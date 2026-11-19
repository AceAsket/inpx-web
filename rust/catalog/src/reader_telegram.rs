use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{ReaderState, now, profiles, string, transfer};
use crate::Result;

pub fn persist_telegram_offset(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or("Нет каталога состояния Telegram")?;
    let previous = crate::atomic_file::current_stamp(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    if crate::atomic_file::publish(temp, path, previous.as_deref())?.is_none() {
        return Err("Состояние Telegram изменилось при сохранении".into());
    }
    Ok(())
}

impl ReaderState {
    pub fn telegram_profile(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        bot: &str,
        chat: &str,
        options: &Value,
    ) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let users = snapshot.data["users"]
            .as_array_mut()
            .ok_or("Личный профиль не найден")?;
        let index = users
            .iter()
            .position(|user| user["id"] == owner && personal(user))
            .ok_or("Личный профиль не найден")?;
        match action {
            "status" => return Ok(status(&users[index], bot)),
            "link" => {
                if !telegram_id(bot) || !telegram_id(chat) {
                    return Err("Некорректная привязка Telegram".into());
                }
                let conflicts = users
                    .iter()
                    .enumerate()
                    .filter(|(other, user)| *other != index && stored(user, bot, chat))
                    .map(|(other, _)| other)
                    .collect::<Vec<_>>();
                if conflicts
                    .iter()
                    .any(|&other| users[other]["telegramBotAutoLinked"] != true)
                {
                    return Err("Этот Telegram уже привязан к другому профилю. Сначала отключите прежнюю привязку".into());
                }
                for other in conflicts {
                    detach(&mut users[other], false);
                }
                attach(&mut users[index], bot, chat, false);
            }
            "unlink" => detach(&mut users[index], true),
            "digest" => users[index]["telegramDigest"] = (options["enabled"] == true).into(),
            "digest-sent" => {
                let user = &mut users[index];
                if !stored(user, bot, chat)
                    || user["telegramDigest"] != true
                    || user["telegramBotBlocked"] == true
                {
                    return Ok(Value::Null);
                }
                let mut seen = user["telegramDigestSeen"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if let Some(ids) = options.as_array() {
                    for uid in ids {
                        if !seen.contains(uid) {
                            seen.push(uid.clone());
                        }
                    }
                }
                seen.drain(..seen.len().saturating_sub(1000));
                user["telegramDigestSeen"] = seen.into();
                user["telegramDigestAt"] = now().into();
            }
            _ => return Err("Неизвестное действие Telegram".into()),
        }
        users[index]["updatedAt"] = now().into();
        let reply = status(&users[index], bot);
        self.publish(snapshot, stamp)?;
        Ok(reply)
    }

    pub fn telegram_chat(&self, stamp: &str, bot: &str, chat: &str) -> Result<Value> {
        if !telegram_id(bot) || !telegram_id(chat) {
            return Ok(Value::Null);
        }
        let mut snapshot = self.snapshot(stamp)?;
        let users = snapshot.data["users"]
            .as_array_mut()
            .ok_or("Личный профиль не найден")?;
        let mut configured = users
            .iter()
            .enumerate()
            .filter(|(_, user)| !profiles::anonymous(user) && user["telegramChatId"] == chat);
        let candidate = configured.next().filter(|_| configured.next().is_none());
        let mut matches = users
            .iter()
            .enumerate()
            .filter(|(_, user)| stored(user, bot, chat));
        if let Some((index, user)) = matches.next() {
            let authorized = matches.next().is_none()
                && personal(user)
                && user["telegramBotBlocked"] != true
                && (user["telegramBotAutoLinked"] != true
                    || candidate.is_some_and(|(id, _)| id == index));
            return Ok(if authorized {
                chat_profile(user)
            } else {
                Value::Null
            });
        }
        let Some((index, user)) = candidate else {
            return Ok(Value::Null);
        };
        if !personal(user)
            || user["telegramBotBlocked"] == true
            || !string(&user["telegramBotLinkedAt"]).is_empty()
                && user["telegramBotAutoLinked"] != true
        {
            return Ok(Value::Null);
        }
        let user = &mut users[index];
        attach(user, bot, chat, true);
        let details = chat_profile(user);
        self.publish(snapshot, stamp)?;
        Ok(details)
    }

    pub fn telegram_digest_profiles(&self, stamp: &str, bot: &str) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let cutoff = OffsetDateTime::now_utc() - time::Duration::days(6);
        Ok(json!(
            snapshot.data["users"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|user| {
                    let last =
                        OffsetDateTime::parse(string(&user["telegramDigestAt"]), &Rfc3339).ok();
                    personal(user)
                        && user["telegramDigest"] == true
                        && user["telegramBotBlocked"] != true
                        && !string(&user["telegramBotLinkedAt"]).is_empty()
                        && user["telegramBotId"] == bot
                        && last.is_none_or(|date| date <= cutoff)
                })
                .map(chat_profile)
                .collect::<Vec<_>>()
        ))
    }
}

fn personal(user: &Value) -> bool {
    !profiles::anonymous(user) && user["blocked"] != true
}

fn telegram_id(value: &str) -> bool {
    !value.starts_with('0')
        && value.bytes().all(|ch| ch.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|id| (1..=(1u64 << 53) - 1).contains(&id))
}

fn stored(user: &Value, bot: &str, chat: &str) -> bool {
    user["telegramBotId"] == bot
        && user["telegramBotChatId"] == chat
        && !string(&user["telegramBotLinkedAt"]).is_empty()
}

fn status(user: &Value, bot: &str) -> Value {
    let linked = user["telegramBotBlocked"] != true
        && !string(&user["telegramBotLinkedAt"]).is_empty()
        && (bot.is_empty() || user["telegramBotId"] == bot);
    let source = if !linked {
        ""
    } else if user["telegramBotAutoLinked"] == true {
        "configured"
    } else {
        "link"
    };
    json!({"linked":linked,"bindingSource":source,"chatId":string(&user["telegramBotChatId"]),
        "linkedAt":string(&user["telegramBotLinkedAt"]),"digest":user["telegramDigest"]==true})
}

fn chat_profile(user: &Value) -> Value {
    let preferred = user
        .get("defaultTelegramFormat")
        .unwrap_or(&user["defaultDownloadFormat"]);
    json!({"id":user["id"],"chatId":user["telegramBotChatId"],"digest":user["telegramDigest"]==true,
        "seen":user["telegramDigestSeen"],"defaultTelegramFormat":transfer::format(preferred),
        "telegramAsZip":user["telegramAsZip"]==true})
}

fn reset_digest(user: &mut Value) {
    user["telegramDigest"] = false.into();
    user["telegramDigestAt"] = "".into();
    user["telegramDigestSeen"] = json!([]);
}

fn attach(user: &mut Value, bot: &str, chat: &str, automatic: bool) {
    user["telegramBotId"] = bot.into();
    user["telegramBotChatId"] = chat.into();
    user["telegramChatId"] = chat.into();
    user["telegramBotLinkedAt"] = now().into();
    user["telegramBotAutoLinked"] = automatic.into();
    user["telegramBotBlocked"] = false.into();
    user["updatedAt"] = now().into();
    reset_digest(user);
}

fn detach(user: &mut Value, clear_chat: bool) {
    if clear_chat && user["telegramChatId"] == user["telegramBotChatId"] {
        user["telegramChatId"] = "".into();
    }
    for key in ["telegramBotId", "telegramBotChatId", "telegramBotLinkedAt"] {
        user[key] = "".into();
    }
    user["telegramBotAutoLinked"] = false.into();
    user["telegramBotBlocked"] = true.into();
    user["updatedAt"] = now().into();
    reset_digest(user);
}
