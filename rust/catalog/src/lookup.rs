use std::collections::{HashMap, HashSet, hash_map::Entry as MapEntry};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{Engine, engine::general_purpose::STANDARD};
use once_cell::sync::OnceCell;
use redb::{
    Database, ReadOnlyDatabase, ReadTransaction, ReadableDatabase, ReadableTable, TableDefinition,
};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::book_maps::BookIds;
use crate::index::{check_generation, publish_with_cache};
use crate::jemba_identity::BookRows;
use crate::lookup_discovery::{BrowseFilter, BrowseResult, BrowseResults, SelectedBooks};
use crate::lookup_order::{
    LabelOrder, NameRunDirectory, NameSelection, SuggestionWindows, load_order,
};

const POSTINGS: TableDefinition<(u8, u32), &[u8]> = TableDefinition::new("lookup_v1");
const LABEL_ORDER: TableDefinition<u8, &[u8]> = TableDefinition::new("lookup_label_order_v1");
const LABEL_DELETIONS: TableDefinition<(u8, u32), u32> =
    TableDefinition::new("lookup_deleted_count_v1");

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Table {
    Author,
    Series,
    Title,
    Word,
}

impl Table {
    pub(crate) const ALL: [Self; 4] = [Self::Author, Self::Series, Self::Title, Self::Word];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Series => "series",
            Self::Title => "title",
            Self::Word => "word",
        }
    }
    fn key(self, id: u32) -> (u8, u32) {
        let table = match self {
            Self::Author => 0,
            Self::Series => 1,
            Self::Title => 2,
            Self::Word => 3,
        };
        (table, id)
    }
}

pub fn seal_lookup(path: &Path, generation: &str) -> Result<usize> {
    let parent = path.parent().ok_or("missing catalogue directory")?;
    let database = Database::builder().open(path)?;
    check_generation(&database.begin_read()?, generation)?;
    let tx = database.begin_write()?;
    let mut count = 0;
    {
        let mut orders = tx.open_table(LABEL_ORDER)?;
        for table in Table::ALL {
            if let Ok(order) = load_order(&parent.join(table.name())) {
                let data = serde_json::to_vec(&order)?;
                orders.insert(table.key(0).0, data.as_slice())?;
                count += 1;
            }
        }
    }
    tx.commit()?;
    Ok(count)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Posting {
    pub(crate) table: Table,
    pub(crate) id: u32,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) value: Option<String>,
    #[serde(default)]
    pub(crate) count: u32,
    #[serde(default)]
    pub(crate) deleted: Option<u32>,
    #[serde(default)]
    pub(crate) omit_from_book_map: bool,
    pub(crate) book_ids: Vec<u32>,
}

pub fn build_lookup(
    path: &Path,
    generation: &str,
    expected: u64,
    book_maps: bool,
    rows: impl IntoIterator<Item = Result<Posting>>,
) -> Result<u64> {
    build_lookup_with_cache(path, generation, expected, book_maps, false, rows)
}

pub fn build_lookup_with_cache(
    path: &Path,
    generation: &str,
    expected: u64,
    book_maps: bool,
    low_memory: bool,
    rows: impl IntoIterator<Item = Result<Posting>>,
) -> Result<u64> {
    publish_with_cache(path, generation, low_memory, |transaction| {
        let mut data = transaction.open_table(POSTINGS)?;
        let mut deletions = transaction.open_table(LABEL_DELETIONS)?;
        let mut maps: Option<[BookIds; 3]> = book_maps.then(Default::default);
        let mut labels: [Vec<(u32, String)>; 4] = Default::default();
        let mut count = 0;
        let mut bytes = Vec::new();
        for row in rows {
            let row = row?;
            count += 1;
            if row.value.is_some() && row.omit_from_book_map {
                continue;
            }
            bytes.clear();
            bytes.extend_from_slice(&row.count.to_le_bytes());
            bytes.extend_from_slice(&u32::try_from(row.name.len())?.to_le_bytes());
            bytes.extend_from_slice(row.name.as_bytes());
            let key = row.table.key(row.id);
            if let Some(value) = row.value
                && !row.omit_from_book_map
            {
                labels[key.0 as usize].push((row.id, value));
            }
            if let Some(deleted) = row.deleted {
                deletions.insert(key, deleted)?;
            }
            if let Some(maps) = &mut maps
                && !row.omit_from_book_map
                && let Some(map) = maps.get_mut(key.0 as usize)
            {
                map.add(row.id, &row.book_ids)?;
            }
            for id in row.book_ids {
                bytes.extend_from_slice(&id.to_le_bytes());
            }
            if data.insert(key, bytes.as_slice())?.is_some() {
                return Err(format!("duplicate lookup row {}", row.id).into());
            }
        }
        if count != expected {
            return Err(
                format!("incomplete lookup: expected {expected} rows, read {count}").into(),
            );
        }
        let mut orders = transaction.open_table(LABEL_ORDER)?;
        let ordered = expected == 0 || labels.iter().any(|labels| !labels.is_empty());
        for (table, labels) in labels.into_iter().enumerate() {
            if ordered {
                let data = serde_json::to_vec(&LabelOrder::sorted(labels))?;
                orders.insert(table as u8, data.as_slice())?;
            }
        }
        if let Some(maps) = maps {
            for (map, name) in maps
                .iter()
                .zip(["author_id.map", "series_id.map", "title_id.map"])
            {
                map.save(&path.with_file_name(name))?;
            }
        }
        Ok(count)
    })
}

struct Entry<'a> {
    count: u32,
    name: &'a str,
    books: &'a [[u8; 4]],
}

impl<'a> Entry<'a> {
    fn decode(bytes: &'a [u8]) -> Result<Self> {
        let (header, tail) = bytes
            .split_first_chunk::<8>()
            .ok_or("invalid lookup header")?;
        let count = u32::from_le_bytes(header[..4].try_into()?);
        let length = u32::from_le_bytes(header[4..].try_into()?) as usize;
        let (name, books) = tail
            .split_at_checked(length)
            .ok_or("invalid lookup label")?;
        let (books, extra) = books.as_chunks::<4>();
        if !extra.is_empty() {
            return Err("invalid lookup postings".into());
        }
        Ok(Self {
            count,
            name: std::str::from_utf8(name)?,
            books,
        })
    }

    fn sample(&self) -> Vec<u32> {
        let count = self.books.len().min(4);
        (0..count)
            .map(|index| {
                u32::from_le_bytes(self.books[index * (self.books.len() - 1) / (count - 1).max(1)])
            })
            .collect()
    }
}

#[derive(Deserialize)]
pub struct LookupRequest {
    pub generation: String,
    #[serde(flatten)]
    pub query: LookupQuery,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum LookupQuery {
    Probe {
        #[serde(default)]
        capabilities: bool,
    },
    #[serde(rename = "nameDirectory")]
    NameDirectory {
        table: Table,
    },
    #[serde(rename = "nameSlices")]
    NameSlices {
        table: Table,
        windows: Vec<[usize; 3]>,
    },
    #[serde(rename = "selectNames")]
    SelectNames {
        table: Table,
        selection: NameSelection,
    },
    #[serde(rename = "selectNameBooks")]
    SelectNameBooks {
        table: Table,
        selections: Vec<NameSelection>,
    },
    #[serde(rename = "browseNames")]
    BrowseNames {
        table: Table,
        prefix: String,
        selection: NameSelection,
        selected: Option<BrowseFilter>,
    },
    #[serde(rename = "suggestSamples")]
    SuggestSamples {
        table: Table,
        limit: usize,
        queries: Vec<SuggestionWindows>,
    },
    Books {
        table: Table,
        groups: Vec<Vec<u32>>,
    },
    Sample {
        table: Table,
        ids: Vec<u32>,
    },
    Labels {
        table: Table,
        ids: Vec<u32>,
    },
    Order {
        table: Table,
    },
    Postings {
        table: Table,
        ids: Vec<u32>,
    },
    #[serde(rename = "nameRows")]
    NameRows {
        table: Table,
        ids: Vec<u32>,
    },
    #[serde(rename = "opdsGroups")]
    OpdsGroups {
        table: Table,
        ids: String,
        depth: u32,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub(crate) id: u32,
    pub(crate) name: String,
    pub(crate) count: u32,
    pub(crate) book_ids: Vec<u32>,
    pub(crate) complete: bool,
}

#[derive(Serialize)]
pub struct SuggestionSamples {
    pub(crate) rows: Vec<Sample>,
    pub(crate) limited: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum LookupResult {
    Probe(bool),
    Capabilities {
        #[serde(rename = "nameRanges")]
        name_ranges: bool,
        #[serde(rename = "nameBrowse")]
        name_browse: bool,
        #[serde(rename = "nameSuggestions")]
        name_suggestions: bool,
    },
    NameDirectory(Option<Vec<NameRunDirectory>>),
    NameSlices(Option<Vec<Vec<String>>>),
    NameIds(Option<Vec<u32>>),
    Browse(Option<BrowseResult>),
    SuggestionSamples(Option<SuggestionSamples>),
    Books(Vec<u32>),
    Samples(Vec<Sample>),
    Labels(Vec<String>),
    Order(Option<LabelOrder>),
    Postings(Vec<PostingRow>),
    NameRows(Vec<NameRow>),
    OpdsGroups(Vec<OpdsGroup>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsGroup {
    id: u32,
    name: String,
    value: Vec<u16>,
    count: u64,
    book_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostingRow {
    pub(crate) id: u32,
    pub(crate) name: String,
    pub(crate) book_ids: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameRow {
    id: u32,
    name: String,
    book_count: u32,
    book_del_count: u32,
}

#[derive(Deserialize)]
struct OldNameCount {
    #[serde(rename = "bookDelCount")]
    deleted: u32,
}

pub struct LookupIndex {
    db: ReadOnlyDatabase,
    directory: PathBuf,
    old_counts: Mutex<HashMap<Table, HashMap<u32, u32>>>,
    orders: [OnceCell<Option<LabelOrder>>; Table::ALL.len()],
}

impl LookupIndex {
    pub(crate) fn browser_label(
        &self,
        generation: &str,
        table: Table,
        id: u32,
    ) -> Result<Option<String>> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, generation)?;
        let data = transaction.open_table(POSTINGS)?;
        data.get(table.key(id))?
            .map(|row| Ok(Entry::decode(row.value())?.name.to_owned()))
            .transpose()
    }

    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            db: Database::builder()
                .set_cache_size(32 * 1024 * 1024)
                .open_read_only(path)?,
            directory: path.parent().unwrap_or_else(|| Path::new(".")).into(),
            old_counts: Mutex::default(),
            orders: Default::default(),
        })
    }

    fn with_order<T>(
        &self,
        transaction: &ReadTransaction,
        table: Table,
        read: impl FnOnce(Option<&LabelOrder>) -> Result<T>,
    ) -> Result<T> {
        let key = table.key(0).0;
        let order = self.orders[key as usize].get_or_try_init(|| -> Result<_> {
            let persisted = match transaction.open_table(LABEL_ORDER) {
                Ok(data) => data
                    .get(key)?
                    .map(|row| serde_json::from_slice(row.value()))
                    .transpose()?,
                Err(redb::TableError::TableDoesNotExist(_)) => None,
                Err(error) => return Err(error.into()),
            };
            Ok(persisted.or_else(|| load_order(&self.directory.join(table.name())).ok()))
        })?;
        read(order.as_ref())
    }

    pub(crate) fn postings(
        &self,
        generation: String,
        table: Table,
        ids: Vec<u32>,
    ) -> Result<Vec<PostingRow>> {
        match self.query(LookupRequest {
            generation,
            query: LookupQuery::Postings { table, ids },
        })? {
            LookupResult::Postings(rows) => Ok(rows),
            _ => unreachable!("posting query yields posting rows"),
        }
    }

    pub(crate) fn entity_book_ids(
        &self,
        generation: &str,
        table: Table,
        names: Vec<u32>,
        first_name_only: bool,
    ) -> Result<Vec<u32>> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, generation)?;
        let data = transaction.open_table(POSTINGS)?;
        if first_name_only {
            let Some(&name) = names.first() else {
                return Ok(Vec::new());
            };
            let Some(row) = data.get(table.key(name))? else {
                return Ok(Vec::new());
            };
            Ok(Entry::decode(row.value())?
                .books
                .iter()
                .copied()
                .map(u32::from_le_bytes)
                .collect())
        } else {
            book_ids(&data, table, vec![names])
        }
    }

    pub(crate) fn visit_names(
        &self,
        generation: &str,
        table: Table,
        matches: impl Fn(&str) -> bool,
        visit: impl FnMut(u32, &str, &str, u32, &[[u8; 4]]) -> Result<()>,
    ) -> Result<()> {
        self.visit_name_candidates(generation, table, &[], matches, visit)
    }

    pub(crate) fn browser_candidates(
        &self,
        generation: &str,
        table: Table,
        prefixes: &[&str],
        matches: impl Fn(&str) -> bool,
    ) -> Result<HashSet<u32>> {
        let mut books = HashSet::new();
        self.visit_name_candidates(generation, table, prefixes, matches, |_, _, _, _, ids| {
            books.extend(ids.iter().copied().map(u32::from_le_bytes));
            Ok(())
        })?;
        Ok(books)
    }

    pub(crate) fn browser_samples(
        &self,
        generation: &str,
        table: Table,
        keys: &[String],
        prefix: bool,
        limit: usize,
    ) -> Result<SuggestionSamples> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, generation)?;
        let data = transaction.open_table(POSTINGS)?;
        self.with_order(&transaction, table, |order| {
            let Some(order) = order else {
                return Ok(SuggestionSamples {
                    rows: Vec::new(),
                    limited: true,
                });
            };
            let (ids, limited) = order.browser_samples(keys, prefix, limit)?;
            Ok(SuggestionSamples {
                rows: sample_rows(&data, table, ids)?,
                limited,
            })
        })
    }

    pub(crate) fn visit_name_candidates(
        &self,
        generation: &str,
        table: Table,
        prefixes: &[&str],
        matches: impl Fn(&str) -> bool,
        mut visit: impl FnMut(u32, &str, &str, u32, &[[u8; 4]]) -> Result<()>,
    ) -> Result<()> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, generation)?;
        let data = transaction.open_table(POSTINGS)?;
        self.with_order(&transaction, table, |order| {
            let order = order.ok_or("missing catalogue name order")?;
            let mut read = |(id, label): &(u32, String)| {
                if matches(label)
                    && let Some(raw) = data.get(table.key(*id))?
                {
                    let row = Entry::decode(raw.value())?;
                    visit(*id, label, row.name, row.count, row.books)?;
                }
                Ok(())
            };
            if prefixes.is_empty() {
                order.visit_selected(NameSelection::All, read)?;
            } else {
                for prefix in prefixes {
                    order.visit_prefix(prefix, &mut read)?;
                }
            }
            Ok(())
        })
    }

    fn old_deleted(&self, table: Table, id: u32) -> Result<u32> {
        let mut counts = self.old_counts.lock().expect("legacy lookup counts");
        let counts = match counts.entry(table) {
            MapEntry::Occupied(entry) => entry.into_mut(),
            MapEntry::Vacant(entry) => {
                let directory = self.directory.join(table.name());
                let rows = BookRows::open(&directory)?;
                let mut counts = HashMap::with_capacity(rows.count);
                rows.visit::<OldNameCount>(|id, row| {
                    counts.insert(id, row.deleted);
                    Ok(())
                })?;
                entry.insert(counts)
            }
        };
        counts
            .get(&id)
            .copied()
            .ok_or_else(|| "missing name row count".into())
    }

    pub fn query(&self, request: LookupRequest) -> Result<LookupResult> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, &request.generation)?;
        let data = transaction.open_table(POSTINGS)?;
        match request.query {
            LookupQuery::Probe { capabilities: true } => Ok(LookupResult::Capabilities {
                name_ranges: true,
                name_browse: true,
                name_suggestions: true,
            }),
            LookupQuery::Probe {
                capabilities: false,
            } => Ok(LookupResult::Probe(true)),
            LookupQuery::NameDirectory { table } => self.with_order(&transaction, table, |order| {
                Ok(LookupResult::NameDirectory(
                    order.map(LabelOrder::directory).transpose()?,
                ))
            }),
            LookupQuery::NameSlices { table, windows } => {
                self.with_order(&transaction, table, |order| {
                    Ok(LookupResult::NameSlices(
                        order.map(|order| order.slices(windows)).transpose()?,
                    ))
                })
            }
            LookupQuery::SelectNames { table, selection } => {
                self.with_order(&transaction, table, |order| {
                    Ok(LookupResult::NameIds(
                        order.map(|order| order.select(selection)).transpose()?,
                    ))
                })
            }
            LookupQuery::SelectNameBooks { table, selections } => {
                self.with_order(&transaction, table, |order| {
                    let Some(order) = order else {
                        return Ok(LookupResult::NameIds(None));
                    };
                    let groups = selections
                        .into_iter()
                        .map(|selection| order.select(selection))
                        .collect::<Result<Vec<_>>>()?;
                    Ok(LookupResult::NameIds(Some(book_ids(&data, table, groups)?)))
                })
            }
            LookupQuery::BrowseNames {
                table,
                prefix,
                selection,
                selected,
            } => {
                if !matches!(table, Table::Author | Table::Series) {
                    return Err("invalid catalogue browse table".into());
                }
                let selected = selected.map(BrowseFilter::decode).transpose()?;
                if selected.as_ref().is_some_and(SelectedBooks::is_empty) {
                    return Ok(LookupResult::Browse(Some(BrowseResult::default())));
                }
                self.with_order(&transaction, table, |order| {
                    let Some(order) = order else {
                        return Ok(LookupResult::Browse(None));
                    };
                    let mut results = BrowseResults::default();
                    order.visit_selected(selection, |(id, label)| {
                        if *id == 0 || label == "?" {
                            return Ok(());
                        }
                        let Some(suffix) = label.strip_prefix(&prefix) else {
                            return Ok(());
                        };
                        let Some(raw) = data.get(table.key(*id))? else {
                            return Ok(());
                        };
                        let row = Entry::decode(raw.value())?;
                        let count = match &selected {
                            Some(selected) => row
                                .books
                                .iter()
                                .filter(|bytes| selected.contains(u32::from_le_bytes(**bytes)))
                                .count() as u64,
                            None => u64::from(row.count),
                        };
                        results.add(suffix, row.name, count);
                        Ok(())
                    })?;
                    Ok(LookupResult::Browse(Some(results.finish(&prefix))))
                })
            }
            LookupQuery::SuggestSamples {
                table,
                limit,
                queries,
            } => {
                if !(1..=32).contains(&limit) {
                    return Err("invalid catalogue suggestion limit".into());
                }
                self.with_order(&transaction, table, |order| {
                    let Some(order) = order else {
                        return Ok(LookupResult::SuggestionSamples(None));
                    };
                    let Some((ids, limited)) = order.suggestions(queries, limit)? else {
                        return Ok(LookupResult::SuggestionSamples(None));
                    };
                    let rows = sample_rows(&data, table, ids)?;
                    Ok(LookupResult::SuggestionSamples(Some(SuggestionSamples {
                        rows,
                        limited,
                    })))
                })
            }
            LookupQuery::Books { table, groups } => {
                Ok(LookupResult::Books(book_ids(&data, table, groups)?))
            }
            LookupQuery::Sample { table, ids } => {
                Ok(LookupResult::Samples(sample_rows(&data, table, ids)?))
            }
            LookupQuery::Labels { table, ids } => {
                if ids.len() > 32_768 {
                    return Err("lookup labels exceed row limit".into());
                }
                let mut labels = Vec::with_capacity(ids.len());
                for id in ids {
                    let row = data.get(table.key(id))?.ok_or("missing lookup row")?;
                    labels.push(Entry::decode(row.value())?.name.to_owned());
                }
                Ok(LookupResult::Labels(labels))
            }
            LookupQuery::Order { table } => self.with_order(&transaction, table, |order| {
                Ok(LookupResult::Order(order.cloned()))
            }),
            LookupQuery::Postings { table, ids } => {
                if ids.len() > 1024 {
                    return Err("lookup postings exceed row limit".into());
                }
                let mut rows = Vec::with_capacity(ids.len());
                for id in ids {
                    let Some(raw) = data.get(table.key(id))? else {
                        continue;
                    };
                    let row = Entry::decode(raw.value())?;
                    rows.push(PostingRow {
                        id,
                        name: row.name.into(),
                        book_ids: row.books.iter().copied().map(u32::from_le_bytes).collect(),
                    });
                }
                Ok(LookupResult::Postings(rows))
            }
            LookupQuery::NameRows { table, ids } => {
                if ids.len() > 1024 || table == Table::Word {
                    return Err("invalid catalogue name rows request".into());
                }
                let deletions = match transaction.open_table(LABEL_DELETIONS) {
                    Ok(table) => Some(table),
                    Err(redb::TableError::TableDoesNotExist(_)) => None,
                    Err(error) => return Err(error.into()),
                };
                let mut rows = Vec::with_capacity(ids.len());
                for id in ids {
                    let key = table.key(id);
                    let Some(record) = data.get(key)? else {
                        continue;
                    };
                    let row = Entry::decode(record.value())?;
                    let stored = deletions
                        .as_ref()
                        .map(|table| table.get(key))
                        .transpose()?
                        .flatten();
                    let book_del_count = match stored {
                        Some(value) => value.value(),
                        None => self.old_deleted(table, id)?,
                    };
                    rows.push(NameRow {
                        id,
                        name: row.name.into(),
                        book_count: row.count,
                        book_del_count,
                    });
                }
                Ok(LookupResult::NameRows(rows))
            }
            LookupQuery::OpdsGroups { table, ids, depth } => Ok(LookupResult::OpdsGroups(
                opds_groups(&data, table, &ids, depth as usize)?,
            )),
        }
    }
}

fn sample_rows(
    data: &impl ReadableTable<(u8, u32), &'static [u8]>,
    table: Table,
    ids: Vec<u32>,
) -> Result<Vec<Sample>> {
    if ids.len() > 32 {
        return Err("lookup sample exceeds row limit".into());
    }
    ids.into_iter()
        .map(|id| {
            let row = data.get(table.key(id))?.ok_or("missing lookup row")?;
            let entry = Entry::decode(row.value())?;
            Ok(Sample {
                id,
                name: entry.name.to_owned(),
                count: entry.count,
                book_ids: entry.sample(),
                complete: entry.books.len() <= 4,
            })
        })
        .collect()
}

fn opds_groups(
    data: &impl ReadableTable<(u8, u32), &'static [u8]>,
    table: Table,
    encoded: &str,
    depth: usize,
) -> Result<Vec<OpdsGroup>> {
    let bytes = STANDARD.decode(encoded)?;
    let (keys, tail) = bytes.as_chunks::<4>();
    if table == Table::Word || !tail.is_empty() || keys.len() > 262_144 {
        return Err("invalid OPDS group request".into());
    }
    let mut groups = HashMap::<Vec<u16>, OpdsGroup>::new();
    let mut prefix = Vec::new();
    for &key in keys {
        let id = u32::from_le_bytes(key);
        let Some(row) = data.get(table.key(id))? else {
            continue;
        };
        let row = Entry::decode(row.value())?;
        prefix.clear();
        prefix.extend(
            crate::catalog_text::lower(row.name)
                .encode_utf16()
                .take(depth),
        );
        if let Some(group) = groups.get_mut(prefix.as_slice()) {
            group.count += 1;
            group.book_count += u64::from(row.count);
        } else {
            groups.insert(
                prefix.clone(),
                OpdsGroup {
                    id,
                    name: row.name.into(),
                    value: Vec::new(),
                    count: 1,
                    book_count: u64::from(row.count),
                },
            );
        }
    }
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(value, mut group)| {
            group.value = value;
            group
        })
        .collect();
    rows.sort_unstable_by_key(|group| group.id);
    Ok(rows)
}

// Preserve the first group's insertion order while intersecting the union for
// each term. The existing search engine uses that order for candidate ties.
fn book_ids(
    data: &impl ReadableTable<(u8, u32), &'static [u8]>,
    table: Table,
    groups: Vec<Vec<u32>>,
) -> Result<Vec<u32>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for (position, group) in groups.into_iter().enumerate() {
        seen.clear();
        for id in group {
            let row = data.get(table.key(id))?.ok_or("missing lookup row")?;
            for bytes in Entry::decode(row.value())?.books {
                let book = u32::from_le_bytes(*bytes);
                if seen.insert(book) && position == 0 {
                    result.push(book);
                }
            }
        }
        if position != 0 {
            result.retain(|id| seen.contains(id));
        }
        if result.is_empty() {
            break;
        }
    }
    Ok(result)
}
