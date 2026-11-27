mod assets;
mod download;
mod file_conditions;
mod http;
mod library_access;
mod native_jxl;
mod opds;
mod profile_sessions;
mod receipts;
mod report;
mod request_access;
mod standalone;
mod standalone_access;
mod standalone_browser;
mod standalone_download;
mod standalone_library;
mod upstream;
mod websocket;

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use inpx_catalog::access_runtime::AccessCommand;
use inpx_catalog::profile_login;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    host: String,
    port: u16,
    upstream_port: u16,
    key: String,
    #[serde(flatten)]
    direct: http::DirectRoutes,
    assets: Option<assets::Config>,
    opds_path: Option<String>,
    files: Option<download::Config>,
    websocket: Option<websocket::Config>,
    library_access: Option<library_access::Settings>,
    profile_sessions: Option<bool>,
    version: Option<String>,
    uptime: f64,
    header_bytes: usize,
    header_count: usize,
    header_timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Control {
    id: u64,
    library_access: Option<AccessCommand>,
    profile_session: Option<profile_sessions::Command>,
    profile_login: Option<profile_login::Request>,
    #[serde(flatten)]
    direct: Option<http::DirectRoutes>,
}

impl Config {
    fn validate(&self) -> std::io::Result<()> {
        if self.upstream_port == 0
            || self.key.len() != 64
            || self.header_count == 0
            || !self
                .key
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid private transport configuration",
            ));
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let [flag, input, output, limit] = args.as_slice()
        && flag == inpx_catalog::legacy_library_files::NATIVE_JXL_WORKER
    {
        let limit = limit
            .to_str()
            .ok_or("invalid JPEG XL output limit")?
            .parse()?;
        return native_jxl::worker(input.as_ref(), output.as_ref(), limit);
    }
    if let [flag, options @ ..] = args.as_slice()
        && flag == "--standalone"
    {
        return standalone::run(options).await;
    }
    if std::env::current_exe()?
        .file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("inpx-web"))
    {
        return standalone::run(&args).await;
    }
    bridge().await
}

async fn bridge() -> Result<(), Box<dyn std::error::Error>> {
    let mut control = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    (&mut control).take(64 * 1024).read_line(&mut line).await?;
    let config: Config = serde_json::from_str(&line)?;
    line.into_bytes().fill(0);
    config.validate()?;
    let notices = report::start();
    let profiles: Option<profile_sessions::Shared> =
        config.profile_sessions.unwrap_or(false).then(Arc::default);
    let profile_logins = Arc::new(Semaphore::new(4));
    let library = config
        .library_access
        .map(|settings| library_access::Worker::start(settings, notices.clone()))
        .transpose()?;
    let listener = TcpListener::bind((config.host.as_str(), config.port)).await?;
    let port = listener.local_addr()?.port();
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.upstream_port));
    let websocket = config.websocket.map(|settings| {
        websocket::Endpoint::new(
            settings,
            config.direct.websocket_requests,
            library.as_ref().and_then(library_access::Worker::sessions),
            profiles.clone(),
        )
    });
    let routes = Arc::new(http::Routes::new(
        config.direct,
        config.version,
        config.uptime,
        assets::Assets::load(config.assets),
        config.opds_path,
        config.files,
        websocket,
    ));
    let key: Arc<str> = config.key.into();
    notices.send(report::Event::Listening {
        port,
        library_access: library.is_some(),
        profile_sessions: profiles.is_some(),
    })?;
    let mut commands = control.lines();

    loop {
        tokio::select! {
            received = commands.next_line() => {
                let Some(line) = received? else { break };
                let command = serde_json::from_str(&line);
                line.into_bytes().fill(0);
                let command: Control = command?;
                if let Some(request) = command.profile_login {
                    profile_sessions::authenticate(command.id, request, profiles.as_ref(), &profile_logins, &notices)?;
                } else if let Some(request) = command.profile_session {
                    let (result, revision) = match profiles.as_ref() {
                        Some(state) => {
                            let mut state = state.lock().expect("profile sessions");
                            (state.handle(request), state.revision())
                        }
                        None => (Err("Хранилище сеансов профилей недоступно"), 0),
                    };
                    notices.send(report::Event::ProfileSession {id:command.id,result,revision})?;
                } else if let Some(request) = command.library_access {
                    let queued=library.as_ref().ok_or("Хранилище сеансов доступа недоступно")
                        .and_then(|worker|worker.submit(command.id,request));
                    if let Err(error) = queued {
                        notices.send(report::Event::LibraryAccess {id:command.id,result:Err(error.into())})?;
                    }
                } else if let Some(direct) = command.direct {
                    routes.update(direct);
                    notices.send(report::Event::Updated(command.id))?;
                } else {
                    return Err("invalid private transport command".into());
                }
            }
            received = listener.accept() => {
                let (stream, peer) = match received {
                    Ok(connection) => connection,
                    Err(error) => {
                        eprintln!("HTTP accept failed: {error}");
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                };
                let upstream = Arc::new(upstream::Upstream::new(address, peer, Arc::clone(&key)));
                let receipts=receipts::Receipts::new(notices.clone());
                let routes = routes.clone();
                let header_timeout = (config.header_timeout_ms != 0)
                    .then(|| Duration::from_millis(config.header_timeout_ms));
                let header_bytes = config.header_bytes.max(8192);
                let header_count = config.header_count;
                tokio::spawn(async move {
                    let _ = stream.set_nodelay(true);
                    let service = service_fn(|request| routes.serve(request, &upstream,&receipts));
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(header_timeout)
                        .max_buf_size(header_bytes)
                        .max_headers(header_count)
                        .serve_connection(TokioIo::new(receipts::PublicStream::new(stream,receipts.clone())),service)
                        .with_upgrades()
                        .await;
                });
            }
        }
    }
    if let Some(library) = library {
        library.stop()?;
    }
    Ok(())
}
