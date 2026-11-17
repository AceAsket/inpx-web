use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Limited};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    header,
};
use inpx_catalog::standalone_catalogue::Catalogue;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::State;
use crate::http::{Body, body};
use crate::opds::html::escape;
use crate::request_access::Admission;
use crate::standalone_access::{BrowserAccess, BrowserLogin, BrowserProfileRequest, Rejection};
use crate::standalone_library::Admission as LibraryAdmission;

#[path = "standalone_ebook_pages.rs"]
mod pages;
#[path = "standalone_ebook_reader.rs"]
mod reader;

const CSS: &str = include_str!("../../../shared/ebook.css");
const FORMAT_NAMES: &[&str] = &[
    "fb2", "epub", "epub3", "kepub", "kfx", "azw8", "pdf", "mobi",
];
const BAD_INPUT: &str = "Некорректные параметры запроса.";
const BUSY: &str = "Сервер занят или библиотека пока недоступна. Повторите запрос позже.";

type Params = BTreeMap<String, String>;
type Result<T> = std::result::Result<T, Failure>;

pub(super) struct Ebook {
    base: String,
    root: String,
    language: String,
    online: bool,
    binding: bool,
    conversions: Vec<&'static str>,
    slots: Arc<Semaphore>,
    login_slots: Arc<Semaphore>,
    text: reader::Cache,
}

struct Page<'a> {
    site: &'a Ebook,
    state: &'a State,
    admission: &'a Admission,
    browser: &'a str,
    access: BrowserAccess,
    profile: Value,
    path: &'a str,
    query: Params,
}

struct Failure {
    status: StatusCode,
    message: String,
}

impl Failure {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    fn invalid() -> Self {
        Self::new(StatusCode::BAD_REQUEST, BAD_INPUT)
    }
    fn missing(message: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    fn busy() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, BUSY)
    }
}

impl From<Box<dyn std::error::Error>> for Failure {
    fn from(error: Box<dyn std::error::Error>) -> Self {
        let message = error.to_string();
        match message.as_str() {
            "need_profile_login" => Self::new(StatusCode::UNAUTHORIZED, "Войдите в профиль."),
            "Список не найден" => Self::missing("Полка не найдена."),
            inpx_catalog::library_media::RATING_FILTER_PENDING => Self::busy(),
            _ => {
                eprintln!("Ebook: {error}");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось выполнить запрос. Попробуйте ещё раз.",
                )
            }
        }
    }
}

impl Ebook {
    pub(super) fn new(
        root: &str,
        config: &Value,
        binding: bool,
        conversions: Vec<&'static str>,
    ) -> Self {
        let root = root.trim_end_matches('/');
        Self {
            base: format!("{root}/ebook"),
            root: root.into(),
            language: text(&config["uiDefaults"], "langDefault").into(),
            online: config["onlineReaderEnabled"] != false,
            binding,
            conversions,
            slots: Arc::new(Semaphore::new(4)),
            login_slots: Arc::new(Semaphore::new(2)),
            text: reader::Cache::default(),
        }
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.strip_prefix(&self.base)
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('/'))
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        request: Request<Incoming>,
        admission: Admission,
    ) -> Response<Body> {
        let method = request.method().clone();
        let head = method == Method::HEAD;
        let path = request
            .uri()
            .path()
            .trim_end_matches('/')
            .strip_prefix(&self.base)
            .unwrap_or_default()
            .to_owned();
        let current = request
            .uri()
            .path_and_query()
            .map_or(self.base.as_str(), |value| value.as_str())
            .to_owned();
        let Ok(query) = parse(request.uri().query().unwrap_or_default(), 32) else {
            return self.early(Failure::invalid(), head);
        };
        if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
            let mut response = self.early(
                Failure::new(StatusCode::METHOD_NOT_ALLOWED, "Метод не поддерживается."),
                head,
            );
            response.headers_mut().insert(
                header::ALLOW,
                header::HeaderValue::from_static("GET, HEAD, POST"),
            );
            return response;
        }
        let permit = if method == Method::POST && matches!(path.as_str(), "/login" | "/access") {
            self.login_slots.clone().try_acquire_owned()
        } else {
            self.slots.clone().try_acquire_owned()
        };
        let Ok(permit) = permit else {
            return self.early(Failure::busy(), head);
        };
        let Ok(browser) = state
            .access
            .sessions
            .open(request.headers(), admission.secure)
        else {
            return self.early(Failure::busy(), head);
        };
        let form = if method == Method::POST {
            match read_form(request).await {
                Ok(form) => form,
                Err(error) => return self.early(error, head),
            }
        } else {
            Params::new()
        };
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let site = &state.ebook;
            let access =
                match state
                    .access
                    .browser(&browser.id, "", admission.proxy_login.as_deref())
                {
                    Ok(access) => access,
                    Err(Rejection::Blocked | Rejection::ProxyScope) => {
                        return site.early(
                            Failure::new(StatusCode::FORBIDDEN, "Профиль недоступен."),
                            head,
                        );
                    }
                    Err(_) => return site.early(Failure::busy(), head),
                };
            let profile = match access
                .owner
                .as_deref()
                .map(|owner| state.access.profile_settings(&access, owner))
                .transpose()
            {
                Ok(profile) => profile.unwrap_or_default(),
                Err(error) => return site.early(error.into(), head),
            };
            let page = Page {
                site,
                state: &state,
                admission: &admission,
                browser: &browser.id,
                access,
                profile,
                path: &path,
                query,
            };
            let outcome = if method == Method::POST {
                page.post(&form, &current)
            } else {
                page.get(&current, head).and_then(|response| {
                    if response.status().is_success() || response.status().is_redirection() {
                        page.check_identity()?;
                    }
                    Ok(response)
                })
            };
            let mut response = outcome.unwrap_or_else(|failure| page.error(failure, head));
            if let Some(cookie) = browser.cookie {
                response.headers_mut().append(header::SET_COOKIE, cookie);
            }
            response
        })
        .await
        .unwrap_or_else(|_| self.early(Failure::busy(), head))
    }

    fn early(&self, failure: Failure, head: bool) -> Response<Body> {
        html(
            failure.status,
            self.document(
                "Не удалось открыть страницу",
                &format!(
                    r#"<p class="error" role="alert">{}</p>"#,
                    escape(&failure.message)
                ),
                "",
                false,
                false,
            ),
            head,
        )
    }

    fn url(&self, path: &str, query: &Params) -> String {
        let query = encode(query);
        if query.is_empty() {
            format!("{}{path}", self.base)
        } else {
            format!("{}{path}?{query}", self.base)
        }
    }

    fn link(&self, path: &str, query: &Params, label: &str, class: &str) -> String {
        format!(
            r#"<a class="{class}" href="{}">{}</a>"#,
            escape(&self.url(path, query)),
            escape(label)
        )
    }

    fn destination(&self, value: &str) -> String {
        if value.len() <= 2048
            && value.starts_with('/')
            && !value.starts_with("//")
            && !value
                .bytes()
                .any(|byte| byte <= b' ' || byte == b'\\' || byte == 127)
            && let Ok(url) = url::Url::parse(&format!("http://ebook.local{value}"))
            && self.matches(url.path())
        {
            return url.query().map_or_else(
                || url.path().into(),
                |query| format!("{}?{query}", url.path()),
            );
        }
        self.base.clone()
    }

    fn document(
        &self,
        title: &str,
        content: &str,
        account: &str,
        reading: bool,
        compact: bool,
    ) -> String {
        let title = escape(title);
        let body = if compact {
            format!("<main>{content}</main>")
        } else {
            let brand = self.link("", &Params::new(), "INPX Web", "");
            let header = format!(
                r#"<header class="masthead"><div class="brand">{brand}</div><div class="account">{account}</div></header>"#
            );
            if reading {
                format!(
                    "{header}<p>{} · {title}</p><main>{content}</main>",
                    self.link("", &Params::new(), "Библиотека", "")
                )
            } else {
                let nav = [
                    ("", "Каталог"),
                    ("/shelves", "Мои полки"),
                    ("/recent", "Сейчас читаю"),
                ]
                .into_iter()
                .map(|(path, label)| self.link(path, &Params::new(), label, ""))
                .collect::<String>();
                format!(
                    r#"{header}<nav class="nav" aria-label="Навигация">{nav}</nav><main><h1>{title}</h1>{content}</main>"#
                )
            }
        };
        let class = if compact { "reader-compact" } else { "" };
        format!(
            r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>{title} — INPX Web</title><style>{CSS}</style></head><body class="{class}"><div class="wrap">{body}</div></body></html>"#
        )
    }
}

impl Page<'_> {
    fn owner(&self) -> Option<&str> {
        self.access.owner.as_deref()
    }

    fn profile_request(&self) -> BrowserProfileRequest<'_> {
        BrowserProfileRequest {
            browser: self.browser,
            token: &self.access.token,
            user: self.owner().unwrap_or_default(),
            proxy_login: self.admission.proxy_login.as_deref(),
        }
    }

    fn check_identity(&self) -> Result<()> {
        if self.owner().is_some() {
            let current =
                self.state
                    .access
                    .browser(self.browser, "", self.admission.proxy_login.as_deref());
            if !current.is_ok_and(|current| {
                current.owner.as_deref() == self.owner() && current.token == self.access.token
            }) {
                return Err(Failure::new(
                    StatusCode::UNAUTHORIZED,
                    "Сеанс завершён. Войдите снова.",
                ));
            }
        }
        Ok(())
    }

    fn catalogue<T>(&self, read: impl FnOnce(&Catalogue) -> Result<T>) -> Result<T> {
        let catalogue = self.state.index.catalogue.read().expect("open catalogue");
        read(catalogue.as_ref().ok_or_else(Failure::busy)?)
    }

    fn account(&self) -> String {
        if self.owner().is_none() {
            return self.site.link("/login", &Params::new(), "Войти", "");
        }
        let name = escape(text(&self.profile, "name"));
        if self.access.bound {
            return format!("<span>{name}</span> · Вход через proxy");
        }
        format!(
            r#"<span>{name}</span> <form class="inline" method="post" action="{}">{}<button>Выйти</button></form>"#,
            escape(&self.site.url("/logout", &Params::new())),
            hidden("csrf", &self.access.csrf)
        )
    }

    fn document(&self, title: &str, content: &str, head: bool) -> Response<Body> {
        html(
            StatusCode::OK,
            self.site
                .document(title, content, &self.account(), false, false),
            head,
        )
    }

    fn error(&self, failure: Failure, head: bool) -> Response<Body> {
        let back = self.site.link("", &Params::new(), "К поиску", "");
        let body = format!(
            r#"<p class="error" role="alert">{}</p>{back}"#,
            escape(&failure.message)
        );
        let account = if failure.status == StatusCode::UNAUTHORIZED {
            self.site.link("/login", &Params::new(), "Войти", "")
        } else {
            self.account()
        };
        html(
            failure.status,
            self.site
                .document("Не удалось открыть страницу", &body, &account, false, false),
            head,
        )
    }

    fn library_allowed(&self) -> Result<bool> {
        Ok(self
            .state
            .access
            .library
            .allowed(&self.state.access.sessions.ebook_access(self.browser))?)
    }

    fn get(&self, current: &str, head: bool) -> Result<Response<Body>> {
        if !self.library_allowed()? {
            return Ok(self.form(
                false,
                current,
                "",
                "",
                false,
                false,
                StatusCode::UNAUTHORIZED,
                head,
            ));
        }
        if self.path == "/login" {
            if self.site.binding {
                return Ok(self.document(
                    "Вход",
                    "<p>Профиль задаётся входом через proxy.</p>",
                    head,
                ));
            }
            return Ok(self.form(
                true,
                get(&self.query, "next"),
                "",
                "",
                false,
                false,
                StatusCode::OK,
                head,
            ));
        }
        if self.owner().is_none()
            && (self.access.required
                || matches!(self.path, "/shelves" | "/shelf")
                || self.download_route() && !self.query.contains_key("format"))
        {
            return Ok(self.form(
                true,
                current,
                "",
                "",
                false,
                false,
                StatusCode::UNAUTHORIZED,
                head,
            ));
        }
        if self.download_route() {
            return self.download();
        }
        let (title, content) = match self.path {
            "" => self.search()?,
            "/book" => self.book()?,
            "/read" => return self.read(head),
            "/recent" => self.recent()?,
            "/shelves" => self.shelves()?,
            "/shelf" => self.shelf()?,
            _ => return Err(Failure::missing("Страница не найдена.")),
        };
        Ok(self.document(&title, &content, head))
    }

    fn post(&self, form: &Params, current: &str) -> Result<Response<Body>> {
        if !matches!(
            self.path,
            "/access" | "/login" | "/logout" | "/format" | "/read"
        ) {
            return Err(Failure::missing("Страница не найдена."));
        }
        if !self
            .state
            .access
            .sessions
            .has_csrf(self.browser, scalar(form, "csrf", 128)?)
        {
            return Err(Failure::new(
                StatusCode::FORBIDDEN,
                "Обновите страницу и повторите действие.",
            ));
        }
        let next = self.site.destination(scalar(form, "next", 2048)?);
        if self.path == "/access" {
            return self.login_library(form, &next);
        }
        if self.path == "/logout" {
            if !self.access.bound {
                self.state
                    .access
                    .sessions
                    .logout(self.browser, &self.access.token);
                self.state
                    .access
                    .library
                    .logout(&self.state.access.sessions.ebook_access(self.browser))?;
                self.state
                    .access
                    .sessions
                    .set_ebook_access(self.browser, None);
            }
            return Ok(redirect(StatusCode::SEE_OTHER, &self.site.base));
        }
        if !self.library_allowed()? {
            return Ok(self.form(
                false,
                current,
                "",
                "",
                false,
                false,
                StatusCode::UNAUTHORIZED,
                false,
            ));
        }
        if self.path == "/login" {
            return self.login_profile(form, &next);
        }
        let owner = self
            .owner()
            .ok_or_else(|| Failure::new(StatusCode::UNAUTHORIZED, "Войдите в профиль."))?;
        if self.path == "/read" {
            return self.save_reading(form);
        }
        let format = scalar(form, "format", 12)?;
        if format != "original" && !FORMAT_NAMES.contains(&format) {
            return Err(Failure::invalid());
        }
        self.check_identity()?;
        self.state.access.profile_command(
            self.profile_request(),
            self.admission,
            self.site.binding,
            &self.site.root,
            "update-user-profile",
            &json!({"targetUserId":owner,"profile":{"defaultDownloadFormat":format}}),
        )?;
        Ok(redirect(StatusCode::SEE_OTHER, &next))
    }

    fn login_library(&self, form: &Params, next: &str) -> Result<Response<Body>> {
        let password = value(form, "password", 1024)?;
        let (result, token) = self
            .state
            .access
            .library
            .login_password(self.admission.client, password)?;
        Ok(match result {
            LibraryAdmission::Allowed => {
                self.state
                    .access
                    .sessions
                    .set_ebook_access(self.browser, Some(&token));
                redirect(StatusCode::SEE_OTHER, next)
            }
            LibraryAdmission::RateLimited(seconds) => self.limited(seconds, false, next),
            LibraryAdmission::Challenge(_) => self.form(
                false,
                next,
                "",
                "Неверный пароль.",
                false,
                false,
                StatusCode::UNAUTHORIZED,
                false,
            ),
        })
    }

    fn login_profile(&self, form: &Params, next: &str) -> Result<Response<Body>> {
        if self.site.binding {
            return Err(Failure::new(
                StatusCode::FORBIDDEN,
                "Профиль задаётся входом через proxy.",
            ));
        }
        let login = scalar(form, "login", 100)?;
        let password = value(form, "password", 1024)?.to_owned();
        let otp = value(form, "otp", 32)?;
        Ok(match self.state.access.login(self.browser,self.admission.client,login,password,otp.into(),None) {
            BrowserLogin::Accepted {user, ..} => {
                if !self.access.token.is_empty() { self.state.access.sessions.revoke(&self.access.token); }
                if let Some(activity) = &self.state.metrics.activity { activity.login(&user); }
                redirect(StatusCode::SEE_OTHER,next)
            }
            BrowserLogin::NeedOtp => self.form(true,next,login,
                "Введите пароль ещё раз и добавьте код из приложения-аутентификатора или резервный код.",
                true,false,StatusCode::UNAUTHORIZED,false),
            BrowserLogin::NeedOtpSetup => self.form(true,next,login,
                "Сначала настройте обязательный второй фактор в основном интерфейсе.",
                false,true,StatusCode::UNAUTHORIZED,false),
            BrowserLogin::Invalid => self.form(true,next,login,
                if otp.is_empty() { "Неверный логин или пароль." } else { "Неверный логин, пароль или код." },
                !otp.is_empty(),false,StatusCode::UNAUTHORIZED,false),
            BrowserLogin::RateLimited(seconds) => self.limited(seconds, true, next),
            BrowserLogin::Unavailable => return Err(Failure::busy()),
        })
    }

    fn limited(&self, seconds: u32, profile: bool, next: &str) -> Response<Body> {
        let mut response = self.form(
            profile,
            next,
            "",
            "Слишком много попыток. Повторите позже.",
            false,
            false,
            StatusCode::TOO_MANY_REQUESTS,
            false,
        );
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from(seconds));
        response
    }

    #[allow(clippy::too_many_arguments)]
    fn form(
        &self,
        profile: bool,
        next: &str,
        login: &str,
        message: &str,
        otp: bool,
        setup: bool,
        status: StatusCode,
        head: bool,
    ) -> Response<Body> {
        let title = if profile {
            "Вход в профиль"
        } else {
            "Доступ к библиотеке"
        };
        let error = if message.is_empty() {
            String::new()
        } else {
            format!(r#"<p class="error" role="alert">{}</p>"#, escape(message))
        };
        let setup = if setup {
            format!(
                r#"<p><a href="{}/#/profile">Открыть основной интерфейс</a></p>"#,
                escape(&self.site.root)
            )
        } else {
            String::new()
        };
        let action = self
            .site
            .url(if profile { "/login" } else { "/access" }, &Params::new());
        let user = if profile {
            format!(
                r#"<label for="login">Логин</label><input id="login" name="login" value="{}" autocomplete="username" maxlength="100" required>"#,
                escape(login)
            )
        } else {
            String::new()
        };
        let label = if profile {
            "Пароль"
        } else {
            "Пароль библиотеки"
        };
        let otp = if otp {
            r#"<label for="otp">Одноразовый или резервный код</label><input id="otp" name="otp" autocomplete="one-time-code" maxlength="32" required>"#
        } else {
            ""
        };
        let content = format!(
            r#"{error}{setup}<form class="auth" method="post" action="{}">{}{}{user}<label for="password">{label}</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>{otp}<button type="submit">Войти</button></form>"#,
            escape(&action),
            hidden("csrf", &self.access.csrf),
            hidden("next", &self.site.destination(next))
        );
        html(
            status,
            self.site
                .document(title, &content, &self.account(), false, false),
            head,
        )
    }
}

async fn read_form(request: Request<Incoming>) -> Result<Params> {
    let content = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    if content.trim() != "application/x-www-form-urlencoded"
        || request.headers().contains_key(header::CONTENT_ENCODING)
    {
        return Err(Failure::invalid());
    }
    let input = tokio::time::timeout(
        Duration::from_secs(5),
        Limited::new(request.into_body(), 8192).collect(),
    )
    .await
    .map_err(|_| Failure::new(StatusCode::REQUEST_TIMEOUT, "Время ожидания формы истекло."))?
    .map_err(|_| {
        Failure::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Не удалось обработать форму.",
        )
    })?
    .to_bytes();
    parse(
        std::str::from_utf8(&input).map_err(|_| Failure::invalid())?,
        12,
    )
}

fn parse(raw: &str, count: usize) -> Result<Params> {
    if raw.len() > 8192 {
        return Err(Failure::invalid());
    }
    let mut fields = Params::new();
    for (name, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if fields.len() >= count
            || fields
                .insert(name.into_owned(), value.into_owned())
                .is_some()
        {
            return Err(Failure::invalid());
        }
    }
    Ok(fields)
}

fn encode(params: &Params) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish()
}

fn with(params: &Params, fields: &[(&str, &str)]) -> Params {
    let mut result = params.clone();
    result.extend(
        fields
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into())),
    );
    result
}

fn get<'a>(params: &'a Params, key: &str) -> &'a str {
    params.get(key).map_or("", String::as_str)
}

fn value<'a>(params: &'a Params, key: &str, len: usize) -> Result<&'a str> {
    let value = get(params, key);
    if value.encode_utf16().count() > len || value.contains('\0') {
        return Err(Failure::invalid());
    }
    Ok(value)
}

fn scalar<'a>(params: &'a Params, key: &str, len: usize) -> Result<&'a str> {
    Ok(value(params, key, len)?.trim())
}

fn number(params: &Params, key: &str, minimum: usize, maximum: usize) -> Result<Option<usize>> {
    let value = scalar(params, key, 10)?;
    if value.is_empty() {
        return Ok(None);
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Failure::invalid());
    }
    value
        .parse()
        .ok()
        .filter(|n| (minimum..=maximum).contains(n))
        .map(Some)
        .ok_or_else(Failure::invalid)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn hidden(name: &str, value: &str) -> String {
    format!(
        r#"<input type="hidden" name="{}" value="{}">"#,
        escape(name),
        escape(value)
    )
}

fn option(name: &str, label: &str, selected: &str) -> String {
    let attr = if name == selected { " selected" } else { "" };
    format!(
        r#"<option value="{}"{attr}>{}</option>"#,
        escape(name),
        escape(label)
    )
}

fn html(status: StatusCode, content: String, head: bool) -> Response<Body> {
    let len = content.len();
    headers(Response::builder().status(status))
        .header(header::CONTENT_LENGTH, len)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body(if head { Bytes::new() } else { content.into() }))
        .expect("ebook HTML response")
}

fn redirect(status: StatusCode, next: &str) -> Response<Body> {
    headers(Response::builder().status(status))
        .header(header::LOCATION, next)
        .body(body(Bytes::new()))
        .expect("same-origin ebook redirect")
}

fn headers(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder.header(header::CACHE_CONTROL,"private, no-store")
        .header(header::PRAGMA,"no-cache").header(header::X_CONTENT_TYPE_OPTIONS,"nosniff")
        .header(header::X_FRAME_OPTIONS,"DENY").header(header::REFERRER_POLICY,"same-origin")
        .header(header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
}
