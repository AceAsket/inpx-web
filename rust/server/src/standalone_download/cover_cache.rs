use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use inpx_catalog::reader_document::Image;

const CAPACITY: usize = 1024;
const FOUND_TTL: Duration = Duration::from_secs(600);
const MISSING_TTL: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub(super) struct CoverFile {
    pub path: PathBuf,
    pub content_type: &'static str,
    len: u64,
    modified: SystemTime,
}

impl CoverFile {
    pub(super) fn stage(image: Image, directory: &Path) -> inpx_catalog::Result<Self> {
        let path = image.stage(directory)?;
        let meta = fs::symlink_metadata(&path)?;
        Ok(Self {
            path,
            content_type: image.content_type,
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
    expires: Instant,
    file: Option<CoverFile>,
}

#[derive(Default)]
pub(super) struct CoverCache {
    rows: VecDeque<Entry>,
    pub epoch: u64,
}

impl CoverCache {
    pub(super) fn get(&self, generation: u64, uid: &str) -> Option<Option<CoverFile>> {
        let now = Instant::now();
        self.rows
            .iter()
            .find(|e| e.generation == generation && e.uid == uid && e.expires > now)
            .map(|entry| entry.file.clone())
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
            expires: Instant::now()
                + if file.is_some() {
                    FOUND_TTL
                } else {
                    MISSING_TTL
                },
            file,
        });
        self.rows.truncate(CAPACITY);
    }

    pub(super) fn clear(&mut self) {
        self.rows.clear();
        self.epoch = self.epoch.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cover_expires_and_cannot_survive_reindex_or_clear() {
        let mut cache = CoverCache::default();
        let epoch = cache.epoch;
        cache.put(epoch, 1, "book", None);
        assert!(matches!(cache.get(1, "book"), Some(None)));
        assert!(cache.get(2, "book").is_none());
        cache.rows[0].expires = Instant::now();
        assert!(cache.get(1, "book").is_none());
        cache.clear();
        cache.put(epoch, 1, "book", None);
        assert!(cache.get(1, "book").is_none());
    }
}
