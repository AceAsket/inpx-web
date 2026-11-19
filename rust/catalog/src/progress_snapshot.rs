use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{
    Value,
    value::{RawValue, to_raw_value},
};

use crate::file_stamp::stamp;
use crate::progress_journal::{CHECKPOINT_FIELD, replay, valid_checkpoint};
use crate::{Result, atomic_file};

type Fields<'a> = IndexMap<String, &'a RawValue>;

#[derive(Default)]
struct Accounts {
    indices: HashMap<String, usize>,
    generations: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum JournalState {
    Replay,
    LegacyJson,
    InvalidRecord,
    TooLarge,
}

#[derive(Deserialize)]
struct JournalRead<'a> {
    state: JournalState,
    #[serde(default)]
    offset: usize,
    #[serde(borrow, default)]
    updates: Vec<(String, String, &'a RawValue, String)>,
    #[serde(default)]
    latest: HashMap<String, String>,
}

/// Fold a matching journal into the staged file for rollback to pre-journal releases.
/// A false result leaves the staged file alone and lets the caller use legacy parsing.
pub(crate) fn fold(journal: &Path, snapshot: &Path) -> Result<bool> {
    match fs::metadata(journal) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    }
    let mut file = File::open(snapshot)?;
    let expected = stamp(&file)?.to_string();
    let mut input = String::new();
    match file.read_to_string(&mut input) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::InvalidData => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let Ok(original) = serde_json::from_str::<&RawValue>(&input) else {
        return Ok(true); // Keep corrupt snapshots for manual recovery.
    };
    if !original.get().starts_with('{') {
        return Ok(true);
    }
    let Ok(mut root) = serde_json::from_str::<Fields<'_>>(original.get()) else {
        return Ok(false);
    };
    let Some(checkpoint) = checkpoint(&root) else {
        return Ok(true);
    };
    let mut users = users(&root);
    let Some(accounts) = accounts(&users) else {
        return Ok(false);
    };
    let result = replay(journal, &checkpoint, &accounts.generations)?;
    let Some(replay) = read_journal(&result)? else {
        return Ok(false);
    };
    if replay.offset == 0 {
        return Ok(true);
    }
    let mut by_user: HashMap<String, Vec<(String, &RawValue)>> = HashMap::new();
    for (user, book, row, _) in replay.updates {
        by_user.entry(user).or_default().push((book, row));
    }
    let mut changed = Vec::with_capacity(by_user.len());
    for (id, rows) in by_user {
        let index = accounts.indices[&id];
        let mut user: Fields<'_> = serde_json::from_str(users[index].get())?;
        let Some(mut progress) = read_progress(user.get("readerProgress").copied()) else {
            return Ok(false);
        };
        progress.extend(rows);
        let progress = to_raw_value(&progress)?;
        let time = to_raw_value(&replay.latest[&id])?;
        user.insert("readerProgress".into(), &progress);
        user.insert("updatedAt".into(), &time);
        changed.push((index, to_raw_value(&user)?));
    }
    for (index, row) in &changed {
        users[*index] = row;
    }
    let users = root
        .get("users")
        .is_some_and(|raw| raw.get().starts_with('['))
        .then(|| to_raw_value(&users))
        .transpose()?;
    if let Some(users) = &users {
        root.insert("users".into(), users);
    }
    root.shift_remove(CHECKPOINT_FIELD);
    drop(file);
    let mut replacement =
        tempfile::NamedTempFile::new_in(snapshot.parent().ok_or("missing snapshot parent")?)?;
    serde_json::to_writer_pretty(&mut replacement, &root)?;
    if atomic_file::publish(replacement, snapshot, Some(&expected))?.is_none() {
        return Err("Staged rollback profile changed during journal folding".into());
    }
    Ok(true)
}

pub(crate) fn clear_obsolete(journal: &Path, snapshot: &Path) -> Result<bool> {
    let Some(expected) = atomic_file::current_stamp(journal)? else {
        return Ok(true);
    };
    let bytes = fs::read(snapshot)?;
    let text = String::from_utf8_lossy(&bytes);
    let root: &RawValue = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| "Invalid reading-lists.json in restored data")?;
    if root.get() == "null" {
        return Err("Invalid reading-lists.json in restored data".into());
    }
    if root.get().starts_with('{') {
        let Ok(root) = serde_json::from_str::<Fields<'_>>(root.get()) else {
            return Ok(false);
        };
        if let Some(checkpoint) = checkpoint(&root) {
            let Some(accounts) = accounts(&users(&root)) else {
                return Ok(false);
            };
            let result = replay(journal, &checkpoint, &accounts.generations)?;
            let Some(replay) = read_journal(&result)? else {
                return Ok(false);
            };
            if replay.offset != 0 {
                return Ok(true);
            }
        }
    }
    if atomic_file::current_stamp(journal)?.as_deref() == Some(expected.as_str()) {
        match fs::remove_file(journal) {
            Ok(()) => atomic_file::sync_parent(journal)?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}

fn checkpoint(root: &Fields<'_>) -> Option<String> {
    root.get(CHECKPOINT_FIELD)
        .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
        .filter(|text| valid_checkpoint(text))
}

fn users<'a>(root: &Fields<'a>) -> Vec<&'a RawValue> {
    root.get("users")
        .and_then(|raw| serde_json::from_str(raw.get()).ok())
        .unwrap_or_default()
}

fn accounts(users: &[&RawValue]) -> Option<Accounts> {
    let mut accounts = Accounts::default();
    for (index, row) in users.iter().enumerate() {
        let Ok(fields) = serde_json::from_str::<Fields<'_>>(row.get()) else {
            continue;
        };
        let Some(id) = fields.get("id") else { continue };
        let id: String = serde_json::from_str(id.get()).ok()?;
        if id.is_empty() {
            continue;
        }
        let generation = generation(fields.get("readerProgressGeneration").copied())?;
        accounts.indices.insert(id.clone(), index);
        accounts.generations.insert(id, generation);
    }
    Some(accounts)
}

fn read_journal(result: &RawValue) -> Result<Option<JournalRead<'_>>> {
    let replay: JournalRead<'_> = serde_json::from_str(result.get())?;
    match replay.state {
        JournalState::Replay => Ok(Some(replay)),
        JournalState::LegacyJson => Ok(None),
        JournalState::InvalidRecord => Err("Некорректная запись в журнале прогресса чтения".into()),
        JournalState::TooLarge => Err("Reader progress journal exceeds its size limit".into()),
    }
}

fn read_progress(raw: Option<&RawValue>) -> Option<Fields<'_>> {
    let Some(raw) = raw else {
        return Some(Fields::new());
    };
    match raw.get() {
        "null" | "false" | "\"\"" => Some(Fields::new()),
        text if text.starts_with('{') => serde_json::from_str(text).ok(),
        text if text.parse::<f64>().ok() == Some(0.0) => Some(Fields::new()),
        _ => None,
    }
}

fn generation(raw: Option<&RawValue>) -> Option<f64> {
    let Some(raw) = raw else { return Some(0.0) };
    match serde_json::from_str(raw.get()).ok()? {
        Value::Null | Value::Bool(_) => Some(0.0),
        Value::Number(number) => {
            let value = number.as_f64()?;
            (value.abs() <= 9_007_199_254_740_991.0 && (value == 0.0 || value.abs() >= 0.000001))
                .then_some(value.trunc().max(0.0))
        }
        Value::String(text) => {
            let text = text.trim_start_matches(crate::fb2_prepare::js_space);
            if text.starts_with('-') {
                return Some(0.0);
            }
            let text = text.strip_prefix('+').unwrap_or(text);
            let length = text.bytes().take_while(u8::is_ascii_digit).count();
            Some(text[..length].parse::<f64>().unwrap_or(0.0))
        }
        _ => None,
    }
}
