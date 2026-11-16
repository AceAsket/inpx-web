use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::file_stamp::stamp;
use crate::progress_journal::{self, JournalAppend, JournalRequest, ProgressJournal};
use crate::progress_update::{ProgressDecision, ProgressPolicy};
use crate::{Result, atomic_file, crypto_support};

#[path = "reader_library.rs"]
mod library;
#[path = "published_reading.rs"]
mod published;
pub use published::PublishedReading;
pub(crate) use shelves::{FILTERS, normalize_filters, relative_date};
#[path = "reader_shelves.rs"]
mod shelves;

pub struct ReaderState {
    file: PathBuf,
    progress_file: PathBuf,
    journal: ProgressJournal,
}

struct Snapshot {
    data: Value,
    checkpoint: String,
    offset: usize,
    journal_stamp: Option<String>,
}

impl ReaderState {
    pub fn new(data: &Path) -> Self {
        let progress_file = data.join(progress_journal::FILE_NAME);
        Self {
            file: data.join("reading-lists.json"),
            journal: ProgressJournal::new(&progress_file),
            progress_file,
        }
    }

    fn snapshot(&self, expected: &str) -> Result<Snapshot> {
        let file = File::open(&self.file)?;
        if stamp(&file)?.to_string() != expected {
            return Err("Файл профилей изменился, повторите запрос".into());
        }
        let mut data: Value = serde_json::from_reader(std::io::BufReader::new(file))?;
        let checkpoint = string(&data[progress_journal::CHECKPOINT_FIELD]).to_owned();
        let journal_stamp = atomic_file::current_stamp(&self.progress_file)?;
        let mut offset = 0;
        if journal_stamp.is_some() && progress_journal::valid_checkpoint(&checkpoint) {
            let mut users = HashMap::new();
            for (index, user) in data["users"]
                .as_array()
                .ok_or("Некорректный файл профилей")?
                .iter()
                .enumerate()
            {
                if let Some(id) = user["id"].as_str() {
                    users
                        .entry(id.to_owned())
                        .or_insert((index, number(&user["readerProgressGeneration"]).max(0.0)));
                }
            }
            let generations = users
                .iter()
                .map(|(id, (_, generation))| (id.clone(), *generation))
                .collect();
            let replay = self.journal.query(JournalRequest::Replay {
                checkpoint: checkpoint.clone(),
                generations,
            })?;
            let result: Value = serde_json::from_str(replay.get())?;
            if result["state"] != "replay" {
                return Err("Журнал прогресса требует восстановления".into());
            }
            offset = result["offset"].as_u64().unwrap_or_default() as usize;
            for entry in result["updates"].as_array().into_iter().flatten() {
                let (Some(user), Some(uid)) = (entry[0].as_str(), entry[1].as_str()) else {
                    continue;
                };
                if let Some(&(index, _)) = users.get(user) {
                    assign(
                        &mut data["users"][index],
                        uid,
                        entry[2].clone(),
                        string(&entry[3]),
                    );
                }
            }
        }
        if atomic_file::current_stamp(&self.file)?.as_deref() != Some(expected)
            || atomic_file::current_stamp(&self.progress_file)? != journal_stamp
        {
            return Err("Состояние читалки изменилось, повторите запрос".into());
        }
        Ok(Snapshot {
            data,
            checkpoint,
            offset,
            journal_stamp,
        })
    }

    pub fn request(
        &self,
        owner: &str,
        expected: &str,
        uid: &str,
        patch: Option<&Value>,
    ) -> Result<Value> {
        let uid = bounded(uid, 512)?;
        if uid.is_empty() {
            return Err("bookUid is empty".into());
        }
        let mut snapshot = self.snapshot(expected)?;
        let index = snapshot.data["users"]
            .as_array()
            .and_then(|users| users.iter().position(|profile| profile["id"] == owner))
            .ok_or("need_profile_login")?;
        let user = &snapshot.data["users"][index];
        let Some(patch) = patch else {
            return Ok(reader_state(user, uid));
        };
        let progress = match prepare(user, uid, patch)? {
            Update::Reply(progress) => return Ok(json!({"progress": progress})),
            Update::Write(progress) => progress,
        };
        let updated = now();
        let mut line = serde_json::to_string(&(owner, uid, &progress, &updated))?;
        line.push('\n');
        let can_append = progress_journal::valid_checkpoint(&snapshot.checkpoint)
            && snapshot.offset.max(33).saturating_add(line.len()) <= progress_journal::MAX_BYTES;
        if can_append {
            if atomic_file::current_stamp(&self.file)?.as_deref() != Some(expected) {
                return Err("Файл профилей изменился, повторите запрос".into());
            }
            let saved = self.journal.query(JournalRequest::Append {
                record: JournalAppend {
                    checkpoint: snapshot.checkpoint,
                    expected: snapshot.journal_stamp,
                    offset: snapshot.offset,
                    line,
                },
            })?;
            let saved: Value = serde_json::from_str(saved.get())?;
            if saved["state"] != "written" {
                return Err("Журнал прогресса изменился, повторите запрос".into());
            }
        } else {
            assign(
                &mut snapshot.data["users"][index],
                uid,
                progress.clone(),
                &updated,
            );
            self.publish(snapshot, expected)?;
        }
        Ok(json!({"progress": progress}))
    }

    fn publish(&self, mut snapshot: Snapshot, expected: &str) -> Result<()> {
        snapshot.data[progress_journal::CHECKPOINT_FIELD] =
            crypto_support::hex(&crypto_support::random::<16>()?).into();
        let mut output = tempfile::NamedTempFile::new_in(
            self.file.parent().ok_or("Каталог профилей отсутствует")?,
        )?;
        serde_json::to_writer(&mut output, &snapshot.data)?;
        if atomic_file::current_stamp(&self.progress_file)? != snapshot.journal_stamp
            || atomic_file::publish(output, &self.file, Some(expected))?.is_none()
        {
            return Err("Состояние читалки изменилось, повторите запрос".into());
        }
        Ok(())
    }
}

fn reader_state(user: &Value, uid: &str) -> Value {
    let mut progress = empty_progress();
    if let Some(stored) = user["readerProgress"][uid].as_object() {
        progress
            .as_object_mut()
            .expect("default position")
            .extend(stored.clone());
    }
    json!({
        "preferences":user["readerPreferences"].as_object().cloned().unwrap_or_default(),
        "progress":progress,
        "progressGeneration":number(&user["readerProgressGeneration"]).max(0.0) as u64,
        "progressResetAt":string(&user["readerProgressResetAt"]),
        "bookmarks":user["readerBookmarks"][uid].as_array().cloned().unwrap_or_default(),
    })
}

fn assign(user: &mut Value, uid: &str, progress: Value, updated: &str) {
    if !user["readerProgress"].is_object() {
        user["readerProgress"] = Value::Object(Map::new());
    }
    user["readerProgress"][uid] = progress;
    user["updatedAt"] = updated.into();
}

fn empty_progress() -> Value {
    json!({"percent":0,"sectionId":"","pageIndex":0,"textOffset":-1,"textSnippet":"","updatedAt":"","hidden":false})
}

enum Update {
    Write(Value),
    Reply(Value),
}

fn prepare(user: &Value, uid: &str, patch: &Value) -> Result<Update> {
    if !patch.is_object() {
        return Err("Некорректная позиция чтения".into());
    }
    let old = &user["readerProgress"][uid];
    let mut current = old.as_object().cloned().unwrap_or_default();
    if !string(&old["relinkedTo"]).is_empty() {
        current.insert("conflict".into(), true.into());
        return Ok(Update::Reply(current.into()));
    }
    let generation = number(&user["readerProgressGeneration"]).max(0.0).trunc();
    let revision = number(&old["revision"]);
    let updated = bounded(string(&patch["updatedAt"]), 128)?;
    let requested_generation = if let Some(value) = patch.get("generation") {
        number(value).max(0.0).trunc()
    } else if patch.get("hidden").is_some() && updated.is_empty() {
        generation
    } else {
        0.0
    };
    let policy = ProgressPolicy {
        generation,
        requested_generation,
        current_generation: (!current.is_empty())
            .then(|| number(&old["generation"]).max(0.0).trunc()),
        revision,
        checks_revision: patch.get("baseRevision").is_some(),
        requested_revision: patch.get("baseRevision").and_then(numeric),
        requested_time: timestamp(updated),
        current_time: timestamp(string(&old["updatedAt"])),
        force: patch["force"] == true,
    };
    match policy.decide() {
        ProgressDecision::Keep => return Ok(Update::Reply(current.into())),
        ProgressDecision::Conflict => {
            current.insert("revision".into(), (revision as u64).into());
            current.insert("conflict".into(), true.into());
            return Ok(Update::Reply(current.into()));
        }
        ProgressDecision::GenerationMismatch => {
            current.insert("generationMismatch".into(), true.into());
            return Ok(Update::Reply(current.into()));
        }
        ProgressDecision::Reset => {
            let mut reset = empty_progress();
            let time = string(&user["readerProgressResetAt"]);
            reset["updatedAt"] = time.into();
            reset["resetAt"] = time.into();
            reset["reset"] = true.into();
            reset["generation"] = (generation as u64).into();
            return Ok(Update::Reply(reset));
        }
        ProgressDecision::Advance => (),
    }
    let field = |key: &str| patch.get(key).unwrap_or(&old[key]);
    let section = bounded(string(field("sectionId")), 4096)?;
    let text = string(field("textSnippet")).trim();
    let mut end = 0;
    let mut units = 0;
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > 240 {
            break;
        }
        end += ch.len_utf8();
    }
    Ok(Update::Write(json!({
        "percent":number(field("percent")).clamp(0.0,1.0),"sectionId":section,
        "pageIndex":number(field("pageIndex")).round().max(0.0) as u64,
        "textOffset":numeric(field("textOffset")).unwrap_or(-1.0).round().max(-1.0) as i64,
        "textSnippet":&text[..end],"updatedAt":if updated.is_empty() { now() } else { updated.to_owned() },
        "hidden":field("hidden")==true,"generation":generation as u64,"revision":(revision as u64).saturating_add(1),
    })))
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn bounded(value: &str, limit: usize) -> Result<&str> {
    let value = value.trim();
    if value.encode_utf16().count() > limit {
        return Err("Слишком длинное поле позиции чтения".into());
    }
    Ok(value)
}

fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value| value.is_finite())
}

pub(crate) fn number(value: &Value) -> f64 {
    numeric(value).unwrap_or_default()
}

fn timestamp(value: &str) -> Option<f64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .map(|time| time.unix_timestamp_nanos() as f64 / 1_000_000.0)
}

pub(crate) fn now() -> String {
    let millis = crate::access_runtime::now_ms();
    let time = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .expect("system date");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        time.month() as u8,
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
}
