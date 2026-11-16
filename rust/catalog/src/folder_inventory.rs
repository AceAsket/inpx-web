use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::Result;

const BATCH_SIZE: usize = 512;

#[derive(Deserialize, Serialize)]
pub(crate) struct Entry {
    pub relative: String,
    pub size: u64,
    pub modified: f64,
}

// Match Node's Stats.mtimeMs so existing fingerprints and folder caches are reusable.
pub(crate) fn modified_ms(time: SystemTime) -> f64 {
    let nanos = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    nanos.div_euclid(1_000_000_000) as f64 * 1000.0
        + nanos.rem_euclid(1_000_000_000) as f64 / 1_000_000.0
}

pub(crate) fn book_name(name: &str) -> bool {
    let name = name.as_bytes();
    [b".fb2".as_slice(), b".epub".as_slice()]
        .into_iter()
        .any(|suffix| {
            name.len() >= suffix.len()
                && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        })
}

pub(crate) fn visit_inventory(
    root: &Path,
    mut visit: impl FnMut(Entry) -> Result<()>,
) -> Result<()> {
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| io::Error::new(error.kind(), format!("{}: {error}", dir.display())))?;
        for entry in entries {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                dirs.push(entry.path());
                continue;
            }
            if !kind.is_file() || !book_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            // Windows DirEntry supplies size and timestamps from the directory enumeration.
            let metadata = entry.metadata()?;
            let relative = entry.path();
            visit(Entry {
                relative: relative
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                size: metadata.len(),
                modified: modified_ms(metadata.modified()?),
            })?;
        }
    }
    Ok(())
}

pub fn write_inventory(root: &Path, mut output: impl Write) -> Result<()> {
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    visit_inventory(root, |entry| {
        batch.push(entry);
        if batch.len() == BATCH_SIZE {
            serde_json::to_writer(&mut output, &batch)?;
            output.write_all(b"\n")?;
            batch.clear();
        }
        Ok(())
    })?;
    if !batch.is_empty() {
        serde_json::to_writer(&mut output, &batch)?;
        output.write_all(b"\n")?;
    }
    output.flush()?;
    Ok(())
}
