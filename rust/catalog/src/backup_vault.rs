use std::cmp::Reverse;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::backup_crypto::{self, SALT_BYTES};
use crate::crypto_support::{KEY_BYTES, Sensitive, random};
use crate::{Result, atomic_file, file_stamp, secret_store};

const MAX_LISTED: usize = 500;
const POLICY_NAME: &str = "backup-vault.json";
const INVALID_NAME: &str = "Некорректное имя резервной копии";
const UNAVAILABLE: &str = "Резервная копия недоступна";
const FAILED_COPY: &str = "Не удалось создать копию. Проверьте журнал и место на диске.";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Policy {
        window: Option<ScheduleWindow>,
    },
    Due {
        window: ScheduleWindow,
    },
    Update {
        patch: Map<String, Value>,
        key: Option<EncryptionPolicy>,
    },
    MarkCreated {
        timestamp: String,
    },
    MarkFailed,
    List {
        scheduled: bool,
    },
    Inspect {
        name: String,
    },
    Remove {
        name: String,
    },
    Rotate {
        keep: usize,
    },
    Probe,
}

#[derive(Deserialize)]
pub struct EncryptionPolicy {
    key: String,
    salt: String,
}

pub(crate) struct ArchiveKey {
    pub(crate) key: Sensitive<[u8; KEY_BYTES]>,
    pub(crate) salt: [u8; SALT_BYTES],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleWindow {
    hour: u8,
    day_start: i64,
    next_day: i64,
}

impl ScheduleWindow {
    pub fn at(local: OffsetDateTime) -> Result<Self> {
        let offset = local.offset();
        let start = local.date().midnight().assume_offset(offset);
        let end = local
            .date()
            .next_day()
            .ok_or("Invalid backup schedule date")?
            .midnight()
            .assume_offset(offset);
        Ok(Self {
            hour: local.hour(),
            day_start: start.unix_timestamp() * 1000,
            next_day: end.unix_timestamp() * 1000,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    version: u8,
    enabled: bool,
    hour: u8,
    keep: u8,
    key: String,
    salt: String,
    last_scheduled_at: String,
    last_error: String,
}

impl Policy {
    fn open(file: &Path) -> Result<(Self, Option<String>)> {
        let (data, stamp) = match File::open(file) {
            Ok(mut file) => {
                let stamp = file_stamp::stamp(&file)?.to_string();
                let mut contents = Vec::new();
                file.read_to_end(&mut contents)?;
                let contents = contents.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&contents);
                (serde_json::from_slice(contents)?, Some(stamp))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (Value::Null, None),
            Err(error) => return Err(error.into()),
        };
        let text = |field: &str| data[field].as_str().unwrap_or("").to_owned();
        Ok((
            Self {
                version: 1,
                enabled: data["enabled"].as_bool() == Some(true),
                hour: integer(&data["hour"], 0, 23).unwrap_or(3),
                keep: integer(&data["keep"], 1, 60).unwrap_or(7),
                key: text("key"),
                salt: text("salt"),
                last_scheduled_at: text("lastScheduledAt"),
                last_error: text("lastError"),
            },
            stamp,
        ))
    }

    fn due(&self, window: &ScheduleWindow) -> bool {
        self.enabled
            && !self.key.is_empty()
            && window.hour >= self.hour
            && !timestamp(&self.last_scheduled_at)
                .is_some_and(|time| (window.day_start..window.next_day).contains(&time))
    }

    fn update(
        &mut self,
        patch: &Map<String, Value>,
        replacement: Option<EncryptionPolicy>,
    ) -> Result<()> {
        if let Some(replacement) = replacement {
            self.key = replacement.key;
            self.salt = replacement.salt;
        }
        if patch.get("clearPassword").and_then(Value::as_bool) == Some(true) {
            self.key.clear();
            self.salt.clear();
            self.enabled = false;
        }
        if let Some(hour) = patch.get("hour") {
            self.hour = integer(hour, 0, 23).ok_or("Укажите час от 0 до 23")?;
        }
        if let Some(keep) = patch.get("keep") {
            self.keep =
                integer(keep, 1, 60).ok_or("Можно хранить от 1 до 60 автоматических копий")?;
        }
        if let Some(enabled) = patch.get("enabled") {
            self.enabled = enabled.as_bool() == Some(true);
        }
        if self.enabled && self.key.is_empty() {
            return Err("Для автоматических копий сначала задайте пароль".into());
        }
        Ok(())
    }
}

fn integer(value: &Value, low: u8, high: u8) -> Option<u8> {
    let value = value.as_f64()?;
    (value.fract() == 0.0 && (f64::from(low)..=f64::from(high)).contains(&value))
        .then_some(value as u8)
}

fn timestamp(value: &str) -> Option<i64> {
    let date = OffsetDateTime::parse(value, &Rfc3339).ok()?;
    (date.unix_timestamp_nanos() / 1_000_000).try_into().ok()
}

pub(crate) fn decode_key(wrapped: &str, salt: &str, master: &Path) -> Result<ArchiveKey> {
    let key = secret_store::key(master, false)?;
    let decoded = secret_store::Envelope::parse(wrapped.as_bytes())?.open(&key.0)?;
    let bytes = Sensitive(STANDARD.decode(&decoded.0)?);
    let key = Sensitive(
        bytes
            .0
            .as_slice()
            .try_into()
            .map_err(|_| "Повреждены настройки шифрования. Задайте пароль заново")?,
    );
    let salt = STANDARD
        .decode(salt)?
        .try_into()
        .map_err(|_| "Повреждены настройки шифрования. Задайте пароль заново")?;
    Ok(ArchiveKey { key, salt })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    name: String,
    size: u64,
    modified_ms: i64,
    encrypted: bool,
    scheduled: bool,
}

struct BackupName<'a> {
    rank: &'a str,
    scheduled: bool,
    encrypted: bool,
}

struct Candidate {
    name: String,
    rank_start: usize,
    scheduled: bool,
    encrypted: bool,
    entry: fs::DirEntry,
}

impl Candidate {
    fn rank(&self) -> &str {
        &self.name[self.rank_start..]
    }
}

fn backup_name(name: &str) -> Option<BackupName<'_>> {
    let base = name.strip_prefix("inpx-web-")?;
    let scheduled = base.starts_with("auto-");
    let rank = base
        .strip_prefix("auto-")
        .unwrap_or(base)
        .strip_prefix("backup-")?;
    let archive = rank.strip_suffix(".enc");
    let (date, suffix) = archive
        .unwrap_or(rank)
        .strip_suffix(".zip")?
        .rsplit_once("Z-")?;
    let (day, clock) = date.split_once('T')?;
    let day = day.as_bytes();
    if day.len() != 10
        || clock.is_empty()
        || !day.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
        || !clock
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
        || suffix.len() != 8
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(BackupName {
        rank,
        scheduled,
        encrypted: archive.is_some(),
    })
}

pub struct Vault {
    root: PathBuf,
    directory: PathBuf,
    policy: PathBuf,
}

impl Vault {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            directory: root.join("backups"),
            policy: root.join(POLICY_NAME),
        }
    }

    pub fn query(&self, request: Request) -> Value {
        // Application errors are returned separately from IPC errors.
        match self.execute(request) {
            Ok(value) => json!({ "value": value }),
            Err(error) => {
                let not_found = error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|io| io.kind() == io::ErrorKind::NotFound);
                json!({ "message": error.to_string(), "notFound": not_found })
            }
        }
    }

    pub fn update(&self, options: &Value) -> Result<()> {
        let patch = options
            .as_object()
            .ok_or("Некорректные настройки резервных копий")?;
        let replacement = match patch.get("password") {
            None => None,
            Some(Value::String(password)) if password.is_empty() => None,
            Some(Value::String(password)) => {
                let salt = random::<SALT_BYTES>()?;
                let derived = backup_crypto::derive(password.as_bytes(), &salt)?;
                Some(EncryptionPolicy {
                    key: wrap_key(&derived, &self.root.join("secret.key"))?,
                    salt: STANDARD.encode(salt),
                })
            }
            Some(_) => return Err("Некорректный пароль резервной копии".into()),
        };
        self.edit(|policy| policy.update(patch, replacement))?;
        Ok(())
    }

    pub(crate) fn archive_key(&self) -> Result<Option<ArchiveKey>> {
        let (policy, _) = Policy::open(&self.policy)?;
        if policy.key.is_empty() {
            return Ok(None);
        }
        Ok(Some(decode_key(
            &policy.key,
            &policy.salt,
            &self.root.join("secret.key"),
        )?))
    }

    pub(crate) fn open_archive(&self, name: &str) -> Result<File> {
        backup_name(name).ok_or(INVALID_NAME)?;
        let mut options = File::options();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            };
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let result = options.open(self.directory.join(name));
        #[cfg(unix)]
        if result
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::ELOOP))
        {
            return Err(UNAVAILABLE.into());
        }
        let file = result?;
        if !file.metadata()?.is_file() {
            return Err(UNAVAILABLE.into());
        }
        Ok(file)
    }

    pub fn execute(&self, request: Request) -> Result<Value> {
        match request {
            Request::Probe => Ok(json!(true)),
            Request::Policy { window } => {
                let (policy, _) = Policy::open(&self.policy)?;
                Ok(match window {
                    Some(window) if !policy.due(&window) => Value::Null,
                    _ => json!(policy),
                })
            }
            Request::Due { window } => Ok(json!(Policy::open(&self.policy)?.0.due(&window))),
            Request::Update { patch, key } => self.edit(|policy| policy.update(&patch, key)),
            Request::MarkCreated { timestamp: created } => self.edit(|policy| {
                if timestamp(&created).is_none() {
                    return Err("Некорректное время резервного копирования".into());
                }
                policy.last_scheduled_at = created;
                policy.last_error.clear();
                Ok(())
            }),
            Request::MarkFailed => self.edit(|policy| {
                policy.last_error = FAILED_COPY.into();
                Ok(())
            }),
            Request::List { scheduled } => Ok(json!(self.list(scheduled)?)),
            Request::Inspect { name } => {
                let (_, metadata) = self.checked_file(&name)?;
                Ok(json!(metadata.len()))
            }
            Request::Remove { name } => {
                let (file, _) = self.checked_file(&name)?;
                fs::remove_file(file)?;
                Ok(Value::Null)
            }
            Request::Rotate { keep } => {
                if !(1..=60).contains(&keep) {
                    return Err("Можно хранить от 1 до 60 автоматических копий".into());
                }
                for item in self.list(true)?.into_iter().skip(keep) {
                    match self
                        .checked_file(&item.name)
                        .and_then(|(file, _)| Ok(fs::remove_file(file)?))
                    {
                        Err(error)
                            if error
                                .downcast_ref::<io::Error>()
                                .is_some_and(|io| io.kind() == io::ErrorKind::NotFound) => {}
                        outcome => outcome?,
                    }
                }
                Ok(Value::Null)
            }
        }
    }

    pub fn archive_path(&self, name: &str) -> Result<PathBuf> {
        Ok(self.checked_file(name)?.0)
    }

    fn edit(&self, apply: impl FnOnce(&mut Policy) -> Result<()>) -> Result<Value> {
        let (mut policy, expected) = Policy::open(&self.policy)?;
        apply(&mut policy)?;
        fs::create_dir_all(&self.root)?;
        let mut file = tempfile::Builder::new()
            .prefix(".backup-vault-")
            .tempfile_in(&self.root)?;
        let contents = serde_json::to_vec(&policy)?;
        file.write_all(&contents)?;
        if atomic_file::publish(file, &self.policy, expected.as_deref())?.is_none() {
            return Err("Настройки резервного копирования изменились. Повторите операцию.".into());
        }
        Ok(Value::Null)
    }

    fn checked_file(&self, name: &str) -> Result<(PathBuf, Metadata)> {
        backup_name(name).ok_or(INVALID_NAME)?;
        let file = self.directory.join(name);
        let metadata = fs::symlink_metadata(&file)?;
        if !metadata.is_file() {
            return Err(UNAVAILABLE.into());
        }
        Ok((file, metadata))
    }

    fn list(&self, scheduled_only: bool) -> Result<Vec<BackupFile>> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if let Some(parsed) = backup_name(&name)
                && (!scheduled_only || parsed.scheduled)
            {
                candidates.push(Candidate {
                    rank_start: name.len() - parsed.rank.len(),
                    scheduled: parsed.scheduled,
                    encrypted: parsed.encrypted,
                    name,
                    entry,
                });
            }
        }
        candidates.sort_by(|a, b| b.rank().cmp(a.rank()));
        let mut result = Vec::new();
        for Candidate {
            name,
            scheduled,
            encrypted,
            entry,
            ..
        } in candidates.into_iter().take(MAX_LISTED)
        {
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.is_file() {
                return Err(UNAVAILABLE.into());
            }
            let modified_ms = match metadata.modified()?.duration_since(UNIX_EPOCH) {
                Ok(value) => i64::try_from(value.as_millis())?,
                Err(value) => -i64::try_from(value.duration().as_millis())?,
            };
            result.push(BackupFile {
                name,
                size: metadata.len(),
                modified_ms,
                scheduled,
                encrypted,
            });
        }
        result.sort_by_key(|file| Reverse(file.modified_ms));
        Ok(result)
    }
}

pub(crate) fn wrap_key(derived: &Sensitive<[u8; KEY_BYTES]>, master: &Path) -> Result<String> {
    let key = secret_store::key(master, true)?;
    let encoded = Sensitive(STANDARD.encode(derived.0).into_bytes());
    let encrypted = secret_store::seal(&key.0, &encoded.0)?;
    Ok(std::str::from_utf8(&encrypted.0)?.into())
}
