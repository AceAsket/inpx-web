use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, Write};
use std::path::Path;

use redb::{
    Database, ReadOnlyDatabase, ReadOnlyTable, ReadTransaction, ReadableDatabase, ReadableTable,
    Table, TableDefinition, WriteTransaction,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::{
    Result,
    index::{METADATA, check_generation, publish},
};

const BASE_FILE: &str = "books.redb";
const PATCH_FILE: &str = "books-patch.redb";
const RECORDS: TableDefinition<u32, &[u8]> = TableDefinition::new("catalog_records_v1");
const UIDS: TableDefinition<&str, u32> = TableDefinition::new("catalog_book_uids_v1");
const BASE: &str = "base";

#[derive(Deserialize)]
struct Header {
    generation: String,
    previous: Option<String>,
}

#[derive(Deserialize)]
struct BookKey<'a> {
    id: u32,
    #[serde(rename = "_uid")]
    uid: &'a str,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFields {
    words: [Vec<String>; 3],
    physical: String,
    score: f64,
}

#[derive(Deserialize)]
struct BookFrame<'a>(#[serde(borrow)] &'a RawValue, #[serde(borrow)] &'a RawValue);

fn decode(data: &[u8]) -> Result<(&[u8], &[u8])> {
    let (length, data) = data.split_first_chunk::<4>().ok_or("invalid stored row")?;
    data.split_at_checked(u32::from_le_bytes(*length) as usize)
        .ok_or_else(|| "truncated stored row".into())
}

pub(crate) struct BookStoreWriter<'a> {
    books: Table<'a, u32, &'static [u8]>,
    uids: Table<'a, &'static str, u32>,
    original: Option<ReadOnlyTable<&'static str, u32>>,
    changed: BTreeSet<u32>,
    row: Vec<u8>,
}

impl<'a> BookStoreWriter<'a> {
    fn new(transaction: &'a WriteTransaction, base: Option<&ReadTransaction>) -> Result<Self> {
        Ok(Self {
            books: transaction.open_table(RECORDS)?,
            uids: transaction.open_table(UIDS)?,
            original: base.map(|tx| tx.open_table(UIDS)).transpose()?,
            changed: BTreeSet::new(),
            row: Vec::new(),
        })
    }

    pub fn is_patch(&self) -> bool {
        self.original.is_some()
    }

    fn replace(&mut self, id: u32) -> Result<()> {
        if let Some(old) = self.books.get(id)? {
            if self.original.is_none() {
                return Err("duplicate book ID".into());
            }
            if !old.value().is_empty() {
                let (record, _) = decode(old.value())?;
                let old: BookKey = serde_json::from_slice(record)?;
                if self
                    .uids
                    .get(old.uid)?
                    .is_some_and(|owner| owner.value() == id)
                {
                    self.uids.remove(old.uid)?;
                }
            }
        }
        if self.original.is_some() {
            self.changed.insert(id);
        }
        Ok(())
    }

    pub fn add(
        &mut self,
        id: u32,
        uid: &str,
        record: &RawValue,
        projection: &impl Serialize,
    ) -> Result<()> {
        if uid.is_empty() || uid.encode_utf16().count() > 100 {
            return Err("invalid book UID length".into());
        }
        self.replace(id)?;
        self.row.clear();
        let data = record.get().as_bytes();
        self.row
            .extend_from_slice(&u32::try_from(data.len())?.to_le_bytes());
        self.row.extend_from_slice(data);
        serde_json::to_writer(&mut self.row, projection)?;
        self.books.insert(id, self.row.as_slice())?;
        if self.original.is_none() && self.uids.insert(uid, id)?.is_some() {
            return Err("duplicate book UID".into());
        }
        Ok(())
    }

    pub fn remove(&mut self, id: u32) -> Result<()> {
        if self.original.is_none() {
            return Err("removal in a base book store".into());
        }
        self.replace(id)?;
        self.books.insert(id, &[][..])?;
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        if let Some(base_uids) = self.original {
            for id in self.changed {
                let row = self.books.get(id)?.ok_or("missing patched row")?;
                if row.value().is_empty() {
                    continue;
                }
                let key: BookKey = serde_json::from_slice(decode(row.value())?.0)?;
                if let Some(owner) = base_uids.get(key.uid)?
                    && owner.value() != id
                    && self.books.get(owner.value())?.is_none()
                {
                    return Err("duplicate book UID from base".into());
                }
                if self.uids.insert(key.uid, id)?.is_some() {
                    return Err("duplicate book UID in patch".into());
                }
            }
        }
        Ok(())
    }
}

fn apply(writer: &mut BookStoreWriter<'_>, input: &mut impl BufRead) -> Result<usize> {
    let mut line = String::new();
    let mut total = 0;
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Err("incomplete book store build".into());
        }
        if let Some(end) = line.strip_prefix("finish ") {
            if end.trim().parse::<usize>()? != total {
                return Err("book store build count differs".into());
            }
            return Ok(total);
        }
        if let Some(id) = line.strip_prefix("remove ") {
            writer.remove(id.trim().parse()?)?;
        } else {
            let BookFrame(record, projection) = serde_json::from_str(&line)?;
            let key: BookKey = serde_json::from_str(record.get())?;
            writer.add(key.id, key.uid, record, &projection)?;
        }
        total += 1;
    }
}

fn open_read(path: &Path) -> Result<ReadOnlyDatabase> {
    Ok(Database::builder()
        .set_cache_size(96 * 1024 * 1024)
        .open_read_only(path)?)
}

pub fn build_store(
    directory: &Path,
    mut input: impl BufRead,
    mut output: impl Write,
) -> Result<usize> {
    output.write_all(b"ready\n")?;
    output.flush()?;
    let mut line = String::new();
    input.read_line(&mut line)?;
    let header: Header = serde_json::from_str(&line)?;
    write_store(
        directory,
        &header.generation,
        header.previous.as_deref(),
        |writer| apply(writer, &mut input),
    )
}

pub(crate) fn write_store<T>(
    directory: &Path,
    generation: &str,
    previous: Option<&str>,
    build: impl FnOnce(&mut BookStoreWriter<'_>) -> Result<T>,
) -> Result<T> {
    if generation.is_empty() {
        return Err("missing book store generation".into());
    }
    let populate = |tx: &WriteTransaction, base: Option<&ReadTransaction>| {
        let mut writer = BookStoreWriter::new(tx, base)?;
        let result = build(&mut writer)?;
        writer.finish()?;
        Ok(result)
    };
    let Some(previous) = previous else {
        return publish(&directory.join(BASE_FILE), generation, |tx| {
            populate(tx, None)
        });
    };
    let base = open_read(&directory.join(BASE_FILE))?;
    let base_read = base.begin_read()?;
    let base_meta = base_read.open_table(METADATA)?;
    let origin = base_meta
        .get("generation")?
        .ok_or("missing base generation")?;
    let path = directory.join(PATCH_FILE);
    if !path.try_exists()? {
        check_generation(&base_read, previous)?;
        return publish(&path, generation, |tx| {
            tx.open_table(METADATA)?.insert(BASE, origin.value())?;
            populate(tx, Some(&base_read))
        });
    }
    let db = Database::builder().open(path)?;
    let previous_read = db.begin_read()?;
    check_generation(&previous_read, previous)?;
    check_base(&previous_read, origin.value())?;
    drop(previous_read);
    let tx = db.begin_write()?;
    tx.open_table(METADATA)?.insert("generation", generation)?;
    let rows = populate(&tx, Some(&base_read))?;
    tx.commit()?;
    Ok(rows)
}

fn check_base(patch: &redb::ReadTransaction, origin: &str) -> Result<()> {
    let metadata = patch.open_table(METADATA)?;
    if !metadata
        .get(BASE)?
        .is_some_and(|value| value.value() == origin)
    {
        return Err("catalog patch is from a different book store".into());
    }
    Ok(())
}

pub struct BookStore {
    base: ReadOnlyDatabase,
    patch: Option<ReadOnlyDatabase>,
}

#[derive(Deserialize)]
pub struct StoreRequest {
    generation: String,
    #[serde(flatten)]
    query: StoreQuery,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum StoreQuery {
    Probe,
    Rows {
        ids: Vec<u32>,
        fields: Option<Vec<String>>,
    },
    Uids {
        uids: Vec<String>,
    },
    Search {
        ids: Vec<u32>,
        terms: [Vec<[String; 2]>; 3],
        deleted: Option<i64>,
        source: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum StoreResponse {
    Probe(bool),
    Rows(Vec<Box<RawValue>>),
    Matches(Vec<Match>),
}

#[derive(Serialize)]
pub struct Match {
    id: u32,
    author: String,
    series: String,
    title: String,
    serno: f64,
    order: usize,
    #[serde(skip)]
    score: f64,
}

#[derive(Deserialize)]
struct SearchRow {
    author: String,
    series: String,
    title: String,
    serno: f64,
    del: Option<i64>,
    #[serde(default, rename = "sourceId")]
    source: String,
}

impl BookStore {
    pub fn open(directory: &Path) -> Result<Self> {
        let patch = directory.join(PATCH_FILE);
        Ok(Self {
            base: open_read(&directory.join(BASE_FILE))?,
            patch: if patch.try_exists()? {
                Some(open_read(&patch)?)
            } else {
                None
            },
        })
    }

    pub fn query(&self, request: StoreRequest) -> Result<StoreResponse> {
        let base = self.base.begin_read()?;
        let patch = self
            .patch
            .as_ref()
            .map(ReadableDatabase::begin_read)
            .transpose()?;
        if let Some(patch) = &patch {
            check_generation(patch, &request.generation)?;
            let metadata = base.open_table(METADATA)?;
            let origin = metadata
                .get("generation")?
                .ok_or("missing base generation")?;
            check_base(patch, origin.value())?;
        } else {
            check_generation(&base, &request.generation)?;
        }
        let records = base.open_table(RECORDS)?;
        let updated = patch
            .as_ref()
            .map(|tx| tx.open_table(RECORDS))
            .transpose()?;
        let read = |id| {
            if let Some(updated) = &updated
                && let Some(value) = updated.get(id)?
            {
                return Ok(Some(value));
            }
            Ok::<_, Box<dyn std::error::Error>>(records.get(id)?)
        };
        Ok(match request.query {
            StoreQuery::Probe => StoreResponse::Probe(true),
            StoreQuery::Rows { ids, fields } => {
                let mut rows = Vec::new();
                for id in ids {
                    if let Some(row) = read(id)?
                        && !row.value().is_empty()
                    {
                        let record = decode(row.value())?.0;
                        rows.push(if let Some(fields) = &fields {
                            let mut row: serde_json::Map<String, serde_json::Value> =
                                serde_json::from_slice(record)?;
                            row.retain(|key, _| fields.contains(key));
                            serde_json::value::to_raw_value(&row)?
                        } else {
                            serde_json::from_slice(record)?
                        });
                    }
                }
                StoreResponse::Rows(rows)
            }
            StoreQuery::Uids { uids } => {
                let by_uid = base.open_table(UIDS)?;
                let newer = patch.as_ref().map(|tx| tx.open_table(UIDS)).transpose()?;
                let mut rows = Vec::new();
                for uid in uids {
                    let active = match &newer {
                        Some(index) => index.get(uid.as_str())?,
                        None => None,
                    };
                    let id = active.or(by_uid.get(uid.as_str())?);
                    if let Some(id) = id
                        && let Some(row) = read(id.value())?
                        && !row.value().is_empty()
                    {
                        let (record, _) = decode(row.value())?;
                        if serde_json::from_slice::<BookKey>(record)?.uid == uid {
                            rows.push(serde_json::from_slice(record)?);
                        }
                    }
                }
                StoreResponse::Rows(rows)
            }
            StoreQuery::Search {
                ids,
                terms,
                deleted,
                source,
            } => {
                let mut matches = HashMap::<String, Match>::new();
                for (order, id) in ids.into_iter().enumerate() {
                    let Some(row) = read(id)? else { continue };
                    if row.value().is_empty() {
                        continue;
                    }
                    let (record, search) = decode(row.value())?;
                    let fields: SearchFields = serde_json::from_slice(search)?;
                    if !terms.iter().zip(&fields.words).all(|(wanted, words)| {
                        wanted.iter().all(|term| {
                            words.as_chunks::<2>().0.iter().any(|word| {
                                word[0].starts_with(&term[0]) || word[1].starts_with(&term[1])
                            })
                        })
                    }) {
                        continue;
                    }
                    let book: SearchRow = serde_json::from_slice(record)?;
                    if deleted.is_some() && deleted != book.del
                        || source.as_ref().is_some_and(|s| *s != book.source)
                    {
                        continue;
                    }
                    let candidate = Match {
                        id,
                        order,
                        score: fields.score,
                        author: book.author,
                        title: book.title,
                        series: book.series,
                        serno: book.serno,
                    };
                    matches
                        .entry(fields.physical)
                        .and_modify(|old| {
                            if candidate.score > old.score
                                || candidate.score == old.score && candidate.id < old.id
                            {
                                old.id = candidate.id;
                                old.score = candidate.score;
                                old.author.clone_from(&candidate.author);
                                old.title.clone_from(&candidate.title);
                                old.series.clone_from(&candidate.series);
                                old.serno = candidate.serno;
                            }
                        })
                        .or_insert(candidate);
                }
                StoreResponse::Matches(matches.into_values().collect())
            }
        })
    }
}
