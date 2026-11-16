use std::fmt::Write;

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::{self, UnboundedSender};

pub(crate) enum Event {
    Listening(u16),
    Updated(u64),
    Delivered { id: u64, complete: bool },
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
                    Event::Listening(port) => writeln!(lines, "{{\"port\":{port}}}"),
                    Event::Updated(id) => writeln!(lines, "{{\"updated\":{id}}}"),
                    Event::Delivered { id, complete } => {
                        writeln!(lines, "{{\"delivery\":{id},\"complete\":{complete}}}")
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
