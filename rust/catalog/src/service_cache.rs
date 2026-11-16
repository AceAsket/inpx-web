use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::Result;

const VALUES: TableDefinition<&str, &[u8]> = TableDefinition::new("query_values");
const CLOCK: TableDefinition<&str, (u64, u64)> = TableDefinition::new("query_access");
const HASHES: TableDefinition<&str, &[u8]> = TableDefinition::new("file_hashes");
const BY_HASH: TableDefinition<(&str, &str), ()> = TableDefinition::new("files_by_hash");

#[derive(Default)]
struct Lru {
    clock: u64,
    bytes: u64,
    ranks: BTreeMap<u64, String>,
    entries: HashMap<String, (u64, u64)>,
    touched: HashSet<String>,
}

impl Lru {
    fn forget(&mut self, key: &str) {
        if let Some((rank, size)) = self.entries.remove(key) {
            self.ranks.remove(&rank);
            self.bytes -= size;
        }
        self.touched.remove(key);
    }

    fn remember(&mut self, key: &str, rank: u64, size: u64) {
        self.forget(key);
        self.ranks.insert(rank, key.into());
        self.entries.insert(key.into(), (rank, size));
        self.clock = self.clock.max(rank);
        self.bytes += size;
    }

    fn evictions(&self, key: &str, size: u64, max_count: usize, max_bytes: u64) -> Vec<String> {
        let old = self.entries.get(key);
        let mut bytes = self.bytes - old.map_or(0, |(_, size)| *size) + size;
        let mut count = self.entries.len() - usize::from(old.is_some()) + usize::from(size > 0);
        let mut removed = Vec::new();
        for candidate in self.ranks.values() {
            if count <= max_count && bytes <= max_bytes {
                break;
            }
            if candidate != key {
                bytes -= self.entries[candidate].1;
                count -= 1;
                removed.push(candidate.clone());
            }
        }
        removed
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHash {
    id: String,
    hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CacheRequest {
    Get {
        key: String,
    },
    Put {
        key: String,
        value: String,
        max_count: usize,
        max_bytes: u64,
    },
    Trim {
        max_count: usize,
        max_bytes: u64,
    },
    Flush,
    FileRows {
        ids: Vec<String>,
    },
    FindHash {
        hash: String,
    },
    PutHash {
        row: FileHash,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum CacheResponse {
    Value(Option<Box<RawValue>>),
    Files(Vec<FileHash>),
    Saved(bool),
}

pub struct ServiceCache {
    db: Database,
    lru: RefCell<Lru>,
}

impl ServiceCache {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Database::create(path)?;
        let tx = db.begin_write()?;
        tx.open_table(VALUES)?;
        tx.open_table(CLOCK)?;
        tx.open_table(HASHES)?;
        tx.open_table(BY_HASH)?;
        tx.commit()?;
        let mut lru = Lru::default();
        for entry in db.begin_read()?.open_table(CLOCK)?.iter()? {
            let (key, metadata) = entry?;
            let (rank, size) = metadata.value();
            lru.remember(key.value(), rank, size);
        }
        Ok(Self {
            db,
            lru: RefCell::new(lru),
        })
    }

    fn get(&self, key: &str) -> Result<CacheResponse> {
        let tx = self.db.begin_read()?;
        let values = tx.open_table(VALUES)?;
        let entry = values
            .get(key)?
            .map(|item| serde_json::from_slice(item.value()))
            .transpose()?;
        let mut lru = self.lru.borrow_mut();
        if entry.is_some()
            && let Some(&(_, size)) = lru.entries.get(key)
        {
            let rank = lru.clock + 1;
            lru.remember(key, rank, size);
            lru.touched.insert(key.into());
        }
        Ok(CacheResponse::Value(entry))
    }

    fn update(
        &self,
        put: Option<(&str, &RawValue)>,
        max_count: usize,
        max_bytes: u64,
    ) -> Result<CacheResponse> {
        let mut lru = self.lru.borrow_mut();
        let size = put.map_or(0, |(key, value)| {
            128 + (key.len() + value.get().len()) as u64
        });
        if size > max_bytes || size > 0 && max_count == 0 {
            return Ok(CacheResponse::Saved(false));
        }
        let key = put.map_or("", |(key, _)| key);
        let removed = lru.evictions(key, size, max_count, max_bytes);
        if put.is_none() && removed.is_empty() && lru.touched.is_empty() {
            return Ok(CacheResponse::Saved(true));
        }
        let rank = lru.clock + 1;
        let tx = self.db.begin_write()?;
        {
            let mut values = tx.open_table(VALUES)?;
            let mut clock = tx.open_table(CLOCK)?;
            let removed_set: HashSet<_> = removed.iter().map(String::as_str).collect();
            for old in &removed {
                values.remove(old.as_str())?;
                clock.remove(old.as_str())?;
            }
            for touched in &lru.touched {
                if !removed_set.contains(touched.as_str()) && touched != key {
                    clock.insert(touched.as_str(), lru.entries[touched])?;
                }
            }
            if let Some((key, value)) = put {
                values.insert(key, value.get().as_bytes())?;
                clock.insert(key, (rank, size))?;
            }
        }
        tx.commit()?;
        for old in removed {
            lru.forget(&old);
        }
        if put.is_some() {
            lru.remember(key, rank, size);
        }
        lru.touched.clear();
        Ok(CacheResponse::Saved(true))
    }

    pub fn query(&self, request: CacheRequest) -> Result<CacheResponse> {
        match request {
            CacheRequest::Get { key } => self.get(&key),
            CacheRequest::Put {
                key,
                value,
                max_count,
                max_bytes,
            } => {
                let value = RawValue::from_string(value)?;
                self.update(Some((&key, &value)), max_count, max_bytes)
            }
            CacheRequest::Trim {
                max_count,
                max_bytes,
            } => self.update(None, max_count, max_bytes),
            CacheRequest::Flush => self.update(None, usize::MAX, u64::MAX),
            CacheRequest::FileRows { ids } => {
                let tx = self.db.begin_read()?;
                let rows = tx.open_table(HASHES)?;
                let mut result = Vec::new();
                for id in ids {
                    if let Some(entry) = rows.get(id.as_str())? {
                        result.push(serde_json::from_slice(entry.value())?);
                    }
                }
                Ok(CacheResponse::Files(result))
            }
            CacheRequest::FindHash { hash } => {
                let tx = self.db.begin_read()?;
                let index = tx.open_table(BY_HASH)?;
                let hashes = tx.open_table(HASHES)?;
                let mut result = Vec::new();
                if let Some((key, _)) = index.range((hash.as_str(), "")..)?.next().transpose()? {
                    let (found, id) = key.value();
                    if found == hash
                        && let Some(row) = hashes.get(id)?
                    {
                        result.push(serde_json::from_slice(row.value())?);
                    }
                }
                Ok(CacheResponse::Files(result))
            }
            CacheRequest::PutHash { row } => {
                let tx = self.db.begin_write()?;
                {
                    let mut hashes = tx.open_table(HASHES)?;
                    let mut index = tx.open_table(BY_HASH)?;
                    if let Some(old) = hashes.get(row.id.as_str())? {
                        let old: FileHash = serde_json::from_slice(old.value())?;
                        index.remove((old.hash.as_str(), row.id.as_str()))?;
                    }
                    let data = serde_json::to_vec(&row)?;
                    hashes.insert(row.id.as_str(), data.as_slice())?;
                    index.insert((row.hash.as_str(), row.id.as_str()), ())?;
                }
                tx.commit()?;
                Ok(CacheResponse::Saved(true))
            }
        }
    }
}
