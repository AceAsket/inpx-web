use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::Result;
use crate::atomic_file;
use crate::crypto_support::{equal, hex, parse_hex};
use crate::file_stamp::{FileStamp, path_stamp, stamp};
use crate::kosync::fingerprint;

const STORE_LIMIT: u64 = 32 * 1024 * 1024;
const BOOK_LIMIT: usize = 8192;
const PROGRESS_LIMIT: usize = 2000;

type RawMap = IndexMap<String, Box<RawValue>>;
type Fields = IndexMap<String, Option<Box<RawValue>>>;
type Accounts = IndexMap<String, AccountEntry>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Client {
    user_id: String,
    password_hash: Option<String>,
    expected_verifier: Option<String>,
}

struct Account {
    verifier: Option<String>,
    web_password_fingerprint: Option<String>,
    documents: RawMap,
    extra: Fields,
}

impl Account {
    fn parse(raw: &RawValue) -> Result<Self> {
        let mut fields: Fields = serde_json::from_str(raw.get())?;
        let documents = fields
            .shift_remove("documents")
            .flatten()
            .map(|value| serde_json::from_str(value.get()))
            .transpose()?
            .unwrap_or_default();
        let mut string = |key| -> Result<Option<String>> {
            Ok(fields
                .shift_remove(key)
                .flatten()
                .map(|value| serde_json::from_str(value.get()))
                .transpose()?)
        };
        let verifier = string("verifier")?;
        let web_password_fingerprint = string("webPasswordFingerprint")?;
        Ok(Self {
            verifier,
            web_password_fingerprint,
            documents,
            extra: fields,
        })
    }

    fn matches_web_password(&self, password_hash: Option<&str>) -> bool {
        let Some(saved) = &self.web_password_fingerprint else {
            return true;
        };
        saved.is_empty()
            || password_hash
                .filter(|hash| !hash.is_empty())
                .is_some_and(|hash| {
                    parse_hex::<32>(saved)
                        .is_some_and(|expected| equal(&Sha256::digest(hash).into(), &expected))
                })
    }
}

impl Serialize for Account {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let count = self.extra.len()
            + 1
            + usize::from(self.verifier.is_some())
            + usize::from(self.web_password_fingerprint.is_some());
        let mut map = serializer.serialize_map(Some(count))?;
        if let Some(verifier) = &self.verifier {
            map.serialize_entry("verifier", verifier)?;
        }
        if let Some(hash) = &self.web_password_fingerprint {
            map.serialize_entry("webPasswordFingerprint", hash)?;
        }
        map.serialize_entry("documents", &self.documents)?;
        for (key, raw) in &self.extra {
            map.serialize_entry(key, raw)?;
        }
        map.end()
    }
}

enum AccountEntry {
    Raw(Box<RawValue>),
    Parsed(Account),
}

impl Serialize for AccountEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Raw(raw) => raw.serialize(serializer),
            Self::Parsed(account) => account.serialize(serializer),
        }
    }
}

fn account<'a>(accounts: &'a mut Accounts, user_id: &str) -> Result<Option<&'a mut Account>> {
    let Some(entry) = accounts.get_mut(user_id) else {
        return Ok(None);
    };
    if let AccountEntry::Raw(raw) = entry {
        if raw.get() == "null" {
            return Ok(None);
        }
        *entry = AccountEntry::Parsed(Account::parse(raw)?);
    }
    match entry {
        AccountEntry::Parsed(account) => Ok(Some(account)),
        AccountEntry::Raw(_) => unreachable!(),
    }
}

struct State {
    file: PathBuf,
    revision: Option<FileStamp>,
    fields: Fields,
    accounts: Accounts,
    books: RawMap,
}

impl State {
    fn empty(file: &Path) -> Self {
        Self {
            file: file.to_owned(),
            revision: None,
            fields: Fields::from([
                (
                    "version".into(),
                    Some(RawValue::from_string("1".into()).expect("valid version")),
                ),
                ("accounts".into(), None),
                ("books".into(), None),
            ]),
            accounts: Accounts::new(),
            books: RawMap::new(),
        }
    }

    fn open(file: &Path) -> Result<Option<Self>> {
        let input = match File::open(file) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let revision = stamp(&input)?;
        let mut body = Vec::with_capacity(revision.len.min(STORE_LIMIT) as usize);
        if revision.len > STORE_LIMIT
            || input.take(STORE_LIMIT + 1).read_to_end(&mut body)? as u64 > STORE_LIMIT
        {
            return Err("Хранилище KOSync превышает лимит".into());
        }
        let bytes = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&body);
        let mut fields: Fields = serde_json::from_slice(bytes)?;
        let mut read_map = |key| -> Result<RawMap> {
            let contents = fields
                .get_mut(key)
                .and_then(Option::take)
                .ok_or("Отсутствуют данные KOSync")?;
            Ok(serde_json::from_str(contents.get())?)
        };
        let accounts = read_map("accounts")?
            .into_iter()
            .map(|(id, value)| (id, AccountEntry::Raw(value)))
            .collect();
        let books = read_map("books")?;
        Ok(Some(Self {
            file: file.to_owned(),
            revision: Some(revision),
            fields,
            accounts,
            books,
        }))
    }

    fn persist(&mut self) -> Result<()> {
        let parent = self
            .file
            .parent()
            .ok_or("Некорректный путь хранилища KOSync")?;
        fs::create_dir_all(parent)?;
        let mut temp = NamedTempFile::new_in(parent)?;
        {
            let mut output = io::BufWriter::with_capacity(64 * 1024, &mut temp);
            serde_json::to_writer(&mut output, self)?;
            output.flush()?;
        }
        if temp.as_file().metadata()?.len() > STORE_LIMIT {
            return Err("Хранилище KOSync заполнено".into());
        }
        let expected = self.revision.as_ref().map(ToString::to_string);
        let installed = atomic_file::publish(temp, &self.file, expected.as_deref())?
            .ok_or("Хранилище KOSync изменено во время записи")?;
        self.revision = Some(stamp(&installed)?);
        Ok(())
    }
}

impl Serialize for State {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.fields.len()))?;
        for (key, value) in &self.fields {
            match key.as_str() {
                "accounts" => map.serialize_entry(key, &self.accounts)?,
                "books" => map.serialize_entry(key, &self.books)?,
                _ => map.serialize_entry(key, value)?,
            }
        }
        map.end()
    }
}

#[derive(Serialize)]
struct Progress<'a> {
    stamp: String,
    verifier: &'a str,
    previous: Option<&'a RawValue>,
    book: Option<&'a RawValue>,
}

#[derive(Default)]
pub(crate) struct Store {
    cached: Option<State>,
}

enum Missing {
    Create,
    Skip,
    Reject,
}

impl Store {
    fn load(&mut self, file: &Path) -> Result<Option<&mut State>> {
        let revision = match path_stamp(file) {
            Ok(revision) => revision,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.cached = None;
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        if !self
            .cached
            .as_ref()
            .is_some_and(|state| state.file == file && state.revision.as_ref() == Some(&revision))
        {
            self.cached = State::open(file)?;
        }
        Ok(self.cached.as_mut())
    }

    fn update(
        &mut self,
        file: &Path,
        missing: Missing,
        edit: impl FnOnce(&mut State) -> Result<bool>,
    ) -> Result<()> {
        let result = (|| {
            self.load(file)?;
            let state = if let Some(state) = &mut self.cached {
                state
            } else {
                match missing {
                    Missing::Create => self.cached.insert(State::empty(file)),
                    Missing::Skip => return Ok(()),
                    Missing::Reject => {
                        return Err("Хранилище KOSync изменено во время записи".into());
                    }
                }
            };
            if edit(state)? {
                state.persist()?;
            }
            Ok(())
        })();
        if result.is_err() {
            // A failed publication leaves the file as the source of truth.
            self.cached = None;
        }
        result
    }

    pub fn account(&mut self, file: &Path, client: &Client, key: Option<&str>) -> Result<Value> {
        let Some(state) = self.load(file)? else {
            return Ok(Value::Null);
        };
        let Some(account) = account(&mut state.accounts, &client.user_id)? else {
            return Ok(Value::Null);
        };
        if client
            .expected_verifier
            .as_deref()
            .is_some_and(|stored| account.verifier.as_deref() != Some(stored))
        {
            return Ok(Value::Null);
        }
        let matches = account.matches_web_password(client.password_hash.as_deref());
        let mut requires_verification = false;
        if let Some(key) = key {
            if !matches || parse_hex::<16>(key).is_none() {
                return Ok(Value::Null);
            }
            let Some(verifier) = account.verifier.as_deref() else {
                return Ok(Value::Null);
            };
            if let Some(expected) = parse_hex::<32>(verifier) {
                if !equal(&Sha256::digest(key).into(), &expected) {
                    return Ok(Value::Null);
                }
            } else {
                // The shared credentials pool bounds concurrent scrypt work.
                requires_verification = true;
            }
        }
        Ok(
            json!({"verifier":account.verifier,"usesWebPassword":account.web_password_fingerprint
            .as_ref().is_some_and(|hash| !hash.is_empty()),"webPasswordChanged":!matches,
            "requiresVerification":requires_verification}),
        )
    }

    pub fn set_account(
        &mut self,
        file: &Path,
        id: &str,
        verifier: String,
        web_password_hash: Option<&str>,
    ) -> Result<()> {
        self.update(file, Missing::Create, |state| {
            let documents = account(&mut state.accounts, id)?
                .map(|row| std::mem::take(&mut row.documents))
                .unwrap_or_default();
            let row = Account {
                verifier: Some(verifier),
                web_password_fingerprint: web_password_hash.map(|hash| hex(&Sha256::digest(hash))),
                documents,
                extra: Fields::new(),
            };
            state
                .accounts
                .insert(id.to_owned(), AccountEntry::Parsed(row));
            Ok(true)
        })
    }

    pub fn disable_account(&mut self, file: &Path, id: &str) -> Result<()> {
        self.update(file, Missing::Skip, |state| {
            Ok(state.accounts.shift_remove(id).is_some())
        })
    }

    pub fn progress(
        &mut self,
        file: &Path,
        client: &Client,
        document: &str,
    ) -> Result<Box<RawValue>> {
        let Some(state) = self.load(file)? else {
            return Ok(RawValue::NULL.to_owned());
        };
        let Some(account) = account(&mut state.accounts, &client.user_id)? else {
            return Ok(RawValue::NULL.to_owned());
        };
        let Some(verifier) = account.verifier.as_deref() else {
            return Ok(RawValue::NULL.to_owned());
        };
        if client
            .expected_verifier
            .as_deref()
            .is_some_and(|stored| stored != verifier)
            || !account.matches_web_password(client.password_hash.as_deref())
        {
            return Ok(RawValue::NULL.to_owned());
        }
        Ok(serde_json::value::to_raw_value(&Progress {
            stamp: state
                .revision
                .as_ref()
                .ok_or("Отсутствует версия хранилища KOSync")?
                .to_string(),
            verifier,
            previous: account.documents.get(document).map(Box::as_ref),
            book: state.books.get(document).map(Box::as_ref),
        })?)
    }

    pub fn save_progress(
        &mut self,
        file: &Path,
        id: &str,
        document: &str,
        expected: &str,
        record: Box<RawValue>,
        prune: bool,
    ) -> Result<()> {
        self.update(file, Missing::Reject, |state| {
            if state
                .revision
                .as_ref()
                .is_none_or(|revision| revision.to_string() != expected)
            {
                return Err("Хранилище KOSync изменено во время записи".into());
            }
            let account =
                account(&mut state.accounts, id)?.ok_or("Аккаунт KOSync больше недоступен")?;
            let docs = &mut account.documents;
            if (!prune || docs.len() <= PROGRESS_LIMIT)
                && docs
                    .get(document)
                    .is_some_and(|previous| previous.get() == record.get())
            {
                return Ok(false);
            }
            docs.insert(document.to_owned(), record);
            if prune {
                prune_oldest(docs, PROGRESS_LIMIT, |row| {
                    #[derive(Deserialize)]
                    struct Time {
                        timestamp: Option<i64>,
                    }
                    serde_json::from_str::<Time>(row.get())
                        .ok()
                        .and_then(|time| time.timestamp)
                        .unwrap_or(0)
                });
            }
            Ok(true)
        })
    }

    pub fn link(
        &mut self,
        file: &Path,
        source: &Path,
        uid: &str,
        ext: &str,
        now: u64,
    ) -> Result<()> {
        if uid.is_empty() || !matches!(ext, "fb2" | "epub" | "pdf" | "djvu") {
            return Ok(());
        }
        self.update(file, Missing::Skip, |state| {
            if state.accounts.is_empty() {
                return Ok(false);
            }
            update_link(&mut state.books, source, uid, ext, now)
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkFields {
    book_uid: Option<String>,
    updated_at: Option<i64>,
}

fn update_link(books: &mut RawMap, source: &Path, uid: &str, ext: &str, now: u64) -> Result<bool> {
    let document = fingerprint(&mut File::open(source)?)?;
    let value = match books.get(&document) {
        Some(row)
            if serde_json::from_str::<LinkFields>(row.get())
                .is_ok_and(|old| old.book_uid.as_deref() != Some(uid)) =>
        {
            json!({"ambiguous":true})
        }
        _ => {
            let name = source
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("Некорректное имя файла KOSync")?;
            json!({"bookUid":uid,"ext":ext,"cacheFile":name,"updatedAt":now})
        }
    };
    let link = serde_json::value::to_raw_value(&value)?;
    if books.len() <= BOOK_LIMIT
        && books
            .get(&document)
            .is_some_and(|old| old.get() == link.get())
    {
        return Ok(false);
    }
    books.insert(document, link);
    prune_oldest(books, BOOK_LIMIT, |row| {
        serde_json::from_str::<LinkFields>(row.get())
            .ok()
            .and_then(|old| old.updated_at)
            .unwrap_or(0)
    });
    Ok(true)
}

fn prune_oldest(rows: &mut RawMap, limit: usize, time: impl Fn(&RawValue) -> i64) {
    let excess = rows.len().saturating_sub(limit);
    if excess == 0 {
        return;
    }
    let by_time = rows.iter().map(|(key, row)| (key, time(row)));
    if excess == 1 {
        // Equal timestamps retain their persisted insertion order.
        let key = by_time
            .min_by_key(|(_, time)| *time)
            .expect("at least one row")
            .0
            .clone();
        rows.shift_remove(&key);
        return;
    }
    let mut ranked: Vec<_> = by_time.collect();
    ranked.sort_by_key(|(_, time)| *time);
    let mut removed: Vec<_> = ranked
        .into_iter()
        .take(excess)
        .map(|(key, _)| key.clone())
        .collect();
    removed.sort_unstable();
    rows.retain(|key, _| removed.binary_search(key).is_err());
}
