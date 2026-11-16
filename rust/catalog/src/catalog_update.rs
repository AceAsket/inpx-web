use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::Instant;

use base64::{Engine, engine::general_purpose::STANDARD};
use inpx_reader::{Archive, Event, Info, Record};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::{json, value::RawValue};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::catalog_postings::{CountsSummary, Postings};
use crate::catalog_text::{SearchProjection, field, lower, number, supported_text};
use crate::folder_index::{CacheStaging, FolderCache};
use crate::folder_inventory::Entry;
use crate::jemba::write_updated_books;
use crate::jemba_identity::{BookRows, Identity, physical_identity};
use crate::store::{BookStore, BookStoreWriter, write_store};
use crate::wide_search::{source_order, write_book_order};

const TEXT_FIELDS: &[&str] = &[
    "author", "series", "title", "file", "genre", "ext", "date", "lang",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    previous_book: Option<PathBuf>,
    previous_catalogue: Option<PathBuf>,
    previous_catalogue_generation: Option<String>,
    #[serde(default)]
    native_catalogue: bool,
    #[serde(default)]
    low_memory: bool,
    previous_generation: Option<String>,
    generation: String,
    sources: Vec<Source>,
    include_authors: Option<HashSet<String>>,
    #[serde(default)]
    exclude_authors: HashSet<String>,
}

impl UpdateRequest {
    pub(crate) fn initial(
        generation: String,
        low_memory: bool,
        sources: Vec<Source>,
        include_authors: Option<HashSet<String>>,
        exclude_authors: HashSet<String>,
    ) -> Self {
        Self {
            previous_book: None,
            previous_catalogue: None,
            previous_catalogue_generation: None,
            native_catalogue: true,
            low_memory,
            previous_generation: None,
            generation,
            sources,
            include_authors,
            exclude_authors,
        }
    }

    pub(crate) fn set_previous(&mut self, directory: &Path, generation: &str, patch: bool) {
        self.previous_catalogue = Some(directory.into());
        self.previous_catalogue_generation = Some(generation.into());
        self.previous_generation = patch.then(|| generation.into());
    }

    pub(crate) fn set_previous_jemba(&mut self, book_table: &Path) {
        self.previous_book = Some(book_table.into());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) inpx: Option<PathBuf>,
    pub(crate) lib_dir: String,
    pub(crate) folder: Option<FolderInput>,
}

#[derive(Deserialize)]
pub(crate) struct FolderInput {
    pub(crate) inventory: PathBuf,
    pub(crate) cache: PathBuf,
}

struct PreparedFolder {
    entries: Vec<Entry>,
    cache: FolderCache,
}

impl PreparedFolder {
    fn open(source: &Source, folder: &FolderInput) -> Result<Self> {
        let entries: Vec<Entry> = serde_json::from_slice(&fs::read(&folder.inventory)?)?;
        let mut cache = FolderCache::open(
            source.lib_dir.clone(),
            source.id.clone(),
            folder.cache.clone(),
        )?;
        for entry in &entries {
            if !cache.prepare(entry)? {
                return Err(format!(
                    "folder book requires a compatibility decoder: {}",
                    entry.relative
                )
                .into());
            }
        }
        Ok(Self { entries, cache })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatedSource<'a> {
    pub(crate) id: &'a str,
    pub(crate) name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) inpx: Option<&'a Path>,
    pub(crate) lib_dir: &'a str,
    pub(crate) info: Info,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummary<'a> {
    pub(crate) parser_infos: Vec<UpdatedSource<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lookup_postings: Option<&'static str>,
    pub(crate) counts: CountsSummary,
    pub(crate) recs_loaded: u64,
    pub(crate) records_changed: usize,
    pub(crate) records_removed: usize,
}

struct OldBook {
    id: u32,
    uid: Rc<str>,
    identity: Rc<str>,
    legacy_uid: Option<String>,
    hash: Option<String>,
    retained: bool,
    changed: bool,
}

enum ByIdentity {
    Unique(usize),
    Ambiguous(HashMap<String, Option<usize>>),
}

struct Previous {
    books: Vec<OldBook>,
    by_uid: HashMap<Rc<str>, usize>,
    physical: HashMap<Rc<str>, ByIdentity>,
    max_id: u32,
}

impl Previous {
    fn new(count: usize) -> Self {
        Self {
            books: Vec::with_capacity(count),
            by_uid: HashMap::with_capacity(count),
            physical: HashMap::with_capacity(count),
            max_id: 0,
        }
    }

    fn add(&mut self, id: u32, row: &Identity) -> Result<()> {
        let previous = self;
        if id != row.id || row.uid.is_empty() || row.uid.encode_utf16().count() > 100 {
            return Err("unsupported book ID or UID in previous catalog".into());
        }
        let uid: Rc<str> = row.uid.as_str().into();
        let identity: Rc<str> = row
            .physical_identity()
            .ok_or("unsupported physical book identity")?
            .into();
        let index = previous.books.len();
        let legacy_uid = row
            .legacy_uid
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .filter(|uid| !uid.is_empty())
            .map(str::to_owned);
        if previous.by_uid.insert(uid.clone(), index).is_some() {
            return Err("duplicate book UID in previous catalog".into());
        }
        if !identity.is_empty() {
            use std::collections::hash_map::Entry;
            let remember = |map: &mut HashMap<String, Option<usize>>, uid: Option<&str>, index| {
                if let Some(uid) = uid {
                    map.entry(uid.into())
                        .and_modify(|value| *value = None)
                        .or_insert(Some(index));
                }
            };
            match previous.physical.entry(identity.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ByIdentity::Unique(index));
                }
                Entry::Occupied(mut entry) => match entry.get_mut() {
                    ByIdentity::Unique(owner) => {
                        let mut map = HashMap::new();
                        remember(
                            &mut map,
                            previous.books[*owner].legacy_uid.as_deref(),
                            *owner,
                        );
                        remember(&mut map, legacy_uid.as_deref(), index);
                        entry.insert(ByIdentity::Ambiguous(map));
                    }
                    ByIdentity::Ambiguous(map) => remember(map, legacy_uid.as_deref(), index),
                },
            }
        }
        let hash = row
            .hash
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        previous.max_id = previous.max_id.max(id);
        previous.books.push(OldBook {
            id,
            uid,
            identity,
            legacy_uid,
            hash,
            retained: false,
            changed: false,
        });
        Ok(())
    }

    fn identify(
        &self,
        parsed: &str,
        identity: &str,
        seen: &HashSet<String>,
    ) -> (String, Option<usize>) {
        let by_uid = self.by_uid.get(parsed).copied();
        let uid_matches =
            by_uid.is_some_and(|index| self.books[index].identity.as_ref() == identity);
        let prior = if identity.is_empty() || uid_matches {
            by_uid
        } else {
            match self.physical.get(identity) {
                Some(ByIdentity::Unique(index)) => Some(*index),
                Some(ByIdentity::Ambiguous(map)) => map.get(parsed).copied().flatten(),
                None => None,
            }
        };
        if let Some(index) = prior
            && !seen.contains(self.books[index].uid.as_ref())
        {
            return (self.books[index].uid.to_string(), Some(index));
        }
        if !identity.is_empty() {
            if !self.physical.contains_key(identity)
                && !seen.contains(identity)
                && !self.by_uid.contains_key(identity)
            {
                return (identity.into(), None);
            }
            if by_uid.is_some() && !uid_matches {
                let mut hash = Sha256::new();
                hash.update(b"inpx-record-v1:");
                hash.update(identity.as_bytes());
                hash.update(b":");
                hash.update(parsed.as_bytes());
                let variant = STANDARD.encode(hash.finalize());
                let prior = self
                    .by_uid
                    .get(variant.as_str())
                    .copied()
                    .filter(|&i| self.books[i].identity.as_ref() == identity);
                return (variant, prior);
            }
        }
        (parsed.into(), None)
    }
}

struct ChangedBook {
    uid: String,
    raw: Box<RawValue>,
}

struct Import<'a> {
    request: &'a UpdateRequest,
    previous: Previous,
    new_count: usize,
    changed_ids: Vec<u32>,
    seen: HashSet<String>,
    changes: HashMap<u32, ChangedBook>,
    postings: Postings,
}

impl Import<'_> {
    fn add(
        &mut self,
        mut row: Record,
        source: &Source,
        store: &mut BookStoreWriter<'_>,
    ) -> Result<()> {
        let parsed = field(&row, "_uid").to_owned();
        if TEXT_FIELDS.iter().any(|key| {
            row.get(*key)
                .and_then(serde_json::Value::as_str)
                .is_none_or(|value| !supported_text(value))
        }) || !supported_text(field(&row, "folder"))
        {
            return Err("unsupported INPX text field or Unicode version".into());
        }
        let folder = source.folder.is_some();
        if parsed.is_empty()
            || (!folder && !safe_integer(&row, "serno"))
            || ["size", "del", "insno", "librate"]
                .iter()
                .any(|key| !safe_integer(&row, key))
        {
            return Err("unsupported INPX numeric value or UID".into());
        }
        let identity = if folder {
            String::new()
        } else {
            physical_identity(
                &source.id,
                field(&row, "folder"),
                field(&row, "file"),
                field(&row, "ext"),
                number(&row, "insno"),
                field(&row, "libid"),
                field(&row, "sourcelib"),
            )?
        };
        row.insert("sourceId".into(), source.id.as_str().into());
        row.insert("sourceName".into(), source.name.as_str().into());
        row.insert("sourceLibDir".into(), source.lib_dir.as_str().into());
        if !identity.is_empty() {
            row.insert("_legacyUid".into(), parsed.as_str().into());
        }
        let (uid, prior) = self.previous.identify(&parsed, &identity, &self.seen);
        let author = field(&row, "author");
        if self.request.include_authors.is_some() || !self.request.exclude_authors.is_empty() {
            let author = lower(if author.is_empty() { "?" } else { author });
            if self
                .request
                .include_authors
                .as_ref()
                .is_some_and(|included| !included.contains(author.as_ref()))
                || author
                    .split(',')
                    .any(|name| self.request.exclude_authors.contains(name))
            {
                return Ok(());
            }
        }
        if !self.seen.insert(uid.clone()) {
            return Ok(());
        }
        if uid != parsed {
            row.insert("_uid".into(), uid.as_str().into());
        }

        let id = match prior {
            Some(index) => {
                let old = &mut self.previous.books[index];
                if old.retained {
                    return Err("more than one record resolves to a previous book ID".into());
                }
                old.retained = true;
                old.id
            }
            None => {
                let id = self
                    .previous
                    .max_id
                    .checked_add(1)
                    .ok_or("book ID limit reached")?;
                self.previous.max_id = id;
                self.new_count += 1;
                id
            }
        };
        let mut serialized = if folder {
            serde_json::to_string(&FolderRow(&row))?
        } else {
            serde_json::to_string(&row)?
        };
        let hash = format!("{:x}", Sha256::digest(serialized.as_bytes()));
        let changed =
            prior.is_none_or(|i| self.previous.books[i].hash.as_deref() != Some(hash.as_str()));
        if changed {
            if let Some(position) = prior {
                self.previous.books[position].changed = true;
            }
            self.changed_ids.push(id);
        }
        if changed || !store.is_patch() {
            let projection = SearchProjection::from_book(&row);
            serialized.pop();
            write_json_suffix(&mut serialized, &hash, id)?;
            let raw = RawValue::from_string(serialized)?;
            store.add(id, &uid, &raw, &projection)?;
            if changed && !self.request.native_catalogue {
                self.changes.insert(id, ChangedBook { uid, raw });
            }
        }
        self.postings.add(&row, id)?;
        Ok(())
    }
}

fn safe_integer(row: &Record, key: &str) -> bool {
    row.get(key)
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|value| value.unsigned_abs() < 1 << 53)
}

struct FolderRow<'a>(&'a Record);

impl Serialize for FolderRow<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0 {
            if key == "serno"
                && let Some(number) = value.as_f64()
            {
                // JSON.stringify normalizes floating-point series numbers before the row is hashed.
                let text = if number == 0.0 {
                    "0".to_owned()
                } else if number.abs() >= 1e21 {
                    format!("{number:e}").replace('e', "e+")
                } else if number.abs() < 1e-6 {
                    format!("{number:e}")
                } else {
                    number.to_string()
                };
                let raw = RawValue::from_string(text).map_err(serde::ser::Error::custom)?;
                map.serialize_entry(key, &raw)?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

fn write_json_suffix(row: &mut String, hash: &str, id: u32) -> Result<()> {
    use std::fmt::Write;
    write!(row, ",\"_recordHash\":\"{hash}\",\"id\":{id}}}")?;
    Ok(())
}

fn report_source(
    output: &mut impl FnMut(serde_json::Value) -> Result<()>,
    source: &Source,
    total_files: usize,
    current: usize,
) -> Result<()> {
    output(
        json!({"job":"load inpx","jobMessage":format!("Loading INPX: {}",source.name),"jobStep":1,
        "sourceId":source.id,"sourceName":source.name,"totalFiles":total_files,"current":current,"progress":0}),
    )
}

const ARCHIVE_BATCH_SIZE: usize = 512;

enum ArchiveBatch {
    File(String),
    Records(Vec<Record>),
}

fn read_archive_batches(
    mut archive: Archive<BufReader<File>>,
    sender: SyncSender<ArchiveBatch>,
) -> std::result::Result<Info, String> {
    let mut batch = Vec::with_capacity(ARCHIVE_BATCH_SIZE);
    let send = |event| {
        sender
            .send(event)
            .map_err(|_| io::Error::other("catalogue importer closed"))
    };
    let flush = |rows: &mut Vec<_>| -> io::Result<()> {
        if !rows.is_empty() {
            send(ArchiveBatch::Records(std::mem::replace(
                rows,
                Vec::with_capacity(ARCHIVE_BATCH_SIZE),
            )))?;
        }
        Ok(())
    };
    archive
        .scan(|event| {
            match event {
                Event::File(name) => {
                    flush(&mut batch)?;
                    send(ArchiveBatch::File(name.to_owned()))?;
                }
                Event::Record(row) => {
                    batch.push(row);
                    if batch.len() == ARCHIVE_BATCH_SIZE {
                        flush(&mut batch)?;
                    }
                }
            }
            Ok(())
        })
        .and_then(|_| flush(&mut batch))
        .map_err(|error| error.to_string())?;
    Ok(archive.into_info())
}

fn scan_archive(
    source: &Source,
    import: &mut Import<'_>,
    store: &mut BookStoreWriter<'_>,
    output: &mut impl FnMut(serde_json::Value) -> Result<()>,
    recs_loaded: &mut u64,
) -> Result<Info> {
    let path = source.inpx.as_ref().ok_or("missing INPX source path")?;
    let archive = Archive::open(BufReader::new(File::open(path)?))?;
    let structure = archive.info().structure.to_lowercase();
    let columns: HashSet<_> = structure.split(';').collect();
    if !TEXT_FIELDS.iter().all(|key| columns.contains(key))
        || columns.iter().any(|key| {
            matches!(*key, "id" | "_uid")
                || !key.is_empty() && key.bytes().all(|c| c.is_ascii_digit())
        })
    {
        return Err("unsupported INPX structure for native update".into());
    }
    let total_files = archive.input_files() + 3;
    report_source(output, source, total_files, 3)?;
    let mut current = 3;
    let mut last = Instant::now();
    std::thread::scope(|scope| {
        let (sender, receiver) = sync_channel(4);
        let reading = scope.spawn(move || read_archive_batches(archive, sender));
        let imported = (|| -> Result<()> {
            for batch in &receiver {
                match batch {
                    ArchiveBatch::File(name) => {
                        current += 1;
                        if last.elapsed().as_millis() >= 125 {
                            output(
                                json!({"fileName":name,"current":current,"totalFiles":total_files,"recsLoaded":*recs_loaded,
                                "sourceId":source.id,"sourceName":source.name,"progress":current as f64 / total_files as f64}),
                            )?;
                            last = Instant::now();
                        }
                    }
                    ArchiveBatch::Records(rows) => {
                        for row in rows {
                            *recs_loaded += 1;
                            import.add(row, source, store)?;
                        }
                    }
                }
            }
            Ok(())
        })();
        drop(receiver);
        let info = reading.join().map_err(|_| "INPX reader thread failed")?;
        imported?;
        info.map_err(Into::into)
    })
}

fn scan_folder(
    source: &Source,
    folder: PreparedFolder,
    import: &mut Import<'_>,
    store: &mut BookStoreWriter<'_>,
    output: &mut impl FnMut(serde_json::Value) -> Result<()>,
    recs_loaded: &mut u64,
    caches: &mut CacheStaging,
) -> Result<Info> {
    let total_files = folder.entries.len();
    report_source(output, source, total_files, 0)?;
    let mut last = Instant::now();
    for (index, entry) in folder.entries.iter().enumerate() {
        let row = serde_json::from_str(folder.cache.record(&entry.relative)?.get())?;
        import.add(row, source, store)?;
        *recs_loaded += 1;
        let current = index + 1;
        if current == total_files || last.elapsed().as_millis() >= 125 {
            output(
                json!({"fileName":entry.relative,"current":current,"totalFiles":total_files,"recsLoaded":*recs_loaded,
                "sourceId":source.id,"sourceName":source.name,"progress":current as f64 / total_files as f64}),
            )?;
            last = Instant::now();
        }
    }
    caches.stage(folder.cache)?;
    Ok(Info::folder(source.name.clone()))
}

pub fn prepare_update<'a>(
    directory: &Path,
    request: &'a UpdateRequest,
    mut output: impl Write,
) -> Result<UpdateSummary<'a>> {
    prepare_update_reporting(directory, request, |value| {
        serde_json::to_writer(&mut output, &value)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    })
}

pub(crate) fn prepare_update_reporting<'a>(
    directory: &Path,
    request: &'a UpdateRequest,
    mut output: impl FnMut(serde_json::Value) -> Result<()>,
) -> Result<UpdateSummary<'a>> {
    if request.sources.is_empty() {
        return Err("missing catalogue sources".into());
    }
    // Check folder metadata ahead of reading previous identities or streaming large INPX archives.
    let folders = request
        .sources
        .iter()
        .map(|source| {
            source
                .folder
                .as_ref()
                .map(|folder| PreparedFolder::open(source, folder))
                .transpose()
        })
        .collect::<Result<Vec<_>>>()?;
    output(
        json!({"job":"previous identities","jobMessage":"Чтение идентификаторов Rust","jobStep":1,"progress":0}),
    )?;
    let rows = request
        .previous_book
        .as_deref()
        .map(BookRows::open)
        .transpose()?;
    let mut previous = Previous::new(rows.as_ref().map_or(0, |rows| rows.count));
    let native_order = if let Some(path) = &request.previous_catalogue {
        let generation = request
            .previous_catalogue_generation
            .as_deref()
            .ok_or("missing previous catalogue generation")?;
        let order = source_order(path, generation)?;
        previous = Previous::new(order.len());
        let store = if request.low_memory {
            BookStore::open_low_memory(path)?
        } else {
            BookStore::open(path)?
        };
        store.visit(|id, raw| previous.add(id, &serde_json::from_slice(raw)?))?;
        if previous.books.len() != order.len() {
            return Err("previous catalogue order count differs".into());
        }
        Some(order)
    } else {
        if let Some(rows) = &rows {
            rows.visit(|id, row: &Identity| previous.add(id, row))?;
        }
        None
    };
    let previous_count = previous.books.len();
    let mut caches = CacheStaging::new(directory);
    let mut import = Import {
        request,
        previous,
        new_count: 0,
        changed_ids: Vec::new(),
        seen: HashSet::with_capacity(previous_count),
        changes: HashMap::new(),
        postings: Postings::new(directory, request.low_memory)?,
    };
    let (parser_infos, recs_loaded, records_removed) = write_store(
        directory,
        &request.generation,
        request.previous_generation.as_deref(),
        request.low_memory,
        |store| {
            let mut parser_infos = Vec::new();
            let mut recs_loaded = 0;
            for (source, folder) in request.sources.iter().zip(folders) {
                let info = match folder {
                    Some(folder) => scan_folder(
                        source,
                        folder,
                        &mut import,
                        store,
                        &mut output,
                        &mut recs_loaded,
                        &mut caches,
                    )?,
                    None => {
                        scan_archive(source, &mut import, store, &mut output, &mut recs_loaded)?
                    }
                };
                parser_infos.push(UpdatedSource {
                    id: &source.id,
                    name: &source.name,
                    inpx: source.inpx.as_deref(),
                    lib_dir: &source.lib_dir,
                    info,
                });
            }
            output(
                json!({"job":"book save","jobMessage":"Сохранение обновлённых книг Rust","jobStep":1,
        "recsLoaded":recs_loaded,"recordsChanged":import.changed_ids.len(),"progress":0}),
            )?;
            let mut records_removed = 0;
            for row in import.previous.books.iter().filter(|row| !row.retained) {
                if store.is_patch() {
                    store.remove(row.id)?;
                }
                records_removed += 1;
            }
            Ok((parser_infos, recs_loaded, records_removed))
        },
    )?;
    let Import {
        previous,
        new_count,
        changed_ids,
        mut changes,
        postings,
        seen,
        ..
    } = import;
    drop(seen);
    let records_changed = changed_ids.len();
    let Previous {
        books,
        by_uid,
        physical,
        ..
    } = previous;
    drop((by_uid, physical));
    let expected = previous_count - records_removed + new_count;
    if request.native_catalogue {
        let unchanged = |row: &&OldBook| row.retained && !row.changed;
        let mut kept: Vec<u32> = match native_order {
            Some(order) => {
                let existing: HashSet<_> =
                    books.iter().filter(unchanged).map(|row| row.id).collect();
                order
                    .into_iter()
                    .filter(|id| existing.contains(id))
                    .collect()
            }
            None => books.iter().filter(unchanged).map(|row| row.id).collect(),
        };
        kept.extend(changed_ids);
        if kept.len() != expected {
            return Err("book sequence differs from the native snapshot".into());
        }
        write_book_order(directory, &request.generation, kept)?;
    } else {
        let rows = rows.ok_or("missing catalogue compatibility source")?;
        let updated = write_updated_books(&directory.join("book"), |writer| {
            let mut previous = books.iter();
            rows.visit::<Box<RawValue>>(|id, raw| {
                let row = previous.next().ok_or("previous book count changed")?;
                if id != row.id {
                    return Err("previous book order changed".into());
                }
                if row.retained && !changes.contains_key(&id) {
                    writer.add(id, &row.uid.as_ref(), raw, false)?;
                }
                Ok(())
            })?;
            // JembaDB moves replaced IDs to the end in the same order as new IDs.
            for id in changed_ids {
                let book = changes
                    .remove(&id)
                    .ok_or("changed book missing from the update")?;
                writer.add(id, &book.uid, &book.raw, false)?;
            }
            Ok(())
        })?;
        if !changes.is_empty() || updated as usize != expected {
            return Err("book change count or row count differs from prepared snapshot".into());
        }
    }
    let posting_path = directory.join(".postings");
    fs::create_dir(&posting_path)?;
    let facet_path = if request.native_catalogue {
        let path = directory.join("facets");
        fs::create_dir(&path)?;
        path
    } else {
        posting_path.clone()
    };
    let counts = postings.save(&posting_path, &facet_path, request.native_catalogue)?;
    caches.finish()?;
    Ok(UpdateSummary {
        parser_infos,
        lookup_postings: request.native_catalogue.then_some("packed-v1"),
        counts,
        recs_loaded,
        records_changed,
        records_removed,
    })
}
