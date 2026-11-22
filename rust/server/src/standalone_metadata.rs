use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use inpx_catalog::book_delivery::{self, Book};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc};
use tokio::time::{Duration, Instant as Deadline, timeout_at};
use url::Url;

use super::{State, VERSION, env, send_bytes};
use crate::http::Body;
use crate::opds::standalone::genre_label;
use crate::request_access::{
    Admission, CoverSigner, MetadataService, ServiceAccess, query_values, trim_js,
};
use crate::standalone_download::load_book;

const SEARCH: Duration = Duration::from_secs(8);
const ENRICH: Duration = Duration::from_secs(3);
const READS: usize = 2;
const PENDING: usize = READS + 16;
const CACHE_BYTES: usize = 8 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

pub(super) struct Routes {
    root: String,
    prefix: String,
    searches: Arc<Semaphore>,
    reads: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    cache: Mutex<Cache>,
}

#[derive(Clone)]
pub(crate) struct Endpoint {
    pub(crate) enabled: bool,
    pub(crate) rules: MetadataService,
    pub(super) public_url: Option<String>,
    pub(super) limit: usize,
}

#[derive(Default)]
struct Cache {
    rows: VecDeque<(String, Instant, Value, usize)>,
    bytes: usize,
}

impl Endpoint {
    pub(crate) fn new(config: &Value, prefix: &str) -> Self {
        let enabled = std::env::var("INPX_ABS_ENABLED")
            .map_or(config["absEnabled"] == true, |value| value == "true");
        let token = env("INPX_ABS_TOKEN")
            .or_else(|| config["absToken"].as_str().map(str::to_owned))
            .map(|value| trim_js(&value).to_owned())
            .unwrap_or_default();
        let limit = env("INPX_ABS_MAX_RESULTS")
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value != 0.0)
            .or_else(|| config["absMaxResults"].as_f64())
            .unwrap_or(10.0);
        Self {
            enabled,
            rules: MetadataService {
                path: format!("{}/api/audiobookshelf", prefix.trim_end_matches('/')),
                token,
            },
            public_url: env("INPX_ABS_PUBLIC_URL")
                .or_else(|| config["absPublicUrl"].as_str().map(str::to_owned))
                .map(|value| trim_js(&value).to_owned())
                .filter(|value| !value.is_empty()),
            limit: limit.floor().clamp(1.0, 20.0) as usize,
        }
    }
}

impl Routes {
    pub(super) fn new(prefix: &str) -> Self {
        let prefix = prefix.trim_end_matches('/').to_owned();
        Self {
            root: format!("{prefix}/api/audiobookshelf"),
            prefix,
            searches: Arc::new(Semaphore::new(2)),
            reads: Arc::new(Semaphore::new(READS)),
            pending: Arc::new(Semaphore::new(PENDING)),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.trim_end_matches('/')
            .strip_prefix(&self.root)
            .is_some_and(|route| matches!(route, "" | "/search" | "/cover"))
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        endpoint: &Endpoint,
        request: &Request<Incoming>,
        admission: &Admission,
    ) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        let path = request.uri().path().trim_end_matches('/');
        let denied = if !endpoint.enabled {
            Some((StatusCode::NOT_FOUND, "Metadata provider is disabled"))
        } else if endpoint.rules.token.is_empty() {
            Some((
                StatusCode::SERVICE_UNAVAILABLE,
                "INPX_ABS_TOKEN is required",
            ))
        } else if !matches!(
            admission.service,
            ServiceAccess::Metadata | ServiceAccess::SignedCover(_)
        ) {
            Some((StatusCode::UNAUTHORIZED, "Invalid authorization token"))
        } else {
            None
        };
        if path == self.root {
            let mut info = self.info(endpoint);
            if let Some((status, message)) = denied {
                info["error"] = message.into();
                return reply(status, info, head);
            }
            let running = READS - self.reads.available_permits();
            let pending = PENDING - self.pending.available_permits();
            info["diagnostics"] = json!({
                "activeSearches": 2 - self.searches.available_permits(),
                "activeArchiveReads": running, "queuedArchiveReads": pending.saturating_sub(running),
                "pendingMetadata": pending, "cachedMetadata": self.cache.lock().expect("metadata cache").rows.len(),
            });
            return reply(StatusCode::OK, info, head);
        }
        if let Some((status, message)) = denied {
            return failure(status, message, head);
        }
        let query = request.uri().query().unwrap_or_default();
        if path.ends_with("/cover") {
            return self.cover(state, query, head).await;
        }
        let Ok([Some(title), author]) = query_values(query, ["query", "author"]) else {
            return failure(
                StatusCode::BAD_REQUEST,
                "Provide query or author, at most 200 characters each",
                head,
            );
        };
        let author = author.as_deref().unwrap_or_default();
        if title.encode_utf16().count() > 200
            || author.encode_utf16().count() > 200
            || trim_js(&title).is_empty() && trim_js(author).is_empty()
        {
            return failure(
                StatusCode::BAD_REQUEST,
                "Provide query or author, at most 200 characters each",
                head,
            );
        }
        let Some(base) = self.base_url(endpoint, request, admission) else {
            return failure(
                StatusCode::BAD_REQUEST,
                "Invalid metadata provider public URL",
                head,
            );
        };
        self.search(
            state,
            endpoint,
            trim_js(&title),
            trim_js(author),
            base,
            head,
        )
        .await
    }

    fn info(&self, endpoint: &Endpoint) -> Value {
        let search = format!("{}/search", self.root);
        json!({
            "provider":"inpx-web", "version":VERSION,
            "description":"Провайдер метаданных Audiobookshelf. Укажите этот базовый адрес в настройках custom provider; ABS сам добавляет /search.",
            "search":search, "cover":format!("{}/cover",self.root), "authorizationRequired":true,
            "configuration":{"enabled":endpoint.enabled,"tokenConfigured":!endpoint.rules.token.is_empty()},
            "authorization":{"header":"Authorization","formats":["<INPX_ABS_TOKEN>","Bearer <INPX_ABS_TOKEN>"]},
            "parameters":{"query":"Название книги; параметр обязателен, но может быть пустым при поиске по автору.",
                "author":"Имя автора; необязательный параметр. Название или автор должны быть заполнены.","maxLength":200},
            "limits":{"maxResults":endpoint.limit,"searchTimeoutMs":SEARCH.as_millis() as u64,"metadataTimeoutMs":ENRICH.as_millis() as u64},
            "example":{"method":"GET","path":format!("{search}?query=&author=%D0%A5%D0%B0%D0%BD%D0%B4%D0%BA%D0%B5"),
                "curl":format!("curl --get 'http://<host>:12380{search}' --header 'Authorization: <INPX_ABS_TOKEN>' --data-urlencode 'query=' --data-urlencode 'author=Хандке'")},
            "troubleshooting":{
                "400":"Проверьте query и author: строки до 200 символов, хотя бы одна непустая.",
                "401":"Передайте INPX_ABS_TOKEN в заголовке Authorization. В браузере заголовок обычно отсутствует.",
                "403":"Проверьте общую авторизацию inpx-web и правила reverse proxy.",
                "404":"Включите провайдер: INPX_ABS_ENABLED=true.",
                "429":"Дождитесь завершения активных поисков и повторите запрос.",
                "503":"Проверьте INPX_ABS_TOKEN, готовность индекса и доступность библиотеки."
            }
        })
    }

    fn base_url(
        &self,
        endpoint: &Endpoint,
        request: &Request<Incoming>,
        admission: &Admission,
    ) -> Option<Url> {
        let supplied = if let Some(url) = &endpoint.public_url {
            url.clone()
        } else {
            let host = admission
                .forwarded_host
                .as_deref()
                .or_else(|| {
                    request
                        .headers()
                        .get(header::HOST)?
                        .to_str()
                        .ok()?
                        .split(',')
                        .next()
                })?
                .trim();
            let scheme = if admission.secure { "https" } else { "http" };
            format!("{scheme}://{host}{}", self.prefix)
        };
        let base = Url::parse(&format!("{}/", supplied.trim_end_matches('/'))).ok()?;
        (matches!(base.scheme(), "http" | "https")
            && base.host_str().is_some()
            && base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none())
        .then_some(base)
    }

    async fn search(
        &self,
        state: &Arc<State>,
        endpoint: &Endpoint,
        title: &str,
        author: &str,
        base: Url,
        head: bool,
    ) -> Response<Body> {
        let Ok(permit) = self.searches.clone().try_acquire_owned() else {
            return busy("Too many metadata searches", head);
        };
        let deadline = Deadline::now() + SEARCH;
        let mut criteria = json!({"del":"0","limit":60,"offset":0});
        if !title.is_empty() {
            criteria["title"] = format!("*{title}").into();
        }
        if let Some(term) = author
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .fold(None, |longest: Option<&str>, word| {
                Some(
                    longest
                        .filter(|previous| {
                            previous.encode_utf16().count() >= word.encode_utf16().count()
                        })
                        .unwrap_or(word),
                )
            })
        {
            criteria["author"] = format!("*{term}").into();
        }
        let server = state.clone();
        let outcome = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || {
                let found = server.index.catalogue.read().ok().and_then(|catalogue| {
                    catalogue
                        .as_ref()?
                        .browser_books(criteria.as_object()?)
                        .ok()
                });
                (permit, found)
            }),
        )
        .await;
        let (_permit, result) = match outcome {
            Ok(Ok((permit, Some(result)))) => (permit, result),
            Err(_) => {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Metadata index search timed out",
                    head,
                );
            }
            _ => {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Metadata search is unavailable",
                    head,
                );
            }
        };
        let title = normalized(title);
        let wanted = normalized(author);
        let mut books: Vec<_> = result["found"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| {
                wanted.split_whitespace().all(|word| {
                    normalized(field(row, "author"))
                        .split_whitespace()
                        .any(|candidate| {
                            candidate == word
                                || word.encode_utf16().count() == 1 && candidate.starts_with(word)
                        })
                })
            })
            .collect();
        books.sort_by_cached_key(|book| {
            std::cmp::Reverse(
                u8::from(normalized(field(book, "title")) == title) * 4
                    + u8::from(book["ext"] == "fb2"),
            )
        });
        books.truncate(endpoint.limit);
        let index = state.index.snapshot();
        let mut extras = vec![Value::Null; books.len()];
        let (sender, mut receiver) = mpsc::channel(books.len().max(1));
        for (i, row) in books.iter().enumerate() {
            let Ok(book) = serde_json::from_value::<Book>((*row).clone()) else {
                continue;
            };
            let key = format!(
                "{}:{}:{}",
                index["inpxHash"], index["indexUpdate"]["updatedAt"], book.uid
            );
            let sender = sender.clone();
            let state = state.clone();
            tokio::spawn(async move {
                let extra = state.metadata.read(&state, key, book).await;
                let _ = sender.send((i, extra)).await;
            });
        }
        drop(sender);
        let budget = deadline.min(Deadline::now() + ENRICH);
        while let Ok(Some((i, extra))) = timeout_at(budget, receiver.recv()).await {
            extras[i] = extra;
        }
        let signer = CoverSigner::new(&endpoint.rules.token);
        let cover = base
            .join("api/audiobookshelf/cover")
            .expect("fixed metadata route");
        let entries: Vec<_> = books
            .into_iter()
            .zip(extras)
            .map(|(book, extra)| {
                let mut entry = metadata(book, &extra);
                let uid = field(book, "_uid");
                let (expires, signature) = signer.signed(uid);
                let mut url = cover.clone();
                url.query_pairs_mut()
                    .append_pair("uid", uid)
                    .append_pair("expires", &expires.to_string())
                    .append_pair("signature", &signature);
                entry["cover"] = url.as_str().into();
                entry
            })
            .collect();
        reply(StatusCode::OK, json!({"matches":entries}), head)
    }

    async fn read(&self, state: &Arc<State>, key: String, book: Book) -> Value {
        if let Some(value) = self.cache.lock().expect("metadata cache").get(&key) {
            return value;
        }
        let Ok(pending) = self.pending.clone().try_acquire_owned() else {
            return Value::Null;
        };
        let Ok(reader) = self.reads.clone().acquire_owned().await else {
            return Value::Null;
        };
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let (_pending, _reader) = (pending, reader);
            let value = book
                .source(&state.index.sources())
                .and_then(|source| book_delivery::metadata(&book, source).ok())
                .unwrap_or_default();
            state
                .metadata
                .cache
                .lock()
                .expect("metadata cache")
                .insert(key, &value);
            value
        })
        .await
        .unwrap_or_default()
    }

    async fn cover(&self, state: &Arc<State>, query: &str, head: bool) -> Response<Body> {
        let Ok([Some(uid)]) = query_values(query, ["uid"]) else {
            return failure(StatusCode::BAD_REQUEST, "Invalid book UID", head);
        };
        if uid.is_empty() || uid.encode_utf16().count() > 256 {
            return failure(StatusCode::BAD_REQUEST, "Invalid book UID", head);
        }
        let Ok(pending) = self.pending.clone().try_acquire_owned() else {
            return busy("Metadata queue is full", head);
        };
        let Ok(reader) = self.reads.clone().acquire_owned().await else {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cover is unavailable",
                head,
            );
        };
        let state = state.clone();
        let uid = uid.into_owned();
        tokio::task::spawn_blocking(move || {
            let (_pending, _reader) = (pending, reader);
            match load_book(&state.index.catalogue, &uid) {
                Ok(None) => failure(StatusCode::NOT_FOUND, "Book not found", head),
                Ok(Some(book)) => match state.downloads.book_cover(&book, &state.index.sources()) {
                    Ok(Some(image)) => {
                        if let Err(error) = image.stage(state.downloads.cache()) {
                            eprintln!("Metadata cover cache: {error}");
                        }
                        let mut response = send_bytes(image.bytes, image.content_type, head);
                        response.headers_mut().insert(
                            header::X_CONTENT_TYPE_OPTIONS,
                            HeaderValue::from_static("nosniff"),
                        );
                        response
                    }
                    Ok(None) => failure(StatusCode::NOT_FOUND, "Cover not found", head),
                    Err(_) => failure(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Cover is unavailable",
                        head,
                    ),
                },
                Err(_) => failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Cover is unavailable",
                    head,
                ),
            }
        })
        .await
        .unwrap_or_else(|_| {
            failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cover is unavailable",
                head,
            )
        })
    }
}

impl Cache {
    fn get(&mut self, key: &str) -> Option<Value> {
        let index = self.rows.iter().position(|row| row.0 == key)?;
        let row = self.rows.remove(index)?;
        if row.1.elapsed() > CACHE_TTL {
            self.bytes -= row.3;
            return None;
        }
        let value = row.2.clone();
        self.rows.push_front(row);
        Some(value)
    }

    fn insert(&mut self, key: String, value: &Value) {
        let bytes = value.to_string().len();
        if bytes > CACHE_BYTES {
            return;
        }
        if let Some(index) = self.rows.iter().position(|row| row.0 == key)
            && let Some(row) = self.rows.remove(index)
        {
            self.bytes -= row.3;
        }
        self.bytes += bytes;
        self.rows
            .push_front((key, Instant::now(), value.clone(), bytes));
        while self.rows.len() > 200 || self.bytes > CACHE_BYTES {
            self.bytes -= self.rows.pop_back().expect("cache eviction").3;
        }
    }
}

fn normalized(value: &str) -> String {
    value
        .to_lowercase()
        .replace('ё', "е")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn optional(value: &str) -> &str {
    let value = trim_js(value);
    if value.eq_ignore_ascii_case("null") {
        ""
    } else {
        value
    }
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    optional(value[name].as_str().unwrap_or_default())
}

fn metadata(book: &Value, extra: &Value) -> Value {
    let title = field(book, "title");
    let mut value = json!({"title":if title.is_empty() { "Без названия" } else { title }});
    let author = field(book, "author")
        .split(',')
        .map(optional)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let preferred = |field_name: &str, fallback: &str| {
        let text = field(extra, field_name);
        if text.is_empty() {
            field(book, fallback)
        } else {
            text
        }
    };
    for (name, text) in [
        ("author", author.as_str()),
        ("language", preferred("language", "lang")),
        ("description", field(extra, "description")),
        ("publisher", field(extra, "publisher")),
        ("isbn", field(extra, "isbn")),
        ("publishedYear", preferred("publishedYear", "year")),
    ] {
        if !text.is_empty() && !(name == "publishedYear" && text == "0") {
            value[name] = text.into();
        }
    }
    let genres: Vec<_> = field(book, "genre")
        .split([',', ':'])
        .map(optional)
        .filter(|code| !code.is_empty())
        .map(genre_label)
        .collect();
    if !genres.is_empty() {
        value["genres"] = json!(genres);
    }
    let mut seen = HashSet::new();
    let tags: Vec<_> = extra["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(field(book, "keywords").split([',', ';']))
        .map(optional)
        .filter(|tag| !tag.is_empty() && seen.insert(*tag))
        .collect();
    if !tags.is_empty() {
        value["tags"] = json!(tags);
    }
    let series = field(book, "series");
    if !series.is_empty() {
        let mut item = json!({"series":series});
        let sequence = match &book["serno"] {
            Value::Number(number) if number.as_f64().is_some_and(|value| value != 0.0) => {
                number.to_string()
            }
            Value::String(value) if !optional(value).is_empty() => optional(value).into(),
            _ => String::new(),
        };
        if !sequence.is_empty() {
            item["sequence"] = sequence.into();
        }
        value["series"] = json!([item]);
    }
    value
}

fn reply(status: StatusCode, value: Value, head: bool) -> Response<Body> {
    let mut response = send_bytes(
        serde_json::to_vec(&value).expect("metadata response"),
        "application/json; charset=utf-8",
        head,
    );
    *response.status_mut() = status;
    response
}

fn failure(status: StatusCode, message: &str, head: bool) -> Response<Body> {
    reply(status, json!({"error":message}), head)
}

fn busy(message: &str, head: bool) -> Response<Body> {
    let mut response = failure(StatusCode::TOO_MANY_REQUESTS, message, head);
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    response
}
