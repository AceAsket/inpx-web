use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use ctutils::CtEq;
use hyper::body::Bytes;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use ipnet::IpNet;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use url::{Origin, Url};

use crate::http::{Body, body};

mod services;

pub(crate) use services::{CoverSigner, query_values, trim_js};

pub(crate) const APPROVAL: HeaderName = HeaderName::from_static("x-inpx-request-access");

pub(crate) fn split_proxy_cidrs(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize)]
#[serde(try_from = "LegacyIpv4Range")]
struct Range(IpNet);

// The Node.js HTTP bridge sends its IPv4 networks as two integers.
#[derive(Deserialize)]
struct LegacyIpv4Range {
    base: u32,
    mask: u32,
}

impl TryFrom<LegacyIpv4Range> for Range {
    type Error = ipnet::PrefixLenError;

    fn try_from(range: LegacyIpv4Range) -> Result<Self, Self::Error> {
        IpNet::with_netmask(
            Ipv4Addr::from(range.base).into(),
            Ipv4Addr::from(range.mask).into(),
        )
        .map(Self)
    }
}

impl Range {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (address, prefix) = match value.split_once('/') {
            Some((address, length)) => (address, Some(length.parse::<u8>().ok()?)),
            None => (value, None),
        };
        let address = address.parse::<IpAddr>().ok()?;
        // Older configurations can use ::1 or mapped addresses with IPv4 prefix lengths.
        if let Some(v4) = ipv4(address)
            && prefix.unwrap_or(32) <= 32
        {
            return IpNet::new(v4.into(), prefix.unwrap_or(32)).ok().map(Self);
        }
        let network = match prefix {
            Some(length) => IpNet::new(address, length).ok()?,
            None => IpNet::from(address),
        };
        if let IpNet::V6(net) = network
            && let Some(mapped) = net.addr().to_ipv4_mapped()
            && net.prefix_len() >= 96
        {
            return IpNet::new(mapped.into(), net.prefix_len() - 96)
                .ok()
                .map(Self);
        }
        Some(Self(network))
    }

    fn contains(&self, peer: IpAddr) -> bool {
        match self.0 {
            IpNet::V4(net) => ipv4(peer).is_some_and(|ip| net.contains(&ip)),
            IpNet::V6(net) => matches!(peer.to_canonical(), IpAddr::V6(ip) if net.contains(&ip)),
        }
    }
}

#[derive(Clone, Deserialize)]
pub(crate) struct Metrics {
    pub(crate) path: String,
    pub(crate) exempt: bool,
    pub(crate) token: String,
}

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Eq)]
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
    configured_binding: bool,
    configured_binding_required: bool,
    force_local_login: bool,
    allow_guests: bool,
    mode: String,
    require_auth: bool,
    pub(crate) services: Arc<Services>,
    pub(crate) login_rate: inpx_auth_state::login_rate::Policy,
    pub(crate) proxy_revision: u64,
}

pub(crate) struct Services {
    pub(crate) metrics: crate::standalone::metrics::Endpoint,
    pub(crate) metadata: crate::standalone::metadata::Endpoint,
}

impl Services {
    pub(crate) fn new(config: &Value, prefix: &str) -> Self {
        Self {
            metrics: crate::standalone::metrics::Endpoint::new(config),
            metadata: crate::standalone::metadata::Endpoint::new(config, prefix),
        }
    }

    fn metrics_rules(&self) -> Option<Metrics> {
        self.metrics.enabled.then(|| self.metrics.rules.clone())
    }

    fn metadata_rules(&self) -> Option<MetadataService> {
        (self.metadata.enabled && !self.metadata.rules.token.is_empty())
            .then(|| self.metadata.rules.clone())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Admission {
    pub(crate) client: IpAddr,
    pub(crate) proxy_login: Option<String>,
    pub(crate) secure: bool,
    pub(crate) cookie_port: u16,
    pub(crate) protected: bool,
    pub(crate) service: ServiceAccess,
    pub(crate) forwarded_host: Option<String>,
}

pub(crate) struct Live(watch::Sender<Arc<Standalone>>);

impl Live {
    pub(crate) fn new(policy: Standalone) -> Self {
        Self(watch::Sender::new(Arc::new(policy)))
    }

    pub(crate) fn current(&self) -> Arc<Standalone> {
        self.0.borrow().clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<Arc<Standalone>> {
        self.0.subscribe()
    }

    pub(crate) fn apply(&self, policy: Standalone) {
        self.0.send_replace(Arc::new(policy));
    }

    pub(crate) fn refresh_clients(&self) {
        self.0.send_modify(|_| {});
    }
}

pub(crate) const LIVE_FIELDS: &[(&str, &str)] = &[
    ("allowAnonymousAccess", "INPX_ALLOW_ANONYMOUS_ACCESS"),
    ("trustProxy", "INPX_TRUST_PROXY"),
    ("trustedProxyCidrs", "INPX_TRUSTED_PROXY_CIDRS"),
    ("authMode", "INPX_AUTH_MODE"),
    ("requireAuth", "INPX_REQUIRE_AUTH"),
    ("proxyAuthHeader", "INPX_PROXY_AUTH_HEADER"),
    ("authExemptHealth", "INPX_AUTH_EXEMPT_HEALTH"),
];

pub(crate) struct BrowserConnection {
    pub(crate) admission: Arc<Admission>,
    pub(crate) peer: IpAddr,
    pub(crate) request: Request<()>,
    pub(crate) proxy_revision: u64,
}

impl BrowserConnection {
    pub(crate) fn valid(&self, policy: &Standalone) -> bool {
        self.proxy_revision == policy.proxy_revision
            || policy
                .admit(
                    &self.request,
                    self.peer,
                    Protocol::WebSocket,
                    ServiceRoute::Other,
                )
                .is_ok_and(|admission| {
                    admission.client == self.admission.client
                        && admission.proxy_login == self.admission.proxy_login
                        && admission.secure == self.admission.secure
                        && admission.cookie_port == self.admission.cookie_port
                })
    }
}

fn auth_mode(config: &Value) -> String {
    std::env::var("INPX_AUTH_MODE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| config["authMode"].as_str().unwrap_or("local").into())
        .trim()
        .to_ascii_lowercase()
}

fn require_auth(config: &Value) -> bool {
    std::env::var("INPX_REQUIRE_AUTH")
        .map_or_else(|_| truthy(&config["requireAuth"]), |value| value == "true")
}

fn allow_guests(config: &Value) -> bool {
    std::env::var("INPX_ALLOW_ANONYMOUS_ACCESS")
        .map_or(config["allowAnonymousAccess"] != false, |value| {
            value != "false"
        })
}

fn login_rate(config: &Value) -> inpx_auth_state::login_rate::Policy {
    let read = |field: &str, fallback| {
        let value = &config[field];
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
            .filter(|&value| value != 0)
            .unwrap_or(fallback)
    };
    inpx_auth_state::login_rate::Policy {
        enabled: std::env::var("INPX_LOGIN_RATE_LIMIT_ENABLED")
            .map_or(config["loginRateLimitEnabled"] != false, |value| {
                value != "false"
            }),
        window_ms: read("loginRateLimitWindowMs", 900_000).max(60_000),
        max_attempts: u32::try_from(read("loginRateLimitMaxAttempts", 8).max(1))
            .unwrap_or(u32::MAX),
    }
}

impl Standalone {
    pub(crate) fn local_login_required(&self) -> bool {
        !self.allow_guests || self.force_local_login
    }

    pub(crate) fn admin_view(&self, peer: IpAddr) -> Value {
        let fields = &self.policy.settings;
        let locked: Vec<_> = LIVE_FIELDS
            .iter()
            .filter(|(_, name)| std::env::var(name).is_ok())
            .map(|(field, _)| *field)
            .collect();
        json!({
            "allowAnonymousAccess":self.allow_guests,
            "localLoginForced":self.force_local_login,
            "trustProxy":fields.trust_proxy,
            "authMode":if self.mode.is_empty() {"local"} else {&self.mode},
            "requireAuth":self.require_auth,
            "proxyAuthHeader":fields.proxy_header,
            "authExemptHealth":fields.auth_exempt_health,
            "trustedProxyCidrs":fields.trusted_ranges.iter().map(|range| range.0.trunc().to_string()).collect::<Vec<_>>(),
            "peer":peer.to_canonical(),
            "peerTrusted":fields.trust_proxy && self.policy.trusted_range(peer),
            "locked":locked
        })
    }

    pub(crate) fn update(
        &self,
        patch: &Value,
        config: &Value,
        services: Option<Services>,
    ) -> inpx_catalog::Result<Self> {
        let mut settings = self.policy.settings.clone();
        let mut allow_guests = self.allow_guests;
        let mut mode = self.mode.clone();
        let mut require_auth = self.require_auth;
        for (field, env) in LIVE_FIELDS {
            let Some(value) = patch.get(*field) else {
                continue;
            };
            if std::env::var(env).is_ok() {
                return Err(format!("Параметр задан через {env}").into());
            }
            match *field {
                "allowAnonymousAccess" => {
                    allow_guests = value
                        .as_bool()
                        .ok_or("Укажите, разрешён ли гостевой доступ")?
                }
                "trustProxy" => {
                    settings.trust_proxy = value
                        .as_bool()
                        .ok_or("Укажите, используется ли доверенный прокси")?;
                    settings.express_trust_proxy = settings.trust_proxy;
                }
                "trustedProxyCidrs" => {
                    let rows = value
                        .as_array()
                        .filter(|rows| rows.len() <= 128)
                        .ok_or("Укажите до 128 доверенных сетей")?;
                    settings.trusted_ranges = rows
                        .iter()
                        .map(|row| {
                            row.as_str()
                                .and_then(Range::parse)
                                .ok_or("Некорректный IPv4/IPv6-адрес или префикс сети")
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                }
                "authMode" => {
                    mode = value
                        .as_str()
                        .filter(|mode| matches!(*mode, "local" | "proxy" | "none"))
                        .ok_or("Некорректный режим входа")?
                        .to_owned();
                }
                "requireAuth" => {
                    require_auth = value.as_bool().ok_or("Некорректное требование входа")?
                }
                "authExemptHealth" => {
                    settings.auth_exempt_health = value
                        .as_bool()
                        .ok_or("Некорректный режим проверки состояния")?
                }
                "proxyAuthHeader" => {
                    let name = value
                        .as_str()
                        .map(str::trim)
                        .ok_or("Некорректный заголовок SSO")?;
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| "Некорректный заголовок SSO")?;
                    settings.proxy_header = name.to_owned();
                }
                _ => unreachable!(),
            }
        }
        let bind_profile = mode == "proxy" && self.configured_binding;
        settings.require_proxy =
            mode == "proxy" && (require_auth || self.configured_binding_required);
        if settings.require_proxy && (!settings.trust_proxy || settings.trusted_ranges.is_empty()) {
            return Err("Для входа через прокси укажите хотя бы один доверенный адрес".into());
        }
        let services = services.map_or_else(|| self.services.clone(), Arc::new);
        settings.metrics = services.metrics_rules();
        settings.metadata_service = services.metadata_rules();
        let force_local_login = matches!(mode.as_str(), "" | "local") && require_auth;
        let changed = self.bind_profile != bind_profile
            || !patch.is_null()
                && LIVE_FIELDS
                    .iter()
                    .any(|(key, _)| *key != "allowAnonymousAccess" && patch.get(*key).is_some());
        let policy = Policy::new(settings);
        if policy.settings.require_proxy && policy.proxy_header.is_none() {
            return Err("Некорректный заголовок SSO".into());
        }
        Ok(Self {
            policy,
            bind_profile,
            configured_binding: self.configured_binding,
            configured_binding_required: self.configured_binding_required,
            force_local_login,
            allow_guests,
            mode,
            require_auth,
            services,
            login_rate: login_rate(config),
            proxy_revision: self.proxy_revision.wrapping_add(u64::from(changed)),
        })
    }

    pub(crate) fn profile_binding(&self) -> bool {
        self.bind_profile
    }

    pub(crate) fn secure_browser_origin(&self, headers: &HeaderMap) -> bool {
        read_header(headers, &header::ORIGIN).is_ok_and(|origin| origin.starts_with("https://"))
            && same_origin(headers, true, "https").unwrap_or(false)
    }

    pub(crate) fn new(
        config: &Value,
        root: &str,
        services: Services,
    ) -> inpx_catalog::Result<Self> {
        let value = |variable, property: &str, default: &str| {
            std::env::var(variable)
                .ok()
                .filter(|value| !value.is_empty())
                .or_else(|| config[property].as_str().map(str::to_owned))
                .unwrap_or_else(|| default.into())
        };
        let flag = |variable| std::env::var(variable).ok().map(|value| value == "true");
        let mode = auth_mode(config);
        if !matches!(mode.as_str(), "proxy" | "local" | "none" | "") {
            return Err("Unsupported authentication mode".into());
        }
        let bind = flag("INPX_PROXY_BIND_PROFILE");
        let configured_binding = bind.unwrap_or(config["proxyBindProfile"] == true);
        let configured_binding_required =
            bind.unwrap_or_else(|| truthy(&config["proxyBindProfile"]));
        let bind_profile = mode == "proxy" && configured_binding;
        let trust_proxy = flag("INPX_TRUST_PROXY").unwrap_or(config["trustProxy"] == true);
        let trusted_ranges = match std::env::var("INPX_TRUSTED_PROXY_CIDRS") {
            Ok(value) => split_proxy_cidrs(&value).filter_map(Range::parse).collect(),
            Err(_) => match &config["trustedProxyCidrs"] {
                Value::String(value) => split_proxy_cidrs(value).filter_map(Range::parse).collect(),
                Value::Array(values) => values
                    .iter()
                    .filter_map(|value| Range::parse(value.as_str()?))
                    .collect(),
                _ => Vec::new(),
            },
        };
        let proxy_header = value("INPX_PROXY_AUTH_HEADER", "proxyAuthHeader", "Remote-User");
        let require_auth = require_auth(config);
        let require_proxy = mode == "proxy" && (configured_binding_required || require_auth);
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
            metrics: services.metrics_rules(),
            metadata_service: services.metadata_rules(),
        });
        if require_proxy && policy.proxy_header.is_none() {
            return Err("Invalid proxy authentication header".into());
        }
        Ok(Self {
            policy,
            bind_profile,
            configured_binding,
            configured_binding_required,
            force_local_login: matches!(mode.as_str(), "" | "local") && require_auth,
            allow_guests: allow_guests(config),
            mode,
            require_auth,
            services: Arc::new(services),
            login_rate: login_rate(config),
            proxy_revision: 0,
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
        let forwarded_host = trusted
            .then(|| first(headers, &HeaderName::from_static("x-forwarded-host")).ok())
            .flatten()
            .filter(|host| !host.is_empty());
        let forwarded_port = trusted
            .then(|| first(headers, &HeaderName::from_static("x-forwarded-port")).ok())
            .flatten()
            .and_then(|port| port.parse().ok());
        let cookie_port = public_port(headers, secure, forwarded_host, forwarded_port);
        Ok(Admission {
            client,
            proxy_login,
            secure,
            cookie_port,
            protected: self.policy.settings.require_proxy,
            service,
            forwarded_host: forwarded_host
                .filter(|_| route == ServiceRoute::Metadata)
                .map(str::to_owned),
        })
    }
}

// Cookies have no port scope in a browser. Use the public listener port in their names.
fn public_port(
    headers: &HeaderMap,
    secure: bool,
    forwarded_host: Option<&str>,
    forwarded_port: Option<u16>,
) -> u16 {
    let port = |host: &str| host.parse::<hyper::http::uri::Authority>().ok()?.port_u16();
    let default = if secure { 443 } else { 80 };
    if let Some(host) = forwarded_host {
        return port(host).or(forwarded_port).unwrap_or(default);
    }
    forwarded_port
        .or_else(|| headers.get(header::HOST)?.to_str().ok().and_then(port))
        .unwrap_or(default)
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
        self.settings
            .trusted_ranges
            .iter()
            .any(|range| range.contains(peer))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_proxy_networks_match_prefixes_and_single_hosts() {
        let matches =
            |range: &str, peer: &str| Range::parse(range).unwrap().contains(peer.parse().unwrap());
        assert!(matches(" 2001:db8:5::a/64 ", "2001:db8:5::ffff"));
        assert!(!matches("2001:db8:5::/64", "2001:db8:6::"));
        assert!(matches("2001:db8::3/127", "2001:db8::2"));
        assert!(!matches("2001:db8::3/127", "2001:db8::1"));
        for range in ["2001:db8::7", "2001:db8::7/128"] {
            assert!(matches(range, "2001:db8:0:0:0:0:0:7"));
            assert!(!matches(range, "2001:db8::6"));
        }
        assert!(matches("::/0", "2001:db8::1"));
        assert!(!matches("::/0", "192.0.2.1"));
        assert!(!matches("::/0", "::ffff:192.0.2.1"));
        assert!(!matches("0.0.0.0/0", "2001:db8::1"));
        for invalid in [
            "",
            "example.org",
            "2001:db8::1/129",
            "::/bad",
            "::/",
            "192.0.2.1/33",
        ] {
            assert!(Range::parse(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn ipv4_proxy_ranges_keep_legacy_address_and_wire_forms() {
        let legacy: Range = serde_json::from_value(serde_json::json!({
            "base": u32::from(Ipv4Addr::new(192,0,2,0)), "mask": 0xffffff00u32
        }))
        .unwrap();
        for range in [
            legacy,
            Range::parse("192.0.2.0/24").unwrap(),
            Range::parse("::ffff:192.0.2.0/24").unwrap(),
            Range::parse("::ffff:192.0.2.0/120").unwrap(),
        ] {
            for peer in ["192.0.2.42", "::ffff:192.0.2.42"] {
                assert!(range.contains(peer.parse().unwrap()));
            }
            assert!(!range.contains("192.0.3.1".parse().unwrap()));
        }
        assert!(
            Range::parse("127.0.0.1")
                .unwrap()
                .contains("::1".parse().unwrap())
        );
        assert!(
            Range::parse("::1/128")
                .unwrap()
                .contains("::1".parse().unwrap())
        );
        assert!(
            !Range::parse("::1/128")
                .unwrap()
                .contains("127.0.0.1".parse().unwrap())
        );
    }

    #[test]
    fn session_cookie_uses_the_public_port() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("[::1]:12380"));
        assert_eq!(public_port(&headers, false, None, None), 12380);
        assert_eq!(public_port(&headers, true, Some("books.test"), None), 443);
        assert_eq!(
            public_port(&headers, true, Some("books.test"), Some(8443)),
            8443
        );
        assert_eq!(
            public_port(&headers, true, Some("books.test:9443"), Some(8443)),
            9443
        );
        assert_eq!(public_port(&headers, true, None, Some(8443)), 8443);
        headers.insert(header::HOST, HeaderValue::from_static("books.test"));
        assert_eq!(public_port(&headers, false, None, None), 80);
    }
}
