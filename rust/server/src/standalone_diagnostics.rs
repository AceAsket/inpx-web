use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::{Result, access_runtime::now_ms, directory_diagnostics};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{State, admin_cache, metrics::process};
use crate::standalone_access::{BrowserAccess, BrowserProfileRequest};

#[path = "standalone_library_audit.rs"]
mod audit;
#[path = "standalone_benchmark.rs"]
mod benchmark;
pub(super) use benchmark::hardware;

const CANCELLED: &str = "Проверка отменена";
const REVOKED: &str = "Права администратора отозваны";
const SOURCE_CHANGED: &str = "Библиотека обновилась. Запустите проверку заново";

pub(super) struct Diagnostics {
    data: PathBuf,
    events: Mutex<VecDeque<Value>>,
    next_event: AtomicU64,
    runtime: Runtime,
    cpu: Mutex<Option<(Instant, f64)>>,
    files: Mutex<Option<(Instant, Value)>>,
    audit: audit::Audit,
    benchmark: benchmark::Benchmark,
}

#[derive(Default)]
pub(super) struct Runtime {
    requests: Mutex<Requests>,
    in_flight: AtomicU64,
    total: AtomicU64,
}

#[derive(Default)]
struct Requests {
    actions: HashMap<String, Timing>,
    slow: Option<Value>,
    lag: VecDeque<f64>,
}

#[derive(Default)]
struct Timing {
    count: u64,
    total_ms: f64,
    max_ms: f64,
}

pub(super) struct RequestTimer<'a> {
    runtime: &'a Runtime,
    action: &'a str,
    start: Instant,
}

impl Drop for RequestTimer<'_> {
    fn drop(&mut self) {
        self.runtime.in_flight.fetch_sub(1, Ordering::Relaxed);
        let duration = self.start.elapsed().as_secs_f64() * 1000.0;
        let mut requests = self.runtime.requests.lock().expect("request timings");
        let action = if self.action.len() <= 64
            && self
                .action
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && (requests.actions.len() < 128 || requests.actions.contains_key(self.action))
        {
            self.action
        } else {
            "other"
        };
        let timing = requests.actions.entry(action.into()).or_default();
        timing.count += 1;
        timing.total_ms += duration;
        timing.max_ms = timing.max_ms.max(duration);
        if duration >= 1500.0 {
            requests.slow = Some(json!({"action":action,"durationMs":duration,"at":timestamp()}));
        }
    }
}

impl Runtime {
    fn snapshot(&self) -> Value {
        let requests = self.requests.lock().expect("request timings");
        let mut timings = requests.actions.iter().collect::<Vec<_>>();
        timings.sort_unstable_by(|(a, left), (b, right)| {
            right.max_ms.total_cmp(&left.max_ms).then_with(|| a.cmp(b))
        });
        let timings = timings.iter().take(8).map(|(action, timing)| json!({
            "action":action,"count":timing.count,"avgMs":timing.total_ms/timing.count as f64,"maxMs":timing.max_ms
        })).collect::<Vec<_>>();
        let mut lag = requests.lag.iter().copied().collect::<Vec<_>>();
        json!({"totalActions":self.total.load(Ordering::Relaxed),
            "inFlightActions":self.in_flight.load(Ordering::Relaxed),"actionCount":requests.actions.len(),
            "slowestActions":timings,"lastSlowAction":requests.slow,
            "lastEventLoopLagMs":requests.lag.back(),"eventLoopLagP95Ms":percentile(&mut lag, 0.95)})
    }
}

struct JobOwner {
    browser: String,
    token: String,
    user: String,
    admission: crate::request_access::Admission,
}

impl JobOwner {
    fn new(request: BrowserProfileRequest<'_>) -> Self {
        Self {
            browser: request.browser.into(),
            token: request.token.into(),
            user: request.user.into(),
            admission: request.admission.clone(),
        }
    }

    fn authorize(&self, state: &State) -> Result<()> {
        state
            .access
            .backup(
                Some(BrowserProfileRequest {
                    browser: &self.browser,
                    token: &self.token,
                    user: &self.user,
                    admission: &self.admission,
                }),
                false,
                |_, _| Ok(()),
            )
            .map_err(|_| REVOKED.into())
    }
}

struct Job {
    owner: JobOwner,
    stop: AtomicBool,
    view: Mutex<Value>,
}

impl Job {
    fn new(owner: BrowserProfileRequest<'_>, mut view: Value) -> Result<Arc<Self>> {
        view["id"] = super::delivery::random_id()?.into();
        view["state"] = "running".into();
        view["running"] = true.into();
        Ok(Arc::new(Self {
            owner: JobOwner::new(owner),
            stop: AtomicBool::new(false),
            view: Mutex::new(view),
        }))
    }

    fn view(&self) -> Value {
        self.view.lock().expect("diagnostics job").clone()
    }

    fn change(&self, run: impl FnOnce(&mut Value)) {
        run(&mut self.view.lock().expect("diagnostics job"))
    }

    fn cancelled(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn cancel(&self) -> Value {
        self.change(|view| {
            if view["running"] == true {
                self.stop.store(true, Ordering::Relaxed);
                view["state"] = "cancelling".into();
            }
        });
        self.view()
    }

    fn ensure(&self, state: &State, generation: u64) -> Result<()> {
        if self.cancelled() {
            return Err(CANCELLED.into());
        }
        self.owner.authorize(state)?;
        if state.index.generation() != generation {
            return Err(SOURCE_CHANGED.into());
        }
        Ok(())
    }

    fn state_for(&self, failure: &str) -> &'static str {
        match failure {
            CANCELLED | REVOKED => "cancelled",
            "" => "completed",
            _ => "failed",
        }
    }
}

impl Diagnostics {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            data: data.into(),
            events: Mutex::default(),
            next_event: AtomicU64::new(0),
            runtime: Runtime::default(),
            cpu: Mutex::default(),
            files: Mutex::default(),
            audit: audit::Audit::default(),
            benchmark: benchmark::Benchmark::new(data),
        }
    }

    pub(super) fn request<'a>(&'a self, action: &'a str) -> RequestTimer<'a> {
        self.runtime.total.fetch_add(1, Ordering::Relaxed);
        self.runtime.in_flight.fetch_add(1, Ordering::Relaxed);
        RequestTimer {
            runtime: &self.runtime,
            action,
            start: Instant::now(),
        }
    }

    pub(super) async fn collect_lag(state: Arc<State>) {
        let interval = Duration::from_millis(250);
        loop {
            let deadline = tokio::time::Instant::now() + interval;
            tokio::time::sleep_until(deadline).await;
            let mut requests = state
                .diagnostics
                .runtime
                .requests
                .lock()
                .expect("request timings");
            if requests.lag.len() == 120 {
                requests.lag.pop_front();
            }
            requests
                .lag
                .push_back(deadline.elapsed().as_secs_f64() * 1000.0);
        }
    }

    pub(super) fn dispatch(
        &self,
        state: &Arc<State>,
        owner: BrowserProfileRequest<'_>,
        access: &BrowserAccess,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        Ok(match action {
            "start-library-audit" => {
                json!({"audit":self.audit.start(state,owner,request["options"]["deep"] == true)?})
            }
            "cancel-library-audit" => json!({"audit":self.audit.cancel()}),
            "get-admin-dashboard" => self.dashboard(state, access, true)?,
            "get-admin-dashboard-metrics" => self.dashboard(state, access, false)?,
            "get-admin-performance" => self.benchmark.snapshot(state)?,
            "start-admin-benchmark" => {
                json!({"job":self.benchmark.start(state,owner,&request["options"])?})
            }
            "cancel-admin-benchmark" => json!({"job":self.benchmark.cancel()}),
            "get-admin-events" => {
                let options = &request["options"];
                let level = options["level"].as_str().unwrap_or("all").trim();
                let category = options["category"].as_str().unwrap_or("all").trim();
                let limit = integer(&options["limit"], 80).clamp(1, 200);
                let (enabled, max) = state.settings.event_policy();
                json!({"enabled":enabled,"maxSize":max,"events":self.events(enabled,level,category,limit)})
            }
            "update-admin-event-log" => {
                let options = &request["options"];
                let enabled = options["enabled"] != false;
                let max = integer(&options["maxSize"], 300).clamp(20, 2000);
                state.settings.save_event_policy(enabled, max)?;
                self.log(
                    state,
                    "info",
                    "settings",
                    "Настройки журнала событий обновлены",
                );
                self.trim(max);
                json!({"enabled":enabled,"maxSize":max})
            }
            "add-admin-test-event" => {
                let level = if request["level"]
                    .as_str()
                    .is_some_and(|level| level.eq_ignore_ascii_case("error"))
                {
                    "error"
                } else {
                    "warn"
                };
                let message = format!("Admin event log test: {level}");
                self.log(state, level, "system", &message);
                json!({"success":true})
            }
            _ => return Err("Неизвестная команда диагностики".into()),
        })
    }

    fn trim(&self, max: usize) {
        let mut rows = self.events.lock().expect("admin events");
        let excess = rows.len().saturating_sub(max);
        rows.drain(..excess);
    }

    pub(super) fn log(&self, state: &State, level: &str, category: &str, message: &str) {
        let (enabled, max) = state.settings.event_policy();
        if !enabled {
            return;
        }
        let mut rows = self.events.lock().expect("admin events");
        let id = self.next_event.fetch_add(1, Ordering::Relaxed);
        rows.push_back(json!({"id":format!("{}-{id}",now_ms()),"time":timestamp(),
            "level":level,"category":category,"message":message.chars().take(2000).collect::<String>(),"details":{}}));
        let excess = rows.len().saturating_sub(max);
        rows.drain(..excess);
    }

    pub(super) fn log_action(&self, state: &State, action: &str, response: &Value) {
        let (category, message) = match action {
            "admin-reindex" if response["started"] == true => {
                ("index", "Запущено переиндексирование библиотеки")
            }
            "update-admin-library-sources" => ("sources", "Обновлены источники библиотек"),
            "update-admin-integrations"
            | "update-admin-opds"
            | "update-admin-access"
            | "update-admin-runtime"
            | "set-admin-resource-profile"
            | "set-admin-isbn-threads"
            | "update-admin-cache"
            | "import-admin-settings" => ("settings", "Обновлены настройки администратора"),
            "admin-clean-cache" => ("cache", "Очистка кэша завершена"),
            "admin-rebuild-cover" | "admin-clean-broken-covers" => {
                ("cover", "Обновлён кэш обложек")
            }
            "create-admin-backup" => ("backup", "Создана резервная копия"),
            "import-admin-backup" | "admin-backup-vault" if response["restored"].is_array() => {
                ("backup", "Восстановлена резервная копия")
            }
            "send-book-telegram" | "send-book-email" => ("delivery", "Отправлена книга"),
            "set-user-profile-blocked" | "set-profile-auth-policy" | "reset-user-profile-totp" => {
                ("security", "Обновлены параметры входа в профили")
            }
            _ => return,
        };
        let failed = response["error"].is_string()
            || response["cleaned"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["error"].is_string()));
        if failed {
            self.log(
                state,
                "error",
                category,
                &format!("Операция завершилась ошибкой ({action})"),
            );
        } else {
            self.log(state, "info", category, message);
        }
    }

    fn events(&self, enabled: bool, level: &str, category: &str, limit: usize) -> Vec<Value> {
        if !enabled {
            return Vec::new();
        }
        self.events
            .lock()
            .expect("admin events")
            .iter()
            .rev()
            .filter(|row| {
                (level == "all" || row["level"] == level)
                    && (category == "all" || row["category"] == category)
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub(super) fn event_counts(
        &self,
        state: &State,
    ) -> std::collections::BTreeMap<(String, String), u64> {
        let mut counts = std::collections::BTreeMap::new();
        for row in self.events(state.settings.event_policy().0, "all", "all", 2000) {
            let pair = (
                row["level"].as_str().unwrap_or_default().into(),
                row["category"].as_str().unwrap_or_default().into(),
            );
            *counts.entry(pair).or_default() += 1;
        }
        counts
    }

    pub(super) fn audit(&self) -> Value {
        self.audit.view()
    }

    pub(super) fn tasks(&self) -> Vec<Value> {
        let mut tasks = Vec::new();
        let audit = self.audit.view();
        if !audit.is_null() {
            let phase = if audit["deep"] == true {
                "Файлы и содержимое"
            } else {
                "Наличие файлов"
            };
            let done = audit["checked"].as_u64().unwrap_or_default();
            let total = audit["total"].as_u64();
            tasks.push(json!({"id":audit["id"],"kind":"audit","title":"Проверка библиотеки","phase":phase,
                "state":audit["state"],"done":done,"total":total,"progress":super::tasks::fraction(done,total),"error":audit["error"]}));
        }
        let job = self.benchmark.view();
        if !job.is_null() {
            tasks.push(json!({"id":job["id"],"kind":"benchmark","title":"Проверка производительности","phase":job["stage"],
                "state":job["state"],"progress":job["progress"],"error":job["message"]}));
        }
        tasks
    }

    fn dashboard(&self, state: &Arc<State>, access: &BrowserAccess, full: bool) -> Result<Value> {
        let config = state.settings.snapshot();
        let db = self.data.join("db");
        let book = state.downloads.cache();
        let legacy = state.downloads.legacy_covers();
        let temp = config["tempDir"]
            .as_str()
            .filter(|path| !path.is_empty())
            .map_or_else(|| self.data.join("tmp"), PathBuf::from);
        let mut limits = admin_cache::Cache::settings(&config);
        limits["maxFilesDirSize"] = config["maxFilesDirSize"].clone();
        let ratio = limits["cacheCleanTargetRatio"].as_f64().unwrap_or(1.0);
        for (size, target) in [
            ("bookCacheSize", "bookCacheTargetSize"),
            ("coverCacheSize", "coverCacheTargetSize"),
        ] {
            limits[target] = limits[size]
                .as_f64()
                .filter(|bytes| *bytes > 0.0)
                .map_or(Value::Null, |bytes| (bytes * ratio).round().into());
        }
        let sizes = {
            let mut cache = self.files.lock().expect("dashboard size cache");
            if let Some((_, sizes)) = cache
                .as_ref()
                .filter(|(time, _)| time.elapsed() < Duration::from_secs(3))
            {
                sizes.clone()
            } else {
                let native = directory_diagnostics::measure(book, 20000, |name| {
                    admin_cache::cover(&name.to_string_lossy())
                });
                let inherited = directory_diagnostics::measure(&legacy, 20000, |_| true);
                let sizes = json!({"db":directory_diagnostics::measure(&db,20000,|_| true),
                    "bookCache":directory_diagnostics::measure(book,20000,|name| !admin_cache::cover(&name.to_string_lossy())),
                    "coverCache":{"exists":native.exists || inherited.exists,"size":native.size.saturating_add(inherited.size),
                        "files":native.files+inherited.files,"truncated":native.truncated || inherited.truncated},
                    "tempDir":directory_diagnostics::measure(&temp,5000,|_| true)});
                *cache = Some((Instant::now(), sizes.clone()));
                sizes
            }
        };
        let uptime = state.started.elapsed().as_secs_f64();
        let cpu = process::cpu().map(|(user, system)| {
            let total = user + system;
            let mut previous = self.cpu.lock().expect("dashboard CPU");
            let percentage = previous.replace((Instant::now(),total)).and_then(|(when, value)| {
                let elapsed = when.elapsed().as_secs_f64();
                (elapsed > 0.0).then_some((total - value).max(0.0)/elapsed*100.0)
            });
            json!({"userSeconds":user,"systemSeconds":system,"totalSeconds":total,"currentPercent":percentage,"averagePercent":total/uptime.max(0.001)*100.0})
        });
        let index = state.index.snapshot();
        let discovery = state
            .access
            .telegram(|reader, stamp| reader.discovery_metrics(stamp))?;
        let mut view = json!({"generatedAt":timestamp(),"uptime":uptime,"memory":{"rss":process::rss()},"cpu":cpu,
            "runtime":self.runtime.snapshot(),"discovery":discovery,"activity":state.metrics.activity.as_ref().map(|activity|activity.snapshot(access)),
            "index":index,"stats":index["stats"],"paths":{"dataDir":self.data,"db":db,"bookCache":book,"coverCache":book,"tempDir":temp},
            "sizes":sizes,"limits":limits});
        if full {
            let mut sources = Vec::new();
            for source in super::settings::display_sources(&config, state)
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(mut row) = source.as_object().cloned() else {
                    continue;
                };
                if source["enabled"] != false {
                    let details = super::settings::diagnose(source)?;
                    row.extend(details.as_object().expect("source details").clone());
                }
                if row
                    .get("inpx")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                    && let Some(inpx) = row.get("inpxFile").cloned()
                {
                    row.insert("inpx".into(), inpx);
                }
                sources.push(Value::Object(row));
            }
            view["sources"] = sources.into();
        }
        let enabled = state.settings.event_policy().0;
        view["covers"] = json!({"dir":book,"size":sizes["coverCache"]["size"],"files":sizes["coverCache"]["files"],
            "limit":limits["coverCacheSize"],"targetSize":limits["coverCacheTargetSize"],"latestErrors":self.events(enabled,"error","cover",8)});
        let tasks = super::tasks::snapshot(state, "", true)?;
        let mut rows = vec![
            json!({"id":"index","title":"Индексация","active":index["updating"] == true,"state":index["state"],
            "message":index["jobMessage"],"progress":index["progress"],"cancellable":false,"lastError":index["error"]}),
        ];
        rows.extend(
            tasks["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|task| task["kind"] != "catalogue")
                .map(|task| {
                    let mut row = task.clone();
                    row["active"] = matches!(
                        task["state"].as_str(),
                        Some("queued" | "running" | "generating" | "cancelling")
                    )
                    .into();
                    row["message"] = task["phase"].clone();
                    row["lastError"] = task["error"].clone();
                    row
                }),
        );
        view["tasks"] = rows.into();
        Ok(view)
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("current UTC timestamp")
}

pub(super) fn integer(value: &Value, fallback: usize) -> usize {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|&value| value != 0)
        .map_or(fallback, |value| value.max(0) as usize)
}

fn percentile(items: &mut [f64], fraction: f64) -> Option<f64> {
    items.sort_unstable_by(f64::total_cmp);
    items
        .get(((items.len() as f64 * fraction).ceil() as usize).saturating_sub(1))
        .copied()
}
