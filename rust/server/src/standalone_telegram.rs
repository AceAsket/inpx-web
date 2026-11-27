use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use inpx_catalog::{Result, book_delivery::Book};
use reqwest::{Client, RequestBuilder, multipart};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use super::{
    State,
    delivery::{boolean, setting},
};
use crate::standalone_access::BrowserProfileRequest;

#[path = "standalone_telegram_chat.rs"]
mod chat;

const CLOUD_MAX_MIB: u64 = 50;
const LOCAL_MAX_MIB: u64 = 2000;
const CLOUD_UPLOAD_SECONDS: u64 = 270;
const LOCAL_UPLOAD_SECONDS: u64 = 1800;
const LINK_TIME: Duration = Duration::from_secs(600);
type AsyncResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub(super) struct Telegram {
    send: bool,
    interactive: bool,
    token: String,
    caption: String,
    local_api: bool,
    transport: std::result::Result<(Url, Client), String>,
    offset_file: PathBuf,
    bot: Mutex<Bot>,
}

#[derive(Default)]
struct Bot {
    id: String,
    username: String,
    state: &'static str,
    error: String,
    last_poll: String,
    pairs: HashMap<[u8; 32], Pair>,
    rate: HashMap<String, (Instant, u8)>,
    callbacks: HashMap<String, chat::Callback>,
    deliveries: HashSet<String>,
}

struct Pair {
    owner: String,
    expires: Instant,
}

impl Telegram {
    pub(super) fn new(data: &Path, config: &Value) -> Self {
        let token = setting(config, "TELEGRAM_BOT_TOKEN", "telegramBotToken");
        let caption = setting(
            config,
            "TELEGRAM_CAPTION_TEMPLATE",
            "telegramCaptionTemplate",
        );
        let send = boolean(
            config,
            "INPX_TELEGRAM_SHARE_ENABLED",
            "telegramShareEnabled",
            !token.is_empty(),
        );
        let interactive = send
            && !token.is_empty()
            && boolean(
                config,
                "INPX_TELEGRAM_BOT_ENABLED",
                "telegramBotEnabled",
                false,
            );
        let endpoint = api_endpoint(config);
        let local_api = endpoint.as_ref().is_ok_and(|(_, local)| *local);
        let transport = if !token.is_empty() {
            endpoint
                .and_then(|(url, _)| Ok((url, transport(config)?)))
                .map_err(|error| error.to_string())
        } else {
            Err("Отправка в Telegram отключена в настройках".into())
        };
        Self {
            send,
            interactive,
            token,
            local_api,
            transport,
            offset_file: data.join("telegram-bot-state.json"),
            caption: if caption.is_empty() {
                "${AUTHOR} - ${TITLE}".into()
            } else {
                caption
            },
            bot: Mutex::new(Bot {
                state: if interactive {
                    "connecting"
                } else {
                    "disabled"
                },
                ..Bot::default()
            }),
        }
    }

    pub(super) fn destination<'a>(&self, profile: &'a Value) -> Result<&'a str> {
        if !self.send {
            return Err("Отправка в Telegram отключена в настройках".into());
        }
        if self.token.is_empty() {
            return Err("Telegram bot token не указан".into());
        }
        profile["telegramChatId"]
            .as_str()
            .map(str::trim)
            .filter(|chat| !chat.is_empty())
            .ok_or_else(|| "Telegram chat id не указан в текущем профиле пользователя".into())
    }

    pub(super) async fn send_book(
        &self,
        chat: &str,
        book: &Book,
        file: &Path,
        name: &str,
    ) -> Result<()> {
        let max_mib = if self.local_api {
            LOCAL_MAX_MIB
        } else {
            CLOUD_MAX_MIB
        };
        if tokio::fs::metadata(file).await?.len() > max_mib * 1024 * 1024 {
            return Err(format!("Telegram принимает файлы не больше {max_mib} МБ").into());
        }
        let caption = book.caption(&self.caption)?;
        let caption = if caption.encode_utf16().count() > 1024 {
            format!("{}…", truncate(&caption, 1023).trim_end())
        } else {
            caption
        };
        let part = multipart::Part::file(file)
            .await?
            .file_name(name.to_owned());
        let form = multipart::Form::new()
            .text("chat_id", chat.to_owned())
            .text("caption", caption)
            .part("document", part);
        self.response(
            self.request("sendDocument")
                .map_err(|error| error.to_string())?
                .timeout(Duration::from_secs(self.upload_seconds()))
                .multipart(form),
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn upload_seconds(&self) -> u64 {
        if self.local_api {
            LOCAL_UPLOAD_SECONDS
        } else {
            CLOUD_UPLOAD_SECONDS
        }
    }

    pub(super) fn client_upload_seconds(&self) -> u64 {
        self.upload_seconds() + 30
    }

    fn request(&self, method: &str) -> AsyncResult<RequestBuilder> {
        let (base, client) = self.transport.as_ref().map_err(String::as_str)?;
        let mut url = base.clone();
        url.path_segments_mut()
            .map_err(|_| "Некорректный адрес Telegram API")?
            .pop_if_empty()
            .push(&format!("bot{}", self.token))
            .push(method);
        Ok(client.post(url))
    }

    async fn response(&self, request: RequestBuilder) -> AsyncResult<Value> {
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "Истекло время ожидания ответа Telegram API"
            } else {
                "Telegram API недоступен, проверьте сеть и прокси"
            }
        })?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Не удалось прочитать ответ Telegram API")?
        {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("Ответ Telegram API слишком большой".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| format!("Некорректный ответ Telegram API (HTTP {})", status.as_u16()))?;
        if !status.is_success() || data["ok"] != true {
            // Telegram and proxies may echo tokens and URLs in error detail.
            let code = data["error_code"]
                .as_u64()
                .filter(|code| (400..600).contains(code))
                .unwrap_or(u64::from(status.as_u16()));
            let message = match code {
                401 => "Проверьте токен бота",
                403 => "Бот не может писать в этот чат",
                409 => "Бот уже получает обновления в другом процессе",
                429 => "Превышен лимит запросов",
                _ => "Telegram не принял запрос",
            };
            return Err(format!("Telegram API ({code}): {message}").into());
        }
        Ok(data["result"].take())
    }

    async fn call(&self, method: &str, value: Value, seconds: u64) -> AsyncResult<Value> {
        self.response(
            self.request(method)?
                .timeout(Duration::from_secs(seconds))
                .json(&value),
        )
        .await
    }

    pub(super) fn status(&self) -> Value {
        let bot = self.bot.lock().expect("Telegram status");
        json!({"enabled":self.interactive,"state":bot.state,"username":bot.username,
            "error":bot.error,"lastPollAt":bot.last_poll})
    }

    pub(super) fn account(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        operation: &str,
        options: &Value,
    ) -> Result<Value> {
        let (bot_id, username) = {
            let bot = self.bot.lock().expect("Telegram status");
            (bot.id.clone(), bot.username.clone())
        };
        let read = |action| {
            state
                .access
                .with_personal_profile(profile, |store, owner, stamp| {
                    let details = store.profile_settings(owner, stamp)?;
                    if !bot_id.is_empty() && action != "unlink" {
                        let chat = details["telegramChatId"].as_str().unwrap_or_default();
                        let binding = store.telegram_chat(stamp, &bot_id, chat)?;
                        let mut status =
                            store.telegram_profile(owner, stamp, action, &bot_id, "", options)?;
                        if binding["id"] != owner {
                            status["linked"] = false.into();
                            status["bindingSource"] = "".into();
                        }
                        return Ok(status);
                    }
                    store.telegram_profile(owner, stamp, action, &bot_id, "", options)
                })
        };
        let mut reply = match operation {
            "link" => {
                let owner = state
                    .access
                    .with_personal_profile(profile, |_, owner, _| Ok(owner.into()))?;
                let owner = owner.as_str().ok_or("Войдите в личный профиль")?;
                let mut bot = self.bot.lock().expect("Telegram links");
                if !self.interactive || bot_id.is_empty() || username.is_empty() {
                    return Err(
                        "Бот ещё не подключён. Проверьте настройки Telegram у администратора"
                            .into(),
                    );
                }
                if !bot.rate(&format!("link:{owner}"), 5) {
                    return Err("Слишком много запросов. Повторите через минуту".into());
                }
                let now = Instant::now();
                bot.pairs
                    .retain(|_, pair| pair.expires > now && pair.owner != owner);
                if bot.pairs.len() >= 1000 {
                    return Err("Слишком много запросов. Повторите позже".into());
                }
                let mut nonce = [0; 24];
                getrandom::fill(&mut nonce).map_err(std::io::Error::other)?;
                let token = URL_SAFE_NO_PAD.encode(nonce);
                bot.pairs.insert(
                    Sha256::digest(token.as_bytes()).into(),
                    Pair {
                        owner: owner.into(),
                        expires: now + LINK_TIME,
                    },
                );
                let expires = OffsetDateTime::now_utc() + time::Duration::seconds(600);
                return Ok(
                    json!({"url":format!("https://t.me/{username}?start=link_{token}"),
                    "expiresAt":expires.format(&Rfc3339)?}),
                );
            }
            "unlink" => {
                let owner = state
                    .access
                    .with_personal_profile(profile, |_, owner, _| Ok(owner.into()))?;
                let mut bot = self.bot.lock().expect("Telegram links");
                let result = read("unlink")?;
                bot.pairs.retain(|_, pair| owner != pair.owner);
                result
            }
            operation @ ("status" | "digest") => read(operation)?,
            _ => return Err("Неизвестное действие Telegram".into()),
        };
        let bot = self.status();
        for key in ["enabled", "state", "username"] {
            reply[key] = bot[key].clone();
        }
        Ok(reply)
    }

    pub(super) fn start(
        self: &Arc<Self>,
        state: &Arc<State>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        self.interactive.then(|| {
            let state = state.clone();
            let telegram = self.clone();
            tokio::spawn(async move {
                telegram.poll(&state).await;
            })
        })
    }

    pub(super) async fn verify(&self) -> AsyncResult<Value> {
        if self.token.is_empty() {
            return Err("Telegram bot token не указан".into());
        }
        let reply = self.call("getMe", json!({}), 15).await?;
        let username = reply["username"].as_str().unwrap_or_default();
        let label = if username.is_empty() {
            reply["first_name"].as_str().unwrap_or("ok")
        } else {
            username
        };
        Ok(json!({"success":true,"checked":"token","username":username,
            "message":format!("Токен Telegram проверен: {label}"),"telegramBotStatus":self.status()}))
    }

    async fn poll(self: &Arc<Self>, state: &Arc<State>) {
        let mut id = String::new();
        let mut failures = 0u32;
        let mut offset = 0i64;
        let mut digest_checked = None;
        loop {
            let result = self.poll_updates(state, &mut id, &mut offset).await;
            match result {
                Ok(()) => {
                    failures = 0;
                    {
                        let mut bot = self.bot.lock().expect("Telegram status");
                        bot.state = "running";
                        bot.error.clear();
                        bot.last_poll = now();
                    }
                    let now = Instant::now();
                    if digest_checked.is_none_or(|checked| {
                        now.duration_since(checked) > Duration::from_secs(3600)
                    }) {
                        digest_checked = Some(now);
                        let state = state.clone();
                        let bot = id.clone();
                        let telegram = self.clone();
                        tokio::spawn(async move {
                            chat::digest(&state, &telegram, &bot).await;
                        });
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => {
                    let message = error.to_string();
                    {
                        let mut bot = self.bot.lock().expect("Telegram status");
                        bot.state = "error";
                        bot.error = message;
                    }
                    failures = failures.saturating_add(1);
                    tokio::time::sleep(Duration::from_secs((1u64 << failures.min(6)).min(60)))
                        .await;
                }
            }
        }
    }

    async fn poll_updates(
        self: &Arc<Self>,
        state: &Arc<State>,
        id: &mut String,
        offset: &mut i64,
    ) -> AsyncResult<()> {
        if id.is_empty() {
            let me = self.call("getMe", json!({}), 20).await?;
            let bot_id =
                safe_number(&me["id"]).ok_or("Telegram вернул некорректный идентификатор бота")?;
            let username = me["username"]
                .as_str()
                .filter(|name| {
                    (5..=32).contains(&name.len())
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
                .ok_or("Telegram вернул некорректное имя бота")?
                .to_owned();
            let webhook = self.call("getWebhookInfo", json!({}), 20).await?;
            if webhook["url"].as_str().is_some_and(|url| !url.is_empty()) {
                return Err(
                    "У бота настроен webhook. Для работы inpx-web нужен отдельный бот без webhook"
                        .into(),
                );
            }
            self.call("setMyCommands", chat::commands(), 20).await?;
            let bot_id = bot_id.to_string();
            let previous: Value = match tokio::fs::read(&self.offset_file).await {
                Ok(bytes) => serde_json::from_slice(&bytes)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
                Err(error) => return Err(error.into()),
            };
            if previous["botId"] == bot_id {
                *offset = previous["offset"].as_i64().unwrap_or_default().max(0);
            }
            id.clone_from(&bot_id);
            let mut bot = self.bot.lock().expect("Telegram status");
            bot.id = bot_id;
            bot.username = username;
        }
        let updates = self
            .call(
                "getUpdates",
                json!({"offset":offset,"timeout":25,"limit":20,
            "allowed_updates":["message","callback_query"]}),
                35,
            )
            .await?;
        let rows = updates.as_array().ok_or("Некорректный ответ Telegram")?;
        let mut next = *offset;
        for update in rows {
            let Some(update_id) = update["update_id"].as_i64().filter(|id| *id >= next) else {
                continue;
            };
            next = update_id.saturating_add(1);
            if chat::handle(state, self, id, update).await.is_err() {
                super::logging::warn_limited(
                    "inpx::delivery",
                    "telegram-handler-failed",
                    format_args!("channel=telegram"),
                );
            }
        }
        if next != *offset {
            let path = self.offset_file.clone();
            let bytes = serde_json::to_vec(&json!({"version":1,"botId":id,"offset":next}))?;
            tokio::task::spawn_blocking(move || {
                inpx_catalog::reader_state::persist_telegram_offset(&path, &bytes)
                    .map_err(|error| error.to_string())
            })
            .await??;
            *offset = next;
        }
        Ok(())
    }
}

impl Bot {
    fn rate(&mut self, key: &str, limit: u8) -> bool {
        let now = Instant::now();
        self.rate.retain(|_, (until, _)| *until > now);
        if self.rate.len() >= 1000 && !self.rate.contains_key(key) {
            return false;
        }
        let (_, count) = self
            .rate
            .entry(key.into())
            .or_insert((now + Duration::from_secs(60), 0));
        if *count >= limit {
            return false;
        }
        *count += 1;
        true
    }
}

pub(super) fn api_endpoint(config: &Value) -> Result<(Url, bool)> {
    let mode = setting(config, "INPX_TELEGRAM_API_MODE", "telegramApiMode");
    let local = match mode.trim() {
        "" | "cloud" => false,
        "local" => true,
        _ => return Err("Режим Telegram Bot API должен быть cloud или local".into()),
    };
    let base = std::env::var("INPX_TELEGRAM_API_URL").unwrap_or_else(|_| {
        if local {
            config["telegramApiUrl"].as_str().unwrap_or_default().into()
        } else {
            "https://api.telegram.org/".into()
        }
    });
    if local && base.trim().is_empty() {
        return Err("Укажите адрес локального Telegram Bot API".into());
    }
    let url = Url::parse(&base).map_err(|_| "Некорректный адрес Telegram API")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Некорректный адрес Telegram API".into());
    }
    if local
        && url
            .host_str()
            .is_some_and(|host| host.trim_end_matches('.') == "api.telegram.org")
    {
        return Err("Укажите адрес сервера Telegram Bot API, запущенного с --local".into());
    }
    super::net::validate_integration_url(&url, "Telegram API")?;
    Ok((url, local))
}

fn transport(config: &Value) -> Result<Client> {
    let family = setting(config, "TELEGRAM_IP_FAMILY", "telegramIpFamily");
    let mut client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(super::net::NoMetadataDnsResolver));
    match family.trim() {
        "" | "0" | "auto" => {}
        "4" => client = client.local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        "6" => client = client.local_address(IpAddr::V6(Ipv6Addr::UNSPECIFIED)),
        _ => return Err("Семейство IP для Telegram: auto, 4 или 6".into()),
    }
    let mode = setting(config, "TELEGRAM_PROXY_MODE", "telegramProxyMode").to_ascii_lowercase();
    match mode.trim() {
        "" | "system" => {}
        "direct" => client = client.no_proxy(),
        "custom" => {
            let protocol = setting(config, "TELEGRAM_PROXY_PROTOCOL", "telegramProxyProtocol")
                .to_ascii_lowercase();
            let protocol = if protocol.is_empty() {
                "http"
            } else {
                protocol.as_str().trim()
            };
            if !matches!(protocol, "http" | "https" | "socks5" | "socks5h") {
                return Err("Telegram прокси: HTTP, HTTPS, SOCKS5 или SOCKS5h".into());
            }
            let host = setting(config, "TELEGRAM_PROXY_HOST", "telegramProxyHost");
            let host = host.trim().trim_matches(['[', ']']);
            let port = setting(config, "TELEGRAM_PROXY_PORT", "telegramProxyPort")
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or("Telegram прокси: укажите хост и порт")?;
            if host.is_empty()
                || host.contains(['/', '@', '?', '#', '\\'])
                || host.chars().any(char::is_whitespace)
            {
                return Err("Telegram прокси: неверный хост".into());
            }
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host.to_owned()
            };
            let mut proxy_url = Url::parse(&format!("{protocol}://{host}:{port}"))
                .map_err(|_| "Некорректный Telegram прокси")?;
            super::net::validate_integration_url(&proxy_url, "Telegram прокси")?;
            let user = setting(config, "TELEGRAM_PROXY_USERNAME", "telegramProxyUsername");
            let pass = setting(config, "TELEGRAM_PROXY_PASSWORD", "telegramProxyPassword");
            if !user.is_empty() || !pass.is_empty() {
                proxy_url
                    .set_username(&user)
                    .map_err(|_| "Некорректный Telegram прокси")?;
                proxy_url
                    .set_password(Some(&pass))
                    .map_err(|_| "Некорректный Telegram прокси")?;
            }
            client = client
                .proxy(reqwest::Proxy::all(proxy_url).map_err(|_| "Некорректный Telegram прокси")?);
        }
        _ => return Err("Telegram прокси: direct, system или custom".into()),
    }
    client
        .build()
        .map_err(|_| "Не удалось создать клиент Telegram".into())
}

fn safe_number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| (1..=(1u64 << 53) - 1).contains(number))
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn truncate(value: &str, limit: usize) -> &str {
    let mut length = 0;
    let boundary = value.char_indices().find_map(|(offset, ch)| {
        length += ch.len_utf16();
        (length > limit).then_some(offset)
    });
    &value[..boundary.unwrap_or(value.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_proxy_rejects_cloud_metadata_addresses() {
        for (protocol, host) in [
            ("http", "169.254.169.254"),
            ("https", "169.254.169.254"),
            ("socks5", "169.254.169.254"),
            ("socks5h", "169.254.169.254"),
            ("http", "2852039166"),
            ("socks5", "2852039166"),
            ("socks5", "metadata.google.internal"),
            ("http", "fe80::1"),
            ("socks5", "64:ff9b::169.254.169.254"),
        ] {
            let config = json!({
                "telegramProxyMode": "custom",
                "telegramProxyProtocol": protocol,
                "telegramProxyHost": host,
                "telegramProxyPort": 1080,
            });
            assert!(
                transport(&config).is_err(),
                "custom {protocol} proxy to {host} must be rejected"
            );
        }
        let valid = json!({
            "telegramProxyMode": "custom",
            "telegramProxyProtocol": "socks5",
            "telegramProxyHost": "127.0.0.1",
            "telegramProxyPort": 1080,
        });
        assert!(transport(&valid).is_ok());
    }
}
