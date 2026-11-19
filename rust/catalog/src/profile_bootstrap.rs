use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use time::OffsetDateTime;

use crate::crypto_support::{Secret, Sensitive, hex, random};
use crate::fb2_prepare::js_space;
use crate::file_stamp::stamp;
use crate::profile_store::{Account, Document, publish_users};
use crate::{Result, atomic_file, profile_decode, profile_password};

const ADMIN: &str = "admin";
const GUEST: &str = "default";

#[derive(Deserialize)]
pub struct Options {
    login: String,
    password: Secret,
    reset: bool,
}

pub(crate) enum Outcome {
    Ready {
        stamp: String,
        generated_password: Option<Secret>,
    },
    Changed,
    Legacy,
    LoginConflict,
}

pub fn initialize(
    data: &Path,
    login: &str,
    password: String,
    reset: bool,
) -> Result<Option<String>> {
    let file = data.join("reading-lists.json");
    let expected = atomic_file::current_stamp(&file)?;
    let options = Options {
        login: login.trim_matches(js_space).to_lowercase(),
        password: Secret::new(password),
        reset,
    };
    match run(&file, expected.as_deref(), options)? {
        Outcome::Ready {
            generated_password, ..
        } => Ok(generated_password.map(|value| value.text().to_owned())),
        Outcome::Changed => Err("Файл профилей изменился, повторите запуск".into()),
        Outcome::Legacy => Err("Profile data requires the compatibility runtime".into()),
        Outcome::LoginConflict => {
            Err(format!("Admin login \"{login}\" already used by another profile").into())
        }
    }
}

pub(crate) fn run(path: &Path, expected: Option<&str>, options: Options) -> Result<Outcome> {
    if !Account::valid_login(&options.login) {
        return Err(
            "Логин должен содержать 3-64 символа: буквы, цифры, точку, дефис или подчёркивание"
                .into(),
        );
    }
    if atomic_file::current_stamp(path)?.as_deref() != expected {
        return Ok(Outcome::Changed);
    }
    let mut input = String::new();
    if let Some(expected) = expected {
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Outcome::Changed),
            Err(error) => return Err(error.into()),
        };
        if stamp(&file)?.to_string() != expected {
            return Ok(Outcome::Changed);
        }
        match file.read_to_string(&mut input) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::InvalidData => return Ok(Outcome::Legacy),
            Err(error) => return Err(error.into()),
        }
    } else {
        input = json!({"version":5,"users":[],"lists":[],"sharedDiscoveryConfig":{},"metadataOverrides":{},
            "profileAuthPolicy":{"otpRequired":false,"trustedBrowsersEnabled":true,"trustedBrowserDays":30},
            "readerProgressCheckpoint":hex(&random::<16>()?)}).to_string();
    }
    let Some(document) = profile_decode::decode(&input) else {
        return Ok(Outcome::Legacy);
    };
    let admin = document
        .users
        .iter()
        .find(|(_, user)| user.is_admin)
        .or_else(|| document.users.iter().find(|(_, user)| user.id == ADMIN));
    let target = document
        .users
        .iter()
        .position(|(_, user)| user.id == ADMIN || user.is_admin);
    let change_password =
        admin.is_none_or(|(_, user)| options.reset || user.password_hash.is_empty());
    let update_admin = change_password || admin.is_some_and(|(_, user)| !user.bootstrapped_admin());
    if options.reset
        && let Some((_, admin)) = admin
        && document
            .users
            .iter()
            .any(|(_, user)| user.id != admin.id && user.login == options.login)
    {
        return Ok(Outcome::LoginConflict);
    }
    if !update_admin && target == Some(0) {
        return Ok(
            if atomic_file::current_stamp(path)?.as_deref() == expected {
                Outcome::Ready {
                    stamp: expected
                        .expect("an administrator was read from disk")
                        .into(),
                    generated_password: None,
                }
            } else {
                Outcome::Changed
            },
        );
    }

    let mut root: IndexMap<String, &RawValue> = serde_json::from_str(input.trim_matches(js_space))?;
    let mut users: Vec<&RawValue> = root
        .get("users")
        .map(|raw| serde_json::from_str(raw.get()))
        .transpose()?
        .unwrap_or_default();
    let lists = if admin.is_none() || target.is_some_and(|index| index > 0) {
        preserve_list_owners(root.get("lists").copied(), &document)?
    } else {
        ListOwners::Unchanged
    };
    match &lists {
        ListOwners::Unchanged => {}
        ListOwners::Preserved(lists) => {
            root.insert("lists".into(), lists);
        }
        ListOwners::Legacy => return Ok(Outcome::Legacy),
    }

    let now = time_string()?;
    let guest = document
        .users
        .is_empty()
        .then(|| to_raw_value(&new_profile(GUEST, "Без профиля", "", "", &now)))
        .transpose()?;
    if let Some(guest) = &guest {
        users.push(guest);
    }
    let generated_password = if change_password && options.password.text().is_empty() {
        let bytes = Sensitive(random::<12>()?);
        Some(Secret::new(URL_SAFE_NO_PAD.encode(bytes.0.as_slice())))
    } else {
        None
    };
    let password = generated_password.as_ref().unwrap_or(&options.password);
    let hash = change_password
        .then(|| profile_password::hash(password.text().as_bytes()))
        .transpose()?;
    let reset_existing = options.reset && admin.is_some();
    let mut policy = None;
    if reset_existing {
        let value: Value = root
            .get("profileAuthPolicy")
            .map(|value| serde_json::from_str(value.get()))
            .transpose()?
            .unwrap_or_default();
        let mut fields = match value {
            Value::Object(fields) => fields,
            _ => serde_json::Map::new(),
        };
        fields.insert("otpRequired".into(), Value::Bool(false));
        policy = Some(to_raw_value(&fields)?);
    }
    if let Some(policy) = &policy {
        root.insert("profileAuthPolicy".into(), policy);
    }

    let mut admin_row = None;
    if update_admin {
        admin_row = Some(match admin {
            Some((index, account)) => {
                let mut fields: IndexMap<String, &RawValue> =
                    serde_json::from_str(users[*index].get())?;
                let mut updates =
                    json!({"isAdmin":true,"opdsEnabled":false,"opdsAuthEnabled":false});
                fields.shift_remove("blocked");
                if change_password || account.login.is_empty() {
                    updates["login"] = json!(options.login);
                }
                if let Some(hash) = &hash {
                    updates["passwordHash"] = json!(hash);
                    updates["updatedAt"] = json!(now);
                }
                if reset_existing {
                    for field in [
                        "profileTotp",
                        "profileTrustedDevices",
                        "otpRequired",
                        "opdsAppPasswordHash",
                    ] {
                        fields.shift_remove(field);
                    }
                }
                let changes = to_raw_value(&updates)?;
                fields.extend(serde_json::from_str::<IndexMap<String, &RawValue>>(
                    changes.get(),
                )?);
                to_raw_value(&fields)?
            }
            None => to_raw_value(&new_profile(
                ADMIN,
                "Администратор",
                &options.login,
                hash.as_deref().expect("new admin password"),
                &now,
            ))?,
        });
    }
    if let Some((index, _)) = admin {
        if let Some(row) = &admin_row {
            users[*index] = row;
        }
        if let Some(target) = target.filter(|&index| index > 0) {
            let moved = users.remove(document.users[target].0);
            users.insert(0, moved);
        }
    } else {
        users.insert(0, admin_row.as_deref().expect("new admin row"));
    }

    if expected.is_none() {
        fs::create_dir_all(path.parent().ok_or("missing profile directory")?)?;
    }
    let Some(installed) = publish_users(path, expected, root, &users)? else {
        return Ok(Outcome::Changed);
    };
    Ok(Outcome::Ready {
        stamp: installed,
        generated_password,
    })
}

fn new_profile(id: &str, name: &str, login: &str, hash: &str, now: &str) -> Value {
    let admin = id == ADMIN;
    json!({"id":id,"name":name,"login":login,"passwordHash":hash,"isAdmin":admin,"emailTo":"","telegramChatId":"",
        "opdsEnabled":!admin,"opdsAuthEnabled":false,"readerProgressGeneration":0,"readerProgressResetAt":"",
        "createdAt":now,"updatedAt":now})
}

enum ListOwners {
    Unchanged,
    Preserved(Box<RawValue>),
    Legacy,
}

// Bind legacy unowned lists to the original first profile before moving or inserting the administrator.
fn preserve_list_owners(raw: Option<&RawValue>, document: &Document) -> Result<ListOwners> {
    let Some(raw) = raw else {
        return Ok(ListOwners::Unchanged);
    };
    let Ok(lists) = serde_json::from_str::<Vec<&RawValue>>(raw.get()) else {
        return Ok(ListOwners::Unchanged);
    };
    let owner = document
        .users
        .first()
        .map_or(GUEST, |(_, user)| user.id.as_str());
    let fallback = to_raw_value(&owner)?;
    let mut changes = Vec::with_capacity(lists.len());
    let mut changed = false;
    for row in &lists {
        let Ok(mut list) = serde_json::from_str::<IndexMap<String, &RawValue>>(row.get()) else {
            changes.push(None);
            continue;
        };
        let value: Value = list
            .get("userId")
            .map(|value| serde_json::from_str(value.get()))
            .transpose()?
            .unwrap_or_default();
        let Ok(user) = profile_decode::text(&value) else {
            return Ok(ListOwners::Legacy);
        };
        if !document
            .users
            .iter()
            .any(|(_, account)| account.id == user.trim_matches(js_space))
        {
            list.insert("userId".into(), &fallback);
            changes.push(Some(to_raw_value(&list)?));
            changed = true;
        } else {
            changes.push(None);
        }
    }
    if !changed {
        return Ok(ListOwners::Unchanged);
    }
    let preserved: Vec<&RawValue> = changes
        .iter()
        .zip(lists)
        .map(|(change, row)| change.as_deref().unwrap_or(row))
        .collect();
    Ok(ListOwners::Preserved(to_raw_value(&preserved)?))
}

fn time_string() -> Result<String> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    let now = OffsetDateTime::from_unix_timestamp_nanos(elapsed.as_nanos().try_into()?)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    ))
}
