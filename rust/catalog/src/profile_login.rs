use std::path::{Path, PathBuf};
use std::sync::Mutex;

use inpx_auth_state::totp_attempts::TotpAttempts;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::access_runtime::now_ms;
use crate::crypto_support::Secret;
use crate::profile_store::{Account, CHANGED, CredentialPatch, Lookup, Policy, Snapshot};
use crate::{Result, profile_password, profile_second_factor, trusted_devices};

pub use crate::profile_store::Store;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(flatten)]
    source: Source,
    key_file: PathBuf,
    password: Secret,
    otp: Option<Secret>,
    trusted_device_token: Secret,
    remember_device: bool,
}

#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "camelCase")]
enum Source {
    Registry { file: PathBuf, login: String },
    Profile { profile: LegacyProfile },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProfile {
    #[serde(flatten)]
    account: Account,
    profile_auth_policy: Policy,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Decision {
    Denied,
    RoleDenied,
    NeedOtp,
    NeedOtpSetup,
    Legacy,
    Accepted(Accepted),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    pub user_id: String,
    #[serde(skip)]
    pub credential_version: [u8; 32],
    #[serde(skip_serializing_if = "Option::is_none")]
    patch: Option<CredentialPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_grant: Option<DeviceGrant>,
}

impl Request {
    pub fn browser(
        file: PathBuf,
        key_file: PathBuf,
        login: &str,
        password: String,
        otp: String,
        trust: Option<(&str, bool)>,
    ) -> Self {
        Self {
            source: Source::Registry {
                file,
                login: login
                    .trim_matches(crate::fb2_prepare::js_space)
                    .to_lowercase(),
            },
            key_file,
            password: Secret::new(password),
            otp: Some(Secret::new(otp)),
            trusted_device_token: Secret::new(trust.map_or("", |(token, _)| token).to_owned()),
            remember_device: trust.is_some_and(|(_, remember)| remember),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub login: String,
    pub name: String,
    pub is_admin: bool,
    pub anonymous_profile: bool,
    pub personal_recommendations_enabled: bool,
    pub requires_login: bool,
    pub opds_enabled: bool,
    pub opds_auth_enabled: bool,
    pub otp_enabled: bool,
    pub otp_required: bool,
    #[serde(skip)]
    pub otp_required_individual: bool,
    #[serde(skip)]
    pub blocked: bool,
    #[serde(skip)]
    pub preferred_format: String,
    #[serde(skip)]
    pub credential_version: [u8; 32],
}

pub struct BrowserProfiles {
    pub users: Vec<BrowserProfile>,
    pub blocked_logins: Vec<String>,
    pub blocked_users: Vec<BrowserProfile>,
    pub require_otp: bool,
    pub auth_policy: serde_json::Value,
    pub stamp: String,
}

impl Store {
    pub fn browser_profiles(&mut self, path: &Path) -> Result<BrowserProfiles> {
        let Snapshot::Ready(document, stamp) = self.snapshot(path)? else {
            return Err("Файл профилей недоступен".into());
        };
        let require_otp = document.policy.otp_required;
        let (users, blocked_users) = document
            .users
            .iter()
            .map(|(_, user)| {
                let anonymous_profile = user.id == "default"
                    && !user.is_admin
                    && user.password_hash.is_empty()
                    && user.login.is_empty();
                BrowserProfile {
                    id: user.id.clone(),
                    login: user.login.clone(),
                    name: if anonymous_profile {
                        "Без профиля".into()
                    } else {
                        user.name.clone()
                    },
                    is_admin: user.is_admin,
                    anonymous_profile,
                    personal_recommendations_enabled: user.personal_recommendations_enabled,
                    requires_login: !user.password_hash.is_empty(),
                    opds_enabled: user.opds_enabled,
                    opds_auth_enabled: user.opds_auth_enabled,
                    otp_enabled: user.profile_totp.is_some(),
                    otp_required: require_otp || user.otp_required,
                    otp_required_individual: user.otp_required,
                    blocked: user.blocked,
                    preferred_format: user.default_opds_format.clone(),
                    credential_version: credential_version(
                        user,
                        document.policy,
                        &user.password_hash,
                    ),
                }
            })
            .partition(|user| !user.blocked);
        Ok(BrowserProfiles {
            users,
            blocked_users,
            blocked_logins: document
                .users
                .iter()
                .filter(|(_, user)| user.blocked)
                .map(|(_, user)| user.login.clone())
                .collect(),
            require_otp,
            auth_policy: serde_json::to_value(document.policy)?,
            stamp: stamp.to_owned(),
        })
    }
}

fn credential_version(account: &Account, policy: Policy, password_hash: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(account.login.as_bytes());
    hash.update([0]);
    hash.update(password_hash.as_bytes());
    hash.update([
        0,
        u8::from(account.otp_required),
        u8::from(policy.otp_required),
    ]);
    if let Some(totp) = &account.profile_totp {
        hash.update([1]);
        hash.update(totp.encrypted_secret().as_bytes());
    }
    hash.finalize().into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGrant {
    pub token: String,
    pub max_age_seconds: u32,
}

/// The caller serializes the operation with other writers to the profile file.
pub fn authenticate(
    request: Request,
    attempts: &Mutex<TotpAttempts>,
    store: &mut Store,
) -> Result<Decision> {
    authenticate_with_role_check(request, attempts, store, |_| true)
}

pub fn authenticate_with_role_check(
    request: Request,
    attempts: &Mutex<TotpAttempts>,
    store: &mut Store,
    permits: impl FnOnce(bool) -> bool,
) -> Result<Decision> {
    let Request {
        source,
        key_file,
        password,
        otp,
        trusted_device_token,
        remember_device,
    } = request;
    let (profile, policy, snapshot) = match source {
        Source::Registry { file, login } => match store.lookup(&file, &login)? {
            Lookup::Legacy => return Ok(Decision::Legacy),
            Lookup::Missing => return Ok(Decision::Denied),
            Lookup::Changed => return Err(CHANGED.into()),
            Lookup::Found(account, policy, position) => {
                (account.clone(), policy, Some((file, position)))
            }
        },
        Source::Profile { profile } => (profile.account, profile.profile_auth_policy, None),
    };
    let password = password.text().as_bytes();
    if profile.blocked
        || !profile_password::verify(&profile.password_hash, profile.login.as_bytes(), password)?
    {
        return Ok(Decision::Denied);
    }
    // A policy-specific error requires a valid password. Check the role before
    // requesting or consuming a second factor or writing any credential changes.
    if !permits(profile.is_admin) {
        return Ok(Decision::RoleDenied);
    }
    if (profile.otp_required || policy.otp_required) && profile.profile_totp.is_none() {
        return Ok(Decision::NeedOtpSetup);
    }

    let mut patch = CredentialPatch::default();
    let mut device_grant = None;
    if let Some(state) = profile.profile_totp.clone() {
        let code = otp.as_ref().map(Secret::text);
        let token = trusted_device_token.text();
        let now = now_ms();
        let trust_enabled = policy.trusted_browsers_enabled;
        if code == Some("") {
            if !trust_enabled
                || !trusted_devices::recognizes(&profile.profile_trusted_devices, token, now)
            {
                return Ok(Decision::NeedOtp);
            }
        } else {
            if !attempts
                .lock()
                .expect("TOTP attempts")
                .allows(&profile.id, now)
            {
                log::debug!(target: "inpx::auth", "otp=rate-limited");
                return Ok(Decision::Denied);
            }
            let remember = (trust_enabled && remember_device).then(|| trusted_devices::Remember {
                devices: profile.profile_trusted_devices.clone(),
                replaced: token.into(),
                days: policy.trusted_browser_days,
            });
            let accepted = code
                .map(|code| {
                    profile_second_factor::consume(
                        &key_file,
                        &profile.id,
                        state,
                        code,
                        now,
                        remember,
                    )
                })
                .transpose()?
                .flatten();
            let mut attempts = attempts.lock().expect("TOTP attempts");
            let Some(result) = accepted else {
                attempts.failed(&profile.id, now);
                log::debug!(target: "inpx::auth", "otp=rejected");
                return Ok(Decision::Denied);
            };
            attempts.reset(&profile.id);
            patch.profile_totp = Some(Some(result.state));
            if let Some(grant) = result.grant {
                patch.profile_trusted_devices = Some(grant.devices);
                device_grant = Some(DeviceGrant {
                    token: grant.token,
                    max_age_seconds: grant.max_age_seconds,
                });
            }
        }
    }

    // An accepted 64-character hash is the legacy SHA-256 format.
    if profile.password_hash.len() == 64 {
        patch.password_hash = Some(profile_password::hash(password)?);
    }
    let credential_version = credential_version(
        &profile,
        policy,
        patch
            .password_hash
            .as_deref()
            .unwrap_or(&profile.password_hash),
    );
    let patch = if let Some((file, position)) = snapshot {
        store.finish_login(&file, position, (!patch.is_empty()).then_some(&patch))?;
        None
    } else {
        Some(patch)
    };
    Ok(Decision::Accepted(Accepted {
        user_id: profile.id,
        credential_version,
        patch,
        device_grant,
    }))
}
