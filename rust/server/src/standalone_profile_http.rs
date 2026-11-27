use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode, header};
use serde_json::{Value, json};

use super::{State, socket};
use crate::http::{Body, body};
use crate::request_access::Admission;
use crate::standalone_access::BrowserLogin;
use crate::standalone_library::Admission as LibraryAdmission;

const TRUST_COOKIE: &str = "inpx_web_trusted_device";

pub(super) async fn login(
    state: &Arc<State>,
    request: Request<Incoming>,
    admission: &Admission,
) -> Response<Body> {
    let browser = state
        .access
        .sessions
        .existing_browser(request.headers(), admission.cookie_port);
    let Some(browser) = browser.filter(|_| {
        admission.secure
            && !state.access.profile_binding(admission)
            && state
                .request_access
                .current()
                .secure_browser_origin(request.headers())
    }) else {
        return failure(
            StatusCode::FORBIDDEN,
            "Вход через эту форму недоступен",
            "profile_web_login_unavailable",
        );
    };
    let json_content = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    if !json_content || request.headers().contains_key(header::CONTENT_ENCODING) {
        return failure(StatusCode::BAD_REQUEST, "Некорректные данные для входа", "");
    }
    let mut cookies = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .filter_map(|(name, value)| (name == TRUST_COOKIE).then_some(value));
    let token = cookies
        .next()
        .filter(|value| value.len() == 64 && cookies.next().is_none())
        .unwrap_or_default()
        .to_owned();
    let Ok(Ok(input)) = tokio::time::timeout(
        Duration::from_secs(5),
        Limited::new(request.into_body(), 32 * 1024).collect(),
    )
    .await
    else {
        return failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Некорректные данные для входа",
            "",
        );
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(&input.to_bytes()) else {
        return failure(StatusCode::BAD_REQUEST, "Некорректные данные для входа", "");
    };
    if !state
        .access
        .sessions
        .has_csrf(&browser, text(&payload, "csrfToken"))
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Обновите страницу и повторите вход",
            "bad_csrf_token",
        );
    }
    let (Some(login), Some(password)) = (payload["login"].as_str(), payload["password"].as_str())
    else {
        return failure(StatusCode::BAD_REQUEST, "Некорректные данные для входа", "");
    };
    let otp = payload.get("otp").map_or(Some(""), Value::as_str);
    let Some(otp) = otp.filter(|otp| otp.encode_utf16().count() <= 64) else {
        return failure(StatusCode::BAD_REQUEST, "Некорректные данные для входа", "");
    };
    if login.encode_utf16().count() > 100 || password.len() > 4096 {
        return failure(StatusCode::BAD_REQUEST, "Некорректные данные для входа", "");
    }
    let args = (
        login.to_owned(),
        password.to_owned(),
        otp.to_owned(),
        payload["rememberDevice"] == true,
    );
    payload["password"] = Value::Null;
    payload["otp"] = Value::Null;
    let peer = admission.client;
    let admission = admission.clone();
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        match state.access.library.admit(peer, text(&payload, "accessToken")) {
            Ok(LibraryAdmission::Allowed) => (),
            Ok(LibraryAdmission::Challenge(_)) => return failure(StatusCode::UNAUTHORIZED, "Требуется пароль библиотеки", "need_access_token"),
            Ok(LibraryAdmission::RateLimited(seconds)) => return rate_limit(seconds),
            Err(_) => return failure(StatusCode::SERVICE_UNAVAILABLE, "Библиотека пока не готова", "server_busy"),
        }
        match state.access.login(&browser, &admission, &args.0, args.1, args.2, Some((&token,args.3))) {
            BrowserLogin::Accepted { user, token, device } => {
                if let Some(activity) = &state.metrics.activity { activity.login(&user); }
                let mut response = json_response(StatusCode::OK,json!({"userId":user,"profileAccessToken":token}));
                if let Some(device) = device {
                    let root = state.socket.root();
                    let path = if root.is_empty() { "/" } else { root };
                    let cookie = format!("{TRUST_COOKIE}={}; HttpOnly; Secure; SameSite=Strict; Path={path}; Max-Age={}",
                        device.token,device.max_age_seconds);
                    if let Ok(value) = header::HeaderValue::from_str(&cookie) {
                        response.headers_mut().append(header::SET_COOKIE,value);
                    }
                }
                response
            }
            BrowserLogin::RateLimited(seconds) => rate_limit(seconds),
            BrowserLogin::Unavailable => failure(StatusCode::INTERNAL_SERVER_ERROR, "Не удалось войти в профиль", ""),
            denied => {
                let status = if matches!(denied, BrowserLogin::AdminRestricted { .. }) {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::UNAUTHORIZED
                };
                let reply = socket::login_response(denied);
                failure(status, text(&reply,"error"),text(&reply,"errorCode"))
            }
        }
    }).await.unwrap_or_else(|_| failure(StatusCode::INTERNAL_SERVER_ERROR, "Не удалось войти в профиль", ""))
}

fn rate_limit(seconds: u32) -> Response<Body> {
    super::logging::warn_limited(
        "inpx::auth",
        "login-rate-limit",
        format_args!("transport=http retry_s={seconds}"),
    );
    let mut response = failure(
        StatusCode::TOO_MANY_REQUESTS,
        "Слишком много попыток входа. Повторите позже.",
        "INPX_LOGIN_RATE_LIMIT",
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, header::HeaderValue::from(seconds));
    response
}

fn failure(status: StatusCode, error: &str, code: &str) -> Response<Body> {
    json_response(status, json!({"error":error,"code":code}))
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body(value.to_string().into()))
        .expect("profile login response")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
