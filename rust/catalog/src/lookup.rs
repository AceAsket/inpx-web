use std::collections::HashSet;
use std::path::Path;

use redb::{Database, ReadOnlyDatabase, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::book_maps::BookIds;
use crate::index::{check_generation, publish};

const POSTINGS: TableDefinition<(u8, u32), &[u8]> = TableDefinition::new("lookup_v1");

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Table {
    Author,
    Series,
    Title,
    Word,
}

impl Table {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Posting {
    table: Table,
    id: u32,
    name: String,
    #[serde(default)]
    count: u32,
    #[serde(default)]
    omit_from_book_map: bool,
    book_ids: Vec<u32>,
}

pub fn build_lookup(
    path: &Path,
    generation: &str,
    expected: u64,
    book_maps: bool,
    rows: impl IntoIterator<Item = Result<Posting>>,
) -> Result<u64> {
    publish(path, generation, |transaction| {
        let mut data = transaction.open_table(POSTINGS)?;
        let mut maps: Option<[BookIds; 3]> = book_maps.then(Default::default);
        let mut count = 0;
        let mut bytes = Vec::new();
        for row in rows {
            let row = row?;
            bytes.clear();
            bytes.extend_from_slice(&row.count.to_le_bytes());
            bytes.extend_from_slice(&u32::try_from(row.name.len())?.to_le_bytes());
            bytes.extend_from_slice(row.name.as_bytes());
            let key = row.table.key(row.id);
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
            count += 1;
        }
        if count != expected {
            return Err(
                format!("incomplete lookup: expected {expected} rows, read {count}").into(),
            );
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
    Books { table: Table, groups: Vec<Vec<u32>> },
    Sample { table: Table, ids: Vec<u32> },
    Labels { table: Table, ids: Vec<u32> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    id: u32,
    name: String,
    count: u32,
    book_ids: Vec<u32>,
    complete: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum LookupResult {
    Books(Vec<u32>),
    Samples(Vec<Sample>),
    Labels(Vec<String>),
}

pub struct LookupIndex {
    db: ReadOnlyDatabase,
}

impl LookupIndex {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            db: Database::builder()
                .set_cache_size(32 * 1024 * 1024)
                .open_read_only(path)?,
        })
    }

    pub fn query(&self, request: LookupRequest) -> Result<LookupResult> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, &request.generation)?;
        let data = transaction.open_table(POSTINGS)?;
        match request.query {
            LookupQuery::Books { table, groups } => {
                Ok(LookupResult::Books(book_ids(&data, table, groups)?))
            }
            LookupQuery::Sample { table, ids } => {
                if ids.len() > 32 {
                    return Err("lookup sample exceeds row limit".into());
                }
                let mut rows = Vec::with_capacity(ids.len());
                for id in ids {
                    let row = data.get(table.key(id))?.ok_or("missing lookup row")?;
                    let entry = Entry::decode(row.value())?;
                    rows.push(Sample {
                        id,
                        name: entry.name.to_owned(),
                        count: entry.count,
                        book_ids: entry.sample(),
                        complete: entry.books.len() <= 4,
                    });
                }
                Ok(LookupResult::Samples(rows))
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
        }
    }
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
