use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition, WriteTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Result;
use crate::framed_protocol::{Frames, complete, header, with_body};
use crate::isbn;

#[path = "isbn_index.rs"]
mod native;
pub use native::{IsbnBuild, IsbnIndex};

const STATE: TableDefinition<u8, &[u8]> = TableDefinition::new("progress");
const MATCHES: TableDefinition<(&str, u32), bool> = TableDefinition::new("isbn_books");
const BODY_LIMIT: u64 = 32 * 1024 * 1024;
const LEGACY_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    version: u8,
    signature: String,
    revision: String,
    #[serde(default)]
    last_id: u32,
    #[serde(default)]
    checked: u64,
    #[serde(default)]
    total: u64,
    #[serde(default)]
    found: u64,
    #[serde(default)]
    errors: u64,
    #[serde(default)]
    skipped: u64,
    #[serde(default)]
    complete: bool,
    updated_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
struct Row(u32, Vec<String>, #[serde(default)] bool);

#[derive(Deserialize)]
struct Checkpoint {
    #[serde(flatten)]
    progress: Progress,
    entries: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Load {
        file: PathBuf,
    },
    Save {
        file: PathBuf,
        bytes: u64,
        reset: bool,
    },
    Select {
        file: PathBuf,
        signature: String,
        revision: String,
        value: String,
    },
    Release {
        file: PathBuf,
    },
}

#[derive(Default)]
struct Store {
    cache: Option<(PathBuf, Database)>,
}

impl Store {
    fn database(&mut self, path: &Path, create: bool) -> Result<Option<&Database>> {
        if !self.cache.as_ref().is_some_and(|(file, _)| file == path) {
            self.cache = None;
            if !create && !path.try_exists()? {
                return Ok(None);
            }
            let db = if create {
                Database::create(path)?
            } else {
                Database::open(path)?
            };
            self.cache = Some((path.into(), db));
        }
        Ok(self.cache.as_ref().map(|(_, db)| db))
    }

    fn load(&mut self, file: &Path) -> Result<Option<Progress>> {
        let path = file.with_extension("redb");
        let db = if let Some(db) = self.database(&path, false)? {
            let tx = db.begin_read()?;
            if let Ok(table) = tx.open_table(STATE)
                && let Some(value) = table.get(0)?
            {
                return Ok(Some(serde_json::from_slice(value.value())?));
            }
            db
        } else {
            if !file.try_exists()? {
                return Ok(None);
            }
            self.database(&path, true)?.expect("created ISBN store")
        };
        let legacy = match File::open(file) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if legacy.metadata()?.len() > LEGACY_LIMIT {
            return Err("Превышен размер индекса ISBN".into());
        }
        let mut reader = BufReader::with_capacity(128 * 1024, legacy);
        if reader.fill_buf()?.starts_with(b"\xef\xbb\xbf") {
            reader.consume(3);
        }
        let checkpoint: Checkpoint = serde_json::from_reader(reader)?;
        validate(&checkpoint.progress)?;
        let tx = db.begin_write()?;
        write_checkpoint(&tx, &checkpoint)?;
        tx.commit()?;
        Ok(Some(checkpoint.progress))
    }

    fn save(&mut self, file: &Path, checkpoint: Checkpoint, reset: bool) -> Result<Value> {
        let path = file.with_extension("redb");
        let db = self.database(&path, true)?.expect("created ISBN store");
        validate(&checkpoint.progress)?;
        let tx = db.begin_write()?;
        if reset {
            tx.delete_table(MATCHES)?;
        } else {
            let state = tx.open_table(STATE)?;
            let current: Progress = serde_json::from_slice(
                state
                    .get(0)?
                    .ok_or("Индекс ISBN не инициализирован")?
                    .value(),
            )?;
            let next = &checkpoint.progress;
            if next.revision != current.revision
                || next.signature != current.signature
                || next.last_id < current.last_id
                || next.checked < current.checked
                || next.found < current.found
                || current.complete && !next.complete
                || checkpoint.entries.iter().any(|row| {
                    row.0 > next.last_id
                        || row.0 <= current.last_id && next.last_id != current.last_id
                })
            {
                return Err("Состояние индекса ISBN уже изменилось".into());
            }
        }
        write_checkpoint(&tx, &checkpoint)?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn select(
        &mut self,
        file: &Path,
        signature: &str,
        revision: &str,
        value: &str,
    ) -> Result<Value> {
        let key = isbn::normalize(value).ok_or("Укажите корректный ISBN-10 или ISBN-13")?;
        let path = file.with_extension("redb");
        let ready =
            "Индекс ISBN ещё не готов. Администратор может подготовить его в разделе «Задачи»";
        let db = self.database(&path, false)?.ok_or(ready)?;
        let tx = db.begin_read()?;
        let state = tx.open_table(STATE)?;
        let progress: Progress = serde_json::from_slice(state.get(0)?.ok_or(ready)?.value())?;
        if !progress.complete || progress.signature != signature || progress.revision != revision {
            return Err(ready.into());
        }
        let table = tx.open_table(MATCHES)?;
        let mut ids = Vec::new();
        let mut deleted = Vec::new();
        for row in table.range((key.as_str(), 0)..=(key.as_str(), u32::MAX))? {
            let (index, flag) = row?;
            let (_, id) = index.value();
            ids.push(id);
            if flag.value() {
                deleted.push(id);
            }
        }
        Ok(json!({"ids":ids,"deletedIds":deleted}))
    }
}

fn validate(progress: &Progress) -> Result<()> {
    if progress.version != 1 || progress.signature.is_empty() || progress.revision.is_empty() {
        return Err("Некорректный индекс ISBN".into());
    }
    Ok(())
}

fn write_checkpoint(tx: &WriteTransaction, checkpoint: &Checkpoint) -> Result<()> {
    let mut matches = tx.open_table(MATCHES)?;
    for Row(id, numbers, deleted) in &checkpoint.entries {
        for number in numbers {
            let normalized =
                isbn::normalize(number).ok_or("Некорректный ISBN в сохранённом индексе")?;
            matches.insert((normalized.as_str(), *id), *deleted)?;
        }
    }
    let bytes = serde_json::to_vec(&checkpoint.progress)?;
    tx.open_table(STATE)?.insert(0, bytes.as_slice())?;
    Ok(())
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut store = Store::default();
    while let Some(request) = header::<Request>(&mut input)? {
        let result = match request {
            Request::Load { file } => store
                .load(&file)
                .and_then(|status| Ok(serde_json::to_value(status)?)),
            Request::Save { file, bytes, reset } => with_body(&mut input, bytes, |reader| {
                if bytes > BODY_LIMIT {
                    return Err("Превышен размер контрольной точки ISBN".into());
                }
                store.save(&file, serde_json::from_reader(reader)?, reset)
            })?,
            Request::Select {
                file,
                signature,
                revision,
                value,
            } => store.select(&file, &signature, &revision, &value),
            Request::Release { file } => {
                if store
                    .cache
                    .as_ref()
                    .is_some_and(|(path, _)| *path == file.with_extension("redb"))
                {
                    store.cache = None;
                }
                Ok(Value::Null)
            }
        };
        match result {
            Ok(value) => {
                Frames(&mut output).write_all(&serde_json::to_vec(&value)?)?;
                complete(&mut output, None, None)?;
            }
            Err(error) => complete(&mut output, Some(error.to_string()), None)?,
        }
    }
    Ok(())
}
