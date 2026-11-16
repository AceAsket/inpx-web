use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};

use crate::assets::{Assets, PROBE};
use crate::download;
use crate::opds::response as opds;
use crate::receipts::Receipts;
use crate::upstream::Upstream;

pub(crate) type BodyError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = UnsyncBoxBody<Bytes, BodyError>;

pub struct Routes {
    direct: AtomicU8,
    version: Option<String>,
    started: Instant,
    uptime: f64,
    assets: Assets,
    opds_path: Option<String>,
    files: Option<download::Config>,
}

const HEALTH: u8 = 1;
const ASSETS: u8 = 2;
const ASSET_GATE: u8 = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRoutes {
    health: bool,
    #[serde(default)]
    serve_assets: bool,
    #[serde(default)]
    asset_gate: bool,
}

impl DirectRoutes {
    fn flags(&self) -> u8 {
        (u8::from(self.health) * HEALTH)
            | (u8::from(self.serve_assets) * ASSETS)
            | (u8::from(self.asset_gate) * ASSET_GATE)
    }
}

#[derive(Serialize)]
struct Health<'a> {
    status: &'static str,
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    uptime: f64,
}

impl Routes {
    pub fn new(
        direct: DirectRoutes,
        version: Option<String>,
        uptime: f64,
        assets: Assets,
        opds_path: Option<String>,
        files: Option<download::Config>,
    ) -> Self {
        Self {
            direct: AtomicU8::new(direct.flags()),
            version,
            started: Instant::now(),
            uptime,
            assets,
            opds_path,
            files,
        }
    }

    pub fn update(&self, direct: DirectRoutes) {
        self.direct.store(direct.flags(), Ordering::Release);
    }

    fn health_response(&self, head: bool) -> Response<Body> {
        let data = serde_json::to_vec(&Health {
            status: "ok",
            ready: true,
            version: self.version.as_deref(),
            uptime: self.uptime + self.started.elapsed().as_secs_f64(),
        })
        .expect("health status serializes");
        let length = data.len();
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_LENGTH, length)
            .header("X-Robots-Tag", "noindex, nofollow")
            .body(body(if head {
                Bytes::new()
            } else {
                Bytes::from(data)
            }))
            .expect("static health response")
    }

    pub async fn serve(
        &self,
        mut request: Request<Incoming>,
        upstream: &Arc<Upstream>,
        receipts: &Receipts,
    ) -> Result<Response<Body>, Infallible> {
        if request.method() == Method::CONNECT || request.uri().authority().is_some() {
            return Ok(error(StatusCode::BAD_REQUEST));
        }
        let direct = self.direct.load(Ordering::Acquire);
        if direct & HEALTH != 0
            && request.uri().path() == "/health"
            && matches!(*request.method(), Method::GET | Method::HEAD)
            && !request.headers().contains_key("x-forwarded-proto")
            && !request.headers().contains_key(header::UPGRADE)
        {
            return Ok(self.health_response(request.method() == Method::HEAD));
        }
        request.headers_mut().remove(&PROBE);
        request.headers_mut().remove(&opds::MODEL);
        request.headers_mut().remove(&download::MODEL);
        if direct & ASSETS != 0
            && let Some(delivery) = self.assets.select(&request, direct & ASSET_GATE != 0)
        {
            if !delivery.needs_probe {
                return Ok(delivery.response(None));
            }
            strip_hop_headers(request.headers_mut(), false);
            request
                .headers_mut()
                .insert(&PROBE, HeaderValue::from_static("1"));
            let Ok(mut response) = upstream.send(request).await else {
                return Ok(error(StatusCode::BAD_GATEWAY));
            };
            let approved = response
                .headers_mut()
                .remove(&PROBE)
                .is_some_and(|value| value == "1");
            if response.headers().contains_key(&opds::MODEL)
                || response.headers().contains_key(&download::MODEL)
            {
                return Ok(error(StatusCode::BAD_GATEWAY));
            }
            if approved && response.status() == StatusCode::NO_CONTENT {
                return Ok(delivery.response(Some(response.headers())));
            }
            strip_hop_headers(response.headers_mut(), false);
            return Ok(forward(response));
        }

        let opds_request = opds::matches(
            request.uri().path(),
            self.opds_path.as_deref(),
            request.method(),
            request.headers(),
        );
        let head = request.method() == Method::HEAD;
        if !opds_request
            && let Some(config) = &self.files
            && let Some(route) =
                config.route(request.uri().path(), request.method(), request.headers())
        {
            let conditions = selected_headers(
                request.headers(),
                [
                    header::RANGE,
                    header::IF_RANGE,
                    header::IF_MATCH,
                    header::IF_NONE_MATCH,
                    header::IF_MODIFIED_SINCE,
                    header::IF_UNMODIFIED_SINCE,
                    header::CACHE_CONTROL,
                ],
            );
            strip_hop_headers(request.headers_mut(), false);
            request
                .headers_mut()
                .insert(&download::MODEL, HeaderValue::from_static("1"));
            if head {
                *request.method_mut() = Method::GET;
            }
            return Ok(
                match download::resolve(upstream.clone(), request, receipts.clone(), route).await {
                    Ok(download::Reply::File(mut delivery)) => {
                        if !sanitize_file_reply(&mut delivery.parts.headers) {
                            return Ok(error(StatusCode::BAD_GATEWAY));
                        }
                        download::send(delivery, config, conditions, head, receipts).await
                    }
                    Ok(download::Reply::Proxy(mut response))
                        if response.status() != StatusCode::SWITCHING_PROTOCOLS =>
                    {
                        if !sanitize_file_reply(response.headers_mut()) {
                            return Ok(error(StatusCode::BAD_GATEWAY));
                        }
                        forward(response)
                    }
                    _ => error(StatusCode::BAD_GATEWAY),
                },
            );
        }
        let opds_conditions = opds_request.then(|| {
            let conditions = if matches!(*request.method(), Method::GET | Method::HEAD) {
                selected_headers(
                    request.headers(),
                    [header::IF_NONE_MATCH, header::CACHE_CONTROL],
                )
            } else {
                HeaderMap::new()
            };
            request
                .headers_mut()
                .insert(&opds::MODEL, HeaderValue::from_static("1"));
            conditions
        });
        if head && opds_request {
            *request.method_mut() = Method::GET;
        }
        let upgrade = is_websocket(request.headers()).then(|| hyper::upgrade::on(&mut request));
        strip_hop_headers(request.headers_mut(), upgrade.is_some());
        let Ok(mut response) = upstream.send(request).await else {
            return Ok(error(StatusCode::BAD_GATEWAY));
        };
        let switching = response.status() == StatusCode::SWITCHING_PROTOCOLS;
        if switching {
            let Some(client) = upgrade.filter(|_| is_websocket(response.headers())) else {
                return Ok(error(StatusCode::BAD_GATEWAY));
            };
            let server = hyper::upgrade::on(&mut response);
            tokio::spawn(async move {
                if let Ok((client, server)) = tokio::try_join!(client, server) {
                    let _ = tokio::io::copy_bidirectional(
                        &mut TokioIo::new(client),
                        &mut TokioIo::new(server),
                    )
                    .await;
                }
            });
        }
        response.headers_mut().remove(&PROBE);
        let model = response.headers_mut().remove(&opds::MODEL);
        if response.headers().contains_key(&download::MODEL) {
            return Ok(error(StatusCode::BAD_GATEWAY));
        }
        strip_hop_headers(response.headers_mut(), switching);
        if let Some(marker) = model {
            let Some(conditions) = opds_conditions else {
                return Ok(error(StatusCode::BAD_GATEWAY));
            };
            let Some(format) = opds::Format::from_response(&marker, response.headers()) else {
                return Ok(error(StatusCode::BAD_GATEWAY));
            };
            if response.status() != StatusCode::OK {
                return Ok(error(StatusCode::BAD_GATEWAY));
            }
            return Ok(opds::send(response, format, &conditions, head)
                .await
                .unwrap_or_else(|| error(StatusCode::BAD_GATEWAY)));
        }
        Ok(forward(response))
    }
}

fn sanitize_file_reply(headers: &mut HeaderMap) -> bool {
    if headers.contains_key(&opds::MODEL) {
        return false;
    }
    headers.remove(&PROBE);
    strip_hop_headers(headers, false);
    true
}

fn selected_headers(headers: &HeaderMap, names: impl IntoIterator<Item = HeaderName>) -> HeaderMap {
    let mut selected = HeaderMap::new();
    for name in names {
        for value in headers.get_all(&name) {
            selected.append(name.clone(), value.clone());
        }
    }
    selected
}

fn forward(response: Response<Incoming>) -> Response<Body> {
    response.map(|incoming| incoming.map_err(Into::into).boxed_unsync())
}

fn is_websocket(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && headers.get_all(header::CONNECTION).iter().any(|value| {
            value.to_str().is_ok_and(|tokens| {
                tokens
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
        })
}

fn strip_hop_headers(headers: &mut HeaderMap, switching: bool) {
    let nominated: Vec<_> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.eq_ignore_ascii_case("keep-alive"))
        .filter_map(|value| HeaderName::from_bytes(value.as_bytes()).ok())
        .collect();
    for name in nominated {
        if name != header::UPGRADE || !switching {
            headers.remove(name);
        }
    }
    for name in [
        header::CONNECTION,
        header::TRANSFER_ENCODING,
        header::TE,
        header::TRAILER,
        header::PROXY_AUTHORIZATION,
        header::PROXY_AUTHENTICATE,
        HeaderName::from_static("keep-alive"),
        HeaderName::from_static("proxy-connection"),
    ] {
        headers.remove(name);
    }
    if switching {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    } else {
        headers.remove(header::UPGRADE);
    }
}

pub fn body(bytes: Bytes) -> Body {
    Full::new(bytes)
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub(crate) fn error(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Robots-Tag", "noindex, nofollow")
        .body(body(Bytes::from_static(
            status.canonical_reason().unwrap_or_default().as_bytes(),
        )))
        .expect("static error response")
}
