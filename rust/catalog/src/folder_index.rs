use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;
use tempfile::{NamedTempFile, TempPath};

use crate::book_archive::Failure;
use crate::folder_inventory::{Entry, visit_inventory};
use crate::folder_record::{self, BookPath, Metadata};
use crate::framed_protocol::{Frames, header, reply, with_body};
use crate::{Result, atomic_file};

const MAX_BATCH: usize = 512;
const MAX_MESSAGE_BYTES: u64 = 16 * 1024 * 1024;
const CACHE_STAGE: &str = ".folder-cache";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    root: String,
    source_id: String,
    cache: PathBuf,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Command {
    Batch { bytes: u64 },
    Fill { index: usize, bytes: u64 },
    Commit,
}

#[derive(Deserialize, Serialize)]
struct CachedBook {
    relative: String,
    size: u64,
    modified: f64,
    record: Box<RawValue>,
    #[serde(skip)]
    seen: bool,
}

pub(crate) struct FolderCache {
    config: Open,
    original: Option<String>,
    rows: HashMap<String, CachedBook>,
    dirty: bool,
    pending: HashMap<usize, Entry>,
}

impl FolderCache {
    pub(crate) fn open(root: String, source_id: String, cache: PathBuf) -> Result<Self> {
        let config = Open {
            root,
            source_id,
            cache,
        };
        let original = atomic_file::current_stamp(&config.cache)?;
        let saved = if original.is_some() {
            fs::read(&config.cache)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        } else {
            None
        };
        Ok(Self {
            config,
            original,
            dirty: saved.is_none(),
            rows: saved.unwrap_or_default(),
            pending: HashMap::new(),
        })
    }

    fn store(&mut self, file: &Entry, path: &BookPath<'_>, metadata: &Metadata) -> Result<()> {
        let record = folder_record::encode(
            &self.config.root,
            &self.config.source_id,
            file,
            path,
            metadata,
        )?;
        self.rows.insert(
            file.relative.clone(),
            CachedBook {
                relative: file.relative.clone(),
                size: file.size,
                modified: file.modified,
                record,
                seen: true,
            },
        );
        self.dirty = true;
        Ok(())
    }

    pub(crate) fn prepare(&mut self, file: &Entry) -> Result<bool> {
        let path = BookPath::new(&file.relative)?;
        if let Some(cached) = self.rows.get_mut(&file.relative)
            && cached.size == file.size
            && cached.modified == file.modified
            && cached.record.get().starts_with('{')
        {
            cached.seen = true;
            return Ok(true);
        }
        match folder_record::read(Path::new(&self.config.root), file, &path) {
            Ok(metadata) => {
                self.store(file, &path, &metadata)?;
                Ok(true)
            }
            Err(
                Failure::Unsupported
                | Failure::DecoderMemory { .. }
                | Failure::Missing
                | Failure::Other(_),
            ) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn record(&self, relative: &str) -> Result<&RawValue> {
        self.rows
            .get(relative)
            .map(|cached| cached.record.as_ref())
            .ok_or_else(|| "missing prepared folder record".into())
    }

    fn batch(&mut self, files: Vec<Entry>, output: &mut impl Write) -> Result<()> {
        if !self.pending.is_empty() || files.is_empty() || files.len() > MAX_BATCH {
            return Err("invalid folder index batch".into());
        }
        for (index, file) in files.iter().enumerate() {
            if !self.prepare(file)? {
                self.pending.insert(
                    index,
                    Entry {
                        relative: file.relative.clone(),
                        size: file.size,
                        modified: file.modified,
                    },
                );
            }
        }
        let records: Vec<_> = files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                if self.pending.contains_key(&index) {
                    None
                } else {
                    Some(&self.rows[&file.relative].record)
                }
            })
            .collect();
        write_records(output, &records)
    }

    fn fill(&mut self, index: usize, metadata: Metadata, output: &mut impl Write) -> Result<()> {
        let file = self
            .pending
            .remove(&index)
            .ok_or("unexpected folder metadata")?;
        let path = BookPath::new(&file.relative)?;
        self.store(&file, &path, &metadata)?;
        write_records(output, &self.rows[&file.relative].record)
    }

    fn has_changes(&mut self) -> Result<bool> {
        if !self.pending.is_empty() {
            return Err("missing folder metadata".into());
        }
        let count = self.rows.len();
        self.rows.retain(|_, row| row.seen);
        Ok(self.dirty || self.rows.len() != count)
    }

    fn write(&self, file: &mut File) -> Result<()> {
        let mut writer = BufWriter::with_capacity(128 * 1024, file);
        serde_json::to_writer(&mut writer, &self.rows)?;
        writer.flush()?;
        Ok(())
    }

    pub(crate) fn commit(&mut self) -> Result<()> {
        if !self.has_changes()? {
            return Ok(());
        }
        let path = &self.config.cache;
        let parent = path.parent().ok_or("missing folder cache parent")?;
        fs::create_dir_all(parent)?;
        let mut temporary = NamedTempFile::new_in(parent)?;
        self.write(temporary.as_file_mut())?;
        // Another completed scan may have published its cache while this index was being prepared.
        atomic_file::publish(temporary, path, self.original.as_deref())?;
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct CacheUpdate {
    cache: PathBuf,
    original: Option<String>,
}

pub(crate) struct CacheStaging {
    directory: PathBuf,
    updates: Vec<CacheUpdate>,
}

impl CacheStaging {
    pub(crate) fn new(directory: &Path) -> Self {
        Self {
            directory: directory.join(CACHE_STAGE),
            updates: Vec::new(),
        }
    }

    pub(crate) fn stage(&mut self, mut cache: FolderCache) -> Result<()> {
        if cache.has_changes()? {
            fs::create_dir_all(&self.directory)?;
            let staged = self.directory.join(format!("{}.json", self.updates.len()));
            let mut file = NamedTempFile::new_in(&self.directory)?;
            cache.write(file.as_file_mut())?;
            file.persist_noclobber(staged)?;
            self.updates.push(CacheUpdate {
                cache: cache.config.cache,
                original: cache.original,
            });
        }
        Ok(())
    }

    pub(crate) fn finish(&self) -> Result<()> {
        if !self.updates.is_empty() {
            let file = File::create_new(self.directory.join("changes.json"))?;
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(&mut writer, &self.updates)?;
            writer.flush()?;
        }
        Ok(())
    }
}

pub fn publish_staged(directory: &Path) -> Result<()> {
    let directory = directory.join(CACHE_STAGE);
    let updates: Vec<CacheUpdate> =
        serde_json::from_slice(&fs::read(directory.join("changes.json"))?)?;
    for (index, update) in updates.into_iter().enumerate() {
        let stage = directory.join(format!("{index}.json"));
        let file = OpenOptions::new().read(true).write(true).open(&stage)?;
        let temporary = NamedTempFile::from_parts(file, TempPath::try_from_path(stage)?);
        let parent = update.cache.parent().ok_or("missing folder cache parent")?;
        fs::create_dir_all(parent)?;
        atomic_file::publish(temporary, &update.cache, update.original.as_deref())?;
    }
    Ok(())
}

fn write_records(output: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let mut writer = BufWriter::with_capacity(128 * 1024, Frames(output));
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    Ok(())
}

fn payload<T: DeserializeOwned>(input: &mut impl BufRead, bytes: u64) -> Result<T> {
    if bytes > MAX_MESSAGE_BYTES {
        return Err("folder index request is too large".into());
    }
    with_body(input, bytes, |body| {
        let mut data = Vec::with_capacity(bytes as usize);
        std::io::Read::read_to_end(body, &mut data)?;
        Ok(serde_json::from_slice(&data)?)
    })?
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let Open {
        root,
        source_id,
        cache,
    } = header(&mut input)?.ok_or("missing folder index configuration")?;
    let mut cache = match FolderCache::open(root, source_id, cache) {
        Ok(cache) => cache,
        Err(error) => return reply(&mut output, Err(error)),
    };
    let mut files = Vec::new();
    if let Err(error) = visit_inventory(Path::new(&cache.config.root), |entry| {
        files.push(entry);
        Ok(())
    }) {
        return reply(&mut output, Err(error));
    }
    write_records(&mut output, &files)?;
    drop(files);
    reply(&mut output, Ok(()))?;
    while let Some(command) = header::<Command>(&mut input)? {
        let result = match command {
            Command::Batch { bytes } => {
                payload(&mut input, bytes).and_then(|files| cache.batch(files, &mut output))
            }
            Command::Fill { index, bytes } => payload(&mut input, bytes)
                .and_then(|metadata| cache.fill(index, metadata, &mut output)),
            Command::Commit => return reply(&mut output, cache.commit()),
        };
        let failed = result.is_err();
        reply(&mut output, result)?;
        if failed {
            break;
        }
    }
    Ok(())
}
