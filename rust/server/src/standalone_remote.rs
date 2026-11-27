use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use inpx_catalog::{
    Result,
    book_delivery::Book,
    library_media::{InpxExchange, Rating},
};
use reqwest::{Client, StatusCode, Upgraded, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_tungstenite::{WebSocketStream, tungstenite};
use tungstenite::handshake::{client::generate_key, derive_accept_key};
use tungstenite::protocol::{Message, Role, WebSocketConfig};
use url::Url;

const MAX_UID: usize = 512;
const MAX_COUNT: u64 = (1 << 53) - 1;
const TTL: Duration = Duration::from_secs(60);
const CONNECT: Duration = Duration::from_secs(10);
const TRANSFER: Duration = Duration::from_secs(120);
const MIB: u64 = 1024 * 1024;

pub(crate) struct Remote {
    url: Url,
    password: String,
    client: Client,
    maximum: u64,
    inpx: PathBuf,
    revision: InpxExchange,
    sync: std::sync::Mutex<()>,
    session: Mutex<Session>,
}

#[derive(Default)]
struct Session {
    socket: Option<WebSocketStream<Upgraded>>,
    token: String,
    request: u64,
    generation: u64,
    protocol: Option<Protocol>,
    ratings: Option<std::sync::Arc<Ratings>>,
}

struct Protocol {
    metadata: bool,
    ratings: bool,
    source: String,
    checked: Instant,
}

pub(super) struct Ratings {
    pub revision: String,
    pub source: String,
    pub counts: HashMap<String, u64>,
    fetched: Instant,
}

#[derive(Debug)]
pub(crate) struct Unavailable;

impl std::fmt::Display for Unavailable {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("Удалённая библиотека недоступна")
    }
}

impl std::error::Error for Unavailable {}

impl Remote {
    pub(super) fn address(config: &Value) -> Result<Option<Url>> {
        if matches!(config, Value::Null | Value::Bool(false)) {
            return Ok(None);
        }
        let mut url = Url::parse(
            config["url"]
                .as_str()
                .ok_or("Укажите адрес удалённой библиотеки")?,
        )
        .map_err(|_| "Некорректный адрес удалённой библиотеки")?;
        let scheme = match url.scheme() {
            "ws" => "http",
            "wss" => "https",
            _ => {
                return Err(
                    "Адрес удалённой библиотеки должен начинаться с ws:// или wss://".into(),
                );
            }
        };
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Некорректный адрес удалённой библиотеки".into());
        }
        url.set_scheme(scheme)
            .map_err(|_| "Некорректная схема удалённой библиотеки")?;
        super::net::validate_integration_url(&url, "удалённой библиотеки")?;
        Ok(Some(url))
    }

    pub(super) fn new(config: &Value, data: &Path) -> Result<Option<Self>> {
        let Some(url) = Self::address(&config["remoteLib"])? else {
            return Ok(None);
        };
        let inpx = data.join("remote.inpx");
        Ok(Some(Self {
            url,
            password: text(&config["remoteLib"], "accessPassword").to_owned(),
            client: Client::builder()
                .http1_only()
                .connect_timeout(CONNECT)
                .timeout(TRANSFER)
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(std::sync::Arc::new(super::net::NoMetadataDnsResolver))
                .build()?,
            maximum: config["maxPayloadSize"]
                .as_u64()
                .unwrap_or(500)
                .clamp(1, 1024)
                * MIB,
            revision: InpxExchange::new(inpx.clone()),
            inpx,
            sync: std::sync::Mutex::default(),
            session: Mutex::default(),
        }))
    }

    pub(super) fn has_inpx(&self) -> bool {
        self.inpx.is_file()
    }

    pub(super) fn sync_inpx(&self) -> Result<()> {
        let _sync = self.sync.lock().map_err(|_| Unavailable)?;
        let previous = self.revision.current_hash()?;
        let encoded: Result<Option<String>> = tokio::runtime::Handle::current().block_on(async {
            let mut session = self.session.lock().await;
            self.protocol(&mut session).await?;
            let mut reply = self
                .request(
                    &mut session,
                    json!({"action":"get-inpx-file","inpxFileHash":previous}),
                )
                .await?;
            match reply["data"].take() {
                Value::Bool(false) if !previous.is_empty() => Ok(None),
                Value::String(encoded) => Ok(Some(encoded)),
                _ => Err("Некорректный ответ при загрузке удалённого INPX".into()),
            }
        });
        if let Some(encoded) = encoded? {
            inpx_catalog::library_media::install_remote_inpx(&self.inpx, &encoded, self.maximum)?;
        }
        Ok(())
    }

    pub(crate) fn download(
        &self,
        book: &Book,
        directory: &Path,
        cached: impl Fn(&str) -> bool,
    ) -> Result<String> {
        tokio::runtime::Handle::current().block_on(async {
            let (response, token) = {
                let mut session = self.session.lock().await;
                let response = self
                    .book_request(&mut session, book, json!({"action":"get-book-link"}))
                    .await
                    .map_err(|error| {
                        if missing_book(&error.to_string()) {
                            Box::new(io::Error::from(io::ErrorKind::NotFound))
                                as Box<dyn std::error::Error>
                        } else {
                            error
                        }
                    })?;
                (response, session.token.clone())
            };
            let (url, hash) = self.book_url(text(&response, "link"))?;
            if cached(&hash) {
                return Ok(hash);
            }
            let mut request = self
                .client
                .get(url)
                .header(header::ACCEPT_ENCODING, "identity");
            if !token.is_empty() {
                request = request.header("x-inpx-access-token", token);
            }
            let mut response = request.send().await.map_err(|_| Unavailable)?;
            match response.status() {
                StatusCode::OK => {}
                StatusCode::NOT_FOUND | StatusCode::GONE => {
                    return Err(io::Error::from(io::ErrorKind::NotFound).into());
                }
                _ => return Err(Unavailable.into()),
            }
            if response
                .content_length()
                .is_some_and(|size| size > self.maximum)
            {
                return Err(inpx_catalog::book_delivery::too_large());
            }
            if response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_some_and(|value| value != "identity")
            {
                return Err(Unavailable.into());
            }
            let expected = response.content_length();
            let mut output = tokio::fs::File::create_new(directory.join("book")).await?;
            let mut digest = Sha256::new();
            let mut size = 0;
            while let Some(chunk) = response.chunk().await.map_err(|_| Unavailable)? {
                size += chunk.len() as u64;
                if size > self.maximum {
                    return Err(inpx_catalog::book_delivery::too_large());
                }
                digest.update(&chunk);
                tokio::io::AsyncWriteExt::write_all(&mut output, &chunk).await?;
            }
            if size == 0
                || expected.is_some_and(|expected| size != expected)
                || hex(&digest.finalize()) != hash
            {
                return Err(Unavailable.into());
            }
            Ok(hash)
        })
    }

    fn book_url(&self, link: &str) -> Result<(Url, String)> {
        if link.is_empty() {
            return Err(Unavailable.into());
        }
        let mut base = self.url.clone();
        let path = base
            .path()
            .trim_end_matches('/')
            .trim_end_matches("/ws")
            .to_owned()
            + "/";
        base.set_path(&path);
        let mut url = base.join(link).map_err(|_| Unavailable)?;
        if url.origin() != self.url.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Unavailable.into());
        }
        let hash = url.path().rsplit('/').next().unwrap_or_default();
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Unavailable.into());
        }
        let hash = hash.to_ascii_lowercase();
        url.path_segments_mut()
            .map_err(|_| Unavailable)?
            .push("raw");
        Ok((url, hash))
    }

    pub(super) fn author(&self, name: &str) -> Result<Value> {
        tokio::runtime::Handle::current().block_on(async {
            let mut session = self.session.lock().await;
            if name.is_empty() || !self.protocol(&mut session).await?.metadata {
                return Ok(Value::Null);
            }
            let response = self
                .request(
                    &mut session,
                    json!({"action":"get-library-metadata","kind":"author","author":name}),
                )
                .await?;
            let author = &response["authorInfo"];
            Ok(if author.is_object() {
                json!({"html":crate::opds::html::sanitize(clip(text(author,"html"), 128_000)),
                    "text":clip(text(author,"text"),128_000),"photo":""})
            } else {
                Value::Null
            })
        })
    }

    pub(super) fn reviews(&self, book: &Book) -> Result<Vec<Value>> {
        tokio::runtime::Handle::current().block_on(async {
            let mut session = self.session.lock().await;
            if !self.protocol(&mut session).await?.metadata {
                return Ok(Vec::new());
            }
            let mut items = Vec::new();
            let mut cursor = 0;
            let mut generation = None;
            loop {
                let page = self
                    .book_request(
                        &mut session,
                        book,
                        json!({"action":"get-library-metadata","kind":"reviews","cursor":cursor}),
                    )
                    .await?;
                same_connection(&mut generation, session.generation)?;
                for item in elements(&page, 10)? {
                    items.push(json!({"name":clip(text(item,"name"),300),
                        "time":clip(text(item,"time"),100),"text":clip(text(item,"text"),16000)}));
                }
                let Some(next) = next(&page, cursor, 10_000)? else {
                    return Ok(items);
                };
                cursor = next;
            }
        })
    }

    pub(super) fn rating(&self, book: &Book) -> Result<Option<Rating>> {
        tokio::runtime::Handle::current().block_on(async {
            let mut session = self.session.lock().await;
            if !self.protocol(&mut session).await?.metadata {
                return Ok(None);
            }
            let reply = self
                .book_request(
                    &mut session,
                    book,
                    json!({"action":"get-library-metadata","kind":"rating"}),
                )
                .await?;
            let rating = &reply["rating"];
            Ok(rating["count"]
                .as_u64()
                .zip(rating["value"].as_f64())
                .filter(|(count, value)| {
                    (1..=MAX_COUNT).contains(count) && *value > 0.0 && *value <= 5.0
                })
                .map(|(count, value)| Rating { count, value }))
        })
    }

    pub(super) fn ratings(&self, mut progress: impl FnMut(u64)) -> Result<std::sync::Arc<Ratings>> {
        tokio::runtime::Handle::current().block_on(async {
            let mut session = self.session.lock().await;
            let protocol = self.protocol(&mut session).await?;
            let source = protocol.source.clone();
            let supported = protocol.ratings;
            if let Some(cached) = &session.ratings
                && cached.fetched.elapsed() < TTL {
                return Ok(cached.clone());
            }
            let mut result = Ratings {
                revision: "legacy".into(), source, counts: HashMap::new(), fetched: Instant::now(),
            };
            if supported {
                let mut cursor = 0;
                let mut revision: Option<String> = None;
                let mut generation = None;
                loop {
                    let page = self.request(&mut session, json!({
                        "action":"get-library-metadata","kind":"ratings","cursor":cursor,"revision":revision,
                    })).await?;
                    same_connection(&mut generation, session.generation)?;
                    let given = text(&page, "revision");
                    if given.is_empty() || given.len() > 512 || revision.as_deref().is_some_and(|old| old != given) {
                        return Err("Индекс удалённых оценок изменился во время загрузки".into());
                    }
                    if revision.is_none() { revision = Some(given.to_owned()); }
                    for item in elements(&page, 1000)? {
                        let uid = item[0].as_str().filter(|uid| !uid.is_empty() && uid.len() <= MAX_UID)
                            .ok_or("Некорректный UID в удалённом индексе оценок")?;
                        let count = item[1].as_u64().filter(|count| *count <= MAX_COUNT)
                            .ok_or("Некорректное число голосов удалённой книги")?;
                        result.counts.insert(uid.to_owned(), count);
                    }
                    progress(result.counts.len() as u64);
                    let Some(next) = next(&page, cursor, 10_000_000)? else { break; };
                    cursor = next;
                }
                result.revision = revision.expect("ratings page");
            }
            result.fetched = Instant::now();
            let result = std::sync::Arc::new(result);
            session.ratings = Some(result.clone());
            Ok(result)
        })
    }

    async fn book_request(
        &self,
        session: &mut Session,
        book: &Book,
        mut request: Value,
    ) -> Result<Value> {
        let source = &self.protocol(session).await?.source;
        let (primary, legacy) = book.remote_ids(source)?;
        request["bookUid"] = primary.into();
        let value = self.request(session, request.clone()).await;
        if let Some(uid) = legacy
            && value
                .as_ref()
                .err()
                .is_some_and(|error| missing_book(&error.to_string()))
        {
            request["bookUid"] = uid.into();
            return self.request(session, request).await;
        }
        value
    }

    async fn protocol<'a>(&self, session: &'a mut Session) -> Result<&'a Protocol> {
        if session
            .protocol
            .as_ref()
            .is_none_or(|protocol| protocol.checked.elapsed() >= TTL)
        {
            let response = self
                .request(session, json!({"action":"get-config"}))
                .await?;
            let advertised = &response["libraryProtocol"];
            let features = if advertised.is_null() {
                None
            } else {
                if advertised["version"] != 1 || !advertised["features"].is_array() {
                    return Err("Несовместимая версия протокола удалённой библиотеки".into());
                }
                advertised["features"].as_array()
            };
            let supports = |feature: &str| {
                features.is_some_and(|all| all.iter().any(|value| value == feature))
            };
            let default = response["librarySources"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|source| source["enabled"] != false && source["type"] != "folder")
                .map(|source| text(source, "id"))
                .filter(|id| !id.is_empty())
                .unwrap_or("main");
            session.protocol = Some(Protocol {
                metadata: supports("metadata"),
                ratings: supports("ratings"),
                source: advertised["sourceId"]
                    .as_str()
                    .unwrap_or(default)
                    .to_owned(),
                checked: Instant::now(),
            });
        }
        Ok(session.protocol.as_ref().expect("negotiated protocol"))
    }

    async fn request(&self, session: &mut Session, mut request: Value) -> Result<Value> {
        let mut retries = 1;
        let mut challenged = false;
        loop {
            session.request = session.request.wrapping_add(1).max(1);
            request["requestId"] = session.request.into();
            if !session.token.is_empty() {
                request["accessToken"] = session.token.clone().into();
            }
            let response = timeout(TRANSFER, self.exchange(session, &request)).await;
            let received = match response {
                Ok(Ok(received)) => received,
                _ => {
                    session.socket = None;
                    session.protocol = None;
                    session.ratings = None;
                    if retries == 0 {
                        return Err(Unavailable.into());
                    }
                    retries -= 1;
                    continue;
                }
            };
            match text(&received, "error") {
                "" => return Ok(received),
                "need_access_token" if !challenged && !self.password.is_empty() => {
                    let salt = text(&received, "salt");
                    if salt.is_empty() || salt.len() > 512 {
                        return Err(Unavailable.into());
                    }
                    let mut hash = Sha256::new();
                    hash.update(self.password.as_bytes());
                    hash.update(salt.as_bytes());
                    session.token = hex(&hash.finalize());
                    challenged = true;
                }
                message if missing_book(message) => return Err(message.to_owned().into()),
                message if message.starts_with("Индекс оценок обновился") => {
                    return Err(message.to_owned().into());
                }
                _ => return Err(Unavailable.into()),
            }
        }
    }

    async fn exchange(&self, session: &mut Session, request: &Value) -> Result<Value> {
        if session.socket.is_none() {
            session.socket = Some(timeout(CONNECT, self.connect()).await??);
            session.generation = session.generation.wrapping_add(1);
        }
        let socket = session.socket.as_mut().expect("remote socket");
        socket
            .send(Message::Text(serde_json::to_string(request)?.into()))
            .await?;
        while let Some(message) = socket.next().await {
            match message? {
                Message::Text(body) => {
                    let response: Value = serde_json::from_str(&body)?;
                    if response["requestId"] == request["requestId"]
                        && response["_rok"].is_null()
                        && response["_progress"].is_null()
                    {
                        return Ok(response);
                    }
                }
                Message::Ping(_) => socket.flush().await?,
                Message::Close(_) => break,
                _ => (),
            }
        }
        Err(Unavailable.into())
    }

    async fn connect(&self) -> Result<WebSocketStream<Upgraded>> {
        let key = generate_key();
        let response = self
            .client
            .get(self.url.clone())
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, &key)
            .send()
            .await?;
        let has = |name, value: &str| {
            response
                .headers()
                .get_all(name)
                .iter()
                .filter_map(|field| field.to_str().ok())
                .any(|field| {
                    field
                        .split(',')
                        .any(|token| token.trim().eq_ignore_ascii_case(value))
                })
        };
        if response.status() != StatusCode::SWITCHING_PROTOCOLS
            || !has(header::CONNECTION, "upgrade")
            || !has(header::UPGRADE, "websocket")
            || response
                .headers()
                .get(header::SEC_WEBSOCKET_ACCEPT)
                .and_then(|field| field.to_str().ok())
                != Some(derive_accept_key(key.as_bytes()).as_str())
            || response
                .headers()
                .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
            || response
                .headers()
                .contains_key(header::SEC_WEBSOCKET_PROTOCOL)
        {
            return Err(Unavailable.into());
        }
        let maximum = (self.maximum.div_ceil(3) * 4 + MIB) as usize;
        let config = WebSocketConfig::default()
            .max_message_size(Some(maximum))
            .max_frame_size(Some(maximum));
        Ok(
            WebSocketStream::from_raw_socket(response.upgrade().await?, Role::Client, Some(config))
                .await,
        )
    }
}

fn same_connection(previous: &mut Option<u64>, actual: u64) -> Result<()> {
    if previous.is_some_and(|generation| generation != actual) {
        return Err("Соединение с удалённой библиотекой изменилось. Повторите запрос.".into());
    }
    *previous = Some(actual);
    Ok(())
}

fn missing_book(message: &str) -> bool {
    matches!(message, "Книга не найдена" | "404 Файл не найден")
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(2 * bytes.len());
    for byte in bytes {
        write!(output, "{byte:02x}").expect("hexadecimal string");
    }
    output
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn clip(value: &str, mut remaining: usize) -> &str {
    for (offset, ch) in value.char_indices() {
        let Some(left) = remaining.checked_sub(ch.len_utf16()) else {
            return &value[..offset];
        };
        remaining = left;
    }
    value
}

fn elements(page: &Value, limit: usize) -> Result<&[Value]> {
    page["items"]
        .as_array()
        .filter(|items| items.len() <= limit)
        .map(Vec::as_slice)
        .ok_or_else(|| "Некорректный ответ удалённой библиотеки".into())
}

fn next(page: &Value, cursor: u64, max: u64) -> Result<Option<u64>> {
    match page.get("next") {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|next| *next > cursor && *next <= max)
            .map(Some)
            .ok_or_else(|| "Некорректная пагинация удалённой библиотеки".into()),
        None => Err("Отсутствует позиция удалённой библиотеки".into()),
    }
}
