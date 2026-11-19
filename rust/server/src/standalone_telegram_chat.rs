use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, Weekday};

use super::{AsyncResult as Result, Telegram, safe_number, truncate};
use crate::standalone::State;

const PAGE: usize = 8;
const CALLBACK_LIFE: Duration = Duration::from_secs(15 * 60);
const HELP: &str = "Отправьте название книги или используйте /search, /reading, /lists, /favorites, /following. Команда /unlink отключает профиль.";

#[derive(Clone)]
enum Action {
    Search(String, &'static str, usize),
    Lists(usize),
    Shelf(String, usize),
    Reading(usize),
    Favorites(usize),
    Following(usize),
    Book(String),
    Send(String, bool),
}

pub(super) struct Callback {
    owner: String,
    chat: String,
    generation: u64,
    expires: Instant,
    action: Action,
}

pub(super) fn commands() -> Value {
    json!({"commands":[
        {"command":"help","description":"Помощь"},
        {"command":"search","description":"Поиск книг"},
        {"command":"reading","description":"Сейчас читаю"},
        {"command":"lists","description":"Мои списки"},
        {"command":"favorites","description":"Избранные авторы и серии"},
        {"command":"following","description":"Новое у любимых"},
        {"command":"unlink","description":"Отключить профиль"}
    ]})
}

struct Context {
    bot: String,
    chat: String,
    owner: String,
    message: Option<u64>,
}

struct Reservation {
    service: Arc<Telegram>,
    chat: String,
}

impl Reservation {
    fn acquire(service: &Arc<Telegram>, chat: &str) -> Option<Self> {
        let mut bot = service.bot.lock().expect("Telegram deliveries");
        bot.deliveries.insert(chat.to_owned()).then(|| Self {
            service: service.clone(),
            chat: chat.into(),
        })
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.service
            .bot
            .lock()
            .expect("Telegram deliveries")
            .deliveries
            .remove(&self.chat);
    }
}

pub(super) async fn handle(
    state: &Arc<State>,
    service: &Arc<Telegram>,
    bot: &str,
    update: &Value,
) -> Result<()> {
    let callback = &update["callback_query"];
    let (message, sender) = if callback.is_object() {
        (&callback["message"], &callback["from"])
    } else {
        (&update["message"], &update["message"]["from"])
    };
    let Some(id) = safe_number(&message["chat"]["id"]) else {
        return Ok(());
    };
    if message["chat"]["type"] != "private"
        || sender["id"].as_u64() != Some(id)
        || sender["is_bot"] == true
    {
        return Ok(());
    }
    let mut ctx = Context {
        bot: bot.into(),
        chat: id.to_string(),
        owner: String::new(),
        message: callback
            .is_object()
            .then(|| message["message_id"].as_u64())
            .flatten(),
    };
    if let Some(id) = callback["id"].as_str() {
        service
            .call("answerCallbackQuery", json!({"callback_query_id":id}), 10)
            .await?;
    }
    if !service
        .bot
        .lock()
        .expect("Telegram rate limits")
        .rate(&format!("chat:{}", ctx.chat), 20)
    {
        return Ok(());
    }
    let text = message["text"].as_str().unwrap_or_default().trim();
    let (command, argument) = text
        .split_once(char::is_whitespace)
        .map_or((text, ""), |(command, arg)| (command, arg.trim()));
    let command = command.split('@').next().unwrap_or_default();
    if callback.is_null()
        && command == "/start"
        && let Some(token) = argument.strip_prefix("link_")
    {
        if token.len() != 32
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return reply(
                service,
                &ctx,
                "Ссылка недействительна или истекла. Создайте новую ссылку в профиле inpx-web.",
                vec![],
            )
            .await;
        }
        let key: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let chat = ctx.chat.clone();
        let bot = ctx.bot.clone();
        let state = state.clone();
        let telegram = service.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut pairs = telegram.bot.lock().expect("Telegram links");
            if !pairs.rate(&format!("pair:{chat}"), 3) {
                return Ok(false);
            }
            let pair = pairs
                .pairs
                .remove(&key)
                .filter(|pair| pair.expires > Instant::now());
            let Some(pair) = pair else { return Ok(false) };
            state
                .access
                .telegram(|reader, stamp| {
                    reader.telegram_profile(&pair.owner, stamp, "link", &bot, &chat, &Value::Null)
                })
                .map(|_| true)
                .map_err(|error| error.to_string())
        })
        .await?;
        let text = match &result {
            Ok(true) => "Профиль подключён. Отправьте название книги или /help.",
            Ok(false) => {
                "Ссылка недействительна или истекла. Создайте новую ссылку в профиле inpx-web."
            }
            Err(error) => error,
        };
        return reply(service, &ctx, text, vec![]).await;
    }
    let user = profile(state.clone(), ctx.bot.clone(), ctx.chat.clone()).await?;
    let Some(owner) = user["id"].as_str() else {
        if callback.is_null() && !text.is_empty() {
            reply(
                service,
                &ctx,
                "Откройте личный профиль inpx-web и подключите Telegram.",
                vec![],
            )
            .await?;
        }
        return Ok(());
    };
    ctx.owner = owner.into();
    if let Some(data) = callback["data"]
        .as_str()
        .and_then(|data| data.strip_prefix("c:"))
    {
        let action = service
            .bot
            .lock()
            .expect("Telegram buttons")
            .callbacks
            .get(data)
            .filter(|entry| {
                entry.expires > Instant::now()
                    && entry.generation == state.index.generation()
                    && entry.chat == ctx.chat
                    && entry.owner == ctx.owner
            })
            .map(|entry| entry.action.clone());
        return match action {
            Some(action) => dispatch(state, service, ctx, action).await,
            None => {
                reply(
                    service,
                    &ctx,
                    "Кнопка устарела. Откройте список заново.",
                    vec![],
                )
                .await
            }
        };
    }
    let action = match command {
        "/start" | "/help" => return reply(service, &ctx, HELP, vec![]).await,
        "/search" if argument.is_empty() => {
            return reply(service, &ctx, "Отправьте название книги.", vec![]).await;
        }
        "/search" => Action::Search(argument.chars().take(200).collect(), "title", 0),
        "/reading" => Action::Reading(0),
        "/lists" => Action::Lists(0),
        "/favorites" => Action::Favorites(0),
        "/following" => Action::Following(0),
        "/unlink" => {
            let (bot, chat, owner) = (ctx.bot.clone(), ctx.chat.clone(), ctx.owner.clone());
            let state = state.clone();
            let telegram = service.clone();
            tokio::task::spawn_blocking(move || {
                let mut pairs = telegram.bot.lock().expect("Telegram links");
                state
                    .access
                    .telegram(|store, stamp| {
                        if store.telegram_chat(stamp, &bot, &chat)?["id"] == owner {
                            store.telegram_profile(
                                &owner,
                                stamp,
                                "unlink",
                                &bot,
                                &chat,
                                &Value::Null,
                            )?;
                        }
                        Ok(Value::Null)
                    })
                    .map_err(|error| error.to_string())?;
                pairs.pairs.retain(|_, pair| pair.owner != owner);
                Ok::<_, String>(())
            })
            .await??;
            return reply(service, &ctx, "Профиль отключён.", vec![]).await;
        }
        _ if text.is_empty() || callback.is_object() => return Ok(()),
        _ => Action::Search(text.chars().take(200).collect(), "title", 0),
    };
    dispatch(state, service, ctx, action).await
}

async fn profile(
    state: Arc<State>,
    bot: String,
    chat: String,
) -> std::result::Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        state
            .access
            .telegram(|store, stamp| store.telegram_chat(stamp, &bot, &chat))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn dispatch(
    state: &Arc<State>,
    service: &Arc<Telegram>,
    ctx: Context,
    action: Action,
) -> Result<()> {
    if let Action::Send(uid, original) = action {
        let Some(reservation) = Reservation::acquire(service, &ctx.chat) else {
            return reply(
                service,
                &ctx,
                "Другая книга уже готовится к отправке.",
                vec![],
            )
            .await;
        };
        reply(
            service,
            &ctx,
            "Книга поставлена в очередь отправки.",
            vec![],
        )
        .await?;
        let state = state.clone();
        let telegram = service.clone();
        tokio::spawn(async move {
            let worker = state.clone();
            let active = telegram.clone();
            let (bot, chat, owner) = (ctx.bot.clone(), ctx.chat.clone(), ctx.owner.clone());
            let result = tokio::task::spawn_blocking(move || {
                worker
                    .send_from_chat(&active, &bot, &chat, &owner, &uid, original)
                    .map_err(|error| error.to_string())
            })
            .await;
            let text = match result {
                Ok(Ok(())) => "Книга отправлена.".into(),
                Ok(Err(error)) => error,
                Err(_) => "Не удалось отправить книгу".into(),
            };
            drop(reservation);
            if Arc::ptr_eq(&telegram, &state.delivery.telegram()) {
                let _ = reply(&telegram, &ctx, &text, vec![]).await;
            }
        });
        return Ok(());
    }
    let state_read = state.clone();
    let (bot, chat, owner) = (ctx.bot.clone(), ctx.chat.clone(), ctx.owner.clone());
    let action_read = action.clone();
    let result = tokio::task::spawn_blocking(move || {
        state_read.access.telegram(|store, stamp| {
            if store.telegram_chat(stamp, &bot, &chat)?["id"] != owner {
                return Err("Привязка Telegram отключена".into());
            }
            let catalogue = state_read.index.catalogue.read().expect("open catalogue");
            let catalogue = catalogue.as_ref().ok_or("Каталог пока недоступен")?;
            let value = match &action_read {
                Action::Search(term, field, page) => {
                    let mut query = json!({"limit":PAGE,"offset":page.saturating_mul(PAGE),"del":"0"});
                    query[*field] = term.as_str().into();
                    catalogue.browser_books(query.as_object().expect("book query"))?
                }
                Action::Lists(page) => store.telegram_shelves(&owner, stamp, page.saturating_mul(PAGE), PAGE)?,
                Action::Shelf(id, page) => store.telegram_shelf_page(&owner, stamp, id, page.saturating_mul(PAGE), PAGE, catalogue)?,
                Action::Reading(page) => store.reading_library(&owner, stamp, &json!({"state":"reading","limit":(page+1).saturating_mul(PAGE)+1}), catalogue)?,
                Action::Favorites(page) | Action::Following(page) => store.library_follows(&owner, stamp, "get-library-follows",
                    &json!({"options":{"limit":PAGE,"offset":page.saturating_mul(PAGE),"autoRefresh":true}}), catalogue)?,
                Action::Book(uid) => catalogue.browser_book(uid)?.ok_or("Книга не найдена")?,
                Action::Send(..) => unreachable!("send handled before catalogue work"),
            };
            Ok(value)
        }).map_err(|error| error.to_string())
    }).await??;
    let mut rows = Vec::new();
    let mut add = |label: &str, action: Action| {
        if let Some(button) = button(state, service, &ctx, label, action) {
            rows.push(vec![button]);
        }
    };
    let heading;
    match action {
        Action::Search(term, field, page) => {
            heading = "Результаты поиска".into();
            for row in array(&result["found"]) {
                add(text(&row["title"]), Action::Book(text(&row["_uid"]).into()));
            }
            if (result["totalFound"].as_u64().unwrap_or_default() as usize) > (page + 1) * PAGE {
                add("Дальше", Action::Search(term.clone(), field, page + 1));
            }
            if page > 0 {
                add("Назад", Action::Search(term.clone(), field, page - 1));
            }
            for (key, label) in [
                ("title", "По названию"),
                ("author", "По автору"),
                ("series", "По серии"),
            ] {
                if key != field {
                    add(label, Action::Search(term.clone(), key, 0));
                }
            }
        }
        Action::Lists(page) => {
            heading = "Мои списки".into();
            for row in array(&result["rows"]) {
                add(
                    text(&row["name"]),
                    Action::Shelf(text(&row["id"]).into(), 0),
                );
            }
            if result["more"] == true {
                add("Дальше", Action::Lists(page + 1));
            }
            if page > 0 {
                add("Назад", Action::Lists(page - 1));
            }
        }
        Action::Shelf(id, page) => {
            heading = text(&result["name"]).into();
            for row in array(&result["rows"]) {
                add(text(&row["title"]), Action::Book(text(&row["_uid"]).into()));
            }
            if result["more"] == true {
                add("Дальше", Action::Shelf(id.clone(), page + 1));
            }
            if page > 0 {
                add("Назад", Action::Shelf(id, page - 1));
            }
            add("Мои списки", Action::Lists(0));
        }
        Action::Reading(page) => {
            heading = "Сейчас читаю".into();
            let books = array(&result["items"]);
            for row in books.iter().skip(page * PAGE).take(PAGE) {
                add(
                    text(&row["title"]),
                    Action::Book(text(&row["bookUid"]).into()),
                );
            }
            if books.len() > (page + 1) * PAGE {
                add("Дальше", Action::Reading(page + 1));
            }
            if page > 0 {
                add("Назад", Action::Reading(page - 1));
            }
        }
        Action::Favorites(page) => {
            heading = "Избранные авторы и серии".into();
            let follows = array(&result["follows"]);
            for row in follows.iter().skip(page * PAGE).take(PAGE) {
                let field = if row["kind"] == "series" {
                    "series"
                } else {
                    "author"
                };
                let name = text(&row["value"]);
                add(name, Action::Search(format!("={name}"), field, 0));
            }
            if follows.len() > (page + 1) * PAGE {
                add("Дальше", Action::Favorites(page + 1));
            }
            if page > 0 {
                add("Назад", Action::Favorites(page - 1));
            }
        }
        Action::Following(page) => {
            heading = "Новые книги любимых авторов и серий".into();
            for row in array(&result["books"]) {
                add(text(&row["title"]), Action::Book(text(&row["_uid"]).into()));
            }
            if result["truncated"] == true {
                add("Дальше", Action::Following(page + 1));
            }
            if page > 0 {
                add("Назад", Action::Following(page - 1));
            }
        }
        Action::Book(uid) => {
            heading = format!("{}\n{}", text(&result["title"]), text(&result["author"]));
            add(
                "Отправить в выбранном формате",
                Action::Send(uid.clone(), false),
            );
            add("Получить оригинал", Action::Send(uid, true));
        }
        Action::Send(..) => unreachable!(),
    }
    let heading: String = heading;
    if profile(state.clone(), ctx.bot.clone(), ctx.chat.clone()).await?["id"] != ctx.owner {
        return Ok(());
    }
    reply(service, &ctx, &heading, rows).await
}

fn button(
    state: &State,
    service: &Telegram,
    ctx: &Context,
    label: &str,
    action: Action,
) -> Option<Value> {
    if label.is_empty() {
        return None;
    }
    let key = crate::standalone::delivery::random_id().ok()?;
    let key = key[..32].to_owned();
    let now = Instant::now();
    let mut bot = service.bot.lock().expect("Telegram buttons");
    bot.callbacks.retain(|_, value| value.expires > now);
    if bot.callbacks.len() >= 2000
        && let Some(oldest) = bot
            .callbacks
            .iter()
            .min_by_key(|(_, value)| value.expires)
            .map(|(key, _)| key.clone())
    {
        bot.callbacks.remove(&oldest);
    }
    bot.callbacks.insert(
        key.clone(),
        Callback {
            chat: ctx.chat.clone(),
            owner: ctx.owner.clone(),
            generation: state.index.generation(),
            expires: now + CALLBACK_LIFE,
            action,
        },
    );
    Some(json!({"text":truncate(label,54),"callback_data":format!("c:{key}")}))
}

async fn reply(service: &Telegram, ctx: &Context, text: &str, rows: Vec<Vec<Value>>) -> Result<()> {
    let mut message = json!({"chat_id":ctx.chat,"text":truncate(text,3800),"link_preview_options":{"is_disabled":true},
        "reply_markup":{"inline_keyboard":rows}});
    if let Some(id) = ctx.message {
        message["message_id"] = id.into();
        if service
            .call("editMessageText", message.clone(), 20)
            .await
            .is_ok()
        {
            return Ok(());
        }
        message
            .as_object_mut()
            .expect("Telegram message")
            .remove("message_id");
    }
    service.call("sendMessage", message, 20).await?;
    Ok(())
}

pub(super) async fn digest(state: &Arc<State>, service: &Arc<Telegram>, bot: &str) {
    let now = OffsetDateTime::now_utc();
    if now.weekday() != Weekday::Monday || now.hour() < 10 {
        return;
    }
    let read = state.clone();
    let id = bot.to_owned();
    let users = tokio::task::spawn_blocking(move || {
        read.access
            .telegram(|store, stamp| store.telegram_digest_profiles(stamp, &id))
            .map_err(|error| error.to_string())
    })
    .await;
    let Ok(Ok(users)) = users else { return };
    for user in array(&users) {
        if !Arc::ptr_eq(service, &state.delivery.telegram()) {
            return;
        }
        let ctx = Context {
            bot: bot.into(),
            chat: text(&user["chatId"]).into(),
            owner: text(&user["id"]).into(),
            message: None,
        };
        let read = state.clone();
        let (owner, bot, chat) = (ctx.owner.clone(), ctx.bot.clone(), ctx.chat.clone());
        let entries = tokio::task::spawn_blocking(move || {
            read.access
                .telegram(|store, stamp| {
                    let profile = store.telegram_chat(stamp, &bot, &chat)?;
                    if profile["id"] != owner || profile["digest"] != true {
                        return Ok(Value::Null);
                    }
                    let catalogue = read.index.catalogue.read().expect("open catalogue");
                    let catalogue = catalogue.as_ref().ok_or("Каталог пока недоступен")?;
                    let result = store.library_follows(
                        &owner,
                        stamp,
                        "get-library-follows",
                        &json!({"options":{"autoRefresh":true,"limit":100}}),
                        catalogue,
                    )?;
                    Ok(json!(
                        array(&result["books"])
                            .iter()
                            .filter(|book| !array(&profile["seen"]).contains(&book["_uid"]))
                            .take(10)
                            .collect::<Vec<_>>()
                    ))
                })
                .map_err(|error| error.to_string())
        })
        .await;
        let Ok(Ok(entries)) = entries else { continue };
        if array(&entries).is_empty() {
            continue;
        }
        let Ok(current) = profile(state.clone(), ctx.bot.clone(), ctx.chat.clone()).await else {
            continue;
        };
        if current["id"] != ctx.owner || current["digest"] != true {
            continue;
        }
        let mut rows = Vec::new();
        for book in array(&entries) {
            if let Some(row) = button(
                state,
                service,
                &ctx,
                text(&book["title"]),
                Action::Book(text(&book["_uid"]).into()),
            ) {
                rows.push(vec![row]);
            }
        }
        if reply(
            service,
            &ctx,
            "Новые книги любимых авторов и серий\nВаша еженедельная подборка.",
            rows,
        )
        .await
        .is_ok()
        {
            let state = state.clone();
            let uids = json!(
                array(&entries)
                    .iter()
                    .map(|book| &book["_uid"])
                    .collect::<Vec<_>>()
            );
            let _ = tokio::task::spawn_blocking(move || {
                state
                    .access
                    .telegram(|store, stamp| {
                        store.telegram_profile(
                            &ctx.owner,
                            stamp,
                            "digest-sent",
                            &ctx.bot,
                            &ctx.chat,
                            &uids,
                        )
                    })
                    .map_err(|error| error.to_string())
            })
            .await;
        }
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
