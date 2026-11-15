use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;

use base64::{Engine, engine::general_purpose::STANDARD};
use inpx_reader::{Archive, Event, Info, Record};
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::catalog_postings::{CountsSummary, Postings};
use crate::catalog_text::{SearchProjection, field, lower, number, supported_text};
use crate::jemba::write_updated_books;
use crate::jemba_identity::{BookRows, Identity, physical_identity};
use crate::store::{BookStoreWriter, write_store};

const TEXT_FIELDS: &[&str] = &[
    "author", "series", "title", "file", "genre", "ext", "date", "lang",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    previous_book: PathBuf,
    previous_generation: Option<String>,
    generation: String,
    sources: Vec<Source>,
    include_authors: Option<HashSet<String>>,
    #[serde(default)]
    exclude_authors: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    name: String,
    inpx: PathBuf,
    lib_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedSource<'a> {
    id: &'a str,
    name: &'a str,
    inpx: &'a Path,
    lib_dir: &'a str,
    info: Info,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummary<'a> {
    parser_infos: Vec<UpdatedSource<'a>>,
    counts: CountsSummary,
    recs_loaded: u64,
    records_changed: usize,
    records_removed: usize,
}

struct OldBook {
    id: u32,
    uid: Rc<str>,
    identity: Rc<str>,
    legacy_uid: Option<String>,
    hash: Option<String>,
    retained: bool,
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
    fn read(rows: &BookRows) -> Result<Self> {
        let mut previous = Self {
            books: Vec::with_capacity(rows.count),
            by_uid: HashMap::with_capacity(rows.count),
            physical: HashMap::with_capacity(rows.count),
            max_id: 0,
        };
        rows.visit(|id, row: &Identity| {
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
                let remember =
                    |map: &mut HashMap<String, Option<usize>>, uid: Option<&str>, index| {
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
            });
            Ok(())
        })?;
        Ok(previous)
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
        if parsed.is_empty()
            || ["serno", "size", "del", "insno", "librate"]
                .iter()
                .any(|key| {
                    row.get(*key)
                        .and_then(serde_json::Value::as_i64)
                        .is_none_or(|value| value.unsigned_abs() >= 1 << 53)
                })
        {
            return Err("unsupported INPX numeric value or UID".into());
        }
        let identity = physical_identity(
            &source.id,
            field(&row, "folder"),
            field(&row, "file"),
            field(&row, "ext"),
            number(&row, "insno"),
            field(&row, "libid"),
            field(&row, "sourcelib"),
        )?;
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
        let mut serialized = serde_json::to_string(&row)?;
        let hash = format!("{:x}", Sha256::digest(serialized.as_bytes()));
        let changed =
            prior.is_none_or(|i| self.previous.books[i].hash.as_deref() != Some(hash.as_str()));
        if changed || !store.is_patch() {
            let projection = SearchProjection::from_book(&row);
            serialized.pop();
            write_json_suffix(&mut serialized, &hash, id)?;
            let raw = RawValue::from_string(serialized)?;
            store.add(id, &uid, &raw, &projection)?;
            if changed {
                self.changes.insert(id, ChangedBook { uid, raw });
                self.changed_ids.push(id);
            }
        }
        self.postings.add(&row, id);
        Ok(())
    }
}

fn write_json_suffix(row: &mut String, hash: &str, id: u32) -> Result<()> {
    use std::fmt::Write;
    write!(row, ",\"_recordHash\":\"{hash}\",\"id\":{id}}}")?;
    Ok(())
}

fn report(output: &mut impl Write, value: serde_json::Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}

pub fn prepare_update<'a>(
    directory: &Path,
    request: &'a UpdateRequest,
    mut output: impl Write,
) -> Result<UpdateSummary<'a>> {
    if request.sources.is_empty() {
        return Err("missing INPX sources".into());
    }
    report(
        &mut output,
        json!({"job":"previous identities","jobMessage":"Чтение идентификаторов Rust","jobStep":1,"progress":0}),
    )?;
    let rows = BookRows::open(&request.previous_book)?;
    let previous = Previous::read(&rows)?;
    let previous_count = previous.books.len();
    let mut import = Import {
        request,
        previous,
        new_count: 0,
        changed_ids: Vec::new(),
        seen: HashSet::with_capacity(previous_count),
        changes: HashMap::new(),
        postings: Postings::default(),
    };
    let (parser_infos, recs_loaded, records_removed) = write_store(
        directory,
        &request.generation,
        request.previous_generation.as_deref(),
        |store| {
            let mut parser_infos = Vec::new();
            let mut recs_loaded = 0;
            for source in &request.sources {
                let mut archive = Archive::open(BufReader::new(File::open(&source.inpx)?))?;
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
                report(
                    &mut output,
                    json!({"job":"load inpx","jobMessage":format!("Loading INPX: {}",source.name),"jobStep":1,
            "sourceId":source.id,"sourceName":source.name,"totalFiles":total_files,"current":3,"progress":0}),
                )?;
                let mut current = 3;
                let mut last = Instant::now();
                archive.scan(|event| {
            match event {
                Event::File(name) => {
                    current += 1;
                    if last.elapsed().as_millis() >= 125 {
                        report(&mut output,json!({"fileName":name,"current":current,"totalFiles":total_files,"recsLoaded":recs_loaded,
                            "sourceId":source.id,"sourceName":source.name,"progress":current as f64 / total_files as f64}))?;
                        last = Instant::now();
                    }
                }
                Event::Record(row) => {
                    recs_loaded += 1;
                    import.add(row,source,store).map_err(|error| io::Error::other(error.to_string()))?;
                }
            }
            Ok(())
        })?;
                parser_infos.push(UpdatedSource {
                    id: &source.id,
                    name: &source.name,
                    inpx: &source.inpx,
                    lib_dir: &source.lib_dir,
                    info: archive.into_info(),
                });
            }
            report(
                &mut output,
                json!({"job":"book save","jobMessage":"Сохранение обновлённых книг Rust","jobStep":1,
        "recsLoaded":recs_loaded,"recordsChanged":import.changes.len(),"progress":0}),
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
    let records_changed = changes.len();
    let Previous {
        books,
        by_uid,
        physical,
        ..
    } = previous;
    drop((by_uid, physical));
    let expected = previous_count - records_removed + new_count;
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
    let posting_path = directory.join(".postings");
    fs::create_dir(&posting_path)?;
    let counts = postings.save(&posting_path)?;
    Ok(UpdateSummary {
        parser_infos,
        counts,
        recs_loaded,
        records_changed,
        records_removed,
    })
}
