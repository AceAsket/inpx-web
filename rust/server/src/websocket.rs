mod bridge;
mod requests;

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Version};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::protocol::{
    CloseFrame, Role, WebSocketConfig, frame::coding::CloseCode,
};
use tokio_tungstenite::tungstenite::{Error, Message, handshake::derive_accept_key};

use crate::http::{Body, body, error, forward, strip_hop_headers};
use crate::receipts::Receipts;
use crate::request_access::{APPROVAL, Decision, Denial};
use crate::upstream::Upstream;
use inpx_catalog::access_runtime::AccessSessions;

pub(crate) use requests::Limits as RequestLimits;

const PRIVATE_UPGRADE: HeaderValue = HeaderValue::from_static("inpx-websocket");
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    max_payload: usize,
    #[serde(default)]
    text_only: bool,
}

#[derive(Clone)]
pub(crate) struct Endpoint {
    config: Config,
    requests: Option<Arc<requests::Gate>>,
    library: Option<AccessSessions>,
    profiles: Option<crate::profile_sessions::Shared>,
}

impl Endpoint {
    pub(crate) fn new(
        config: Config,
        limits: Option<RequestLimits>,
        library: Option<AccessSessions>,
        profiles: Option<crate::profile_sessions::Shared>,
    ) -> Self {
        Self {
            config,
            requests: limits.map(|limits| Arc::new(requests::Gate::new(limits))),
            library,
            profiles,
        }
    }

    pub(crate) fn configure(&self, limits: Option<RequestLimits>) {
        if let (Some(gate), Some(limits)) = (&self.requests, limits) {
            gate.configure(limits);
        }
    }
}

pub(crate) fn public_reply(request: &Request<Incoming>) -> Response<Body> {
    if request.method() != Method::GET {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    if request.version() != Version::HTTP_11 {
        return error(StatusCode::BAD_REQUEST);
    }
    let headers = request.headers();
    let mut keys = headers.get_all(header::SEC_WEBSOCKET_KEY).iter();
    let Some(key) = keys.next().map(HeaderValue::as_bytes) else {
        return error(StatusCode::BAD_REQUEST);
    };
    if key.len() != 24
        || &key[22..] != b"=="
        || keys.next().is_some()
        || !key[..22]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return error(StatusCode::BAD_REQUEST);
    }
    let mut versions = headers.get_all(header::SEC_WEBSOCKET_VERSION).iter();
    if !versions
        .next()
        .is_some_and(|version| matches!(version.as_bytes(), b"8" | b"13"))
        || versions.next().is_some()
    {
        let mut response = error(StatusCode::BAD_REQUEST);
        response.headers_mut().insert(
            header::SEC_WEBSOCKET_VERSION,
            HeaderValue::from_static("13, 8"),
        );
        return response;
    }
    let mut protocols = HashSet::new();
    let mut first = None;
    for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
        let Ok(value) = value.to_str() else {
            return error(StatusCode::BAD_REQUEST);
        };
        for token in value.split(',').map(str::trim) {
            if HeaderName::from_bytes(token.as_bytes()).is_err() || !protocols.insert(token) {
                return error(StatusCode::BAD_REQUEST);
            }
            first.get_or_insert(token);
        }
    }
    let mut response = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, derive_accept_key(key));
    if let Some(protocol) = first {
        response = response.header(header::SEC_WEBSOCKET_PROTOCOL, protocol);
    }
    response
        .body(body(Bytes::new()))
        .expect("valid public WebSocket upgrade")
}

pub(crate) async fn upgrade(
    mut request: Request<Incoming>,
    upstream: &Arc<Upstream>,
    endpoint: Endpoint,
    access: Decision,
    receipts: &Receipts,
) -> Response<Body> {
    let reply = public_reply(&request);
    if reply.status() != StatusCode::SWITCHING_PROTOCOLS {
        return reply;
    }
    match access {
        Decision::Deny { reason, .. } => {
            receipts.websocket_rejected(upstream.client_ip(), reason.diagnostic());
            return Denial::websocket();
        }
        Decision::Allow { proof, .. } => {
            request.headers_mut().insert(APPROVAL, proof);
        }
        Decision::Forward => (),
    }
    let client = hyper::upgrade::on(&mut request);
    request
        .headers_mut()
        .insert(header::UPGRADE, PRIVATE_UPGRADE);
    let Ok(mut response) = upstream.send(request).await else {
        return error(StatusCode::BAD_GATEWAY);
    };
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        strip_hop_headers(response.headers_mut(), false);
        return forward(response);
    }
    if response.headers().get(header::UPGRADE) != Some(&PRIVATE_UPGRADE) {
        return error(StatusCode::BAD_GATEWAY);
    }
    let private = hyper::upgrade::on(&mut response);
    tokio::spawn(async move {
        if let Ok((client, private)) = tokio::try_join!(client, private) {
            relay(TokioIo::new(client), TokioIo::new(private), endpoint).await;
        }
    });
    reply
}

enum End {
    Disconnected,
    BackendGone,
    PeerClose,
    Close(Option<CloseFrame>),
}

impl End {
    fn close(code: CloseCode, reason: &'static str) -> Self {
        Self::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))
    }
}

async fn relay(
    client: impl AsyncRead + AsyncWrite + Unpin,
    private: impl AsyncRead + AsyncWrite + Unpin,
    endpoint: Endpoint,
) {
    let Endpoint {
        config,
        requests,
        library,
        profiles,
    } = endpoint;
    let options = WebSocketConfig::default()
        .max_message_size(Some(config.max_payload))
        .max_frame_size(Some(config.max_payload))
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0);
    let websocket = WebSocketStream::from_raw_socket(client, Role::Server, Some(options)).await;
    let (mut to_client, mut from_client) = websocket.split();
    let (private_read, private_write) = tokio::io::split(private);
    let mut private_read = bridge::Reader::new(private_read);
    let mut private_write = bridge::Writer::new(private_write);
    let session = Mutex::new(requests::Session::default());
    let end = tokio::select! {
        end = async {
            loop {
                let (kind, bytes) = match from_client.next().await {
                    Some(Ok(Message::Text(text))) => (bridge::TEXT,text.into()),
                    Some(Ok(Message::Binary(_))) if config.text_only => return End::close(CloseCode::Unsupported,"Text JSON required"),
                    Some(Ok(Message::Binary(bytes))) => (bridge::BINARY,bytes),
                    Some(Ok(Message::Close(_))) => return End::PeerClose,
                    Some(Ok(_)) => continue,
                    Some(Err(Error::Capacity(_))) => return End::close(CloseCode::Size,""),
                    Some(Err(Error::Utf8(_))) => return End::close(CloseCode::Invalid,""),
                    Some(Err(Error::Protocol(ProtocolError::ResetWithoutClosingHandshake))) => return End::Disconnected,
                    Some(Err(Error::Protocol(_))) => return End::close(CloseCode::Protocol,""),
                    _ => return End::Disconnected,
                };
                let written = if let Some(gate) = requests.as_ref().filter(|_| kind == bridge::TEXT) {
                    let Some((ticket, limits)) = gate.reserve(&session, bytes.len()) else {
                        return End::close(CloseCode::Again,"Too many active requests");
                    };
                    let (validation, checked) = limits.check(&bytes);
                    let (validation, profile) = requests::access_metadata(validation, &checked, library.as_ref(), profiles.as_ref());
                    let payload = match checked { Cow::Borrowed(_) => bytes, Cow::Owned(rejected) => rejected.into() };
                    private_write.request(ticket,validation,payload,profile).await
                } else {
                    private_write.send(kind,&[],bytes).await
                };
                if written.is_err() {
                    return End::BackendGone;
                }
            }
        } => end,
        end = async {
            loop {
                match private_read.read_packet().await {
                    Ok(Some(bridge::Packet::Message(Message::Close(close)))) => return End::Close(close),
                    Ok(Some(bridge::Packet::Message(message))) => {
                        if to_client.send(message).await.is_err() { return End::Disconnected; }
                    }
                    Ok(Some(bridge::Packet::Complete(ticket))) => {
                        if !session.lock().expect("request session").finish(ticket) {
                            return End::BackendGone;
                        }
                    }
                    Ok(Some(bridge::Packet::Terminate)) => return End::Disconnected,
                    _ => return End::BackendGone,
                }
            }
        } => end,
    };
    let backend_alive = !matches!(end, End::BackendGone);
    let close_public = async move {
        let _ = timeout(CLOSE_TIMEOUT, async {
            match end {
                End::Disconnected | End::BackendGone => (),
                End::PeerClose => {
                    let _ = to_client.flush().await;
                }
                End::Close(frame) => {
                    if to_client.send(Message::Close(frame)).await.is_ok() {
                        while let Some(Ok(message)) = from_client.next().await {
                            if message.is_close() {
                                break;
                            }
                        }
                    }
                }
            }
        })
        .await;
    };
    // Work already handed to the application keeps its admission slot after disconnect.
    let drain_backend = async move {
        let mut session = session.into_inner().expect("request session");
        if !backend_alive || session.is_idle() {
            return;
        }
        if private_write.flush().await.is_err()
            || private_write
                .send(bridge::PEER_CLOSED, &[], Bytes::new())
                .await
                .is_err()
        {
            return;
        }
        while !session.is_idle() {
            match private_read.read_packet().await {
                Ok(Some(bridge::Packet::Complete(ticket))) => {
                    session.finish(ticket);
                }
                Ok(Some(_)) => (),
                _ => break,
            }
        }
    };
    tokio::join!(close_public, drain_backend);
}
