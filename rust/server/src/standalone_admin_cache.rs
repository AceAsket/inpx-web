use std::path::Path;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;

use inpx_catalog::{Result, directory_diagnostics};
use serde_json::{Value, json};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use tokio::sync::Notify;

use super::State;
use crate::standalone_download::Downloads;

const MIB: f64 = 1024.0 * 1024.0;
pub(super) struct Cache {
    cleaning: Mutex<()>,
    pub(super) changed: Notify,
}

impl Cache {
    pub(super) fn new() -> Self {
        Self {
            cleaning: Mutex::new(()),
            changed: Notify::new(),
        }
    }

    pub(super) fn settings(config: &Value) -> Value {
        let now = OffsetDateTime::now_utc();
        let next = next_run(config, now)
            .and_then(|date| date.format(&Rfc3339).ok())
            .unwrap_or_default();
        json!({
            "bookCacheSize":book_size(config),
            "coverCacheSize":cover_size(config),
            "cacheCleanInterval":interval_minutes(config).unwrap_or_default(),
            "cacheCleanSchedule":schedule_pattern(config).unwrap_or_default(),
            "cacheCleanNextRunAt":next,
            "cacheCleanServerTimeZone":std::env::var("TZ").ok().or_else(||
                (local_offset(now)==UtcOffset::UTC).then(|| "UTC".to_owned())).unwrap_or_default(),
            "cacheCleanTargetRatio":ratio(config)
        })
    }

    pub(super) fn patch(current: &Value, patch: &Value) -> Result<Value> {
        let mut result = json!({});
        for (input, field, current) in [
            ("bookCacheSizeMb", "bookCacheSize", book_size(current)),
            ("coverCacheSizeMb", "coverCacheSize", cover_size(current)),
        ] {
            if let Some(value) = patch.get(input) {
                let bytes = numeric(value)
                    .map(|value| (value.max(1.0) * MIB).round())
                    .unwrap_or(current);
                if !bytes.is_finite() {
                    return Err("Некорректный размер кэша".into());
                }
                result[field] = bytes.into();
                if field == "bookCacheSize" {
                    result["maxFilesDirSize"] = bytes.into()
                }
            }
        }
        if let Some(value) = numeric(&patch["cacheCleanIntervalMinutes"]) {
            result["cacheCleanInterval"] = value.round().max(0.0).into();
        }
        if let Some(value) = numeric(&patch["cacheCleanTargetPercent"]) {
            result["cacheCleanTargetRatio"] = (value / 100.0).clamp(0.1, 1.0).into();
        }
        if let Some(value) = patch.get("cacheCleanSchedule") {
            let schedule = value.as_str().ok_or("Некорректное расписание кэша")?.trim();
            validate_schedule(schedule)?;
            result["cacheCleanSchedule"] = schedule.into();
        }
        Ok(result)
    }

    pub(super) fn clean(
        &self,
        config: &Value,
        downloads: &Downloads,
        kind: &str,
        force: bool,
    ) -> Result<Value> {
        if !matches!(kind, "all" | "book" | "cover") {
            return Err("Неизвестный кэш для очистки".into());
        }
        let _guard = match self.cleaning.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Ok(json!({"skipped":true,"reason":"already-running"}));
            }
            Err(_) => return Err("Очистка кэша недоступна".into()),
        };
        let legacy = downloads.legacy_covers();
        let book_directory = downloads.cache();
        let ratio = ratio(config);
        let mut cleaned = Vec::new();
        let mut rotate = |id, title, directory: &Path, maximum: f64, filter: fn(&str) -> bool| {
            if maximum <= 0.0 {
                return;
            }
            let target = (maximum * ratio).round();
            let mut row = checked_directory(directory)
                .and_then(|()| {
                    directory_diagnostics::rotate_cache(directory, maximum, target, force, filter)
                })
                .unwrap_or_else(|error| json!({"error":error.to_string()}));
            row["id"] = Value::String(id);
            row["title"] = Value::String(title);
            row["dir"] = json!(directory);
            row["maxSize"] = json!(maximum);
            row["targetSize"] = json!(target);
            cleaned.push(row);
        };
        if kind != "cover" {
            rotate(
                "book".into(),
                "Книжный кэш".into(),
                book_directory,
                book_size(config),
                |name| !cover(name),
            );
        }
        if kind != "book" {
            rotate(
                "cover".into(),
                "Кэш обложек".into(),
                book_directory,
                cover_size(config),
                cover,
            );
            if legacy.is_dir() {
                rotate(
                    "cover".into(),
                    "Кэш обложек совместимости".into(),
                    &legacy,
                    cover_size(config),
                    |_| true,
                );
            }
        }
        Ok(json!({"cleaned":cleaned}))
    }

    pub(super) fn purge(&self, downloads: &Downloads) -> Result<Value> {
        let _guard = self
            .cleaning
            .lock()
            .map_err(|_| "Очистка кэша недоступна")?;
        let native = downloads.cache();
        let legacy = downloads.legacy_covers();
        checked_directory(native)?;
        checked_directory(&legacy)?;
        let a = directory_diagnostics::purge_cover_cache(native, true)?;
        let b = directory_diagnostics::purge_cover_cache(&legacy, false)?;
        let sum =
            |key: &str| a[key].as_u64().unwrap_or_default() + b[key].as_u64().unwrap_or_default();
        Ok(json!({"dir":native,"checked":sum("checked"),"removed":sum("removed")}))
    }

    pub(super) async fn schedule(state: Arc<State>) {
        loop {
            let notification = state.admin_cache.changed.notified();
            let now = OffsetDateTime::now_utc();
            let config = state.settings.snapshot();
            let Some(next) = next_run(&config, now) else {
                notification.await;
                continue;
            };
            let wait = Duration::try_from(next - now).unwrap_or_default();
            // Bound the sleep to re-evaluate changes to the server clock.
            if wait > Duration::from_secs(1800) {
                tokio::select! { _ = notification => (), _ = tokio::time::sleep(Duration::from_secs(1800)) => () }
                continue;
            }
            tokio::select! {
                _ = notification => continue,
                _ = tokio::time::sleep(wait) => (),
            }
            let worker = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let run = worker
                    .resources
                    .acquire(super::resources::Kind::Background)
                    .and_then(|_permit| {
                        worker
                            .admin_cache
                            .clean(&config, &worker.downloads, "all", false)
                    });
                if let Err(error) = run {
                    eprintln!("Cache rotation: {error}");
                }
            })
            .await;
        }
    }
}

fn checked_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() && !info.is_symlink() => Ok(()),
        Ok(_) => Err("Недопустимый каталог кэша".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn cover(name: &str) -> bool {
    name.ends_with(".reader-cover")
}

fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value| value.is_finite())
}

fn env_number(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn env_size(bytes: &str, megabytes: &str, default_mb: u64) -> f64 {
    let read = |key| std::env::var(key).ok()?.trim().parse::<u64>().ok();
    read(bytes).unwrap_or_else(|| {
        read(megabytes)
            .unwrap_or(default_mb)
            .saturating_mul(1024 * 1024)
    }) as f64
}

pub(super) fn book_size(config: &Value) -> f64 {
    numeric(&config["bookCacheSize"])
        .or_else(|| numeric(&config["maxFilesDirSize"]))
        .unwrap_or_else(|| env_size("INPX_BOOK_CACHE_SIZE", "INPX_BOOK_CACHE_SIZE_MB", 2048))
        .max(0.0)
}

pub(super) fn cover_size(config: &Value) -> f64 {
    numeric(&config["coverCacheSize"])
        .unwrap_or_else(|| env_size("INPX_COVER_CACHE_SIZE", "INPX_COVER_CACHE_SIZE_MB", 512))
        .max(0.0)
}

fn ratio(config: &Value) -> f64 {
    numeric(&config["cacheCleanTargetRatio"])
        .or_else(|| env_number("INPX_CACHE_CLEAN_TARGET_RATIO"))
        .unwrap_or(0.8)
        .clamp(0.1, 1.0)
}

fn interval_minutes(config: &Value) -> Option<f64> {
    numeric(&config["cacheCleanInterval"])
        .or_else(|| env_number("INPX_CACHE_CLEAN_INTERVAL_MINUTES"))
        .map(|minutes| minutes.max(0.0))
}

fn schedule_pattern(config: &Value) -> Option<&str> {
    match config.get("cacheCleanSchedule") {
        Some(value) => Some(value.as_str().unwrap_or_default().trim()),
        None if interval_minutes(config).is_none() => Some("0 0 * * *"),
        None => None,
    }
}

pub(super) fn validate_schedule(schedule: &str) -> Result<()> {
    if !schedule.is_empty() {
        Cron::parse(schedule)?;
    }
    Ok(())
}

fn local_offset(instant: OffsetDateTime) -> UtcOffset {
    UtcOffset::local_offset_at(instant).unwrap_or(UtcOffset::UTC)
}

fn next_run(config: &Value, now: OffsetDateTime) -> Option<OffsetDateTime> {
    if let Some(pattern) = schedule_pattern(config) {
        return (!pattern.is_empty())
            .then(|| Cron::parse(pattern).ok()?.next(now))
            .flatten();
    }
    let interval = (interval_minutes(config)? * 60.0).round() as i64;
    if interval <= 0 {
        return None;
    }
    let local = now
        .unix_timestamp()
        .checked_add(i64::from(local_offset(now).whole_seconds()))?;
    now.checked_add(time::Duration::seconds(
        interval - local.rem_euclid(interval),
    ))
}

struct Cron {
    minute: u64,
    hour: u64,
    day: u64,
    month: u64,
    week: u64,
    day_all: bool,
    week_all: bool,
}

impl Cron {
    fn parse(schedule: &str) -> Result<Self> {
        let parts = schedule.split_whitespace().collect::<Vec<_>>();
        let [minute, hour, day, month, week] = parts.as_slice() else {
            return Err("Расписание кэша должно содержать 5 полей cron".into());
        };
        Ok(Self {
            minute: field(minute, 0, 59, &[], false)?,
            hour: field(hour, 0, 23, &[], false)?,
            day: field(day, 1, 31, &[], false)?,
            month: field(
                month,
                1,
                12,
                &[
                    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                    "dec",
                ],
                false,
            )?,
            week: field(
                week,
                0,
                7,
                &["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
                true,
            )?,
            day_all: *day == "*",
            week_all: *week == "*",
        })
    }

    fn next(&self, now: OffsetDateTime) -> Option<OffsetDateTime> {
        let mut instant =
            OffsetDateTime::from_unix_timestamp(now.unix_timestamp().div_euclid(60) * 60 + 60)
                .ok()?;
        let mut offset = local_offset(instant);
        for minute in 0..366 * 24 * 60 {
            if minute % 60 == 0 {
                offset = local_offset(instant);
            }
            let local = instant.to_offset(offset);
            let day = contains(self.day, local.day());
            let week = contains(self.week, local.weekday().number_days_from_sunday());
            let matches_day = match (self.day_all, self.week_all) {
                (true, true) => true,
                (true, false) => week,
                (false, true) => day,
                (false, false) => day || week,
            };
            if contains(self.month, local.month() as u8)
                && matches_day
                && contains(self.hour, local.hour())
                && contains(self.minute, local.minute())
            {
                return Some(instant);
            }
            instant += time::Duration::minutes(1);
        }
        None
    }
}

fn contains(bits: u64, value: u8) -> bool {
    bits & (1 << value) != 0
}

fn field(input: &str, min: u8, max: u8, aliases: &[&str], sunday: bool) -> Result<u64> {
    let invalid = || format!("Некорректное поле cron: {input}");
    let value = |value: &str| {
        aliases
            .iter()
            .position(|alias| value.eq_ignore_ascii_case(alias))
            .map(|index| index as u8 + min)
            .or_else(|| value.parse::<u8>().ok())
            .filter(|value| (min..=max).contains(value))
    };
    let mut bits = 0;
    for item in input.split(',') {
        let (range, step) = item
            .split_once('/')
            .map_or((item, Some(1)), |(range, step)| {
                (range, step.parse::<usize>().ok().filter(|step| *step > 0))
            });
        let step = step.ok_or_else(invalid)?;
        let (from, to) = if range == "*" {
            (min, if sunday { 6 } else { max })
        } else if let Some((start, end)) = range.split_once('-') {
            (
                value(start).ok_or_else(invalid)?,
                value(end).ok_or_else(invalid)?,
            )
        } else {
            let number = value(range).ok_or_else(invalid)?;
            (number, number)
        };
        if from > to {
            return Err(invalid().into());
        }
        for value in (from..=to).step_by(step) {
            bits |= 1 << if sunday && value == 7 { 0 } else { value };
        }
    }
    Ok(bits)
}
