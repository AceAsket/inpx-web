use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use hyper::{Request, Response, StatusCode, body::Incoming, header};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use tokio::sync::{
    Semaphore,
    broadcast::{Receiver, error::RecvError},
    mpsc,
};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::{
    CloseFrame, Role, WebSocketConfig, frame::coding::CloseCode,
};
use tokio_tungstenite::tungstenite::{Error, Message};

use super::discovery::{ExternalDiscovery, ExternalOptions, limit as discovery_limit};
use super::events::{Change, Event, Subscription};
use super::{NAME, State, VERSION};
use crate::http::{Body, error};
use crate::request_access::Admission;
use crate::standalone_access::{
    BLOCKED_PROFILE, BrowserAccess, BrowserLogin, BrowserProfileRequest, PROXY_SCOPE, Rejection,
    profile_scope,
};
use crate::standalone_library::Admission as LibraryAdmission;
use inpx_catalog::book_preview;
use inpx_catalog::reader_state::shared_discovery;
use inpx_catalog::reader_state::{apply_metadata_override, apply_search_metadata};

const IDLE: Duration = Duration::from_secs(5 * 60);
const CONNECTION_REQUESTS: usize = 8;
const MIB: usize = 1024 * 1024;

pub(super) struct Socket {
    root: String,
    route: String,
    web_config: Map<String, Value>,
    message_limit: usize,
    import_limit: usize,
    frame_limit: usize,
    jobs: Arc<Semaphore>,
    pub(super) previews: Arc<super::resources::AdmissionSlots>,
    external: ExternalDiscovery,
}

impl Socket {
    pub(super) fn new(
        root: &str,
        config: &Value,
        data: &Path,
        conversion_formats: &[&str],
        free_access: bool,
        tts_enabled: bool,
        archive_slots: usize,
    ) -> Self {
        let root = root.trim_end_matches('/');
        let message_limit = megabytes(&config["wsMessageLimitMb"], 1, 16);
        let import_limit = megabytes(&config["importLimitMb"], 16, 64);
        let frame_limit = [
            message_limit,
            6 * MIB,
            import_limit + 65536,
            megabytes(&config["backupUploadLimitMb"], 32, 128).div_ceil(3) * 4 + 65536,
        ]
        .into_iter()
        .max()
        .expect("transport limits");
        let mut web_config = Map::new();
        for key in [
            "latestVersion",
            "latestReleaseLink",
            "bookReadLink",
            "updateChannel",
            "installMode",
        ] {
            if let Some(value) = config.get(key) {
                web_config.insert(key.into(), value.clone());
            }
        }
        let mut ui = json!({
            "limit":20,"downloadAsZip":false,"showCounts":true,"showRates":true,"showInfo":true,
            "showGenres":true,"bookCardView":"cards","showDates":false,"showDeleted":false,"abCacheEnabled":true,
            "langDefault":"","showJson":false,"showNewReleaseAvailable":true,"darkTheme":false,
        });
        if let Some(configured) = config["uiDefaults"].as_object() {
            ui.as_object_mut()
                .expect("default UI object")
                .extend(configured.clone());
        }
        web_config.insert("uiDefaults".into(), ui);
        let mut discovery = config["discovery"].as_object().cloned().unwrap_or_default();
        for (name, key) in [
            ("INPX_DISCOVERY_LIMIT", "shelfLimit"),
            ("INPX_DISCOVERY_EXTERNAL_SOURCE", "externalSource"),
            ("INPX_DISCOVERY_EXTERNAL_NAME", "externalName"),
            ("INPX_DISCOVERY_EXTERNAL_URL", "externalUrl"),
            ("INPX_DISCOVERY_EXTERNAL_LIMIT", "externalLimit"),
            ("INPX_DISCOVERY_EXTERNAL_TTL_MINUTES", "externalTtlMinutes"),
        ] {
            if let Ok(value) = std::env::var(name) {
                discovery.insert(key.into(), value.into());
            }
        }
        web_config.extend(json!({
            "name":NAME,"version":VERSION,"branch":"production","dbVersion":"15",
            "rootPathStatic":root,"freeAccess":free_access,
            "clientApi":{"version":1,"features":["resumeSession","readerEvents","mobileHome","cancelAudio","bookSearchFormats","libraryFollowNews","overviewPinnedShelves","overviewShelfLayout","overviewRecommendations","separateExternalDiscovery","catalogSuggest","adminDashboard"]},
            "libraryProtocol":{"version":1,"features":["metadata","ratings"]},
            "opdsRoot":config["opds"]["root"].as_str().unwrap_or("/opds"),
            "extendedSearch":config["extendedSearch"]!=false,
            "conversionEnabled":!conversion_formats.is_empty(),"conversionFormats":conversion_formats,
            "onlineReaderEnabled":config["onlineReaderEnabled"]!=false,
            "epubReaderEnabled":config["onlineReaderEnabled"]!=false,
            "ebookReaderEnabled":config["onlineReaderEnabled"]!=false && matches!(&config["remoteLib"], Value::Null | Value::Bool(false)),
            "canRememberProfileDevice":false,
            "discovery":discovery,
            "ttsEnabled":tts_enabled,
            "telegramShareEnabled":false,"emailShareEnabled":false,
        }).as_object().expect("web configuration").clone());
        Self {
            root: root.into(),
            route: format!("{root}/ws"),
            web_config,
            message_limit,
            import_limit,
            frame_limit,
            jobs: Arc::new(Semaphore::new(64)),
            previews: super::resources::AdmissionSlots::new(archive_slots),
            external: ExternalDiscovery::new(data),
        }
    }

    pub(super) fn document(&self, path: &str) -> bool {
        path == self.root || path.strip_suffix('/') == Some(self.root.as_str())
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        self.document(path)
            || matches!(path, "/" | "/ws" | "/ws/")
            || path.trim_end_matches('/') == self.route
    }

    pub(super) fn background_route<'a>(&self, path: &'a str) -> Option<(&'a str, &'a str)> {
        path.strip_prefix(&self.root)?
            .strip_prefix("/reader-background/")?
            .split_once('/')
            .filter(|(owner, name)| !owner.is_empty() && !name.contains('/'))
    }

    pub(super) fn profile_login_route(&self, path: &str) -> bool {
        path.strip_prefix(&self.root) == Some("/api/profile/login")
    }

    pub(super) fn root(&self) -> &str {
        &self.root
    }

    pub(super) fn upgrade(
        &self,
        mut request: Request<Incoming>,
        state: Arc<State>,
        admission: Admission,
    ) -> Response<Body> {
        let mut response = crate::websocket::public_reply(&request);
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            return response;
        }
        let Ok(session) = state.access.sessions.open(request.headers(), &admission) else {
            return error(StatusCode::SERVICE_UNAVAILABLE);
        };
        if let Some(cookie) = session.cookie {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            if let Ok(client) = upgrade.await {
                run(TokioIo::new(client), state, session.id, Arc::new(admission)).await;
            }
        });
        response
    }

    fn dispatch(
        &self,
        state: &Arc<State>,
        browser: &str,
        admission: &Admission,
        context: DispatchContext<'_>,
        mut request: Value,
        subscription: &mut Change,
    ) -> Value {
        let peer = admission.client;
        let proxy_login = admission.proxy_login.as_deref();
        let connection = context.connection;
        if let (Some(activity), Some(id)) = (&state.metrics.activity, connection) {
            activity.seen(id, None);
        }
        match state
            .access
            .library
            .admit(peer, text(&request, "accessToken"))
        {
            Ok(LibraryAdmission::Allowed) => (),
            Ok(LibraryAdmission::Challenge(salt)) => {
                return json!({"error":"need_access_token","salt":salt});
            }
            Ok(LibraryAdmission::RateLimited(retry)) => {
                return login_response(BrowserLogin::RateLimited(retry));
            }
            Err(error) => {
                eprintln!("WebAccess: {error}");
                return fault("Хранилище сеансов доступа недоступно");
            }
        }
        let Some(action) = request["action"].as_str().map(str::to_owned) else {
            return fault("Некорректный запрос WebSocket");
        };
        let _timing = state.diagnostics.request(&action);
        let access =
            match state
                .access
                .browser(browser, text(&request, "profileAccessToken"), proxy_login)
            {
                Ok(access) => access,
                Err(Rejection::Unauthorized) => {
                    return fault("bad_csrf_token");
                }
                Err(Rejection::Blocked) => return fault(BLOCKED_PROFILE),
                Err(_) => return fault("Хранилище профилей недоступно"),
            };
        if let (Some(activity), Some(id)) = (&state.metrics.activity, connection) {
            activity.seen(id, access.owner.as_deref());
        }
        let is_mutation = matches!(
            action.as_str(),
            "login-user-profile"
                | "resume-user-profile"
                | "logout-user-profile"
                | "logout"
                | "update-reader-progress"
                | "prepare-reader-audio"
                | "preview-reader-voice"
                | "cancel-reader-audio"
                | "update-audio-position"
                | "prepare-batch-download"
                | "send-book-telegram"
                | "send-book-email"
                | "telegram-bot-account"
                | "update-admin-integrations"
                | "test-admin-integration"
                | "update-admin-opds"
                | "update-admin-library-sources"
                | "admin-diagnose-library-source"
                | "set-admin-resource-profile"
                | "set-admin-isbn-threads"
                | "update-admin-cache"
                | "admin-clean-cache"
                | "admin-clean-broken-covers"
                | "admin-rebuild-cover"
                | "import-admin-settings"
                | "create-admin-backup"
                | "preview-admin-backup"
                | "import-admin-backup"
                | "admin-backup-vault"
                | "start-library-audit"
                | "cancel-library-audit"
                | "start-admin-benchmark"
                | "cancel-admin-benchmark"
                | "update-admin-event-log"
                | "add-admin-test-event"
                | "relink-reader-book"
                | "delete-reader-progress"
                | "forget-hidden-book"
                | "clear-reader-progress"
                | "update-reader-preferences"
                | "subscribe-client-events"
                | "profile-totp-enrollment"
                | "profile-totp"
                | "reset-user-profile-totp"
                | "set-user-profile-totp-required"
                | "set-profile-auth-policy"
                | "create-user-profile"
                | "update-user-profile"
                | "set-user-profile-blocked"
                | "delete-user-profile"
                | "import-reading-lists"
                | "add-reader-bookmark"
                | "delete-reader-bookmark"
                | "change-library-follow"
                | "update-discovery-preferences"
                | "record-discovery-events"
                | "update-shared-discovery-config"
                | "update-book-metadata"
                | "start-isbn-index"
                | "cancel-isbn-index"
                | "admin-reindex"
                | "kosync-settings"
        ) || shelf_mutation(&action);
        if is_mutation
            && !state
                .access
                .sessions
                .has_csrf(browser, text(&request, "csrfToken"))
        {
            return fault("bad_csrf_token");
        }
        let bootstrap = matches!(
            action.as_str(),
            "get-config"
                | "get-worker-state"
                | "test"
                | "login-user-profile"
                | "profile-totp-enrollment"
                | "resume-user-profile"
                | "logout-user-profile"
                | "logout"
        );
        let password = if matches!(action.as_str(), "login-user-profile" | "kosync-settings") {
            take_text(&mut request, "password")
        } else {
            String::new()
        };
        let requested = text(&request, "userId").trim();
        let profile_request = BrowserProfileRequest {
            browser,
            token: text(&request, "profileAccessToken"),
            user: requested,
            proxy_login,
        };
        let permitted_scope = access.users.iter().any(|profile| {
            access.owner.as_deref() == Some(profile.id.as_str())
                && profile_scope(profile, requested)
        });
        let admin = permitted_scope
            && access
                .users
                .iter()
                .any(|user| user.is_admin && access.owner.as_deref() == Some(user.id.as_str()));
        if access.bound
            && (action == "login-user-profile"
                || !permitted_scope
                    && !matches!(
                        action.as_str(),
                        "get-config" | "get-user-profiles" | "logout-user-profile"
                    ))
        {
            return fault(PROXY_SCOPE);
        }
        if !access.bound && access.required && !bootstrap && !permitted_scope {
            return fault("need_profile_login");
        }
        let response = match action.as_str() {
            "test" => json!({"message":format!("{NAME} project is awesome")}),
            "get-config" => self.config(state, &access, requested, admission, &request),
            "get-worker-state" => worker_state(state, &access, text(&request, "workerId")),
            "get-user-profiles" => profiles(&access, requested),
            "subscribe-client-events" => {
                if permitted_scope && !access.token.is_empty() && request["enabled"] != false {
                    *subscription = Change::Subscribe(Subscription {
                        owner: access.owner.as_deref().unwrap_or_default().into(),
                        token: access.token.clone(),
                        library_token: text(&request, "accessToken").into(),
                    });
                    json!({"enabled":true})
                } else {
                    *subscription = Change::Clear;
                    if request["enabled"] != false
                        && let Err(error) = state
                            .access
                            .with_profile(profile_request, |_, _, _| Ok(Value::Null))
                    {
                        return fault(&error.to_string());
                    }
                    json!({"enabled":false})
                }
            }
            "get-inpx-file" => state
                .exchange
                .inpx(text(&request, "inpxFileHash"), &state.index.sources())
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "get-author-info" => {
                let id = request["authorId"]
                    .as_u64()
                    .and_then(|value| value.try_into().ok())
                    .or_else(|| text(&request, "authorId").parse().ok());
                state
                    .exchange
                    .author(state, text(&request, "author"), id)
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-book-reviews" => state
                .exchange
                .reviews(state, text(&request, "bookUid"))
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "get-rating-index-status" => super::exchange::Exchange::rating_status(state),
            "prepare-batch-download" => state
                .batch
                .prepare(
                    state,
                    profile_request,
                    &request["selection"],
                    context.batch_progress,
                )
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "send-book-telegram" | "send-book-email" => state
                .delivery
                .send(
                    state,
                    profile_request,
                    &request,
                    action == "send-book-telegram",
                )
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "telegram-bot-account" => state
                .delivery
                .telegram()
                .account(
                    state,
                    profile_request,
                    text(&request, "operation"),
                    &request["options"],
                )
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "admin-telegram-bot-status" => {
                if !permitted_scope {
                    return fault("need_profile_login");
                }
                if !admin {
                    return fault("Требуются права администратора");
                }
                json!({"telegramBotStatus":state.delivery.telegram().status()})
            }
            "create-admin-backup"
            | "preview-admin-backup"
            | "import-admin-backup"
            | "admin-backup-vault" => {
                if !admin {
                    return fault("Требуются права администратора");
                }
                state
                    .backups
                    .dispatch(state, profile_request, &action, &request)
                    .unwrap_or_else(|error| fault(&error.to_string()))
            }
            "start-library-audit"
            | "cancel-library-audit"
            | "get-admin-dashboard"
            | "get-admin-dashboard-metrics"
            | "get-admin-performance"
            | "start-admin-benchmark"
            | "cancel-admin-benchmark"
            | "get-admin-events"
            | "update-admin-event-log"
            | "add-admin-test-event" => {
                if !admin {
                    return fault("Требуются права администратора");
                }
                let owner = BrowserProfileRequest {
                    token: &access.token,
                    user: access.owner.as_deref().unwrap_or(requested),
                    ..profile_request
                };
                state
                    .diagnostics
                    .dispatch(state, owner, &access, &action, &request)
                    .unwrap_or_else(|error| fault(&error.to_string()))
            }
            "update-admin-integrations"
            | "test-admin-integration"
            | "update-admin-opds"
            | "update-admin-library-sources"
            | "admin-diagnose-library-source"
            | "set-admin-resource-profile"
            | "set-admin-isbn-threads"
            | "update-admin-cache"
            | "admin-clean-cache"
            | "admin-clean-broken-covers"
            | "admin-rebuild-cover"
            | "export-admin-settings"
            | "import-admin-settings" => {
                if !permitted_scope {
                    return fault("need_profile_login");
                }
                if !admin {
                    return fault("Требуются права администратора");
                }
                state
                    .settings
                    .dispatch(state, &action, &request, self.import_limit)
                    .unwrap_or_else(|error| fault(&error.to_string()))
            }
            "get-library-metadata" => state
                .exchange
                .metadata(state, &request)
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "start-isbn-index" | "cancel-isbn-index" => {
                if !permitted_scope {
                    return fault("need_profile_login");
                }
                if !admin {
                    return fault("Требуются права администратора");
                }
                let result = if action == "start-isbn-index" {
                    super::isbn::start(state, request["options"]["force"] == true)
                } else {
                    state.index.isbn.cancel();
                    super::isbn::status(state)
                };
                result.unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-background-tasks" => {
                let owner = match state
                    .access
                    .with_personal_profile(profile_request, |_, owner, _| Ok(owner.into()))
                {
                    Ok(owner) => owner,
                    Err(error) => return fault(&error.to_string()),
                };
                super::tasks::snapshot(state, owner.as_str().unwrap_or_default(), admin)
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-discovery-shelves" => self
                .discovery(state, profile_request, &request, admin)
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "update-discovery-preferences"
            | "record-discovery-events"
            | "update-shared-discovery-config" => state
                .access
                .with_personal_profile(profile_request, |store, owner, stamp| {
                    store.discovery_request(owner, stamp, &action, &request)
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "update-book-metadata" => state
                .access
                .with_personal_profile(profile_request, |store, owner, stamp| {
                    store.update_book_metadata(
                        owner,
                        stamp,
                        text(&request, "bookUid"),
                        &request["metadata"],
                    )
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "catalog-entity" => {
                let read = || {
                    let reading = state.access.catalogue_reading(&access, permitted_scope)?;
                    let catalogue = state.index.catalogue.read().expect("open catalogue");
                    let catalogue = catalogue
                        .as_ref()
                        .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                    catalogue.browser_entity(&request["options"], &reading)
                };
                read().unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "admin-reindex" => {
                let Some(profile) = access.users.iter().find(|profile| {
                    access.owner.as_deref() == Some(profile.id.as_str())
                        && (requested.is_empty()
                            || requested == profile.id
                            || requested == profile.login)
                }) else {
                    return fault("need_profile_login");
                };
                if !profile.is_admin {
                    return fault("Только администратор может управлять профилями");
                }
                state
                    .reindex()
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "login-user-profile" => {
                let login = text(&request, "login").to_owned();
                let otp = take_text(&mut request, "otp");
                if login.len() > 100 || password.len() > 4096 || otp.len() > 64 {
                    return fault("INPX_INVALID_PROFILE_CREDENTIALS");
                }
                let result = state
                    .access
                    .login(browser, peer, &login, password, otp, None);
                if let (Some(activity), BrowserLogin::Accepted { user, .. }) =
                    (&state.metrics.activity, &result)
                {
                    activity.login(user);
                    if let Some(id) = connection {
                        activity.seen(id, Some(user));
                    }
                }
                login_response(result)
            }
            "profile-totp-enrollment"
            | "profile-totp"
            | "reset-user-profile-totp"
            | "set-user-profile-totp-required"
            | "set-profile-auth-policy"
            | "create-user-profile"
            | "update-user-profile"
            | "set-user-profile-blocked"
            | "delete-user-profile" => state
                .access
                .profile_command(
                    profile_request,
                    admission,
                    state.request_access.profile_binding(),
                    &self.root,
                    &action,
                    &request,
                )
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "resume-user-profile" => {
                let Some(owner) = access
                    .owner
                    .as_deref()
                    .filter(|owner| access.bound || requested.is_empty() || requested == *owner)
                else {
                    return fault("need_profile_login");
                };
                if !access.bound {
                    state.access.sessions.resume(browser, &access.token);
                }
                json!({"userId":owner,"profileAccessToken":access.token})
            }
            "logout-user-profile" => {
                *subscription = Change::Clear;
                if access.bound {
                    state.access.sessions.clear_proxy(browser);
                } else {
                    state
                        .access
                        .sessions
                        .logout(browser, text(&request, "profileAccessToken"));
                }
                if let (Some(activity), Some(id)) = (&state.metrics.activity, connection) {
                    activity.seen(id, None);
                }
                json!({"success":true})
            }
            "logout" => {
                *subscription = Change::Clear;
                state
                    .access
                    .library
                    .logout(text(&request, "accessToken"))
                    .map(|()| json!({"success":true}))
                    .unwrap_or_else(|error| {
                        eprintln!("WebAccess revoke: {error}");
                        fault("Хранилище сеансов доступа недоступно")
                    })
            }
            "kosync-settings" => {
                let operation = request
                    .get("operation")
                    .map_or("status", |value| value.as_str().unwrap_or_default());
                match state
                    .access
                    .kosync_settings(profile_request, peer, operation, password)
                {
                    Ok(mut result) => {
                        if result.get("error").is_none() {
                            result["path"] = state.kosync.root.as_str().into();
                        }
                        result
                    }
                    Err(error) if error.to_string() == "INPX_INVALID_PROFILE_CREDENTIALS" => {
                        json!({"error":"Неверный пароль INPX Web","errorCode":"INPX_INVALID_PROFILE_CREDENTIALS"})
                    }
                    Err(error) => fault(&error.to_string()),
                }
            }
            "get-reader-state" | "update-reader-progress" => {
                let default_patch = json!({});
                let patch = (action == "update-reader-progress")
                    .then(|| request.get("progress").unwrap_or(&default_patch));
                state
                    .access
                    .with_profile(profile_request, |store, owner, stamp| {
                        store.request(owner, stamp, text(&request, "bookUid"), patch)
                    })
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "prepare-reader-audio"
            | "get-reader-audio-plan"
            | "get-reader-audio-status"
            | "preview-reader-voice"
            | "cancel-reader-audio" => {
                let owner = match state
                    .access
                    .with_profile(profile_request, |_, owner, _| Ok(owner.into()))
                {
                    Ok(owner) => owner,
                    Err(error) => return fault(&error.to_string()),
                };
                state
                    .speech
                    .request(state, owner.as_str().unwrap_or_default(), &request)
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-audio-position" | "update-audio-position" => {
                let patch = (action == "update-audio-position").then_some(&request["progress"]);
                state
                    .access
                    .with_profile(profile_request, |store, owner, stamp| {
                        store.audio_position(
                            owner,
                            stamp,
                            text(&request, "bookUid"),
                            text(&request, "variant"),
                            patch,
                        )
                    })
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "search-reader-replacement" => {
                if let Err(error) = state
                    .access
                    .with_profile(profile_request, |_, _, _| Ok(Value::Null))
                {
                    return fault(&error.to_string());
                }
                let title = truncate(text(&request, "title").trim(), 200);
                let author = truncate(text(&request, "author").trim(), 200);
                if title.is_empty() && author.is_empty() {
                    return fault("Укажите название или автора");
                }
                self.catalogue(state, "bookSearch", &json!({
                    "query":{"title":title,"author":author,"ext":"fb2","del":"0","limit":20,"offset":0}
                }))
            }
            "relink-reader-book" => state
                .access
                .with_profile(profile_request, |store, owner, stamp| {
                    let source = text(&request, "bookUid").trim();
                    let target = text(&request, "replacementBookUid").trim();
                    let catalogue = state.index.catalogue.read().expect("open catalogue");
                    let catalogue = catalogue
                        .as_ref()
                        .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                    if catalogue.browser_book(source)?.is_some() {
                        return Err("Исходная книга доступна. Перенос не требуется".into());
                    }
                    if !catalogue
                        .browser_book(target)?
                        .is_some_and(|row| text(&row, "ext").eq_ignore_ascii_case("fb2"))
                    {
                        return Err("Выберите доступную книгу в формате FB2".into());
                    }
                    store.relink_progress(owner, stamp, source, target, &request["baseRevision"])
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "delete-reader-progress" | "forget-hidden-book" | "clear-reader-progress" => state
                .access
                .with_profile(profile_request, |store, owner, stamp| {
                    let uid =
                        (action != "clear-reader-progress").then(|| text(&request, "bookUid"));
                    store.delete_progress(
                        owner,
                        stamp,
                        uid,
                        (action == "forget-hidden-book").then_some(&request),
                    )
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "update-reader-preferences" | "export-reading-lists" | "import-reading-lists" => state
                .access
                .with_profile(profile_request, |store, owner, stamp| {
                    match action.as_str() {
                        "update-reader-preferences" => store.update_preferences(
                            owner,
                            stamp,
                            &request["preferences"],
                            &self.root,
                        ),
                        "export-reading-lists" => store.export_reading_lists(owner, stamp),
                        _ => store.import_reading_lists(
                            owner,
                            stamp,
                            &request["data"],
                            &self.root,
                            self.import_limit,
                        ),
                    }
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "add-reader-bookmark" | "delete-reader-bookmark" => state
                .access
                .with_profile(profile_request, |store, owner, stamp| {
                    store.bookmark_request(owner, stamp, &action, &request)
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            "get-library-follows" | "change-library-follow" => state
                .access
                .with_personal_profile(profile_request, |store, owner, stamp| {
                    let catalogue = state.index.catalogue.read().expect("open catalogue");
                    let catalogue = catalogue
                        .as_ref()
                        .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                    store.library_follows(owner, stamp, &action, &request, catalogue)
                })
                .unwrap_or_else(|failure| fault(&failure.to_string())),
            action
                if shelf_mutation(action)
                    || matches!(
                        action,
                        "get-reading-lists"
                            | "get-reading-list"
                            | "get-user-reading-library"
                            | "get-mobile-home"
                            | "get-overview-pinned-shelves"
                    ) =>
            {
                reading_shelves(state, profile_request, action, &request)
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-book-preview" => {
                let uid = text(&request, "bookUid");
                if uid.is_empty() || uid.encode_utf16().count() > 1024 {
                    return fault("Invalid book UID");
                }
                let Some(_permit) = self.previews.try_take() else {
                    return json!({"error":"Preview queue is full","errorCode":"INPX_RESOURCE_IO_QUEUE_FULL"});
                };
                let _resource = match state.resources.acquire(super::resources::Kind::Archives) {
                    Ok(permit) => permit,
                    Err(error) => return fault(&error.to_string()),
                };
                match crate::standalone_download::load_book(&state.index.catalogue, uid) {
                    Ok(book) => book_preview::read(uid, book.as_ref(), &state.index.sources()),
                    Err(failure) => fault(&failure.to_string()),
                }
            }
            "get-book-link" | "get-book-info" | "get-book-gallery" => {
                if action == "get-book-info"
                    && request["readerOnly"] == true
                    && self.web_config["onlineReaderEnabled"] == false
                {
                    return fault("Онлайн-читалка отключена.");
                }
                let uid = text(&request, "bookUid");
                if uid.is_empty() {
                    return fault("bookUid is empty");
                }
                let Some(_permit) = state.download_slots.try_take() else {
                    return fault("server_busy");
                };
                let result = match action.as_str() {
                    "get-book-info" => state.downloads.book_info(
                        uid,
                        &state.index.catalogue,
                        &state.index.sources(),
                        request["card"] == true,
                        request["readerOnly"] == true,
                    ),
                    "get-book-gallery" => {
                        state
                            .downloads
                            .gallery(uid, &state.index.catalogue, &state.index.sources())
                    }
                    _ => state.downloads.book_link(
                        uid,
                        &state.index.catalogue,
                        &state.index.sources(),
                    ),
                };
                match result {
                    Ok(Some(mut result)) => {
                        if let Some(book) = result
                            .get_mut("bookInfo")
                            .and_then(|info| info.get_mut("book"))
                            .and_then(Value::as_object_mut)
                        {
                            match state.access.metadata_overrides() {
                                Ok(overrides) => apply_metadata_override(book, &overrides),
                                Err(error) => return fault(&error.to_string()),
                            }
                        }
                        result
                    }
                    Ok(None) => fault("404 Файл не найден"),
                    Err(failure) => {
                        use inpx_catalog::book_delivery::{DownloadError, classify};
                        match classify(failure.as_ref()) {
                            DownloadError::Missing => fault("404 Файл не найден"),
                            DownloadError::Unsupported => fault("Неподдерживаемый формат книги"),
                            DownloadError::DecoderMemory => fault(&failure.to_string()),
                            DownloadError::Limit => fault("Файл книги слишком большой"),
                            DownloadError::Internal => {
                                eprintln!("WebSocket book link: {failure}");
                                fault("Не удалось подготовить книгу")
                            }
                        }
                    }
                }
            }
            _ => self.catalogue(state, &action, &request),
        };
        if permitted_scope {
            state.diagnostics.log_action(state, &action, &response);
        }
        let event_kind = if action == "update-audio-position" {
            Some("audio")
        } else if reader_change(&action) {
            Some("reader")
        } else {
            None
        };
        if permitted_scope
            && text(&response, "error").is_empty()
            && let Some(kind) = event_kind
            && ["conflict", "generationMismatch", "reset"]
                .into_iter()
                .all(|field| response["progress"][field] != true)
            && let Some(owner) = access.owner.as_deref()
        {
            state.events.send(
                kind,
                Some(context.events_connection),
                owner,
                text(&request, "bookUid"),
            );
        }
        response
    }

    fn config(
        &self,
        state: &State,
        access: &BrowserAccess,
        requested: &str,
        admission: &Admission,
        request: &Value,
    ) -> Value {
        let bare = access.required && access.owner.is_none();
        let mut config = if bare {
            [
                "name",
                "version",
                "branch",
                "dbVersion",
                "rootPathStatic",
                "clientApi",
                "freeAccess",
                "canRememberProfileDevice",
            ]
            .into_iter()
            .filter_map(|key| {
                self.web_config
                    .get(key)
                    .map(|value| (key.into(), value.clone()))
            })
            .collect()
        } else {
            self.web_config.clone()
        };
        let selected = if bare {
            None
        } else {
            select_profile(access, requested)
        };
        let authorized = selected.is_some_and(|profile| {
            !profile.anonymous_profile
                && (access.owner.as_deref() == Some(profile.id.as_str())
                    || !access.required && !profile.requires_login && !profile.otp_required)
        });
        let binding = state.request_access.profile_binding();
        let can_remember = !binding
            && admission.secure
            && request["client"]["type"] != "android"
            && access.auth_policy["trustedBrowsersEnabled"] == true;
        if let Some(features) = config
            .get_mut("clientApi")
            .and_then(|api| api["features"].as_array_mut())
        {
            features.extend(
                ["profileTotp", "adminProfileTotpReset", "adminProfileBlock"].map(Value::from),
            );
            if !binding {
                features.extend(["adminProfileTotpPolicy", "profileAuthPolicy"].map(Value::from));
            }
        }
        config.insert("canRememberProfileDevice".into(), can_remember.into());
        if can_remember {
            config.insert(
                "trustedBrowserDays".into(),
                access.auth_policy["trustedBrowserDays"].clone(),
            );
        }
        config.extend(json!({
            "csrfToken":access.csrf,
            "profileLoginRequired":access.required,"profileAuthorized":authorized,
            "profileBoundId":access.owner.as_deref().filter(|_|access.bound).unwrap_or_default(),
            "currentUserId":selected.map_or("",|profile| profile.id.as_str()),
            "currentUserProfile":selected.map(|profile| json!({
                "id":profile.id,"name":profile.name,"login":profile.login,
                "hasPassword":profile.requires_login,"anonymousProfile":profile.anonymous_profile,"isAdmin":profile.is_admin,
                "otpEnabled":authorized && profile.otp_enabled,"otpRequired":authorized && profile.otp_required,
                "opdsEnabled":profile.opds_enabled,"opdsAuthEnabled":profile.opds_auth_enabled,
                "defaultDownloadFormat":"original","defaultOpdsFormat":if authorized && !profile.preferred_format.is_empty() { &profile.preferred_format } else { "original" },
                "currentReading":[],"currentReadingCount":0,"readerPreferences":null,
                "personalRecommendationsEnabled":authorized && profile.personal_recommendations_enabled,
            })),
            "userProfiles":if bare { Vec::new() } else { profile_rows(access) },
        }).as_object().expect("browser profile config").clone());
        if let Some(profile) = selected.filter(|_| authorized) {
            if let Ok(details) = state.access.profile_settings(access, &profile.id)
                && let Some(details) = details.as_object()
            {
                let current = config
                    .get_mut("currentUserProfile")
                    .and_then(Value::as_object_mut)
                    .expect("selected browser profile");
                for key in [
                    "emailTo",
                    "telegramChatId",
                    "defaultDownloadFormat",
                    "defaultEmailFormat",
                    "defaultTelegramFormat",
                    "defaultOpdsFormat",
                    "emailAsZip",
                    "telegramAsZip",
                    "overviewShelfLayout",
                    "readerPreferences",
                ] {
                    if let Some(value) = details.get(key) {
                        current.insert(key.into(), value.clone());
                    }
                }
            }
            if !binding && profile.is_admin {
                config.insert("profileAuthPolicy".into(), access.auth_policy.clone());
            }
        }
        let (telegram, email) = if authorized {
            config
                .get("currentUserProfile")
                .map_or((false, false), |profile| state.delivery.options(profile))
        } else {
            (false, false)
        };
        config.insert("telegramShareEnabled".into(), telegram.into());
        config.insert("emailShareEnabled".into(), email.into());
        if !bare {
            let current = state.settings.snapshot();
            config.insert(
                "opdsRoot".into(),
                current["opds"]["root"].as_str().unwrap_or("/opds").into(),
            );
            config.insert(
                "extendedSearch".into(),
                (current["extendedSearch"] != false).into(),
            );
            if let Some(link) = current.get("bookReadLink") {
                config.insert("bookReadLink".into(), link.clone());
            }
            if let Some(defaults) = current["uiDefaults"].as_object()
                && let Some(view) = config.get_mut("uiDefaults").and_then(Value::as_object_mut)
            {
                view.extend(defaults.clone());
            }
            if authorized && selected.is_some_and(|profile| profile.is_admin) {
                config.insert(
                    "adminIntegrations".into(),
                    super::settings::admin_integrations(&current, state),
                );
                config.insert(
                    "adminOpds".into(),
                    super::settings::opds_view(&current["opds"], true),
                );
                config.insert(
                    "adminCache".into(),
                    super::admin_cache::Cache::settings(&current),
                );
                config.insert(
                    "adminLibrarySources".into(),
                    super::settings::display_sources(&current, state),
                );
            }
            let index = state.index.snapshot();
            if let Some(source) = state
                .index
                .sources()
                .iter()
                .find(|source| source.kind != Some(inpx_catalog::library_sources::Kind::Folder))
                && let Some(protocol) = config.get_mut("libraryProtocol")
            {
                protocol["sourceId"] = source.id.as_str().into();
            }
            config.insert("librarySources".into(), index["sources"].clone());
            config.insert("dbConfig".into(), json!({
                "inpxHash":index["inpxHash"],"inpxInfo":index["inpxInfo"],"stats":index["stats"],
                "indexUpdate":index["indexUpdate"]
            }));
            config.insert(
                "discovery".into(),
                self.discovery_config(&state.access.shared_discovery_config().unwrap_or_default()),
            );
        }
        Value::Object(config)
    }

    fn catalogue(&self, state: &State, action: &str, request: &Value) -> Value {
        if !matches!(
            action,
            "search"
                | "bookSearch"
                | "catalog-browse"
                | "catalog-suggest"
                | "get-author-book-list"
                | "get-author-series-list"
                | "get-series-book-list"
                | "get-genre-tree"
        ) {
            return fault(&format!("Unknown action: {action}"));
        }
        let empty = Map::new();
        let query = request["query"].as_object().unwrap_or(&empty);
        if matches!(action, "search" | "bookSearch") && !request["query"].is_object() {
            return fault("query is empty");
        }
        if query
            .get("ratingCount")
            .is_some_and(|value| !value.is_null() && value != "")
            && let Err(error) = state.exchange.prepare_rating_filter(state)
        {
            return fault(&error.to_string());
        }
        let overrides = if matches!(
            action,
            "search" | "bookSearch" | "get-author-book-list" | "get-series-book-list"
        ) {
            match state.access.metadata_overrides() {
                Ok(overrides) => Some(overrides),
                Err(error) => return fault(&error.to_string()),
            }
        } else {
            None
        };
        let catalogue = state.index.catalogue.read().expect("open catalogue");
        let Some(catalogue) = catalogue.as_ref() else {
            return fault("Каталог недоступен. Перезапустите сервер.");
        };
        let returned = match action {
            "search" => match text(request, "from") {
                "" => return fault("from is empty"),
                table => catalogue.browser_names(table, query),
            },
            "bookSearch" if !state.settings.extended_search() => {
                return fault("config.extendedSearch disabled");
            }
            "bookSearch" => catalogue.browser_books(query),
            "catalog-browse" => catalogue.browser_browse(&request["options"]),
            "catalog-suggest" => catalogue.browser_suggest(&request["options"]),
            "get-author-book-list" | "get-author-series-list" => {
                let id = request["authorId"]
                    .as_u64()
                    .and_then(|id| id.try_into().ok())
                    .or_else(|| request["authorId"].as_str().and_then(|id| id.parse().ok()))
                    .unwrap_or(0);
                catalogue.browser_author(id, query, action == "get-author-series-list")
            }
            "get-series-book-list" => catalogue.browser_series(text(request, "series"), query),
            "get-genre-tree" => crate::opds::standalone::genre_tree(catalogue),
            _ => unreachable!("catalogue action already selected"),
        };
        returned
            .map(|mut result| {
                if let Some(overrides) = overrides {
                    apply_search_metadata(&mut result, &overrides);
                }
                result
            })
            .unwrap_or_else(|failure| fault(&failure.to_string()))
    }

    fn discovery(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        request: &Value,
        admin: bool,
    ) -> inpx_catalog::Result<Value> {
        let mut config = self.discovery_config(&state.access.shared_discovery_config()?);
        if config["enabled"] == false {
            return Ok(json!({"shelves":[]}));
        }
        if admin {
            let overrides: Map<_, _> = [
                "externalSource",
                "externalName",
                "externalUrl",
                "externalTtlMinutes",
            ]
            .into_iter()
            .filter_map(|key| {
                request
                    .get(key)
                    .map(|value| (key.to_owned(), value.clone()))
            })
            .collect();
            if !overrides.is_empty() {
                let patch = shared_discovery(&config, &Value::Object(overrides));
                config
                    .as_object_mut()
                    .expect("discovery config")
                    .extend(patch.as_object().expect("external config").clone());
            }
        }
        let recommendations_only = request["recommendationsOnly"] == true;
        let external_only = request["externalOnly"] == true && !recommendations_only;
        let mut result = if external_only {
            json!({"shelves":[]})
        } else {
            self.local_discovery(state, profile, request, &config, recommendations_only)?
        };
        if !recommendations_only
            && (external_only || request["includeExternal"] != false)
            && let Some(options) = ExternalOptions::new(&config, request)
        {
            let shelf = self
                .external
                .feed(&options)
                .and_then(|feed| {
                    let catalogue = state.index.catalogue.read().expect("open catalogue");
                    let catalogue = catalogue
                        .as_ref()
                        .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                    self.external.build_shelf(catalogue, &options, feed)
                })
                .unwrap_or_else(|error| options.error_shelf(&error));
            result["shelves"]
                .as_array_mut()
                .expect("discovery shelves")
                .push(shelf);
        }
        Ok(result)
    }

    fn discovery_config(&self, stored: &Value) -> Value {
        let base = &self.web_config["discovery"];
        let mut merged = shared_discovery(base, stored);
        merged["enabled"] = (base["enabled"] != false).into();
        merged["shelfLimit"] = discovery_limit(&base["shelfLimit"], 8, 24).into();
        merged
    }

    fn local_discovery(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        request: &Value,
        config: &Value,
        recommendations_only: bool,
    ) -> inpx_catalog::Result<Value> {
        let default = discovery_limit(&config["shelfLimit"], 8, 24);
        let personal_limit = discovery_limit(
            &request["personalLimit"],
            if recommendations_only { 12 } else { default },
            24,
        );
        let personal = if recommendations_only || !profile.user.is_empty() {
            let read = state
                .access
                .with_personal_profile(profile, |store, owner, stamp| {
                    store.personal_discovery(owner, stamp)
                });
            if recommendations_only {
                Some(read?)
            } else {
                read.ok()
            }
        } else {
            None
        };
        let scores = if recommendations_only {
            None
        } else {
            Some(state.access.discovery_scores()?)
        };
        let catalogue = state.index.catalogue.read().expect("open catalogue");
        let catalogue = catalogue
            .as_ref()
            .ok_or("Каталог недоступен. Перезапустите сервер.")?;
        let mut result = if let Some(scores) = scores {
            catalogue.local_overview(
                discovery_limit(&request["newestLimit"], default, 24),
                discovery_limit(&request["popularLimit"], default, 24),
                &scores,
            )?
        } else {
            json!({"shelves":[]})
        };
        if let Some(personal) = personal {
            let similar_limit = if recommendations_only {
                Some(personal_limit)
            } else {
                (request["personalSimilarEnabled"] != false).then_some(personal_limit.max(16))
            };
            let shelves = catalogue.personal_overview(
                &personal,
                personal_limit,
                similar_limit,
                recommendations_only,
            )?;
            result["shelves"]
                .as_array_mut()
                .expect("discovery shelves")
                .extend(shelves);
        }
        Ok(result)
    }
}

struct DispatchContext<'a> {
    connection: Option<u64>,
    events_connection: u64,
    batch_progress: &'a dyn Fn(usize, usize),
}

async fn run(
    client: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    state: Arc<State>,
    browser: String,
    admission: Arc<Admission>,
) {
    let settings = WebSocketConfig::default()
        .max_message_size(Some(state.socket.frame_limit))
        .max_frame_size(Some(state.socket.frame_limit))
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0);
    let mut socket = WebSocketStream::from_raw_socket(client, Role::Server, Some(settings)).await;
    let online = state
        .metrics
        .activity
        .as_ref()
        .map(|activity| activity.connect());
    let connection = online.as_ref().map(|connection| connection.id);
    let events_connection = state.events.connect();
    let mut subscribed = None::<(Arc<Subscription>, Receiver<Arc<Event>>)>;
    let mut running = JoinSet::new();
    let (replies, mut incoming) = mpsc::channel(16);
    loop {
        tokio::select! {
            message = timeout(IDLE, socket.next()) => {
                let frame = match message {
                    Ok(Some(Ok(Message::Text(text)))) => text,
                    Ok(Some(Ok(Message::Binary(_)))) => {
                        close(&mut socket, CloseCode::Unsupported, "Text JSON required").await;
                        return;
                    }
                    Ok(Some(Ok(Message::Close(_)))) => { let _ = socket.flush().await; return; }
                    Ok(Some(Ok(Message::Ping(_)))) => { if socket.flush().await.is_err() { return; } continue; }
                    Ok(Some(Ok(_))) => continue,
                    Ok(Some(Err(Error::Capacity(_)))) => { close(&mut socket, CloseCode::Size, "").await; return; }
                    Ok(Some(Err(Error::Utf8(_)))) => { close(&mut socket, CloseCode::Invalid, "").await; return; }
                    _ => return,
                };
                let Ok(request) = serde_json::from_str::<Value>(&frame) else {
                    if send(&mut socket, fault("Некорректный запрос WebSocket"), None).await.is_err() { return; }
                    continue;
                };
                let id = request.get("requestId").filter(|id| match id {
                    Value::Null | Value::Bool(false) => false,
                    Value::String(value) => !value.is_empty(),
                    Value::Number(value) => value.as_f64() != Some(0.0),
                    _ => true,
                }).cloned();
                // The browser requests a fresh salt with an otherwise empty envelope.
                let probe = state.access.library.protected() && request.as_object().is_some_and(|fields|
                    fields.len() == 1 && fields.contains_key("requestId"));
                let limit = match request["action"].as_str() {
                    Some("update-reader-preferences" | "update-user-profile") => state.socket.message_limit.max(6 * MIB),
                    Some("import-reading-lists" | "import-admin-settings") => state.socket.import_limit + 65536,
                    Some("preview-admin-backup" | "import-admin-backup") => state.backups.request_limit(),
                    _ => state.socket.message_limit,
                };
                if (!probe && !request["action"].is_string()) || frame.len() > limit {
                    let reason = if request["action"].is_string() { "Превышен размер запроса" } else { "Некорректный запрос WebSocket" };
                    if send(&mut socket, fault(reason), id).await.is_err() { return; }
                    continue;
                }
                if send(&mut socket,json!({"_rok":1}),id.clone()).await.is_err() { return; }
                let Some(permit) = (running.len() < CONNECTION_REQUESTS)
                    .then(|| state.socket.jobs.clone().try_acquire_owned().ok()).flatten()
                else {
                    if send(&mut socket, fault("server_busy"), id).await.is_err() { return; }
                    continue;
                };
                let state = state.clone();
                let browser = browser.clone();
                let admission = admission.clone();
                let replies = replies.clone();
                running.spawn(async move {
                    let _permit = permit;
                    let progress_replies = replies.clone();
                    let progress_id = id.clone();
                    let (response, change) = tokio::task::spawn_blocking(move || {
                        let mut change = Change::Unchanged;
                        let enabled = request["wantProgress"] == true;
                        let last = std::cell::Cell::new(None::<Instant>);
                        let batch_progress = |done, total| {
                            if enabled && (done == total || last.get().is_none_or(|time| time.elapsed() >= Duration::from_millis(200))) {
                                let update = json!({"_progress":true,"progress":{"done":done,"total":total}});
                                if progress_replies.try_send((update, progress_id.clone(), Change::Unchanged)).is_ok() {
                                    last.set(Some(Instant::now()));
                                }
                            }
                        };
                        let response = state.socket.dispatch(&state, &browser, &admission,
                            DispatchContext {connection, events_connection, batch_progress: &batch_progress}, request, &mut change);
                        (response, change)
                    }).await.unwrap_or_else(|_| (fault("server_busy"), Change::Unchanged));
                    if response["error"] == "need_access_token" {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    let _ = replies.send((response, id, change)).await;
                });
            }
            result = running.join_next(), if !running.is_empty() => {
                if !matches!(result, Some(Ok(()))) { return; }
            }
            Some((result,id,change)) = incoming.recv() => {
                match change {
                    Change::Unchanged => (),
                    Change::Clear => subscribed = None,
                    Change::Subscribe(subscription) => {
                        subscribed = Some((Arc::new(subscription), state.events.subscribe()));
                    }
                }
                if send(&mut socket,result,id).await.is_err() { return; }
            }
            event = async { subscribed.as_mut().expect("event subscription").1.recv().await }, if subscribed.is_some() => {
                match event {
                    Ok(event) => {
                        let (subscription, _) = subscribed.as_ref().expect("event subscription");
                        if event.origin == Some(events_connection) || event.owner != subscription.owner { continue; }
                        if !subscription.clone().authorized(state.clone(), browser.clone(), admission.clone()).await {
                            close(&mut socket, CloseCode::Policy, "Session expired").await;
                            return;
                        }
                        if !matches!(timeout(Duration::from_secs(5), send(&mut socket,event.message(),None)).await, Ok(Ok(()))) { return; }
                    }
                    Err(RecvError::Lagged(_)) => {
                        close(&mut socket, CloseCode::Again, "Resubscribe and refresh").await;
                        return;
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        }
    }
}

async fn close<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    code: CloseCode,
    reason: &'static str,
) {
    let _ = timeout(
        Duration::from_secs(5),
        socket.close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await;
}

async fn send<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    mut result: Value,
    id: Option<Value>,
) -> std::result::Result<(), Error> {
    if let Some(id) = id {
        result["requestId"] = id;
    }
    socket.send(Message::Text(result.to_string().into())).await
}

fn select_profile<'a>(
    access: &'a BrowserAccess,
    requested: &str,
) -> Option<&'a inpx_catalog::profile_login::BrowserProfile> {
    access
        .owner
        .as_ref()
        .and_then(|owner| access.users.iter().find(|user| &user.id == owner))
        .or_else(|| access.users.iter().find(|user| user.id == requested))
        .or_else(|| access.users.iter().find(|user| user.anonymous_profile))
        .or_else(|| access.users.first())
}

fn profile_rows(access: &BrowserAccess) -> Vec<Value> {
    let owner = access.owner.as_deref().filter(|_| access.bound);
    let show_all = owner.is_none()
        || access
            .users
            .iter()
            .any(|user| user.is_admin && Some(user.id.as_str()) == owner);
    let admin = access
        .users
        .iter()
        .any(|user| user.is_admin && Some(user.id.as_str()) == access.owner.as_deref());
    let mut users: Vec<_> = access
        .users
        .iter()
        .chain(access.blocked_users.iter().filter(|_| admin))
        .filter(|user| show_all || Some(user.id.as_str()) == owner)
        .collect();
    users.sort_by(|left, right| left.name.cmp(&right.name));
    users.into_iter().map(|user| {
        let mut row = json!({"id":user.id,"name":user.name,"login":user.login,
        "requiresLogin":user.requires_login && Some(user.id.as_str()) != owner,"anonymousProfile":user.anonymous_profile,"isAdmin":user.is_admin,
        "opdsEnabled":user.opds_enabled,"opdsAuthEnabled":user.opds_auth_enabled,"currentReadingCount":0});
        if admin {
            row["otpEnabled"] = user.otp_enabled.into();
            row["otpRequired"] = user.otp_required_individual.into();
            row["blocked"] = user.blocked.into();
        }
        row
    }).collect()
}

fn profiles(access: &BrowserAccess, requested: &str) -> Value {
    json!({"users":profile_rows(access),"currentUserId":select_profile(access,requested).map_or("",|user| user.id.as_str())})
}

fn worker_state(state: &State, access: &BrowserAccess, worker: &str) -> Value {
    if access.required && access.owner.is_none() {
        return json!({"state":"normal","serverMessage":""});
    }
    if worker.is_empty() {
        return fault("key 'workerId' is empty");
    }
    if worker != "server_state" {
        return json!({});
    }
    let index = state.index.snapshot();
    json!({"workerId":worker,"state":index["state"],"serverMessage":index["serverMessage"],
        "updating":index["updating"],"job":index["job"],"jobMessage":index["jobMessage"],
        "progress":index["progress"],"recsLoaded":index["recsLoaded"],"jobStep":index["jobStep"],"jobStepCount":index["jobStepCount"]})
}

pub(super) fn login_response(result: BrowserLogin) -> Value {
    match result {
        BrowserLogin::Accepted { user, token, .. } => {
            json!({"userId":user,"profileAccessToken":token})
        }
        BrowserLogin::Invalid => {
            json!({"error":"Неверный логин или пароль","errorCode":"INPX_INVALID_PROFILE_CREDENTIALS"})
        }
        BrowserLogin::NeedOtp => {
            json!({"error":"Введите код двухфакторной защиты","errorCode":"need_profile_otp"})
        }
        BrowserLogin::NeedOtpSetup => {
            json!({"error":"Настройте обязательный OTP в веб-интерфейсе INPX Web","errorCode":"need_profile_otp_setup"})
        }
        BrowserLogin::RateLimited(seconds) => {
            json!({"error":"Слишком много попыток входа. Повторите позже.",
            "errorCode":"INPX_LOGIN_RATE_LIMIT","retryAfterMs":u64::from(seconds)*1000})
        }
        BrowserLogin::Unavailable => fault("Не удалось войти в профиль"),
    }
}

fn fault(message: &str) -> Value {
    json!({"error":message,"errorCode":message})
}

fn reading_shelves(
    state: &State,
    profile: BrowserProfileRequest<'_>,
    action: &str,
    request: &Value,
) -> inpx_catalog::Result<Value> {
    let run = || {
        let execute =
            |store: &inpx_catalog::reader_state::ReaderState, owner: &str, stamp: &str| {
                let guard = state.index.catalogue.read().expect("open catalogue");
                let catalogue = guard
                    .as_ref()
                    .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                match action {
                    "get-user-reading-library" => {
                        store.reading_library(owner, stamp, &request["options"], catalogue)
                    }
                    "get-mobile-home" => store.mobile_home(
                        owner,
                        stamp,
                        &request["limit"],
                        catalogue,
                        state.index.generation(),
                    ),
                    _ => store.shelf_request(owner, stamp, action, request, catalogue),
                }
            };
        if matches!(
            action,
            "get-overview-pinned-shelves" | "set-overview-pinned-shelves"
        ) {
            state.access.with_personal_profile(profile, execute)
        } else {
            state.access.with_profile(profile, execute)
        }
    };
    match run() {
        Err(error) if error.to_string() == inpx_catalog::library_media::RATING_FILTER_PENDING => {
            state.exchange.prepare_rating_filter(state)?;
            run()
        }
        result => result,
    }
}

fn shelf_mutation(action: &str) -> bool {
    matches!(
        action,
        "create-reading-list"
            | "rename-reading-list"
            | "set-reading-list-visibility"
            | "delete-reading-list"
            | "update-reading-list-book"
            | "set-reading-list-book-read"
            | "mark-reader-books-read"
            | "mark-series-read"
            | "mark-series-until"
            | "add-series-to-reading-list"
            | "set-overview-pinned-shelves"
    )
}

fn reader_change(action: &str) -> bool {
    shelf_mutation(action)
        || matches!(
            action,
            "update-reader-progress"
                | "relink-reader-book"
                | "delete-reader-progress"
                | "forget-hidden-book"
                | "clear-reader-progress"
                | "update-reader-preferences"
                | "add-reader-bookmark"
                | "delete-reader-bookmark"
                | "import-reading-lists"
                | "change-library-follow"
        )
}

fn text<'a>(request: &'a Value, field: &str) -> &'a str {
    request[field].as_str().unwrap_or_default()
}

fn truncate(value: &str, units: usize) -> &str {
    let mut left = units;
    for (offset, ch) in value.char_indices() {
        let Some(next) = left.checked_sub(ch.len_utf16()) else {
            return &value[..offset];
        };
        left = next;
    }
    value
}

fn take_text(request: &mut Value, field: &str) -> String {
    match request[field].take() {
        Value::String(value) => value,
        _ => String::new(),
    }
}

pub(super) fn megabytes(value: &Value, default: usize, max: usize) -> usize {
    let parsed = value.as_f64().or_else(|| value.as_str()?.parse().ok());
    parsed
        .filter(|value| value.is_finite() && *value >= 1.0)
        .map_or(default, |value| (value as usize).min(max))
        * MIB
}
