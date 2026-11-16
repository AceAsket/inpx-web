use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, Response, StatusCode};
use inpx_auth_state::login_rate::{Kind, LoginRate, Policy};
use inpx_auth_state::totp_attempts::TotpAttempts;
use inpx_catalog::access_runtime::now_ms;
use inpx_catalog::book_delivery::Book;
use inpx_catalog::kosync::{KoSync, ProgressRequest, Session};
use inpx_catalog::opds_access::{self, Decision, Grant, Resource, Scope, SharedPassword};
use inpx_catalog::profile_login::{self, BrowserProfile, BrowserProfiles, Store};
use inpx_catalog::reader_state::{PublishedReading, ReaderState};
use serde_json::{Value, value::RawValue};

use crate::http::{Body, error};
use crate::request_access::Admission;
use crate::standalone_browser::{Identity, Sessions};
use crate::standalone_library::Library;

pub(crate) struct Access {
    file: PathBuf,
    key_file: PathBuf,
    shared: Option<SharedPassword>,
    require_profile: bool,
    opds_enabled: bool,
    policy: Policy,
    state: Mutex<State>,
    totp: Mutex<TotpAttempts>,
    pub(crate) sessions: Sessions,
    pub(crate) library: Library,
}

struct State {
    profiles: Store,
    attempts: LoginRate,
    reader: ReaderState,
    kosync: KoSync,
}

pub(crate) enum Rejection {
    Unauthorized,
    Blocked,
    ProxyScope,
    Missing,
    RateLimited(u32),
    Unavailable,
}

pub(crate) const PROXY_SCOPE: &str = "Профиль закреплён за пользователем proxy";
pub(crate) const BLOCKED_PROFILE: &str = "Профиль недоступен";

pub(crate) struct BrowserAccess {
    pub(crate) csrf: String,
    pub(crate) required: bool,
    pub(crate) owner: Option<String>,
    pub(crate) token: String,
    pub(crate) bound: bool,
    pub(crate) users: Vec<BrowserProfile>,
}

pub(crate) struct BrowserProfileRequest<'a> {
    pub browser: &'a str,
    pub token: &'a str,
    pub user: &'a str,
    pub proxy_login: Option<&'a str>,
}

pub(crate) enum BrowserLogin {
    Accepted { user: String, token: String },
    Invalid,
    NeedOtp,
    NeedOtpSetup,
    RateLimited(u32),
    Unavailable,
}

impl Access {
    pub(crate) fn login_metrics(&self) -> (bool, [u64; inpx_auth_state::login_rate::METRIC_COUNT]) {
        let mut metrics = self
            .state
            .lock()
            .expect("profile access")
            .attempts
            .metrics(now_ms(), self.policy.max_attempts);
        for (total, library) in metrics.iter_mut().zip(self.library.login_metrics()) {
            *total = total.saturating_add(library);
        }
        (self.policy.enabled, metrics)
    }

    pub(crate) fn download_profile(&self, headers: &HeaderMap, grant: &Grant) -> Option<String> {
        if grant.authenticated
            && let Some(scope) = &grant.scope
        {
            return Some(scope.id.clone());
        }
        let (_, owner) = self.sessions.http_owner(headers)?;
        let profiles = self
            .state
            .lock()
            .ok()?
            .profiles
            .browser_profiles(&self.file)
            .ok()?;
        profiles
            .users
            .iter()
            .any(|profile| {
                profile.id == owner.owner && profile.credential_version == owner.credential_version
            })
            .then_some(owner.owner)
    }
    pub(crate) fn published_reading(&self, grant: &Grant) -> Result<PublishedReading, Rejection> {
        let mut state = self.state.lock().map_err(|_| Rejection::Unavailable)?;
        let profiles = state
            .profiles
            .browser_profiles(&self.file)
            .map_err(report)?;
        state
            .reader
            .published_reading(&grant.profile_stamp, profiles)
            .map_err(report)
    }

    pub(crate) fn new(
        data: &Path,
        config: &Value,
        kosync_enabled: bool,
    ) -> inpx_catalog::Result<Self> {
        let opds = &config["opds"];
        let opds_enabled = opds["enabled"] == Value::Bool(true);
        let shared = if opds_enabled {
            SharedPassword::new(
                opds["user"].as_str().unwrap_or_default(),
                opds["password"].as_str().unwrap_or_default(),
            )?
        } else {
            None
        };
        let policy = Policy {
            enabled: std::env::var("INPX_LOGIN_RATE_LIMIT_ENABLED").map_or(
                config["loginRateLimitEnabled"] != Value::Bool(false),
                |value| value != "false",
            ),
            window_ms: setting(&config["loginRateLimitWindowMs"], 900_000).max(60_000),
            max_attempts: u32::try_from(setting(&config["loginRateLimitMaxAttempts"], 8).max(1))
                .unwrap_or(u32::MAX),
        };
        let minutes = &config["accessTimeout"];
        let minutes = minutes
            .as_f64()
            .or_else(|| {
                minutes.as_str().and_then(|value| {
                    let value = value.trim();
                    if value.is_empty() {
                        Some(0.0)
                    } else {
                        value.parse().ok()
                    }
                })
            })
            .or_else(|| minutes.as_bool().map(|value| f64::from(u8::from(value))))
            .or_else(|| minutes.is_null().then_some(0.0));
        let duration = minutes.map_or(-1.0, |minutes| minutes * 60_000.0);
        let timeout = if duration == 0.0 {
            None
        } else {
            let milliseconds = if duration.is_nan() {
                -1
            } else {
                duration
                    .ceil()
                    .clamp(-9_007_199_254_740_991.0, 9_007_199_254_740_991.0) as i64
            };
            Some(milliseconds)
        };
        let password = config
            .get("accessPassword")
            .map(|value| value.as_str().ok_or("accessPassword должен быть строкой"))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            file: data.join("reading-lists.json"),
            key_file: data.join("secret.key"),
            shared,
            require_profile: std::env::var("INPX_ALLOW_ANONYMOUS_ACCESS").map_or(
                config["allowAnonymousAccess"] == Value::Bool(false),
                |value| value == "false",
            ),
            opds_enabled,
            policy,
            state: Mutex::new(State {
                profiles: Store::default(),
                attempts: LoginRate::default(),
                reader: ReaderState::new(data),
                kosync: KoSync::new(data, kosync_enabled),
            }),
            totp: Mutex::new(TotpAttempts::default()),
            sessions: Sessions::new(config["server"]["root"].as_str().unwrap_or_default())?,
            library: Library::open(data, password, timeout, policy)?,
        })
    }

    pub(crate) fn with_profile(
        &self,
        query: BrowserProfileRequest<'_>,
        run: impl FnOnce(&ReaderState, &str, &str) -> inpx_catalog::Result<Value>,
    ) -> inpx_catalog::Result<Value> {
        self.with_profile_state(query, |state, owner, stamp| {
            run(&state.reader, owner, stamp)
        })
    }

    fn with_profile_state(
        &self,
        query: BrowserProfileRequest<'_>,
        run: impl FnOnce(&mut State, &str, &str) -> inpx_catalog::Result<Value>,
    ) -> inpx_catalog::Result<Value> {
        let browser = self
            .sessions
            .load(query.browser, query.token)
            .ok_or("need_profile_login")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Хранилище профилей недоступно")?;
        let profiles = state.profiles.browser_profiles(&self.file)?;
        let requested = query.user.trim();
        if let Some(profile) =
            bound_profile(&profiles, query.proxy_login).map_err(|_| BLOCKED_PROFILE)?
        {
            if !profile_scope(profile, requested) {
                return Err(PROXY_SCOPE.into());
            }
            return run(&mut state, &profile.id, &profiles.stamp);
        }
        let owner = browser
            .profile
            .as_ref()
            .map(|(_, identity)| identity.owner.as_str());
        let id = if requested.is_empty() {
            owner.unwrap_or("default")
        } else {
            requested
        };
        let profile = profiles
            .users
            .iter()
            .find(|user| user.id == id)
            .ok_or("need_profile_login")?;
        let authorized = browser.profile.as_ref().is_some_and(|(_, identity)| {
            identity.owner == id && identity.credential_version == profile.credential_version
        });
        if !authorized
            && (self.require_profile
                || profiles.require_otp
                || profile.otp_required
                || profile.requires_login
                || !query.token.is_empty()
                || owner.is_some())
        {
            return Err("need_profile_login".into());
        }
        run(&mut state, &profile.id, &profiles.stamp)
    }

    pub(crate) fn kosync_settings(
        &self,
        profile: BrowserProfileRequest<'_>,
        peer: IpAddr,
        operation: &str,
        password: String,
    ) -> inpx_catalog::Result<Value> {
        self.with_profile_state(profile, |state, owner, stamp| {
            let confirm = operation == "use-web-password";
            let client = peer.to_string();
            if confirm {
                let retry =
                    state
                        .attempts
                        .check(Kind::Profile, &client, now_ms(), self.policy, true);
                if retry != 0 {
                    return Ok(serde_json::json!({
                        "error":"Слишком много попыток входа. Повторите позже.",
                        "errorCode":"INPX_LOGIN_RATE_LIMIT","retryAfterMs":u64::from(retry)*1000,
                    }));
                }
            }
            let result =
                state
                    .kosync
                    .settings(&mut state.profiles, owner, stamp, operation, password);
            if confirm {
                let outcome = match &result {
                    Ok(_) => Some(true),
                    Err(error) if error.to_string() == "INPX_INVALID_PROFILE_CREDENTIALS" => {
                        Some(false)
                    }
                    _ => None,
                };
                state.attempts.finish(
                    Kind::Profile,
                    &client,
                    now_ms(),
                    self.policy,
                    self.policy.enabled,
                    outcome,
                );
            }
            result
        })
    }

    pub(crate) fn kosync_auth(
        &self,
        peer: IpAddr,
        user: &str,
        key: &str,
    ) -> Result<Session, Rejection> {
        let mut state = self.state.lock().map_err(|_| Rejection::Unavailable)?;
        let client = peer.to_string();
        let retry = state
            .attempts
            .check(Kind::Opds, &client, now_ms(), self.policy, true);
        if retry != 0 {
            return Err(Rejection::RateLimited(retry));
        }
        let State {
            kosync, profiles, ..
        } = &mut *state;
        let result = kosync.authenticate(profiles, user, key);
        let outcome = result.as_ref().ok().map(Option::is_some);
        state.attempts.finish(
            Kind::Opds,
            &client,
            now_ms(),
            self.policy,
            self.policy.enabled,
            outcome,
        );
        result.map_err(report)?.ok_or(Rejection::Unauthorized)
    }

    pub(crate) fn kosync_progress(
        &self,
        request: ProgressRequest<'_>,
        book: impl FnOnce(&str) -> inpx_catalog::Result<Option<Book>>,
        fb2: impl FnOnce(&Book) -> inpx_catalog::Result<Option<PathBuf>>,
    ) -> Result<Box<RawValue>, Rejection> {
        let mut state = self.state.lock().map_err(|_| Rejection::Unavailable)?;
        let State {
            kosync,
            profiles,
            reader,
            ..
        } = &mut *state;
        kosync
            .progress(profiles, reader, request, book, fb2)
            .map_err(|error| {
                if error.to_string() == "need_profile_login" {
                    Rejection::Unauthorized
                } else {
                    report(error)
                }
            })?
            .ok_or(Rejection::Unauthorized)
    }

    pub(crate) fn kosync_link(
        &self,
        uid: &str,
        ext: &str,
        raw: impl FnOnce() -> inpx_catalog::Result<PathBuf>,
    ) -> inpx_catalog::Result<()> {
        self.state
            .lock()
            .map_err(|_| "Хранилище KOSync недоступно")?
            .kosync
            .link(uid, ext, raw)
    }

    pub(crate) fn browser(
        &self,
        id: &str,
        supplied: &str,
        proxy_login: Option<&str>,
    ) -> Result<BrowserAccess, Rejection> {
        let browser = self
            .sessions
            .load(id, supplied)
            .ok_or(Rejection::Unauthorized)?;
        let profiles = self
            .state
            .lock()
            .map_err(|_| Rejection::Unavailable)?
            .profiles
            .browser_profiles(&self.file)
            .map_err(report)?;
        let bound = bound_profile(&profiles, proxy_login);
        if let Ok(Some(profile)) = bound {
            let token = self.sessions.bind_proxy(id, &profile.id).map_err(report)?;
            return Ok(BrowserAccess {
                csrf: browser.csrf,
                owner: Some(profile.id.clone()),
                token,
                users: profiles.users,
                required: self.require_profile,
                bound: true,
            });
        }
        self.sessions.clear_proxy(id);
        bound?;
        let profile = browser.profile.filter(|(token, identity)| {
            let current = profiles.users.iter().any(|user| {
                user.id == identity.owner && user.credential_version == identity.credential_version
            });
            if !current {
                self.sessions.revoke(token);
            }
            current
        });
        let (token, owner) = profile.map_or_else(
            || (String::new(), None),
            |(token, identity)| (token, Some(identity.owner)),
        );
        Ok(BrowserAccess {
            csrf: browser.csrf,
            owner,
            token,
            users: profiles.users,
            required: self.require_profile || profiles.require_otp,
            bound: false,
        })
    }

    pub(crate) fn login(
        &self,
        browser: &str,
        peer: IpAddr,
        login: &str,
        password: String,
        otp: String,
    ) -> BrowserLogin {
        let Ok(mut state) = self.state.lock() else {
            return BrowserLogin::Unavailable;
        };
        let client = peer.to_string();
        let retry = state
            .attempts
            .check(Kind::Profile, &client, now_ms(), self.policy, true);
        if retry != 0 {
            return BrowserLogin::RateLimited(retry);
        }
        let request = profile_login::Request::browser(
            self.file.clone(),
            self.key_file.clone(),
            login,
            password,
            otp,
        );
        let decision = profile_login::authenticate(request, &self.totp, &mut state.profiles);
        let outcome = match &decision {
            Ok(profile_login::Decision::Accepted(_)) => Some(true),
            Ok(profile_login::Decision::Denied) => Some(false),
            _ => None,
        };
        state.attempts.finish(
            Kind::Profile,
            &client,
            now_ms(),
            self.policy,
            self.policy.enabled,
            outcome,
        );
        match decision {
            Ok(profile_login::Decision::Accepted(user)) => {
                let identity = Identity {
                    owner: user.user_id.clone(),
                    credential_version: user.credential_version,
                };
                match self.sessions.login(browser, identity) {
                    Ok(token) => BrowserLogin::Accepted {
                        user: user.user_id,
                        token,
                    },
                    Err(_) => BrowserLogin::Unavailable,
                }
            }
            Ok(profile_login::Decision::NeedOtp) => BrowserLogin::NeedOtp,
            Ok(profile_login::Decision::NeedOtpSetup) => BrowserLogin::NeedOtpSetup,
            Ok(profile_login::Decision::Denied) => BrowserLogin::Invalid,
            _ => BrowserLogin::Unavailable,
        }
    }

    pub(crate) fn check(
        &self,
        request: &Request<impl Sized>,
        admission: &Admission,
        resource: Resource,
    ) -> Result<Grant, Rejection> {
        let scope =
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .find(|(name, _)| name == "user")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
        let mut values = request.headers().get_all(header::AUTHORIZATION).iter();
        let supplied = values.next().map(HeaderValue::as_bytes);
        let authorization = if values.next().is_none() {
            supplied
        } else {
            Some(&[][..])
        };
        let mut state = self.state.lock().map_err(|_| Rejection::Unavailable)?;
        let local = self.sessions.http_owner(request.headers());
        if local.is_some() || admission.proxy_login.is_some() {
            let profiles = state
                .profiles
                .browser_profiles(&self.file)
                .map_err(report)?;
            if let Some(profile) = bound_profile(&profiles, admission.proxy_login.as_deref())? {
                if !profile_scope(profile, scope.trim()) {
                    return Err(Rejection::ProxyScope);
                }
                return Ok(profile_grant(profile, &profiles.stamp));
            }
            if let Some((token, owner)) = local {
                let profile = profiles.users.iter().find(|profile| {
                    profile.id == owner.owner
                        && profile.credential_version == owner.credential_version
                });
                match profile {
                    Some(profile) if self.require_profile || profiles.require_otp => {
                        if !profile_scope(profile, scope.trim()) {
                            return Err(Rejection::Unauthorized);
                        }
                        return Ok(profile_grant(profile, &profiles.stamp));
                    }
                    Some(_) => (),
                    None => self.sessions.revoke(&token),
                }
            }
        }
        let inspect = |store: &mut Store, authorization| {
            opds_access::authorize(
                store,
                opds_access::Request {
                    profile_file: &self.file,
                    shared: self.shared.as_ref(),
                    require_profile: self.require_profile,
                    opds_enabled: self.opds_enabled,
                    resource,
                    scope: &scope,
                    authorization,
                },
            )
        };
        let mut decision = inspect(&mut state.profiles, None).map_err(report)?;
        if authorization.is_some() && matches!(decision, Decision::Deny) {
            let client = admission.client.to_string();
            let retry = state
                .attempts
                .check(Kind::Opds, &client, now_ms(), self.policy, true);
            if retry != 0 {
                return Err(Rejection::RateLimited(retry));
            }
            let verified = inspect(&mut state.profiles, authorization);
            let outcome = match &verified {
                Ok(Decision::Allow(grant)) if grant.authenticated => Some(true),
                Ok(Decision::Deny) => Some(false),
                _ => None,
            };
            state.attempts.finish(
                Kind::Opds,
                &client,
                now_ms(),
                self.policy,
                self.policy.enabled,
                outcome,
            );
            decision = verified.map_err(report)?;
        }
        match decision {
            Decision::Allow(grant) => Ok(grant),
            Decision::Deny => Err(Rejection::Unauthorized),
            Decision::Missing => Err(Rejection::Missing),
            Decision::Unavailable => Err(Rejection::Unavailable),
        }
    }
}

fn bound_profile<'a>(
    profiles: &'a BrowserProfiles,
    login: Option<&str>,
) -> Result<Option<&'a BrowserProfile>, Rejection> {
    let Some(login) = login.filter(|_| !profiles.require_otp) else {
        return Ok(None);
    };
    if profiles
        .blocked_logins
        .iter()
        .any(|blocked| blocked == login)
    {
        return Err(Rejection::Blocked);
    }
    Ok(profiles.users.iter().find(|profile| profile.login == login))
}

pub(crate) fn profile_scope(profile: &BrowserProfile, requested: &str) -> bool {
    requested.is_empty() || requested == profile.id || requested == profile.login
}

fn profile_grant(profile: &BrowserProfile, stamp: &str) -> Grant {
    Grant {
        scope: Some(Scope {
            id: profile.id.clone(),
            preferred_format: profile.preferred_format.clone(),
        }),
        authenticated: true,
        profile_stamp: stamp.into(),
    }
}

fn setting(value: &Value, fallback: i64) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .filter(|&value| value != 0)
        .unwrap_or(fallback)
}

fn report(error: Box<dyn std::error::Error>) -> Rejection {
    eprintln!("OPDS authentication: {error}");
    Rejection::Unavailable
}

pub(crate) fn private(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    let scope = HeaderValue::from_static("Authorization, Cookie");
    if !headers
        .get_all(header::VARY)
        .iter()
        .any(|value| value == scope)
    {
        headers.append(header::VARY, scope);
    }
}

impl Rejection {
    pub(crate) fn response(self) -> Response<Body> {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Blocked | Self::ProxyScope => StatusCode::FORBIDDEN,
            Self::Missing => StatusCode::NOT_FOUND,
            Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        let mut response = error(status);
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        match self {
            Self::Unauthorized => {
                headers.insert(
                    header::WWW_AUTHENTICATE,
                    HeaderValue::from_static("Basic realm=\"inpx-web OPDS\", charset=\"UTF-8\""),
                );
            }
            Self::RateLimited(seconds) => {
                headers.insert(header::RETRY_AFTER, HeaderValue::from(seconds));
            }
            _ => (),
        }
        response
    }
}
