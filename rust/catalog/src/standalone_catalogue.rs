use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::catalog_update::{FolderInput, Source as UpdateSource, prepare_update_reporting};
use crate::catalogue_lock::CatalogueLease;
use crate::library_sources::{Kind, Source};
use crate::{
    BookStore, LookupIndex, LookupRequest, Result, UpdateRequest, atomic_file, crypto_support,
    folder_index, folder_inventory, lookup_staging, store,
};

const LOOKUP: &str = "lookup.redb";
const METADATA: &str = "catalogue.json";
const DB_VERSION: &str = "15";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: u32,
    inpx_info: Value,
    stats: Value,
    #[serde(default)]
    inpx_hash: String,
    #[serde(default)]
    index_update: Value,
    rust_book_store_generation: String,
    rust_lookup_generation: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Filter {
    include_authors: Option<Vec<String>>,
    exclude_authors: Vec<String>,
    info: Option<Value>,
    filter: Option<Value>,
}

pub struct Catalogue {
    pub store: BookStore,
    pub(crate) lookup: LookupIndex,
    pub(crate) lookup_generation: String,
    pub generation: String,
    pub info: Value,
    pub stats: Value,
    pub inpx_hash: String,
    pub index_update: Value,
    pub created: bool,
    _lease: CatalogueLease,
}

pub struct CatalogueFiles {
    pub data: PathBuf,
    pub filter: PathBuf,
    pub low_memory: bool,
}

pub struct PreparedCatalogue(tempfile::TempDir);

enum PreviousCatalogue<'a> {
    Native(&'a str),
    Jemba(&'a Path),
}

impl CatalogueFiles {
    pub fn open_or_create(&self, sources: &[Source]) -> Result<Catalogue> {
        fs::create_dir_all(&self.data)?;
        let _publishing = self.publication_lock()?;
        let directory = self.data.join("db");
        let previous = self.data.join("db.previous");
        if !directory.try_exists()? && previous.try_exists()? {
            fs::rename(&previous, &directory)?;
            atomic_file::sync_parent(&directory)?;
        }
        if !directory.try_exists()? {
            let stage = self.build(sources, None, |_| Ok(()))?;
            stage.validate(self.low_memory)?;
            if directory.try_exists()? {
                return Err("Catalogue was published by another process".into());
            }
            fs::rename(stage.0.path(), &directory)?;
            atomic_file::sync_parent(&directory)?;
            save_folder_caches(&directory);
            return Catalogue::open(&directory, self.low_memory, true);
        }
        let book_table = directory.join("book");
        if !directory.join(METADATA).try_exists()? && book_table.is_dir() {
            let legacy = CatalogueLease::open(&directory)?;
            let stage = self.build(sources, Some(PreviousCatalogue::Jemba(&book_table)), |_| {
                Ok(())
            })?;
            stage.validate(self.low_memory)?;
            remove_previous(&previous)?;
            // Directory renames on Windows require closing the lease handle.
            drop(legacy);
            return self.replace(stage, &directory, &previous, true);
        }
        Catalogue::open(&directory, self.low_memory, false)
    }

    pub fn source_hash(&self, sources: &[Source]) -> Result<String> {
        Ok(collect(sources, &self.filter, None)?.1)
    }

    pub fn prepare(
        &self,
        sources: &[Source],
        previous_generation: &str,
        report: impl FnMut(Value) -> Result<()>,
    ) -> Result<PreparedCatalogue> {
        let stage = self.build(
            sources,
            Some(PreviousCatalogue::Native(previous_generation)),
            report,
        )?;
        stage.validate(self.low_memory)?;
        Ok(stage)
    }

    pub fn publish(&self, stage: PreparedCatalogue, active: &mut Option<Catalogue>) -> Result<()> {
        let _publishing = self.publication_lock()?;
        let directory = self.data.join("db");
        let previous = self.data.join("db.previous");
        remove_previous(&previous)?;

        // Windows cannot rename a catalogue directory while its stores or lease are open.
        drop(active.take());
        match self.replace(stage, &directory, &previous, false) {
            Ok(catalogue) => {
                *active = Some(catalogue);
                Ok(())
            }
            Err(error) => match Catalogue::open(&directory, self.low_memory, false) {
                Ok(catalogue) => {
                    *active = Some(catalogue);
                    Err(error)
                }
                Err(reopen) => Err(format!("{error}; cannot reopen catalogue: {reopen}").into()),
            },
        }
    }

    fn replace(
        &self,
        stage: PreparedCatalogue,
        directory: &Path,
        previous: &Path,
        created: bool,
    ) -> Result<Catalogue> {
        fs::rename(directory, previous)?;
        let mut moved = false;
        let install = (|| {
            fs::rename(stage.0.path(), directory)?;
            moved = true;
            atomic_file::sync_parent(directory)?;
            Catalogue::open(directory, self.low_memory, created)
        })();
        let catalogue = match install {
            Ok(catalogue) => catalogue,
            Err(error) => {
                let restore = (|| -> Result<()> {
                    if moved {
                        fs::rename(directory, stage.0.path())?;
                    }
                    fs::rename(previous, directory)?;
                    atomic_file::sync_parent(directory)
                })();
                return match restore {
                    Ok(()) => Err(error),
                    Err(restore) => {
                        Err(format!("{error}; cannot restore catalogue: {restore}").into())
                    }
                };
            }
        };
        if let Err(error) = fs::remove_dir_all(previous) {
            eprintln!("Cannot remove previous catalogue: {error}");
        }
        save_folder_caches(directory);
        Ok(catalogue)
    }

    fn publication_lock(&self) -> Result<File> {
        let path = self.data.join("__inpx_catalogue_publish");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match lock.try_lock() {
            Ok(()) => Ok(lock),
            Err(fs::TryLockError::WouldBlock) => {
                Err(format!("Database locked: {}", path.display()).into())
            }
            Err(fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}

impl PreparedCatalogue {
    fn validate(&self, low_memory: bool) -> Result<()> {
        Catalogue::open(self.0.path(), low_memory, false)?;
        Ok(())
    }
}

fn remove_previous(previous: &Path) -> Result<()> {
    if previous.try_exists()? {
        fs::remove_dir_all(previous)?;
    }
    Ok(())
}

impl Catalogue {
    fn open(directory: &Path, low_memory: bool, created: bool) -> Result<Self> {
        let lease = CatalogueLease::open(directory)?;
        let header_file = File::open(directory.join(METADATA)).map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                io::Error::other("Missing native catalogue metadata or legacy JembaDB book table")
            } else {
                error
            }
        })?;
        let header: Header = serde_json::from_reader(header_file)?;
        if header.format != 1
            || header.rust_book_store_generation.is_empty()
            || header.rust_lookup_generation.is_empty()
        {
            return Err("Invalid Rust catalogue header".into());
        }
        let store = if low_memory {
            BookStore::open_low_memory(directory)?
        } else {
            BookStore::open(directory)?
        };
        store.query(serde_json::from_value(
            json!({"generation":header.rust_book_store_generation,"op":"probe"}),
        )?)?;
        let lookup = LookupIndex::open(&directory.join(LOOKUP))?;
        lookup.query(LookupRequest {
            generation: header.rust_lookup_generation.clone(),
            query: crate::lookup::LookupQuery::Probe {
                capabilities: false,
            },
        })?;
        Ok(Self {
            store,
            lookup,
            lookup_generation: header.rust_lookup_generation,
            generation: header.rust_book_store_generation,
            info: header.inpx_info,
            stats: header.stats,
            inpx_hash: header.inpx_hash,
            index_update: header.index_update,
            created,
            _lease: lease,
        })
    }
}

impl CatalogueFiles {
    fn build(
        &self,
        sources: &[Source],
        previous_catalogue: Option<PreviousCatalogue<'_>>,
        mut report: impl FnMut(Value) -> Result<()>,
    ) -> Result<PreparedCatalogue> {
        let stage = tempfile::Builder::new()
            .prefix(".db-building-")
            .tempdir_in(&self.data)?;
        let input_directory = stage.path().join(".folder-input");
        fs::create_dir(&input_directory)?;
        let (inputs, source_hash, filter) =
            collect(sources, &self.filter, Some((&input_directory, &self.data)))?;
        let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
        let time = OffsetDateTime::from_unix_timestamp_nanos(elapsed.as_nanos().try_into()?)?;
        let date = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            time.year(),
            time.month() as u8,
            time.day(),
            time.hour(),
            time.minute(),
            time.second(),
            time.millisecond()
        );
        let generation = format!("{DB_VERSION}:{source_hash}:{date}");
        if inputs.is_empty() {
            return Err("Missing catalogue sources".into());
        }
        let include = filter.include_authors.map(author_names);
        let exclude = author_names(filter.exclude_authors);
        let mut request = UpdateRequest::initial(
            generation.clone(),
            self.low_memory,
            inputs,
            include,
            exclude,
        );
        let incremental = previous_catalogue.is_some();
        match previous_catalogue {
            Some(PreviousCatalogue::Native(generation)) => {
                let previous = self.data.join("db");
                let patch = store::stage_patch(stage.path(), &previous)?;
                request.set_previous(&previous, generation, patch);
            }
            Some(PreviousCatalogue::Jemba(book_table)) => request.set_previous_jemba(book_table),
            None => {}
        }
        let summary = prepare_update_reporting(stage.path(), &request, &mut report)?;
        let sizes = summary.counts.name_counts;
        report(
            json!({"job":"lookup","jobMessage":"Сохранение поискового индекса","jobStep":2,"progress":0}),
        )?;
        let series = lookup_staging::publish_sorted(
            &stage.path().join(LOOKUP),
            &generation,
            sizes,
            self.low_memory,
        )?;
        let mut stats = serde_json::to_value(&summary.counts)?;
        let files = stats["filesCount"].as_u64().unwrap_or(0)
            + stats["filesDelCount"].as_u64().unwrap_or(0);
        let books =
            stats["bookCount"].as_u64().unwrap_or(0) + stats["bookDelCount"].as_u64().unwrap_or(0);
        for (field, value) in [
            ("filesCountAll", files),
            ("bookCountAll", books),
            ("recsLoaded", summary.recs_loaded),
            ("authorCountAll", sizes[0] as u64),
            ("titleCount", sizes[2] as u64),
            ("seriesCount", series as u64),
        ] {
            stats[field] = json!(value);
        }
        let info = catalogue_info(&summary.parser_infos, filter.info)?;
        if self.source_hash(sources)? != source_hash {
            return Err("Источники изменились во время индексации. Повторите запуск.".into());
        }
        write_json(
            &stage.path().join("books-store.json"),
            &json!({ "generation": generation }),
        )?;
        write_json(
            &stage.path().join(METADATA),
            &json!({
                "format":1, "stats":stats, "inpxInfo":info, "inpxHash":source_hash, "dbVersion":DB_VERSION,
                "indexUpdate":{"incremental":incremental,"recordsChanged":summary.records_changed,
                    "recordsRemoved":summary.records_removed,"updatedAt":date},
                "rustLookupGeneration":generation,"rustBookStoreGeneration":generation,
            }),
        )?;
        fs::remove_dir_all(stage.path().join(".postings"))?;
        fs::remove_dir_all(input_directory)?;
        atomic_file::sync_directory(stage.path())?;
        Ok(PreparedCatalogue(stage))
    }
}

fn save_folder_caches(directory: &Path) {
    let caches = directory.join(".folder-cache");
    if caches.exists() {
        if let Err(error) = folder_index::publish_staged(directory) {
            eprintln!("Cannot save folder metadata cache: {error}");
        }
        if let Err(error) = fs::remove_dir_all(caches) {
            eprintln!("Cannot remove staging folder cache: {error}");
        }
    }
}

fn author_names(rows: Vec<String>) -> HashSet<String> {
    rows.into_iter().map(|value| value.to_lowercase()).collect()
}

fn catalogue_info(
    sources: &[crate::catalog_update::UpdatedSource<'_>],
    override_info: Option<Value>,
) -> Result<Value> {
    let first = sources
        .first()
        .ok_or("Missing catalogue source information")?;
    let mut info = serde_json::to_value(&first.info)?;
    if sources.len() > 1 {
        let collection: Vec<_> = sources.iter().map(|source| source.name).collect();
        let versions: Vec<_> = sources
            .iter()
            .map(|source| source.info.version.as_str())
            .filter(|value| !value.is_empty())
            .collect();
        info["collection"] = json!(collection.join(" + "));
        info["version"] = json!(versions.join(" + "));
        info["sources"] = json!(sources.iter().map(|source| json!({ "id":source.id,"name":source.name,
            "inpx":source.inpx,"libDir":source.lib_dir,"collection":source.info.collection,"version":source.info.version,
        })).collect::<Vec<_>>());
    }
    if let Some(override_info) = override_info {
        for field in ["collection", "version"] {
            if let Some(value) = override_info[field]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                info[field] = json!(value);
            }
        }
    }
    Ok(info)
}

fn collect(
    sources: &[Source],
    filter: &Path,
    staging: Option<(&Path, &Path)>,
) -> Result<(Vec<UpdateSource>, String, Filter)> {
    let file = match fs::read(filter) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let mut hash = Sha256::new();
    hash.update(DB_VERSION);
    let filter = match file {
        Some(bytes) => {
            hash.update(crypto_support::hex(&Sha256::digest(&bytes)));
            serde_json::from_slice::<Filter>(&bytes)?
        }
        None => Filter::default(),
    };
    if filter.filter.as_ref().is_some_and(|value| {
        value.as_str().is_none_or(|text| !text.is_empty()) && value != &Value::Bool(false)
    }) {
        return Err("JavaScript INPX filters require the compatibility runtime".into());
    }
    let mut inputs = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        if source.remote {
            return Err("Remote library synchronization requires the compatibility runtime".into());
        }
        if index != 0 {
            hash.update(b"|");
        }
        let lib_dir = source.lib_dir.to_str().ok_or("Invalid library directory")?;
        hash.update(format!("{}:{}:{lib_dir}:", source.id, source.name));
        let (source_hash, folder) = if source.kind == Some(Kind::Folder) {
            let mut rows = Vec::new();
            folder_inventory::visit_inventory(&source.lib_dir, |row| {
                rows.push(row);
                Ok(())
            })?;
            rows.sort_by(|a, b| a.relative.encode_utf16().cmp(b.relative.encode_utf16()));
            let inventory = serde_json::to_vec(&rows)?;
            let folder = staging
                .map(|(directory, data)| -> io::Result<_> {
                    let file = directory.join(format!("{index}.json"));
                    fs::write(&file, &inventory)?;
                    Ok(FolderInput {
                        inventory: file,
                        cache: data
                            .join("folder-index")
                            .join(format!("{}.json", source.id)),
                    })
                })
                .transpose()?;
            (crypto_support::hex(&Sha256::digest(inventory)), folder)
        } else {
            (hash_file(&source.inpx)?, None)
        };
        hash.update(source_hash);
        if staging.is_some() {
            inputs.push(UpdateSource {
                id: source.id.clone(),
                name: source.name.clone(),
                inpx: (source.kind != Some(Kind::Folder)).then(|| source.inpx.clone()),
                lib_dir: lib_dir.into(),
                folder,
            });
        }
    }
    Ok((inputs, crypto_support::hex(&hash.finalize()), filter))
}

fn hash_file(path: &Path) -> Result<String> {
    let mut input = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let len = input.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hash.update(&buffer[..len]);
    }
    Ok(crypto_support::hex(&hash.finalize()))
}

fn write_json(path: &Path, data: &impl Serialize) -> Result<()> {
    let file = File::create_new(path)?;
    serde_json::to_writer(&file, data)?;
    file.sync_all()?;
    Ok(())
}
