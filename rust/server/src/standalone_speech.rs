use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use ctutils::CtEq;
use hmac::{Hmac, KeyInit, Mac};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, StatusCode};
use inpx_catalog::Result;
use inpx_catalog::access_runtime::now_ms;
use inpx_catalog::reader_document::{Document, SpeechMode, SpeechPart};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use super::State;
use crate::standalone_download::Prepared;

#[path = "standalone_speech_plan.rs"]
mod plan;

const LIFETIME: Duration = Duration::from_secs(24 * 3600);
const META_TIMEOUT: Duration = Duration::from_secs(5);
const CONSUMER_LIFETIME: Duration = Duration::from_secs(600);
const PARTS_LIFETIME: Duration = Duration::from_secs(900);
const MIB: u64 = 1024 * 1024;
const DISABLED: &str = "Серверная озвучка не настроена.";
const SAMPLE: &str = "Откройте книгу и устройтесь поудобнее. За окном тихо шумел дождь, а в комнате было тепло и спокойно. Каждая новая история — это путешествие. Послушайте мой голос и выберите удобную скорость чтения.";

pub(super) struct Speech {
    root: String,
    directory: PathBuf,
    url: Option<String>,
    api_key: String,
    model: String,
    limit: u64,
    timeout: Duration,
    signer: Hmac<Sha256>,
    client: reqwest::Client,
    scheduler: Mutex<Scheduler>,
    parts: Mutex<VecDeque<CachedParts>>,
}

struct CachedParts {
    version: String,
    mode: SpeechMode,
    parts: Arc<[SpeechPart]>,
    bytes: usize,
    used: Instant,
}

type ConsumerKey = (String, Option<String>);

#[derive(Default)]
struct Scheduler {
    jobs: HashMap<String, Job>,
    consumers: HashMap<ConsumerKey, (Instant, bool)>,
    queue: VecDeque<String>,
    running: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Queued,
    Generating,
    Ready,
    Cancelled,
    Error,
}

impl Phase {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Generating)
    }
}

struct Job {
    attempt: String,
    speaker: String,
    engine: String,
    state: Phase,
    phase: String,
    progress: f64,
    remaining: Option<f64>,
    characters: usize,
    owners: HashSet<String>,
    consumers: HashSet<ConsumerKey>,
    cancel: watch::Sender<bool>,
    payload: Option<Vec<u8>>,
    options: bool,
    created: Instant,
    error: String,
}

struct Work {
    id: String,
    attempt: String,
    engine: String,
    options: bool,
    payload: Vec<u8>,
    cancel: watch::Receiver<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Synthesis<'a> {
    text: &'a str,
    speaker: &'a str,
    model: &'a str,
    request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<&'a plan::Options>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<&'a [SpeechPart]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedSegment<'a> {
    index: usize,
    title: &'a str,
    #[serde(flatten)]
    part: &'a SpeechPart,
}

impl Speech {
    pub(super) fn new(data: &Path, root: &str, config: &Value) -> Result<Arc<Self>> {
        let setting = |name: &str, key: &str| {
            std::env::var(name)
                .ok()
                .unwrap_or_else(|| config[key].as_str().unwrap_or_default().into())
                .trim()
                .to_owned()
        };
        let bounded_setting = |name: &str, key: &str, default| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .or_else(|| config[key].as_u64())
                .filter(|value| *value > 0)
                .unwrap_or(default)
        };
        let enabled = std::env::var("INPX_TTS_ENABLED")
            .map_or(config["ttsEnabled"] == true, |value| value == "true");
        let url = setting("INPX_TTS_URL", "ttsUrl");
        let model = setting("INPX_TTS_MODEL", "ttsModel");
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(std::io::Error::other)?;
        Ok(Arc::new(Self {
            root: format!("{}/reader-audio/", root.trim_end_matches('/')),
            directory: data.join("speech"),
            url: (enabled && !url.is_empty()).then(|| url.trim_end_matches('/').to_owned()),
            api_key: setting("INPX_TTS_API_KEY", "ttsApiKey"),
            model: if model.is_empty() {
                "v5_6_ru".into()
            } else {
                model
            },
            limit: bounded_setting("INPX_TTS_CACHE_SIZE_MB", "ttsCacheSizeMb", 4096)
                .max(64)
                .saturating_mul(MIB),
            timeout: Duration::from_millis(bounded_setting(
                "INPX_TTS_TIMEOUT_MS",
                "ttsTimeoutMs",
                3_600_000,
            )),
            signer: Hmac::new_from_slice(&secret).expect("HMAC key"),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            scheduler: Mutex::new(Scheduler::default()),
            parts: Mutex::new(VecDeque::new()),
        }))
    }

    pub(super) fn enabled(&self) -> bool {
        self.url.is_some()
    }

    pub(super) fn request(
        self: &Arc<Self>,
        state: &State,
        owner: &str,
        request: &Value,
    ) -> Result<Value> {
        let action = request["action"].as_str().unwrap_or_default();
        match action {
            "get-reader-audio-status" => {
                let scheduler = self.scheduler.lock().expect("speech scheduler");
                let id = request["jobId"].as_str().unwrap_or_default();
                let job = scheduler
                    .jobs
                    .get(id)
                    .filter(|job| job.owners.contains(owner))
                    .ok_or("Задание озвучки не найдено.")?;
                return Ok(self.describe(&scheduler, id, job));
            }
            "cancel-reader-audio" => return self.cancel(owner, request.get("consumerId")),
            _ => {}
        }
        let preparing = action != "get-reader-audio-plan";
        let consumer = if preparing {
            self.scheduler
                .lock()
                .expect("speech scheduler")
                .consumer(owner, request.get("consumerId"))?
        } else {
            (owner.into(), None)
        };
        if self.cancelled(&consumer) {
            return Ok(json!({"state":"cancelled"}));
        }
        if !self.enabled() {
            return Err(DISABLED.into());
        }
        if action == "preview-reader-voice" {
            let text = request
                .get("sampleText")
                .map_or(Some(SAMPLE), Value::as_str)
                .filter(|text| {
                    text.encode_utf16().count() <= 500 && text.chars().any(plan::russian)
                })
                .ok_or("Для пробы введите русский текст, до 500 символов.")?
                .trim();
            let parts = [SpeechPart {
                title: String::new(),
                text: text.into(),
                chapter_end: true,
                paragraph_end: None,
            }];
            return self.enqueue(
                consumer,
                "voice-preview-v1",
                &parts,
                0,
                Some(&parts),
                request,
                true,
            );
        }
        let uid = request["bookUid"]
            .as_str()
            .filter(|uid| !uid.trim().is_empty())
            .ok_or("bookUid is empty")?;
        let mode = match request["mode"].as_str().filter(|mode| !mode.is_empty()) {
            Some(mode) => mode,
            None if preparing => "book",
            None => "online",
        };
        let (path, version) =
            state
                .downloads
                .speech_document(uid, &state.index.catalogue, &state.index.sources())?;
        let parsed = SpeechMode::parse(mode)?;
        let parts = self.parts(&path, &version, parsed)?;
        if !preparing {
            let (chapters, start, characters) = plan::chapters(&parts, &request["anchor"])?;
            let estimate = self.metadata("/estimate").ok().zip(chapters.first());
            let (engine, estimate) = estimate
                .and_then(|(data, first)| {
                    Some((
                        engine_id(&data)?.to_owned(),
                        self.estimate(&data, first, characters),
                    ))
                })
                .unwrap_or_default();
            return Ok(
                json!({"chapters":chapters,"characters":characters,"startChapter":start,"engineId":engine,"estimate":estimate}),
            );
        }
        let index = if request["mode"].as_str().is_none_or(str::is_empty) {
            0
        } else {
            request["chapterIndex"]
                .as_f64()
                .filter(|index| {
                    index.fract() == 0.0 && *index >= 0.0 && *index < parts.len() as f64
                })
                .ok_or("Глава озвучки не найдена.")? as usize
        };
        let key = if parsed == SpeechMode::Book {
            uid.to_owned()
        } else {
            format!("{uid}:{mode}:{index}")
        };
        let segments = if parsed == SpeechMode::Book
            && plan::Options::parse(request.get("options"))?.is_some()
        {
            Some(self.parts(&path, &version, SpeechMode::Chapters)?)
        } else {
            None
        };
        self.enqueue(
            consumer,
            &key,
            &parts,
            index,
            segments.as_deref(),
            request,
            false,
        )
    }

    fn parts(&self, path: &Path, version: &str, mode: SpeechMode) -> Result<Arc<[SpeechPart]>> {
        let now = Instant::now();
        {
            let mut cache = self.parts.lock().expect("speech document cache");
            cache.retain(|entry| now.duration_since(entry.used) < PARTS_LIFETIME);
            if let Some(index) = cache
                .iter()
                .position(|entry| entry.version == version && entry.mode == mode)
            {
                let mut entry = cache.remove(index).expect("cached document");
                entry.used = now;
                let result = entry.parts.clone();
                cache.push_back(entry);
                return Ok(result);
            }
        }
        let parts: Arc<[SpeechPart]> = Document::read(path)?.speech_parts(mode)?.into();
        let bytes = parts
            .iter()
            .map(|part| part.text.len() + part.title.len() + size_of::<SpeechPart>())
            .sum();
        let limit = 12 * MIB as usize;
        if bytes <= limit {
            let mut cache = self.parts.lock().expect("speech document cache");
            cache.retain(|entry| entry.version != version || entry.mode != mode);
            let mut used = cache.iter().map(|entry| entry.bytes).sum::<usize>();
            while cache.len() >= 16 || used + bytes > limit {
                used -= cache.pop_front().expect("cached documents").bytes;
            }
            cache.push_back(CachedParts {
                version: version.into(),
                mode,
                parts: parts.clone(),
                bytes,
                used: Instant::now(),
            });
        }
        Ok(parts)
    }

    fn metadata(&self, path: &str) -> Result<Value> {
        tokio::runtime::Handle::current().block_on(async {
            let response = self
                .http(reqwest::Method::GET, path)
                .timeout(META_TIMEOUT)
                .send()
                .await?;
            if path == "/health" && response.status() == StatusCode::NOT_FOUND {
                return Ok(Value::Null);
            }
            Ok(response_json(response).await?)
        })
    }

    fn estimate(&self, data: &Value, first: &Value, characters: usize) -> Value {
        let Some(speed) = plan::number(&data["charactersPerSecond"]).filter(|value| *value > 0.0)
        else {
            return Value::Null;
        };
        let warmup = plan::number(&data["warmupSeconds"])
            .unwrap_or_default()
            .max(0.0);
        let scheduler = self.scheduler.lock().expect("speech scheduler");
        let pending: f64 = scheduler
            .jobs
            .values()
            .filter(|job| job.state.active())
            .map(|job| job.characters as f64 * (1.0 - job.progress))
            .sum();
        json!({"charactersPerSecond":speed,"warmupSeconds":warmup,
            "firstSeconds":(first["characters"].as_f64().unwrap_or_default()/speed+warmup).ceil(),
            "totalSeconds":(characters as f64/speed+warmup).ceil(),"queueSeconds":(pending/speed).ceil(),
            "measured":data["measured"] == true})
    }

    fn cancelled(&self, key: &ConsumerKey) -> bool {
        self.scheduler
            .lock()
            .expect("speech scheduler")
            .is_cancelled(key)
    }

    fn cancel(&self, owner: &str, value: Option<&Value>) -> Result<Value> {
        let mut scheduler = self.scheduler.lock().expect("speech scheduler");
        let key = scheduler.consumer(owner, value)?;
        scheduler
            .consumers
            .get_mut(&key)
            .ok_or("Не указан идентификатор озвучки.")?
            .1 = true;
        let mut cancelled = HashSet::new();
        for (id, job) in &mut scheduler.jobs {
            if job.consumers.remove(&key) && job.consumers.is_empty() && job.state.active() {
                job.state = Phase::Cancelled;
                job.payload = None;
                job.cancel.send_replace(true);
                cancelled.insert(id.clone());
            }
        }
        scheduler.queue.retain(|id| !cancelled.contains(id));
        Ok(json!({"state":"cancelled"}))
    }

    fn enqueue(
        self: &Arc<Self>,
        key: ConsumerKey,
        book: &str,
        parts: &[SpeechPart],
        index: usize,
        segments: Option<&[SpeechPart]>,
        request: &Value,
        preview: bool,
    ) -> Result<Value> {
        if self.cancelled(&key) {
            return Ok(json!({"state":"cancelled"}));
        }
        let speaker = request["speaker"]
            .as_str()
            .filter(|speaker| !speaker.is_empty())
            .unwrap_or("xenia");
        if !matches!(speaker, "aidar" | "baya" | "kseniya" | "xenia" | "eugene") {
            return Err("Неизвестный голос Silero.".into());
        }
        let options = plan::Options::parse(request.get("options"))?;
        let text = &parts[index].text;
        let segments = options
            .as_ref()
            .map(|_| segments.unwrap_or(&parts[index..index + 1]));
        let engine = self
            .metadata("/health")
            .ok()
            .and_then(|data| engine_id(&data).map(str::to_owned))
            .ok_or("Не удалось проверить сервис Silero. Проверьте контейнер озвучки.")?;
        let id = cache_id(
            &self.model,
            speaker,
            book,
            text,
            &engine,
            options.as_ref(),
            segments,
            index,
            preview,
        )?;
        let attempt = random_id()?;
        let payload = serde_json::to_vec(&Synthesis {
            text,
            speaker,
            model: &self.model,
            request_id: &attempt,
            options: options.as_ref(),
            segments,
        })?;
        if payload.len() as u64 > 16 * MIB {
            return Err("Текст книги слишком большой для озвучки.".into());
        }
        let characters = text.encode_utf16().count();
        let mut scheduler = self.scheduler.lock().expect("speech scheduler");
        if scheduler.is_cancelled(&key) {
            return Ok(json!({"state":"cancelled"}));
        }
        let file = self.file(&id);
        if let Some(job) = scheduler.jobs.get_mut(&id)
            && (job.state.active() || job.state == Phase::Ready && file.is_file())
        {
            job.owners.insert(key.0.clone());
            job.consumers.insert(key);
            return Ok(self.describe(&scheduler, &id, &scheduler.jobs[&id]));
        }
        let cached = file.is_file();
        if !cached && scheduler.queue.len() + usize::from(scheduler.running) >= 8 {
            return Err("Очередь озвучки заполнена. Повторите позже.".into());
        }
        if scheduler.jobs.len() >= 128 && !scheduler.jobs.contains_key(&id) {
            let oldest = scheduler
                .jobs
                .iter()
                .filter(|(_, job)| !job.state.active())
                .min_by_key(|(_, job)| job.created)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                scheduler.jobs.remove(&oldest);
            }
        }
        if cached {
            touch(&file);
        }
        scheduler.jobs.insert(
            id.clone(),
            Job {
                attempt,
                speaker: speaker.into(),
                engine,
                state: if cached { Phase::Ready } else { Phase::Queued },
                phase: String::new(),
                progress: if cached { 1.0 } else { 0.0 },
                remaining: None,
                characters,
                owners: HashSet::from([key.0.clone()]),
                consumers: HashSet::from([key]),
                cancel: watch::channel(false).0,
                payload: (!cached).then_some(payload),
                options: options.is_some(),
                created: Instant::now(),
                error: String::new(),
            },
        );
        if !cached {
            if preview {
                scheduler.queue.push_front(id.clone());
            } else {
                scheduler.queue.push_back(id.clone());
            }
            if !scheduler.running {
                scheduler.running = true;
                let service = self.clone();
                tokio::spawn(async move { service.drain().await });
            }
        }
        Ok(self.describe(&scheduler, &id, &scheduler.jobs[&id]))
    }

    fn describe(&self, scheduler: &Scheduler, id: &str, job: &Job) -> Value {
        let mut state = scheduler.describe(id, job);
        state["speaker"] = job.speaker.as_str().into();
        state["engineId"] = job.engine.as_str().into();
        if job.state == Phase::Ready {
            let expires = now_ms() as u64 + LIFETIME.as_millis() as u64;
            let signature = self.signature(id, &expires.to_string());
            state["url"] = format!("{}{id}.mp3?access={expires}.{signature}", self.root).into();
        }
        state
    }

    pub(super) fn tasks(&self, owner: &str, admin: bool) -> Vec<Value> {
        let scheduler = self.scheduler.lock().expect("speech scheduler");
        let mut jobs = scheduler
            .jobs
            .iter()
            .filter(|(_, job)| admin || job.owners.contains(owner))
            .collect::<Vec<_>>();
        jobs.sort_by_key(|(_, job)| job.created);
        jobs.into_iter()
            .map(|(id, job)| {
                let mut state = scheduler.describe(id, job);
                state["kind"] = "speech".into();
                state["title"] = "Озвучка книги".into();
                state
            })
            .collect()
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.starts_with(&self.root)
    }

    pub(super) fn playback(
        &self,
        request: &Request<Incoming>,
    ) -> std::result::Result<Prepared, StatusCode> {
        let missing = StatusCode::NOT_FOUND;
        let id = request
            .uri()
            .path()
            .strip_prefix(&self.root)
            .and_then(|name| name.strip_suffix(".mp3"))
            .filter(|id| valid_id(id))
            .ok_or(missing)?;
        if !self.enabled() {
            return Err(missing);
        }
        let mut query =
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .filter(|(key, _)| key == "access");
        let (_, token) = query.next().ok_or(missing)?;
        let (expires, signature) = token.split_once('.').ok_or(missing)?;
        let now = now_ms() as u64;
        if query.next().is_some()
            || expires.len() != 13
            || !expires.bytes().all(|byte| byte.is_ascii_digit())
            || !expires
                .parse::<u64>()
                .is_ok_and(|time| (now..=now + LIFETIME.as_millis() as u64).contains(&time))
            || !valid_id(signature)
            || !signature
                .as_bytes()
                .ct_eq(self.signature(id, expires).as_bytes())
                .to_bool()
        {
            return Err(missing);
        }
        let path = self.file(id);
        touch(&path);
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
        Ok(Prepared::File { path, headers })
    }

    fn signature(&self, id: &str, expires: &str) -> String {
        let mut mac = self.signer.clone();
        mac.update(id.as_bytes());
        mac.update(b":");
        mac.update(expires.as_bytes());
        hex(&mac.finalize().into_bytes())
    }

    fn file(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.mp3"))
    }

    fn http(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self.client.request(
            method,
            format!("{}{path}", self.url.as_deref().expect("speech enabled")),
        );
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        request
    }

    async fn drain(self: Arc<Self>) {
        loop {
            let work = {
                let mut scheduler = self.scheduler.lock().expect("speech scheduler");
                let Some(id) = scheduler.queue.pop_front() else {
                    scheduler.running = false;
                    return;
                };
                let job = scheduler.jobs.get_mut(&id).expect("queued job");
                job.state = Phase::Generating;
                Work {
                    id,
                    attempt: job.attempt.clone(),
                    engine: job.engine.clone(),
                    options: job.options,
                    payload: job.payload.take().expect("queued synthesis payload"),
                    cancel: job.cancel.subscribe(),
                }
            };
            let target = self.file(&work.id);
            let temporary = self
                .directory
                .join(format!("{}.{}.partial", work.id, work.attempt));
            let id = work.id.clone();
            let attempt = work.attempt.clone();
            let result = self.generate(work, &temporary).await;
            {
                let mut scheduler = self.scheduler.lock().expect("speech scheduler");
                if let Some(job) = scheduler.jobs.get_mut(&id)
                    && job.attempt == attempt
                    && job.state != Phase::Cancelled
                {
                    // Serialize publishing the finished file with cancellation.
                    match result.and_then(|()| {
                        fs::rename(&temporary, &target)
                            .map_err(|_| "Не удалось сохранить аудиофайл.".to_owned())
                    }) {
                        Ok(()) => job.state = Phase::Ready,
                        Err(error) => {
                            job.state = Phase::Error;
                            job.error = error;
                        }
                    }
                    job.remaining = None;
                }
            }
            let _ = tokio::fs::remove_file(&temporary).await;
        }
    }

    async fn generate(&self, work: Work, temporary: &Path) -> std::result::Result<(), String> {
        let used = self.clean_cache(self.limit - self.limit / 5).await?;
        if used >= self.limit {
            return Err(
                "Кэш озвучки заполнен. Увеличьте INPX_TTS_CACHE_SIZE_MB или повторите позже."
                    .into(),
            );
        }
        let Work {
            id,
            attempt,
            engine,
            options,
            payload,
            mut cancel,
        } = work;
        if *cancel.borrow() {
            return Ok(());
        }
        let progress_path = format!("/jobs/{attempt}");
        let mut worker = Box::pin(self.synthesize(
            payload,
            &engine,
            options,
            temporary,
            self.limit - used,
            cancel.clone(),
        ));
        let tracking = self.track(&id, &attempt, &progress_path);
        tokio::pin!(tracking);
        tokio::select! {
            biased;
            result = &mut worker => result,
            _ = cancel.changed() => {
                // Let Silero release its single worker even with older containers
                // that only implement synthesis.
                let cancellation = self.http(reqwest::Method::POST, &format!("{progress_path}/cancel"))
                    .timeout(META_TIMEOUT).send();
                tokio::pin!(cancellation);
                tokio::select! {
                    result = &mut worker => result,
                    _ = &mut cancellation => worker.await,
                }
            }
            _ = &mut tracking => unreachable!("progress polling ends with the job"),
        }
    }

    async fn track(&self, id: &str, attempt: &str, path: &str) {
        tokio::time::sleep(Duration::from_secs(1)).await;
        loop {
            if let Ok(response) = self
                .http(reqwest::Method::GET, path)
                .timeout(Duration::from_secs(3))
                .send()
                .await
                && let Ok(data) = response_json(response).await
            {
                let mut scheduler = self.scheduler.lock().expect("speech scheduler");
                if let Some(job) = scheduler.jobs.get_mut(id)
                    && job.attempt == attempt
                    && job.state == Phase::Generating
                {
                    job.phase = data["state"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .take(80)
                        .collect();
                    if let Some(progress) = plan::number(&data["progress"]) {
                        job.progress = job.progress.max(progress.clamp(0.0, 1.0));
                    }
                    job.remaining = data["remainingSeconds"]
                        .as_f64()
                        .map(|seconds| seconds.max(0.0));
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn synthesize(
        &self,
        payload: Vec<u8>,
        engine: &str,
        options: bool,
        temporary: &Path,
        available: u64,
        cancel: watch::Receiver<bool>,
    ) -> std::result::Result<(), String> {
        let mut response = self
            .http(reqwest::Method::POST, "/synthesize")
            .header(header::CONTENT_TYPE, "application/json")
            .timeout(self.timeout)
            .body(payload)
            .send()
            .await
            .map_err(transport_error)?;
        if *cancel.borrow() {
            return Ok(());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Ошибка сервиса Silero (HTTP {}). Проверьте его журнал.",
                response.status().as_u16()
            ));
        }
        let headers = response.headers();
        let actual = headers
            .get("x-inpx-speech-engine")
            .and_then(|value| value.to_str().ok());
        let expected = if engine.is_empty() { "builtin" } else { engine };
        if (!engine.is_empty() || actual.is_some()) && actual != Some(expected) {
            return Err(
                "Способ расстановки ударений изменился. Повторите подготовку аудио.".into(),
            );
        }
        if options
            && headers
                .get("x-inpx-speech-options")
                .is_none_or(|value| value != "1")
        {
            return Err("Обновите контейнер Silero: он не поддерживает настройки озвучки.".into());
        }
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|mime| mime.starts_with("audio/mpeg"))
        {
            return Err("Silero вернул некорректный аудиофайл.".into());
        }
        let storage = |_| "Не удалось сохранить аудиофайл.".to_owned();
        let mut file = tokio::fs::File::create(temporary).await.map_err(storage)?;
        let mut bytes = 0;
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            if *cancel.borrow() {
                return Ok(());
            }
            bytes += chunk.len() as u64;
            if bytes > available {
                return Err("Недостаточно места в кэше озвучки.".into());
            }
            file.write_all(&chunk).await.map_err(storage)?;
        }
        if bytes == 0 {
            return Err("Silero вернул пустой аудиофайл.".into());
        }
        file.flush().await.map_err(storage)
    }

    async fn clean_cache(&self, target: u64) -> std::result::Result<u64, String> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&directory)?;
            let mut size = 0u64;
            let mut files = Vec::new();
            for entry in fs::read_dir(directory)?.flatten() {
                let path = entry.path();
                if path.extension() != Some(OsStr::new("mp3"))
                    || !path
                        .file_stem()
                        .and_then(OsStr::to_str)
                        .is_some_and(valid_id)
                {
                    continue;
                }
                if let Ok(metadata) = entry.metadata()
                    && metadata.is_file()
                {
                    size = size.saturating_add(metadata.len());
                    if let Ok(when) = metadata.modified()
                        && when.elapsed().is_ok_and(|age| age >= LIFETIME)
                    {
                        files.push((when, metadata.len(), path));
                    }
                }
            }
            files.sort_unstable_by_key(|(when, _, _)| *when);
            for (_, bytes, path) in files {
                if size <= target {
                    break;
                }
                if fs::remove_file(&path).is_ok() {
                    size = size.saturating_sub(bytes);
                }
            }
            Ok::<_, std::io::Error>(size)
        })
        .await
        .map_err(|_| "Кэш озвучки недоступен.".to_owned())?
        .map_err(|_| "Кэш озвучки недоступен.".to_owned())
    }
}

impl Scheduler {
    fn consumer(&mut self, owner: &str, value: Option<&Value>) -> Result<ConsumerKey> {
        let Some(value) = value else {
            return Ok((owner.into(), None));
        };
        let id = value
            .as_str()
            .filter(|id| {
                (16..=128).contains(&id.len())
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            .ok_or("Некорректный идентификатор озвучки.")?;
        let key = (owner.into(), Some(id.into()));
        let now = Instant::now();
        self.consumers.retain(|key, (used, _)| {
            now.duration_since(*used) < CONSUMER_LIFETIME
                || self
                    .jobs
                    .values()
                    .any(|job| job.state.active() && job.consumers.contains(key))
        });
        if self.consumers.len() >= 4096 && !self.consumers.contains_key(&key) {
            return Err("Слишком много запросов озвучки. Повторите позже.".into());
        }
        self.consumers.entry(key.clone()).or_insert((now, false)).0 = now;
        Ok(key)
    }

    fn is_cancelled(&self, key: &ConsumerKey) -> bool {
        self.consumers
            .get(key)
            .is_some_and(|(_, cancelled)| *cancelled)
    }

    fn describe(&self, id: &str, job: &Job) -> Value {
        let queue_position = self
            .queue
            .iter()
            .position(|queued| queued == id)
            .map_or(0, |position| position + 1);
        json!({"id":id,"state":job.state,"error":job.error,"phase":job.phase,
            "progress":if job.state == Phase::Ready { 1.0 } else { job.progress.min(0.99) },
            "remainingSeconds":job.remaining,"queuePosition":queue_position})
    }
}

fn cache_id(
    model: &str,
    speaker: &str,
    book: &str,
    text: &str,
    engine: &str,
    options: Option<&plan::Options>,
    segments: Option<&[SpeechPart]>,
    index: usize,
    preview: bool,
) -> Result<String> {
    let mut key = vec![
        json!("silero-mp3-v1"),
        json!(model),
        json!(speaker),
        json!(book),
        json!(text),
    ];
    let mut bytes = serde_json::to_vec(&key)?;
    if let Some(options) = options {
        bytes.pop();
        bytes.extend_from_slice(b",\"speech-options-v1\",");
        serde_json::to_writer(&mut bytes, options)?;
        bytes.push(b',');
        let segments = segments.expect("custom options have segments");
        if preview {
            serde_json::to_writer(&mut bytes, segments)?;
        } else {
            let start = if book.ends_with(&format!(":{index}")) {
                index
            } else {
                0
            };
            let parts = segments
                .iter()
                .enumerate()
                .map(|(index, part)| CachedSegment {
                    index: start + index,
                    title: &part.title,
                    part,
                })
                .collect::<Vec<_>>();
            serde_json::to_writer(&mut bytes, &parts)?;
        }
        bytes.push(b']');
    }
    if !engine.is_empty() {
        key.clear();
        key.extend([json!("speech-engine-v1"), json!(engine)]);
        bytes.pop();
        bytes.push(b',');
        bytes.extend_from_slice(&serde_json::to_vec(&key)?[1..]);
    }
    Ok(hex(&Sha256::digest(bytes)))
}

fn engine_id(data: &Value) -> Option<&str> {
    let value = data["cacheIdentity"]
        .as_str()
        .or_else(|| data["cacheIdentity"].is_null().then_some(""))?;
    (value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte)))
    .then_some(value)
}

fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn random_id() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").expect("hex");
    }
    output
}

fn touch(path: &Path) {
    if let Ok(file) = File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

async fn response_json(mut response: reqwest::Response) -> Result<Value> {
    response = response.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err("Ответ Silero слишком большой.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Истекло время подготовки аудио.".into()
    } else {
        "Сервис Silero недоступен. Проверьте контейнер озвучки.".into()
    }
}
