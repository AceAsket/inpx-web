use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use crate::request_access::{BrowserConnection, LIVE_FIELDS, split_proxy_cidrs};
use crate::standalone_access::LiveOpds;

const EXPORT: &str = "libDir inpx librarySources inpxFilterFile extendedSearch bookReadLink isbnThreads
    loggingEnabled logServerStats logQueries logLevel logToFile loginRateLimitEnabled loginRateLimitWindowMs loginRateLimitMaxAttempts
    requireAuth allowAnonymousAccess proxyBindProfile authMode trustProxy proxyAuthHeader trustedProxyCidrs adminDirectOnly adminAllowedCidrs authExemptHealth
    metricsEnabled metricsPath metricsExemptAuth dbCacheSize dbCacheBudgetMb queryCacheMemMb queryCacheDiskMb
    maxFilesDirSize bookCacheSize coverCacheSize queryCacheEnabled queryCacheMemSize queryCacheDiskSize
    cacheCleanInterval cacheCleanSchedule cacheCleanTargetRatio adminEventLogEnabled adminEventLogSize inpxCheckInterval
    lowMemoryMode fullOptimization converterPaths fb2cngArgs fb2cngConfigPath bookTitleTemplate kindlingPath mobiEnabled
    server opds telegramShareEnabled telegramBotEnabled
    telegramIpFamily telegramProxyMode telegramProxyProtocol telegramProxyHost telegramProxyPort telegramProxyUsername
    telegramChatId telegramCaptionTemplate emailShareEnabled smtpHost smtpPort smtpSecure smtpUser emailFrom emailTo
    discovery uiDefaults resourceTotal resourceImages resourceReviews resourceConversions resourceBackground
    resourceTaskTimeoutMs resourceBenchEnabled resourceBenchTimeoutMs
    isbnMaxBookBytes conversionEnabled conversionFormats conversionQueueLimit conversionQueueTimeoutMs conversionTimeoutMs
    bookFilenameTemplate onlineReaderEnabled jxlDecoder coverMemoryMb ttsEnabled ttsUrl ttsModel ttsCacheSizeMb ttsTimeoutMs
    kosyncEnabled opdsFeedsFile absEnabled absPublicUrl absMaxResults
    wsMessageLimitMb importLimitMb backupUploadLimitMb backupExpandedLimitMb";

const INTEGRATIONS: &[(&str, &str)] = &[
    ("telegramShareEnabled", "INPX_TELEGRAM_SHARE_ENABLED"),
    ("telegramBotEnabled", "INPX_TELEGRAM_BOT_ENABLED"),
    ("telegramBotToken", "TELEGRAM_BOT_TOKEN"),
    ("telegramApiMode", "INPX_TELEGRAM_API_MODE"),
    ("telegramApiUrl", "INPX_TELEGRAM_API_URL"),
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
    source_options: Value,
    config: Mutex<Value>,
    extended_search: AtomicBool,
    online_reader: AtomicBool,
    restored: AtomicBool,
    pub(super) index_interval: tokio::sync::watch::Sender<Option<Duration>>,
}

impl Settings {
    pub(super) fn index_files(
        &self,
        config: &Value,
    ) -> inpx_catalog::standalone_catalogue::CatalogueFiles {
        inpx_catalog::standalone_catalogue::CatalogueFiles {
            data: self.data.clone(),
            filter: config["inpxFilterFile"]
                .as_str()
                .filter(|path| !path.is_empty())
                .map_or_else(|| self.file.with_file_name("filter.json"), PathBuf::from),
            low_memory: super::env_bool("INPX_LOW_MEMORY_MODE")
                .unwrap_or(config["lowMemoryMode"] == true),
        }
    }

    pub(super) fn new(
        file: PathBuf,
        data: PathBuf,
        prefix: &str,
        config: Value,
        source_options: Value,
    ) -> Self {
        Self {
            file,
            data,
            prefix: prefix.trim_end_matches('/').into(),
            source_options,
            extended_search: AtomicBool::new(config["extendedSearch"] != false),
            online_reader: AtomicBool::new(config["onlineReaderEnabled"] != false),
            restored: AtomicBool::new(false),
            index_interval: tokio::sync::watch::Sender::new(super::index::interval(
                &config["inpxCheckInterval"],
            )),
            config: Mutex::new(config),
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        self.config.lock().expect("settings").clone()
    }

    pub(super) fn extended_search(&self) -> bool {
        self.extended_search.load(Ordering::Relaxed)
    }

    pub(super) fn online_reader(&self) -> bool {
        self.online_reader.load(Ordering::Relaxed)
    }

    pub(super) fn isbn_threads(&self) -> Option<usize> {
        super::isbn::thread_setting(&self.config.lock().expect("settings")["isbnThreads"])
            .unwrap_or_default()
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
        self.build_opds(config, &[])?;
        Ok(())
    }

    pub(super) fn sources(&self, config: &Value) -> Result<Arc<Vec<Source>>> {
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

    fn source_override(&self, config: &Value) -> Option<&str> {
        let options = &self.source_options;
        if super::remote::Remote::address(&config["remoteLib"])
            .is_ok_and(|address| address.is_some())
        {
            Some("Удалённая библиотека")
        } else if library_sources::has_environment_sources(
            options["environment"].as_str().unwrap_or_default(),
        ) {
            options["environmentName"].as_str()
        } else if options["argument"]
            .as_str()
            .is_some_and(|argument| !argument.is_empty())
        {
            Some("--library-sources")
        } else {
            None
        }
    }

    pub(super) fn source_view(&self, config: &Value) -> Value {
        let origin = self.source_override(config);
        let options = &self.source_options;
        json!({
            "override":origin,
            "fallback":if origin.is_none() && config["librarySources"].as_array().is_none_or(Vec::is_empty) {
                ["libDir", "inpx"].into_iter().filter_map(|field| {
                    let value = options.get(field)?.as_str()?;
                    let name = options.get(format!("{field}Source"))?.as_str()?;
                    Some(json!({"from":name,"value":value}))
                }).collect::<Vec<_>>()
            } else { Vec::new() }
        })
    }

    pub(super) fn build_opds(&self, config: &Value, formats: &[&str]) -> Result<LiveOpds> {
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
                formats,
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
        connection: &BrowserConnection,
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
                if !connection.valid(&state.request_access.current()) {
                    return Err("Правила доступа изменились. Подключитесь заново".into());
                }
                let debug = if action == "update-admin-runtime" {
                    request
                        .get("debugLogging")
                        .map(|value| {
                            if let Some(flag) = super::logging::locked_by() {
                                Err(format!("Уровень логирования задан через {flag}"))
                            } else {
                                value
                                    .as_bool()
                                    .ok_or_else(|| "Некорректный режим диагностики".into())
                            }
                        })
                        .transpose()?
                } else {
                    None
                };
                let mut patch = match action {
                    "update-admin-integrations" => {
                        integration_patch(&current, &request["integrations"])?
                    }
                    "update-admin-opds" => {
                        let request = &request["opds"];
                        let mut patch = json!({"opds":opds_patch(&current["opds"],request)?});
                        if let Some(file) = request.get("feedsFile") {
                            if std::env::var("INPX_OPDS_FEEDS_FILE").is_ok() {
                                return Err("Параметр задан через INPX_OPDS_FEEDS_FILE".into());
                            }
                            let file = file
                                .as_str()
                                .map(str::trim)
                                .filter(|name| {
                                    name.len() <= 4096 && !name.chars().any(char::is_control)
                                })
                                .ok_or("Некорректный путь к файлу подборок")?;
                            patch["opdsFeedsFile"] = file.into();
                        }
                        patch
                    }
                    "update-admin-access" => live_access_patch(&request["access"])?,
                    "update-admin-runtime" => super::runtime::patch(&request["settings"])?,
                    "update-admin-library-sources" => {
                        if let Some(source) = self.source_override(&current) {
                            return Err(
                                format!("Список источников задан при запуске ({source})").into()
                            );
                        }
                        json!({"librarySources":normalized_sources(&request["sources"])?})
                    }
                    "set-admin-resource-profile" => {
                        let profile = request
                            .get("profile")
                            .filter(|value| value.is_null() || value.is_string())
                            .ok_or("Выберите профиль сервера")?;
                        json!({"resourceProfile":profile})
                    }
                    "set-admin-isbn-threads" => {
                        let value = request.get("workers").ok_or("Укажите число потоков ISBN")?;
                        json!({"isbnThreads":super::isbn::thread_setting(value)?})
                    }
                    "update-admin-cache" => Cache::patch(&current, &request["cache"])?,
                    "import-admin-settings" => {
                        let mut patch = import(&current, &request["data"], import_limit)?;
                        let fields = patch.as_object_mut().expect("imported settings");
                        let runtime: serde_json::Map<_, _> = fields
                            .iter()
                            .filter(|(key, value)| {
                                key.as_str() != "uiDefaults"
                                    && super::runtime::known(key)
                                    && current.get(*key) != Some(*value)
                            })
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect();
                        let validated = super::runtime::patch(&Value::Object(runtime))?;
                        fields.extend(validated.as_object().expect("runtime patch").clone());
                        patch
                    }
                    _ => return Err("Неизвестная операция с настройками".into()),
                };
                if action == "update-admin-runtime"
                    && let Some(defaults) = patch["uiDefaults"].as_object()
                {
                    let mut merged = current["uiDefaults"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default();
                    merged.extend(defaults.clone());
                    patch["uiDefaults"] = Value::Object(merged);
                }
                let mut next = current.clone();
                let fields = patch.as_object().expect("settings patch");
                next.as_object_mut()
                    .expect("settings")
                    .extend(fields.clone());
                if let Some(path) = fields.get("inpxFilterFile").and_then(Value::as_str)
                    && !path.is_empty()
                    && current["inpxFilterFile"] != path
                {
                    inpx_catalog::standalone_catalogue::CatalogueFiles::validate_filter(Path::new(
                        path,
                    ))
                    .map_err(|error| format!("Фильтр INPX не принят: {error}"))?;
                }
                let access_patch = Value::Object(
                    fields
                        .iter()
                        .filter(|(key, value)| {
                            LIVE_FIELDS.iter().any(|(name, _)| key.as_str() == *name)
                                && current.get(*key) != Some(*value)
                        })
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                );
                if fields.get("jxlDecoder").is_some_and(|mode| mode == "djxl")
                    && current["jxlDecoder"] != "djxl"
                    && !state.downloads.covers.has_djxl()
                {
                    return Err("Утилита djxl недоступна на сервере".into());
                }
                let services = fields
                    .keys()
                    .any(|key| super::runtime::SERVICE_KEYS.contains(&key.as_str()))
                    .then(|| crate::request_access::Services::new(&next, &self.prefix));
                let active_access = state.request_access.current();
                let active_metrics = &active_access.services.metrics;
                let metrics = services
                    .as_ref()
                    .map_or(active_metrics, |services| &services.metrics);
                if metrics.rules.path != active_metrics.rules.path
                    || metrics.enabled && !active_metrics.enabled
                {
                    state.validate_metrics_path(
                        &metrics.rules.path,
                        next["opds"]["root"].as_str().unwrap_or("/opds"),
                    )?;
                }
                if let Some(services) = &services
                    && services.metadata.enabled
                    && services.metadata.rules.token.is_empty()
                    && ["absEnabled", "absToken"].iter().any(|key| {
                        fields
                            .get(*key)
                            .is_some_and(|value| current.get(*key) != Some(value))
                    })
                {
                    return Err("Для Audiobookshelf укажите токен".into());
                }
                let resource_policy = if fields
                    .keys()
                    .any(|key| key == "resourceProfile" || super::runtime::resource_key(key))
                {
                    let (cpu, memory) = super::diagnostics::hardware();
                    Some(super::resources::Policy::new(cpu, memory, &next)?)
                } else {
                    None
                };
                let media = if fields
                    .keys()
                    .any(|key| super::runtime::MEDIA_KEYS.contains(&key.as_str()))
                {
                    let exe = std::env::current_exe()?;
                    let directory = exe.parent().ok_or("Каталог сервера недоступен")?;
                    if fields.contains_key("fb2cngArgs") || fields.contains_key("fb2cngConfigPath")
                    {
                        inpx_catalog::book_conversion::Conversion::validate_fb2cng(
                            &next,
                            directory,
                            next["fb2cngConfigPath"] != current["fb2cngConfigPath"],
                        )?;
                    }
                    let limit = resource_policy.as_ref().map_or_else(
                        || state.resources.policy().selected.limits.conversions,
                        |policy| policy.selected.limits.conversions,
                    );
                    Some((
                        super::fb2_download_enabled(&next),
                        inpx_catalog::book_conversion::Conversion::new(&next, directory, limit)?,
                    ))
                } else {
                    None
                };
                if fields.contains_key("opdsFeedsFile")
                    && next["opdsFeedsFile"] != current["opdsFeedsFile"]
                {
                    if std::env::var("INPX_OPDS_FEEDS_FILE").is_ok() {
                        return Err("Параметр задан через INPX_OPDS_FEEDS_FILE".into());
                    }
                    let file = next["opdsFeedsFile"]
                        .as_str()
                        .ok_or("Некорректный путь к файлу подборок")?
                        .trim();
                    if !file.is_empty() {
                        inpx_catalog::opds_shelves::load(&self.data.join(file)).map_err(
                            |error| format!("Не удалось прочитать подборки OPDS: {error}"),
                        )?;
                    }
                }
                let opds = if fields.contains_key("opds")
                    || fields.contains_key("opdsFeedsFile")
                    || media.is_some()
                {
                    let formats =
                        media.as_ref().map_or_else(
                            || state.downloads.formats(),
                            |(fb2, conversion)| {
                                fb2.then_some("fb2")
                                    .into_iter()
                                    .chain(conversion.iter().flat_map(
                                        inpx_catalog::book_conversion::Conversion::formats,
                                    ))
                                    .collect()
                            },
                        );
                    let opds = self.build_opds(&next, &formats)?;
                    if fields.contains_key("opds")
                        && metrics.enabled
                        && !state
                            .access
                            .opds()
                            .route
                            .as_ref()
                            .is_some_and(|opds| opds.matches(&metrics.rules.path))
                        && opds
                            .route
                            .as_ref()
                            .is_some_and(|opds| opds.matches(&metrics.rules.path))
                    {
                        return Err("Путь OPDS пересекается с маршрутом метрик".into());
                    }
                    Some(opds)
                } else {
                    None
                };
                let access = if access_patch
                    .as_object()
                    .is_some_and(|patch| !patch.is_empty())
                    || services.is_some()
                    || fields
                        .keys()
                        .any(|key| super::runtime::LOGIN_KEYS.contains(&key.as_str()))
                {
                    let candidate = active_access.update(&access_patch, &next, services)?;
                    let admin_client =
                        candidate.admin_client(connection.peer, connection.request.headers());
                    let permitted = candidate
                        .profile_transport(connection.peer, admin_client)
                        .permits(true);
                    if candidate.has_admin_ranges() && !permitted {
                        let Some(address) = admin_client else {
                            return Err("Сервер не получил IP текущего клиента от доверенного прокси. Проверьте настройку прокси и повторите сохранение.".into());
                        };
                        return Err(format!("Добавьте текущий адрес {} в список разрешённых адресов администратора, чтобы сохранить доступ.", address.to_canonical()).into());
                    }
                    if !permitted
                        || !candidate.has_admin_ranges()
                            && access_patch["adminDirectOnly"] == true
                            && active_access.is_proxy_peer(connection.peer)
                    {
                        return Err(format!(
                            "TCP-адрес текущего подключения {} попадает в список адресов прокси. Откройте библиотеку напрямую с адреса вне этого списка.",
                            connection.peer.to_canonical()
                        ).into());
                    }
                    if !connection.valid(&candidate) {
                        return Err("Новые правила лишат текущий сеанс доступа. Подключитесь через доверенный прокси с подходящим заголовком SSO или сохраните прежний режим".into());
                    }
                    Some(candidate)
                } else {
                    None
                };
                let speech = fields
                    .keys()
                    .any(|key| super::runtime::SPEECH_KEYS.contains(&key.as_str()))
                    .then(|| super::speech::Provider::new(&next))
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
                let log_file = if fields.contains_key("logToFile") {
                    Some(super::logging::prepare_file(&next, &self.data)?)
                } else {
                    None
                };
                if !fields.is_empty() {
                    configuration::save(&self.file, &self.data, &next)?;
                }
                *current = next;
                super::logging::apply(
                    fields
                        .get("logLevel")
                        .and_then(Value::as_str)
                        .and_then(super::logging::level),
                    log_file,
                );
                if let Some(debug) = debug {
                    super::logging::temporary_debug(debug);
                }
                if fields
                    .keys()
                    .any(|key| super::runtime::TRANSPORT_KEYS.contains(&key.as_str()))
                {
                    state.socket.configure_limits(&current);
                }
                if !fields.is_empty() || debug.is_some() {
                    let changed: Vec<_> = fields.keys().map(String::as_str).collect();
                    log::info!(target: "inpx::settings", "operation={action} fields={changed:?} temporary_debug={debug:?}");
                }
                if fields.contains_key("inpxCheckInterval") {
                    self.index_interval
                        .send_replace(super::index::interval(&current["inpxCheckInterval"]));
                }
                self.extended_search
                    .store(current["extendedSearch"] != false, Ordering::Relaxed);
                self.online_reader
                    .store(current["onlineReaderEnabled"] != false, Ordering::Relaxed);
                if let Some((fb2, conversion)) = media {
                    state.downloads.configure_media(fb2, conversion);
                }
                if fields
                    .keys()
                    .any(|key| super::runtime::COVER_KEYS.contains(&key.as_str()))
                {
                    state.downloads.configure_names_and_covers(&current);
                }
                if let Some(speech) = speech {
                    state.speech.configure(speech);
                }
                if let Some(policy) = resource_policy {
                    let limits = policy.selected.limits;
                    state.resources.configure(policy);
                    state.downloads.set_resource_limits(limits);
                    state.socket.previews.resize(limits.reviews);
                    state.download_slots.resize(limits.total.max(4));
                }
                if let Some(opds) = opds {
                    state.access.set_opds(opds);
                }
                if fields.contains_key("kosyncEnabled") {
                    state
                        .access
                        .set_kosync_enabled(super::runtime::kosync_enabled(&current));
                }
                if let Some(channels) = channels {
                    Delivery::configure(state, channels, telegram_changed);
                }
                if fields.keys().any(|key| cache_key(key)) {
                    state.admin_cache.changed.notify_one();
                }
                if let Some(access) = access {
                    state.request_access.apply(access);
                } else if telegram_changed || fields.keys().any(|key| super::runtime::known(key)) {
                    state.request_access.refresh_clients();
                }
                Ok(match action {
                    "update-admin-integrations" => {
                        json!({"integrations":integrations(&current,state)})
                    }
                    "update-admin-opds" => json!({"opds":admin_opds(&current)}),
                    "update-admin-access" => {
                        json!({"access":state.request_access.current().admin_view(&connection.admission)})
                    }
                    "update-admin-runtime" => {
                        json!({"runtime":super::runtime::view(&current, state)})
                    }
                    "update-admin-library-sources" => {
                        json!({"sources":current["librarySources"],"reindexRequired":true})
                    }
                    "set-admin-resource-profile" | "set-admin-isbn-threads" => {
                        json!({"success":true})
                    }
                    "update-admin-cache" => json!({"cache":Cache::settings(&current)}),
                    _ => {
                        json!({"success":true,"importedKeys":fields.keys().collect::<Vec<_>>(), "settings":export(&current,state),
                        "reindexRequired":fields.keys().any(|key|matches!(key.as_str(),"libDir"|"inpx"|"librarySources"|"inpxFilterFile"|"lowMemoryMode")),
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
fn live_access_patch(value: &Value) -> Result<Value> {
    let fields = value.as_object().ok_or("Укажите настройки доступа")?;
    if fields
        .keys()
        .any(|key| !LIVE_FIELDS.iter().any(|(field, _)| key == field))
    {
        return Err("Неизвестная настройка доступа".into());
    }
    Ok(value.clone())
}

fn restart_key(key: &str) -> bool {
    !cache_key(key)
        && !LIVE_FIELDS.iter().any(|(field, _)| key == *field)
        && !super::runtime::known(key)
        && !matches!(
            key,
            "opds"
                | "opdsFeedsFile"
                | "librarySources"
                | "libDir"
                | "inpx"
                | "uiDefaults"
                | "extendedSearch"
                | "bookReadLink"
                | "isbnThreads"
                | "inpxCheckInterval"
        )
        && !INTEGRATIONS.iter().any(|(field, _)| *field == key)
}

pub(super) fn display_sources(config: &Value, state: &State) -> Value {
    if state.settings.source_override(config).is_some() {
        return json!(&*state.index.sources());
    }
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

pub(super) fn admin_opds(config: &Value) -> Value {
    let compatibility = std::env::var("INPX_OPDS_COMPATIBILITY").ok();
    let feeds = std::env::var("INPX_OPDS_FEEDS_FILE").ok();
    let mut view = opds_view(&config["opds"], true);
    view["compatibility"] = compatibility
        .as_deref()
        .unwrap_or(
            config["opds"]["compatibility"]
                .as_str()
                .unwrap_or("standard"),
        )
        .into();
    view["feedsFile"] = feeds
        .as_deref()
        .unwrap_or(config["opdsFeedsFile"].as_str().unwrap_or_default())
        .into();
    view["compatibilityLocked"] = compatibility.is_some().into();
    view["feedsFileLocked"] = feeds.is_some().into();
    view
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
        if std::env::var("INPX_OPDS_COMPATIBILITY").is_ok()
            && current.get("compatibility") != Some(mode)
        {
            return Err("Параметр задан через INPX_OPDS_COMPATIBILITY".into());
        }
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
    result["telegramApiModeLocked"] = std::env::var("INPX_TELEGRAM_API_MODE").is_ok().into();
    result["telegramApiUrlLocked"] = std::env::var("INPX_TELEGRAM_API_URL").is_ok().into();
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
        ("telegramApiMode", "cloud"),
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
    for (key, env) in INTEGRATIONS {
        let Some(value) = patch.get(key) else {
            continue;
        };
        if matches!(*key, "telegramApiMode" | "telegramApiUrl") && std::env::var(env).is_ok() {
            return Err(format!("Параметр задан через {env}").into());
        }
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
    if next.get("telegramApiMode").is_some() || next.get("telegramApiUrl").is_some() {
        super::telegram::api_endpoint(&combined)?;
    }
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
    if let Some(cidrs) = patch.get_mut("trustedProxyCidrs")
        && let Some(value) = cidrs.as_str()
    {
        *cidrs = json!(split_proxy_cidrs(value).collect::<Vec<_>>());
    }
    if let Some(value) = patch.get("isbnThreads") {
        super::isbn::thread_setting(value)?;
    }
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
