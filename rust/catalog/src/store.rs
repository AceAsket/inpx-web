use std::collections::{BTreeSet, HashMap, hash_map::Entry};
use std::io::{BufRead, Write};
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::{borrow::Cow, cell::RefCell};

use redb::{
    Database, ReadOnlyDatabase, ReadOnlyTable, ReadTransaction, ReadableDatabase, ReadableTable,
    Table, TableDefinition, WriteTransaction,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::catalog_files::{FileCounter, FileTotals};
use crate::catalog_query::{Copies, Filter, merged_key};
use crate::facets::{Facet, Label, Postings};
use crate::lookup::{LookupIndex, Table as LookupTable};
use crate::wide_search::{self, WideOrder, WideResult, WideSearch};
use crate::{
    Result,
    index::{METADATA, REDUCED_CACHE_BYTES, check_generation, publish_with_cache},
};

const BASE_FILE: &str = "books.redb";
const PATCH_FILE: &str = "books-patch.redb";
const RECORDS: TableDefinition<u32, &[u8]> = TableDefinition::new("catalog_records_v1");
const UIDS: TableDefinition<&str, u32> = TableDefinition::new("catalog_book_uids_v1");
const BASE: &str = "base";
const READ_CACHE_BYTES: usize = 96 * 1024 * 1024;

#[derive(Deserialize)]
struct Header {
    generation: String,
    previous: Option<String>,
    #[serde(default, rename = "lowMemory")]
    low_memory: bool,
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

pub(crate) fn decode(data: &[u8]) -> Result<(&[u8], &[u8])> {
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

fn open_read(path: &Path, cache_bytes: usize) -> Result<ReadOnlyDatabase> {
    Ok(Database::builder()
        .set_cache_size(cache_bytes)
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
        header.low_memory,
        |writer| apply(writer, &mut input),
    )
}

pub(crate) fn write_store<T>(
    directory: &Path,
    generation: &str,
    previous: Option<&str>,
    low_memory: bool,
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
        return publish_with_cache(&directory.join(BASE_FILE), generation, low_memory, |tx| {
            populate(tx, None)
        });
    };
    let base = open_read(
        &directory.join(BASE_FILE),
        if low_memory {
            REDUCED_CACHE_BYTES
        } else {
            READ_CACHE_BYTES
        },
    )?;
    let base_read = base.begin_read()?;
    let base_meta = base_read.open_table(METADATA)?;
    let origin = base_meta
        .get("generation")?
        .ok_or("missing base generation")?;
    let path = directory.join(PATCH_FILE);
    if !path.try_exists()? {
        check_generation(&base_read, previous)?;
        return publish_with_cache(&path, generation, low_memory, |tx| {
            tx.open_table(METADATA)?.insert(BASE, origin.value())?;
            populate(tx, Some(&base_read))
        });
    }
    let mut builder = Database::builder();
    if low_memory {
        builder.set_cache_size(REDUCED_CACHE_BYTES);
    }
    let db = builder.open(path)?;
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

fn check_snapshot(
    base: &ReadTransaction,
    patch: Option<&ReadTransaction>,
    generation: &str,
) -> Result<()> {
    if let Some(patch) = patch {
        check_generation(patch, generation)?;
        let metadata = base.open_table(METADATA)?;
        let origin = metadata
            .get("generation")?
            .ok_or("missing base generation")?;
        check_base(patch, origin.value())?;
    } else {
        check_generation(base, generation)?;
    }
    Ok(())
}

pub struct BookStore {
    base: ReadOnlyDatabase,
    patch: Option<ReadOnlyDatabase>,
    directory: PathBuf,
    facets: RefCell<HashMap<Facet, Option<Postings>>>,
    wide_order: RefCell<Option<(String, WideOrder)>>,
    lookup: RefCell<Option<LookupIndex>>,
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
    Probe {
        #[serde(default)]
        capabilities: bool,
    },
    Rows {
        ids: Vec<u32>,
        fields: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    BookGroups {
        table: LookupTable,
        ids: Vec<u32>,
        lookup_generation: String,
    },
    Uids {
        uids: Vec<String>,
    },
    Scan {
        after: Option<u32>,
        limit: usize,
        fields: Option<Vec<String>>,
    },
    FacetLabels {
        table: Facet,
    },
    FacetBooks {
        table: Facet,
        rows: Vec<u32>,
        candidates: Option<Vec<u32>>,
    },
    BookOrder,
    WideSearch(WideSearch),
    Search {
        ids: Vec<u32>,
        terms: [Vec<[String; 2]>; 3],
        deleted: Option<i64>,
        source: Option<String>,
        #[serde(default)]
        filters: Vec<Filter>,
        #[serde(default)]
        copies: Copies,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum StoreResponse {
    Probe(bool),
    Capabilities {
        #[serde(rename = "advancedSearch")]
        advanced_search: bool,
        #[serde(rename = "catalogScan")]
        catalog_scan: bool,
        facets: bool,
        #[serde(rename = "wideSearch")]
        wide_search: bool,
    },
    Rows(Vec<Box<RawValue>>),
    Groups(Vec<BookGroup>),
    Page {
        after: Option<u32>,
        rows: Vec<Box<RawValue>>,
    },
    FacetLabels(Option<Vec<Vec<(u32, Label)>>>),
    Ids(Vec<u32>),
    Matches(Vec<Match>),
    Ranked(WideResult),
}

#[derive(Serialize)]
pub struct BookGroup {
    id: u32,
    name: String,
    books: Vec<Box<RawValue>>,
}

#[derive(Serialize)]
pub struct Match {
    id: u32,
    author: String,
    series: String,
    title: String,
    serno: f64,
    order: usize,
    score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    copy: Option<String>,
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

fn project(record: &[u8], fields: Option<&[String]>) -> Result<Box<RawValue>> {
    if let Some(fields) = fields {
        let mut row: inpx_reader::Record = serde_json::from_slice(record)?;
        row.retain(|key, _| fields.contains(key));
        Ok(serde_json::value::to_raw_value(&row)?)
    } else {
        Ok(serde_json::from_slice(record)?)
    }
}

impl BookStore {
    pub fn open(directory: &Path) -> Result<Self> {
        Self::open_with_cache(directory, READ_CACHE_BYTES)
    }

    pub fn open_low_memory(directory: &Path) -> Result<Self> {
        Self::open_with_cache(directory, REDUCED_CACHE_BYTES)
    }

    fn open_with_cache(directory: &Path, cache_bytes: usize) -> Result<Self> {
        let patch = directory.join(PATCH_FILE);
        Ok(Self {
            base: open_read(&directory.join(BASE_FILE), cache_bytes)?,
            patch: if patch.try_exists()? {
                Some(open_read(&patch, cache_bytes)?)
            } else {
                None
            },
            directory: directory.into(),
            facets: RefCell::new(HashMap::new()),
            wide_order: RefCell::new(None),
            lookup: RefCell::new(None),
        })
    }

    pub(crate) fn visit(&self, visitor: impl FnMut(u32, &[u8]) -> Result<()>) -> Result<()> {
        self.visit_rows(None, visitor)
    }

    fn visit_rows(
        &self,
        generation: Option<&str>,
        mut visitor: impl FnMut(u32, &[u8]) -> Result<()>,
    ) -> Result<()> {
        let base = self.base.begin_read()?;
        let patch = self
            .patch
            .as_ref()
            .map(ReadableDatabase::begin_read)
            .transpose()?;
        if let Some(generation) = generation {
            check_snapshot(&base, patch.as_ref(), generation)?;
        }
        let records = base.open_table(RECORDS)?;
        let updated = patch
            .as_ref()
            .map(|tx| tx.open_table(RECORDS))
            .transpose()?;
        wide_search::visit_rows(&records, updated.as_ref(), 0..=u32::MAX, &mut |id, data| {
            visitor(id, decode(data)?.0)
        })
    }

    pub fn count_files(&self, generation: &str) -> Result<FileTotals> {
        #[derive(Deserialize)]
        struct FileRow<'a> {
            #[serde(default, borrow)]
            folder: Cow<'a, str>,
            #[serde(default, borrow)]
            file: Cow<'a, str>,
            #[serde(default, borrow)]
            ext: Cow<'a, str>,
            del: Option<i64>,
        }
        let mut counts = FileCounter::new(&self.directory, true)?;
        self.visit_rows(Some(generation), |_, record| {
            let row: FileRow = serde_json::from_slice(record)?;
            counts.add(&row.folder, &row.file, &row.ext, row.del.unwrap_or(0) != 0)
        })?;
        counts.finish()
    }

    fn facet<T>(
        &self,
        table: Facet,
        read: impl FnOnce(Option<&Postings>) -> Result<T>,
    ) -> Result<T> {
        let mut facets = self.facets.borrow_mut();
        let index = match facets.entry(table) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(Postings::open(&self.directory, table).ok()),
        };
        read(index.as_ref())
    }

    pub fn query(&self, request: StoreRequest) -> Result<StoreResponse> {
        let base = self.base.begin_read()?;
        let patch = self
            .patch
            .as_ref()
            .map(ReadableDatabase::begin_read)
            .transpose()?;
        check_snapshot(&base, patch.as_ref(), &request.generation)?;
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
            StoreQuery::Probe { capabilities } => {
                if capabilities {
                    StoreResponse::Capabilities {
                        advanced_search: true,
                        catalog_scan: true,
                        facets: true,
                        wide_search: true,
                    }
                } else {
                    StoreResponse::Probe(true)
                }
            }
            StoreQuery::FacetLabels { table } => StoreResponse::FacetLabels(
                self.facet(table, |index| Ok(index.map(Postings::labels)))?,
            ),
            StoreQuery::FacetBooks {
                table,
                rows,
                candidates,
            } => StoreResponse::Ids(self.facet(table, |index| {
                index
                    .ok_or("facet index unavailable")?
                    .intersection(rows, candidates)
            })?),
            StoreQuery::BookOrder => StoreResponse::Ids(wide_search::source_order(
                &self.directory,
                &request.generation,
            )?),
            StoreQuery::WideSearch(query) => {
                let mut current = self.wide_order.borrow_mut();
                if current
                    .as_ref()
                    .is_none_or(|(key, _)| key != query.order_key())
                {
                    let key = query.order_key();
                    *current = Some((
                        key.into(),
                        WideOrder::open(&self.directory, key, &request.generation)?,
                    ));
                }
                StoreResponse::Ranked(wide_search::search(
                    &records,
                    updated.as_ref(),
                    &current.as_ref().unwrap().1,
                    query,
                )?)
            }
            StoreQuery::Rows { ids, fields } => {
                let mut rows = Vec::new();
                for id in ids {
                    if let Some(row) = read(id)?
                        && !row.value().is_empty()
                    {
                        let record = decode(row.value())?.0;
                        rows.push(project(record, fields.as_deref())?);
                    }
                }
                StoreResponse::Rows(rows)
            }
            StoreQuery::BookGroups {
                table,
                ids,
                lookup_generation,
            } => {
                let mut lookup = self.lookup.borrow_mut();
                if lookup.is_none() {
                    *lookup = Some(LookupIndex::open(&self.directory.join("lookup.redb"))?);
                }
                let postings = lookup
                    .as_ref()
                    .unwrap()
                    .postings(lookup_generation, table, ids)?;
                let mut groups = Vec::with_capacity(postings.len());
                for row in postings {
                    let mut books = Vec::with_capacity(row.book_ids.len());
                    for id in row.book_ids {
                        if let Some(book) = read(id)?
                            && !book.value().is_empty()
                        {
                            books.push(project(decode(book.value())?.0, None)?);
                        }
                    }
                    groups.push(BookGroup {
                        id: row.id,
                        name: row.name,
                        books,
                    });
                }
                StoreResponse::Groups(groups)
            }
            StoreQuery::Scan {
                after,
                limit,
                fields,
            } => {
                if !(1..=4096).contains(&limit) {
                    return Err("invalid catalogue scan batch size".into());
                }
                let range = (after.map_or(Unbounded, Excluded), Unbounded);
                let mut candidates = BTreeSet::new();
                for entry in records.range::<u32>(range)?.take(limit) {
                    candidates.insert(entry?.0.value());
                }
                if let Some(updated) = &updated {
                    for entry in updated.range::<u32>(range)?.take(limit) {
                        candidates.insert(entry?.0.value());
                    }
                }
                let mut rows = Vec::with_capacity(limit);
                let mut last = None;
                let mut count = 0;
                for id in candidates.into_iter().take(limit) {
                    count += 1;
                    last = Some(id);
                    if let Some(row) = read(id)?
                        && !row.value().is_empty()
                    {
                        rows.push(project(decode(row.value())?.0, fields.as_deref())?);
                    }
                }
                StoreResponse::Page {
                    after: if count == limit { last } else { None },
                    rows,
                }
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
                filters,
                copies,
            } => {
                let mut matches = HashMap::<String, Match>::new();
                for (order, id) in ids.into_iter().enumerate() {
                    let Some(row) = read(id)? else { continue };
                    if row.value().is_empty() {
                        continue;
                    }
                    let (record, search) = decode(row.value())?;
                    let full = if filters.is_empty() && copies == Copies::Physical {
                        None
                    } else {
                        let fields: inpx_reader::Record = serde_json::from_slice(record)?;
                        if !filters.iter().all(|filter| filter.matches(&fields)) {
                            continue;
                        }
                        Some(fields)
                    };
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
                    let mut candidate = Match {
                        id,
                        order,
                        score: fields.score,
                        author: book.author,
                        title: book.title,
                        series: book.series,
                        serno: book.serno,
                        copy: full
                            .as_ref()
                            .filter(|_| copies == Copies::Ranked)
                            .map(merged_key),
                    };
                    let key = if copies == Copies::Merge {
                        merged_key(full.as_ref().expect("complete row when merging copies"))
                    } else {
                        fields.physical
                    };
                    matches
                        .entry(key)
                        .and_modify(|old| {
                            if candidate.score > old.score
                                || candidate.score == old.score && candidate.id < old.id
                            {
                                candidate.order = old.order;
                                std::mem::swap(old, &mut candidate);
                            }
                        })
                        .or_insert(candidate);
                }
                StoreResponse::Matches(matches.into_values().collect())
            }
        })
    }
}
