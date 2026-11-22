use std::sync::Arc;

use inpx_catalog::Result;
use inpx_catalog::isbn_store::IsbnBuild;
use serde_json::Value;

use super::State;

const UNAVAILABLE: &str = "Каталог недоступен. Перезапустите сервер.";
const CHANGED: &str = "Библиотека обновилась. Запустите подготовку ISBN заново";

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
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = run(&state, &generation, &mut build);
            state.index.isbn.finish(build, outcome);
        });
    }
    Ok(with_workers(state, state.index.isbn.status(&signature)))
}

fn run(state: &State, generation: &str, build: &mut IsbnBuild) -> Result<bool> {
    let sources = state.index.sources();
    let mut after = Some(build.last_id());
    let mut reader = build.reader(super::isbn_limit(&state.settings.snapshot()));
    while !build.cancelled() {
        let workers = state
            .settings
            .isbn_threads()
            .unwrap_or(8)
            .min(state.isbn_worker_capacity);
        let _permit = state
            .resources
            .acquire(super::resources::Kind::Background)?;
        if build.cancelled() {
            break;
        }
        let (rows, next) = {
            let lock = state.index.catalogue.read().expect("open catalogue");
            let catalogue = lock
                .as_ref()
                .filter(|catalogue| catalogue.generation == generation)
                .ok_or(CHANGED)?;
            catalogue.source_book_batch(after)?
        };
        build.record_batch(rows, &sources, &mut reader, |extra| {
            state.resources.spare_background(extra.min(workers - 1))
        })?;
        state.index.isbn.checkpoint(build)?;
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
