use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fmt::Write as _;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use hmac::{Hmac, KeyInit, Mac};
use http_body_util::BodyExt;
use hyper::body::{Body as Stream, Bytes, Frame, SizeHint};
use hyper::header;
use hyper::{Response, StatusCode};
use inpx_catalog::{Result, directory_diagnostics};
use serde_json::Value;
use sha2::Sha256;
use tokio::sync::Semaphore;

use super::{State, VERSION, env, send_bytes};
use crate::http::{Body, BodyError};
use crate::request_access::{Metrics, ServiceAccess, trim_js};

#[path = "standalone_process_metrics.rs"]
pub(super) mod process;

const MAX_FILES: usize = 20_000;
const MAX_PROFILES: usize = 512;

pub(super) struct Monitor {
    pub(super) path: String,
    enabled: bool,
    token_required: bool,
    data: PathBuf,
    book_limit: u64,
    cover_limit: u64,
    disabled_sources: usize,
    pub(super) activity: Option<Arc<Activity>>,
    slot: Arc<Semaphore>,
}

pub(super) struct Activity {
    signer: Hmac<Sha256>,
    counts: Mutex<ActivityCounts>,
}

#[derive(Default)]
struct ActivityCounts {
    next_id: u64,
    sockets: HashMap<u64, Option<(Instant, Option<String>)>>,
    profiles: BTreeMap<String, [u64; 2]>,
}

pub(super) struct Connection {
    activity: Arc<Activity>,
    pub(super) id: u64,
}

impl Activity {
    pub(super) fn snapshot(&self) -> Value {
        let counts = self.counts.lock().expect("metrics activity");
        let mut totals = [0_u64; 2];
        let profiles = counts
            .profiles
            .iter()
            .map(|(profile, stats)| {
                totals[0] = totals[0].saturating_add(stats[0]);
                totals[1] = totals[1].saturating_add(stats[1]);
                serde_json::json!({"profile":profile,"logins":stats[0],"downloads":stats[1]})
            })
            .collect::<Vec<_>>();
        serde_json::json!({"totals":{"logins":totals[0],"downloads":totals[1]},"profiles":profiles})
    }

    fn new(data: &Path) -> Result<Self> {
        let file = data.join("session-secret");
        let secret = match std::fs::read_to_string(&file) {
            Ok(value) if !trim_js(&value).is_empty() => trim_js(&value).to_owned(),
            Ok(_) => return Err("Empty session-secret".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut random = [0; 48];
                getrandom::fill(&mut random).map_err(|_| "Cannot issue telemetry pseudonyms")?;
                let mut secret = String::with_capacity(96);
                for byte in random {
                    write!(secret, "{byte:02x}").expect("hex secret");
                }
                let mut options = std::fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut writer = options.open(&file)?;
                writer.write_all(secret.as_bytes())?;
                writer.sync_all()?;
                secret
            }
            Err(error) => return Err(error.into()),
        };
        let mut signer = Hmac::new_from_slice(secret.as_bytes()).expect("HMAC key");
        signer.update(b"server-activity\0");
        let mut counts = ActivityCounts::default();
        counts.profiles.insert("guest".into(), [0; 2]);
        Ok(Self {
            signer,
            counts: Mutex::new(counts),
        })
    }

    pub(super) fn connect(self: &Arc<Self>) -> Connection {
        let mut counts = self.counts.lock().expect("metrics activity");
        counts.next_id += 1;
        let id = counts.next_id;
        counts.sockets.insert(id, None);
        Connection {
            activity: self.clone(),
            id,
        }
    }

    pub(super) fn seen(&self, id: u64, owner: Option<&str>) {
        if let Some(socket) = self
            .counts
            .lock()
            .expect("metrics activity")
            .sockets
            .get_mut(&id)
        {
            *socket = Some((Instant::now(), owner.map(str::to_owned)));
        }
    }

    pub(super) fn login(&self, owner: &str) {
        self.record(Some(owner), 0, 1);
    }

    fn record(&self, owner: Option<&str>, field: usize, amount: u64) {
        let mut counts = self.counts.lock().expect("metrics activity");
        let profile = if let Some(owner) = owner {
            let mut mac = self.signer.clone();
            mac.update(owner.as_bytes());
            let mut label = String::with_capacity(12);
            for byte in &mac.finalize().into_bytes()[..6] {
                write!(label, "{byte:02x}").expect("hex profile");
            }
            if counts.profiles.contains_key(&label) || counts.profiles.len() <= MAX_PROFILES {
                label
            } else {
                "other".into()
            }
        } else {
            "guest".into()
        };
        let value = &mut counts.profiles.entry(profile).or_default()[field];
        *value = value.saturating_add(amount);
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.activity
            .counts
            .lock()
            .expect("metrics activity")
            .sockets
            .remove(&self.id);
    }
}

impl Monitor {
    pub(super) fn path(config: &Value) -> String {
        env("INPX_METRICS_PATH")
            .or_else(|| {
                config["metricsPath"]
                    .as_str()
                    .filter(|path| !path.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "/metrics".into())
    }

    pub(super) fn new(config: &Value, data: &Path) -> Result<(Self, Option<Metrics>)> {
        let enabled = std::env::var("INPX_METRICS_ENABLED")
            .map_or(config["metricsEnabled"] == true, |value| value == "true");
        let path = Self::path(config);
        let token = std::env::var("INPX_METRICS_TOKEN")
            .unwrap_or_else(|_| config["metricsToken"].as_str().unwrap_or_default().into());
        let token_required = !token.is_empty();
        let token = trim_js(&token);
        let normalized = path.trim_end_matches('/');
        let access = enabled.then(|| Metrics {
            path: if normalized.is_empty() {
                "/"
            } else {
                normalized
            }
            .into(),
            token: token.into(),
            exempt: std::env::var("INPX_METRICS_EXEMPT_AUTH")
                .map_or(config["metricsExemptAuth"] == true, |value| value == "true"),
        });
        let monitor = Self {
            path,
            enabled,
            token_required,
            data: data.into(),
            book_limit: integer(&config["bookCacheSize"])
                .or_else(|| integer(&config["maxFilesDirSize"]))
                .unwrap_or_else(|| cache_limit("BOOK", 2048)),
            cover_limit: integer(&config["coverCacheSize"])
                .unwrap_or_else(|| cache_limit("COVER", 512)),
            disabled_sources: config["librarySources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|source| source["enabled"] == false)
                .count(),
            activity: match Activity::new(data) {
                Ok(activity) => Some(Arc::new(activity)),
                Err(error) if enabled => return Err(error),
                Err(error) => {
                    eprintln!("Server activity: {error}");
                    None
                }
            },
            slot: Arc::new(Semaphore::new(1)),
        };
        Ok((monitor, access))
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.trim_end_matches('/') == self.path.trim_end_matches('/')
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        service: ServiceAccess,
        head: bool,
    ) -> Response<Body> {
        let (status, text) = if !self.enabled {
            (StatusCode::NOT_FOUND, "Not Found")
        } else if self.token_required && !matches!(service, ServiceAccess::Metrics) {
            (StatusCode::UNAUTHORIZED, "Metrics token required")
        } else if let Ok(permit) = self.slot.clone().try_acquire_owned() {
            let state = state.clone();
            if let Ok(document) = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                state.metrics.document(&state)
            })
            .await
            {
                return send_bytes(
                    document.into_bytes(),
                    "text/plain; version=0.0.4; charset=utf-8",
                    head,
                );
            }
            (StatusCode::SERVICE_UNAVAILABLE, "Metrics unavailable")
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Metrics collection in progress",
            )
        };
        let mut response = send_bytes(text.as_bytes().to_vec(), "text/plain; charset=utf-8", head);
        *response.status_mut() = status;
        response
    }

    fn document(&self, state: &State) -> String {
        let status = state.index.snapshot();
        let stats = &status["stats"];
        let n = |name: &str| stats[name].as_f64().unwrap_or(0.0);
        let measure = |root: &Path| directory_diagnostics::measure(root, MAX_FILES, |_| true);
        let cover = |name: &OsStr| name.to_string_lossy().ends_with(".reader-cover");
        let db = measure(&self.data.join("db"));
        let books =
            directory_diagnostics::measure(state.downloads.cache(), MAX_FILES, |name| !cover(name));
        let covers = directory_diagnostics::measure(state.downloads.cache(), MAX_FILES, cover);
        let mut output = String::new();
        family(
            &mut output,
            "build_info",
            "Application build information.",
            "gauge",
        );
        sample(
            &mut output,
            "build_info",
            &format!("{{version=\"{VERSION}\",branch=\"production\"}}"),
            1,
        );
        gauge(
            &mut output,
            "uptime_seconds",
            "Process uptime in seconds.",
            state.started.elapsed().as_secs_f64(),
        );
        if let Some(rss) = process::rss() {
            gauge(
                &mut output,
                "memory_rss_bytes",
                "Resident set size in bytes.",
                rss,
            );
        }
        gauge(
            &mut output,
            "memory_heap_used_bytes",
            "Used V8 heap in bytes.",
            0,
        );
        if let Some((user, system)) = process::cpu() {
            for (name, help, seconds) in [
                (
                    "process_cpu_user_seconds_total",
                    "Total user CPU time spent by the process.",
                    user,
                ),
                (
                    "process_cpu_system_seconds_total",
                    "Total system CPU time spent by the process.",
                    system,
                ),
                (
                    "process_cpu_seconds_total",
                    "Total CPU time spent by the process.",
                    user + system,
                ),
            ] {
                family(&mut output, name, help, "counter");
                sample(&mut output, name, "", seconds);
            }
        }
        for (name, help, value) in [
            (
                "index_ready",
                "Whether the search index is ready.",
                f64::from(u8::from(status["ready"] == true)),
            ),
            (
                "index_progress",
                "Current indexing progress from 0 to 1.",
                status["progress"].as_f64().unwrap_or(0.0),
            ),
            (
                "index_records_loaded",
                "Records loaded while indexing.",
                status["recsLoaded"]
                    .as_f64()
                    .filter(|n| *n != 0.0)
                    .unwrap_or_else(|| n("recsLoaded")),
            ),
            ("books_total", "Indexed non-deleted books.", n("bookCount")),
            (
                "authors_total",
                "Indexed non-empty authors.",
                n("authorCount"),
            ),
            ("series_total", "Indexed series.", n("seriesCount")),
            ("files_total", "Indexed non-deleted files.", n("filesCount")),
        ] {
            gauge(&mut output, name, help, value);
        }
        for (name, help, data) in [
            (
                "db_size_bytes",
                "Search database directory size in bytes.",
                db.size,
            ),
            (
                "book_cache_size_bytes",
                "Prepared book cache size in bytes.",
                books.size,
            ),
            (
                "book_cache_limit_bytes",
                "Prepared book cache limit in bytes.",
                self.book_limit,
            ),
            (
                "cover_cache_size_bytes",
                "Cover cache size in bytes.",
                covers.size,
            ),
            (
                "cover_cache_limit_bytes",
                "Cover cache limit in bytes.",
                self.cover_limit,
            ),
            (
                "cover_cache_files",
                "Cover cache file count.",
                covers.files as u64,
            ),
        ] {
            gauge(&mut output, name, help, data);
        }
        let name = "library_sources_total";
        family(
            &mut output,
            name,
            "Configured library sources by enabled state.",
            "gauge",
        );
        sample(
            &mut output,
            name,
            "{enabled=\"true\"}",
            state.index.sources().len(),
        );
        sample(
            &mut output,
            name,
            "{enabled=\"false\"}",
            self.disabled_sources,
        );
        family(
            &mut output,
            "admin_events_total",
            "Admin event log entries by level and category.",
            "gauge",
        );
        for ((level, category), count) in state.diagnostics.event_counts(state) {
            sample(
                &mut output,
                "admin_events_total",
                &format!("{{level=\"{level}\",category=\"{category}\"}}"),
                count,
            );
        }
        if let Some(activity) = &self.activity {
            let counts = activity.counts.lock().expect("metrics activity");
            let mut clients = 0;
            let mut anonymous = 0;
            let mut users = HashSet::new();
            for (last, owner) in counts.sockets.values().flatten() {
                if last.elapsed() > Duration::from_secs(300) {
                    continue;
                }
                clients += 1;
                if let Some(owner) = owner {
                    users.insert(owner);
                } else {
                    anonymous += 1;
                }
            }
            gauge(
                &mut output,
                "ws_clients",
                "Active WebSocket clients.",
                clients,
            );
            gauge(
                &mut output,
                "users_online",
                "Distinct authorized user profiles with active WebSocket sessions.",
                users.len(),
            );
            gauge(
                &mut output,
                "ws_anonymous_clients",
                "Active WebSocket clients without an authorized user profile.",
                anonymous,
            );
            for (i, name, help) in [
                (
                    0,
                    "profile_logins_total",
                    "Successful profile sessions by pseudonymous profile.",
                ),
                (
                    1,
                    "book_downloads_total",
                    "Books delivered in complete HTTP downloads by pseudonymous profile.",
                ),
            ] {
                family(&mut output, name, help, "counter");
                for (label, totals) in &counts.profiles {
                    sample(
                        &mut output,
                        name,
                        &format!("{{profile=\"{label}\"}}"),
                        totals[i],
                    );
                }
            }
        }
        let (enabled, attempts) = state.access.login_metrics();
        family(
            &mut output,
            "login_attempts_total",
            "Login and access attempts by kind and result.",
            "counter",
        );
        for (kind, values) in ["access", "profile", "opds"]
            .into_iter()
            .zip(attempts.as_chunks::<3>().0)
        {
            for (result, count) in ["success", "failure", "blocked"].into_iter().zip(values) {
                sample(
                    &mut output,
                    "login_attempts_total",
                    &format!("{{kind=\"{kind}\",result=\"{result}\"}}"),
                    count,
                );
            }
        }
        gauge(
            &mut output,
            "login_rate_limit_enabled",
            "Whether internal login rate limiting is enabled.",
            u8::from(enabled),
        );
        gauge(
            &mut output,
            "login_failed_attempts_active",
            "Failed login/access attempts currently kept in the rate-limit window.",
            attempts[9],
        );
        gauge(
            &mut output,
            "login_rate_limited_ips",
            "Client IP buckets currently blocked by login rate limiting.",
            attempts[10],
        );
        output
    }
}

pub(super) fn track_download(
    response: Response<Body>,
    activity: &Arc<Activity>,
    owner: Option<String>,
) -> Response<Body> {
    track_downloads(response, activity, owner, 1)
}

pub(super) fn track_downloads(
    mut response: Response<Body>,
    activity: &Arc<Activity>,
    owner: Option<String>,
    books: u64,
) -> Response<Body> {
    let whole = response.status() == StatusCode::OK
        || response.status() == StatusCode::PARTIAL_CONTENT
            && response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("bytes 0-")?.split_once('/'))
                .is_some_and(|(last, size)| {
                    last.parse::<u64>().ok().and_then(|end| end.checked_add(1))
                        == size.parse::<u64>().ok()
                });
    if whole && let Some(length) = response.body().size_hint().exact() {
        if length == 0 {
            activity.record(owner.as_deref(), 1, books);
        } else {
            let body = response.into_parts();
            response = Response::from_parts(
                body.0,
                Delivery {
                    body: body.1,
                    remaining: length,
                    count: Some((activity.clone(), owner, books)),
                }
                .boxed_unsync(),
            );
        }
    }
    response
}

struct Delivery {
    body: Body,
    remaining: u64,
    count: Option<(Arc<Activity>, Option<String>, u64)>,
}

impl Stream for Delivery {
    type Data = Bytes;
    type Error = BodyError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, BodyError>>> {
        let frame = Pin::new(&mut self.body).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &frame
            && let Some(bytes) = frame.data_ref()
        {
            self.remaining = self.remaining.saturating_sub(bytes.len() as u64);
            if self.remaining == 0
                && let Some((activity, owner, books)) = self.count.take()
            {
                activity.record(owner.as_deref(), 1, books);
            }
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

fn integer(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse().ok())
}

fn cache_limit(name: &str, default_mb: u64) -> u64 {
    env(&format!("INPX_{name}_CACHE_SIZE"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or_else(|| {
            env(&format!("INPX_{name}_CACHE_SIZE_MB"))
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(default_mb)
                .saturating_mul(1024 * 1024)
        })
}

fn family(output: &mut String, name: &str, help: &str, kind: &str) {
    writeln!(
        output,
        "# HELP inpx_web_{name} {help}\n# TYPE inpx_web_{name} {kind}"
    )
    .expect("text metrics");
}

fn sample(output: &mut String, name: &str, labels: &str, value: impl std::fmt::Display) {
    writeln!(output, "inpx_web_{name}{labels} {value}").expect("text metrics");
}

fn gauge(output: &mut String, name: &str, help: &str, value: impl std::fmt::Display) {
    family(output, name, help, "gauge");
    sample(output, name, "", value);
}
