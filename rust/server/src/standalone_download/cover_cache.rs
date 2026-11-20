use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use hyper::body::Bytes;
use inpx_catalog::reader_document::Image;

const CAPACITY: usize = 1024;
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const MEMORY_TTL: Duration = Duration::from_secs(600);
const FOUND_TTL: Duration = Duration::from_secs(900);
const MISSING_TTL: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub(super) struct CoverFile {
    pub path: PathBuf,
    pub content_type: &'static str,
    pub bytes: Option<Bytes>,
    len: u64,
    pub modified: SystemTime,
}

impl CoverFile {
    pub(super) fn stage(image: Image, directory: &Path) -> inpx_catalog::Result<Self> {
        let path = image.stage(directory)?;
        let meta = fs::symlink_metadata(&path)?;
        Ok(Self {
            path,
            content_type: image.content_type,
            bytes: Some(Bytes::from(image.bytes.into_boxed_slice())),
            len: meta.len(),
            modified: meta.modified()?,
        })
    }

    pub(super) fn available(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok_and(|meta| {
            meta.is_file() && meta.len() == self.len && meta.modified().ok() == Some(self.modified)
        })
    }
}

struct Entry {
    generation: u64,
    uid: String,
    stored: Instant,
    file: Option<CoverFile>,
}

#[derive(Default)]
pub(super) struct CoverCache {
    rows: VecDeque<Entry>,
    pub epoch: u64,
}

impl CoverCache {
    pub(super) fn get(&mut self, generation: u64, uid: &str) -> Option<Option<CoverFile>> {
        let now = Instant::now();
        let index = self
            .rows
            .iter()
            .position(|e| e.generation == generation && e.uid == uid)?;
        let mut entry = self.rows.remove(index)?;
        if !entry.retain(now) {
            return None;
        }
        let file = entry.file.clone();
        self.rows.push_front(entry);
        Some(file)
    }

    pub(super) fn put(&mut self, epoch: u64, generation: u64, uid: &str, file: Option<CoverFile>) {
        // A request already reading an archive must not undo an admin cache clear.
        if self.epoch != epoch {
            return;
        }
        self.rows
            .retain(|e| e.generation != generation || e.uid != uid);
        self.rows.push_front(Entry {
            generation,
            uid: uid.to_owned(),
            stored: Instant::now(),
            file,
        });
        self.rows.truncate(CAPACITY);
        self.trim(MEMORY_LIMIT);
    }

    fn trim(&mut self, mut budget: usize) {
        self.expire();
        for row in &mut self.rows {
            if let Some(file) = &mut row.file
                && let Some(bytes) = &file.bytes
            {
                if bytes.len() <= budget {
                    budget -= bytes.len();
                } else {
                    file.bytes = None;
                }
            }
        }
    }

    pub(super) fn expire(&mut self) {
        let now = Instant::now();
        self.rows.retain_mut(|entry| entry.retain(now));
    }
    pub(super) fn clear(&mut self) {
        self.rows.clear();
        self.epoch = self.epoch.wrapping_add(1);
    }
}

impl Entry {
    fn retain(&mut self, now: Instant) -> bool {
        let age = now.duration_since(self.stored);
        if let Some(file) = &mut self.file {
            if age >= MEMORY_TTL {
                file.bytes = None;
            }
            age < FOUND_TTL
        } else {
            age < MISSING_TTL
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_images_fall_back_to_disk_after_expiry_or_memory_pressure() {
        let path = PathBuf::from("example.reader-cover");
        let file = CoverFile {
            path: path.clone(),
            content_type: "image/png",
            bytes: Some(Bytes::from_static(b"12345678")),
            len: 8,
            modified: SystemTime::UNIX_EPOCH,
        };
        let mut cache = CoverCache::default();
        cache.put(0, 1, "first", Some(file.clone()));
        cache.put(0, 1, "second", Some(file.clone()));
        assert!(cache.get(1, "first").unwrap().unwrap().bytes.is_some());
        cache.trim(8);
        assert!(cache.get(1, "first").unwrap().unwrap().bytes.is_some());
        let cold = cache.get(1, "second").unwrap().unwrap();
        assert!(cold.bytes.is_none());
        assert_eq!(cold.path, path);
        cache.put(0, 1, "book", Some(file));
        assert!(cache.get(2, "book").is_none());
        cache.rows[0].stored -= MEMORY_TTL;
        cache.expire();
        let cold = cache.get(1, "book").unwrap().unwrap();
        assert!(cold.bytes.is_none());
        assert_eq!(cold.path, path);
        cache.rows[0].stored -= FOUND_TTL - MEMORY_TTL;
        assert!(cache.get(1, "book").is_none());
    }

    #[test]
    fn missing_cover_expires_and_cannot_survive_reindex_or_clear() {
        let mut cache = CoverCache::default();
        let epoch = cache.epoch;
        cache.put(epoch, 1, "book", None);
        assert!(matches!(cache.get(1, "book"), Some(None)));
        assert!(cache.get(2, "book").is_none());
        cache.rows[0].stored -= MISSING_TTL;
        assert!(cache.get(1, "book").is_none());
        cache.clear();
        cache.put(epoch, 1, "book", None);
        assert!(cache.get(1, "book").is_none());
    }
}
