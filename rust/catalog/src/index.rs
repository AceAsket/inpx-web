use std::path::Path;

use redb::{
    Database, MultimapTableDefinition, ReadOnlyDatabase, ReadableDatabase, TableDefinition,
    backends::FileBackend,
};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::{Result, ShelfRequest};

pub(crate) const BOOKS: TableDefinition<u64, &[u8]> = TableDefinition::new("books");
pub(crate) const UIDS: TableDefinition<&str, u64> = TableDefinition::new("uids");
pub(crate) const COPIES: MultimapTableDefinition<&str, u64> =
    MultimapTableDefinition::new("copies");
pub(crate) const DATES: TableDefinition<(i64, u64), ()> = TableDefinition::new("dates");
pub(crate) const RATED: TableDefinition<(i64, u32, u32, u32, u64), ()> =
    TableDefinition::new("rated");
pub(crate) const METADATA: TableDefinition<&str, &str> = TableDefinition::new("catalog_v1");

pub(crate) fn publish<T>(
    path: &Path,
    generation: &str,
    populate: impl FnOnce(&redb::WriteTransaction) -> Result<T>,
) -> Result<T> {
    if generation.is_empty() {
        return Err("missing index generation".into());
    }
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let staging = NamedTempFile::new_in(parent)?;
    let db = Database::builder().create_with_backend(FileBackend::new(staging.reopen()?)?)?;
    let transaction = db.begin_write()?;
    transaction
        .open_table(METADATA)?
        .insert("generation", generation)?;
    let result = populate(&transaction)?;
    transaction.commit()?;
    drop(db);
    staging.persist_noclobber(path)?;
    Ok(result)
}

pub(crate) fn check_generation(
    transaction: &redb::ReadTransaction,
    generation: &str,
) -> Result<()> {
    let metadata = transaction.open_table(METADATA)?;
    if !metadata
        .get("generation")?
        .is_some_and(|value| value.value() == generation)
    {
        return Err("catalog does not match the requested index generation".into());
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: u64,
    pub uid: String,
    pub copy_key: String,
    pub quality: f64,
    pub date_ms: Option<i64>,
    pub date_order: u32,
    pub rating: i32,
    pub author_order: u32,
    pub title_order: u32,
    pub author_group: String,
    pub series_group: String,
}

impl Book {
    pub(crate) fn rated_order(&self) -> (i64, u32, u32, u32, u64) {
        (
            -i64::from(self.rating),
            u32::MAX - self.date_order,
            self.author_order,
            self.title_order,
            self.id,
        )
    }

    pub(crate) fn better_copy_than(&self, other: &Self) -> bool {
        self.quality > other.quality || self.quality == other.quality && self.id < other.id
    }
}

/// Build a complete snapshot next to the destination and publish it atomically.
pub fn build(
    path: &Path,
    generation: &str,
    books: impl IntoIterator<Item = Result<Book>>,
) -> Result<u64> {
    publish(path, generation, |transaction| {
        let mut count = 0;
        let mut data = transaction.open_table(BOOKS)?;
        let mut by_uid = transaction.open_table(UIDS)?;
        let mut copies = transaction.open_multimap_table(COPIES)?;
        let mut dates = transaction.open_table(DATES)?;
        let mut rated = transaction.open_table(RATED)?;
        for book in books {
            let book = book?;
            let bytes = serde_json::to_vec(&book)?;
            if data.insert(book.id, bytes.as_slice())?.is_some()
                || by_uid.insert(book.uid.as_str(), book.id)?.is_some()
            {
                return Err(format!("duplicate catalog record {} ({})", book.id, book.uid).into());
            }
            copies.insert(book.copy_key.as_str(), book.id)?;
            if let Some(date) = book.date_ms {
                dates.insert((date, book.id), ())?;
            }
            if book.rating > 0 {
                rated.insert(book.rated_order(), ())?;
            }
            count += 1;
        }
        Ok(count)
    })
}

pub struct Catalog {
    db: ReadOnlyDatabase,
}

impl Catalog {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            db: Database::builder().open_read_only(path)?,
        })
    }

    pub fn shelves(&self, request: &ShelfRequest) -> Result<Vec<Vec<String>>> {
        let transaction = self.db.begin_read()?;
        check_generation(&transaction, &request.generation)?;
        crate::shelves::select(&transaction, request)
    }
}
