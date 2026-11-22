use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, ErrorKind};
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tempfile::TempDir;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::backup_archive::{self, INFO};
use crate::backup_transaction::{BackupTransaction, Entry};
use crate::backup_vault::{self, ArchiveKey, Vault};
use crate::crypto_support::{KEY_BYTES, Sensitive, hex, random};
use crate::reader_state::ReaderState;
use crate::{Result, configuration, file_stamp, profile_totp, progress_journal, secret_store};

#[derive(Clone)]
pub struct Backup {
    data: PathBuf,
    config: PathBuf,
    pub vault: Vault,
    pub upload_limit: u64,
    expanded_limit: u64,
}

pub struct Snapshot {
    folder: TempDir,
    created: OffsetDateTime,
    encryption: Option<ArchiveKey>,
}

pub struct Archive {
    folder: TempDir,
    inspection: Value,
}

impl Backup {
    pub fn with_limits(&self, upload_limit: u64, expanded_limit: u64) -> Self {
        Self {
            upload_limit,
            expanded_limit,
            ..self.clone()
        }
    }

    pub fn new(data: &Path, config: &Path, upload_limit: u64, expanded_limit: u64) -> Self {
        Self {
            data: data.into(),
            config: config.into(),
            vault: Vault::new(data),
            upload_limit,
            expanded_limit,
        }
    }

    pub fn snapshot(
        &self,
        reader: &ReaderState,
        stamp: &str,
        name: &str,
        version: &str,
    ) -> Result<Snapshot> {
        let folder = self.stage()?;
        let created = OffsetDateTime::now_utc();
        let target = folder.path();
        write_json(
            &target.join(INFO),
            &json!({
                "app":name, "version":version, "createdAt":created.format(&Rfc3339)?,
                "note":"Backup includes runtime config, secrets, user profiles, reading lists, reader progress and bookmarks. It does not include source book archives, generated search DB or caches.",
            }),
        )?;
        if !copy_optional(&self.config, &target.join(Entry::Config.name()))? {
            return Err("Файл настроек недоступен".into());
        }
        write_json(
            &target.join(Entry::Profiles.name()),
            &reader.backup_profiles(stamp)?,
        )?;
        let has_vault = copy_optional(
            &self.data.join(Entry::Vault.name()),
            &target.join(Entry::Vault.name()),
        )?;
        let secret = Entry::Secret.name();
        if !copy_optional(&self.data.join(secret), &target.join(secret))? && has_vault {
            // A vault without a password may exist before the installation generates a key.
            secret_store::key(&target.join(secret), true)?;
        }
        copy_optional(
            &self.data.join(Entry::Discovery.name()),
            &target.join(Entry::Discovery.name()),
        )?;
        Ok(Snapshot {
            folder,
            created,
            encryption: self.vault.archive_key()?,
        })
    }

    pub fn publish(&self, snapshot: Snapshot, scheduled: bool) -> Result<Value> {
        let created = snapshot.created.format(&Rfc3339)?;
        let time = snapshot.created;
        let timestamp = format!(
            "{}T{:02}-{:02}-{:02}-{:03}Z",
            time.date(),
            time.hour(),
            time.minute(),
            time.second(),
            time.millisecond()
        );
        let encrypted = snapshot.encryption.is_some();
        let marker = if scheduled { "auto-" } else { "" };
        let extension = if encrypted { ".zip.enc" } else { ".zip" };
        let name = format!(
            "inpx-web-{marker}backup-{timestamp}-{}{extension}",
            hex(&random::<4>()?)
        );
        let directory = self.data.join("backups");
        fs::create_dir_all(&directory)?;
        if !fs::symlink_metadata(&directory)?.file_type().is_dir() {
            return Err("Небезопасное хранилище резервных копий".into());
        }
        backup_archive::write_snapshot(
            snapshot.folder.path(),
            directory.join(&name),
            snapshot.created,
            snapshot.encryption.as_ref(),
            self.upload_limit,
            self.expanded_limit,
        )?;
        Ok(json!({"success":true,"fileName":name,"createdAt":created,"encrypted":encrypted}))
    }

    pub fn upload(&self, payload: &Value) -> Result<Archive> {
        let encoded = payload["contentBase64"]
            .as_str()
            .filter(|value| !value.is_empty())
            .or_else(|| payload["data"].as_str())
            .ok_or("Превышен размер бэкапа или неверный формат")?;
        if encoded.len() as u64 > self.upload_limit.div_ceil(3) * 4 + 1024 {
            return Err("Превышен размер бэкапа или неверный формат".into());
        }
        let encoded = if encoded.starts_with("data:") {
            encoded
                .split_once(',')
                .filter(|(header, _)| header.len() <= 205)
                .map(|(_, content)| content)
                .ok_or("Некорректный base64 бэкапа")?
        } else {
            encoded
        };
        let bytes = Sensitive(
            STANDARD
                .decode(encoded.trim())
                .map_err(|_| "Некорректный base64 бэкапа")?,
        );
        if bytes.0.is_empty() {
            return Err("Некорректный base64 бэкапа".into());
        }
        self.extract(Cursor::new(bytes.0.as_slice()), payload)
    }

    pub fn stored(&self, payload: &Value) -> Result<Archive> {
        let name = payload["name"].as_str().unwrap_or_default();
        let mut file = self.vault.open_archive(name)?;
        let expected = file_stamp::stamp(&file)?;
        let archive = self.extract(&mut file, payload)?;
        if file_stamp::stamp(&file)? != expected {
            return Err("Файл резервной копии изменился после проверки".into());
        }
        Ok(archive)
    }

    fn extract(
        &self,
        source: impl std::io::Read + std::io::Seek,
        payload: &Value,
    ) -> Result<Archive> {
        let folder = self.stage()?;
        let inspection = backup_archive::read_snapshot(
            source,
            payload["password"].as_str().unwrap_or_default().as_bytes(),
            payload["fingerprint"]
                .as_str()
                .filter(|value| !value.is_empty()),
            folder.path(),
            self.upload_limit,
            self.expanded_limit,
        )?;
        Ok(Archive { folder, inspection })
    }

    pub fn restore(
        &self,
        archive: Archive,
        current: &Value,
        profile: &ReaderState,
        prefix: &str,
        preview: bool,
        validate: impl FnOnce(&Value) -> Result<()>,
    ) -> Result<Value> {
        let dir = archive.folder.path();
        let info = read_json(&dir.join(INFO))?.ok_or("Отсутствует backup-info.json")?;
        let config = read_json(&dir.join(Entry::Config.name()))?;
        let restored_prefix = config.as_ref().map_or_else(
            || prefix.to_owned(),
            |config| {
                config["server"]["root"]
                    .as_str()
                    .unwrap_or_default()
                    .trim_end_matches('/')
                    .to_owned()
            },
        );
        let sources = config
            .as_ref()
            .and_then(|config| config["librarySources"].as_array())
            .into_iter()
            .flatten()
            .map(|source| {
                let name = source["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .or_else(|| source["id"].as_str())
                    .unwrap_or_default();
                json!({"name":name.chars().take(200).collect::<String>()})
            })
            .collect::<Vec<_>>();
        let mut profiles = read_json(&dir.join(Entry::Profiles.name()))?;
        let vault_file = dir.join(Entry::Vault.name());
        let vault = read_json(&vault_file)?;
        let mut files = Vec::new();
        let source_key = dir.join(Entry::Secret.name());
        let current_key = self.data.join(Entry::Secret.name());
        let includes_key = source_key.try_exists()?;
        if includes_key {
            let encoded = Sensitive(fs::read(&source_key)?);
            let key = Sensitive(
                STANDARD
                    .decode(encoded.0.trim_ascii())
                    .map_err(|_| "Некорректный ключ бэкапа")?,
            );
            if config.is_none() || key.0.len() != KEY_BYTES {
                return Err("Ключ бэкапа повреждён или отсутствует config.json".into());
            }
        }
        if vault
            .as_ref()
            .is_some_and(|value| value["version"] != 1 || !includes_key)
        {
            return Err("Настройки резервных копий повреждены".into());
        }
        if let Some(config) = config {
            if !includes_key {
                copy_optional(&current_key, &source_key)?;
            }
            configuration::stage_backup(config, current, &self.data, dir, validate)?;
            files.push(Entry::Config);
            if source_key.try_exists()? {
                files.insert(0, Entry::Secret);
            }
        }
        if let Some(vault) = vault {
            if let Some(key) = vault["key"].as_str().filter(|key| !key.is_empty()) {
                backup_vault::decode_key(
                    key,
                    vault["salt"].as_str().unwrap_or_default(),
                    &source_key,
                )?;
            }
            if vault["enabled"] == true && vault["key"].as_str().is_none_or(str::is_empty) {
                return Err("Настройки резервных копий повреждены".into());
            }
            files.push(Entry::Vault);
        } else if includes_key {
            let current_vault = self.data.join(Entry::Vault.name());
            if let Some(mut policy) = read_json(&current_vault)?
                && let Some(key) = policy["key"].as_str().filter(|key| !key.is_empty())
            {
                let key = backup_vault::decode_key(
                    key,
                    policy["salt"].as_str().unwrap_or_default(),
                    &current_key,
                )?;
                policy["key"] = backup_vault::wrap_key(&key.key, &source_key)?.into();
                write_json(&vault_file, &policy)?;
                files.push(Entry::Vault);
            }
        }
        if read_json(&dir.join(Entry::Discovery.name()))?.is_some() {
            files.push(Entry::Discovery);
        }
        let old_profiles =
            read_json(&self.data.join(Entry::Profiles.name()))?.unwrap_or(Value::Null);
        let key = if source_key.try_exists()? {
            &source_key
        } else {
            &current_key
        };
        let mut inspection = archive.inspection;
        inspection["version"] = info["version"].as_str().unwrap_or_default().into();
        inspection["createdAt"] = info["createdAt"].as_str().unwrap_or_default().into();
        inspection["sources"] = sources.into();
        inspection["restartRecommended"] = true.into();
        let mut counts = (0, 0, 0, 0);
        if let Some(data) = &mut profiles {
            counts = profile_counts(data)?;
            validate_totp(data, key)?;
            if !preview {
                prepare_profiles(data, &old_profiles, profile, &restored_prefix)?;
                write_json(&dir.join(Entry::Profiles.name()), data)?;
                files.push(Entry::Profiles);
            }
        } else if includes_key {
            validate_totp(&old_profiles, key)?;
        }
        if preview {
            for (key, value) in [
                ("users", counts.0),
                ("lists", counts.1),
                ("progress", counts.2),
                ("bookmarks", counts.3),
            ] {
                inspection[key] = value.into();
            }
            return Ok(inspection);
        }
        let restored = files.iter().map(|entry| entry.name()).collect::<Vec<_>>();
        BackupTransaction::new(&self.data, &self.config).restore(dir, files)?;
        Ok(
            json!({"success":true,"restored":restored,"restartRecommended":true,
            "message":"Полный бэкап восстановлен. Перезапустите приложение для применения всех настроек. При смене библиотек выполните переиндексацию."}),
        )
    }

    fn stage(&self) -> Result<TempDir> {
        Ok(tempfile::Builder::new()
            .prefix(".backup-work-")
            .tempdir_in(&self.data)?)
    }
}

fn copy_optional(source: &Path, target: &Path) -> Result<bool> {
    match File::open(source) {
        Ok(mut source) => {
            let mut output = tempfile::NamedTempFile::new_in(
                target.parent().ok_or("Missing backup directory")?,
            )?;
            std::io::copy(&mut source, output.as_file_mut())?;
            output.persist(target)?;
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn read_json(file: &Path) -> Result<Option<Value>> {
    let mut reader = match File::open(file) {
        Ok(file) => BufReader::new(file),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    use std::io::BufRead;
    if reader.fill_buf()?.starts_with(b"\xef\xbb\xbf") {
        reader.consume(3);
    }
    let data: Value = serde_json::from_reader(reader).map_err(|error| {
        format!(
            "Неверный формат {} (строка {})",
            file.file_name().unwrap_or_default().to_string_lossy(),
            error.line()
        )
    })?;
    if !data.is_object() {
        return Err(format!(
            "Неверный формат {}",
            file.file_name().unwrap_or_default().to_string_lossy()
        )
        .into());
    }
    Ok(Some(data))
}

fn write_json(file: &Path, value: &Value) -> Result<()> {
    let mut output =
        tempfile::NamedTempFile::new_in(file.parent().ok_or("Missing backup directory")?)?;
    serde_json::to_writer(output.as_file_mut(), value)?;
    output.persist(file)?;
    Ok(())
}

fn profile_counts(data: &Value) -> Result<(usize, usize, usize, usize)> {
    let users = data["users"]
        .as_array()
        .ok_or("Неверный формат reading-lists.json")?;
    let lists = data["lists"]
        .as_array()
        .ok_or("Неверный формат reading-lists.json")?;
    let mut ids = HashSet::new();
    for user in users {
        let id = user["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Некорректный профиль в резервной копии")?;
        if !ids.insert(id) {
            return Err("Повторяющийся профиль в резервной копии".into());
        }
    }
    let progress = users
        .iter()
        .filter_map(|row| row["readerProgress"].as_object())
        .map(|rows| rows.len())
        .sum();
    let bookmarks = users
        .iter()
        .filter_map(|row| row["readerBookmarks"].as_object())
        .flat_map(|rows| rows.values())
        .filter_map(Value::as_array)
        .map(Vec::len)
        .sum();
    Ok((users.len(), lists.len(), progress, bookmarks))
}

fn validate_totp(data: &Value, key: &Path) -> Result<()> {
    for user in data["users"].as_array().into_iter().flatten() {
        if let Some(totp) = profile_totp::State::from_stored(&user["profileTotp"]) {
            profile_totp::read_secret(key, user["id"].as_str().unwrap_or_default(), &totp)
                .map_err(|_| "Секреты двухфакторной защиты не соответствуют ключу бэкапа")?;
        }
    }
    Ok(())
}

fn prepare_profiles(
    data: &mut Value,
    old: &Value,
    reader: &ReaderState,
    prefix: &str,
) -> Result<()> {
    let generations = old["users"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|user| {
            Some((
                user["id"].as_str()?,
                generation(&user["readerProgressGeneration"]),
            ))
        })
        .collect::<HashMap<_, _>>();
    let updated = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let root = data.as_object_mut().expect("validated profiles");
    root.remove(progress_journal::CHECKPOINT_FIELD);
    for user in root
        .get_mut("users")
        .and_then(Value::as_array_mut)
        .expect("validated users")
    {
        let fields = user.as_object_mut().expect("validated user");
        let owner = fields["id"]
            .as_str()
            .expect("validated identity")
            .to_owned();
        let generation = fields
            .get("readerProgressGeneration")
            .map_or(0, generation)
            .max(*generations.get(owner.as_str()).unwrap_or(&0))
            + 1;
        fields.remove("profileTrustedDevices");
        fields.insert("readerProgressGeneration".into(), generation.into());
        fields.insert("readerProgressResetAt".into(), updated.as_str().into());
        if let Some(rows) = fields
            .get_mut("readerProgress")
            .and_then(Value::as_object_mut)
        {
            rows.retain(|_, row| row.is_object());
            for row in rows.values_mut() {
                row["generation"] = generation.into();
            }
        }
        if let Some(prefs) = fields
            .get_mut("readerPreferences")
            .filter(|value| value.is_object())
        {
            reader.restore_preferences(&owner, prefix, prefs)?;
        }
    }
    Ok(())
}

fn generation(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .unwrap_or_default()
        .min(9_007_199_254_740_990)
}
