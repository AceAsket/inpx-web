use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::Result;
use crate::atomic_file;
use crate::backup_transaction::{BackupRequest, BackupTransaction};
use crate::file_stamp::stamp;
use crate::profile_snapshot::{ProfileSnapshot, SnapshotRequest};
use crate::progress_update::{ProgressDecision, ProgressPolicy};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const CHECKPOINT_BYTES: usize = 32;
const HEADER_BYTES: usize = CHECKPOINT_BYTES + 1;
pub(crate) const FILE_NAME: &str = "reader-progress.log";
pub(crate) const CHECKPOINT_FIELD: &str = "readerProgressCheckpoint";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum JournalRequest {
    Probe,
    Replay {
        checkpoint: String,
        generations: HashMap<String, f64>,
    },
    Append {
        #[serde(flatten)]
        record: JournalAppend,
    },
    Update {
        policy: ProgressPolicy,
        append: Option<JournalAppend>,
    },
    Snapshot {
        #[serde(flatten)]
        action: SnapshotRequest,
    },
    Backup {
        #[serde(rename = "configFile")]
        config_file: PathBuf,
        #[serde(flatten)]
        action: BackupRequest,
    },
}

#[derive(Deserialize)]
pub struct JournalAppend {
    pub(crate) checkpoint: String,
    pub(crate) expected: Option<String>,
    pub(crate) offset: usize,
    pub(crate) line: String,
}

struct CommittedAppend {
    stamp: String,
    checkpoint: String,
    offset: usize,
}

pub struct ProgressJournal {
    path: PathBuf,
    committed: RefCell<Option<CommittedAppend>>,
    profiles: ProfileSnapshot,
}

#[derive(Deserialize)]
struct Entry<'a>(
    #[serde(borrow)] Cow<'a, str>,
    #[serde(borrow)] Cow<'a, str>,
    #[serde(borrow)] &'a RawValue,
    #[serde(borrow)] Cow<'a, str>,
);

#[derive(Deserialize)]
struct Progress {
    generation: f64,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum JournalResponse<'a> {
    Replay {
        offset: usize,
        updates: Vec<(&'a str, &'a str, &'a RawValue, &'a str)>,
        latest: HashMap<&'a str, &'a str>,
    },
    LegacyJson,
    TooLarge,
    InvalidRecord,
    Ready {
        updates: bool,
        snapshots: bool,
        #[serde(rename = "profileCredentials")]
        profile_credentials: bool,
        #[serde(rename = "profileBootstrap")]
        profile_bootstrap: bool,
        backups: bool,
    },
    Changed,
    Advance,
    GenerationMismatch,
    Reset,
    Conflict,
    Keep,
    Written {
        stamp: String,
        offset: usize,
    },
}

fn encode(replay: JournalResponse<'_>) -> Result<Box<RawValue>> {
    Ok(serde_json::value::to_raw_value(&replay)?)
}

impl ProgressJournal {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.into(),
            committed: RefCell::new(None),
            profiles: ProfileSnapshot::new(path.with_file_name("reading-lists.json")),
        }
    }

    pub fn query(&self, request: JournalRequest) -> Result<Box<RawValue>> {
        match request {
            JournalRequest::Probe => encode(JournalResponse::Ready {
                updates: true,
                snapshots: true,
                profile_credentials: true,
                profile_bootstrap: true,
                backups: true,
            }),
            JournalRequest::Replay {
                checkpoint,
                generations,
            } => replay(&self.path, &checkpoint, &generations),
            JournalRequest::Append { record } => self.append(record),
            JournalRequest::Snapshot { action } => Ok(serde_json::value::to_raw_value(
                &self.profiles.apply(action)?,
            )?),
            JournalRequest::Backup {
                config_file,
                action,
            } => {
                let data = self.path.parent().ok_or("missing backup directory")?;
                let transaction = BackupTransaction::new(data, &config_file);
                Ok(serde_json::value::to_raw_value(&transaction.run(action))?)
            }
            JournalRequest::Update { policy, append } => match policy.decide() {
                ProgressDecision::Advance => match append {
                    Some(record) => self.append(record),
                    None => encode(JournalResponse::Advance),
                },
                ProgressDecision::GenerationMismatch => encode(JournalResponse::GenerationMismatch),
                ProgressDecision::Reset => encode(JournalResponse::Reset),
                ProgressDecision::Conflict => encode(JournalResponse::Conflict),
                ProgressDecision::Keep => encode(JournalResponse::Keep),
            },
        }
    }
}

pub(crate) fn valid_checkpoint(checkpoint: &str) -> bool {
    checkpoint.len() == CHECKPOINT_BYTES
        && checkpoint
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn replay(
    file: &Path,
    checkpoint: &str,
    generations: &HashMap<String, f64>,
) -> Result<Box<RawValue>> {
    if !valid_checkpoint(checkpoint) {
        return Err("invalid reader progress checkpoint".into());
    }
    let mut data = Vec::new();
    File::open(file)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)?;
    let prefix = checkpoint.as_bytes();
    let matches = data
        .strip_prefix(prefix)
        .is_some_and(|tail| tail.starts_with(b"\n"));
    if !matches {
        return encode(JournalResponse::Replay {
            offset: 0,
            updates: Vec::new(),
            latest: HashMap::new(),
        });
    }
    if data.len() > MAX_BYTES {
        return encode(JournalResponse::TooLarge);
    }
    let offset = data
        .iter()
        .rposition(|byte| *byte == b'\n')
        .expect("checkpoint delimiter")
        + 1;
    let records = String::from_utf8_lossy(&data[prefix.len() + 1..offset]);
    let mut entries: Vec<Entry> = Vec::new();
    // Keep decoded strings in the parsed entries. Most lines hold borrowed
    // strings, whereas escaped IDs or timestamps need owned strings.
    for line in records.split_terminator('\n') {
        let Ok(entry) = serde_json::from_str::<Entry>(line) else {
            return encode(JournalResponse::LegacyJson);
        };
        let Entry(user, book, progress, _) = &entry;
        if book.is_empty() || !progress.get().starts_with('{') {
            return encode(JournalResponse::InvalidRecord);
        }
        let Ok(row) = serde_json::from_str::<Progress>(progress.get()) else {
            return encode(JournalResponse::LegacyJson);
        };
        if generations.get(user.as_ref()) != Some(&row.generation) {
            return encode(JournalResponse::InvalidRecord);
        }
        entries.push(entry);
    }
    let mut latest = HashMap::new();
    let mut positions = HashMap::new();
    let mut updates = Vec::new();
    for Entry(user, book, progress, updated) in &entries {
        latest.insert(user.as_ref(), updated.as_ref());
        let index = *positions
            .entry((user.as_ref(), book.as_ref()))
            .or_insert(updates.len());
        let replacement = (user.as_ref(), book.as_ref(), *progress, updated.as_ref());
        if index == updates.len() {
            updates.push(replacement);
        } else {
            updates[index] = replacement;
        }
    }
    encode(JournalResponse::Replay {
        offset,
        updates,
        latest,
    })
}

impl ProgressJournal {
    fn append(&self, record: JournalAppend) -> Result<Box<RawValue>> {
        let JournalAppend {
            checkpoint,
            expected,
            offset,
            line,
        } = record;
        let line = line.as_bytes();
        let expected = expected.as_deref();
        let file = &self.path;
        if !valid_checkpoint(&checkpoint)
            || offset != 0 && !(HEADER_BYTES..=MAX_BYTES).contains(&offset)
            || !matches!(line.split_last(), Some((b'\n', contents)) if !contents.is_empty() && !contents.contains(&b'\n'))
        {
            return Err("invalid reader progress append".into());
        }
        let written = offset.max(HEADER_BYTES) + line.len();
        if written > MAX_BYTES {
            return encode(JournalResponse::TooLarge);
        }
        let last = self.committed.borrow_mut().take();
        if offset == 0 {
            drop(last);
            let parent = file.parent().ok_or("missing reader progress directory")?;
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            temp.write_all(checkpoint.as_bytes())?;
            temp.write_all(b"\n")?;
            temp.write_all(line)?;
            let Some(persisted) = atomic_file::publish(temp, file, expected)? else {
                return encode(JournalResponse::Changed);
            };
            return self.remember(persisted, checkpoint, written);
        }

        let known_end = last.is_some_and(|last| {
            last.offset == offset
                && last.checkpoint == checkpoint
                && Some(last.stamp.as_str()) == expected
        });
        let mut options = OpenOptions::new();
        options.read(!known_end).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
        let mut handle = match options.open(file) {
            Ok(handle) => handle,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return encode(JournalResponse::Changed);
            }
            Err(error) => return Err(error.into()),
        };
        let current = stamp(&handle)?;
        if Some(current.to_string().as_str()) != expected
            || current.len < offset as u64
            || known_end && current.len != offset as u64
        {
            return encode(JournalResponse::Changed);
        }
        if known_end {
            handle.seek(SeekFrom::Start(offset as u64))?;
        } else {
            let mut header = [0; HEADER_BYTES];
            handle.read_exact(&mut header)?;
            if header[..CHECKPOINT_BYTES] != *checkpoint.as_bytes()
                || header[CHECKPOINT_BYTES] != b'\n'
            {
                return encode(JournalResponse::Changed);
            }
            handle.seek(SeekFrom::Start((offset - 1) as u64))?;
            let mut delimiter = [0];
            handle.read_exact(&mut delimiter)?;
            if delimiter != *b"\n" {
                return encode(JournalResponse::Changed);
            }
            if current.len != offset as u64 {
                handle.set_len(offset as u64)?;
            }
        }
        handle.write_all(line)?;
        handle.sync_all()?;
        self.remember(handle, checkpoint, written)
    }

    fn remember(&self, file: File, checkpoint: String, offset: usize) -> Result<Box<RawValue>> {
        let observed = stamp(&file)?;
        drop(file);
        if observed.len != offset as u64 {
            return encode(JournalResponse::Changed);
        }
        let stamp = observed.to_string();
        let response = encode(JournalResponse::Written {
            stamp: stamp.clone(),
            offset,
        })?;
        *self.committed.borrow_mut() = Some(CommittedAppend {
            stamp,
            checkpoint,
            offset,
        });
        Ok(response)
    }
}
