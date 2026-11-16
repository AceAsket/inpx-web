use std::fmt::Write;
use std::sync::Mutex;

use hyper::header::{self, HeaderMap, HeaderValue};
use inpx_auth_state::browser_sessions::BrowserSessions;
use inpx_auth_state::sessions::{SessionData, SessionTable};
use inpx_catalog::{Result, access_runtime::now_ms};

const PROFILE_TOKEN: usize = 0;
const PROXY_OWNER: usize = 1;
const PROXY_TOKEN: usize = 2;
const COOKIE: &str = "inpx_web_session";

pub(crate) struct Browser {
    pub id: String,
    pub cookie: Option<HeaderValue>,
}

pub(crate) struct Sessions {
    path: String,
    shared: Mutex<Shared>,
}

#[derive(Default)]
struct Shared {
    browsers: BrowserSessions,
    profiles: SessionTable<Identity>,
}

#[derive(Clone)]
pub(crate) struct Identity {
    pub owner: String,
    pub credential_version: [u8; 32],
}

impl SessionData for Identity {
    fn owner(&self) -> Option<&str> {
        Some(&self.owner)
    }
}

pub(crate) struct Valid {
    pub csrf: String,
    pub profile: Option<(String, Identity)>,
}

impl Sessions {
    pub(crate) fn new(prefix: &str) -> Result<Self> {
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|_| "Не удалось защитить браузерные сеансы")?;
        let mut shared = Shared::default();
        shared.browsers.replace_key(&key);
        let path = if prefix.starts_with('/')
            && prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._~-%".contains(&b))
        {
            prefix.trim_end_matches('/')
        } else {
            ""
        };
        Ok(Self {
            path: if path.is_empty() {
                "/".into()
            } else {
                path.into()
            },
            shared: Mutex::new(shared),
        })
    }

    pub(crate) fn open(&self, headers: &HeaderMap, secure: bool) -> Result<Browser> {
        let mut shared = self.shared.lock().expect("browser sessions");
        if let Some(id) = unpack(&mut shared.browsers, headers) {
            return Ok(Browser { id, cookie: None });
        }
        let id = random_hex::<24>()?;
        let csrf = random_hex::<32>()?;
        shared.browsers.create(&id, &csrf, now_ms());
        let signature = shared.browsers.signature(&id);
        let signature = std::str::from_utf8(&signature).expect("hex cookie signature");
        let transport = if secure { "; Secure" } else { "" };
        let cookie = HeaderValue::from_str(&format!(
            "{COOKIE}={id}.{signature}; HttpOnly; SameSite=Lax; Path={}; Max-Age=2592000{transport}",
            self.path
        ))?;
        Ok(Browser {
            id,
            cookie: Some(cookie),
        })
    }

    pub(crate) fn bind_proxy(&self, browser: &str, owner: &str) -> Result<String> {
        let mut shared = self.shared.lock().expect("browser sessions");
        if shared
            .browsers
            .load(browser, None, now_ms(), |_| ())
            .is_none()
        {
            return Err("bad_csrf_token".into());
        }
        if shared.browsers.field(browser, PROXY_OWNER) == Some(owner)
            && let Some(token) = shared.browsers.field(browser, PROXY_TOKEN)
        {
            return Ok(token.into());
        }
        // Proxy binding is authorized by the current request. Its compatibility
        // token is deliberately absent from the local password-session table.
        let token = random_hex::<24>()?;
        shared.browsers.set_field(browser, PROXY_OWNER, Some(owner));
        shared
            .browsers
            .set_field(browser, PROXY_TOKEN, Some(&token));
        shared.browsers.set_field(browser, PROFILE_TOKEN, None);
        Ok(token)
    }

    pub(crate) fn clear_proxy(&self, browser: &str) {
        let mut shared = self.shared.lock().expect("browser sessions");
        shared.browsers.set_field(browser, PROXY_OWNER, None);
        shared.browsers.set_field(browser, PROXY_TOKEN, None);
    }

    pub(crate) fn load(&self, browser: &str, supplied: &str) -> Option<Valid> {
        let mut shared = self.shared.lock().expect("browser sessions");
        let csrf = shared
            .browsers
            .load(browser, None, now_ms(), str::to_owned)?;
        let selected = if supplied.is_empty() {
            shared
                .browsers
                .field(browser, PROFILE_TOKEN)
                .unwrap_or_default()
                .to_owned()
        } else {
            supplied.to_owned()
        };
        let profile = profile(&mut shared.profiles, &selected).map(|owner| (selected, owner));
        Some(Valid { csrf, profile })
    }

    pub(crate) fn http_owner(&self, headers: &HeaderMap) -> Option<(String, Identity)> {
        let mut shared = self.shared.lock().expect("browser sessions");
        let browser = unpack(&mut shared.browsers, headers)?;
        let token = shared.browsers.field(&browser, PROFILE_TOKEN)?.to_owned();
        let identity = profile(&mut shared.profiles, &token)?;
        Some((token, identity))
    }

    pub(crate) fn has_csrf(&self, browser: &str, token: &str) -> bool {
        let mut shared = self.shared.lock().expect("browser sessions");
        shared
            .browsers
            .load(browser, None, now_ms(), |_| ())
            .is_some()
            && shared.browsers.verify_csrf(browser, token)
    }

    pub(crate) fn login(&self, browser: &str, identity: Identity) -> Result<String> {
        let token = random_hex::<24>()?;
        let mut shared = self.shared.lock().expect("browser sessions");
        let now = now_ms();
        if shared.browsers.load(browser, None, now, |_| ()).is_none() {
            return Err("bad_csrf_token".into());
        }
        shared.profiles.insert(&token, identity, now);
        shared
            .browsers
            .set_field(browser, PROFILE_TOKEN, Some(&token));
        Ok(token)
    }

    pub(crate) fn resume(&self, browser: &str, token: &str) {
        self.shared
            .lock()
            .expect("browser sessions")
            .browsers
            .set_field(browser, PROFILE_TOKEN, Some(token));
    }

    pub(crate) fn revoke(&self, token: &str) {
        self.shared
            .lock()
            .expect("browser sessions")
            .profiles
            .remove(token);
    }

    pub(crate) fn logout(&self, browser: &str, supplied: &str) {
        let mut shared = self.shared.lock().expect("browser sessions");
        if let Some(bound) = shared
            .browsers
            .field(browser, PROFILE_TOKEN)
            .map(str::to_owned)
        {
            shared.profiles.remove(&bound);
        }
        shared.profiles.remove(supplied);
        shared.browsers.set_field(browser, PROFILE_TOKEN, None);
    }
}

fn profile(sessions: &mut SessionTable<Identity>, token: &str) -> Option<Identity> {
    crate::profile_sessions::valid_token(token).then_some(())?;
    sessions.with_session(token, now_ms(), |identity| Some(identity.clone()))
}

fn unpack(browsers: &mut BrowserSessions, headers: &HeaderMap) -> Option<String> {
    let mut cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|cookie| {
            let (name, value) = cookie.split_once('=')?;
            (name.trim() == COOKIE).then_some(value.trim())
        });
    let (id, signature) = cookies.next()?.split_once('.')?;
    if cookies.next().is_some()
        || !crate::profile_sessions::valid_token(id)
        || signature.len() != 64
    {
        return None;
    }
    browsers.load(id, Some(signature.as_bytes()), now_ms(), |_| id.to_owned())
}

fn random_hex<const N: usize>() -> Result<String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "Не удалось выпустить сеанс")?;
    let mut token = String::with_capacity(2 * N);
    for byte in bytes {
        write!(token, "{byte:02x}").expect("writing to String");
    }
    Ok(token)
}
