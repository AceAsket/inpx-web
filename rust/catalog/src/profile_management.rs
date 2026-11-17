use serde_json::{Value, json};

use super::bookmarks::words;
use super::shelves::truthy;
use super::{ReaderState, now, preferences, string, transfer};
use crate::profile_store::Account;
use crate::{Result, crypto_support, profile_decode, profile_password};

pub(super) const ADMIN_ONLY: &str = "Только администратор может управлять профилями";
pub(super) const MISSING: &str = "Пользователь не найден";

pub enum ProfileSessionsChange {
    None,
    Revoke(String),
    KeepCurrent,
    KeepCurrentOnly,
    RefreshScope(Option<String>),
    Login(String),
}

pub struct ProfileChange {
    pub reply: Value,
    pub sessions: ProfileSessionsChange,
}

impl ProfileChange {
    pub(super) fn reply(reply: Value) -> Self {
        Self {
            reply,
            sessions: ProfileSessionsChange::None,
        }
    }
}

impl ReaderState {
    pub fn profile_settings(&self, owner: &str, stamp: &str) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let user = transfer::user(&snapshot.data, owner)?;
        let mut profile = public_profile(user);
        profile["readerPreferences"] = preferences::normalize(&user["readerPreferences"]);
        Ok(profile)
    }

    pub fn manage_profile(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
        root: &str,
    ) -> Result<ProfileChange> {
        let mut snapshot = self.snapshot(stamp)?;
        let data = &mut snapshot.data;
        let admin = is_admin(transfer::user(data, owner)?);
        let policy = profile_decode::auth_policy(&data["profileAuthPolicy"]);
        let target = string(&request["targetUserId"]).trim();
        if (action != "update-user-profile" || target != owner) && !admin {
            return Err(ADMIN_ONLY.into());
        }
        let users = data["users"]
            .as_array_mut()
            .ok_or("Некорректный файл профилей")?;
        let updated = now();
        let result = match action {
            "create-user-profile" | "update-user-profile" => {
                let create = action == "create-user-profile";
                let excluded = if create { "" } else { target };
                let index = if create {
                    None
                } else {
                    Some(target_index(users, target)?)
                };
                let old = index.map_or(&Value::Null, |index| &users[index]);
                let patch = &request["profile"];
                let field = |key: &str| patch.get(key).unwrap_or(&old[key]);
                let name = words(field("name"));
                if name.is_empty() {
                    return Err("Имя пользователя не должно быть пустым".into());
                }
                if name.encode_utf16().count() > 80 {
                    return Err("Имя пользователя слишком длинное".into());
                }
                let login = login(field("login"));
                if !Account::valid_login(&login) {
                    return Err("Логин должен содержать 3-64 символа: буквы, цифры, точку, дефис или подчёркивание".into());
                }
                let lower = name.to_lowercase();
                if users.iter().any(|user| {
                    user["id"] != excluded && string(&user["name"]).to_lowercase() == lower
                }) {
                    return Err("Пользователь с таким именем уже существует".into());
                }
                if !login.is_empty()
                    && users
                        .iter()
                        .any(|user| user["id"] != excluded && user["login"] == login)
                {
                    return Err("Пользователь с таким логином уже существует".into());
                }
                let password = crypto_support::Secret::new(preferences::text(&patch["password"]));
                let old_hash = string(&old["passwordHash"]);
                let renamed = login != old["login"];
                let changed = renamed || !password.text().is_empty();
                let hash = if password.text().is_empty() {
                    if renamed && old_hash.len() == 64 {
                        return Err("Для смены логина укажите пароль заново".into());
                    }
                    old_hash.to_owned()
                } else {
                    if login.is_empty() {
                        return Err("Для пароля нужно указать логин".into());
                    }
                    profile_password::hash(password.text().as_bytes())?
                };
                if is_admin(old) && login.is_empty() {
                    return Err("Для администратора нужен логин".into());
                }
                let mut user = if create {
                    let id = loop {
                        let id = crypto_support::hex(&crypto_support::random::<8>()?);
                        if users.iter().all(|row| row["id"] != id) {
                            break id;
                        }
                    };
                    json!({"id":id,"isAdmin":false,"createdAt":updated,"readerProgress":{},
                        "readerProgressGeneration":0,"readerProgressResetAt":"","readerBookmarks":{},"audioProgress":{}})
                } else {
                    old.clone()
                };
                user["name"] = name.into();
                user["login"] = login.into();
                user["passwordHash"] = hash.into();
                apply_settings(&mut user, patch);
                if !has_password(&user) {
                    if policy.otp_required || user["otpRequired"] == true {
                        return Err(if create {
                            "При обязательном OTP у профиля должны быть логин и пароль"
                        } else {
                            "Сначала снимите требование OTP для профиля"
                        }
                        .into());
                    }
                    if !user["profileTotp"].is_null() {
                        return Err("Сначала отключите двухфакторную защиту профиля".into());
                    }
                    if user["opdsAuthEnabled"] == true {
                        return Err(
                            "Для OPDS-авторизации у профиля должен быть логин и пароль".into()
                        );
                    }
                }
                if changed {
                    remove(&mut user, "opdsAppPasswordHash");
                    remove(&mut user, "profileTrustedDevices");
                }
                if let Some(prefs) = patch.get("readerPreferences").filter(|_| !create) {
                    let mut prefs = preferences::normalize(prefs);
                    self.externalize_preferences(target, root, &mut prefs)?;
                    user["readerPreferences"] = prefs;
                }
                user["updatedAt"] = updated.into();
                let reply = json!({"user": public_profile(&user)});
                if let Some(index) = index {
                    users[index] = user;
                } else {
                    users.push(user);
                }
                ProfileChange {
                    reply,
                    sessions: if !create && changed {
                        ProfileSessionsChange::Revoke(target.into())
                    } else {
                        ProfileSessionsChange::None
                    },
                }
            }
            "set-user-profile-blocked" => {
                let blocked = request["blocked"]
                    .as_bool()
                    .ok_or("Укажите состояние профиля")?;
                let index = target_index(users, target)?;
                let user = &mut users[index];
                if target == owner {
                    return Err("Нельзя заблокировать собственный профиль".into());
                }
                if is_admin(user) || anonymous(user) {
                    return Err("Этот профиль нельзя заблокировать".into());
                }
                let reply = json!({"userId":target,"blocked":blocked});
                if (user["blocked"] == true) == blocked {
                    return Ok(ProfileChange::reply(reply));
                }
                if blocked {
                    user["blocked"] = true.into();
                    remove(user, "profileTrustedDevices");
                } else {
                    remove(user, "blocked");
                }
                user["updatedAt"] = updated.into();
                ProfileChange {
                    reply,
                    sessions: ProfileSessionsChange::Revoke(target.into()),
                }
            }
            "delete-user-profile" => {
                let index = target_index(users, target)?;
                if is_admin(&users[index]) {
                    return Err("Нельзя удалить профиль администратора".into());
                }
                users.remove(index);
                let next = users
                    .first()
                    .map_or("", |user| string(&user["id"]))
                    .to_owned();
                if let Some(lists) = data["lists"].as_array_mut() {
                    lists.retain(|list| list["userId"] != target);
                }
                ProfileChange {
                    reply: json!({"success":true,"nextUserId":next}),
                    sessions: ProfileSessionsChange::Revoke(target.into()),
                }
            }
            _ => return Err("Неизвестная команда профиля".into()),
        };
        self.publish(snapshot, stamp)?;
        Ok(result)
    }
}

fn apply_settings(user: &mut Value, patch: &Value) {
    for field in ["emailTo", "telegramChatId"] {
        if let Some(value) = patch.get(field) {
            let value = preferences::text(value);
            let value = value.trim();
            if field == "telegramChatId" && value != string(&user[field]) {
                for field in [
                    "telegramBotId",
                    "telegramBotChatId",
                    "telegramBotLinkedAt",
                    "telegramDigestAt",
                ] {
                    user[field] = "".into();
                }
                for field in [
                    "telegramBotAutoLinked",
                    "telegramBotBlocked",
                    "telegramDigest",
                ] {
                    user[field] = false.into();
                }
                user["telegramDigestSeen"] = json!([]);
            }
            user[field] = value.into();
        }
    }
    for field in [
        "defaultDownloadFormat",
        "defaultEmailFormat",
        "defaultTelegramFormat",
        "defaultOpdsFormat",
    ] {
        if let Some(value) = patch.get(field) {
            user[field] = transfer::format(value).into();
        }
    }
    for field in ["emailAsZip", "telegramAsZip", "opdsAuthEnabled"] {
        if let Some(value) = patch.get(field) {
            user[field] = (value == true).into();
        }
    }
    for field in ["opdsEnabled", "personalRecommendationsEnabled"] {
        if let Some(value) = patch.get(field) {
            user[field] = (value != false).into();
        }
    }
    if is_admin(user) {
        user["opdsEnabled"] = false.into();
        user["opdsAuthEnabled"] = false.into();
    }
    if user["opdsEnabled"] == false
        || patch.get("opdsAuthEnabled").is_some() && user["opdsAuthEnabled"] == false
    {
        remove(user, "opdsAppPasswordHash");
    }
}

pub(super) fn public_profile(user: &Value) -> Value {
    let download = transfer::format(&user["defaultDownloadFormat"]);
    json!({
        "id":user["id"],"name":user["name"],"login":user["login"],"isAdmin":is_admin(user),
        "hasPassword":has_password(user),"blocked":user["blocked"]==true,
        "otpEnabled":!user["profileTotp"].is_null(),"otpRequired":user["otpRequired"]==true,
        "emailTo":string(&user["emailTo"]),"telegramChatId":string(&user["telegramChatId"]),
        "opdsEnabled":user["opdsEnabled"]!=false,"opdsAuthEnabled":user["opdsAuthEnabled"]==true,
        "emailAsZip":user["emailAsZip"]==true,"telegramAsZip":user["telegramAsZip"]==true,
        "personalRecommendationsEnabled":user["personalRecommendationsEnabled"]!=false,
        "defaultDownloadFormat":download,"defaultOpdsFormat":transfer::format(&user["defaultOpdsFormat"]),
        "defaultEmailFormat":user.get("defaultEmailFormat").map_or(download,transfer::format),
        "defaultTelegramFormat":user.get("defaultTelegramFormat").map_or(download,transfer::format),
        "createdAt":user["createdAt"],"updatedAt":user["updatedAt"],
    })
}

pub(super) fn target_index(users: &[Value], target: &str) -> Result<usize> {
    if target.is_empty() {
        return Err("targetUserId is empty".into());
    }
    users
        .iter()
        .position(|user| user["id"] == target)
        .ok_or_else(|| MISSING.into())
}

pub(super) fn remove(user: &mut Value, field: &str) {
    user.as_object_mut().expect("stored profile").remove(field);
}

pub(super) fn is_admin(user: &Value) -> bool {
    truthy(&user["isAdmin"]) && user["blocked"] != true
}

pub(super) fn anonymous(user: &Value) -> bool {
    user["id"] == "default"
        && !is_admin(user)
        && string(&user["login"]).is_empty()
        && string(&user["passwordHash"]).is_empty()
}

pub(super) fn has_password(user: &Value) -> bool {
    !string(&user["login"]).is_empty() && !string(&user["passwordHash"]).is_empty()
}

pub(super) fn login(value: &Value) -> String {
    preferences::text(value)
        .trim_matches(crate::fb2_prepare::js_space)
        .to_lowercase()
}
