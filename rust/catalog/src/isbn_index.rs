use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Checkpoint, Progress, Row, Store};
use crate::Result;
use crate::book_archive::{IsbnMember, IsbnReader};
use crate::book_delivery::Book;
use crate::book_metadata::Format;
use crate::book_source::{Folder, member_name};
use crate::crypto_support::{hex, random};
use crate::library_sources::Source;
use crate::standalone_catalogue::Catalogue;

const READY: &str =
    "Индекс ISBN ещё не готов. Администратор может подготовить его в разделе «Задачи»";
const INVALID: &str = "Не удалось прочитать индекс ISBN. Запустите полную перестройку.";

pub struct IsbnIndex {
    file: PathBuf,
    shared: Mutex<Shared>,
    store: Mutex<Store>,
}

#[derive(Default)]
struct Shared {
    build: Option<Active>,
    error: String,
}

struct Active {
    progress: Progress,
    cancel: Arc<AtomicBool>,
    started: Instant,
    started_checked: u64,
}

pub struct IsbnBuild {
    progress: Progress,
    pending: Vec<Row>,
    cancel: Arc<AtomicBool>,
    checkpoint: Instant,
}

impl IsbnIndex {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            shared: Mutex::default(),
            store: Mutex::default(),
        }
    }

    pub fn status(&self, signature: &str) -> Value {
        let shared = self.shared.lock().expect("ISBN job");
        if let Some(job) = &shared.build {
            let mut current = status(
                "running",
                (job.progress.signature == signature).then_some(&job.progress),
                "",
            );
            if job.progress.signature == signature {
                let done = job.progress.checked.saturating_sub(job.started_checked);
                let left = job.progress.total.saturating_sub(job.progress.checked);
                if done > 0 && left > 0 {
                    current["remainingSeconds"] =
                        ((job.started.elapsed().as_secs_f64() * left as f64 / done as f64).ceil()
                            as u64)
                            .into();
                }
            }
            return current;
        }
        let saved = self.store.lock().expect("ISBN store").load(&self.file);
        let saved = match saved {
            Ok(saved) => saved.filter(|progress| progress.signature == signature),
            Err(error) => {
                eprintln!("ISBN index: {error}");
                return status("empty", None, INVALID);
            }
        };
        let label =
            saved.as_ref().map_or(
                "empty",
                |progress| if progress.complete { "ready" } else { "paused" },
            );
        status(label, saved.as_ref(), &shared.error)
    }

    pub fn start(&self, signature: String, total: u64, force: bool) -> Result<Option<IsbnBuild>> {
        let mut shared = self.shared.lock().expect("ISBN job");
        if shared.build.is_some() {
            return Err("Подготовка ISBN уже выполняется".into());
        }
        let mut store = self.store.lock().expect("ISBN store");
        let saved = if force {
            None
        } else {
            store
                .load(&self.file)
                .map_err(|error| {
                    eprintln!("ISBN index: {error}");
                    INVALID
                })?
                .filter(|progress| progress.signature == signature)
        };
        if saved.as_ref().is_some_and(|progress| progress.complete) {
            return Ok(None);
        }
        let progress = match saved {
            Some(progress) => Progress { total, ..progress },
            None => {
                let progress = Progress {
                    version: 1,
                    signature,
                    revision: hex(&random::<12>()?),
                    last_id: 0,
                    checked: 0,
                    total,
                    found: 0,
                    errors: 0,
                    skipped: 0,
                    complete: false,
                    updated_at: Some(millis()),
                };
                store.save(
                    &self.file,
                    Checkpoint {
                        progress: progress.clone(),
                        entries: Vec::new(),
                    },
                    true,
                )?;
                progress
            }
        };
        let cancel = Arc::new(AtomicBool::default());
        shared.build = Some(Active {
            started: Instant::now(),
            started_checked: progress.checked,
            progress: progress.clone(),
            cancel: cancel.clone(),
        });
        shared.error.clear();
        Ok(Some(IsbnBuild {
            progress,
            pending: Vec::new(),
            cancel,
            checkpoint: Instant::now(),
        }))
    }

    pub fn cancel(&self) {
        if let Some(build) = self.shared.lock().expect("ISBN job").build.as_ref() {
            build.cancel.store(true, Ordering::Release);
        }
    }

    pub fn checkpoint(&self, build: &mut IsbnBuild) -> Result<()> {
        let mut shared = self.shared.lock().expect("ISBN job");
        if build.pending.len() >= 4096 || build.checkpoint.elapsed() >= Duration::from_secs(30) {
            self.save(build)?;
        }
        if let Some(active) = shared.build.as_mut() {
            active.progress = build.progress.clone();
        }
        Ok(())
    }

    pub fn finish(&self, mut build: IsbnBuild, outcome: Result<bool>) {
        let mut shared = self.shared.lock().expect("ISBN job");
        let mut error = match outcome {
            Ok(completed) => {
                build.progress.complete = completed && !build.cancelled();
                if build.progress.complete {
                    String::new()
                } else {
                    "Подготовка ISBN отменена".into()
                }
            }
            Err(error) => error.to_string(),
        };
        if let Err(error_saving) = self.save(&mut build) {
            error = error_saving.to_string();
        }
        shared.error = error;
        shared.build = None;
    }

    fn save(&self, build: &mut IsbnBuild) -> Result<()> {
        build.progress.updated_at = Some(millis());
        let checkpoint = Checkpoint {
            progress: build.progress.clone(),
            entries: build.pending.clone(),
        };
        let mut store = self.store.lock().expect("ISBN store");
        store.save(&self.file, checkpoint, false)?;
        build.pending.clear();
        build.checkpoint = Instant::now();
        Ok(())
    }

    fn select(&self, signature: &str, value: &str) -> Result<HashSet<u32>> {
        let mut store = self.store.lock().expect("ISBN store");
        let progress = store
            .load(&self.file)?
            .filter(|progress| progress.complete && progress.signature == signature)
            .ok_or(READY)?;
        let response = store.select(&self.file, signature, &progress.revision, value)?;
        let ids = response["ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_u64().and_then(|id| id.try_into().ok()))
            .collect();
        Ok(ids)
    }
}

impl IsbnBuild {
    pub fn signature(&self) -> &str {
        &self.progress.signature
    }
    pub fn last_id(&self) -> u32 {
        self.progress.last_id
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    pub fn reader(&self, limit: u64) -> BookIsbnReader {
        BookIsbnReader {
            archive: IsbnReader::default(),
            limit,
        }
    }

    pub fn record_batch(
        &mut self,
        rows: Vec<Value>,
        sources: &[Source],
        reader: &mut BookIsbnReader,
    ) -> Result<()> {
        enum Outcome {
            Numbers(Vec<String>),
            Skipped,
            Unread,
        }
        let mut records = Vec::with_capacity(rows.len());
        let mut groups = HashMap::<(_, String), Vec<IsbnMember>>::new();
        for (row_index, row) in rows.into_iter().enumerate() {
            let id = row["id"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or("Некорректный идентификатор книги")?;
            let deleted = row["del"].as_i64().unwrap_or_default() != 0;
            let numbers = crate::isbn::extract(row["isbn"].as_str().unwrap_or_default());
            let ext = row["ext"].as_str().unwrap_or_default();
            let format = if ext.eq_ignore_ascii_case("fb2") {
                Some(Format::Fb2)
            } else if ext.eq_ignore_ascii_case("epub") {
                Some(Format::Epub)
            } else {
                None
            };
            let outcome = if !numbers.is_empty() {
                Outcome::Numbers(numbers)
            } else if let Some(format) = format.filter(|_| !deleted) {
                if let Ok(book) = serde_json::from_value::<Book>(row)
                    && let Some(source) = book.source(sources)
                    && let Ok(name) = member_name(&format!("{}.{}", book.file, book.ext))
                {
                    groups
                        .entry((&source.lib_dir, book.folder))
                        .or_default()
                        .push(IsbnMember {
                            row: row_index,
                            name,
                            format,
                        });
                }
                Outcome::Unread
            } else {
                Outcome::Skipped
            };
            records.push((id, deleted, outcome));
        }
        for ((library, folder), members) in groups {
            if self.cancelled() {
                return Ok(());
            }
            if let Ok(folder) = Folder::resolve(library, &folder) {
                let _ = reader.archive.read_group(
                    &folder,
                    &members,
                    reader.limit,
                    &|| self.cancelled(),
                    |row, numbers| {
                        records[row].2 = Outcome::Numbers(numbers);
                    },
                );
            }
        }
        // A checkpoint advances only over a complete page in catalogue ID order.
        if !self.cancelled() {
            for (id, deleted, outcome) in records {
                match outcome {
                    Outcome::Numbers(numbers) if !numbers.is_empty() => {
                        self.pending.push(Row(id, numbers, deleted));
                        self.progress.found += 1;
                    }
                    Outcome::Numbers(_) => {}
                    Outcome::Unread => self.progress.errors += 1,
                    Outcome::Skipped => self.progress.skipped += 1,
                }
                self.progress.checked += 1;
                self.progress.last_id = id;
            }
        }
        Ok(())
    }
}

pub struct BookIsbnReader {
    archive: IsbnReader,
    limit: u64,
}

impl Catalogue {
    pub fn attach_isbn_index(&mut self, index: Arc<IsbnIndex>) {
        self.isbn_index = Some(index);
    }

    pub fn isbn_signature(&self) -> Result<String> {
        Ok(hex(&Sha256::digest(serde_json::to_vec(&json!([
            ["indexUpdate", self.index_update],
            ["inpxHash", self.inpx_hash]
        ]))?)))
    }

    pub(crate) fn isbn_candidates(&self, value: &str) -> Result<HashSet<u32>> {
        let index = self.isbn_index.as_ref().ok_or(READY)?;
        index.select(&self.isbn_signature()?, value)
    }

    pub(crate) fn isbn_filter_ready(&self) -> bool {
        self.isbn_index
            .as_ref()
            .zip(self.isbn_signature().ok())
            .is_some_and(|(index, signature)| index.status(&signature)["state"] == "ready")
    }

    pub fn source_book_batch(&self, after: Option<u32>) -> Result<(Vec<Value>, Option<u32>)> {
        let crate::StoreResponse::Page { rows, after } =
            self.store.query(serde_json::from_value(json!({
                "op":"scan","generation":self.generation,"after":after,"limit":250,
                "fields":["id","_uid","title","folder","file","ext","sourceId","sourceLibDir","isbn","del"],
            }))?)?
        else {
            unreachable!("catalogue book scan")
        };
        let books = rows
            .iter()
            .map(|row| serde_json::from_str(row.get()))
            .collect::<std::result::Result<_, _>>()?;
        Ok((books, after))
    }
}

fn status(label: &str, progress: Option<&Progress>, error: &str) -> Value {
    let mut value = json!({"state":label,"checked":0,"total":0,"found":0,"errors":0,"skipped":0,"error":error,"remote":false});
    if let Some(progress) = progress {
        value["checked"] = progress.checked.into();
        value["total"] = progress.total.into();
        value["found"] = progress.found.into();
        value["errors"] = progress.errors.into();
        value["skipped"] = progress.skipped.into();
        value["updatedAt"] = progress.updated_at.into();
    }
    value
}

fn millis() -> u64 {
    crate::access_runtime::now_ms().max(0) as u64
}
