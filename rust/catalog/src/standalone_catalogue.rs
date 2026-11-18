use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::catalog_update::{FolderInput, Source as UpdateSource, prepare_update_reporting};
use crate::catalogue_lock::CatalogueLease;
use crate::inpx_filter::Filter as RecordFilter;
use crate::library_sources::{Kind, Source};
use crate::{
    BookStore, LookupIndex, LookupRequest, Result, UpdateRequest, atomic_file, crypto_support,
    folder_index, folder_inventory, lookup_staging, store,
};

const LOOKUP: &str = "lookup.redb";
const METADATA: &str = "catalogue.json";
const DB_VERSION: &str = "15";
const MIGRATION_READY: &str = ".db-migration-ready";
const MIGRATION_INPUT: &str = ".migration-input.json";

#[derive(Deserialize, Serialize)]
struct MigrationInput {
    legacy: String,
    source_hash: String,
}

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
    pub store: Arc<BookStore>,
    pub(crate) lookup: LookupIndex,
    pub(crate) lookup_generation: String,
    pub generation: String,
    pub info: Value,
    pub stats: Value,
    pub inpx_hash: String,
    pub index_update: Value,
    pub created: bool,
    pub(crate) overview_cache: Mutex<crate::catalog_overview::ShelfCache>,
    pub(crate) recommendation_cache: Mutex<crate::catalog_personal_overview::RecommendationCache>,
    pub(crate) rating_filter: Mutex<Option<Arc<crate::library_media::RatingIndex>>>,
    pub(crate) isbn_index: Option<Arc<crate::isbn_store::IsbnIndex>>,
    _lease: CatalogueLease,
}

pub struct CatalogueFiles {
    pub data: PathBuf,
    pub filter: PathBuf,
    pub low_memory: bool,
}

pub struct PreparedCatalogue(tempfile::TempDir);

enum PreviousCatalogue<'a> {
    Native(&'a str, &'a BookStore),
    Jemba(&'a Path),
}

impl CatalogueFiles {
    pub fn open_or_create(
        &self,
        sources: &[Source],
        mut report: impl FnMut(Value) -> Result<()>,
    ) -> Result<Catalogue> {
        fs::create_dir_all(&self.data)?;
        let _publishing = self.publication_lock()?;
        let directory = self.data.join("db");
        let previous = self.data.join("db.previous");
        if !directory.try_exists()? && previous.try_exists()? {
            fs::rename(&previous, &directory)?;
            atomic_file::sync_parent(&directory)?;
        }
        if !directory.try_exists()? {
            let stage = self.build(sources, None, &mut report)?;
            stage.validate(self.low_memory)?;
            if directory.try_exists()? {
                return Err("Catalogue was published by another process".into());
            }
            report(startup_step("publish", "Подключение готового индекса"))?;
            fs::rename(stage.0.path(), &directory)?;
            atomic_file::sync_parent(&directory)?;
            save_folder_caches(&directory);
            return Catalogue::open(&directory, self.low_memory, true);
        }
        let book_table = directory.join("book");
        if !directory.join(METADATA).try_exists()? && book_table.is_dir() {
            report(startup_step("migration", "Перенос каталога JembaDB → Redb"))?;
            let legacy = CatalogueLease::open(&directory)?;
            let pending = self.prepare_migration(sources, &book_table, &mut report)?;
            remove_previous(&previous)?;
            report(startup_step("publish", "Подключение готового индекса"))?;
            // Directory renames on Windows require closing the lease handle.
            drop(legacy);
            let catalogue = self.replace(&pending, &directory, &previous, true)?;
            return Ok(catalogue);
        }
        let resuming_publication =
            directory.join(MIGRATION_INPUT).is_file() && previous.join("book").is_dir();
        if resuming_publication {
            report(startup_step(
                "resume",
                "Открываю готовый индекс после прерванного переноса",
            ))?;
        }
        let catalogue = Catalogue::open(&directory, self.low_memory, resuming_publication)?;
        if resuming_publication {
            finish_publication(&directory, &previous);
        }
        Ok(catalogue)
    }

    fn prepare_migration(
        &self,
        sources: &[Source],
        book_table: &Path,
        report: &mut impl FnMut(Value) -> Result<()>,
    ) -> Result<PathBuf> {
        let pending = self.data.join(MIGRATION_READY);
        let legacy = legacy_revision(book_table)?;
        if pending.try_exists()? {
            let input: MigrationInput =
                serde_json::from_reader(File::open(pending.join(MIGRATION_INPUT))?)?;
            if input.legacy == legacy && input.source_hash == self.source_hash(sources)? {
                report(startup_step(
                    "resume",
                    "Использую готовый индекс после прерванного переноса",
                ))?;
                let (_, _, header) = Catalogue::load(&pending, self.low_memory)?;
                if header.inpx_hash != input.source_hash {
                    return Err(
                        "В готовом индексе и состоянии переноса указаны разные источники".into(),
                    );
                }
                return Ok(pending);
            }
            report(startup_step(
                "migration-reset",
                "Исходный каталог изменился. Построение нового индекса",
            ))?;
            fs::remove_dir_all(&pending)?;
        }
        let stage = self.build(
            sources,
            Some(PreviousCatalogue::Jemba(book_table)),
            &mut *report,
        )?;
        report(startup_step("validate", "Проверка готового индекса"))?;
        let (_, _, header) = Catalogue::load(stage.0.path(), self.low_memory)?;
        if legacy_revision(book_table)? != legacy {
            return Err("Таблица JembaDB изменилась во время переноса".into());
        }
        write_json(
            &stage.0.path().join(MIGRATION_INPUT),
            &MigrationInput {
                legacy,
                source_hash: header.inpx_hash,
            },
        )?;
        for entry in fs::read_dir(stage.0.path().join("facets"))? {
            File::options()
                .write(true)
                .open(entry?.path())?
                .sync_all()?;
        }
        atomic_file::sync_directory(&stage.0.path().join("facets"))?;
        atomic_file::sync_directory(stage.0.path())?;
        fs::rename(stage.0.path(), &pending)?;
        atomic_file::sync_parent(&pending)?;
        report(startup_step(
            "checkpoint",
            "Готовый индекс сохранён. При повторном запуске он будет использован снова",
        ))?;
        Ok(pending)
    }

    pub fn source_hash(&self, sources: &[Source]) -> Result<String> {
        Ok(collect(sources, &self.filter, None)?.1)
    }

    pub fn prepare(
        &self,
        sources: &[Source],
        previous_generation: &str,
        previous_store: &BookStore,
        report: impl FnMut(Value) -> Result<()>,
    ) -> Result<PreparedCatalogue> {
        let stage = self.build(
            sources,
            Some(PreviousCatalogue::Native(
                previous_generation,
                previous_store,
            )),
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
        match self.replace(stage.0.path(), &directory, &previous, false) {
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
        stage: &Path,
        directory: &Path,
        previous: &Path,
        created: bool,
    ) -> Result<Catalogue> {
        fs::rename(directory, previous)?;
        let mut moved = false;
        let mut synced = false;
        let install = (|| {
            fs::rename(stage, directory)?;
            moved = true;
            atomic_file::sync_parent(directory)?;
            synced = true;
            Catalogue::open(directory, self.low_memory, created)
        })();
        let catalogue = match install {
            Ok(catalogue) => catalogue,
            // A complete startup migration is already installed. Keep both
            // directories while another process holds the active catalogue.
            Err(error)
                if created
                    && synced
                    && error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|error| error.kind() == ErrorKind::WouldBlock) =>
            {
                return Err(error);
            }
            Err(error) => {
                let restore = (|| -> Result<()> {
                    if moved {
                        fs::rename(directory, stage)?;
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
        finish_publication(directory, previous);
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
        let (store, lookup, header) = Self::load(directory, low_memory)?;
        Ok(Self {
            store: Arc::new(store),
            lookup,
            lookup_generation: header.rust_lookup_generation,
            generation: header.rust_book_store_generation,
            info: header.inpx_info,
            stats: header.stats,
            inpx_hash: header.inpx_hash,
            index_update: header.index_update,
            created,
            overview_cache: Mutex::default(),
            recommendation_cache: Mutex::default(),
            rating_filter: Mutex::default(),
            isbn_index: None,
            _lease: lease,
        })
    }

    fn load(directory: &Path, low_memory: bool) -> Result<(BookStore, LookupIndex, Header)> {
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
        Ok((store, lookup, header))
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
        report(startup_step("sources", "Проверка источников каталога"))?;
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
            RecordFilter::compile(filter.filter.as_ref())?,
        );
        let incremental = previous_catalogue.is_some();
        let previous_store = match previous_catalogue {
            Some(PreviousCatalogue::Native(generation, previous_store)) => {
                let previous = self.data.join("db");
                let patch = store::stage_patch(stage.path(), &previous)?;
                request.set_previous(&previous, generation, patch);
                Some(previous_store)
            }
            Some(PreviousCatalogue::Jemba(book_table)) => {
                request.set_previous_jemba(book_table);
                None
            }
            None => None,
        };
        let summary =
            prepare_update_reporting(stage.path(), &request, previous_store, &mut report)?;
        let sizes = summary.counts.name_counts;
        let series = lookup_staging::publish_sorted(
            &stage.path().join(LOOKUP),
            &generation,
            sizes,
            self.low_memory,
            |table| match table {
                Some(table) => report(
                    json!({"job":"lookup order","jobMessage":format!("Сортировка поискового индекса ({table})"),
                    "jobStep":2,"progress":0}),
                ),
                None => report(
                    json!({"job":"lookup","jobMessage":"Запись поискового индекса в Redb","jobStep":2,"progress":0}),
                ),
            },
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
        // Return the indexer's temporary pages before this worker goes idle.
        #[cfg(all(target_os = "linux", target_env = "musl"))]
        unsafe {
            libmimalloc_sys::mi_collect(true);
        }
        Ok(PreparedCatalogue(stage))
    }
}

fn startup_step(job: &str, message: &str) -> Value {
    json!({"job":job,"jobMessage":message,"progress":0})
}

fn legacy_revision(book_table: &Path) -> Result<String> {
    let mut paths = fs::read_dir(book_table)?
        .map(|entry| Ok(entry?.path()))
        .collect::<io::Result<Vec<_>>>()?;
    paths.sort_unstable();
    let mut hash = Sha256::new();
    for path in paths {
        let name = path
            .file_name()
            .ok_or("missing legacy table file name")?
            .as_encoded_bytes();
        hash.update(name.len().to_le_bytes());
        hash.update(name);
        hash.update(crate::file_stamp::path_stamp(&path)?.to_string());
    }
    Ok(crypto_support::hex(&hash.finalize()))
}

fn finish_publication(directory: &Path, previous: &Path) {
    if let Err(error) = fs::remove_dir_all(previous) {
        eprintln!("Cannot remove previous catalogue: {error}");
    } else if let Err(error) = fs::remove_file(directory.join(MIGRATION_INPUT))
        && error.kind() != ErrorKind::NotFound
    {
        eprintln!("Cannot remove catalogue migration marker: {error}");
    }
    save_folder_caches(directory);
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
    let mut inputs = Vec::new();
    for (index, source) in sources.iter().enumerate() {
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
