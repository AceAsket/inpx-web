use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Cursor, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use zip::ZipArchive;

use crate::{Result, atomic_file, crypto_support};

const MARKER: &str = ".inpx-web-managed.json";
const VERSION_FILE: &str = "version.txt";
const INVALID_BUNDLE: &str = "Некорректный состав веб-приложения";
const LINK: &str = "Символическая ссылка в каталоге веб-приложения";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub public_dir: PathBuf,
    pub temp_dir: PathBuf,
    pub version: String,
    pub prefix: String,
    pub app_directory: String,
    pub bundle: String,
}

#[derive(Serialize)]
struct Manifest<'a> {
    version: &'a str,
    files: &'a [String],
}

pub fn install(options: Install) -> Result<()> {
    let Install {
        public_dir,
        temp_dir,
        version,
        prefix,
        app_directory,
        bundle,
    } = options;
    let digest = crypto_support::hex(&Sha256::digest(bundle.as_bytes()));
    let mut version = format!("{version}:{prefix}:{digest}");
    if !prefix.is_empty() {
        version.push_str(":prefixed-v1");
    }
    let marker = checked_path(&public_dir, MARKER)?;
    let previous = read_manifest(&marker)?;
    let old_files = previous.get("files").and_then(Value::as_array);
    if previous.get("version").and_then(Value::as_str) == Some(&version) && old_files.is_some() {
        return Ok(());
    }
    let mut zip = ZipArchive::new(Cursor::new(
        STANDARD.decode(bundle).map_err(|_| INVALID_BUNDLE)?,
    ))
    .map_err(|_| INVALID_BUNDLE)?;
    let mut files = Vec::new();
    let mut unique = HashSet::new();
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|_| INVALID_BUNDLE)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name();
        if !safe_name(name) || !unique.insert(comparison_key(name)) || entry.is_symlink() {
            return Err(INVALID_BUNDLE.into());
        }
        files.push((name.to_owned(), index));
    }
    if files.is_empty() {
        return Err(INVALID_BUNDLE.into());
    }
    let stale: Vec<_> = old_files
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| safe_name(name) && !unique.contains(&comparison_key(name)))
        .collect();
    let mut planned = unique.clone();
    let mut paths = Vec::with_capacity(files.len());
    for (name, _) in &files {
        let target = checked_path(&public_dir, name)?;
        require_file(&target)?;
        let flag = flag_name(name);
        if unique.contains(&comparison_key(&flag)) {
            return Err(INVALID_BUNDLE.into());
        }
        let rewrite = !prefix.is_empty()
            && matches!(
                Path::new(name).extension().and_then(|ext| ext.to_str()),
                Some("html" | "css" | "js")
            );
        let flag_path = checked_path(&public_dir, &flag)?;
        if rewrite {
            require_file(&flag_path)?;
            planned.insert(comparison_key(&flag));
        }
        paths.push((target, flag_path, rewrite));
    }
    if planned.iter().any(|name| {
        name.match_indices('/')
            .any(|(i, _)| planned.contains(&name[..i]))
    }) {
        return Err(INVALID_BUNDLE.into());
    }
    for name in &stale {
        checked_path(&public_dir, name)?;
        checked_path(&public_dir, &flag_name(name))?;
    }
    let version_file = checked_path(&public_dir, VERSION_FILE)?;
    require_file(&version_file)?;

    fs::create_dir_all(&temp_dir)?;
    let stage = tempfile::Builder::new()
        .prefix("webapp-")
        .tempdir_in(temp_dir)?;
    let pattern = format!("/{app_directory}");
    let replacement = format!("{prefix}{pattern}");
    for ((_, index), (_, _, rewrite)) in files.iter().zip(&paths) {
        let mut entry = zip.by_index(*index).map_err(|_| INVALID_BUNDLE)?;
        let staged = stage.path().join(index.to_string());
        let mut output = File::create_new(&staged)?;
        if *rewrite {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            let rewritten = String::from_utf8_lossy(&bytes).replace(&pattern, &replacement);
            output.write_all(rewritten.as_bytes())?;
        } else {
            io::copy(&mut entry, &mut output)?;
        }
    }

    for ((name, index), (path, flag, rewrite)) in files.iter().zip(paths) {
        checked_path(&public_dir, name)?;
        checked_path(&public_dir, &flag_name(name))?;
        write_atomic(&path, File::open(stage.path().join(index.to_string()))?)?;
        if rewrite {
            write_atomic(&flag, io::empty())?;
        } else {
            remove_file(&flag)?;
        }
    }
    for name in stale {
        remove_file(&checked_path(&public_dir, name)?)?;
        remove_file(&checked_path(&public_dir, &flag_name(name))?)?;
    }
    write_atomic(&version_file, version.as_bytes())?;
    let names: Vec<_> = files.into_iter().map(|(name, _)| name).collect();
    let manifest = serde_json::to_vec(&Manifest {
        version: &version,
        files: &names,
    })?;
    write_atomic(&marker, &manifest[..])
}

fn read_manifest(path: &Path) -> Result<Value> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error.into()),
    };
    let input = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    Ok(serde_json::from_slice(input).unwrap_or(Value::Null))
}

fn comparison_key(name: &str) -> String {
    #[cfg(windows)]
    let name = name.to_lowercase();
    #[cfg(not(windows))]
    let name = name.to_owned();
    name
}

fn safe_name(name: &str) -> bool {
    !matches!(comparison_key(name).as_str(), MARKER | VERSION_FILE)
        && !name.contains(['\\', ':', '\0'])
        && name.split('/').all(|part| {
            if part.is_empty() || matches!(part, "." | "..") {
                return false;
            }
            #[cfg(windows)]
            if part.ends_with(['.', ' ']) {
                return false;
            }
            true
        })
}

fn checked_path(directory: &Path, name: &str) -> Result<PathBuf> {
    let mut path = directory.to_path_buf();
    reject_link(&path)?;
    for component in name.split('/') {
        path.push(component);
        reject_link(&path)?;
    }
    Ok(path)
}

fn reject_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() => Err(LINK.into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn require_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(format!("Ожидался файл веб-приложения: {}", path.display()).into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn flag_name(name: &str) -> String {
    format!("{name}.replaced")
}

fn write_atomic(path: &Path, mut content: impl Read) -> Result<()> {
    let parent = path.parent().ok_or("missing web app asset directory")?;
    fs::create_dir_all(parent)?;
    let expected = atomic_file::current_stamp(path)?;
    let mut stage = NamedTempFile::new_in(parent)?;
    io::copy(&mut content, &mut stage)?;
    if atomic_file::publish(stage, path, expected.as_deref())?.is_none() {
        return Err(format!("Web app asset changed during install: {}", path.display()).into());
    }
    Ok(())
}

fn remove_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            fs::remove_file(path)?;
            atomic_file::sync_parent(path)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
