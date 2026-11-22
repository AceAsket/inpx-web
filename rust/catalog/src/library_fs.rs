//! Files selected by Android's document picker are opened by the same-UID Java broker.
//! Other platforms retain the ordinary filesystem and its containment checks.
use std::ffi::OsString;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "android")]
#[path = "library_fs_android.rs"]
mod android;

pub(crate) fn virtual_path(path: &Path) -> bool {
    cfg!(target_os = "android") && path.starts_with("/__android_library__")
}

pub(crate) fn register_source(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        android::request("hello", path)?;
    }
    let _ = path;
    Ok(())
}

pub(crate) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        android::validate(path)?;
        let normalized: PathBuf = path.components().collect();
        android::request("stat", &normalized)?;
        return Ok(normalized);
    }
    fs::canonicalize(path)
}

pub(crate) fn is_dir(path: &Path) -> bool {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        return android::request("stat", path).is_ok_and(|(value, _)| value["directory"] == true);
    }
    path.is_dir()
}

pub(crate) fn is_file(path: &Path) -> bool {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        return android::request("stat", path).is_ok_and(|(value, _)| value["directory"] == false);
    }
    path.is_file()
}

pub(crate) fn open(path: &Path) -> io::Result<File> {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        return android::request("open", path)?
            .1
            .ok_or_else(|| io::Error::other("Missing storage descriptor"));
    }
    File::open(path)
}

pub(crate) enum Entry {
    Local(fs::DirEntry),
    #[cfg(target_os = "android")]
    Remote {
        path: PathBuf,
        directory: bool,
        metadata: Metadata,
    },
}
#[derive(Clone, Copy)]
pub(crate) enum FileType {
    Local(fs::FileType),
    #[cfg(target_os = "android")]
    Remote(bool),
}
impl FileType {
    pub fn is_dir(&self) -> bool {
        match self {
            Self::Local(kind) => kind.is_dir(),
            #[cfg(target_os = "android")]
            Self::Remote(dir) => *dir,
        }
    }
    pub fn is_file(&self) -> bool {
        match self {
            Self::Local(kind) => kind.is_file(),
            #[cfg(target_os = "android")]
            Self::Remote(dir) => !dir,
        }
    }
}
#[derive(Clone)]
pub(crate) struct Metadata {
    len: u64,
    modified: std::time::SystemTime,
}
impl Metadata {
    pub fn len(&self) -> u64 {
        self.len
    }
    pub fn modified(&self) -> io::Result<std::time::SystemTime> {
        Ok(self.modified)
    }
}
impl Entry {
    pub fn path(&self) -> PathBuf {
        match self {
            Self::Local(entry) => entry.path(),
            #[cfg(target_os = "android")]
            Self::Remote { path, .. } => path.clone(),
        }
    }
    pub fn file_name(&self) -> OsString {
        self.path().file_name().unwrap_or_default().into()
    }
    pub fn file_type(&self) -> io::Result<FileType> {
        match self {
            Self::Local(entry) => entry.file_type().map(FileType::Local),
            #[cfg(target_os = "android")]
            Self::Remote { directory, .. } => Ok(FileType::Remote(*directory)),
        }
    }
    pub fn metadata(&self) -> io::Result<Metadata> {
        match self {
            Self::Local(entry) => {
                let metadata = entry.metadata()?;
                Ok(Metadata {
                    len: metadata.len(),
                    modified: metadata.modified()?,
                })
            }
            #[cfg(target_os = "android")]
            Self::Remote { metadata, .. } => Ok(metadata.clone()),
        }
    }
}

pub(crate) fn ordered_entries(
    path: &Path,
) -> io::Result<std::vec::IntoIter<io::Result<(OsString, Entry)>>> {
    let mut entries = Vec::new();
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        let (value, _) = android::request("list", path)?;
        for value in value
            .as_array()
            .ok_or_else(|| io::Error::other("Invalid storage listing"))?
        {
            let name = value["name"]
                .as_str()
                .ok_or_else(|| io::Error::other("Missing document name"))?;
            if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
                return Err(io::Error::other("Invalid document name"));
            }
            entries.push((
                OsString::from(name),
                Entry::Remote {
                    path: path.join(name),
                    directory: value["directory"] == true,
                    metadata: Metadata {
                        len: value["size"].as_u64().unwrap_or_default(),
                        modified: std::time::UNIX_EPOCH
                            + std::time::Duration::from_millis(
                                value["modified"].as_u64().unwrap_or_default(),
                            ),
                    },
                },
            ));
        }
    } else {
        local_entries(path, &mut entries)?;
    }
    #[cfg(not(target_os = "android"))]
    local_entries(path, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries.into_iter().map(Ok).collect::<Vec<_>>().into_iter())
}

fn local_entries(path: &Path, entries: &mut Vec<(OsString, Entry)>) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        entries.push((entry.file_name(), Entry::Local(entry)));
    }
    Ok(())
}

pub(crate) fn source_stamp(path: &Path, file: &File) -> io::Result<crate::file_stamp::FileStamp> {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        return path_stamp(path);
    }
    let _ = path;
    crate::file_stamp::stamp(file)
}

pub(crate) fn path_stamp(path: &Path) -> io::Result<crate::file_stamp::FileStamp> {
    #[cfg(target_os = "android")]
    if virtual_path(path) {
        use std::hash::{Hash, Hasher};
        let (value, _) = android::request("stat", path)?;
        let mut key = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut key);
        return Ok(crate::file_stamp::FileStamp {
            inode: key.finish(),
            len: value["size"].as_u64().unwrap_or_default(),
            modified_ns: i128::from(value["modified"].as_u64().unwrap_or_default()) * 1_000_000,
        });
    }
    crate::file_stamp::path_stamp(path)
}
