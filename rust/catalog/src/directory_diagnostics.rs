use std::ffi::{OsStr, OsString};
use std::fs::{self, DirEntry, Metadata};
use std::io::{self, BufRead, Write};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::framed_protocol::{Frames, header, reply};

mod cleanup;

const INPX_LIMIT: usize = 20;
const ARCHIVE_LIMIT: usize = 20_000;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    Sizes {
        directories: Vec<Directory>,
    },
    Source {
        directory: PathBuf,
        inpx: PathBuf,
    },
    RotateCache {
        directory: PathBuf,
        max_size: f64,
        target_size: f64,
        force_target: bool,
    },
    PurgeBrokenCovers {
        directory: PathBuf,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    path: PathBuf,
    max_files: usize,
}

#[derive(Default, Serialize)]
pub struct Size {
    pub exists: bool,
    pub size: u64,
    pub files: usize,
    pub truncated: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    inpx_exists: bool,
    lib_dir_exists: bool,
    found_inpx: Vec<PathBuf>,
    archive_count: usize,
    archive_count_truncated: bool,
    has_covers: bool,
    has_etc: bool,
    has_images: bool,
    has_bin: bool,
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    while let Some(request) = header::<Request>(&mut input)? {
        match execute(request) {
            Ok(bytes) => Frames(&mut output).write_all(&bytes)?,
            Err(error) => {
                reply(&mut output, Err(error))?;
                continue;
            }
        }
        reply(&mut output, Ok(()))?;
    }
    Ok(())
}

fn execute(request: Request) -> Result<Vec<u8>> {
    let bytes = match request {
        Request::Sizes { directories } => {
            let sizes: Vec<_> = directories.iter().map(size).collect();
            serde_json::to_vec(&sizes)
        }
        Request::Source { directory, inpx } => serde_json::to_vec(&source(&directory, &inpx)),
        Request::RotateCache {
            directory,
            max_size,
            target_size,
            force_target,
        } => serde_json::to_vec(&cleanup::rotate(
            &directory,
            max_size,
            target_size,
            force_target,
        )?),
        Request::PurgeBrokenCovers { directory } => {
            serde_json::to_vec(&cleanup::purge_covers(&directory)?)
        }
    }?;
    Ok(bytes)
}

pub(crate) fn ordered_entries(
    dir: &Path,
) -> io::Result<impl Iterator<Item = io::Result<(OsString, DirEntry)>>> {
    let entries = fs::read_dir(dir)?.map(|entry| entry.map(|entry| (entry.file_name(), entry)));
    #[cfg(unix)]
    let entries = {
        // libuv sorts by filename bytes on Unix and uses filesystem order on Windows.
        let mut entries: Vec<_> = entries.collect::<io::Result<_>>()?;
        entries.sort_unstable_by(|a, b| a.0.as_encoded_bytes().cmp(b.0.as_encoded_bytes()));
        entries.into_iter().map(Ok)
    };
    Ok(entries)
}

fn visit_dir(
    dir: &Path,
    mut visit: impl FnMut(&OsStr, DirEntry) -> ControlFlow<()>,
) -> ControlFlow<()> {
    let Ok(entries) = ordered_entries(dir) else {
        return ControlFlow::Continue(());
    };
    for (name, entry) in entries.flatten() {
        visit(&name, entry)?;
    }
    ControlFlow::Continue(())
}

fn size(directory: &Directory) -> Size {
    measure(&directory.path, directory.max_files, |_| true)
}

pub fn measure(root: &Path, max_files: usize, include: impl Fn(&OsStr) -> bool) -> Size {
    let mut result = Size {
        exists: root.exists(),
        ..Size::default()
    };
    if !result.exists {
        return result;
    }
    let mut directories = vec![root.to_path_buf()];
    while let Some(dir) = directories.pop() {
        let stop = visit_dir(&dir, |name, entry| {
            // Node builds file paths from names decoded as UTF-8. Preserve that
            // lookup for old Unix directories with non-UTF-8 names.
            let lossy_name = name.to_str().is_none();
            let child = || dir.join(name.to_string_lossy().as_ref());
            let metadata = if lossy_name {
                fs::metadata(child()).map(|metadata| (metadata, true))
            } else {
                listed_metadata(&entry)
            };
            let Ok((metadata, follow)) = metadata else {
                return ControlFlow::Continue(());
            };
            if metadata.is_dir() {
                let child = child();
                if !follow || !links_to_ancestor(root, &dir, &child) {
                    directories.push(child);
                }
            } else {
                if !include(name) {
                    return ControlFlow::Continue(());
                }
                result.files += 1;
                result.size = result.size.saturating_add(metadata.len());
                if result.files >= max_files {
                    result.truncated = true;
                    return ControlFlow::Break(());
                }
            }
            ControlFlow::Continue(())
        });
        if stop.is_break() {
            break;
        }
    }
    result
}

fn listed_metadata(entry: &DirEntry) -> io::Result<(Metadata, bool)> {
    let metadata = entry.metadata()?;
    // NTFS junctions and symbolic links require a target lookup. Regular
    // Windows entries reuse metadata from directory enumeration.
    if needs_target_metadata(&metadata) {
        return Ok((fs::metadata(entry.path())?, true));
    }
    Ok((metadata, false))
}

#[cfg(windows)]
fn needs_target_metadata(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn needs_target_metadata(metadata: &Metadata) -> bool {
    metadata.is_symlink()
}

fn links_to_ancestor(root: &Path, parent: &Path, child: &Path) -> bool {
    child.canonicalize().is_ok_and(|target| {
        parent
            .ancestors()
            .take_while(|ancestor| ancestor.starts_with(root))
            .any(|ancestor| ancestor.canonicalize().is_ok_and(|path| path == target))
    })
}

fn source(root: &Path, inpx: &Path) -> Source {
    let mut result = Source {
        inpx_exists: inpx.exists(),
        lib_dir_exists: root.exists(),
        ..Source::default()
    };
    if !result.lib_dir_exists {
        return result;
    }
    result.has_covers = root.join("covers").exists();
    result.has_etc = root.join("etc").exists();
    result.has_images = root.join("images").exists();
    result.has_bin = root.join("bin").exists();
    let mut directories = vec![root.to_owned()];
    while let Some(dir) = directories.pop() {
        let stop = visit_dir(&dir, |name, entry| {
            let Ok(kind) = entry.file_type() else {
                return ControlFlow::Continue(());
            };
            if kind.is_dir() {
                directories.push(dir.join(name.to_string_lossy().as_ref()));
                return ControlFlow::Continue(());
            }
            let Some(ext) = Path::new(name).extension() else {
                return ControlFlow::Continue(());
            };
            if result.found_inpx.len() < INPX_LIMIT && ext.eq_ignore_ascii_case("inpx") {
                let relative = dir.strip_prefix(root).expect("directory inside source");
                result
                    .found_inpx
                    .push(relative.join(name.to_string_lossy().as_ref()));
            }
            if result.archive_count < ARCHIVE_LIMIT
                && ["zip", "7z", "fb2", "epub"]
                    .iter()
                    .any(|candidate| ext.eq_ignore_ascii_case(candidate))
            {
                result.archive_count += 1;
                result.archive_count_truncated = result.archive_count == ARCHIVE_LIMIT;
            }
            if result.found_inpx.len() == INPX_LIMIT && result.archive_count_truncated {
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        });
        if stop.is_break() {
            break;
        }
    }
    result
}

pub fn diagnose(directory: &Path, inpx: &Path) -> Result<serde_json::Value> {
    let mut report = source(directory, inpx);
    for path in &mut report.found_inpx {
        *path = directory.join(&*path);
    }
    Ok(serde_json::to_value(report)?)
}

pub fn rotate_cache(
    directory: &Path,
    max: f64,
    target: f64,
    force: bool,
    include: impl Fn(&str) -> bool,
) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(cleanup::rotate_filtered(
        directory, max, target, force, include,
    )?)?)
}

pub fn purge_cover_cache(directory: &Path, native: bool) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(cleanup::purge_filtered(
        directory, native,
    )?)?)
}
