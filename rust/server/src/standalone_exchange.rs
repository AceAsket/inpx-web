use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::Result;
use inpx_catalog::book_delivery::Book;
use inpx_catalog::library_media::{InpxExchange, LibraryMedia, Rating, RatingIndex, author_info};
use inpx_catalog::library_sources::{Kind, Source};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::State;
use crate::standalone_download::load_book;

const UNAVAILABLE: &str = "Каталог недоступен. Перезапустите сервер.";

pub(super) struct Exchange {
    files: Mutex<Option<(PathBuf, Arc<InpxExchange>)>>,
    remote_enabled: bool,
    media: LibraryMedia,
    building: Mutex<()>,
    ratings: Mutex<RatingState>,
}

#[derive(Default)]
struct RatingState {
    index: Option<Arc<RatingIndex>>,
    generation: String,
    running: bool,
    started: Option<Instant>,
    last_checked: Option<Instant>,
    error: String,
    done: u64,
    total: Option<u64>,
}

impl Exchange {
    pub(super) fn new(config: &Value) -> Self {
        let remote_enabled = config["allowRemoteLib"] == true;
        Self {
            files: Mutex::default(),
            remote_enabled,
            media: LibraryMedia::default(),
            building: Mutex::default(),
            ratings: Mutex::default(),
        }
    }

    pub(super) fn inpx(&self, previous: &str, sources: &[Source]) -> Result<Value> {
        if !self.remote_enabled {
            return Err("Remote lib access disabled".into());
        }
        let path = &sources
            .iter()
            .find(|source| source.kind != Some(Kind::Folder))
            .ok_or("Файл INPX не найден")?
            .inpx_file;
        let exchange = {
            let mut files = self.files.lock().expect("INPX exchange");
            if files.as_ref().is_none_or(|(current, _)| current != path) {
                *files = Some((path.clone(), Arc::new(InpxExchange::new(path.clone()))));
            }
            files.as_ref().expect("INPX exchange").1.clone()
        };
        exchange.data(previous)
    }

    fn rating(&self, book: &Book, sources: &[Source]) -> Result<Option<Rating>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        Ok(self
            .media
            .ratings(&source.lib_dir)?
            .get(&book.folder, &book.file, &book.ext))
    }

    pub(super) fn author(&self, state: &State, name: &str, id: Option<u32>) -> Result<Value> {
        let mut name = name.trim().to_owned();
        if name.is_empty()
            && let Some(id) = id
        {
            let catalogue = state.index.catalogue.read().expect("open catalogue");
            name = catalogue
                .as_ref()
                .ok_or(UNAVAILABLE)?
                .browser_author_name(id)?
                .unwrap_or_default();
        }
        Ok(json!({"authorInfo":author_info(&name,&state.index.sources())?}))
    }

    pub(super) fn reviews(&self, state: &State, uid: &str) -> Result<Value> {
        if uid.is_empty() {
            return Err("bookUid is empty".into());
        }
        let book = load_book(&state.index.catalogue, uid)?.ok_or("404 Файл не найден")?;
        let reviews = book
            .source(&state.index.sources())
            .map(|source| self.media.reviews(&book, &source.lib_dir))
            .transpose()?
            .unwrap_or_default();
        let library_rating = self.rating(&book, &state.index.sources())?;
        Ok(json!({"reviews":reviews,"libraryRating":library_rating}))
    }

    pub(super) fn metadata(&self, state: &State, request: &Value) -> Result<Value> {
        let cursor = match request.get("cursor") {
            None | Some(Value::Null | Value::Bool(false)) => Some(0.0),
            Some(Value::Bool(true)) => Some(1.0),
            Some(Value::String(value)) => {
                if value.trim().is_empty() {
                    Some(0.0)
                } else {
                    value.trim().parse().ok()
                }
            }
            Some(value) => value.as_f64(),
        }
        .filter(|value| (0.0..=10_000_000.0).contains(value) && value.fract() == 0.0)
        .ok_or("Некорректная позиция обмена")? as usize;
        let kind = text(request, "kind");
        if kind == "ratings" {
            let index = self.rating_index(state)?;
            let given = text(request, "revision");
            if !given.is_empty() && given != index.revision {
                return Err("Индекс оценок обновился. Повторите синхронизацию".into());
            }
            let items: Vec<_> = index
                .entries
                .iter()
                .skip(cursor)
                .take(1000)
                .filter(|row| !row.uid.is_empty())
                .map(|row| json!([row.uid, row.count]))
                .collect();
            return Ok(
                json!({"revision":index.revision,"items":items,"next":(cursor + 1000 < index.entries.len()).then_some(cursor + 1000)}),
            );
        }
        if kind == "author" {
            let name = text(request, "author").trim();
            if name.is_empty() || name.encode_utf16().count() > 300 {
                return Err("Некорректное имя автора".into());
            }
            let result = self.author(state, name, None)?;
            let info = &result["authorInfo"];
            return Ok(json!({"authorInfo":info.as_object().map(|_| json!({
                "html":clip(text(info,"html"),128_000),"text":clip(text(info,"text"),128_000),
            }))}));
        }
        let book = load_book(&state.index.catalogue, text(request, "bookUid"))?
            .ok_or("Книга не найдена")?;
        match kind {
            "rating" => Ok(json!({"rating":self.rating(&book,&state.index.sources())?})),
            "reviews" => {
                let reviews = book
                    .source(&state.index.sources())
                    .map(|source| self.media.reviews(&book, &source.lib_dir))
                    .transpose()?
                    .unwrap_or_default();
                let items: Vec<_> = reviews.iter().skip(cursor).take(10).map(|review| json!({
                    "name":clip(text(review,"name"),300),"time":clip(text(review,"time"),100),"text":clip(text(review,"text"),16000),
                })).collect();
                Ok(
                    json!({"items":items,"next":(cursor + 10 < reviews.len()).then_some(cursor + 10)}),
                )
            }
            _ => Err("Неизвестный вид метаданных".into()),
        }
    }

    pub(super) fn rating_status(state: &Arc<State>) -> Value {
        let generation = state
            .index
            .catalogue
            .read()
            .expect("open catalogue")
            .as_ref()
            .map(|catalogue| catalogue.generation.clone())
            .unwrap_or_default();
        let mut tracker = state.exchange.ratings.lock().expect("rating status");
        let available = tracker.index.is_some() && tracker.generation == generation;
        if !tracker.running
            && tracker
                .last_checked
                .is_none_or(|when| when.elapsed() >= Duration::from_secs(1))
        {
            tracker.running = true;
            tracker.error.clear();
            let state = state.clone();
            tokio::task::spawn_blocking(move || {
                let _ = state.exchange.rating_index(&state);
            });
        }
        let label = if tracker.running && !available {
            "running"
        } else if tracker.error.is_empty() {
            "ready"
        } else {
            "error"
        };
        let phase = if label == "running" {
            if tracker.total.is_none() {
                "Чтение метаданных"
            } else {
                "Обработка книг"
            }
        } else {
            ""
        };
        json!({"state":label,"error":tracker.error,"phase":phase,"done":tracker.done,"total":tracker.total})
    }

    fn rating_index(&self, state: &State) -> Result<Arc<RatingIndex>> {
        let _build = self
            .building
            .lock()
            .map_err(|_| "Индекс оценок недоступен")?;
        {
            let mut task = self.ratings.lock().expect("rating status");
            task.running = true;
            task.started = Some(Instant::now());
            task.done = 0;
            task.total = None;
            task.error.clear();
        }
        let outcome = self.load_rating_index(state);
        let mut task = self.ratings.lock().expect("rating status");
        task.error = outcome
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        task.running = false;
        task.last_checked = Some(Instant::now());
        outcome
    }

    fn load_rating_index(&self, state: &State) -> Result<Arc<RatingIndex>> {
        let active = state.index.sources();
        let sources: HashMap<_, _> = active
            .iter()
            .map(|source| {
                Ok::<_, Box<dyn std::error::Error>>((
                    source.id.as_str(),
                    self.media.ratings(&source.lib_dir)?,
                ))
            })
            .collect::<Result<_>>()?;
        let catalogue = state.index.catalogue.read().expect("open catalogue");
        let catalogue = catalogue.as_ref().ok_or(UNAVAILABLE)?;
        let mut hash = Sha256::new();
        hash.update(catalogue.generation.as_bytes());
        for source in active.iter() {
            hash.update(serde_json::to_vec(&(
                source.id.as_str(),
                sources[source.id.as_str()].revision().collect::<Vec<_>>(),
            ))?);
        }
        let revision = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        {
            let mut tracker = self.ratings.lock().expect("rating status");
            if let Some(index) = tracker
                .index
                .as_ref()
                .filter(|index| index.revision == revision)
            {
                catalogue.publish_rating_filter(index.clone());
                return Ok(index.clone());
            }
            tracker.done = 0;
            tracker.total = catalogue.stats["bookCountAll"].as_u64();
        }
        let index = Arc::new(catalogue.build_rating_index(&sources, revision, |done| {
            self.ratings.lock().expect("rating status").done = done;
        })?);
        catalogue.publish_rating_filter(index.clone());
        let mut tracker = self.ratings.lock().expect("rating status");
        tracker.index = Some(index.clone());
        tracker.generation = catalogue.generation.clone();
        tracker.error.clear();
        Ok(index)
    }

    pub(super) fn prepare_rating_filter(&self, state: &State) -> Result<()> {
        self.rating_index(state).map(|_| ())
    }

    pub(super) fn rating_task(&self) -> Option<Value> {
        let tracker = self.ratings.lock().expect("rating status");
        let remaining = tracker
            .started
            .zip(tracker.total)
            .filter(|(_, total)| tracker.done > 0 && *total > tracker.done)
            .map(|(start, total)| {
                (start.elapsed().as_secs_f64() * (total - tracker.done) as f64
                    / tracker.done as f64)
                    .ceil() as u64
            });
        tracker.running.then(|| json!({"id":"ratings","kind":"ratings","title":"Индекс числа голосов",
            "state":"running","phase":if tracker.total.is_none() {"Чтение метаданных"} else {"Обработка книг"},
            "done":tracker.done,"total":tracker.total,"progress":super::tasks::fraction(tracker.done,tracker.total),
            "remainingSeconds":remaining}))
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn clip(value: &str, mut remaining: usize) -> &str {
    let end = value
        .char_indices()
        .find(|(_, char)| {
            let Some(left) = remaining.checked_sub(char.len_utf16()) else {
                return true;
            };
            remaining = left;
            false
        })
        .map_or(value.len(), |(offset, _)| offset);
    &value[..end]
}
