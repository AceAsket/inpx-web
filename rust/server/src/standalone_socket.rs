use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hyper::{Request, Response, StatusCode, body::Incoming, header};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::{
    CloseFrame, Role, WebSocketConfig, frame::coding::CloseCode,
};
use tokio_tungstenite::tungstenite::{Error, Message};

use super::{NAME, State, VERSION};
use crate::http::{Body, error};
use crate::request_access::Admission;
use crate::standalone_access::{
    BLOCKED_PROFILE, BrowserAccess, BrowserLogin, BrowserProfileRequest, PROXY_SCOPE, Rejection,
    profile_scope,
};
use crate::standalone_library::Admission as LibraryAdmission;

const IDLE: Duration = Duration::from_secs(5 * 60);
const CONNECTION_REQUESTS: usize = 8;
const MIB: usize = 1024 * 1024;

pub(super) struct Socket {
    root: String,
    route: String,
    web_config: Map<String, Value>,
    message_limit: usize,
    frame_limit: usize,
    jobs: Arc<Semaphore>,
}

impl Socket {
    pub(super) fn new(root: &str, config: &Value, epub_reader: bool, free_access: bool) -> Self {
        let root = root.trim_end_matches('/');
        let message_limit = megabytes(&config["wsMessageLimitMb"], 1, 16);
        let frame_limit = [
            message_limit,
            6 * MIB,
            megabytes(&config["importLimitMb"], 16, 64) + 65536,
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
        web_config.extend(json!({
            "name":NAME,"version":VERSION,"branch":"production","dbVersion":"15",
            "rootPathStatic":root,"freeAccess":free_access,
            "clientApi":{"version":1,"features":["resumeSession","bookSearchFormats"]},
            "opdsRoot":config["opds"]["root"].as_str().unwrap_or("/opds"),
            "extendedSearch":config["extendedSearch"]!=false,
            "conversionEnabled":epub_reader,"conversionFormats":if epub_reader { vec!["fb2"] } else { Vec::new() },
            "onlineReaderEnabled":config["onlineReaderEnabled"]!=false,"ebookReaderEnabled":false,
            "canRememberProfileDevice":false,"discovery":{},"ttsEnabled":false,
            "telegramShareEnabled":false,"emailShareEnabled":false,
        }).as_object().expect("web configuration").clone());
        Self {
            root: root.into(),
            route: format!("{root}/ws"),
            web_config,
            message_limit,
            frame_limit,
            jobs: Arc::new(Semaphore::new(64)),
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
        let Ok(session) = state
            .access
            .sessions
            .open(request.headers(), admission.secure)
        else {
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
        connection: Option<u64>,
        mut request: Value,
    ) -> Value {
        let peer = admission.client;
        let proxy_login = admission.proxy_login.as_deref();
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
        match action.as_str() {
            "test" => json!({"message":format!("{NAME} project is awesome")}),
            "get-config" => self.config(state, &access, requested),
            "get-worker-state" => worker_state(state, &access, text(&request, "workerId")),
            "get-user-profiles" => profiles(&access, requested),
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
                state.start_index_check(true);
                json!({"started":true})
            }
            "login-user-profile" => {
                let login = text(&request, "login").to_owned();
                let otp = take_text(&mut request, "otp");
                if login.len() > 100 || password.len() > 4096 || otp.len() > 64 {
                    return fault("INPX_INVALID_PROFILE_CREDENTIALS");
                }
                let result = state.access.login(browser, peer, &login, password, otp);
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
            "resume-user-profile" => {
                let Some(owner) = access
                    .owner
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
            "logout" => state
                .access
                .library
                .logout(text(&request, "accessToken"))
                .map(|()| json!({"success":true}))
                .unwrap_or_else(|error| {
                    eprintln!("WebAccess revoke: {error}");
                    fault("Хранилище сеансов доступа недоступно")
                }),
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
            action
                if shelf_mutation(action)
                    || matches!(
                        action,
                        "get-reading-lists" | "get-reading-list" | "get-user-reading-library"
                    ) =>
            {
                state
                    .access
                    .with_profile(profile_request, |store, owner, stamp| {
                        let catalogue = state.index.catalogue.lock().expect("open catalogue");
                        let catalogue = catalogue
                            .as_ref()
                            .ok_or("Каталог недоступен. Перезапустите сервер.")?;
                        if action == "get-user-reading-library" {
                            store.reading_library(owner, stamp, &request["options"], catalogue)
                        } else {
                            store.shelf_request(owner, stamp, action, &request, catalogue)
                        }
                    })
                    .unwrap_or_else(|failure| fault(&failure.to_string()))
            }
            "get-book-link" | "get-book-info" | "get-book-gallery" => {
                let uid = text(&request, "bookUid");
                if uid.is_empty() {
                    return fault("bookUid is empty");
                }
                let Ok(_permit) = state.download_slots.try_acquire() else {
                    return fault("server_busy");
                };
                let result = match action.as_str() {
                    "get-book-info" => state.downloads.book_info(
                        uid,
                        &state.index.catalogue,
                        &state.sources,
                        request["card"] == true,
                        request["readerOnly"] == true,
                    ),
                    "get-book-gallery" => {
                        state
                            .downloads
                            .gallery(uid, &state.index.catalogue, &state.sources)
                    }
                    _ => state
                        .downloads
                        .book_link(uid, &state.index.catalogue, &state.sources),
                };
                match result {
                    Ok(Some(result)) => result,
                    Ok(None) => fault("404 Файл не найден"),
                    Err(failure) => {
                        use inpx_catalog::book_delivery::{DownloadError, classify};
                        match classify(failure.as_ref()) {
                            DownloadError::Missing => fault("404 Файл не найден"),
                            DownloadError::Unsupported => fault("Неподдерживаемый формат книги"),
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
        }
    }

    fn config(&self, state: &State, access: &BrowserAccess, requested: &str) -> Value {
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
            })),
            "userProfiles":if bare { Vec::new() } else { profile_rows(access) },
        }).as_object().expect("browser profile config").clone());
        if !bare {
            let index = state.index.snapshot();
            config.insert("librarySources".into(), index["sources"].clone());
            config.insert("dbConfig".into(), json!({
                "inpxHash":index["inpxHash"],"inpxInfo":index["inpxInfo"],"stats":index["stats"],
                "indexUpdate":index["indexUpdate"]
            }));
        }
        Value::Object(config)
    }

    fn catalogue(&self, state: &State, action: &str, request: &Value) -> Value {
        if !matches!(
            action,
            "search"
                | "bookSearch"
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
        let catalogue = state.index.catalogue.lock().expect("open catalogue");
        let Some(catalogue) = catalogue.as_ref() else {
            return fault("Каталог недоступен. Перезапустите сервер.");
        };
        let returned = match action {
            "search" => match text(request, "from") {
                "" => return fault("from is empty"),
                table => catalogue.browser_names(table, query),
            },
            "bookSearch" if self.web_config.get("extendedSearch") == Some(&Value::Bool(false)) => {
                return fault("config.extendedSearch disabled");
            }
            "bookSearch" => catalogue.browser_books(query),
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
        returned.unwrap_or_else(|failure| fault(&failure.to_string()))
    }
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
    let mut running = JoinSet::new();
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
                if (!probe && !request["action"].is_string()) || frame.len() > state.socket.message_limit {
                    let reason = if request["action"].is_string() { "Превышен размер запроса" } else { "Некорректный запрос WebSocket" };
                    if send(&mut socket, fault(reason), id).await.is_err() { return; }
                    continue;
                }
                let Some(permit) = (running.len() < CONNECTION_REQUESTS)
                    .then(|| state.socket.jobs.clone().try_acquire_owned().ok()).flatten()
                else {
                    close(&mut socket, CloseCode::Again, "Too many active requests").await;
                    return;
                };
                if send(&mut socket,json!({"_rok":1}),id.clone()).await.is_err() { return; }
                let state = state.clone();
                let browser = browser.clone();
                let admission = admission.clone();
                running.spawn(async move {
                    let _permit = permit;
                    let response = tokio::task::spawn_blocking(move || {
                        state.socket.dispatch(&state, &browser, &admission, connection, request)
                    }).await.unwrap_or_else(|_| fault("server_busy"));
                    if response["error"] == "need_access_token" {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    (response, id)
                });
            }
            result = running.join_next(), if !running.is_empty() => {
                let Some(Ok((result,id))) = result else { return; };
                if send(&mut socket,result,id).await.is_err() { return; }
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
    let mut users: Vec<_> = access
        .users
        .iter()
        .filter(|user| show_all || Some(user.id.as_str()) == owner)
        .collect();
    users.sort_by(|left, right| left.name.cmp(&right.name));
    users.into_iter().map(|user| json!({"id":user.id,"name":user.name,"login":user.login,
        "requiresLogin":user.requires_login && Some(user.id.as_str()) != owner,"anonymousProfile":user.anonymous_profile,"isAdmin":user.is_admin,
        "opdsEnabled":user.opds_enabled,"opdsAuthEnabled":user.opds_auth_enabled,"currentReadingCount":0})).collect()
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

fn login_response(result: BrowserLogin) -> Value {
    match result {
        BrowserLogin::Accepted { user, token } => json!({"userId":user,"profileAccessToken":token}),
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
            | "add-series-to-reading-list"
    )
}

fn text<'a>(request: &'a Value, field: &str) -> &'a str {
    request[field].as_str().unwrap_or_default()
}

fn take_text(request: &mut Value, field: &str) -> String {
    match request[field].take() {
        Value::String(value) => value,
        _ => String::new(),
    }
}

fn megabytes(value: &Value, default: usize, max: usize) -> usize {
    let parsed = value.as_f64().or_else(|| value.as_str()?.parse().ok());
    parsed
        .filter(|value| value.is_finite() && *value >= 1.0)
        .map_or(default, |value| (value as usize).min(max))
        * MIB
}
