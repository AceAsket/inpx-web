use std::net::{IpAddr, Ipv4Addr};

use ctutils::CtEq;
use hyper::body::Bytes;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use url::{Origin, Url};

use crate::http::{Body, body};

mod services;

pub(crate) use services::{CoverSigner, query_values, trim_js};

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

impl Range {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (address, bits) = value.split_once('/').unwrap_or((value, "32"));
        let address = ipv4(address.parse().ok()?)?;
        let bits = bits.parse::<u32>().ok().filter(|bits| *bits <= 32)?;
        let mask = u32::MAX.checked_shl(32 - bits).unwrap_or(0);
        Some(Self {
            base: u32::from(address) & mask,
            mask,
        })
    }
}

#[derive(Deserialize)]
pub(crate) struct Metrics {
    pub(crate) path: String,
    pub(crate) exempt: bool,
    pub(crate) token: String,
}

#[derive(Deserialize)]
pub(crate) struct MetadataService {
    pub(crate) path: String,
    pub(crate) token: String,
}

pub(crate) struct Policy {
    settings: Settings,
    proxy_header: Option<HeaderName>,
    http_approval: HeaderValue,
    websocket_approval: HeaderValue,
    metrics_approval: HeaderValue,
    metadata_approval: HeaderValue,
    cover_signer: Option<CoverSigner>,
}

#[derive(Clone, Copy)]
pub(crate) enum ServiceAccess {
    None,
    Exempt,
    Metrics,
    Metadata,
    SignedCover(u64),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServiceRoute {
    Other,
    Health,
    Metrics,
    Metadata,
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
        service: ServiceAccess,
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

pub(crate) struct Standalone {
    policy: Policy,
    bind_profile: bool,
}

pub(crate) struct Admission {
    pub(crate) client: IpAddr,
    pub(crate) proxy_login: Option<String>,
    pub(crate) secure: bool,
    pub(crate) protected: bool,
    pub(crate) service: ServiceAccess,
    pub(crate) forwarded_host: Option<String>,
}

impl Standalone {
    pub(crate) fn new(
        config: &Value,
        root: &str,
        metrics: Option<Metrics>,
        metadata_service: Option<MetadataService>,
    ) -> inpx_catalog::Result<Self> {
        let value = |variable, property: &str, default: &str| {
            std::env::var(variable)
                .ok()
                .filter(|value| !value.is_empty())
                .or_else(|| config[property].as_str().map(str::to_owned))
                .unwrap_or_else(|| default.into())
        };
        let flag = |variable| std::env::var(variable).ok().map(|value| value == "true");
        let mode = value("INPX_AUTH_MODE", "authMode", "local")
            .trim()
            .to_ascii_lowercase();
        if !matches!(mode.as_str(), "proxy" | "local" | "none" | "") {
            return Err("Unsupported authentication mode".into());
        }
        let bind = flag("INPX_PROXY_BIND_PROFILE");
        let bind_profile = mode == "proxy" && bind.unwrap_or(config["proxyBindProfile"] == true);
        let trust_proxy = flag("INPX_TRUST_PROXY").unwrap_or(config["trustProxy"] == true);
        let trusted_ranges = match std::env::var("INPX_TRUSTED_PROXY_CIDRS") {
            Ok(value) => value.split(',').filter_map(Range::parse).collect(),
            Err(_) => config["trustedProxyCidrs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| Range::parse(value.as_str()?))
                .collect(),
        };
        let proxy_header = value("INPX_PROXY_AUTH_HEADER", "proxyAuthHeader", "Remote-User");
        let require_proxy = mode == "proxy"
            && (bind.unwrap_or_else(|| truthy(&config["proxyBindProfile"]))
                || flag("INPX_REQUIRE_AUTH").unwrap_or_else(|| truthy(&config["requireAuth"])));
        let policy = Policy::new(Settings {
            revision: 0,
            require_proxy,
            proxy_header: if proxy_header.is_empty() {
                "Remote-User".into()
            } else {
                proxy_header.trim().into()
            },
            trust_proxy,
            express_trust_proxy: trust_proxy,
            trusted_ranges,
            auth_exempt_health: std::env::var("INPX_AUTH_EXEMPT_HEALTH")
                .map_or(config["authExemptHealth"] != false, |value| {
                    value != "false"
                }),
            root: root.trim_end_matches('/').into(),
            metrics,
            metadata_service,
        });
        if require_proxy && policy.proxy_header.is_none() {
            return Err("Invalid proxy authentication header".into());
        }
        Ok(Self {
            policy,
            bind_profile,
        })
    }

    pub(crate) fn admit(
        &self,
        request: &Request<impl Sized>,
        peer: IpAddr,
        protocol: Protocol,
        route: ServiceRoute,
    ) -> Result<Admission, Decision> {
        let decision = self
            .policy
            .evaluate(request, peer, protocol, Some(route))
            .unwrap_or(Decision::Forward);
        let Decision::Allow {
            secure, service, ..
        } = decision
        else {
            return Err(decision);
        };
        let trusted = self.policy.settings.trust_proxy && self.policy.trusted_range(peer);
        let headers = request.headers();
        let client = if trusted {
            self.policy.forwarded_client(headers).unwrap_or(peer)
        } else {
            peer
        };
        let proxy_login = if trusted && self.bind_profile {
            self.policy
                .proxy_header
                .as_ref()
                .and_then(|name| read_header(headers, name).ok())
                .map(trim_js)
                .filter(|login| !login.is_empty())
                .map(str::to_lowercase)
        } else {
            None
        };
        Ok(Admission {
            client,
            proxy_login,
            secure,
            protected: self.policy.settings.require_proxy,
            service,
            forwarded_host: (trusted && route == ServiceRoute::Metadata)
                .then(|| first(headers, &HeaderName::from_static("x-forwarded-host")).ok())
                .flatten()
                .filter(|host| !host.is_empty())
                .map(str::to_owned),
        })
    }
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
        let cover_signer = settings
            .metadata_service
            .as_ref()
            .filter(|service| !service.token.is_empty())
            .map(|service| CoverSigner::new(&service.token));
        Self {
            http_approval: marker("http"),
            websocket_approval: marker("websocket"),
            metrics_approval: marker("http:metrics"),
            metadata_approval: marker("http:metadata"),
            cover_signer,
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
        self.evaluate(request, peer, protocol, None)
            .unwrap_or(Decision::Forward)
    }

    fn evaluate(
        &self,
        request: &Request<impl Sized>,
        peer: IpAddr,
        protocol: Protocol,
        route: Option<ServiceRoute>,
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
        let on_health = matches!(normalized, "/health" | "/ready" | "/api/index-status")
            && route.is_none_or(|route| route == ServiceRoute::Health);
        let on_metrics = self
            .settings
            .metrics
            .as_ref()
            .is_some_and(|metrics| metrics.path == normalized)
            && route.is_none_or(|route| route == ServiceRoute::Metrics);
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

        let service = self.service_access(request, normalized, protocol, on_metrics, route)?;
        let check_proxy = self.settings.require_proxy
            && !(on_health && self.settings.auth_exempt_health)
            && matches!(service, ServiceAccess::None);
        let deny = |reason| {
            if route.is_none() && protocol == Protocol::Http && needs_session {
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
            self.websocket_approval.clone()
        } else {
            match service {
                ServiceAccess::Metrics => self.metrics_approval.clone(),
                ServiceAccess::Metadata => self.metadata_approval.clone(),
                ServiceAccess::SignedCover(expires) => HeaderValue::try_from(format!(
                    "{}:http:cover:{expires}",
                    self.settings.revision
                ))
                .expect("valid signed cover approval"),
                ServiceAccess::Exempt | ServiceAccess::None => self.http_approval.clone(),
            }
        };
        Ok(Decision::Allow {
            proof,
            secure,
            needs_session,
            service,
        })
    }

    fn metrics_path(&self) -> &str {
        self.settings
            .metrics
            .as_ref()
            .map_or("", |metrics| &metrics.path)
    }

    fn trusted_range(&self, peer: IpAddr) -> bool {
        ipv4(peer).is_some_and(|ip| {
            self.settings
                .trusted_ranges
                .iter()
                .any(|range| u32::from(ip) & range.mask == range.base)
        })
    }

    fn forwarded_client(&self, headers: &HeaderMap) -> Option<IpAddr> {
        let value = read_header(headers, &HeaderName::from_static("x-forwarded-for")).ok()?;
        let mut chain = value
            .rsplit(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .peekable();
        while let Some(hop) = chain.next() {
            let address = hop.parse().ok()?;
            if chain.peek().is_none() || !self.trusted_range(address) {
                return Some(address);
            }
        }
        None
    }

    fn service_access(
        &self,
        request: &Request<impl Sized>,
        path: &str,
        protocol: Protocol,
        on_metrics: bool,
        route: Option<ServiceRoute>,
    ) -> Result<ServiceAccess, Forward> {
        if protocol == Protocol::Http
            && route.is_none_or(|route| route == ServiceRoute::Metadata)
            && matches!(*request.method(), Method::GET | Method::HEAD)
            && let Some(service) = &self.settings.metadata_service
            && let Some(suffix) = path.strip_prefix(&service.path)
            && matches!(suffix, "" | "/search" | "/cover")
        {
            let header = read_header(request.headers(), &header::AUTHORIZATION)?;
            let supplied = bearer(header).unwrap_or(header).trim();
            if equal_token(supplied, &service.token) {
                return Ok(ServiceAccess::Metadata);
            }
            if suffix == "/cover"
                && let Some(signer) = &self.cover_signer
                && let Some(query) = request.uri().query()
            {
                if request.uri().scheme().is_some() {
                    return Err(Forward);
                }
                let verified = signer.verify(query);
                let expires = if route.is_none() {
                    verified?
                } else {
                    verified.ok().flatten()
                };
                if let Some(expires) = expires {
                    return Ok(ServiceAccess::SignedCover(expires));
                }
            }
        }
        if on_metrics && let Some(metrics) = &self.settings.metrics {
            if !metrics.token.is_empty() {
                let header = read_header(request.headers(), &header::AUTHORIZATION)?;
                let from_header = bearer(header)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let matches = if let Some(supplied) = from_header {
                    equal_token(supplied, &metrics.token)
                } else if protocol == Protocol::Http
                    && let Some(query) = request.uri().query()
                {
                    if request.uri().scheme().is_some() {
                        return Err(Forward);
                    }
                    let supplied = if route.is_some() {
                        services::metrics_token(query)
                    } else {
                        let [value] = query_values(query, ["token"])?;
                        value
                    };
                    supplied.is_some_and(|value| equal_token(trim_js(&value), &metrics.token))
                } else {
                    false
                };
                if matches {
                    return Ok(ServiceAccess::Metrics);
                }
            }
            if metrics.exempt {
                return Ok(ServiceAccess::Exempt);
            }
        }
        Ok(ServiceAccess::None)
    }
}

pub(crate) struct Forward;

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

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn ipv4(peer: IpAddr) -> Option<Ipv4Addr> {
    match peer {
        IpAddr::V4(addr) => Some(addr),
        IpAddr::V6(addr) if addr.is_loopback() => Some(Ipv4Addr::LOCALHOST),
        IpAddr::V6(addr) => addr.to_ipv4_mapped(),
    }
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
