use std::io;
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use inpx_catalog::access_runtime::{AccessCommand, AccessRuntime, AccessSessions, now_ms};
use serde::Deserialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::report::Event;

const FLUSH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    file: PathBuf,
    password: String,
    timeout_ms: Option<i64>,
}

pub(crate) struct Worker {
    queue: SyncSender<Work>,
    complete: JoinHandle<()>,
    sessions: Option<AccessSessions>,
}

enum Work {
    Request(u64, AccessCommand),
    Stop,
}

impl Worker {
    pub(crate) fn start(
        settings: Settings,
        notices: UnboundedSender<Event>,
    ) -> inpx_catalog::Result<Self> {
        let mut password = settings.password.into_bytes();
        let protected = !password.is_empty();
        let opened = AccessRuntime::open(&settings.file, &password, settings.timeout_ms);
        password.fill(0);
        let Some(runtime) = opened? else {
            return Err("Нужно восстановить прежнее хранилище сеансов доступа".into());
        };
        let sessions = protected.then(|| runtime.sessions());
        let (queue, receiver) = mpsc::sync_channel(128);
        let complete = thread::Builder::new()
            .name("library-access".into())
            .spawn(move || run(runtime, receiver, notices))?;
        Ok(Self {
            queue,
            complete,
            sessions,
        })
    }

    pub(crate) fn sessions(&self) -> Option<AccessSessions> {
        self.sessions.clone()
    }

    pub(crate) fn submit(&self, id: u64, request: AccessCommand) -> Result<(), &'static str> {
        self.queue
            .try_send(Work::Request(id, request))
            .map_err(|error| match error {
                TrySendError::Full(_) => "Очередь запросов WebAccess заполнена",
                TrySendError::Disconnected(_) => "Хранилище сеансов доступа недоступно",
            })
    }

    pub(crate) fn stop(self) -> io::Result<()> {
        let _ = self.queue.send(Work::Stop);
        self.complete
            .join()
            .map_err(|_| io::Error::other("Library access worker panicked"))
    }
}

fn run(mut runtime: AccessRuntime, work: mpsc::Receiver<Work>, notices: UnboundedSender<Event>) {
    let mut flush_at = Instant::now() + FLUSH_INTERVAL;
    loop {
        let now = Instant::now();
        if now >= flush_at {
            flush(&mut runtime);
            flush_at = now + FLUSH_INTERVAL;
        }
        match work.recv_timeout(flush_at.saturating_duration_since(now)) {
            Ok(Work::Request(id, request)) => {
                let result = runtime
                    .run(request, now_ms())
                    .map_err(|error| error.to_string());
                if notices.send(Event::LibraryAccess { id, result }).is_err() {
                    break;
                }
            }
            Ok(Work::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
    }
    flush(&mut runtime);
}

fn flush(runtime: &mut AccessRuntime) {
    if let Err(error) = runtime.flush(now_ms()) {
        eprintln!("WebAccess flush: {error}");
    }
}
