use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use inpx_catalog::kosync::{ProgressRequest, Push, valid_document};
use percent_encoding::percent_decode_str;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::{State, send_bytes};
use crate::http::Body;
use crate::standalone_access::Rejection;
use crate::standalone_download::load_book;

pub(super) struct Routes {
    pub(super) root: String,
    slots: Arc<Semaphore>,
}

impl Routes {
    pub(super) fn new(prefix: &str) -> Self {
        Self {
            root: format!("{}/kosync", prefix.trim_end_matches('/')),
            slots: Arc::new(Semaphore::new(2)),
        }
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.strip_prefix(&self.root)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with('/'))
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        request: Request<Incoming>,
        peer: IpAddr,
    ) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        let read = matches!(*request.method(), Method::GET | Method::HEAD);
        if !state.access.kosync_enabled() {
            return failure(StatusCode::NOT_FOUND, "Not Found", head);
        }
        let path = request.uri().path()[self.root.len()..].trim_end_matches('/');
        if read && path.eq_ignore_ascii_case("/healthcheck") {
            return reply(StatusCode::OK, json!({"state":"OK"}), head);
        }
        if request.method() == Method::POST && path.eq_ignore_ascii_case("/users/create") {
            return failure(
                StatusCode::FORBIDDEN,
                "Создайте ключ в настройках профиля INPX Web",
                head,
            );
        }
        let route = path.to_ascii_lowercase();
        let document = (read && route.starts_with("/syncs/progress/"))
            .then(|| &path["/syncs/progress/".len()..])
            .filter(|doc| !doc.contains('/'))
            .map(|doc| {
                percent_decode_str(doc)
                    .decode_utf8()
                    .map(|doc| doc.into_owned())
            });
        let push = request.method() == Method::PUT && route == "/syncs/progress";

        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            return rejected(
                Rejection::Unavailable,
                "KOSync temporarily unavailable",
                head,
            );
        };
        let user = credential(request.headers(), "x-auth-user");
        let key = credential(request.headers(), "x-auth-key");
        let auth_state = state.clone();
        let identity =
            tokio::task::spawn_blocking(move || auth_state.access.kosync_auth(peer, &user, &key))
                .await
                .unwrap_or(Err(Rejection::Unavailable));
        let identity = match identity {
            Ok(identity) => identity,
            Err(error) => return rejected(error, "KOSync temporarily unavailable", head),
        };
        if read && route == "/users/auth" {
            return reply(StatusCode::OK, json!({"authorized":"OK"}), head);
        }
        let (document, patch) = if push {
            let input = match parse(request).await {
                Ok(input) => input,
                Err(status) => return failure(status, "KOSync request failed", head),
            };
            let Some(doc) = input["document"].as_str().filter(|doc| valid_document(doc)) else {
                return failure(StatusCode::BAD_REQUEST, "Invalid document", head);
            };
            let doc = doc.to_owned();
            let Ok(patch) = serde_json::from_value::<Push>(input) else {
                return failure(StatusCode::BAD_REQUEST, "Invalid progress", head);
            };
            if !patch.valid() {
                return failure(StatusCode::BAD_REQUEST, "Invalid progress", head);
            }
            (doc, Some(patch))
        } else if let Some(document) = document {
            match document {
                Ok(doc) if valid_document(&doc) => (doc, None),
                _ => return failure(StatusCode::BAD_REQUEST, "Invalid document", head),
            }
        } else {
            return failure(StatusCode::NOT_FOUND, "Not Found", head);
        };
        let state = state.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            state.access.kosync_progress(
                ProgressRequest {
                    session: &identity,
                    document: &document,
                    patch: patch.as_ref(),
                },
                |uid| load_book(&state.index.catalogue, uid),
                |book| state.downloads.kosync_fb2(book, &state.index.sources()),
                |owner, uid| state.events.send("reader", None, owner, uid),
            )
        })
        .await
        .unwrap_or(Err(Rejection::Unavailable));
        match result {
            Ok(result) => json_response(StatusCode::OK, result.get().as_bytes().to_vec(), head),
            Err(error) => rejected(error, "KOSync request failed", head),
        }
    }
}

fn credential(headers: &header::HeaderMap, name: &'static str) -> String {
    let mut values = headers.get_all(name).iter();
    let first = values
        .next()
        .and_then(|value| std::str::from_utf8(value.as_bytes()).ok());
    if values.next().is_some() {
        String::new()
    } else {
        first.unwrap_or_default().into()
    }
}

async fn parse(request: Request<Incoming>) -> Result<Value, StatusCode> {
    let mime = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    if !mime.eq_ignore_ascii_case("application/json")
        && !mime.eq_ignore_ascii_case("application/vnd.koreader.v1+json")
    {
        return Ok(Value::Null);
    }
    let input = tokio::time::timeout(
        Duration::from_secs(15),
        Limited::new(request.into_body(), 16 * 1024).collect(),
    )
    .await
    .map_err(|_| StatusCode::REQUEST_TIMEOUT)?
    .map_err(|error| {
        if error.is::<LengthLimitError>() {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_REQUEST
        }
    })?;
    serde_json::from_slice(&input.to_bytes()).map_err(|_| StatusCode::BAD_REQUEST)
}

fn rejected(error: Rejection, message: &str, head: bool) -> Response<Body> {
    match error {
        Rejection::Unauthorized => failure(StatusCode::UNAUTHORIZED, "Unauthorized", head),
        Rejection::Blocked | Rejection::ProxyScope => {
            failure(StatusCode::FORBIDDEN, "Forbidden", head)
        }
        Rejection::Missing => failure(StatusCode::NOT_FOUND, "Not Found", head),
        Rejection::Unavailable => failure(StatusCode::SERVICE_UNAVAILABLE, message, head),
        Rejection::RateLimited(seconds) => {
            let mut result = failure(StatusCode::TOO_MANY_REQUESTS, message, head);
            result
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
            result
        }
    }
}

fn failure(status: StatusCode, message: &str, head: bool) -> Response<Body> {
    reply(status, json!({"message":message}), head)
}

fn reply(status: StatusCode, data: Value, head: bool) -> Response<Body> {
    json_response(
        status,
        serde_json::to_vec(&data).expect("KOSync response serializes"),
        head,
    )
}

fn json_response(status: StatusCode, data: Vec<u8>, head: bool) -> Response<Body> {
    let mut response = send_bytes(data, "application/json; charset=utf-8", head);
    *response.status_mut() = status;
    response
}
