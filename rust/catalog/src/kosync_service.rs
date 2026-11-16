use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{md5, pair};
use crate::access_runtime::now_ms;
use crate::crypto_support::{Secret, Sensitive, hex, parse_hex};
use crate::kosync_index::{Cache, Query};
use crate::kosync_store::{Client, Store};
use crate::profile_store::{Account, Snapshot, Store as Profiles};
use crate::reader_state::ReaderState;
use crate::{Result, atomic_file, book_delivery, profile_password};

pub struct KoSync {
    file: PathBuf,
    profile_file: PathBuf,
    indexes: PathBuf,
    enabled: bool,
    store: Store,
    cache: Cache,
}

pub struct Session {
    owner: String,
    verifier: String,
}

#[derive(Deserialize, Serialize)]
pub struct Push {
    pub document: String,
    progress: String,
    percentage: f64,
    device: String,
    #[serde(default)]
    device_id: String,
}

impl Push {
    pub fn valid(&self) -> bool {
        !self.progress.is_empty()
            && self.progress.encode_utf16().count() <= 4096
            && (0.0..=1.0).contains(&self.percentage)
            && self.device.encode_utf16().count() <= 128
            && self.device_id.encode_utf16().count() <= 128
    }
}

pub struct ProgressRequest<'a> {
    pub session: &'a Session,
    pub document: &'a str,
    pub patch: Option<&'a Push>,
}

type Record = IndexMap<String, Box<RawValue>>;

#[derive(Deserialize)]
struct StoredProgress<'a> {
    stamp: String,
    #[serde(borrow)]
    previous: Option<&'a RawValue>,
    book: Option<LinkedBook>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedBook {
    book_uid: Option<String>,
    ext: Option<String>,
}

pub fn valid_document(value: &str) -> bool {
    parse_hex::<16>(value).is_some()
}

impl KoSync {
    pub fn new(data: &Path, enabled: bool) -> Self {
        Self {
            file: data.join("kosync.json"),
            profile_file: data.join("reading-lists.json"),
            indexes: data.join("kosync"),
            enabled,
            store: Store::default(),
            cache: Cache::default(),
        }
    }

    pub fn authenticate(
        &mut self,
        profiles: &mut Profiles,
        username: &str,
        key: &str,
    ) -> Result<Option<Session>> {
        if !self.enabled
            || username.is_empty()
            || username.encode_utf16().count() > 128
            || !valid_document(key)
        {
            return Ok(None);
        }
        let Some((user, _)) = personal(profiles, &self.profile_file, |user| {
            username == account_name(user)
        })?
        else {
            return Ok(None);
        };
        let result = self
            .store
            .account(&self.file, &client(user, None), Some(key))?;
        let Some(verifier) = result["verifier"].as_str() else {
            return Ok(None);
        };
        if result["requiresVerification"] == true
            && !profile_password::verify(verifier, b"", key.as_bytes())?
        {
            return Ok(None);
        }
        Ok(Some(Session {
            owner: user.id.clone(),
            verifier: verifier.into(),
        }))
    }

    pub fn settings(
        &mut self,
        profiles: &mut Profiles,
        owner: &str,
        expected: &str,
        operation: &str,
        password: String,
    ) -> Result<Value> {
        let password = Secret::new(password);
        let Some((user, actual)) = personal(profiles, &self.profile_file, |user| user.id == owner)?
        else {
            return Err("need_profile_login".into());
        };
        if expected != actual {
            return Err("need_profile_login".into());
        }
        let mut generated = None;
        match operation {
            "enable" | "set-password" | "use-web-password" => {
                if !self.enabled {
                    return Err("KOSync выключен при запуске сервера".into());
                }
                let use_web = operation == "use-web-password";
                let secret = password.text();
                let verifier = if operation == "enable" {
                    let (password, verifier) = pair()?;
                    generated = Some(password);
                    verifier
                } else {
                    if use_web {
                        if user.password_hash.is_empty() {
                            return Err("У профиля нет пароля INPX Web".into());
                        }
                        if !profile_password::verify(
                            &user.password_hash,
                            user.login.as_bytes(),
                            secret.as_bytes(),
                        )? {
                            return Err("INPX_INVALID_PROFILE_CREDENTIALS".into());
                        }
                    } else if secret.encode_utf16().count() > 128
                        || secret
                            .trim_matches(crate::fb2_prepare::js_space)
                            .encode_utf16()
                            .count()
                            < 6
                    {
                        return Err("Пароль KOReader должен содержать от 6 до 128 символов".into());
                    }
                    let key = Sensitive(hex(&md5(secret.as_bytes())?).into_bytes());
                    profile_password::hash(&key.0)?
                };
                self.require_profile_stamp(expected)?;
                self.store.set_account(
                    &self.file,
                    owner,
                    verifier,
                    use_web.then_some(user.password_hash.as_str()),
                )?;
            }
            "disable" => {
                self.require_profile_stamp(expected)?;
                self.store.disable_account(&self.file, owner)?;
            }
            "status" => {}
            _ => return Err("Неизвестная операция KOSync".into()),
        }
        let account = self.store.account(&self.file, &client(user, None), None)?;
        let mut result = json!({
            "available": self.enabled, "enabled": !account.is_null(),
            "username": account_name(user), "hasWebPassword": !user.password_hash.is_empty(),
            "usesWebPassword": account["usesWebPassword"] == true,
            "webPasswordChanged": account["webPasswordChanged"] == true,
        });
        if let Some(password) = generated {
            result["password"] = password.into();
        }
        Ok(result)
    }

    pub fn link(
        &mut self,
        uid: &str,
        ext: &str,
        raw: impl FnOnce() -> Result<PathBuf>,
    ) -> Result<()> {
        if self.enabled {
            self.store
                .link(&self.file, uid, ext, now_ms() as u64, raw)?;
        }
        Ok(())
    }

    pub fn progress(
        &mut self,
        profiles: &mut Profiles,
        reader: &ReaderState,
        request: ProgressRequest<'_>,
        book: impl FnOnce(&str) -> Result<Option<book_delivery::Book>>,
        fb2: impl FnOnce(&book_delivery::Book) -> Result<Option<PathBuf>>,
    ) -> Result<Option<Box<RawValue>>> {
        let ProgressRequest {
            session,
            document,
            patch,
        } = request;
        if !self.enabled || !valid_document(document) {
            return Ok(None);
        }
        let owner = &session.owner;
        let Some((user, stamp)) = personal(profiles, &self.profile_file, |user| user.id == *owner)?
        else {
            return Ok(None);
        };
        let state =
            self.store
                .progress(&self.file, &client(user, Some(&session.verifier)), document)?;
        if state.get() == "null" {
            return Ok(None);
        }
        let stored: StoredProgress = serde_json::from_str(state.get())?;
        // Keep the original JSON values so positions written by JavaScript with unpaired
        // UTF-16 escapes can still be read and updated without changing their text.
        let previous = stored
            .previous
            .and_then(|value| serde_json::from_str::<Record>(value.get()).ok())
            .unwrap_or_default();
        let mut reply = previous
            .get("progress")
            .filter(|raw| raw.get().starts_with('"') && raw.get() != r#""""#)
            .map(|_| previous.clone())
            .unwrap_or_default();
        let linked = match stored
            .book
            .as_ref()
            .and_then(|book| book.book_uid.as_deref())
        {
            Some(uid) => book(uid)?,
            None => None,
        };
        let position = linked
            .as_ref()
            .map(|book| reader.request(owner, stamp, &book.uid, None))
            .transpose()?;
        let current = position
            .as_ref()
            .map_or(&Value::Null, |value| &value["progress"]);
        let revision = current["revision"].as_u64().unwrap_or(0);
        let generation = user.reader_progress_generation;
        let ext = stored
            .book
            .as_ref()
            .and_then(|book| book.ext.as_deref())
            .unwrap_or_default();
        let anchor = linked.as_ref().filter(|_| ext == "fb2").and_then(|book| {
            let query = match patch {
                Some(patch) => Query::From {
                    pointer: patch.progress.clone(),
                },
                None => Query::To {
                    text_snippet: current["textSnippet"].as_str().unwrap_or_default().into(),
                    percent: current["percent"].as_f64().unwrap_or_default(),
                },
            };
            // Data can still synchronize between KOReader devices when an FB2 cannot be indexed.
            self.position(document, &query, || fb2(book)).ok().flatten()
        });
        self.require_profile_stamp(stamp)?;
        let previous_revision = stored_number(&previous, "bridgeRevision");
        let previous_generation = stored_number(&previous, "bridgeGeneration").unwrap_or(0);
        let record = if let Some(patch) = patch {
            let timestamp = now_ms() / 1000;
            reply = raw_fields(json!({"document":document,"timestamp":timestamp}))?;
            let mut record = raw_fields(patch)?;
            record.insert("timestamp".into(), to_raw_value(&timestamp)?);
            if let Some(linked) = &linked
                && (revision == 0 || previous_revision == Some(revision))
                && (generation == 0 || previous_generation == generation)
            {
                set_bridge(&mut record, revision, generation)?;
                if ext != "fb2" || anchor.as_ref().is_some_and(Value::is_object) {
                    let mut patch_data = anchor.unwrap_or_else(|| {
                        json!({
                            "textSnippet":"","textOffset":-1,"pageIndex":0,"sectionId":"",
                        })
                    });
                    patch_data["percent"] = patch.percentage.into();
                    patch_data["hidden"] = false.into();
                    patch_data["updatedAt"] = crate::reader_state::now().into();
                    patch_data["baseRevision"] = revision.into();
                    patch_data["generation"] = generation.into();
                    let saved = reader.request(owner, stamp, &linked.uid, Some(&patch_data))?;
                    let progress = &saved["progress"];
                    if progress["conflict"] != true && progress["generationMismatch"] != true {
                        set_bridge(
                            &mut record,
                            progress["revision"].as_u64().unwrap_or(0),
                            progress["generation"].as_u64().unwrap_or(0),
                        )?;
                    }
                }
            }
            Some(record)
        } else if generation > previous_generation && revision == 0 {
            reply.clear();
            let mut record = Record::new();
            set_bridge(&mut record, 0, generation)?;
            Some(record)
        } else if let Some(pointer) = anchor
            .as_ref()
            .and_then(Value::as_str)
            .filter(|_| revision != 0)
        {
            if previous_revision != Some(revision) {
                let timestamp = current["updatedAt"]
                    .as_str()
                    .and_then(|date| OffsetDateTime::parse(date, &Rfc3339).ok())
                    .map(|date| date.unix_timestamp());
                reply = raw_fields(json!({
                    "document": document, "progress": pointer, "percentage": current["percent"],
                    "device": "INPX Web", "device_id": "inpx-web", "timestamp": timestamp,
                }))?;
            }
            let mut record = reply.clone();
            set_bridge(&mut record, revision, generation)?;
            Some(record)
        } else if linked.is_some() && anchor.is_none() {
            let mut record = previous;
            set_bridge(&mut record, revision, generation)?;
            Some(record)
        } else {
            None
        };
        if let Some(record) = record {
            self.store.save_progress(
                &self.file,
                owner,
                document,
                &stored.stamp,
                to_raw_value(&record)?,
                patch.is_some(),
            )?;
        }
        reply.shift_remove("bridgeRevision");
        reply.shift_remove("bridgeGeneration");
        Ok(Some(to_raw_value(&reply)?))
    }

    fn position(
        &mut self,
        document: &str,
        query: &Query,
        source: impl FnOnce() -> Result<Option<PathBuf>>,
    ) -> Result<Option<Value>> {
        let file = self.indexes.join(format!("{document}.json"));
        let mut result = self.cache.lookup(&file, query)?;
        if result["ready"] != true {
            let Some(source) = source()? else {
                return Ok(None);
            };
            Cache::build(&file, &source, document)?;
            result = self.cache.lookup(&file, query)?;
        }
        Ok((result["ready"] == true).then(|| result["value"].take()))
    }

    fn require_profile_stamp(&self, stamp: &str) -> Result<()> {
        if atomic_file::current_stamp(&self.profile_file)?.as_deref() != Some(stamp) {
            return Err("need_profile_login".into());
        }
        Ok(())
    }
}

fn personal<'a>(
    profiles: &'a mut Profiles,
    file: &Path,
    matches: impl Fn(&Account) -> bool,
) -> Result<Option<(&'a Account, &'a str)>> {
    let Snapshot::Ready(document, stamp) = profiles.snapshot(file)? else {
        return Ok(None);
    };
    Ok(document
        .users
        .iter()
        .map(|(_, user)| user)
        .find(|user| {
            !user.blocked
                && !(user.id == "default" && user.login.is_empty() && user.password_hash.is_empty())
                && matches(user)
        })
        .map(|user| (user, stamp)))
}

fn account_name(user: &Account) -> &str {
    if user.login.is_empty() {
        &user.id
    } else {
        &user.login
    }
}

fn client(user: &Account, verifier: Option<&str>) -> Client {
    Client {
        user_id: user.id.clone(),
        password_hash: (!user.password_hash.is_empty()).then(|| user.password_hash.clone()),
        expected_verifier: verifier.map(str::to_owned),
    }
}

fn raw_fields(value: impl Serialize) -> Result<Record> {
    Ok(serde_json::from_str(to_raw_value(&value)?.get())?)
}

fn stored_number(record: &Record, field: &str) -> Option<u64> {
    record.get(field)?.get().parse().ok()
}

fn set_bridge(record: &mut Record, revision: u64, generation: u64) -> Result<()> {
    record.insert("bridgeRevision".into(), to_raw_value(&revision)?);
    record.insert("bridgeGeneration".into(), to_raw_value(&generation)?);
    Ok(())
}
