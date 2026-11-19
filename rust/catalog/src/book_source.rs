use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::directory_diagnostics::ordered_entries;

pub(crate) struct Input {
    pub file: File,
    pub path: PathBuf,
    pub member: Option<String>,
}

pub(crate) fn resolve(library: &Path, folder: &str, name: &str) -> io::Result<Input> {
    Folder::resolve(library, folder)?.open(member_name(name)?)
}

pub(crate) fn member_name(name: &str) -> io::Result<String> {
    let name = relative(name)?;
    Path::new(&name).file_name().ok_or_else(invalid)?;
    Ok(name)
}

pub(crate) struct Folder {
    root: PathBuf,
    pub(crate) path: PathBuf,
    pub(crate) archived: bool,
}

impl Folder {
    pub(crate) fn resolve(library: &Path, folder: &str) -> io::Result<Self> {
        let folder = relative(folder)?;
        let root = library.canonicalize()?;
        let path = archive_location(&root, &folder)?.ok_or_else(|| {
            io::Error::new(ErrorKind::NotFound, "Book folder or archive not found")
        })?;
        Ok(Self {
            archived: !path.is_dir(),
            path,
            root,
        })
    }

    pub(crate) fn open_archive(&self) -> io::Result<File> {
        open_within(&self.root, &self.path)
    }

    pub(crate) fn open(&self, name: String) -> io::Result<Input> {
        let (path, member) = if self.archived {
            (self.path.clone(), Some(name))
        } else {
            let path = existing(&self.root, &self.path.join(&name))?
                .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "Book file not found"))?;
            (path, None)
        };
        let file = open_within(&self.root, &path)?;
        Ok(Input { file, path, member })
    }
}

pub(crate) fn cover_inputs(library: &Path, folder: &str, file: &str) -> io::Result<Vec<Input>> {
    let folder = relative(folder)?;
    if folder.is_empty() {
        return Ok(vec![]);
    }
    let root = library.canonicalize()?;
    let archive = archive_location(&root, &folder)?.unwrap_or_else(|| root.join(folder));
    asset_inputs(&root, &archive, file, "covers")
}

pub(crate) fn fb2_inputs(
    library: &Path,
    folder: &str,
    file: &str,
    book: &Input,
) -> io::Result<(Vec<Input>, Vec<Input>)> {
    if folder.is_empty() {
        return Ok((vec![], vec![]));
    }
    let root = library.canonicalize()?;
    let archive = if book.member.is_some() {
        book.path.clone()
    } else {
        let folder = relative(folder)?;
        archive_location(&root, &folder)?.unwrap_or_else(|| root.join(folder))
    };
    Ok((
        asset_inputs(&root, &archive, file, "covers")?,
        asset_inputs(&root, &archive, file, "images")?,
    ))
}

fn asset_inputs(root: &Path, archive: &Path, file: &str, kind: &str) -> io::Result<Vec<Input>> {
    let file = relative(file)?;
    let Some(stem) = Path::new(&file).file_stem().and_then(|name| name.to_str()) else {
        return Ok(Vec::new());
    };
    let parent = root.parent().unwrap_or(root);
    let Some(archive_name) = archive.file_stem() else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    let mut visited = std::collections::HashSet::new();
    for directory in [
        archive.parent().unwrap_or(root).join(kind),
        root.join(kind),
        parent.join(kind),
    ] {
        let Ok(directory) = directory.canonicalize() else {
            continue;
        };
        if !directory.starts_with(parent) || !visited.insert(directory.clone()) {
            continue;
        }
        for ext in ["zip", "7z"] {
            let mut name = archive_name.to_os_string();
            name.push(".");
            name.push(ext);
            let path = directory.join(name);
            let Ok(Some(path)) = existing(parent, &path) else {
                continue;
            };
            if !path.is_file() {
                continue;
            }
            let Ok(file) = open_within(parent, &path) else {
                continue;
            };
            found.push(Input {
                file,
                path,
                member: Some(stem.into()),
            });
        }
    }
    Ok(found)
}
fn invalid() -> io::Error {
    io::Error::new(
        ErrorKind::PermissionDenied,
        "Путь выходит за пределы источника библиотеки",
    )
}

fn relative(value: &str) -> io::Result<String> {
    let value = value.replace('\\', "/");
    if value.starts_with('/')
        || value.bytes().any(|byte| byte == b':' || byte < 32)
        || value
            .split('/')
            .any(|part| part == ".." || cfg!(windows) && part != "." && part.ends_with(['.', ' ']))
    {
        return Err(invalid());
    }
    Ok(value)
}

pub(crate) fn within(root: &Path, path: PathBuf) -> io::Result<PathBuf> {
    if !path.starts_with(root) {
        return Err(invalid());
    }
    Ok(path)
}

fn recoverable(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

fn existing(root: &Path, candidate: &Path) -> io::Result<Option<PathBuf>> {
    match candidate.canonicalize() {
        Ok(path) => return within(root, path).map(Some),
        Err(error) if recoverable(&error) => {}
        Err(error) => return Err(error),
    }
    let Some((parent, name)) = candidate.parent().zip(candidate.file_name()) else {
        return Ok(None);
    };
    let parent = match parent.canonicalize() {
        Ok(parent) => within(root, parent)?,
        Err(error) if recoverable(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let name = name.to_string_lossy().to_lowercase();
    for entry in ordered_entries(&parent)? {
        let (actual, entry) = entry?;
        if actual.to_string_lossy().to_lowercase() == name {
            return within(root, entry.path().canonicalize()?).map(Some);
        }
    }
    Ok(None)
}

fn archive_location(root: &Path, folder: &str) -> io::Result<Option<PathBuf>> {
    let path = Path::new(folder);
    let candidate = root.join(path);
    if let Some(found) = archive_variant(root, &candidate)? {
        return Ok(Some(found));
    }
    let Some(name) = path.file_name() else {
        return Ok(None);
    };
    for subdir in ["", "fb2", "books", "archives"] {
        let directory = root.join(subdir);
        for relative in [path, Path::new(name)] {
            if let Some(found) = archive_variant(root, &directory.join(relative))? {
                return Ok(Some(found));
            }
        }
    }
    for entry in ordered_entries(root)? {
        let (subdir, entry) = entry?;
        // Asset archives deliberately share the name of their book archive.
        // Only an explicitly selected folder may resolve into an asset directory.
        if entry.file_type()?.is_dir()
            && !["fb2", "books", "archives", "images", "covers", "authors"]
                .iter()
                .any(|name| subdir.eq_ignore_ascii_case(name))
            && let Some(found) = archive_variant(root, &entry.path().join(name))?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn archive_variant(root: &Path, candidate: &Path) -> io::Result<Option<PathBuf>> {
    if let Some(found) = existing(root, candidate)? {
        return Ok(Some(found));
    }
    let extension = candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("zip") {
        existing(root, &candidate.with_extension("7z"))
    } else if extension.eq_ignore_ascii_case("7z") {
        existing(root, &candidate.with_extension("zip"))
    } else {
        Ok(None)
    }
}

#[cfg(unix)]
pub(crate) fn open_within(root: &Path, path: &Path) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    use std::path::Component;

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)?;
    let mut parts = path
        .strip_prefix(root)
        .map_err(|_| invalid())?
        .components()
        .peekable();
    while let Some(Component::Normal(part)) = parts.next() {
        let name = CString::new(part.as_bytes()).map_err(|_| invalid())?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if parts.peek().is_some() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // The parent handle stays open and each name is a single component.
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd == -1 {
            return Err(io::Error::last_os_error());
        }
        // A successful openat returns a new descriptor owned by the caller.
        file = unsafe { File::from_raw_fd(fd) };
    }
    regular(file)
}

#[cfg(windows)]
pub(crate) fn open_within(root: &Path, path: &Path) -> io::Result<File> {
    use std::ffi::OsString;
    use std::os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, GetFinalPathNameByHandleW,
    };

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    // A zero-length call returns the size needed for the path of this open handle.
    let size =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, 0) };
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0; size as usize];
    let used =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), size, 0) };
    if used == 0 || used >= size {
        return Err(invalid());
    }
    within(
        root,
        PathBuf::from(OsString::from_wide(&buffer[..used as usize])),
    )?;
    regular(file)
}

fn regular(file: File) -> io::Result<File> {
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    if !metadata.is_file() {
        return Err(io::Error::new(
            ErrorKind::NotFound,
            "Book source is not a regular file",
        ));
    }
    Ok(file)
}
