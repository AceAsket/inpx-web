use std::fmt::Write;
use std::net::IpAddr;

use crate::profile_sessions::Reply as ProfileReply;
use inpx_catalog::access_runtime::AccessReply;
use inpx_catalog::profile_login;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::{self, UnboundedSender};

pub(crate) enum Event {
    Listening {
        port: u16,
        library_access: bool,
        profile_sessions: bool,
    },
    Updated(u64),
    Delivered {
        id: u64,
        complete: bool,
    },
    WebSocketRejected {
        peer: IpAddr,
        reason: &'static str,
    },
    LibraryAccess {
        id: u64,
        result: Result<AccessReply, String>,
    },
    ProfileSession {
        id: u64,
        result: Result<ProfileReply, &'static str>,
        revision: u64,
    },
    ProfileLogin {
        id: u64,
        result: Result<profile_login::Decision, String>,
    },
}

pub(crate) fn start() -> UnboundedSender<Event> {
    let (events, mut receiver) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        let mut pending = Vec::with_capacity(32);
        let mut lines = String::new();
        while receiver.recv_many(&mut pending, 32).await != 0 {
            lines.clear();
            for event in pending.drain(..) {
                let _ = match event {
                    Event::Listening {
                        port,
                        library_access,
                        profile_sessions,
                    } => writeln!(
                        lines,
                        "{{\"port\":{port},\"libraryAccess\":{library_access},\"profileSessions\":{profile_sessions},\"profileLogin\":{}}}",
                        if profile_sessions { 2 } else { 0 }
                    ),
                    Event::Updated(id) => writeln!(lines, "{{\"updated\":{id}}}"),
                    Event::Delivered { id, complete } => {
                        writeln!(lines, "{{\"delivery\":{id},\"complete\":{complete}}}")
                    }
                    Event::WebSocketRejected { peer, reason } => {
                        writeln!(
                            lines,
                            "{{\"websocketRejected\":\"{reason}\",\"peer\":\"{peer}\"}}"
                        )
                    }
                    Event::LibraryAccess { id, result } => {
                        let result = serde_json::to_string(&result)
                            .expect("library access reply serializes");
                        writeln!(lines, "{{\"libraryReply\":{id},\"result\":{result}}}")
                    }
                    Event::ProfileSession {
                        id,
                        result,
                        revision,
                    } => {
                        let result = serde_json::to_string(&result)
                            .expect("profile session reply serializes");
                        writeln!(
                            lines,
                            "{{\"profileReply\":{id},\"result\":{result},\"revision\":{revision}}}"
                        )
                    }
                    Event::ProfileLogin { id, result } => {
                        let result =
                            serde_json::to_string(&result).expect("profile login reply serializes");
                        writeln!(lines, "{{\"profileLoginReply\":{id},\"result\":{result}}}")
                    }
                };
            }
            if stdout.write_all(lines.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    events
}
