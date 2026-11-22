use std::collections::HashMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::Result;
use log::{Level, Log, Metadata, Record};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const DEBUG_WINDOW: Duration = Duration::from_secs(15 * 60);
const FILE_LIMIT: u64 = 8 * 1024 * 1024;

static LOGGER: Logger = Logger(Mutex::new(Policy {
    level: Level::Info,
    debug_until: None,
    locked_by: None,
    file: None,
}));

struct Logger(Mutex<Policy>);

struct Policy {
    level: Level,
    debug_until: Option<Instant>,
    locked_by: Option<&'static str>,
    file: Option<PathBuf>,
}

impl Policy {
    fn effective(&self) -> Level {
        if self.debug_until.is_some_and(|until| until > Instant::now()) {
            Level::Debug
        } else {
            self.level
        }
    }
}

pub(super) fn level(value: &str) -> Option<Level> {
    match value {
        "error" => Some(Level::Error),
        "warn" => Some(Level::Warn),
        "info" => Some(Level::Info),
        "debug" => Some(Level::Debug),
        _ => None,
    }
}

pub(super) fn init(argument: Option<&str>, config: &Value, data: &Path) -> Result<()> {
    let env = std::env::var("INPX_LOG_LEVEL").ok();
    let (level, locked_by) = if let Some(value) = argument {
        (value, Some("--log-level"))
    } else if let Some(value) = env.as_deref() {
        (value, Some("INPX_LOG_LEVEL"))
    } else {
        (config["logLevel"].as_str().unwrap_or("info"), None)
    };
    let parsed_level = self::level(level);
    if locked_by.is_some() && parsed_level.is_none() {
        return Err("Уровень логирования: error, warn, info или debug".into());
    }
    let file = prepare_file(config, data);
    let file_failed = file.is_err();
    *LOGGER.0.lock().expect("logging policy") = Policy {
        level: parsed_level.unwrap_or(Level::Info),
        debug_until: None,
        locked_by,
        file: file.unwrap_or_default(),
    };
    log::set_logger(&LOGGER).map_err(|_| "Журнал уже настроен")?;
    log::set_max_level(log::LevelFilter::Debug);
    if parsed_level.is_none() {
        log::warn!(target: "inpx::logging", "Некорректный уровень в конфигурации, используется info");
    }
    if file_failed {
        log::error!(target: "inpx::logging", "Не удалось открыть файловый журнал, записи идут в консоль");
    }
    Ok(())
}

pub(super) fn locked_by() -> Option<&'static str> {
    LOGGER.0.lock().expect("logging policy").locked_by
}

pub(super) fn prepare_file(config: &Value, data: &Path) -> Result<Option<PathBuf>> {
    if config["logToFile"] != true {
        return Ok(None);
    }
    let dir = config["logDir"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map_or_else(|| data.join("log"), PathBuf::from);
    fs::create_dir_all(&dir)?;
    let file = dir.join("inpx-web.log");
    open(&file)?;
    Ok(Some(file))
}

pub(super) fn apply(level: Option<Level>, file: Option<Option<PathBuf>>) {
    let mut policy = LOGGER.0.lock().expect("logging policy");
    if let Some(level) = level {
        policy.level = level;
    }
    if let Some(file) = file {
        policy.file = file;
    }
}

pub(super) fn temporary_debug(enabled: bool) {
    LOGGER.0.lock().expect("logging policy").debug_until =
        enabled.then(|| Instant::now() + DEBUG_WINDOW);
}

pub(super) fn view() -> Value {
    let policy = LOGGER.0.lock().expect("logging policy");
    let remaining = policy.debug_until.map_or(Duration::ZERO, |until| {
        until.saturating_duration_since(Instant::now())
    });
    json!({"level":policy.level.as_str().to_ascii_lowercase(), "fileActive":policy.file.is_some(),
        "effectiveLevel":policy.effective().as_str().to_ascii_lowercase(),
        "debugRemainingMs":remaining.as_millis() as u64, "lockedBy":policy.locked_by})
}

pub(crate) fn warn_limited(target: &'static str, event: &'static str, details: fmt::Arguments<'_>) {
    if !log::log_enabled!(target: target, Level::Warn) {
        return;
    }
    static WARNINGS: LazyLock<Mutex<HashMap<&'static str, (Instant, u64)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let repeats = {
        let mut warnings = WARNINGS.lock().expect("log rate limit");
        let now = Instant::now();
        if let Some((last, repeats)) = warnings.get_mut(event) {
            if now.duration_since(*last) < Duration::from_secs(30) {
                *repeats = repeats.saturating_add(1);
                return;
            }
            *last = now;
            std::mem::take(repeats)
        } else {
            warnings.insert(event, (now, 0));
            0
        }
    };
    log::warn!(target: target, "{event} {details} suppressed={repeats}");
}

impl Log for Logger {
    fn enabled(&self, record: &Metadata<'_>) -> bool {
        record.target().starts_with("inpx::")
            && record.level() <= self.0.lock().expect("logging policy").effective()
    }

    fn log(&self, record: &Record<'_>) {
        if !record.target().starts_with("inpx::") {
            return;
        }
        let mut policy = self.0.lock().expect("logging policy");
        if record.level() > policy.effective() {
            return;
        }
        let time = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_default();
        let message: String = record
            .args()
            .to_string()
            .chars()
            .take(2000)
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect();
        let line = format!(
            "{time} {} [{}] {message}\n",
            record.level(),
            record.target()
        );
        let _ = io::stderr().lock().write_all(line.as_bytes());
        if let Some(file) = &policy.file
            && write(file, line.as_bytes()).is_err()
        {
            policy.file = None;
            eprintln!("{time} ERROR [inpx::logging] Файловый журнал отключён после ошибки записи");
        }
    }

    fn flush(&self) {}
}

fn open(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = open(path)?;
    if file.metadata()?.len().saturating_add(bytes.len() as u64) > FILE_LIMIT {
        drop(file);
        let previous = path.with_extension("log.1");
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(path, previous)?;
        file = open(path)?;
    }
    file.write_all(bytes)
}
