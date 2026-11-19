use std::path::Path;

use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use sha2::{Digest, Sha256};

use crate::crypto_support::{Sensitive, equal};
use crate::fb2_prepare::js_space;
use crate::profile_store::{Account, CredentialPatch, Position, Snapshot, Store};
use crate::{Result, atomic_file, opds_password, profile_password};

pub struct SharedPassword {
    user: [u8; 32],
    password: [u8; 32],
}

impl SharedPassword {
    pub fn new(user: &str, password: &str) -> Result<Option<Self>> {
        if password.is_empty() {
            return Ok(None);
        }
        if user.is_empty() {
            return Err("User must not be empty if OPDS password is set".into());
        }
        Ok(Some(Self {
            user: Sha256::digest(user.as_bytes()).into(),
            password: Sha256::digest(password.as_bytes()).into(),
        }))
    }

    fn matches(&self, credentials: &Credentials) -> bool {
        equal(
            &self.user,
            &Sha256::digest(credentials.login().as_bytes()).into(),
        ) & equal(
            &self.password,
            &Sha256::digest(credentials.password()).into(),
        )
    }
}

struct Credentials {
    // Both slices are stored in the same zeroed-on-drop buffer.
    bytes: Sensitive<Vec<u8>>,
    separator: usize,
}

const BASIC: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

impl Credentials {
    fn parse(header: &[u8]) -> Option<Self> {
        let header = std::str::from_utf8(header).ok()?;
        let (scheme, value) = header.split_once(|ch: char| ch.is_ascii_whitespace())?;
        if !scheme.eq_ignore_ascii_case("basic") {
            return None;
        }
        let value = value.trim_ascii();
        let bytes = Sensitive(BASIC.decode(value).ok()?);
        let separator = bytes.0.iter().position(|&byte| byte == b':')?;
        std::str::from_utf8(&bytes.0).ok()?;
        Some(Self { bytes, separator })
    }

    fn login(&self) -> &str {
        std::str::from_utf8(&self.bytes.0[..self.separator]).expect("UTF-8 credentials")
    }

    fn password(&self) -> &[u8] {
        &self.bytes.0[self.separator + 1..]
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Resource {
    Catalogue,
    Download,
}

pub struct Request<'a> {
    pub profile_file: &'a Path,
    pub shared: Option<&'a SharedPassword>,
    pub require_profile: bool,
    pub opds_enabled: bool,
    pub resource: Resource,
    pub scope: &'a str,
    pub authorization: Option<&'a [u8]>,
}

pub struct Scope {
    pub id: String,
    pub preferred_format: String,
}

pub struct Grant {
    pub scope: Option<Scope>,
    pub authenticated: bool,
    pub profile_stamp: String,
}

impl Grant {
    pub fn private(&self) -> bool {
        self.authenticated || self.scope.is_some()
    }
}

pub enum Decision {
    Allow(Grant),
    Deny,
    Missing,
    Unavailable,
}

pub fn authorize(store: &mut Store, request: Request<'_>) -> Result<Decision> {
    for _ in 0..2 {
        match authorize_snapshot(store, &request)? {
            Decision::Unavailable => (),
            decision => return Ok(decision),
        }
    }
    Ok(Decision::Unavailable)
}

fn authorize_snapshot(store: &mut Store, request: &Request<'_>) -> Result<Decision> {
    let (profiles, stamp) = match store.snapshot(request.profile_file)? {
        Snapshot::Ready(profiles, stamp) => (profiles, stamp),
        Snapshot::Legacy | Snapshot::Changed => return Ok(Decision::Unavailable),
    };
    let global_otp = profiles.policy.otp_required;
    let require_profile = request.require_profile || global_otp;
    if request.resource == Resource::Download && !require_profile {
        let decision =
            if atomic_file::current_stamp(request.profile_file)?.as_deref() == Some(stamp) {
                allow(None, false, stamp)
            } else {
                Decision::Unavailable
            };
        return Ok(decision);
    }
    if !request.opds_enabled {
        return Ok(Decision::Deny);
    }
    let credentials = request.authorization.and_then(Credentials::parse);
    let login = credentials
        .as_ref()
        .map(|value| value.login().trim_matches(js_space).to_lowercase());
    let scope = request.scope.trim_matches(js_space);
    let scoped = !scope.is_empty();
    let requested = if scoped {
        profiles
            .users
            .iter()
            .find(|(_, account)| account.id == scope)
            .or_else(|| {
                profiles
                    .users
                    .iter()
                    .find(|(_, account)| account.login == scope)
            })
    } else if require_profile || request.shared.is_some() {
        login
            .as_deref()
            .filter(|login| !login.is_empty())
            .and_then(|login| {
                profiles
                    .users
                    .iter()
                    .find(|(_, account)| account.login == login)
            })
    } else {
        None
    };
    let requested = requested.filter(|(_, account)| !account.blocked && account.opds_enabled);
    let scoped_profile = if scoped {
        requested.map(|(_, account)| account)
    } else {
        None
    };
    let shared = request.shared;
    let stamp = stamp.to_owned();
    let mut upgrade = None;
    let fallback = || {
        shared_or_public(
            scoped,
            scoped_profile,
            shared,
            credentials.as_ref(),
            require_profile,
            global_otp,
            &stamp,
        )
    };
    let decision = if let Some((index, account)) = requested
        && (account.profile_totp.is_some()
            || scoped && account.otp_required
            || global_otp
            || shared.is_none() && account.opds_auth_enabled)
    {
        let needs_app_password =
            global_otp || account.otp_required || account.profile_totp.is_some();
        let credential = profile_credential(
            account,
            login.as_deref(),
            credentials.as_ref(),
            needs_app_password,
        )?;
        match credential {
            Credential::Password | Credential::AppPassword => {
                if credential == Credential::Password && account.password_hash.len() == 64 {
                    upgrade = Some((*index, credentials.as_ref().expect("checked password")));
                }
                allow(Some(account), true, &stamp)
            }
            Credential::Invalid if scoped && (needs_app_password || shared.is_none()) => {
                Decision::Deny
            }
            Credential::Invalid => fallback(),
        }
    } else {
        fallback()
    };
    let Decision::Allow(mut grant) = decision else {
        return Ok(decision);
    };
    if let Some((index, credentials)) = upgrade {
        let patch = CredentialPatch {
            password_hash: Some(profile_password::hash(credentials.password())?),
            ..CredentialPatch::default()
        };
        return match store.finish_login(
            request.profile_file,
            Position { stamp, index },
            Some(&patch),
        ) {
            Ok(stamp) => {
                grant.profile_stamp = stamp;
                Ok(Decision::Allow(grant))
            }
            Err(error) if error.to_string() == crate::profile_store::CHANGED => {
                Ok(Decision::Unavailable)
            }
            Err(error) => Err(error),
        };
    }
    if atomic_file::current_stamp(request.profile_file)?.as_deref() != Some(&stamp) {
        return Ok(Decision::Unavailable);
    }
    Ok(Decision::Allow(grant))
}

fn shared_or_public(
    scoped: bool,
    profile: Option<&Account>,
    shared: Option<&SharedPassword>,
    credentials: Option<&Credentials>,
    require_profile: bool,
    global_otp: bool,
    stamp: &str,
) -> Decision {
    let authenticated = if global_otp {
        return Decision::Deny;
    } else if let Some(shared) = shared {
        if !credentials.is_some_and(|value| shared.matches(value)) {
            return Decision::Deny;
        }
        true
    } else if require_profile {
        return Decision::Deny;
    } else {
        false
    };
    if scoped && profile.is_none() {
        return Decision::Missing;
    }
    allow(profile, authenticated, stamp)
}

fn allow(profile: Option<&Account>, authenticated: bool, stamp: &str) -> Decision {
    Decision::Allow(Grant {
        scope: profile.map(|account| Scope {
            id: account.id.clone(),
            preferred_format: account.default_opds_format.clone(),
        }),
        authenticated,
        profile_stamp: stamp.into(),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Credential {
    Password,
    AppPassword,
    Invalid,
}

fn profile_credential(
    account: &Account,
    login: Option<&str>,
    credentials: Option<&Credentials>,
    needs_app_password: bool,
) -> Result<Credential> {
    let Some(credentials) = credentials.filter(|_| {
        login == Some(account.login.as_str())
            && !account.login.is_empty()
            && !account.password_hash.is_empty()
    }) else {
        return Ok(Credential::Invalid);
    };
    if needs_app_password && account.profile_totp.is_none() {
        return Ok(Credential::Invalid);
    }
    if opds_password::verify(&account.opds_app_password_hash, credentials.password()) {
        return Ok(Credential::AppPassword);
    }
    if !needs_app_password
        && profile_password::verify(
            &account.password_hash,
            account.login.as_bytes(),
            credentials.password(),
        )?
    {
        return Ok(Credential::Password);
    }
    Ok(Credential::Invalid)
}
