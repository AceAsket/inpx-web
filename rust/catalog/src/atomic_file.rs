use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;

use tempfile::NamedTempFile;

use crate::{Result, file_stamp::path_stamp};

pub(crate) fn current_stamp(path: &Path) -> Result<Option<String>> {
    match path_stamp(path) {
        Ok(current) => Ok(Some(current.to_string())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

// An expected stamp comes from the transaction which created the new contents.
// Check it after synchronizing the staging file, immediately before publication.
pub(crate) fn publish(
    temp: NamedTempFile,
    path: &Path,
    expected: Option<&str>,
) -> Result<Option<File>> {
    temp.as_file().sync_all()?;
    if current_stamp(path)?.as_deref() != expected {
        return Ok(None);
    }
    let installed = if expected.is_some() {
        temp.persist(path)?
    } else {
        match temp.persist_noclobber(path) {
            Ok(installed) => installed,
            Err(error) if error.error.kind() == ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    };
    sync_parent(path)?;
    Ok(Some(installed))
}

pub(crate) fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("missing parent directory")?)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
