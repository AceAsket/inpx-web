use inpx_catalog::Result;
use serde_json::{Map, Value, json};

use super::State;

const MIB: u64 = 1024 * 1024;
pub(super) const FORMATS: &[&str] = &[
    "fb2", "epub", "epub3", "kepub", "kfx", "azw3", "azw8", "mobi", "pdf",
];
const RESOURCE_KEYS: &[&str] = &[
    "resourceTotal",
    "resourceImages",
    "resourceReviews",
    "resourceConversions",
    "resourceBackground",
    "resourceTaskTimeoutMs",
];

pub(super) const MEDIA_KEYS: &[&str] = &[
    "conversionEnabled",
    "conversionFormats",
    "mobiEnabled",
    "conversionQueueLimit",
    "conversionQueueTimeoutMs",
    "conversionTimeoutMs",
    "bookTitleTemplate",
    "fb2cngArgs",
    "fb2cngConfigPath",
];
pub(super) const COVER_KEYS: &[&str] = &["jxlDecoder", "coverMemoryMb", "bookFilenameTemplate"];
pub(super) const SPEECH_KEYS: &[&str] = &[
    "ttsEnabled",
    "ttsUrl",
    "ttsModel",
    "ttsApiKey",
    "ttsCacheSizeMb",
    "ttsTimeoutMs",
];

pub(super) const SERVICE_KEYS: &[&str] = &[
    "metricsEnabled",
    "metricsPath",
    "metricsToken",
    "metricsExemptAuth",
    "absEnabled",
    "absToken",
    "absPublicUrl",
    "absMaxResults",
];
pub(super) const LOGIN_KEYS: &[&str] = &[
    "loginRateLimitEnabled",
    "loginRateLimitMaxAttempts",
    "loginRateLimitWindowMs",
];
pub(super) const TRANSPORT_KEYS: &[&str] = &[
    "wsMessageLimitMb",
    "importLimitMb",
    "backupUploadLimitMb",
    "backupExpandedLimitMb",
];
const SECRET_KEYS: &[&str] = &["ttsApiKey", "absToken", "metricsToken"];

const FIELDS: &[(&str, &[&str])] = &[
    ("logLevel", &[]),
    ("logToFile", &[]),
    ("extendedSearch", &[]),
    ("bookReadLink", &[]),
    ("uiDefaults", &[]),
    ("inpxFilterFile", &[]),
    ("lowMemoryMode", &["INPX_LOW_MEMORY_MODE"]),
    ("wsMessageLimitMb", &["INPX_WS_MESSAGE_LIMIT_MB"]),
    ("importLimitMb", &["INPX_IMPORT_LIMIT_MB"]),
    ("backupUploadLimitMb", &["INPX_BACKUP_UPLOAD_LIMIT_MB"]),
    ("backupExpandedLimitMb", &["INPX_BACKUP_EXPANDED_LIMIT_MB"]),
    ("conversionEnabled", &["INPX_ENABLE_CONVERSION"]),
    ("conversionFormats", &["INPX_CONVERSION_FORMATS"]),
    ("mobiEnabled", &["INPX_MOBI_ENABLED"]),
    ("conversionQueueLimit", &["INPX_CONVERSION_QUEUE_LIMIT"]),
    (
        "conversionQueueTimeoutMs",
        &["INPX_CONVERSION_QUEUE_TIMEOUT_MS"],
    ),
    (
        "conversionTimeoutMs",
        &[
            "INPX_RESOURCE_TASK_TIMEOUT_MS",
            "INPX_CONVERSION_TIMEOUT_MS",
        ],
    ),
    ("bookTitleTemplate", &["INPX_BOOK_TITLE_TEMPLATE"]),
    ("fb2cngArgs", &["INPX_FB2CNG_ARGS"]),
    ("fb2cngConfigPath", &["INPX_FB2CNG_CONFIG", "FB2CNG_CONFIG"]),
    ("kosyncEnabled", &["INPX_KOSYNC_ENABLED"]),
    ("loginRateLimitEnabled", &["INPX_LOGIN_RATE_LIMIT_ENABLED"]),
    ("loginRateLimitMaxAttempts", &[]),
    ("loginRateLimitWindowMs", &[]),
    ("metricsEnabled", &["INPX_METRICS_ENABLED"]),
    ("metricsPath", &["INPX_METRICS_PATH"]),
    ("metricsToken", &["INPX_METRICS_TOKEN"]),
    ("metricsExemptAuth", &["INPX_METRICS_EXEMPT_AUTH"]),
    ("absEnabled", &["INPX_ABS_ENABLED"]),
    ("absToken", &["INPX_ABS_TOKEN"]),
    ("absPublicUrl", &["INPX_ABS_PUBLIC_URL"]),
    ("absMaxResults", &["INPX_ABS_MAX_RESULTS"]),
    ("bookFilenameTemplate", &["INPX_BOOK_FILENAME_TEMPLATE"]),
    ("onlineReaderEnabled", &[]),
    (
        "isbnMaxBookBytes",
        &["INPX_ISBN_MAX_BOOK_BYTES", "INPX_ISBN_MAX_BOOK_MB"],
    ),
    ("inpxCheckInterval", &[]),
    ("jxlDecoder", &["INPX_JXL_DECODER"]),
    ("coverMemoryMb", &[]),
    ("resourceTotal", &["INPX_RESOURCE_TOTAL"]),
    ("resourceImages", &["INPX_RESOURCE_IMAGES"]),
    ("resourceReviews", &["INPX_RESOURCE_REVIEWS"]),
    (
        "resourceConversions",
        &["INPX_RESOURCE_CONVERSIONS", "INPX_CONVERSION_CONCURRENCY"],
    ),
    ("resourceBackground", &["INPX_RESOURCE_BACKGROUND"]),
    ("resourceTaskTimeoutMs", &["INPX_RESOURCE_TASK_TIMEOUT_MS"]),
    ("resourceBenchEnabled", &["INPX_RESOURCE_BENCH_ENABLED"]),
    (
        "resourceBenchTimeoutMs",
        &["INPX_RESOURCE_BENCH_TIMEOUT_MS"],
    ),
    ("ttsEnabled", &["INPX_TTS_ENABLED"]),
    ("ttsUrl", &["INPX_TTS_URL"]),
    ("ttsModel", &["INPX_TTS_MODEL"]),
    ("ttsApiKey", &["INPX_TTS_API_KEY"]),
    ("ttsCacheSizeMb", &["INPX_TTS_CACHE_SIZE_MB"]),
    ("ttsTimeoutMs", &["INPX_TTS_TIMEOUT_MS"]),
];

pub(super) fn resource_key(key: &str) -> bool {
    RESOURCE_KEYS.contains(&key)
}

pub(super) fn known(key: &str) -> bool {
    FIELDS.iter().any(|(field, _)| *field == key)
}

pub(super) fn kosync_enabled(config: &Value) -> bool {
    std::env::var("INPX_KOSYNC_ENABLED")
        .map_or(config["kosyncEnabled"] != false, |value| value != "false")
}

pub(super) fn patch(value: &Value) -> Result<Value> {
    let input = value.as_object().ok_or("Укажите настройки сервера")?;
    let mut settings = Map::new();
    for (key, value) in input {
        let Some((_, vars)) = FIELDS.iter().find(|(field, _)| *field == key) else {
            return Err(format!("Неизвестная настройка {key}").into());
        };
        if let Some(variable) = vars.iter().find(|variable| std::env::var(variable).is_ok()) {
            return Err(format!("Параметр задан через {variable}").into());
        }
        if key == "logLevel"
            && let Some(flag) = super::logging::locked_by()
        {
            return Err(format!("Параметр задан через {flag}").into());
        }
        let number = |min, max| {
            value
                .as_u64()
                .filter(|value| (min..=max).contains(value))
                .map(Value::from)
        };
        let string = || {
            value
                .as_str()
                .filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        };
        let checked = match key.as_str() {
            "conversionEnabled"
            | "logToFile"
            | "extendedSearch"
            | "lowMemoryMode"
            | "mobiEnabled"
            | "onlineReaderEnabled"
            | "ttsEnabled"
            | "resourceBenchEnabled"
            | "kosyncEnabled"
            | "loginRateLimitEnabled"
            | "metricsEnabled"
            | "metricsExemptAuth"
            | "absEnabled" => value.as_bool().map(Value::from),
            "logLevel" => string()
                .filter(|value| matches!(*value, "error" | "warn" | "info"))
                .map(Value::from),
            "bookReadLink" => string()
                .map(str::trim)
                .filter(|address| {
                    address.is_empty()
                        || url::Url::parse(address).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https")
                                && url.host().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                        })
                })
                .map(Value::from),
            "uiDefaults" => value
                .as_object()
                .filter(|settings| {
                    settings.iter().all(|(key, value)| match key.as_str() {
                        "limit" => value
                            .as_u64()
                            .is_some_and(|value| (1..=120).contains(&value)),
                        "langDefault" => value.as_str().is_some_and(|value| {
                            value.len() <= 16
                                && value
                                    .bytes()
                                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        }),
                        "bookCardView" => matches!(value.as_str(), Some("cards" | "list")),
                        "darkTheme"
                        | "downloadAsZip"
                        | "showCounts"
                        | "showRates"
                        | "showInfo"
                        | "showGenres"
                        | "showDates"
                        | "showDeleted"
                        | "abCacheEnabled"
                        | "showJson"
                        | "showNewReleaseAvailable" => value.is_boolean(),
                        _ => false,
                    })
                })
                .map(|_| value.clone()),
            "fb2cngArgs" => value
                .as_array()
                .filter(|args| {
                    args.len() <= 64
                        && args
                            .iter()
                            .all(|arg| arg.as_str().is_some_and(|arg| arg.len() <= 4096))
                })
                .map(|_| value.clone()),
            "conversionFormats" => value
                .as_array()
                .filter(|formats| {
                    formats.len() <= FORMATS.len()
                        && formats.iter().all(|format| {
                            format.as_str().is_some_and(|name| FORMATS.contains(&name))
                        })
                })
                .map(|formats| {
                    json!(
                        FORMATS
                            .iter()
                            .copied()
                            .filter(|name| formats.iter().any(|format| format == name))
                            .collect::<Vec<_>>()
                    )
                }),
            "conversionQueueLimit" => number(0, 256),
            "wsMessageLimitMb" => number(1, 16),
            "importLimitMb" => number(1, 64),
            "backupUploadLimitMb" => number(1, 128),
            "backupExpandedLimitMb" => number(1, 256),
            "resourceTaskTimeoutMs" => number(1000, 3_600_000),
            "resourceBenchTimeoutMs" => number(10_000, 180_000),
            "conversionQueueTimeoutMs" | "conversionTimeoutMs" => number(1000, 3_600_000),
            "ttsTimeoutMs" => number(1, 3_600_000),
            "coverMemoryMb" => number(0, 1024),
            "inpxCheckInterval" => number(0, 10_080),
            "isbnMaxBookBytes" => number(MIB, 16 * 1024 * MIB),
            "jxlDecoder" => string()
                .filter(|mode| matches!(*mode, "native" | "djxl"))
                .map(Value::from),
            "loginRateLimitMaxAttempts" => number(1, 1000),
            "loginRateLimitWindowMs" => number(60_000, 86_400_000),
            "absMaxResults" => number(1, 20),
            "metricsPath" => string().and_then(|path| {
                let path = path.trim().trim_end_matches('/');
                path.strip_prefix('/')
                    .filter(|segments| {
                        segments.split('/').all(|part| {
                            !matches!(part, "" | "." | "..")
                                && part.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(byte, b'-' | b'_' | b'.')
                                })
                        })
                    })
                    .map(|_| Value::from(path))
            }),
            "ttsUrl" | "absPublicUrl" => string()
                .filter(|address| {
                    address.is_empty()
                        || url::Url::parse(address).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https")
                                && url.host().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                                && url.query().is_none()
                                && url.fragment().is_none()
                        })
                })
                .map(Value::from),
            key if SECRET_KEYS.contains(&key) && value == "__KEEP__" => continue,
            key if SECRET_KEYS.contains(&key) => string().map(|value| Value::from(value.trim())),
            "ttsCacheSizeMb" => number(64, 1024 * 1024),
            key if resource_key(key) && value.is_null() => Some(Value::Null),
            key if resource_key(key) => number(1, 16),
            _ => string().map(Value::from),
        };
        settings.insert(
            key.clone(),
            checked.ok_or_else(|| format!("Некорректное значение {key}"))?,
        );
    }
    Ok(Value::Object(settings))
}

pub(super) fn view(config: &Value, state: &State) -> Value {
    let mut settings = json!({
        "conversionEnabled":true, "conversionFormats":FORMATS, "mobiEnabled":true,
        "conversionQueueLimit":16, "conversionQueueTimeoutMs":120_000, "conversionTimeoutMs":120_000,
        "bookTitleTemplate":"", "bookFilenameTemplate":"", "onlineReaderEnabled":true,
        "inpxCheckInterval":60, "jxlDecoder":"native", "coverMemoryMb":64,
        "resourceTaskTimeoutMs":120_000, "resourceBenchEnabled":true, "resourceBenchTimeoutMs":60_000,
        "ttsEnabled":false, "ttsUrl":"", "ttsModel":"v5_6_ru", "ttsApiKey":"",
        "fb2cngArgs":[], "fb2cngConfigPath":"", "kosyncEnabled":true,
        "loginRateLimitEnabled":true, "loginRateLimitMaxAttempts":8, "loginRateLimitWindowMs":900_000,
        "metricsEnabled":false, "metricsPath":"/metrics", "metricsToken":"", "metricsExemptAuth":false,
        "absEnabled":false, "absToken":"", "absPublicUrl":"", "absMaxResults":10,
        "ttsCacheSizeMb":4096, "ttsTimeoutMs":3_600_000,
    });
    settings["logToFile"] = false.into();
    settings["extendedSearch"] = true.into();
    settings["bookReadLink"] = "".into();
    settings["uiDefaults"] = json!({});
    let mut locked = Map::new();
    for (key, vars) in FIELDS {
        if let Some(value) = config.get(*key).filter(|value| !value.is_null()) {
            settings[*key] = value.clone();
        }
        if let Some((name, value)) = vars
            .iter()
            .find_map(|name| std::env::var(name).ok().map(|value| (*name, value)))
        {
            locked.insert((*key).into(), name.into());
            settings[*key] = match *key {
                "conversionEnabled"
                | "mobiEnabled"
                | "resourceBenchEnabled"
                | "loginRateLimitEnabled" => (value != "false").into(),
                "ttsEnabled" | "metricsEnabled" | "metricsExemptAuth" | "absEnabled" => {
                    (value == "true").into()
                }
                "fb2cngArgs" => serde_json::from_str::<Value>(&value).unwrap_or_else(|_| json!([])),
                "conversionFormats" => json!(
                    value
                        .split(',')
                        .map(|item| item.trim().to_ascii_lowercase())
                        .collect::<Vec<_>>()
                ),
                _ if settings[*key].is_number() || resource_key(key) => value
                    .parse::<u64>()
                    .map_or_else(|_| settings[*key].clone(), Value::from),
                _ => value.into(),
            };
        }
    }
    let logging = super::logging::view();
    let active_index = state.index.files();
    let next_index = state.settings.index_files(config);
    let limits = state.socket.limits();
    settings["wsMessageLimitMb"] = ((limits.message as u64) / MIB).into();
    settings["importLimitMb"] = ((limits.import as u64) / MIB).into();
    settings["backupUploadLimitMb"] = ((limits.backup_upload as u64) / MIB).into();
    settings["backupExpandedLimitMb"] = ((limits.backup_expanded as u64) / MIB).into();
    settings["lowMemoryMode"] = next_index.low_memory.into();
    settings["inpxFilterFile"] = settings["inpxFilterFile"]
        .as_str()
        .unwrap_or_default()
        .into();
    settings["logLevel"] = logging["level"].clone();
    if let Some(locked_by) = logging["lockedBy"].as_str() {
        locked.insert("logLevel".into(), locked_by.into());
    }
    if !settings["conversionFormats"].is_array() {
        settings["conversionFormats"] = json!(FORMATS);
    }
    if !settings["fb2cngArgs"]
        .as_array()
        .is_some_and(|args| args.iter().all(Value::is_string))
    {
        settings["fb2cngArgs"] = json!([]);
    }
    settings["isbnMaxBookBytes"] = super::isbn_limit(config).into();
    settings["kosyncEnabled"] = kosync_enabled(config).into();
    let access = state.request_access.current();
    let rate = access.login_rate;
    settings["loginRateLimitEnabled"] = rate.enabled.into();
    settings["loginRateLimitMaxAttempts"] = rate.max_attempts.into();
    settings["loginRateLimitWindowMs"] = rate.window_ms.into();
    let services = &access.services;
    settings["metricsEnabled"] = services.metrics.enabled.into();
    settings["metricsPath"] = services.metrics.rules.path.clone().into();
    settings["metricsExemptAuth"] = services.metrics.rules.exempt.into();
    settings["absEnabled"] = services.metadata.enabled.into();
    settings["absPublicUrl"] = services
        .metadata
        .public_url
        .clone()
        .unwrap_or_default()
        .into();
    settings["absMaxResults"] = services.metadata.limit.into();
    if settings["jxlDecoder"] != "native" && settings["jxlDecoder"] != "" {
        settings["jxlDecoder"] = "djxl".into();
    } else {
        settings["jxlDecoder"] = "native".into();
    }
    for key in SECRET_KEYS {
        let key_set = settings[*key]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
        settings[*key] = if key_set { "__KEEP__" } else { "" }.into();
    }
    let tools = std::env::current_exe().ok().and_then(|exe| {
        exe.parent().map(|directory| {
            inpx_catalog::book_conversion::Conversion::tool_availability(config, directory)
        })
    });
    json!({
        "settings":settings, "locked":locked, "logging":logging, "formats":state.downloads.formats(),
        "indexOptions":{"filter":active_index.filter,"lowMemory":active_index.low_memory,
            "pending":active_index.filter != next_index.filter || active_index.low_memory != next_index.low_memory},
        "djxl":state.downloads.covers.has_djxl(), "ttsActive":state.speech.enabled(), "tools":tools,
        "limits":state.resources.policy().selected.limits
    })
}
