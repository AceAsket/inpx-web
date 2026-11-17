use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use inpx_catalog::{
    Result, configuration, directory_diagnostics,
    library_sources::{self, Source},
};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    State,
    admin_cache::Cache,
    delivery::{self, Channels, Delivery},
};
use crate::opds::standalone::Opds;
use crate::standalone_access::LiveOpds;

const EXPORT: &str = "libDir inpx librarySources inpxFilterFile extendedSearch bookReadLink
    loggingEnabled logServerStats logQueries loginRateLimitEnabled loginRateLimitWindowMs loginRateLimitMaxAttempts
    requireAuth allowAnonymousAccess proxyBindProfile authMode trustProxy proxyAuthHeader trustedProxyCidrs authExemptHealth
    metricsEnabled metricsPath metricsExemptAuth dbCacheSize dbCacheBudgetMb queryCacheMemMb queryCacheDiskMb
    maxFilesDirSize bookCacheSize coverCacheSize queryCacheEnabled queryCacheMemSize queryCacheDiskSize
    cacheCleanInterval cacheCleanSchedule cacheCleanTargetRatio adminEventLogEnabled adminEventLogSize inpxCheckInterval
    lowMemoryMode fullOptimization converterPaths fb2cngArgs fb2cngConfigPath bookTitleTemplate kindlingPath mobiEnabled
    server opds telegramShareEnabled telegramBotEnabled
    telegramIpFamily telegramProxyMode telegramProxyProtocol telegramProxyHost telegramProxyPort telegramProxyUsername
    telegramChatId telegramCaptionTemplate emailShareEnabled smtpHost smtpPort smtpSecure smtpUser emailFrom emailTo
    discovery uiDefaults";

const INTEGRATIONS: &[(&str, &str)] = &[
    ("telegramShareEnabled", "INPX_TELEGRAM_SHARE_ENABLED"),
    ("telegramBotEnabled", "INPX_TELEGRAM_BOT_ENABLED"),
    ("telegramBotToken", "TELEGRAM_BOT_TOKEN"),
    ("telegramIpFamily", "TELEGRAM_IP_FAMILY"),
    ("telegramProxyMode", "TELEGRAM_PROXY_MODE"),
    ("telegramProxyProtocol", "TELEGRAM_PROXY_PROTOCOL"),
    ("telegramProxyHost", "TELEGRAM_PROXY_HOST"),
    ("telegramProxyPort", "TELEGRAM_PROXY_PORT"),
    ("telegramProxyUsername", "TELEGRAM_PROXY_USERNAME"),
    ("telegramProxyPassword", "TELEGRAM_PROXY_PASSWORD"),
    ("telegramChatId", "TELEGRAM_CHAT_ID"),
    ("telegramCaptionTemplate", "TELEGRAM_CAPTION_TEMPLATE"),
    ("emailShareEnabled", "INPX_EMAIL_SHARE_ENABLED"),
    ("smtpHost", "SMTP_HOST"),
    ("smtpPort", "SMTP_PORT"),
    ("smtpSecure", "SMTP_SECURE"),
    ("smtpUser", "SMTP_USER"),
    ("smtpPass", "SMTP_PASS"),
    ("emailFrom", "EMAIL_FROM"),
    ("emailTo", "EMAIL_TO"),
];
const SECRETS: &[(&str, &str)] = &[
    ("telegramBotToken", "telegramBotTokenSet"),
    ("smtpPass", "smtpPassSet"),
    ("telegramProxyPassword", "telegramProxyPasswordSet"),
];
const CAPTION: &str = "${AUTHOR} - ${TITLE}";

pub(super) struct Settings {
    file: PathBuf,
    data: PathBuf,
    prefix: String,
    conversion_formats: Vec<&'static str>,
    source_options: Value,
    config: Mutex<Value>,
    extended_search: AtomicBool,
    restored: AtomicBool,
}

impl Settings {
    pub(super) fn new(
        file: PathBuf,
        data: PathBuf,
        prefix: &str,
        conversion_formats: Vec<&'static str>,
        config: Value,
        source_options: Value,
    ) -> Self {
        Self {
            file,
            data,
            prefix: prefix.trim_end_matches('/').into(),
            conversion_formats,
            source_options,
            extended_search: AtomicBool::new(config["extendedSearch"] != false),
            restored: AtomicBool::new(false),
            config: Mutex::new(config),
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        self.config.lock().expect("settings").clone()
    }

    pub(super) fn extended_search(&self) -> bool {
        self.extended_search.load(Ordering::Relaxed)
    }

    pub(super) fn event_policy(&self) -> (bool, usize) {
        let config = self.config.lock().expect("settings");
        (
            config["adminEventLogEnabled"] != false,
            super::diagnostics::integer(&config["adminEventLogSize"], 300).clamp(1, 2000),
        )
    }

    pub(super) fn save_event_policy(&self, enabled: bool, max: usize) -> Result<()> {
        let mut config = self
            .config
            .lock()
            .map_err(|_| "Хранилище настроек недоступно")?;
        if self.restored.load(Ordering::Relaxed) {
            return Err("Перезапустите приложение после восстановления резервной копии".into());
        }
        let mut next = config.clone();
        next["adminEventLogEnabled"] = enabled.into();
        next["adminEventLogSize"] = max.into();
        configuration::save(&self.file, &self.data, &next)?;
        *config = next;
        Ok(())
    }

    pub(super) fn with_backup<T>(
        &self,
        restore: bool,
        run: impl FnOnce(&Value) -> Result<T>,
    ) -> Result<T> {
        let current = self
            .config
            .lock()
            .map_err(|_| "Хранилище настроек недоступно")?;
        let result = run(&current)?;
        if restore {
            self.restored.store(true, Ordering::Relaxed);
        }
        Ok(result)
    }

    pub(super) fn validate_backup(&self, config: &Value) -> Result<()> {
        super::remote::Remote::address(&config["remoteLib"])?;
        for key in ["server", "opds", "uiDefaults", "discovery"] {
            if config.get(key).is_some_and(|value| !value.is_object()) {
                return Err(format!("Некорректное поле настроек {key}").into());
            }
        }
        if let Some(rows) = config.get("librarySources")
            && rows.as_array().is_none_or(|rows| !rows.is_empty())
        {
            normalized_sources(rows)?;
        }
        if let Some(schedule) = config["cacheCleanSchedule"].as_str() {
            super::admin_cache::validate_schedule(schedule.trim())?;
        }
        self.build_opds(config)?;
        Ok(())
    }

    pub(super) fn sources(&self) -> Result<Arc<Vec<Source>>> {
        let config = self.snapshot();
        let mut options = self.source_options.clone();
        if super::remote::Remote::address(&config["remoteLib"])?.is_some() {
            options["remote"] = json!({"inpx":self.data.join("remote.inpx"),"libDir":self.data});
        }
        options["configured"] = config["librarySources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into();
        for field in ["libDir", "inpx"] {
            if options[field].is_null() {
                options[field] = config[field].as_str().unwrap_or_default().into();
            }
        }
        Ok(Arc::new(library_sources::resolve(serde_json::from_value(
            options,
        )?)?))
    }

    pub(super) fn build_opds(&self, config: &Value) -> Result<LiveOpds> {
        let opds = &config["opds"];
        let tolino = match std::env::var("INPX_OPDS_COMPATIBILITY") {
            Ok(value) if value == "tolino" => true,
            Ok(value) if value == "standard" => false,
            Err(std::env::VarError::NotPresent) => opds["compatibility"] == "tolino",
            _ => return Err("INPX_OPDS_COMPATIBILITY: standard или tolino".into()),
        };
        let feeds = std::env::var("INPX_OPDS_FEEDS_FILE")
            .ok()
            .or_else(|| opds_string(config, "opdsFeedsFile"))
            .filter(|path| !path.trim().is_empty())
            .map(|path| self.data.join(path.trim()));
        let route = (opds["enabled"] != false).then(|| {
            Opds::new(
                opds["root"].as_str().unwrap_or("/opds"),
                &self.prefix,
                &format!("{}/book", self.prefix),
                tolino,
                &self.conversion_formats,
                feeds,
            )
        });
        LiveOpds::new(route, opds)
    }

    pub(super) fn dispatch(
        &self,
        state: &Arc<State>,
        action: &str,
        request: &Value,
        import_limit: usize,
    ) -> Result<Value> {
        match action {
            "admin-diagnose-library-source" => diagnose(&request["source"]),
            "admin-clean-cache" => {
                let kind = request["kind"]
                    .as_str()
                    .unwrap_or("all")
                    .trim()
                    .to_ascii_lowercase();
                state
                    .admin_cache
                    .clean(&self.snapshot(), &state.downloads, &kind, true)
            }
            "admin-clean-broken-covers" => state.admin_cache.purge(&state.downloads),
            "admin-rebuild-cover" => {
                let uid = request["bookUid"]
                    .as_str()
                    .map(str::trim)
                    .filter(|uid| !uid.is_empty())
                    .ok_or("bookUid is empty")?;
                state
                    .downloads
                    .rebuild_cover(uid, &state.index.catalogue, &state.index.sources())
            }
            "test-admin-integration" => {
                let kind = request["kind"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                let channels = state.delivery.channels();
                tokio::runtime::Handle::current().block_on(async {
                    match kind.as_str() {
                        "smtp" => channels.mail.verify().await,
                        "telegram" => channels
                            .telegram
                            .verify()
                            .await
                            .map_err(|error| error.to_string().into()),
                        _ => Err("Неизвестная интеграция".into()),
                    }
                })
            }
            "export-admin-settings" => Ok(
                json!({"exportedAt":OffsetDateTime::now_utc().format(&Rfc3339)?,
                "settings":export(&self.snapshot(),state)}),
            ),
            _ => {
                let mut current = self
                    .config
                    .lock()
                    .map_err(|_| "Хранилище настроек недоступно")?;
                if self.restored.load(Ordering::Relaxed) {
                    return Err(
                        "Перезапустите приложение после восстановления резервной копии".into(),
                    );
                }
                let patch = match action {
                    "update-admin-integrations" => {
                        integration_patch(&current, &request["integrations"])?
                    }
                    "update-admin-opds" => {
                        json!({"opds":opds_patch(&current["opds"],&request["opds"])?})
                    }
                    "update-admin-library-sources" => {
                        json!({"librarySources":normalized_sources(&request["sources"])?})
                    }
                    "update-admin-cache" => Cache::patch(&current, &request["cache"])?,
                    "import-admin-settings" => import(&current, &request["data"], import_limit)?,
                    _ => return Err("Неизвестная операция с настройками".into()),
                };
                let mut next = current.clone();
                let fields = patch.as_object().expect("settings patch");
                next.as_object_mut()
                    .expect("settings")
                    .extend(fields.clone());
                let opds = fields
                    .contains_key("opds")
                    .then(|| self.build_opds(&next))
                    .transpose()?;
                let telegram_changed = INTEGRATIONS
                    .iter()
                    .any(|(key, _)| key.starts_with("telegram") && next[*key] != current[*key]);
                let mail_changed = INTEGRATIONS
                    .iter()
                    .any(|(key, _)| !key.starts_with("telegram") && next[*key] != current[*key]);
                let channels = (telegram_changed || mail_changed).then(|| {
                    let mut channels = Channels::new(&self.data, &next);
                    if !mail_changed {
                        channels.mail = state.delivery.channels().mail;
                    }
                    channels
                });
                if !fields.is_empty() {
                    configuration::save(&self.file, &self.data, &next)?;
                }
                *current = next;
                self.extended_search
                    .store(current["extendedSearch"] != false, Ordering::Relaxed);
                if let Some(opds) = opds {
                    state.access.set_opds(opds);
                }
                if let Some(channels) = channels {
                    Delivery::configure(state, channels, telegram_changed);
                }
                if fields.keys().any(|key| cache_key(key)) {
                    state.admin_cache.changed.notify_one();
                }
                Ok(match action {
                    "update-admin-integrations" => {
                        json!({"integrations":integrations(&current,state)})
                    }
                    "update-admin-opds" => json!({"opds":opds_view(&current["opds"], true)}),
                    "update-admin-library-sources" => {
                        json!({"sources":current["librarySources"],"reindexRequired":true})
                    }
                    "update-admin-cache" => json!({"cache":Cache::settings(&current)}),
                    _ => {
                        json!({"success":true,"importedKeys":fields.keys().collect::<Vec<_>>(), "settings":export(&current,state),
                        "reindexRequired":fields.keys().any(|key|matches!(key.as_str(),"libDir"|"inpx"|"librarySources")),
                        "restartRequired":fields.keys().any(|key|restart_key(key))})
                    }
                })
            }
        }
    }
}

fn opds_string(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}
fn cache_key(key: &str) -> bool {
    key.starts_with("cacheClean")
        || matches!(key, "bookCacheSize" | "coverCacheSize" | "maxFilesDirSize")
}
fn restart_key(key: &str) -> bool {
    !cache_key(key)
        && !matches!(
            key,
            "opds"
                | "librarySources"
                | "libDir"
                | "inpx"
                | "uiDefaults"
                | "extendedSearch"
                | "bookReadLink"
        )
        && !INTEGRATIONS.iter().any(|(field, _)| *field == key)
}

pub(super) fn display_sources(config: &Value, state: &State) -> Value {
    config["librarySources"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .map_or_else(|| json!(&*state.index.sources()), |rows| json!(rows))
}

fn normalized_sources(input: &Value) -> Result<Value> {
    let rows = input
        .as_array()
        .ok_or("librarySources должен быть массивом")?;
    let mut sources = Vec::new();
    let mut enabled = HashSet::new();
    for (index, row) in rows.iter().enumerate() {
        if !row.is_object() {
            return Err("Некорректный источник библиотеки".into());
        }
        let primary = str_value(row, "inpx").trim();
        let inpx = if primary.is_empty() {
            str_value(row, "inpxFile").trim()
        } else {
            primary
        };
        let lib = str_value(row, "libDir").trim();
        if lib.is_empty() && inpx.is_empty() {
            continue;
        }
        if [lib, inpx].into_iter().any(|value| value.contains('\0')) {
            return Err("Некорректный путь источника".into());
        }
        let name = str_value(row, "name").trim();
        let fallback = format!("Library {}", index + 1);
        let name = if name.is_empty() {
            Path::new(inpx)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&fallback)
        } else {
            name
        };
        let id = str_value(row, "id").trim();
        let base = if id.is_empty() { name } else { id };
        let mut id = String::new();
        for ch in base.chars() {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                id.push(ch.to_ascii_lowercase());
            } else if !id.ends_with('-') {
                id.push('-');
            }
        }
        let id = id.trim_matches('-');
        let id = if id.is_empty() {
            format!("source-{}", index + 1)
        } else {
            id.chars().take(40).collect()
        };
        let active = row["enabled"] != false;
        if active && !enabled.insert(id.clone()) {
            return Err("Идентификаторы источников должны быть уникальны".into());
        }
        sources.push(
            json!({"id":id,"name":name,"libDir":lib,"inpx":inpx,"inpxFile":inpx,
            "type":if row["type"]=="folder"{"folder"}else{"inpx"},"enabled":active}),
        );
    }
    if enabled.is_empty() {
        return Err("Должен быть включён хотя бы один источник библиотеки".into());
    }
    Ok(sources.into())
}

pub(super) fn diagnose(source: &Value) -> Result<Value> {
    let lib = str_value(source, "libDir").trim();
    let mut inpx = str_value(source, "inpx").trim();
    if inpx.is_empty() {
        inpx = str_value(source, "inpxFile").trim();
    }
    let mut result = directory_diagnostics::diagnose(Path::new(lib), Path::new(inpx))?;
    result["libDirExists"] = Path::new(lib).is_dir().into();
    result["inpxExists"] = Path::new(inpx).is_file().into();
    Ok(result)
}

pub(super) fn opds_view(opds: &Value, placeholder: bool) -> Value {
    let password = !str_value(opds, "password").is_empty();
    let mut result = json!({"enabled":opds["enabled"]!=false,"root":opds["root"].as_str().unwrap_or("/opds"),
        "user":str_value(opds,"user"),"passwordSet":password});
    if let Some(mode) = opds.get("compatibility") {
        result["compatibility"] = mode.clone();
    }
    if placeholder {
        result["password"] = Value::from(if password { "__KEEP__" } else { "" });
    }
    result
}

fn opds_patch(current: &Value, patch: &Value) -> Result<Value> {
    let mut next = if current.is_object() {
        current.clone()
    } else {
        json!({})
    };
    if let Some(enabled) = patch.get("enabled") {
        next["enabled"] = (enabled != false).into();
    }
    if let Some(root) = patch.get("root") {
        let input = root
            .as_str()
            .ok_or("Некорректный путь OPDS")?
            .trim()
            .trim_matches('/');
        if input.contains(['?', '#', '\\', '%'])
            || input
                .chars()
                .any(|ch| ch.is_control() || ch.is_whitespace())
            || !input.is_empty()
                && input
                    .split('/')
                    .any(|segment| matches!(segment, "" | "." | ".."))
        {
            return Err("Некорректный путь OPDS".into());
        }
        next["root"] = if input.is_empty() {
            "/opds".to_owned()
        } else {
            format!("/{input}")
        }
        .into();
    }
    if let Some(user) = patch.get("user") {
        next["user"] = user.as_str().unwrap_or_default().trim().into();
    }
    if let Some(password) = patch.get("password").filter(|value| **value != "__KEEP__") {
        next["password"] = password.as_str().unwrap_or_default().into();
    }
    if let Some(mode) = patch.get("compatibility") {
        if !matches!(mode.as_str(), Some("standard" | "tolino")) {
            return Err("Режим OPDS должен быть standard или tolino".into());
        }
        next["compatibility"] = mode.clone();
    }
    if !str_value(&next, "password").is_empty() && str_value(&next, "user").is_empty() {
        return Err("Для общего OPDS-пароля нужно указать логин".into());
    }
    Ok(next)
}

fn integrations(config: &Value, state: &State) -> Value {
    let mut result = effective_integrations(config);
    for (key, status) in SECRETS {
        let configured = !str_value(&result, key).is_empty();
        result[*key] = if configured { "__KEEP__" } else { "" }.into();
        result[*status] = configured.into();
    }
    result["telegramBotStatus"] = state.delivery.telegram().status();
    result
}

pub(super) fn admin_integrations(config: &Value, state: &State) -> Value {
    integrations(config, state)
}

fn effective_integrations(config: &Value) -> Value {
    let mut result = json!({});
    for (key, env) in INTEGRATIONS {
        result[*key] = delivery::setting(config, env, key).into();
    }
    let telegram = !str_value(&result, "telegramBotToken").is_empty();
    let smtp = !str_value(&result, "smtpHost").is_empty();
    for (key, env, default) in [
        (
            "telegramShareEnabled",
            "INPX_TELEGRAM_SHARE_ENABLED",
            telegram,
        ),
        ("telegramBotEnabled", "INPX_TELEGRAM_BOT_ENABLED", false),
        ("emailShareEnabled", "INPX_EMAIL_SHARE_ENABLED", smtp),
        ("smtpSecure", "SMTP_SECURE", false),
    ] {
        result[key] = delivery::boolean(config, env, key, default).into();
    }
    for (key, default) in [
        ("telegramIpFamily", "auto"),
        ("telegramProxyMode", "system"),
        ("telegramProxyProtocol", "http"),
        ("telegramCaptionTemplate", CAPTION),
    ] {
        if str_value(&result, key).is_empty() {
            result[key] = default.into();
        }
    }
    result["smtpPort"] = str_value(&result, "smtpPort")
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .unwrap_or(587)
        .into();
    if let Ok(port) = str_value(&result, "telegramProxyPort").parse::<u16>() {
        result["telegramProxyPort"] = port.into();
    }
    result
}

fn integration_patch(config: &Value, patch: &Value) -> Result<Value> {
    let mut next = json!({});
    for (key, _) in INTEGRATIONS {
        let Some(value) = patch.get(key) else {
            continue;
        };
        next[*key] = match *key {
            "telegramShareEnabled" | "telegramBotEnabled" | "emailShareEnabled" | "smtpSecure" => {
                value
                    .as_bool()
                    .ok_or("Некорректный переключатель интеграции")?
                    .into()
            }
            "smtpPort" => port(value).unwrap_or(587).clamp(1, 65535).into(),
            "telegramProxyPort" if value.is_null() || value == "" => "".into(),
            "telegramProxyPort" => port(value)
                .filter(|port| (1..=65535).contains(port))
                .ok_or("Telegram прокси: порт от 1 до 65535")?
                .into(),
            field => {
                let value = value.as_str().unwrap_or_default();
                if SECRETS.iter().any(|(key, _)| *key == field) && value == "__KEEP__" {
                    continue;
                }
                if value.chars().any(char::is_control) {
                    return Err("Некорректное поле интеграции".into());
                }
                let mut value = if matches!(
                    field,
                    "smtpPass" | "telegramProxyPassword" | "telegramProxyUsername"
                ) {
                    value
                } else {
                    value.trim()
                }
                .to_owned();
                if matches!(
                    field,
                    "telegramIpFamily" | "telegramProxyMode" | "telegramProxyProtocol"
                ) {
                    value.make_ascii_lowercase();
                }
                if field == "telegramIpFamily" && matches!(value.as_str(), "" | "0") {
                    value = "auto".into();
                }
                if field == "telegramCaptionTemplate" && value.is_empty() {
                    value = CAPTION.into();
                }
                value.into()
            }
        };
    }
    let mut combined = config.clone();
    combined
        .as_object_mut()
        .expect("settings")
        .extend(next.as_object().expect("patch").clone());
    let effective = effective_integrations(&combined);
    validate_integration_fields(&effective)?;
    Ok(next)
}

fn validate_integration_fields(value: &Value) -> Result<()> {
    if !matches!(
        str_value(value, "telegramIpFamily"),
        "auto" | "0" | "4" | "6"
    ) {
        return Err("Семейство IP для Telegram: auto, 4 или 6".into());
    }
    let mode = str_value(value, "telegramProxyMode");
    if !matches!(mode, "system" | "direct" | "custom") {
        return Err("Режим Telegram прокси: direct, system или custom".into());
    }
    if !matches!(
        str_value(value, "telegramProxyProtocol"),
        "http" | "https" | "socks5" | "socks5h"
    ) {
        return Err("Протокол Telegram прокси: HTTP, HTTPS, SOCKS5 или SOCKS5h".into());
    }
    let host = str_value(value, "telegramProxyHost");
    if host.contains(['/', '@', '?', '#', '\\'])
        || host.chars().any(char::is_whitespace)
        || host.len() > 255
        || ["telegramProxyUsername", "telegramProxyPassword"]
            .into_iter()
            .any(|key| str_value(value, key).len() > 255)
    {
        return Err("Некорректные параметры Telegram прокси".into());
    }
    if mode == "custom"
        && (host.is_empty()
            || !port(&value["telegramProxyPort"]).is_some_and(|port| (1..=65535).contains(&port)))
    {
        return Err("Telegram прокси: укажите хост и порт".into());
    }
    Ok(())
}

fn export(config: &Value, state: &State) -> Value {
    let mut output = pick(config);
    output["opds"] = opds_view(&config["opds"], false);
    output["librarySources"] = display_sources(config, state);
    let delivery = effective_integrations(config);
    for key in EXPORT
        .split_whitespace()
        .filter(|key| INTEGRATIONS.iter().any(|(field, _)| field == key))
    {
        output[key] = delivery[key].clone();
    }
    output
}

fn pick(data: &Value) -> Value {
    Value::Object(
        EXPORT
            .split_whitespace()
            .filter_map(|key| data.get(key).map(|value| (key.to_owned(), value.clone())))
            .collect(),
    )
}

fn import(current: &Value, data: &Value, limit: usize) -> Result<Value> {
    if serde_json::to_vec(data)?.len() > limit {
        return Err("Файл настроек слишком большой".into());
    }
    let body = data.get("settings").unwrap_or(data);
    if !body.is_object() {
        return Err("Файл настроек имеет неверный формат".into());
    }
    let mut patch = pick(body);
    if patch.as_object().is_none_or(|patch| patch.is_empty()) {
        return Err("В файле не найдены настройки для восстановления".into());
    }
    if let Some(rows) = patch.get("librarySources") {
        // An empty list in a legacy export selects the default INPX paths.
        if rows.as_array().is_none_or(|rows| !rows.is_empty()) {
            patch["librarySources"] = normalized_sources(rows)?;
        }
    }
    if let Some(value) = patch.get("opds") {
        if !value.is_object() {
            return Err("Некорректные настройки OPDS".into());
        }
        patch["opds"] = opds_patch(&current["opds"], value)?;
    }
    if let Some(schedule) = patch.get("cacheCleanSchedule") {
        super::admin_cache::validate_schedule(
            schedule
                .as_str()
                .ok_or("Некорректное расписание кэша")?
                .trim(),
        )?;
    }
    for key in ["server", "uiDefaults", "discovery"] {
        if patch.get(key).is_some_and(|value| !value.is_object()) {
            return Err(format!("Некорректное поле настроек {key}").into());
        }
    }
    if INTEGRATIONS.iter().any(|(key, _)| patch.get(key).is_some()) {
        let normalized = integration_patch(current, &patch)?;
        patch.as_object_mut().expect("patch").extend(
            normalized
                .as_object()
                .expect("normalized integrations")
                .clone(),
        );
    }
    Ok(patch)
}

fn str_value<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn port(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse().ok())
}
