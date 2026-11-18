use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use inpx_catalog::{Result, book_delivery};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, SemaphorePermit};

use super::{State, smtp::Mail, telegram::Telegram};
use crate::standalone_access::BrowserProfileRequest;
use crate::standalone_download::load_book;

pub(super) struct Delivery {
    channels: RwLock<Channels>,
    polling: Mutex<Option<tokio::task::JoinHandle<()>>>,
    outgoing: Queue,
}

#[derive(Clone)]
pub(super) struct Channels {
    pub(super) telegram: Arc<Telegram>,
    pub(super) mail: Arc<Mail>,
}

impl Channels {
    pub(super) fn new(data: &Path, config: &Value) -> Self {
        Self {
            telegram: Arc::new(Telegram::new(data, config)),
            mail: Arc::new(Mail::new(config)),
        }
    }
}

pub(super) struct Queue {
    permits: Semaphore,
    pending: Semaphore,
    next: AtomicU64,
    kind: &'static str,
    title: &'static str,
    tasks: Mutex<BTreeMap<u64, (String, Value)>>,
}

pub(super) struct Task<'a> {
    queue: &'a Queue,
    id: u64,
    _reserved: SemaphorePermit<'a>,
    _slot: SemaphorePermit<'a>,
}

impl Queue {
    pub(super) fn new(
        active: usize,
        waiting: usize,
        kind: &'static str,
        title: &'static str,
    ) -> Self {
        Self {
            permits: Semaphore::new(active),
            pending: Semaphore::new(active + waiting),
            next: AtomicU64::new(1),
            kind,
            title,
            tasks: Mutex::default(),
        }
    }

    pub(super) fn enter(&self, owner: &str) -> Result<Task<'_>> {
        let reserved = self
            .pending
            .try_acquire()
            .map_err(|_| "Очередь заполнена. Повторите позже.")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.tasks.lock().expect("delivery tasks").insert(id, (owner.into(), json!({
            "id":format!("{}-{id}",self.kind),"kind":self.kind,"title":self.title,"state":"queued",
            "phase":"Ожидание","done":0,"total":null,"progress":null
        })));
        let slot = tokio::runtime::Handle::current()
            .block_on(self.permits.acquire())
            .expect("active queue");
        let task = Task {
            queue: self,
            id,
            _reserved: reserved,
            _slot: slot,
        };
        task.progress("Подготовка книги", 0, 0);
        Ok(task)
    }

    pub(super) fn tasks(&self, owner: &str, admin: bool) -> Vec<Value> {
        let tasks = self.tasks.lock().expect("delivery tasks");
        let mut place = 0;
        tasks
            .values()
            .filter_map(|(id, row)| {
                let queued = row["state"] == "queued";
                place += usize::from(queued);
                (admin || id == owner).then(|| {
                    let mut row = row.clone();
                    if queued {
                        row["queuePosition"] = place.into();
                    }
                    row
                })
            })
            .collect()
    }
}

impl Task<'_> {
    pub(super) fn progress(&self, phase: &str, done: usize, total: usize) {
        let mut tasks = self.queue.tasks.lock().expect("delivery tasks");
        let row = &mut tasks.get_mut(&self.id).expect("active delivery task").1;
        row["state"] = "running".into();
        row["phase"] = phase.into();
        row["done"] = done.into();
        row["total"] = (total > 0).then_some(total).into();
        row["progress"] =
            super::tasks::fraction(done as u64, (total > 0).then_some(total as u64)).into();
    }
}

impl Drop for Task<'_> {
    fn drop(&mut self) {
        self.queue
            .tasks
            .lock()
            .expect("delivery tasks")
            .remove(&self.id);
    }
}

impl Delivery {
    pub(super) fn new(data: &Path, config: &Value) -> Self {
        Self {
            channels: RwLock::new(Channels::new(data, config)),
            polling: Mutex::default(),
            outgoing: Queue::new(4, 16, "book-delivery", "Отправка книги"),
        }
    }

    pub(super) fn channels(&self) -> Channels {
        self.channels.read().expect("delivery settings").clone()
    }

    pub(super) fn telegram(&self) -> Arc<Telegram> {
        self.channels
            .read()
            .expect("delivery settings")
            .telegram
            .clone()
    }

    pub(super) fn start(state: &Arc<State>) {
        *state.delivery.polling.lock().expect("Telegram poller") =
            state.delivery.telegram().start(state);
    }

    pub(super) fn configure(state: &Arc<State>, mut channels: Channels, telegram_changed: bool) {
        let mut current = state.delivery.channels.write().expect("delivery settings");
        if !telegram_changed {
            channels.telegram = current.telegram.clone();
        }
        *current = channels;
        drop(current);
        if telegram_changed {
            let mut poller = state.delivery.polling.lock().expect("Telegram poller");
            if let Some(previous) = poller.take() {
                previous.abort();
            }
            *poller = state.delivery.telegram().start(state);
        }
    }

    pub(super) fn tasks(&self, owner: &str, admin: bool) -> Vec<Value> {
        self.outgoing.tasks(owner, admin)
    }

    pub(super) fn options(&self, profile: &Value) -> (bool, bool) {
        let channels = self.channels();
        (
            channels.telegram.destination(profile).is_ok(),
            channels.mail.destination(profile).is_some(),
        )
    }

    pub(super) fn send(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        request: &Value,
        telegram: bool,
    ) -> Result<Value> {
        let uid = request["bookUid"]
            .as_str()
            .map(str::trim)
            .filter(|uid| !uid.is_empty())
            .ok_or("bookUid is empty")?;
        let details = || {
            state.access.with_profile(profile, |store, owner, stamp| {
                store.profile_settings(owner, stamp)
            })
        };
        let initial = details()?;
        let destination = |channels: &Channels, details: &Value| -> Result<String> {
            if telegram {
                channels.telegram.destination(details).map(str::to_owned)
            } else {
                channels
                    .mail
                    .destination(details)
                    .map(str::to_owned)
                    .ok_or_else(|| "Отправка на email не настроена".into())
            }
        };
        destination(&self.channels(), &initial)?;
        let task = self
            .outgoing
            .enter(initial["id"].as_str().ok_or("need_profile_login")?)?;
        let details_before = details()?;
        let channels = self.channels();
        let to = destination(&channels, &details_before)?;
        let book = load_book(&state.index.catalogue, uid)?.ok_or("Книга не найдена в каталоге")?;
        let (preference, zip) = if telegram {
            ("defaultTelegramFormat", "telegramAsZip")
        } else {
            ("defaultEmailFormat", "emailAsZip")
        };
        let (path, filename) = state
            .downloads
            .attachment(
                &book,
                &state.index.sources(),
                request["format"].as_str().unwrap_or_default(),
                details_before[preference].as_str().unwrap_or_default(),
                details_before[zip] == true,
            )
            .map_err(book_error)?;
        let current = details()?;
        let latest = self.channels();
        let replaced = if telegram {
            !Arc::ptr_eq(&latest.telegram, &channels.telegram)
        } else {
            !Arc::ptr_eq(&latest.mail, &channels.mail)
        };
        if destination(&latest, &current)? != to
            || replaced
            || current[preference] != details_before[preference]
            || current[zip] != details_before[zip]
        {
            return Err("Настройки отправки изменились. Повторите отправку.".into());
        }
        task.progress(
            if telegram {
                "Отправка в Telegram"
            } else {
                "Отправка по email"
            },
            0,
            0,
        );
        tokio::runtime::Handle::current().block_on(async {
            if telegram {
                channels
                    .telegram
                    .send_book(&to, &book, &path, &filename)
                    .await
            } else {
                channels
                    .mail
                    .send(&to, &book.author, &book.title, &filename, &path)
                    .await
            }
        })?;
        Ok(json!({"success":true}))
    }
}

impl State {
    pub(super) fn send_from_chat(
        &self,
        service: &Arc<Telegram>,
        bot: &str,
        chat: &str,
        owner: &str,
        uid: &str,
        original: bool,
    ) -> Result<()> {
        let details = || {
            if !Arc::ptr_eq(service, &self.delivery.telegram()) {
                return Err("Настройки Telegram изменились".into());
            }
            self.access.telegram(|store, stamp| {
                let profile = store.telegram_chat(stamp, bot, chat)?;
                if profile["id"] != owner {
                    return Err("Привязка Telegram отключена".into());
                }
                Ok(profile)
            })
        };
        details()?;
        let task = self.delivery.outgoing.enter(owner)?;
        let profile = details()?;
        let book = load_book(&self.index.catalogue, uid)?.ok_or("Книга не найдена в каталоге")?;
        let (path, filename) = self
            .downloads
            .attachment(
                &book,
                &self.index.sources(),
                if original { "original" } else { "" },
                profile["defaultTelegramFormat"]
                    .as_str()
                    .unwrap_or_default(),
                profile["telegramAsZip"] == true,
            )
            .map_err(book_error)?;
        let current = details()?;
        if profile["defaultTelegramFormat"] != current["defaultTelegramFormat"]
            || profile["telegramAsZip"] != current["telegramAsZip"]
        {
            return Err("Настройки отправки изменились. Повторите отправку.".into());
        }
        task.progress("Отправка в Telegram", 0, 0);
        tokio::runtime::Handle::current().block_on(service.send_book(chat, &book, &path, &filename))
    }
}

pub(super) fn book_error(error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    use book_delivery::DownloadError;
    match book_delivery::classify(error.as_ref()) {
        DownloadError::Missing => "Файл книги не найден".into(),
        DownloadError::Limit => "Файл книги слишком большой".into(),
        DownloadError::Unsupported => "Неподдерживаемый формат книги".into(),
        DownloadError::DecoderMemory => error,
        DownloadError::Internal => {
            if error
                .to_string()
                .starts_with("Неподдерживаемый формат отправки:")
            {
                return error;
            }
            eprintln!("Book delivery: {error}");
            "Не удалось подготовить файл книги".into()
        }
    }
}

pub(super) fn setting(config: &Value, env: &str, key: &str) -> String {
    std::env::var(env).unwrap_or_else(|_| match &config[key] {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    })
}

pub(super) fn boolean(config: &Value, env: &str, key: &str, default: bool) -> bool {
    std::env::var(env).map_or_else(
        |_| config[key].as_bool().unwrap_or(default),
        |value| value == "true",
    )
}

pub(super) fn random_id() -> Result<String> {
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
