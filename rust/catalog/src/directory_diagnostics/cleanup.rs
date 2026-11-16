use std::fs::{self, Metadata};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::folder_inventory::modified_ms;

use super::{listed_metadata, ordered_entries};

const LOGGED_FAILURES: usize = 32;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rotation {
    exists: bool,
    found: usize,
    removed: usize,
    size: u64,
    after: u64,
    over_limit: bool,
    failed: usize,
    failures: Vec<Failure>,
}

#[derive(Serialize)]
struct Failure {
    name: String,
    error: String,
}

#[derive(Default, Serialize)]
pub(super) struct CoverRepair {
    checked: usize,
    removed: usize,
}

struct CacheFile {
    name: String,
    stamp: Stamp,
}

#[derive(PartialEq, Eq)]
struct Stamp {
    bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64),
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}

impl Stamp {
    fn read(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        Self {
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: (metadata.dev(), metadata.ino()),
            #[cfg(not(unix))]
            created: metadata.created().ok(),
        }
    }
}

enum Removed {
    Unlinked,
    Missing,
    Changed,
}

impl CacheFile {
    fn remove(&self, directory: &Path) -> io::Result<Removed> {
        let path = directory.join(&self.name);
        // A download may have published a replacement after the scan. Check
        // the observed file again, and only unlink a single directory entry.
        let current = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Removed::Missing),
            Err(error) => return Err(error),
        };
        if current.is_dir() || Stamp::read(&current) != self.stamp {
            return Ok(Removed::Changed);
        }
        match fs::remove_file(path) {
            Ok(()) => Ok(Removed::Unlinked),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Removed::Missing),
            Err(error) => Err(error),
        }
    }
}

fn scan(
    directory: &Path,
    skip_unreadable_files: bool,
    mut visit: impl FnMut(String, Metadata),
) -> io::Result<Option<PathBuf>> {
    if !directory.exists() {
        return Ok(None);
    }
    // Resolve a configured directory alias once so a retargeted link cannot
    // move the cleanup to another physical directory during the scan.
    let root = directory.canonicalize()?;
    for entry in ordered_entries(&root)? {
        let (name, entry) = entry?;
        let Ok(name) = name.into_string() else {
            if skip_unreadable_files {
                continue;
            }
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "В кэше обнаружено имя файла с недопустимой кодировкой",
            ));
        };
        let metadata = match listed_metadata(&entry) {
            Ok((metadata, _)) => metadata,
            Err(_) if skip_unreadable_files => continue,
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("{}: {error}", directory.join(&name).display()),
                ));
            }
        };
        if !metadata.is_dir() {
            visit(name, metadata);
        }
    }
    Ok(Some(root))
}

pub(super) fn rotate(
    directory: &Path,
    max_size: f64,
    target_size: f64,
    force_target: bool,
) -> io::Result<Rotation> {
    if !max_size.is_finite() || !(0.0..=max_size).contains(&target_size) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Некорректные лимиты кэша",
        ));
    }
    let mut result = Rotation::default();
    let mut files = Vec::new();
    let Some(root) = scan(directory, false, |name, metadata| {
        let stamp = Stamp::read(&metadata);
        result.size = result.size.saturating_add(stamp.bytes);
        files.push(CacheFile { name, stamp });
    })?
    else {
        return Ok(result);
    };
    result.exists = true;
    result.found = files.len();
    result.after = result.size;
    result.over_limit = result.size as f64 > max_size;
    if !(result.over_limit || force_target) || result.size as f64 <= target_size {
        return Ok(result);
    }

    // Sort only when a deletion is due. A stable sort preserves the listing
    // order used by Node when modification timestamps compare equal.
    let mtime = |file: &CacheFile| file.stamp.modified.map_or(0.0, modified_ms);
    files.sort_by(|left, right| mtime(left).total_cmp(&mtime(right)));
    let mut planned = result.size;
    for file in files {
        if planned as f64 <= target_size {
            break;
        }
        let bytes = file.stamp.bytes;
        planned = planned.saturating_sub(bytes);
        match file.remove(&root) {
            Ok(Removed::Unlinked) => {
                result.removed += 1;
                result.after = result.after.saturating_sub(bytes);
            }
            Ok(Removed::Missing) => result.after = result.after.saturating_sub(bytes),
            Ok(Removed::Changed) => {}
            Err(error) => {
                result.failed += 1;
                if result.failures.len() < LOGGED_FAILURES {
                    result.failures.push(Failure {
                        name: file.name,
                        error: error.to_string(),
                    });
                }
            }
        }
    }
    Ok(result)
}

pub(super) fn purge_covers(directory: &Path) -> io::Result<CoverRepair> {
    let mut result = CoverRepair::default();
    let mut broken = Vec::new();
    let Some(root) = scan(directory, true, |name, metadata| {
        result.checked += 1;
        let allowed = Path::new(&name).extension().is_some_and(|ext| {
            ["png", "jpg", "gif"]
                .iter()
                .any(|kind| ext.eq_ignore_ascii_case(kind))
        });
        if metadata.len() == 0 || !allowed {
            broken.push(CacheFile {
                name,
                stamp: Stamp::read(&metadata),
            });
        }
    })?
    else {
        return Ok(result);
    };
    for file in broken {
        if matches!(file.remove(&root)?, Removed::Unlinked) {
            result.removed += 1;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_replaced_after_scan_is_kept() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("cover.jpg");
        fs::write(&path, [])?;
        let original = CacheFile {
            name: "cover.jpg".into(),
            stamp: Stamp::read(&fs::metadata(&path)?),
        };
        fs::write(&path, b"new cover")?;
        assert!(matches!(original.remove(dir.path())?, Removed::Changed));
        assert_eq!(fs::read(path)?, b"new cover");
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn failed_unlink_keeps_bytes_in_report_and_does_not_remove_extra_files() -> io::Result<()> {
        use std::fs::{File, OpenOptions};
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::Duration;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let dir = tempfile::tempdir()?;
        let old = dir.path().join("old.cache");
        let new = dir.path().join("new.cache");
        fs::write(&old, b"old!")?;
        fs::write(&new, b"new!")?;
        File::options()
            .write(true)
            .open(&old)?
            .set_modified(SystemTime::now() - Duration::from_secs(60))?;
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&old)?;
        let result = rotate(dir.path(), 5.0, 4.0, false)?;
        assert_eq!(
            (result.size, result.after, result.removed, result.failed),
            (8, 8, 0, 1)
        );
        assert_eq!(result.failures[0].name, "old.cache");
        assert_eq!(fs::read(&new)?, b"new!");
        drop(locked);
        assert_eq!(fs::read(&old)?, b"old!");
        Ok(())
    }
}
