use std::sync::Arc;

use inpx_catalog::Result;
use inpx_catalog::isbn_store::IsbnBuild;
use serde_json::Value;

use super::State;

const UNAVAILABLE: &str = "Каталог недоступен. Перезапустите сервер.";
const CHANGED: &str = "Библиотека обновилась. Запустите подготовку ISBN заново";

pub(super) fn status(state: &State) -> Result<Value> {
    let signature = {
        let lock = state.index.catalogue.read().expect("open catalogue");
        lock.as_ref().ok_or(UNAVAILABLE)?.isbn_signature()?
    };
    Ok(state.index.isbn.status(&signature))
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
    Ok(state.index.isbn.status(&signature))
}

fn run(state: &State, generation: &str, build: &mut IsbnBuild) -> Result<bool> {
    let sources = state.index.sources();
    let mut after = Some(build.last_id());
    let mut reader = build.reader(state.isbn_limit);
    while !build.cancelled() {
        let (rows, next) = {
            let lock = state.index.catalogue.read().expect("open catalogue");
            let catalogue = lock
                .as_ref()
                .filter(|catalogue| catalogue.generation == generation)
                .ok_or(CHANGED)?;
            catalogue.source_book_batch(after)?
        };
        build.record_batch(rows, &sources, &mut reader)?;
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
