use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::book_archive::Failure;
use crate::book_delivery::Cached;
use crate::{Result, atomic_file, book_cache, crypto_support, file_stamp};

const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_OUTPUT: u64 = 500 * 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Format {
    Epub,
    Epub3,
    Kepub,
    Kfx,
    Azw8,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Epub3 => "epub3",
            Self::Kepub => "kepub",
            Self::Kfx => "kfx",
            Self::Azw8 => "azw8",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Epub3 => "epub",
            Self::Kepub => "kepub.epub",
            _ => self.name(),
        }
    }

    fn argument(self) -> &'static str {
        match self {
            Self::Epub => "epub2",
            _ => self.name(),
        }
    }
}

const FORMATS: [Format; 5] = [
    Format::Epub,
    Format::Epub3,
    Format::Kepub,
    Format::Kfx,
    Format::Azw8,
];

pub struct Fb2cng {
    binary: PathBuf,
    formats: Vec<Format>,
    arguments: Vec<String>,
    yaml: Option<PathBuf>,
    timeout: Duration,
    mutex: Mutex<()>,
}

impl Fb2cng {
    pub fn new(config: &Value, exec_dir: &Path) -> Result<Option<Self>> {
        let enabled = std::env::var("INPX_ENABLE_CONVERSION")
            .map_or(config["conversionEnabled"] != false, |value| {
                value != "false"
            });
        if !enabled {
            return Ok(None);
        }
        let requested = std::env::var("INPX_CONVERSION_FORMATS").ok();
        let formats: Vec<_> = FORMATS
            .into_iter()
            .filter(|format| {
                requested.as_deref().map_or_else(
                    || {
                        config["conversionFormats"]
                            .as_array()
                            .is_none_or(|formats| {
                                formats.iter().any(|value| {
                                    value.as_str().is_some_and(|value| {
                                        value.trim().eq_ignore_ascii_case(format.name())
                                    })
                                })
                            })
                    },
                    |list| {
                        list.split(',')
                            .any(|value| value.trim().eq_ignore_ascii_case(format.name()))
                    },
                )
            })
            .collect();
        if formats.is_empty() {
            return Ok(None);
        }
        let Some(binary) = binary(config, exec_dir) else {
            return Ok(None);
        };
        let arguments = std::env::var("INPX_FB2CNG_ARGS")
            .ok()
            .map(|value| {
                if value.trim().is_empty() {
                    Ok(json!([]))
                } else {
                    serde_json::from_str(&value)
                }
            })
            .transpose()?
            .unwrap_or_else(|| {
                config
                    .get("fb2cngArgs")
                    .cloned()
                    .unwrap_or_else(|| json!([]))
            });
        let arguments: Vec<String> = serde_json::from_value(arguments)
            .map_err(|_| "fb2cngArgs должен быть массивом строк")?;
        for arg in &arguments {
            let flag = arg.split('=').next().unwrap_or_default();
            if arg.trim().is_empty()
                || arg.contains('\0')
                || matches!(
                    flag,
                    "--config" | "-c" | "--to" | "--output-file" | "-o" | "--overwrite" | "--"
                )
                || arg.starts_with("-c")
                || arg.starts_with("-o")
            {
                return Err(
                    "fb2cngArgs не должен переопределять формат, конфиг или пути вывода".into(),
                );
            }
        }
        let yaml = std::env::var_os("INPX_FB2CNG_CONFIG")
            .or_else(|| std::env::var_os("FB2CNG_CONFIG"))
            .or_else(|| config["fb2cngConfigPath"].as_str().map(Into::into))
            .filter(|value| !value.is_empty())
            .map(|value| std::path::absolute(PathBuf::from(value)))
            .transpose()?;
        let timeout = std::env::var("INPX_RESOURCE_TASK_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .or_else(|| config["conversionTimeoutMs"].as_u64())
            .unwrap_or(120_000)
            .clamp(1_000, 3_600_000);
        Ok(Some(Self {
            binary,
            formats,
            arguments,
            yaml,
            timeout: Duration::from_millis(timeout),
            mutex: Mutex::new(()),
        }))
    }

    pub fn formats(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.formats.iter().map(|format| format.name())
    }

    pub fn format(&self, name: &str) -> Option<Format> {
        self.formats
            .iter()
            .copied()
            .find(|format| format.name() == name)
    }

    pub fn convert(
        &self,
        cache: &Path,
        book: &Cached,
        source_ext: &str,
        format: Format,
    ) -> Result<PathBuf> {
        let settings = self
            .yaml
            .as_ref()
            .map(|file| bounded_config(file))
            .transpose()?;
        let binary = file_stamp::path_stamp(&self.binary)?.to_string();
        let config_hash = settings
            .as_ref()
            .map(|content| crypto_support::hex(&Sha256::digest(content)));
        let signature = json!([
            book.hash,
            source_ext.to_ascii_lowercase(),
            format.name(),
            self.binary,
            binary,
            self.arguments,
            self.yaml,
            config_hash
        ]);
        let key = Sha256::digest(serde_json::to_vec(&signature)?);
        let target = cache.join(format!(
            "{}.fbc-v1-{}-{}.{}",
            book.hash,
            format.name(),
            crypto_support::hex(&key[..12]),
            format.extension()
        ));
        if usable(&target)? {
            return Ok(target);
        }
        let _guard = self.mutex.lock().map_err(|_| "Конвертер книг недоступен")?;
        if usable(&target)? {
            return Ok(target);
        }
        let directory = tempfile::Builder::new()
            .prefix(".fb2cng-")
            .tempdir_in(cache)?;
        let input = directory.path().join("source.fb2");
        let original = book.reader_file(cache, source_ext)?;
        fs::copy(original, &input)?;
        let mut command = Command::new(&self.binary);
        if let Some(content) = settings {
            let file = directory.path().join("config.yaml");
            fs::write(&file, content)?;
            command.arg("--config").arg(&file);
        }
        let output = directory.path().join("out");
        fs::create_dir(&output)?;
        let cwd = self
            .yaml
            .as_deref()
            .and_then(Path::parent)
            .unwrap_or(directory.path());
        command
            .current_dir(cwd)
            .args(["convert", "--to", format.argument(), "--overwrite"])
            .args(&self.arguments)
            .arg(&input)
            .arg(&output);
        run(command, self.timeout)?;
        let suffix = format!(".{}", format.extension());
        let mut candidates = Vec::new();
        for item in fs::read_dir(&output)? {
            let item = item?;
            if item.file_type()?.is_file()
                && item
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(&suffix)
            {
                candidates.push(item.path());
            }
        }
        let [candidate] = candidates.as_slice() else {
            return Err(format!("fb2cng не создал один файл формата {}", format.name()).into());
        };
        let source =
            book_cache::regular_file(candidate, false)?.ok_or("Файл конвертации недоступен")?;
        let mut temporary = tempfile::NamedTempFile::new_in(cache)?;
        let size = io::copy(&mut source.take(MAX_OUTPUT + 1), temporary.as_file_mut())?;
        if size == 0 {
            return Err("Конвертер создал пустой файл".into());
        }
        if size > MAX_OUTPUT {
            return Err(Failure::Limit.into());
        }
        if atomic_file::publish(temporary, &target, None)?.is_none() && !usable(&target)? {
            return Err("Файл конвертации не опубликован".into());
        }
        Ok(target)
    }
}

fn usable(path: &Path) -> Result<bool> {
    let Some(file) = book_cache::regular_file(path, true)? else {
        return Ok(false);
    };
    if file.metadata()?.len() == 0 {
        return Err("Пустой файл в кэше конвертации".into());
    }
    file.set_modified(std::time::SystemTime::now())?;
    Ok(true)
}

fn bounded_config(path: &Path) -> Result<Vec<u8>> {
    let mut content = Vec::new();
    File::open(path)?
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut content)?;
    if content.len() as u64 > MAX_CONFIG {
        return Err("Конфигурация fb2cng превышает допустимый размер".into());
    }
    Ok(content)
}

fn binary(config: &Value, exec_dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "fbc.exe" } else { "fbc" };
    let resolve = |path: PathBuf| {
        path.is_file()
            .then(|| std::path::absolute(path).ok())
            .flatten()
    };
    let configured = ["fb2cng", "fbc"].iter().find_map(|key| {
        config["converterPaths"][*key]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    });
    if let Some(configured) = configured {
        let path = PathBuf::from(configured);
        if path.components().count() > 1 || path.is_absolute() {
            return resolve(path);
        }
        return std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .find_map(|dir| resolve(dir.join(configured)));
    }
    [exec_dir.join("bin").join(name), exec_dir.join(name)]
        .into_iter()
        .chain(std::env::var_os("PATH").into_iter().flat_map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .collect::<Vec<_>>()
        }))
        .find_map(resolve)
}

fn run(mut command: Command, timeout: Duration) -> Result<()> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("fb2cng завершился с ошибкой ({status})").into());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            state => {
                let _ = child.kill();
                let _ = child.wait();
                state?;
                return Err("Превышено время конвертации книги".into());
            }
        }
    }
}
