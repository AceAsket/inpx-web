use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::Result;
use inpx_catalog::isbn_store::IsbnBuild;
use serde_json::Value;

use super::State;

const UNAVAILABLE: &str = "Каталог недоступен. Перезапустите сервер.";
const CHANGED: &str = "Библиотека обновилась. Запустите подготовку ISBN заново";

struct Progress {
    stage: &'static str,
    since: Instant,
    source: String,
    archive: String,
    saved: u32,
}

impl Progress {
    fn enter(&mut self, stage: &'static str, source: &str, archive: &str) {
        self.stage = stage;
        self.since = Instant::now();
        self.source = source.chars().take(80).collect();
        self.archive = archive.chars().take(120).collect();
    }
}

pub(super) fn capacity(cpu: usize, memory: Option<u64>) -> usize {
    #[cfg(windows)]
    let memory = memory.or_else(|| {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // The Windows API writes into the initialized, correctly sized structure.
        (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
    });
    cpu.min(memory.map_or(4, |bytes| (bytes / (512 << 20)) as usize))
        .clamp(1, 32)
}

pub(super) fn thread_setting(value: &Value) -> Result<Option<usize>> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_u64() {
        Some(n @ (1 | 2 | 4 | 8 | 16 | 32)) => Ok(Some(n as usize)),
        _ => Err("Выберите автоматически или 1, 2, 4, 8, 16, 32 потока ISBN".into()),
    }
}

fn with_workers(state: &State, mut status: Value) -> Value {
    let configured = state.settings.isbn_threads();
    let limits = state.resources.policy().selected.limits;
    status["workers"] = configured.into();
    status["workerLimit"] = configured
        .unwrap_or(8)
        .min(state.isbn_worker_capacity)
        .min(limits.background)
        .min(limits.total)
        .into();
    status
}

pub(super) fn status(state: &State) -> Result<Value> {
    let signature = {
        let lock = state.index.catalogue.read().expect("open catalogue");
        lock.as_ref().ok_or(UNAVAILABLE)?.isbn_signature()?
    };
    Ok(with_workers(state, state.index.isbn.status(&signature)))
}

pub(super) fn start(state: &Arc<State>, force: bool) -> Result<Value> {
    let (generation, signature, total) = {
        let lock = state.index.catalogue.read().expect("open catalogue");
        let catalogue = lock.as_ref().ok_or(UNAVAILABLE)?;
        (
            catalogue.generation.clone(),
            catalogue.isbn_signature()?,
            catalogue.stats["bookCountAll"].as_u64().unwrap_or_default(),
        )
    };
    if let Some(mut build) = state.index.isbn.start(signature.clone(), total, force)? {
        let id = build.revision().to_owned();
        let started = Instant::now();
        let progress = Arc::new(Mutex::new(Progress {
            stage: "starting",
            since: started,
            source: String::new(),
            archive: String::new(),
            saved: build.last_id(),
        }));
        log::info!(target: "inpx::isbn", "job={id} phase=start total={total} checkpoint={} rebuild={force}", build.last_id());
        let state = state.clone();
        let worker_progress = progress.clone();
        let worker_id = id.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let outcome = run(&state, &generation, &mut build, &worker_progress);
            let processed = build.last_id();
            let (checked, found, unread, skipped) = build.counts();
            let result = state.index.isbn.finish(build, outcome);
            let (level, message) = match result {
                "ready" => (log::Level::Info, "Индекс ISBN готов"),
                "cancelled" => (log::Level::Info, "Подготовка ISBN отменена"),
                _ => (log::Level::Error, "Подготовка ISBN завершилась ошибкой"),
            };
            log::log!(target: "inpx::isbn", level,
                "job={worker_id} phase={result} processed_id={processed} checked={checked} found={found} unread={unread} skipped={skipped} elapsed_ms={}",
                started.elapsed().as_millis());
            state.diagnostics.log(
                &state,
                if level == log::Level::Error {
                    "error"
                } else {
                    "info"
                },
                "index",
                message,
            );
        });
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = &mut worker => {
                        if result.is_err() {
                            log::error!(target: "inpx::isbn", "job={id} phase=worker-failed");
                        }
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(30)) => {
                        let progress = progress.lock().expect("ISBN diagnostics");
                        let elapsed = progress.since.elapsed().as_secs();
                        if elapsed >= 30 {
                            log::warn!(target: "inpx::isbn", "job={id} phase={} waiting_s={elapsed} checkpoint={} source={:?} archive={:?}",
                                progress.stage, progress.saved, progress.source, progress.archive);
                        }
                    }
                }
            }
        });
    }
    Ok(with_workers(state, state.index.isbn.status(&signature)))
}

fn run(
    state: &State,
    generation: &str,
    build: &mut IsbnBuild,
    progress: &Mutex<Progress>,
) -> Result<bool> {
    let sources = state.index.sources();
    let mut after = Some(build.last_id());
    let mut reader = build.reader(super::isbn_limit(&state.settings.snapshot()));
    while !build.cancelled() {
        let enter = |stage, source: &str, archive: &str| {
            progress
                .lock()
                .expect("ISBN diagnostics")
                .enter(stage, source, archive);
        };
        let workers = state
            .settings
            .isbn_threads()
            .unwrap_or(8)
            .min(state.isbn_worker_capacity);
        enter("queue", "", "");
        let _permit = state
            .resources
            .acquire(super::resources::Kind::Background)?;
        if build.cancelled() {
            break;
        }
        enter("catalogue", "", "");
        let (rows, next) = {
            let lock = state.index.catalogue.read().expect("open catalogue");
            let catalogue = lock
                .as_ref()
                .filter(|catalogue| catalogue.generation == generation)
                .ok_or(CHANGED)?;
            catalogue.source_book_batch(after)?
        };
        build.record_batch(
            rows,
            &sources,
            &mut reader,
            |extra| state.resources.spare_background(extra.min(workers - 1)),
            |source, archive| enter("reading", source, archive),
        )?;
        enter("checkpoint", "", "");
        if state.index.isbn.checkpoint(build)? {
            progress.lock().expect("ISBN diagnostics").saved = build.last_id();
            log::debug!(target: "inpx::isbn", "job={} phase=checkpoint saved_id={}", build.revision(), build.last_id());
        }
        if next.is_none() {
            let lock = state.index.catalogue.read().expect("open catalogue");
            let current = lock
                .as_ref()
                .filter(|catalogue| catalogue.generation == generation)
                .ok_or(CHANGED)?;
            if current.isbn_signature()? != build.signature() {
                return Err(CHANGED.into());
            }
            return Ok(true);
        }
        after = next;
    }
    Ok(false)
}
