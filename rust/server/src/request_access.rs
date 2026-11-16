use std::net::{IpAddr, Ipv4Addr};

use ctutils::CtEq;
use hyper::body::Bytes;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use url::{Origin, Url};

use crate::http::{Body, body};

pub(crate) const APPROVAL: HeaderName = HeaderName::from_static("x-inpx-request-access");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    revision: u64,
    require_proxy: bool,
    proxy_header: String,
    trust_proxy: bool,
    express_trust_proxy: bool,
    trusted_ranges: Vec<Range>,
    auth_exempt_health: bool,
    root: String,
    metrics: Option<Metrics>,
    metadata_service: Option<MetadataService>,
}

#[derive(Deserialize)]
struct Range {
    base: u32,
    mask: u32,
}

#[derive(Deserialize)]
struct Metrics {
    path: String,
    exempt: bool,
    token: String,
}

#[derive(Deserialize)]
struct MetadataService {
    path: String,
    token: String,
}

pub(crate) struct Policy {
    settings: Settings,
    proxy_header: Option<HeaderName>,
    http_approval: HeaderValue,
    websocket_approval: HeaderValue,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Protocol {
    Http,
    WebSocket,
}

pub(crate) enum Decision {
    Allow {
        proof: HeaderValue,
        secure: bool,
        needs_session: bool,
    },
    Deny {
        reason: Denial,
        secure: bool,
    },
    Forward,
}

#[derive(Clone, Copy)]
pub(crate) enum Denial {
    UntrustedPeer,
    MissingProxyUser,
    ForeignOrigin,
}

impl Policy {
    pub(crate) fn new(settings: Settings) -> Self {
        let proxy_header = HeaderName::from_bytes(settings.proxy_header.as_bytes())
            .ok()
            .filter(|key| {
                !matches!(
                    key.as_str(),
                    "connection"
                        | "transfer-encoding"
                        | "te"
                        | "trailer"
                        | "keep-alive"
                        | "upgrade"
                        | "close"
                        | "proxy-authorization"
                        | "proxy-authenticate"
                        | "proxy-connection"
                        | "x-inpx-request-access"
                        | "x-inpx-managed-asset"
                        | "x-inpx-opds-model"
                        | "x-inpx-file"
                )
            });
        let marker = |protocol| {
            HeaderValue::from_str(&format!("{}:{protocol}", settings.revision))
                .expect("valid policy revision")
        };
        Self {
            http_approval: marker("http"),
            websocket_approval: marker("websocket"),
            settings,
            proxy_header,
        }
    }

    pub(crate) fn authorize(
        &self,
        request: &Request<impl Sized>,
        peer: IpAddr,
        protocol: Protocol,
    ) -> Decision {
        self.evaluate(request, peer, protocol)
            .unwrap_or(Decision::Forward)
    }

    fn evaluate(
        &self,
        request: &Request<impl Sized>,
        peer: IpAddr,
        protocol: Protocol,
    ) -> Result<Decision, Forward> {
        let headers = request.headers();
        // The upstream HTTP parser sees headers after connection-specific fields are removed.
        // Leave unusual nominations and duplicated security headers to that parser.
        for value in headers.get_all(header::CONNECTION) {
            let value = value.to_str().map_err(|_| Forward)?;
            if value.split(',').map(str::trim).any(|token| {
                !token.is_empty()
                    && !["keep-alive", "close", "upgrade"]
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(token))
            }) {
                return Err(Forward);
            }
        }

        let path = if protocol == Protocol::WebSocket {
            "/"
        } else {
            request.uri().path()
        };
        let normalized = path.trim_end_matches('/');
        let normalized = if normalized.is_empty() {
            "/"
        } else {
            normalized
        };
        let on_health = matches!(normalized, "/health" | "/ready" | "/api/index-status");
        let on_metrics = self
            .settings
            .metrics
            .as_ref()
            .is_some_and(|metrics| metrics.path == normalized);
        let in_proxy_range = (self.settings.trust_proxy || self.settings.express_trust_proxy)
            && self.trusted_range(peer);
        let trusted = in_proxy_range && self.settings.trust_proxy;
        let forwarded_proto = if in_proxy_range {
            first(headers, &HeaderName::from_static("x-forwarded-proto"))?
        } else {
            ""
        };
        let secure = forwarded_proto == "https";
        let document = protocol == Protocol::Http
            && !on_health
            && normalized != self.metrics_path()
            && (path == self.settings.root
                || path.strip_suffix('/') == Some(self.settings.root.as_str())
                || headers
                    .get_all(header::ACCEPT)
                    .iter()
                    .any(|value| value.as_bytes().windows(9).any(|part| part == b"text/html")));
        let needs_session = document || headers.contains_key(header::COOKIE);

        let check_proxy = self.settings.require_proxy
            && !(on_health && self.settings.auth_exempt_health)
            && !self.service_access(request, normalized, protocol, on_metrics)?;
        let deny = |reason| {
            if protocol == Protocol::Http && needs_session {
                Decision::Forward
            } else {
                Decision::Deny { reason, secure }
            }
        };
        if check_proxy {
            if !trusted {
                return Ok(deny(Denial::UntrustedPeer));
            }
            let user = read_header(headers, self.proxy_header.as_ref().ok_or(Forward)?)?;
            if user.trim().is_empty() {
                return Ok(deny(Denial::MissingProxyUser));
            }
        }

        let proof = if protocol == Protocol::WebSocket {
            if !same_origin(headers, trusted, forwarded_proto)? {
                return Ok(deny(Denial::ForeignOrigin));
            }
            &self.websocket_approval
        } else {
            &self.http_approval
        };
        Ok(Decision::Allow {
            proof: proof.clone(),
            secure,
            needs_session,
        })
    }

    fn metrics_path(&self) -> &str {
        self.settings
            .metrics
            .as_ref()
            .map_or("", |metrics| &metrics.path)
    }

    fn trusted_range(&self, peer: IpAddr) -> bool {
        let ip = match peer {
            IpAddr::V4(addr) => Some(addr),
            IpAddr::V6(addr) if addr.is_loopback() => Some(Ipv4Addr::LOCALHOST),
            IpAddr::V6(addr) => addr.to_ipv4_mapped(),
        };
        ip.is_some_and(|ip| {
            self.settings
                .trusted_ranges
                .iter()
                .any(|range| u32::from(ip) & range.mask == range.base)
        })
    }

    fn service_access(
        &self,
        request: &Request<impl Sized>,
        path: &str,
        protocol: Protocol,
        on_metrics: bool,
    ) -> Result<bool, Forward> {
        if protocol == Protocol::Http
            && matches!(*request.method(), Method::GET | Method::HEAD)
            && let Some(service) = &self.settings.metadata_service
            && let Some(suffix) = path.strip_prefix(&service.path)
            && matches!(suffix, "" | "/search" | "/cover")
        {
            let header = read_header(request.headers(), &header::AUTHORIZATION)?;
            let supplied = bearer(header).unwrap_or(header).trim();
            if equal_token(supplied, &service.token) {
                return Ok(true);
            }
            if suffix == "/cover" && request.uri().query().is_some() {
                // Signed cover parameters are still interpreted by the application.
                return Err(Forward);
            }
        }
        if on_metrics && let Some(metrics) = &self.settings.metrics {
            if metrics.exempt {
                return Ok(true);
            }
            if !metrics.token.is_empty() {
                let header = read_header(request.headers(), &header::AUTHORIZATION)?;
                if let Some(supplied) = bearer(header)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Ok(equal_token(supplied, &metrics.token));
                }
                // Express owns the legacy query-string token parsing rules.
                if protocol == Protocol::Http && request.uri().query().is_some() {
                    return Err(Forward);
                }
            }
        }
        Ok(false)
    }
}

struct Forward;

fn read_header<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<&'a str, Forward> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(HeaderValue::to_str)
        .transpose()
        .map_err(|_| Forward)?
        .unwrap_or("");
    if values.next().is_some() {
        return Err(Forward);
    }
    Ok(value)
}

fn first<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<&'a str, Forward> {
    Ok(read_header(headers, name)?
        .split(',')
        .next()
        .unwrap_or("")
        .trim())
}

fn bearer(value: &str) -> Option<&str> {
    let (start, tail) = value.split_at_checked(6)?;
    (start.eq_ignore_ascii_case("bearer") && tail.starts_with([' ', '\t'])).then_some(tail)
}

fn equal_token(value: &str, expected: &str) -> bool {
    !expected.is_empty() && value.as_bytes().ct_eq(expected.as_bytes()).to_bool()
}

fn same_origin(headers: &HeaderMap, trusted: bool, forwarded_proto: &str) -> Result<bool, Forward> {
    let claimed = read_header(headers, &header::ORIGIN)?.trim();
    if claimed.is_empty() {
        return Ok(true);
    }
    let (scheme, host) = claimed.split_once("://").ok_or(Forward)?;
    let Some(claimed) = origin(scheme, host)? else {
        return Ok(false);
    };
    let host = first(headers, &header::HOST)?;
    if origin("http", host)?.as_ref() == Some(&claimed) {
        return Ok(true);
    }
    let proto = if forwarded_proto.is_empty() {
        "http"
    } else {
        forwarded_proto
    };
    if !trusted || !http_scheme(proto) {
        return Ok(false);
    }
    let forwarded_host = first(headers, &HeaderName::from_static("x-forwarded-host"))?;
    let host = if forwarded_host.is_empty() {
        host
    } else {
        forwarded_host
    };
    Ok(origin(proto, host)?.as_ref() == Some(&claimed))
}

fn http_scheme(value: &str) -> bool {
    value.eq_ignore_ascii_case("http") || value.eq_ignore_ascii_case("https")
}

fn origin(scheme: &str, authority: &str) -> Result<Option<Origin>, Forward> {
    let authority = authority.trim_end_matches('/');
    if !http_scheme(scheme)
        || !authority
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".:-_[]".contains(&byte))
    {
        return Err(Forward);
    }
    Ok(Url::parse(&format!("{scheme}://{authority}"))
        .ok()
        .map(|url| url.origin()))
}

pub(crate) fn security_headers(secure: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if secure {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("upgrade-insecure-requests"),
        );
    }
    headers
}

impl Denial {
    pub(crate) fn diagnostic(self) -> &'static str {
        match self {
            Self::MissingProxyUser => "missing-proxy-user",
            Self::UntrustedPeer => "untrusted-peer",
            Self::ForeignOrigin => "foreign-origin",
        }
    }

    pub(crate) fn http(self, head: bool, secure: bool) -> Response<Body> {
        let (status, message, etag) = match self {
            Self::MissingProxyUser => (
                StatusCode::UNAUTHORIZED,
                "Proxy authentication required",
                "W/\"1d-TFNEU3ApNCBHlyWQCPjRBv+Nrjs\"",
            ),
            _ => (
                StatusCode::FORBIDDEN,
                "Direct access is forbidden",
                "W/\"1a-Uu3mkzygI8ErmydJvXa2Y0IcoLU\"",
            ),
        };
        let mut response = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_LENGTH, message.len())
            .header(header::ETAG, etag)
            .header("x-powered-by", "Express")
            .header("x-robots-tag", "noindex, nofollow")
            .body(body(if head {
                Bytes::new()
            } else {
                Bytes::from_static(message.as_bytes())
            }))
            .expect("static HTTP access rejection");
        response.headers_mut().extend(security_headers(secure));
        response
    }

    pub(crate) fn websocket() -> Response<Body> {
        Response::builder()
            .status(StatusCode::FORBIDDEN)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CONTENT_LENGTH, 9)
            .header(header::CONNECTION, "close")
            .body(body(Bytes::from_static(b"Forbidden")))
            .expect("static WebSocket access rejection")
    }
}
