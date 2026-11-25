use std::collections::HashMap;
use std::convert::Infallible;
use std::ffi::OsString;
use std::fs::File;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hyper::body::{Bytes, Incoming};
use hyper::header;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use inpx_catalog::opds_access::Resource;
use inpx_catalog::standalone_catalogue::CatalogueFiles;
use inpx_catalog::{Result, profile_bootstrap, web_app};
use inpx_catalog::{book_conversion::Conversion, configuration};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use crate::assets::{self, Assets};
use crate::http::{Body, body, error};
use crate::request_access::{self, Admission, Decision, Protocol, ServiceRoute};
use crate::standalone_access::{self, Access, Rejection};
use crate::standalone_download::{self, Downloads};

#[path = "standalone_admin_cache.rs"]
mod admin_cache;
#[path = "standalone_backup.rs"]
mod backup;
#[path = "standalone_batch.rs"]
mod batch;
#[path = "standalone_delivery.rs"]
mod delivery;
#[path = "standalone_diagnostics.rs"]
mod diagnostics;
#[path = "standalone_discovery.rs"]
mod discovery;
#[path = "standalone_ebook.rs"]
mod ebook;
#[path = "standalone_events.rs"]
mod events;
#[path = "standalone_exchange.rs"]
mod exchange;
#[path = "standalone_index.rs"]
mod index;
#[path = "standalone_isbn.rs"]
mod isbn;
#[path = "standalone_kosync.rs"]
mod kosync;
#[path = "standalone_legacy_http.rs"]
mod legacy_http;
#[path = "standalone_logging.rs"]
pub(crate) mod logging;
#[path = "standalone_metadata.rs"]
pub(crate) mod metadata;
#[path = "standalone_metrics.rs"]
pub(crate) mod metrics;
#[path = "standalone_profile_http.rs"]
mod profile_http;
#[path = "standalone_remote.rs"]
pub(crate) mod remote;
#[path = "standalone_resources.rs"]
pub(crate) mod resources;
#[path = "standalone_runtime.rs"]
mod runtime;
#[path = "standalone_settings.rs"]
mod settings;
#[path = "standalone_smtp.rs"]
mod smtp;
#[path = "standalone_socket.rs"]
mod socket;
#[path = "standalone_speech.rs"]
mod speech;
#[path = "standalone_startup.rs"]
mod startup;
#[path = "standalone_tasks.rs"]
mod tasks;
#[path = "standalone_telegram.rs"]
mod telegram;

const VERSION: &str = env!("INPX_RELEASE_VERSION");
const NAME: &str = "inpx-web";

struct State {
    started: Instant,
    resources: Arc<resources::Budget>,
    index: index::Index,
    settings: settings::Settings,
    admin_cache: admin_cache::Cache,
    diagnostics: diagnostics::Diagnostics,
    backups: backup::Backups,
    assets: Assets,
    legacy: legacy_http::Routes,
    opds_slots: Arc<Semaphore>,
    access: Access,
    socket: socket::Socket,
    events: events::Events,
    ebook: ebook::Ebook,
    speech: Arc<speech::Speech>,
    delivery: delivery::Delivery,
    batch: batch::Downloads,
    downloads: Downloads,
    download_slots: Arc<resources::AdmissionSlots>,
    kosync: kosync::Routes,
    request_access: Arc<request_access::Live>,
    metadata: metadata::Routes,
    exchange: exchange::Exchange,
    isbn_worker_capacity: usize,
    metrics: metrics::Monitor,
    launch: Value,
}

#[derive(Default)]
struct Args {
    help: bool,
    version: bool,
    reset: bool,
    recreate: bool,
    values: HashMap<String, String>,
}

impl Args {
    fn parse(args: &[OsString]) -> Result<Self> {
        let mut parsed = Self::default();
        let mut args = args.iter();
        while let Some(argument) = args.next() {
            let argument = argument.to_str().ok_or("Invalid command-line argument")?;
            let (flag, value) = argument
                .split_once('=')
                .map_or((argument, None), |(flag, value)| (flag, Some(value)));
            match flag {
                "--help" | "-h" if value.is_none() => parsed.help = true,
                "--version" | "-v" if value.is_none() => parsed.version = true,
                "--reset-admin-password" if value.is_none() => parsed.reset = true,
                "--recreate" if value.is_none() => parsed.recreate = true,
                // Rust interprets the record predicate without executing JavaScript.
                "--unsafe-filter" if value.is_none() => {}
                "--host" | "--port" | "--config" | "--data-dir" | "--app-dir" | "--lib-dir"
                | "--inpx" | "--library-sources" | "--admin-login" | "--admin-password"
                | "--web-bundle" | "--log-level" => {
                    let value = value
                        .or_else(|| {
                            args.next()
                                .and_then(|value| value.to_str())
                                .filter(|value| !value.starts_with("--"))
                        })
                        .ok_or_else(|| format!("Missing value for {flag}"))?;
                    parsed.values.insert(flag.into(), value.into());
                }
                _ => return Err(format!("Unsupported standalone option {flag}").into()),
            }
        }
        Ok(parsed)
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn nonempty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }
}

pub(crate) async fn run(args: &[OsString]) -> Result<()> {
    let args = Args::parse(args)?;
    if args.version {
        println!("{NAME} v{VERSION}");
        return Ok(());
    }
    if args.help {
        println!(
            "{NAME} v{VERSION}\nUsage: inpx-web [--host=<ip>] [--port=<port>] [--data-dir=<dir>]\n\
            [--config=<file>] [--lib-dir=<dir>] [--inpx=<file>] [--library-sources=<sources>] [--web-bundle=<file>]\n\
            [--admin-login=<login>] [--admin-password=<password>] [--reset-admin-password] [--recreate]\n\
            [--log-level=<error|warn|info|debug>]"
        );
        return Ok(());
    }

    let executable = std::env::current_exe()?;
    let exec_dir = executable.parent().ok_or("Missing executable directory")?;
    let default_data = args
        .nonempty("--data-dir")
        .or_else(|| args.nonempty("--app-dir"))
        .map_or_else(|| exec_dir.join(".inpx-web"), PathBuf::from);
    let file = args
        .nonempty("--config")
        .map_or_else(|| default_data.join("config.json"), PathBuf::from);
    let configuration::Loaded::Ready {
        config: saved,
        needs_save,
    } = configuration::load(
        configuration::Load {
            file: file.clone(),
            default_data_dir: default_data.clone(),
            exec_dir: exec_dir.into(),
            name: NAME.into(),
            version: Some(VERSION.into()),
        },
        "rust",
    )?
    else {
        return Err("Existing configuration requires the compatibility runtime".into());
    };
    let mut config = json!({
        "dataDir":default_data,"server":{"host":"0.0.0.0","port":"12380","root":""},
        "opds":{"enabled":true,"root":"/opds","user":"","password":""},"inpxCheckInterval":60,
    });
    let fresh = saved.is_none();
    if let Some(saved) = saved {
        config
            .as_object_mut()
            .expect("application defaults")
            .extend(saved);
    }
    let host = args
        .nonempty("--host")
        .or_else(|| text(&config["server"]["host"]))
        .unwrap_or("0.0.0.0");
    if host.contains('/') {
        return Err("Для --host или server.host укажите адрес слушателя без CIDR. Для всех IPv6-интерфейсов используйте ::".into());
    }
    let port = match args
        .nonempty("--port")
        .or_else(|| config["server"]["port"].as_str())
    {
        Some(port) => port.parse::<u16>()?,
        None => u16::try_from(config["server"]["port"].as_u64().unwrap_or(12380))?,
    };
    let prefix = text(&config["server"]["root"]).unwrap_or_default();
    let data = text(&config["dataDir"]).map_or(default_data, PathBuf::from);
    logging::init(args.get("--log-level"), &config, &data)?;
    let remote = remote::Remote::new(&config, &data)?.map(Arc::new);
    let kosync_enabled = runtime::kosync_enabled(&config);
    let fb2_download = fb2_download_enabled(&config);
    let (cpu, memory) = diagnostics::hardware();
    let policy = resources::Policy::new(cpu, memory, &config)?;
    let resources = Arc::new(resources::Budget::new(policy.clone()));
    let conversion = Conversion::new(&config, exec_dir, policy.selected.limits.conversions)?;
    let conversion_formats: Vec<_> = fb2_download
        .then_some("fb2")
        .into_iter()
        .chain(conversion.iter().flat_map(Conversion::formats))
        .collect();
    let settings = settings::Settings::new(
        file.clone(),
        data.clone(),
        prefix,
        config.clone(),
        json!({
            "argument":args.get("--library-sources").unwrap_or_default(),
            "environment":env("INPX_LIBRARY_SOURCES").or_else(|| env("LIBRARY_SOURCES")).unwrap_or_default(),
            "environmentName":if env("INPX_LIBRARY_SOURCES").is_some() { "INPX_LIBRARY_SOURCES" } else { "LIBRARY_SOURCES" },
            "libDir":args.nonempty("--lib-dir").map(str::to_owned).or_else(||env("LIBDIR")),
            "libDirSource":if args.nonempty("--lib-dir").is_some() { "--lib-dir" } else { "LIBDIR" },
            "inpx":args.nonempty("--inpx").map(str::to_owned).or_else(||env("INPX")),
            "inpxSource":if args.nonempty("--inpx").is_some() { "--inpx" } else { "INPX" },
            "execDir":exec_dir,
        }),
    );
    let metadata = metadata::Routes::new(prefix);
    let metrics = metrics::Monitor::new(&config, &data)?;
    let request_access = Arc::new(request_access::Live::new(request_access::Standalone::new(
        &config,
        prefix,
        request_access::Services::new(&config, prefix),
    )?));
    let access = Access::new(
        &data,
        &config,
        kosync_enabled,
        settings.build_opds(&config, &conversion_formats)?,
        request_access.clone(),
    )?;
    if fresh || needs_save {
        configuration::save(&file, &data, &config)?;
    }
    if let Some(remote) = remote.clone() {
        std::fs::create_dir_all(&data)?;
        tokio::task::spawn_blocking(move || -> std::result::Result<(), String> {
            if let Err(error) = remote.sync_inpx() {
                if !remote.has_inpx() {
                    return Err(error.to_string());
                }
                log::warn!(target: "inpx::index", "Удалённая библиотека недоступна. Используется сохранённый INPX");
            }
            Ok(())
        })
        .await??;
    }

    let sources = settings.sources(&config)?;
    let index = index::Index::new(settings.index_files(&config), sources);
    let login = override_string(&args, "--admin-login", "INPX_ADMIN_LOGIN", &Value::Null)
        .unwrap_or_else(|| "admin".into());
    let password = args
        .get("--admin-password")
        .map(str::to_owned)
        .or_else(|| env("INPX_ADMIN_PASSWORD"))
        .unwrap_or_default();
    if let Some(generated) = profile_bootstrap::initialize(
        &data,
        &login,
        password,
        args.reset || env_bool("INPX_RESET_ADMIN_PASSWORD").unwrap_or(false),
    )? {
        eprintln!(
            "Admin profile \"{login}\" password: {generated} (generated; set INPX_ADMIN_PASSWORD or --admin-password to choose one)"
        );
    }

    let app_directory: &str = serde_json::from_str(include_str!("../app-directory.json"))?;
    let public_dir = data.join("public");
    if let Some(bundle) = args.get("--web-bundle") {
        install_bundle(&data, &config, prefix, app_directory, Path::new(bundle))?;
    } else {
        let bundle = exec_dir.join("bin").join("public.json");
        if bundle.try_exists()? {
            install_bundle(&data, &config, prefix, app_directory, &bundle)?;
        }
    }
    let assets = Assets::load(Some(assets::Config {
        directory: public_dir,
        prefix: prefix.into(),
        app_directory: app_directory.into(),
        metrics_path: metrics::Endpoint::path(&config),
        opds_path: Some(text(&config["opds"]["root"]).unwrap_or("/opds").into()),
    }));
    let downloads = Downloads::new(
        &data,
        prefix,
        resources.clone(),
        fb2_download,
        conversion,
        remote,
        inpx_catalog::legacy_library_files::Covers::new(
            exec_dir,
            &config,
            policy.selected.limits.images,
            policy.timeout,
        ),
    )?;
    let listener = TcpListener::bind((host, port)).await.map_err(|error| {
        format!("Не удалось открыть TCP-слушатель на {host} (порт {port}). {error}")
    })?;
    downloads.configure_names_and_covers(&config);
    let speech = speech::Speech::new(&data, prefix, &config)?;
    let batch = batch::Downloads::new(&data, downloads.root());
    let delivery = delivery::Delivery::new(&data, &config);
    let socket = socket::Socket::new(
        prefix,
        &config,
        &data,
        &conversion_formats,
        !access.library.protected(),
        speech.enabled(),
        policy.selected.limits.reviews,
    );
    let exchange = exchange::Exchange::new(&config);
    let ebook = ebook::Ebook::new(prefix, &config);
    let state = Arc::new(State {
        started: Instant::now(),
        index,
        settings,
        admin_cache: admin_cache::Cache::new(),
        diagnostics: diagnostics::Diagnostics::new(&data),
        backups: backup::Backups::new(&data, &file, prefix, socket::TransportLimits::new(&config)),
        assets,
        legacy: legacy_http::Routes::new(prefix),
        opds_slots: Arc::new(Semaphore::new(8)),
        access,
        socket,
        events: events::Events::new(),
        ebook,
        speech,
        batch,
        delivery,
        downloads,
        download_slots: resources::AdmissionSlots::new(policy.selected.limits.total.max(4)),
        resources,
        kosync: kosync::Routes::new(prefix),
        request_access,
        metadata,
        exchange,
        isbn_worker_capacity: isbn::capacity(cpu, memory),
        metrics,
        launch: json!({
            "host":host, "address":listener.local_addr()?.to_string(), "prefix":prefix,
            "dataDir":data, "configFile":file
        }),
    });
    println!("{NAME} v{VERSION} listening on {}", listener.local_addr()?);
    let initializing = state.clone();
    let mut opening = tokio::task::spawn_blocking(move || {
        initializing
            .index
            .initialize(args.recreate)
            .map_err(|err| err.to_string())
    });
    let created = loop {
        tokio::select! {
            result = &mut opening => break result??,
            connection = listener.accept() => serve_connection(&state,connection?),
        }
    };
    delivery::Delivery::start(&state);
    tokio::spawn(admin_cache::Cache::schedule(state.clone()));
    tokio::spawn(diagnostics::Diagnostics::collect_lag(state.clone()));
    tokio::spawn(backup::Backups::schedule(state.clone()));
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let state = state.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    state.downloads.expire_covers();
                    state.batch.cleanup()
                })
                .await;
            }
        });
    }
    state.schedule_index_checks(!created && !args.recreate && state.downloads.remote().is_none());
    if state.access.library.protected() {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let state = state.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Err(error) = state.access.library.flush() {
                        log::error!(target: "inpx::auth", "WebAccess flush: {error}");
                    }
                })
                .await;
            }
        });
    }
    loop {
        serve_connection(&state, listener.accept().await?);
    }
}

fn serve_connection(
    state: &Arc<State>,
    (stream, peer): (tokio::net::TcpStream, std::net::SocketAddr),
) {
    let state = state.clone();
    tokio::spawn(async move {
        let _ = stream.set_nodelay(true);
        let service = service_fn(|request| state.serve(request, peer.ip()));
        let _ = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(Duration::from_secs(60))
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades()
            .await;
    });
}

fn isbn_limit(config: &Value) -> u64 {
    let parse = |key| {
        std::env::var(key)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
    };
    const MIB: u64 = 1024 * 1024;
    parse("INPX_ISBN_MAX_BOOK_BYTES")
        .or_else(|| parse("INPX_ISBN_MAX_BOOK_MB").map(|size| size.saturating_mul(MIB)))
        .or_else(|| config["isbnMaxBookBytes"].as_u64())
        .unwrap_or(64 * MIB)
        .max(MIB)
}

fn install_bundle(
    data: &Path,
    config: &Value,
    prefix: &str,
    application: &str,
    bundle: &Path,
) -> Result<()> {
    let bundle: Value = serde_json::from_reader(File::open(bundle)?)?;
    let bundle = bundle["data"]
        .as_str()
        .ok_or("Invalid packaged web app bundle")?;
    let temp_dir = match text(&config["tempDir"]) {
        Some(concat!("$", "{OS}")) => std::env::temp_dir().join(NAME),
        Some(path) => PathBuf::from(path),
        None => data.join("tmp"),
    };
    web_app::install(web_app::Install {
        public_dir: data.join("public"),
        temp_dir,
        version: VERSION.into(),
        prefix: prefix.into(),
        app_directory: application.into(),
        bundle: bundle.into(),
    })
}

fn override_string(args: &Args, flag: &str, variable: &str, value: &Value) -> Option<String> {
    args.nonempty(flag)
        .map(str::to_owned)
        .or_else(|| env(variable))
        .or_else(|| text(value).map(str::to_owned))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|value| value == "true")
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.is_empty())
}

fn fb2_download_enabled(config: &Value) -> bool {
    std::env::var("INPX_ENABLE_CONVERSION").map_or(config["conversionEnabled"] != false, |value| {
        value != "false"
    }) && std::env::var("INPX_CONVERSION_FORMATS").map_or_else(
        |_| {
            config["conversionFormats"]
                .as_array()
                .is_none_or(|formats| {
                    formats.iter().any(|value| {
                        text(value).is_some_and(|format| format.eq_ignore_ascii_case("fb2"))
                    })
                })
        },
        |value| {
            value
                .split(',')
                .any(|name| name.trim().eq_ignore_ascii_case("fb2"))
        },
    )
}

impl State {
    fn validate_metrics_path(&self, path: &str, opds_root: &str) -> Result<()> {
        let prefix = self.launch["prefix"]
            .as_str()
            .unwrap_or_default()
            .trim_end_matches('/');
        let in_route = |root: &str| {
            path.strip_prefix(root)
                .is_some_and(|tail| tail.is_empty() || tail.starts_with('/'))
        };
        let opds_path = format!("{prefix}{}", opds_root.trim_end_matches('/'));
        if self.socket.matches(path)
            || self.socket.document(path)
            || self.assets.has_path(path)
            || self.kosync.matches(path)
            || self.metadata.matches(path)
            || self.ebook.matches(path)
            || self.backups.matches(path)
            || self.batch.matches(path)
            || self.speech.matches(path)
            || matches!(path, "/" | "/health" | "/ready" | "/api/index-status")
            || in_route(&opds_path)
            || ["book", "cover", "api", "reader-background"]
                .iter()
                .any(|route| in_route(&format!("{prefix}/{route}")))
        {
            return Err("Путь метрик занят другим маршрутом библиотеки".into());
        }
        Ok(())
    }

    fn service_route(
        &self,
        request: &Request<Incoming>,
        websocket: bool,
        policy: &request_access::Standalone,
    ) -> ServiceRoute {
        if websocket || !matches!(*request.method(), Method::GET | Method::HEAD) {
            return ServiceRoute::Other;
        }
        let path = request.uri().path();
        if self
            .access
            .opds()
            .route
            .as_ref()
            .is_some_and(|opds| opds.matches(path))
        {
            ServiceRoute::Other
        } else if self.metadata.matches(path) {
            ServiceRoute::Metadata
        } else if self.kosync.matches(path) {
            ServiceRoute::Other
        } else if matches!(
            path.trim_end_matches('/'),
            "/health" | "/ready" | "/api/index-status"
        ) {
            ServiceRoute::Health
        } else if policy.services.metrics.matches(path) {
            ServiceRoute::Metrics
        } else {
            ServiceRoute::Other
        }
    }

    fn start_index_check(self: &Arc<Self>, force: bool) -> Option<tokio::task::JoinHandle<()>> {
        self.index.start(force).then(|| {
            let state = self.clone();
            tokio::task::spawn_blocking(move || {
                state.refresh_index(state.index.sources(), force, state.index.files());
            })
        })
    }

    fn reindex(self: &Arc<Self>) -> Result<Value> {
        let config = self.settings.snapshot();
        let sources = self.settings.sources(&config)?;
        let files = self.settings.index_files(&config);
        if !self.index.start(true) {
            return Ok(json!({"started":false}));
        }
        let state = self.clone();
        tokio::task::spawn_blocking(move || state.refresh_index(sources, true, files));
        Ok(json!({"started":true}))
    }

    fn refresh_index(
        &self,
        sources: Arc<Vec<inpx_catalog::library_sources::Source>>,
        force: bool,
        files: CatalogueFiles,
    ) {
        let _permit = match self.resources.acquire(resources::Kind::Background) {
            Ok(permit) => permit,
            Err(_) => {
                self.index.failed("Индексация не получила ресурсы", None);
                return;
            }
        };
        if let Some(remote) = self.downloads.remote()
            && remote.sync_inpx().is_err()
        {
            self.index
                .failed("Не удалось обновить INPX удалённой библиотеки", None);
            return;
        }
        let event = match self.index.refresh(sources, force, files) {
            Some(true) => ("info", "Переиндексация завершена"),
            None => ("error", "Переиндексация завершилась ошибкой"),
            Some(false) => return,
        };
        self.diagnostics.log(self, event.0, "index", event.1);
    }

    fn schedule_index_checks(self: &Arc<Self>, on_start: bool) {
        let state = self.clone();
        let mut interval = self.settings.index_interval.subscribe();
        tokio::spawn(async move {
            if on_start && let Some(check) = state.start_index_check(false) {
                let _ = check.await;
            }
            loop {
                let next = *interval.borrow_and_update();
                if let Some(delay) = next {
                    tokio::select! {
                        result = interval.changed() => { if result.is_err() { break; } }
                        () = tokio::time::sleep(delay) => {
                            if let Some(check) = state.start_index_check(false) {
                                let _ = check.await;
                            }
                        }
                    }
                } else if interval.changed().await.is_err() {
                    break;
                }
            }
        });
    }

    async fn serve(
        self: &Arc<Self>,
        request: Request<Incoming>,
        peer: IpAddr,
    ) -> std::result::Result<Response<Body>, Infallible> {
        if request.method() == Method::CONNECT || request.uri().authority().is_some() {
            return Ok(error(StatusCode::BAD_REQUEST));
        }
        let websocket = crate::http::is_websocket(request.headers())
            && self.socket.matches(request.uri().path());
        let protocol = if websocket {
            Protocol::WebSocket
        } else {
            Protocol::Http
        };
        let head = request.method() == Method::HEAD;
        let policy = self.request_access.current();
        let route = self.service_route(&request, websocket, &policy);
        let admission = match policy.admit(&request, peer, protocol, route) {
            Ok(admission) => admission,
            Err(failure) if websocket => {
                let event = match failure {
                    Decision::Deny { reason, .. } => reason.diagnostic(),
                    _ => "invalid-websocket-request",
                };
                logging::warn_limited("inpx::proxy", event, format_args!("peer={peer}"));
                return Ok(request_access::Denial::websocket());
            }
            Err(Decision::Deny { reason, secure }) => {
                let mut response = reason.http(head, secure);
                standalone_access::private(response.headers_mut());
                return Ok(response);
            }
            Err(_) => return Ok(error(StatusCode::BAD_REQUEST)),
        };
        let (secure, protected) = (admission.secure, admission.protected);
        let mut response = if self
            .index
            .starting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            startup::response(self, &request)
        } else if self.socket.document(request.uri().path()) && startup::is_poll(&request) {
            send_bytes(
                br#"{"ready":true}"#.to_vec(),
                "application/json; charset=utf-8",
                head,
            )
        } else if websocket {
            self.socket.upgrade(
                request,
                self.clone(),
                admission,
                peer,
                policy.proxy_revision,
            )
        } else {
            match route {
                ServiceRoute::Metrics => {
                    self.metrics
                        .serve(self, &policy.services.metrics, admission.service, head)
                        .await
                }
                ServiceRoute::Metadata => {
                    self.metadata
                        .serve(self, &policy.services.metadata, &request, &admission)
                        .await
                }
                _ => self.serve_http(request, admission).await?,
            }
        };
        if protected
            && !websocket
            && !matches!(route, ServiceRoute::Metadata | ServiceRoute::Metrics)
        {
            standalone_access::private(response.headers_mut());
        }
        let mut headers = request_access::security_headers(secure);
        if response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY)
        {
            headers.remove(header::CONTENT_SECURITY_POLICY);
        }
        response.headers_mut().extend(headers);
        Ok(response)
    }

    async fn serve_http(
        self: &Arc<Self>,
        request: Request<Incoming>,
        admission: Admission,
    ) -> std::result::Result<Response<Body>, Infallible> {
        if admission.profile_transport == request_access::ProfileTransport::AdminOnly
            && admission.service == request_access::ServiceAccess::None
            && self
                .access
                .require_http_admin(request.headers(), &admission)
                .is_err()
        {
            return Ok(self
                .static_asset(&request, &admission)
                .unwrap_or_else(|| error(StatusCode::FORBIDDEN)));
        }
        if self.ebook.matches(request.uri().path()) {
            return Ok(self.ebook.serve(self, request, admission).await);
        }
        if self.backups.matches(request.uri().path())
            && matches!(*request.method(), Method::GET | Method::HEAD)
        {
            return Ok(self.backups.serve(self, request, admission).await);
        }
        if self.batch.matches(request.uri().path())
            && matches!(*request.method(), Method::GET | Method::HEAD)
        {
            return Ok(self.batch.serve(self, request, admission).await);
        }
        if self.speech.matches(request.uri().path())
            && matches!(*request.method(), Method::GET | Method::HEAD)
        {
            let prepared = self.speech.playback(&request);
            return Ok(standalone_download::respond(
                prepared,
                request.headers().clone(),
                request.method() == Method::HEAD,
            )
            .await);
        }
        let opds_policy = self.access.opds();
        if opds_policy
            .route
            .as_ref()
            .is_some_and(|opds| opds.matches(request.uri().path()))
        {
            let Ok(permit) = self.opds_slots.clone().try_acquire_owned() else {
                return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
            };
            let state = self.clone();
            let response = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let grant = match state.access.check_with_opds(
                    &request,
                    &admission,
                    Resource::Catalogue,
                    &opds_policy,
                ) {
                    Ok(grant) => grant,
                    Err(rejected) => return rejected.response(),
                };
                let opds = opds_policy.route.as_ref().expect("OPDS enabled");
                let reading = if let Some(required) = opds.published_reading(request.uri().path()) {
                    match state.access.published_reading(&grant) {
                        Ok(reading) => Some(reading),
                        Err(rejected) if required => return rejected.response(),
                        Err(_) => None,
                    }
                } else {
                    None
                };
                let catalogue = state.index.catalogue.read().expect("open catalogue");
                let Some(catalogue) = catalogue.as_ref() else {
                    return error(StatusCode::SERVICE_UNAVAILABLE);
                };
                match opds.serve(&request, catalogue, &grant, reading.as_ref()) {
                    Ok(response) => response,
                    Err(_) => {
                        log::error!(target: "inpx::opds", "Не удалось сформировать выдачу OPDS");
                        error(StatusCode::INTERNAL_SERVER_ERROR)
                    }
                }
            })
            .await
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR));
            return Ok(response);
        }
        if self.kosync.matches(request.uri().path()) {
            return Ok(self.kosync.serve(self, request, admission.client).await);
        }
        if request.method() == Method::POST && self.socket.profile_login_route(request.uri().path())
        {
            return Ok(profile_http::login(self, request, &admission).await);
        }
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return Ok(error(StatusCode::NOT_FOUND));
        }
        let head = request.method() == Method::HEAD;
        if let Some((owner, name)) = self.socket.background_route(request.uri().path()) {
            let Ok(owner) = percent_encoding::percent_decode_str(owner).decode_utf8() else {
                return Ok(error(StatusCode::NOT_FOUND));
            };
            let owner = owner.into_owned();
            let name = name.to_owned();
            let state = self.clone();
            let mut response = tokio::task::spawn_blocking(move || {
                match state
                    .access
                    .reader_background(request.headers(), &admission, &owner, &name)
                {
                    Ok((mime, bytes)) => Response::builder()
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::CONTENT_LENGTH, bytes.len())
                        .body(crate::http::body(if head {
                            Bytes::new()
                        } else {
                            bytes.into()
                        }))
                        .expect("valid reader background headers"),
                    Err(Rejection::Unauthorized) => error(StatusCode::UNAUTHORIZED),
                    Err(rejected) => rejected.response(),
                }
            })
            .await
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR));
            standalone_access::private(response.headers_mut());
            return Ok(response);
        }
        if let Some(route) = self.legacy.route(&request) {
            return Ok(legacy_http::Routes::serve(self, route, request, admission).await);
        }
        let cover = self.downloads.cover_request(&request);
        let requested = cover
            .is_none()
            .then(|| self.downloads.request(&request))
            .flatten();
        if cover.is_some() || requested.is_some() {
            let requested = match requested.transpose() {
                Ok(requested) => requested,
                Err(status) => return Ok(error(status)),
            };
            let download = requested.is_some() && !head;
            let slots = self.download_slots.clone();
            let permit = if cover.is_some() {
                Some(slots.take().await)
            } else {
                slots.try_take()
            };
            let Some(permit) = permit else {
                return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
            };
            let state = self.clone();
            let conditions = request.headers().clone();
            let prepared = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let grant = state
                    .access
                    .check(&request, &admission, Resource::Download)?;
                let prepared = if let Some(uid) = cover {
                    state.downloads.cover(
                        &uid,
                        &state.index.catalogue,
                        state.index.generation(),
                        &state.index.sources(),
                    )
                } else {
                    state.downloads.prepare(
                        requested.expect("download request"),
                        &state.index.catalogue,
                        &state.index.sources(),
                        state.access.kosync_enabled().then_some(&state.access),
                    )
                };
                let owner = (download && state.metrics.activity.is_some())
                    .then(|| {
                        state.access.download_profile(
                            request.headers(),
                            admission.cookie_port,
                            &grant,
                        )
                    })
                    .flatten();
                Ok((prepared, grant.private(), owner))
            })
            .await
            .unwrap_or(Err(Rejection::Unavailable));
            return Ok(match prepared {
                Ok((prepared, private, owner)) => {
                    let mut response =
                        standalone_download::respond(prepared, conditions, head).await;
                    if private {
                        standalone_access::private(response.headers_mut());
                    }
                    if download && let Some(activity) = &self.metrics.activity {
                        response = metrics::track_download(response, activity, owner);
                    }
                    response
                }
                Err(rejected) => rejected.content_response(&conditions),
            });
        }
        let path = request.uri().path().trim_end_matches('/');
        let reply = match path {
            "/health" => {
                json!({"status":"ok","ready":self.index.snapshot()["ready"],"version":VERSION,"uptime":self.started.elapsed().as_secs_f64()})
            }
            "/ready" => {
                let index = self.index.snapshot();
                let ready = index["ready"] == true;
                json!({"status":if ready {"ready"} else {"waiting"},"ready":ready,"serverReady":true,"indexReady":ready,"updating":index["updating"],
                    "state":index["state"],"serverMessage":index["serverMessage"],"jobMessage":index["jobMessage"],"progress":index["progress"],
                    "recsLoaded":index["recsLoaded"],"version":VERSION})
            }
            "/api/index-status" => self.index.snapshot(),
            _ => {
                return Ok(self
                    .static_asset(&request, &admission)
                    .unwrap_or_else(|| error(StatusCode::NOT_FOUND)));
            }
        };
        let bytes = serde_json::to_vec(&reply).expect("application status serializes");
        let mut response = send_bytes(bytes, "application/json; charset=utf-8", head);
        if path == "/ready" && reply["ready"] != true {
            *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
        }
        Ok(response)
    }

    fn static_asset(
        &self,
        request: &Request<Incoming>,
        admission: &Admission,
    ) -> Option<Response<Body>> {
        let mut response = self.assets.select(request, false)?.response(None);
        if request.method() != Method::HEAD && self.socket.document(request.uri().path()) {
            let Ok(session) = self.access.sessions.open(request.headers(), admission) else {
                return Some(error(StatusCode::SERVICE_UNAVAILABLE));
            };
            if let Some(cookie) = session.cookie {
                standalone_access::private(response.headers_mut());
                response.headers_mut().append(header::SET_COOKIE, cookie);
            }
        }
        Some(response)
    }
}

fn send_bytes(bytes: Vec<u8>, media_type: &'static str, head: bool) -> Response<Body> {
    Response::builder()
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-robots-tag", "noindex, nofollow")
        .body(body(if head {
            Bytes::new()
        } else {
            Bytes::from(bytes)
        }))
        .expect("HTTP response")
}
