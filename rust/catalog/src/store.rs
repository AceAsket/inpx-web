use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, Write};
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::OnceCell;
use redb::{
    AccessGuard, Database, ReadOnlyDatabase, ReadOnlyTable, ReadTransaction, ReadableDatabase,
    ReadableTable, Table, TableDefinition, WriteTransaction,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;

use crate::catalog_entity::{
    EntityBook, EntityPage, EntityPageRequest, SeriesVolume, SeriesVolumes, series_through,
};
use crate::catalog_files::{FileCounter, FileTotals};
use crate::catalog_query::{Copies, Filter, merged_key};
use crate::facets::{Facet, Label, Postings};
use crate::lookup::{LookupIndex, Table as LookupTable};
use crate::lookup_discovery::{BrowseFilter, SelectedBooks};
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

pub(crate) fn stage_patch(directory: &Path, previous: &Path) -> Result<bool> {
    let base = previous.join(BASE_FILE);
    let patch = previous.join(PATCH_FILE);
    let patch_size = match fs::metadata(&patch) {
        Ok(metadata) => Some(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(size) = patch_size
        && size > fs::metadata(&base)?.len() / 4
    {
        return Ok(false);
    }
    let target = directory.join(BASE_FILE);
    let linked = if fs::hard_link(&base, &target).is_ok() {
        match open_read(&target, REDUCED_CACHE_BYTES) {
            Ok(_) => true,
            Err(error)
                if error
                    .downcast_ref::<redb::DatabaseError>()
                    .is_some_and(|error| {
                        matches!(error, redb::DatabaseError::DatabaseAlreadyOpen)
                    }) =>
            {
                // Some mounted filesystems refuse a second reader of the same inode.
                fs::remove_file(&target)?;
                false
            }
            Err(error) => return Err(error),
        }
    } else {
        false
    };
    if !linked {
        fs::copy(&base, &target)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&target)?
            .sync_all()?;
    }
    if patch_size.is_some() {
        fs::copy(patch, directory.join(PATCH_FILE))?;
    }
    Ok(true)
}

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

fn compact_row<T: DeserializeOwned>(
    row: Option<AccessGuard<'_, &'static [u8]>>,
) -> Result<Option<T>> {
    let Some(row) = row else {
        return Ok(None);
    };
    let data = row.value();
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(decode(data)?.0)?))
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
        if let Some(old) = self.books.get(id)?
            && !old.value().is_empty()
        {
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
        self.changed.insert(id);
        Ok(())
    }

    pub fn add(
        &mut self,
        id: u32,
        uid: &str,
        record: &str,
        projection: &impl Serialize,
    ) -> Result<()> {
        if uid.is_empty() || uid.encode_utf16().count() > 100 {
            return Err("invalid book UID length".into());
        }
        let patch = self.original.is_some();
        if patch {
            self.replace(id)?;
        }
        self.row.clear();
        let data = record.as_bytes();
        self.row
            .extend_from_slice(&u32::try_from(data.len())?.to_le_bytes());
        self.row.extend_from_slice(data);
        serde_json::to_writer(&mut self.row, projection)?;
        if self.books.insert(id, self.row.as_slice())?.is_some() && !patch {
            return Err("duplicate book ID".into());
        }
        if !patch && self.uids.insert(uid, id)?.is_some() {
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
            writer.add(key.id, key.uid, record.get(), &projection)?;
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
    facets: [OnceCell<Option<Postings>>; Facet::Source as usize + 1],
    active_books: OnceCell<SelectedBooks>,
    wide_order: Mutex<Option<(String, Arc<WideOrder>)>>,
    lookup: OnceCell<LookupIndex>,
}

impl BookStore {
    pub fn read_cache_bytes(&self) -> usize {
        self.base.cache_stats().used_bytes()
            + self
                .patch
                .as_ref()
                .map_or(0, |db| db.cache_stats().used_bytes())
    }
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
    FacetSelection {
        groups: Vec<FacetRows>,
    },
    EntityRows(EntityRowsRequest),
    EntityPage(EntityPageRequest),
    SeriesVolumes(SeriesVolumesRequest),
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

#[derive(Deserialize)]
struct FacetRows {
    table: Facet,
    rows: Vec<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityRowsRequest {
    table: LookupTable,
    name_ids: Vec<u32>,
    lookup_generation: String,
    groups: Vec<FacetRows>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeriesVolumesRequest {
    name_ids: Vec<u32>,
    lookup_generation: String,
    target: String,
    numbers: HashMap<String, Option<f64>>,
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
        #[serde(rename = "facetSelection")]
        facet_selection: bool,
        #[serde(rename = "catalogueEntities")]
        catalogue_entities: bool,
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
    FacetSelection(BrowseFilter),
    EntityRows(Vec<EntityBook>),
    EntityPage(EntityPage),
    SeriesVolumes(SeriesVolumes),
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

impl Match {
    fn retain_best(mut self, key: String, matches: &mut HashMap<String, Match>) {
        matches
            .entry(key)
            .and_modify(|old| {
                if self.score > old.score || self.score == old.score && self.id < old.id {
                    self.order = old.order;
                    std::mem::swap(old, &mut self);
                }
            })
            .or_insert(self);
    }

    fn catalogue_order(&self, right: &Self) -> std::cmp::Ordering {
        self.author
            .cmp(&right.author)
            .then_with(|| self.series.is_empty().cmp(&right.series.is_empty()))
            .then_with(|| self.series.cmp(&right.series))
            .then_with(|| self.serno.total_cmp(&right.serno))
            .then_with(|| self.title.cmp(&right.title))
            .then_with(|| self.order.cmp(&right.order))
    }
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
    pub(crate) fn catalogue_rows(
        &self,
        generation: &str,
        ids: Vec<u32>,
    ) -> Result<Vec<inpx_reader::Record>> {
        let StoreResponse::Rows(rows) = self.query(StoreRequest {
            generation: generation.into(),
            query: StoreQuery::Rows { ids, fields: None },
        })?
        else {
            unreachable!("row lookup returns rows");
        };
        rows.into_iter()
            .map(|row| Ok(serde_json::from_str(row.get())?))
            .collect()
    }

    pub(crate) fn opds_ranked(
        &self,
        generation: &str,
        ids: Vec<u32>,
        field: &str,
        term: &str,
        limit: usize,
    ) -> Result<Vec<u32>> {
        if ids.is_empty() {
            return Ok(ids);
        }
        let StoreResponse::Matches(mut matches) = self.query(StoreRequest {
            generation: generation.into(),
            query: StoreQuery::Search {
                ids,
                terms: [vec![], vec![], vec![]],
                deleted: Some(0),
                source: None,
                filters: vec![Filter::Contains {
                    field: field.into(),
                    value: term.into(),
                    special: false,
                }],
                copies: Copies::Physical,
            },
        })?
        else {
            unreachable!("search returns ranked candidates");
        };
        matches.sort_unstable_by(Match::catalogue_order);
        Ok(matches
            .into_iter()
            .take(limit)
            .map(|book| book.id)
            .collect())
    }

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
            facets: Default::default(),
            active_books: OnceCell::new(),
            wide_order: Mutex::default(),
            lookup: OnceCell::new(),
        })
    }

    pub(crate) fn visit(&self, visitor: impl FnMut(u32, &[u8]) -> Result<()>) -> Result<()> {
        self.visit_rows(None, None, visitor)
    }

    pub(crate) fn visit_search_rows(
        &self,
        generation: &str,
        candidates: Option<&[u32]>,
        visitor: impl FnMut(u32, &[u8]) -> Result<()>,
    ) -> Result<()> {
        self.visit_rows(Some(generation), candidates, visitor)
    }

    fn visit_rows(
        &self,
        generation: Option<&str>,
        candidates: Option<&[u32]>,
        mut visitor: impl FnMut(u32, &[u8]) -> Result<()>,
    ) -> Result<()> {
        self.visit_stored_rows(generation, candidates, |id, data| {
            visitor(id, decode(data)?.0)
        })
    }

    fn visit_stored_rows(
        &self,
        generation: Option<&str>,
        candidates: Option<&[u32]>,
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
        if let Some(candidates) = candidates {
            for &id in candidates {
                let changed = updated
                    .as_ref()
                    .map(|table| table.get(id))
                    .transpose()?
                    .flatten();
                let row = match changed {
                    Some(row) => Some(row),
                    None => records.get(id)?,
                };
                if let Some(row) = row
                    && !row.value().is_empty()
                {
                    visitor(id, row.value())?;
                }
            }
            return Ok(());
        }
        wide_search::visit_rows(&records, updated.as_ref(), 0..=u32::MAX, &mut visitor)
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
        self.visit_rows(Some(generation), None, |_, record| {
            let row: FileRow = serde_json::from_slice(record)?;
            counts.add(&row.folder, &row.file, &row.ext, row.del.unwrap_or(0) != 0)
        })?;
        counts.finish()
    }

    pub(crate) fn facet<T>(
        &self,
        table: Facet,
        read: impl FnOnce(Option<&Postings>) -> Result<T>,
    ) -> Result<T> {
        let index =
            self.facets[table as usize].get_or_init(|| Postings::open(&self.directory, table).ok());
        read(index.as_ref())
    }

    fn facet_selection(&self, groups: Vec<FacetRows>) -> Result<SelectedBooks> {
        if !(1..=5).contains(&groups.len()) {
            return Err("invalid catalogue facet selection".into());
        }
        let mut groups = groups.into_iter();
        let select = |group: FacetRows, previous: Option<&SelectedBooks>| {
            self.facet(group.table, |index| {
                let rows = index
                    .ok_or("facet index unavailable")?
                    .book_lists(&group.rows)?;
                Ok(SelectedBooks::from_postings(rows, previous))
            })
        };
        let first = select(groups.next().ok_or("missing facet group")?, None)?;
        groups.try_fold(first, |selection, group| select(group, Some(&selection)))
    }

    pub(crate) fn select_facet(
        &self,
        facet: Facet,
        previous: Option<&SelectedBooks>,
        matches: impl Fn(&Label) -> bool,
    ) -> Result<SelectedBooks> {
        self.facet(facet, |index| {
            let index = index.ok_or("facet index unavailable")?;
            Ok(SelectedBooks::from_postings(
                index.matching(matches),
                previous,
            ))
        })
    }

    pub(crate) fn opds_books(&self, genres: &[&str]) -> Result<Cow<'_, SelectedBooks>> {
        let active = self.active_books.get_or_try_init(|| {
            self.facet(Facet::Del, |index| {
                let index = index.ok_or("missing catalogue deletion index")?;
                Ok(SelectedBooks::from_postings(
                    index.matching(|label| label == &Label::Number(0)),
                    None,
                ))
            })
        })?;
        if genres.is_empty() {
            return Ok(Cow::Borrowed(active));
        }
        self.facet(Facet::Genre, |index| {
            let index = index.ok_or("missing catalogue genre index")?;
            Ok(Cow::Owned(SelectedBooks::from_postings(
                index.matching(
                    |label| matches!(label, Label::Text(genre) if genres.contains(&genre.as_str())),
                ),
                Some(active),
            )))
        })
    }

    pub(crate) fn opds_genres(&self) -> Result<Vec<String>> {
        self.facet_text(Facet::Genre)
    }

    pub(crate) fn facet_text(&self, facet: Facet) -> Result<Vec<String>> {
        self.facet(facet, |index| {
            let mut labels: Vec<_> = index
                .ok_or("missing catalogue facet index")?
                .labels()
                .into_iter()
                .flatten()
                .filter_map(|(_, label)| match label {
                    Label::Text(genre) if !genre.is_empty() && genre != "?" => Some(genre),
                    _ => None,
                })
                .collect();
            labels.sort();
            labels.dedup();
            Ok(labels)
        })
    }

    pub(crate) fn browser_search_order(
        &self,
        generation: &str,
        candidates: Option<&[u32]>,
        matches: impl Fn(&[u8], Option<i64>, &str) -> Result<bool>,
        merge: bool,
    ) -> Result<Vec<u32>> {
        #[derive(Deserialize)]
        struct Rank {
            score: f64,
            physical: String,
        }
        let mut ranked = HashMap::new();
        let mut order = 0;
        self.visit_stored_rows(Some(generation), candidates, |id, bytes| {
            let (record, projection) = decode(bytes)?;
            let row: SearchRow = serde_json::from_slice(record)?;
            if !matches(record, row.del, &row.source)? {
                return Ok(());
            }
            let rank: Rank = serde_json::from_slice(projection)?;
            let key = if merge {
                crate::catalog_query::merged_key_from_record(record)?
            } else {
                rank.physical
            };
            Match {
                id,
                order,
                score: rank.score,
                author: row.author,
                title: row.title,
                series: row.series,
                serno: row.serno,
                copy: None,
            }
            .retain_best(key, &mut ranked);
            order += 1;
            Ok(())
        })?;
        let mut candidates: Vec<_> = ranked.into_values().collect();
        candidates.sort_unstable_by(Match::catalogue_order);
        Ok(candidates.into_iter().map(|book| book.id).collect())
    }

    pub(crate) fn order_shelf_volumes(&self, generation: &str, ids: Vec<u32>) -> Result<Vec<u32>> {
        let mut candidates = self.rank_shelf_ids(generation, ids, false)?;
        candidates.sort_unstable_by(|left, right| {
            left.serno
                .total_cmp(&right.serno)
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(candidates.into_iter().map(|book| book.id).collect())
    }

    fn rank_shelf_ids(&self, generation: &str, ids: Vec<u32>, merge: bool) -> Result<Vec<Match>> {
        let StoreResponse::Matches(candidates) = self.query(StoreRequest {
            generation: generation.into(),
            query: StoreQuery::Search {
                ids,
                terms: [vec![], vec![], vec![]],
                deleted: None,
                source: None,
                filters: Vec::new(),
                copies: if merge {
                    Copies::Merge
                } else {
                    Copies::Physical
                },
            },
        })?
        else {
            unreachable!("book ranking returns candidates");
        };
        Ok(candidates)
    }

    fn with_lookup<T>(&self, read: impl FnOnce(&LookupIndex) -> Result<T>) -> Result<T> {
        let lookup = self
            .lookup
            .get_or_try_init(|| LookupIndex::open(&self.directory.join("lookup.redb")))?;
        read(lookup)
    }

    fn entity_rows(
        &self,
        query: EntityRowsRequest,
        mut read: impl FnMut(u32) -> Result<Option<EntityBook>>,
    ) -> Result<Vec<EntityBook>> {
        if !matches!(query.table, LookupTable::Author | LookupTable::Series) {
            return Err("invalid catalogue entity table".into());
        }
        let ids = self.with_lookup(|lookup| {
            lookup.entity_book_ids(&query.lookup_generation, query.table, query.name_ids, false)
        })?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let selected = (!query.groups.is_empty())
            .then(|| self.facet_selection(query.groups))
            .transpose()?;
        let mut rows = Vec::new();
        for id in ids {
            if selected.as_ref().is_none_or(|scope| scope.contains(id))
                && let Some(row) = read(id)?
                && row.del.unwrap_or_default() == 0
            {
                rows.push(row);
            }
        }
        Ok(rows)
    }

    fn series_volumes(
        &self,
        query: SeriesVolumesRequest,
        mut read: impl FnMut(u32) -> Result<Option<SeriesVolume>>,
    ) -> Result<SeriesVolumes> {
        let ids = self.with_lookup(|lookup| {
            lookup.entity_book_ids(
                &query.lookup_generation,
                LookupTable::Series,
                query.name_ids,
                true,
            )
        })?;
        let mut books = Vec::<SeriesVolume>::with_capacity(ids.len());
        for id in ids {
            if let Some(book) = read(id)? {
                books.push(book);
            }
        }
        Ok(series_through(books, &query.target, |uid| {
            query.numbers.get(uid).copied()
        }))
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
                        facet_selection: true,
                        catalogue_entities: true,
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
            StoreQuery::FacetSelection { groups } => {
                StoreResponse::FacetSelection(self.facet_selection(groups)?.encode())
            }
            StoreQuery::EntityRows(query) => {
                StoreResponse::EntityRows(self.entity_rows(query, |id| compact_row(read(id)?))?)
            }
            StoreQuery::EntityPage(query) => StoreResponse::EntityPage(query.prepare(|id| {
                let Some(row) = read(id)? else {
                    return Ok(None);
                };
                let data = row.value();
                if data.is_empty() {
                    return Ok(None);
                }
                Ok(Some(project(decode(data)?.0, None)?))
            })?),
            StoreQuery::SeriesVolumes(query) => StoreResponse::SeriesVolumes(
                self.series_volumes(query, |id| compact_row(read(id)?))?,
            ),
            StoreQuery::BookOrder => StoreResponse::Ids(wide_search::source_order(
                &self.directory,
                &request.generation,
            )?),
            StoreQuery::WideSearch(query) => {
                let order = {
                    let mut current = self.wide_order.lock().expect("wide search order");
                    let key = query.order_key();
                    match current.as_ref() {
                        Some((cached, order)) if cached == key => order.clone(),
                        _ => {
                            let order = Arc::new(WideOrder::open(
                                &self.directory,
                                key,
                                &request.generation,
                            )?);
                            *current = Some((key.into(), order.clone()));
                            order
                        }
                    }
                };
                StoreResponse::Ranked(wide_search::search(
                    &records,
                    updated.as_ref(),
                    &order,
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
                let postings =
                    self.with_lookup(|lookup| lookup.postings(lookup_generation, table, ids))?;
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
                    let candidate = Match {
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
                    candidate.retain_best(key, &mut matches);
                }
                StoreResponse::Matches(matches.into_values().collect())
            }
        })
    }
}
