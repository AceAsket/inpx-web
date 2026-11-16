use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::{fmt::Write as _, fs::File};

use serde::Serialize;
use tempfile::TempDir;

use crate::Result;

const PARTITIONS: usize = 64;
const BUFFER_BYTES: usize = 32 * 1024;
const DELETED_BIT: u32 = 1 << 31;
const MAX_KEY_BYTES: usize = 1024 * 1024;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTotals {
    pub(crate) files_count: usize,
    pub(crate) files_del_count: usize,
}

pub(crate) enum FileCounter {
    Memory {
        live: HashSet<String>,
        deleted: HashSet<String>,
    },
    Disk(Partitions),
}

impl Default for FileCounter {
    fn default() -> Self {
        Self::Memory {
            live: HashSet::new(),
            deleted: HashSet::new(),
        }
    }
}

impl FileCounter {
    pub fn new(directory: &Path, low_memory: bool) -> Result<Self> {
        if low_memory {
            Ok(Self::Disk(Partitions::new(directory)?))
        } else {
            Ok(Self::default())
        }
    }

    pub fn add(&mut self, folder: &str, file: &str, ext: &str, deleted: bool) -> Result<()> {
        match self {
            Self::Memory {
                live,
                deleted: removed,
            } => {
                let set = if deleted { removed } else { live };
                set.insert(format!("{folder}/{file}.{ext}"));
                Ok(())
            }
            Self::Disk(partitions) => partitions.add(folder, file, ext, deleted),
        }
    }

    pub fn finish(self) -> Result<FileTotals> {
        match self {
            Self::Memory { live, deleted } => Ok(FileTotals {
                files_count: live.len(),
                files_del_count: deleted.difference(&live).count(),
            }),
            Self::Disk(partitions) => partitions.finish(),
        }
    }
}

pub(crate) struct Partitions {
    directory: TempDir,
    hash: RandomState,
    key: String,
    writers: Vec<Option<BufWriter<File>>>,
}

impl Partitions {
    fn new(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            directory: tempfile::Builder::new()
                .prefix(".catalogue-files-")
                .tempdir_in(directory)?,
            hash: RandomState::new(),
            key: String::new(),
            writers: (0..PARTITIONS).map(|_| None).collect(),
        })
    }

    fn path(&self, index: usize) -> PathBuf {
        self.directory.path().join(index.to_string())
    }

    fn add(&mut self, folder: &str, file: &str, ext: &str, deleted: bool) -> Result<()> {
        self.key.clear();
        write!(&mut self.key, "{folder}/{file}.{ext}")?;
        let key = self.key.as_bytes();
        if key.len() > MAX_KEY_BYTES {
            return Err("catalogue file path is too long".into());
        }
        let index = (self.hash.hash_one(key) % PARTITIONS as u64) as usize;
        if self.writers[index].is_none() {
            let file = File::create_new(self.path(index))?;
            self.writers[index] = Some(BufWriter::with_capacity(BUFFER_BYTES, file));
        }
        let writer = self.writers[index].as_mut().expect("partition opened");
        let header = (key.len() as u32) | if deleted { DELETED_BIT } else { 0 };
        writer.write_all(&header.to_le_bytes())?;
        writer.write_all(key)?;
        Ok(())
    }

    fn finish(mut self) -> Result<FileTotals> {
        // Close every buffered writer before opening a reader. Only one partition's
        // keys are held in memory at any time.
        let mut present = Vec::with_capacity(PARTITIONS);
        for (index, writer) in self.writers.iter_mut().enumerate() {
            if let Some(mut writer) = writer.take() {
                writer.flush()?;
                present.push(index);
            }
        }
        let mut totals = FileTotals::default();
        for index in present {
            let (live, deleted) = count_partition(&self.path(index))?;
            totals.files_count += live;
            totals.files_del_count += deleted;
        }
        Ok(totals)
    }
}

fn count_partition(path: &Path) -> Result<(usize, usize)> {
    let mut input = BufReader::with_capacity(BUFFER_BYTES, File::open(path)?);
    let mut flags = HashMap::<Box<[u8]>, bool>::new();
    let mut key = Vec::new();
    while !input.fill_buf()?.is_empty() {
        let mut header = [0; 4];
        input.read_exact(&mut header)?;
        let header = u32::from_le_bytes(header);
        let deleted = header & DELETED_BIT != 0;
        let count = (header & !DELETED_BIT) as usize;
        if count > MAX_KEY_BYTES {
            return Err("invalid catalogue file partition".into());
        }
        key.resize(count, 0);
        input.read_exact(&mut key)?;
        if let Some(flag) = flags.get_mut(key.as_slice()) {
            // A live record takes precedence over any deleted copy of the same file.
            *flag &= deleted;
        } else {
            flags.insert(key.as_slice().into(), deleted);
        }
    }
    let deleted = flags.values().filter(|&&removed| removed).count();
    Ok((flags.len() - deleted, deleted))
}
