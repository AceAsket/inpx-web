use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use tempfile::NamedTempFile;

use crate::backup_transaction::BackupTransaction;
use crate::crypto_support::Sensitive;
use crate::secret_store::{self, Envelope};
use crate::startup_paths::{absolute, realpath};
use crate::{Result, atomic_file, upgrade_data};

type Settings = IndexMap<String, Value>;

#[derive(Deserialize)]
struct Fields {
    properties: Vec<String>,
    secrets: Vec<String>,
}

fn fields() -> &'static Fields {
    static FIELDS: OnceLock<Fields> = OnceLock::new();
    FIELDS.get_or_init(|| {
        serde_json::from_str(include_str!("../config-fields.json"))
            .expect("valid persisted configuration schema")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    pub file: PathBuf,
    pub default_data_dir: PathBuf,
    pub exec_dir: PathBuf,
    pub name: String,
    pub version: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Loaded {
    Ready {
        config: Option<Settings>,
        needs_save: bool,
    },
    Legacy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Save {
    file: PathBuf,
    data_dir: PathBuf,
    config: Value,
}

enum ReadConfig {
    Missing,
    Json(Value),
    Legacy,
}

pub fn load(options: Load, runtime: &str) -> Result<Loaded> {
    let initial = read(&options.file)?;
    let recovery_dir = match &initial {
        ReadConfig::Missing => &options.default_data_dir,
        ReadConfig::Json(config) => {
            match data_dir(config.get("dataDir"), &options.default_data_dir) {
                Some(directory) => directory,
                None => return Ok(Loaded::Legacy),
            }
        }
        ReadConfig::Legacy => return Ok(Loaded::Legacy),
    };
    if !BackupTransaction::new(recovery_dir, &options.file).recover_startup()? {
        return Ok(Loaded::Legacy);
    }
    let mut raw = match read(&options.file)? {
        ReadConfig::Missing => None,
        ReadConfig::Json(value) => Some(select(&value)),
        ReadConfig::Legacy => return Ok(Loaded::Legacy),
    };
    let mut needs_save = false;
    if let Some(config) = &mut raw {
        needs_save = relocate(&options, config)?;
    }
    let Some(directory) = data_dir(
        raw.as_ref().and_then(|config| config.get("dataDir")),
        &options.default_data_dir,
    ) else {
        return Ok(Loaded::Legacy);
    };
    let directory = directory.to_path_buf();
    if let Some(version) = &options.version
        && matches!(
            upgrade_data::snapshot(&directory, &options.file, version, runtime)?,
            upgrade_data::Upgrade::Legacy
        )
    {
        return Ok(Loaded::Legacy);
    }
    if let Some(config) = &mut raw {
        config.insert("dataDir".into(), serde_json::to_value(&directory)?);
        needs_save |= secrets(config, &directory, false)?;
        needs_save |= release_links(config);
    }
    Ok(Loaded::Ready {
        config: raw,
        needs_save,
    })
}

pub fn save_from(mut input: impl Read) -> Result<bool> {
    let mut bytes = Sensitive(Vec::new());
    input.read_to_end(&mut bytes.0)?;
    let request = match serde_json::from_slice::<Save>(&bytes.0) {
        Ok(request) => request,
        Err(_) if serde_json::from_slice::<&RawValue>(&bytes.0).is_ok() => return Ok(false),
        Err(_) => return Err("Invalid configuration save request".into()),
    };
    save(&request.file, &request.data_dir, &request.config)?;
    Ok(true)
}

pub fn save(file: &Path, directory: &Path, value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err("Invalid configuration save request".into());
    }
    let file = absolute(file)?;
    let expected = atomic_file::current_stamp(&file)?;
    let mut config = select(value);
    secrets(&mut config, directory, true)?;
    let parent = file.parent().ok_or("Missing configuration directory")?;
    fs::create_dir_all(parent)?;
    let mut staged = NamedTempFile::new_in(parent)?;
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    config.serialize(&mut serde_json::Serializer::with_formatter(
        &mut staged,
        formatter,
    ))?;
    if atomic_file::publish(staged, &file, expected.as_deref())?.is_none() {
        return Err("Файл настроек изменился, повторите сохранение".into());
    }
    Ok(())
}

pub(crate) fn stage_backup(
    mut config: Value,
    current: &Value,
    data: &Path,
    folder: &Path,
    validate: impl FnOnce(&Value) -> Result<()>,
) -> Result<()> {
    let fields = config
        .as_object_mut()
        .ok_or("Неверный формат config.json")?;
    fields.insert("dataDir".into(), serde_json::to_value(data)?);
    for name in ["tempDir", "logDir"] {
        if let Some(path) = current.get(name) {
            fields.insert(name.into(), path.clone());
        } else {
            fields.remove(name);
        }
    }
    let mut decoded = select(&config);
    secrets(&mut decoded, folder, false)?;
    let decoded = serde_json::to_value(decoded)?;
    validate(&decoded)?;
    save(&folder.join("config.json"), folder, &decoded)
}

fn read(file: &Path) -> Result<ReadConfig> {
    let bytes = match fs::read(file) {
        Ok(bytes) => Sensitive(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ReadConfig::Missing),
        Err(error) => return Err(error.into()),
    };
    let text = String::from_utf8_lossy(&bytes.0);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Null) => Err("Invalid config.json".into()),
        Ok(value) => Ok(ReadConfig::Json(value)),
        Err(_) if serde_json::from_str::<&RawValue>(text).is_ok() => Ok(ReadConfig::Legacy),
        Err(error) => Err(format!(
            "Invalid config.json at line {}, column {}",
            error.line(),
            error.column()
        )
        .into()),
    }
}

fn select(value: &Value) -> Settings {
    fields()
        .properties
        .iter()
        .filter_map(|name| {
            value
                .get(name.as_str())
                .map(|field| (name.clone(), field.clone()))
        })
        .collect()
}

fn data_dir<'a>(setting: Option<&'a Value>, fallback: &'a Path) -> Option<&'a Path> {
    match setting.filter(|setting| truthy(setting)) {
        Some(Value::String(name)) => Some(Path::new(name)),
        Some(_) => None,
        None => Some(fallback),
    }
}

fn relocate(options: &Load, config: &mut Settings) -> Result<bool> {
    let Some(directory) = config
        .get("dataDir")
        .and_then(Value::as_str)
        .filter(|dir| !dir.is_empty())
    else {
        return Ok(false);
    };
    let directory = Path::new(directory);
    let cwd = std::env::current_dir()?;
    if directory.has_root() || absolute(directory)? != cwd {
        return Ok(false);
    }
    let source = realpath(&cwd)?;
    let mut destination = absolute(&options.default_data_dir)?;
    fs::create_dir_all(&destination)?;
    if realpath(&destination)? == source {
        destination = options.exec_dir.join(format!(".{}", options.name));
        fs::create_dir_all(&destination)?;
    }
    let migrated = upgrade_data::migrate(&destination, &source, &absolute(&options.file)?)?;
    config.insert("dataDir".into(), serde_json::to_value(migrated)?);
    for (setting, folder) in [("tempDir", "tmp"), ("logDir", "log")] {
        if let Some(path) = config
            .get(setting)
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
        {
            let previous = absolute(Path::new(path))?;
            if previous == cwd || previous == cwd.join(folder) {
                config.insert(setting.into(), Value::String(String::new()));
            }
        }
    }
    Ok(true)
}

fn release_links(config: &mut Settings) -> bool {
    let mut changed = false;
    for (field, legacy, current) in [
        (
            "latestReleaseLink",
            "https://github.com/bookpauk/inpx-web/releases/latest",
            "https://github.com/AceAsket/inpx-web/releases/latest",
        ),
        (
            "checkReleaseLink",
            "https://api.github.com/repos/bookpauk/inpx-web/releases/latest",
            "https://api.github.com/repos/AceAsket/inpx-web/releases/latest",
        ),
    ] {
        let value = config.get(field);
        if !value.is_some_and(truthy) || value.and_then(Value::as_str) == Some(legacy) {
            config.insert(field.into(), Value::String(current.into()));
            changed = true;
        }
    }
    changed
}

fn secrets(config: &mut Settings, directory: &Path, encrypt: bool) -> Result<bool> {
    let file = directory.join("secret.key");
    let mut key = None;
    let mut needs_save = false;
    for path in &fields().secrets {
        let value = match path.split_once('.') {
            Some((object, property)) => config
                .get_mut(object)
                .and_then(|object| object.get_mut(property)),
            None => config.get_mut(path.as_str()),
        };
        let Some(value) = value else { continue };
        let text = Sensitive(if truthy(value) {
            crate::library_sources::js_string(value).into_bytes()
        } else {
            Vec::new()
        });
        let encrypted = text.0.starts_with(secret_store::PREFIX.as_bytes());
        if encrypt && (text.0.is_empty() || encrypted) {
            *value = Value::String(std::str::from_utf8(&text.0)?.into());
        } else if encrypt || encrypted {
            let envelope = (!encrypt).then(|| Envelope::parse(&text.0)).transpose()?;
            let key = match &key {
                Some(key) => key,
                None => key.insert(secret_store::key(&file, encrypt)?),
            };
            let data = if let Some(envelope) = envelope {
                envelope.open(&key.0)?
            } else {
                secret_store::seal(&key.0, &text.0)?
            };
            *value = Value::String(String::from_utf8_lossy(&data.0).into_owned());
        } else {
            needs_save |= !text.0.is_empty();
        }
    }
    Ok(needs_save)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
