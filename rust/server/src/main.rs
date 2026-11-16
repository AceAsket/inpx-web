mod assets;
mod download;
mod file_conditions;
mod http;
mod opds;
mod receipts;
mod report;
mod request_access;
mod upstream;
mod websocket;

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpListener;

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
    version: Option<String>,
    uptime: f64,
    header_bytes: usize,
    header_count: usize,
    header_timeout_ms: u64,
}

#[derive(Deserialize)]
struct RouteUpdate {
    id: u64,
    #[serde(flatten)]
    direct: http::DirectRoutes,
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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut control = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    (&mut control).take(64 * 1024).read_line(&mut line).await?;
    let config: Config = serde_json::from_str(&line)?;
    config.validate()?;
    let listener = TcpListener::bind((config.host.as_str(), config.port)).await?;
    let port = listener.local_addr()?.port();
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.upstream_port));
    let routes = Arc::new(http::Routes::new(
        config.direct,
        config.version,
        config.uptime,
        assets::Assets::load(config.assets),
        config.opds_path,
        config.files,
        config.websocket,
    ));
    let key: Arc<str> = config.key.into();
    let notices = report::start();
    notices.send(report::Event::Listening(port))?;
    let mut commands = control.lines();

    loop {
        tokio::select! {
            received = commands.next_line() => {
                let Some(line) = received? else { break };
                let update: RouteUpdate = serde_json::from_str(&line)?;
                routes.update(update.direct);
                notices.send(report::Event::Updated(update.id))?;
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
    Ok(())
}
