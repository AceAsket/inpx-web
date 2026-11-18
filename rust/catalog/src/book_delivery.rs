use std::fs::{self, File};
use std::io::{self, BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::book_archive::{Failure, extract_input};
use crate::book_cache::{self, Descriptor, Staging};
use crate::book_metadata::Format;
use crate::library_sources::Source;
use crate::{Result, book_names, book_source, crypto_support, fb2_prepare, jemba_identity};

const ASSET_VERSION: &str = "rust-original-v1";
const MAX_FB2: u64 = 500 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    #[serde(rename = "_uid")]
    pub uid: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub series: String,
    pub serno: Option<f64>,
    pub folder: String,
    pub file: String,
    pub ext: String,
    #[serde(default)]
    insno: i64,
    #[serde(default)]
    libid: String,
    #[serde(default)]
    sourcelib: String,
    #[serde(default, rename = "_legacyUid")]
    legacy_uid: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    source_lib_dir: String,
}

impl Book {
    pub fn source<'a>(&self, sources: &'a [Source]) -> Option<&'a Source> {
        if !self.source_id.is_empty() {
            return sources.iter().find(|source| {
                source.id == self.source_id
                    && (self.source_lib_dir.is_empty()
                        || source.lib_dir == Path::new(&self.source_lib_dir))
            });
        }
        if !self.source_lib_dir.is_empty() {
            return sources
                .iter()
                .find(|source| source.lib_dir == Path::new(&self.source_lib_dir));
        }
        match sources {
            [source] => Some(source),
            _ => None,
        }
    }

    pub fn extension(&self) -> Option<&str> {
        (!self.ext.is_empty()
            && self.ext.len() <= 32
            && self
                .ext
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .then_some(self.ext.as_str())
    }

    pub fn filename(&self, template: &str) -> Result<String> {
        book_names::filename(
            self,
            template,
            self.extension().ok_or("Invalid book extension")?,
        )
    }

    pub fn caption(&self, template: &str) -> Result<String> {
        book_names::render(self, template, &self.ext)
    }

    pub fn remote_ids(&self, source: &str) -> Result<(String, Option<&str>)> {
        let physical = jemba_identity::physical_identity(
            source,
            &self.folder,
            &self.file,
            &self.ext,
            self.insno,
            &self.libid,
            &self.sourcelib,
        )?;
        let primary = if physical.is_empty() {
            self.uid.clone()
        } else {
            physical
        };
        let legacy = (!self.legacy_uid.is_empty() && self.legacy_uid != primary)
            .then_some(self.legacy_uid.as_str());
        Ok((primary, legacy))
    }
}

pub fn archive_attachment(directory: &Path, source: &Path, name: &str) -> Result<PathBuf> {
    let digest = Sha256::digest(name.as_bytes());
    let target = source.with_extension(format!(
        "{}.delivery-v1-{}.zip",
        source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
        crypto_support::hex(&digest[..12])
    ));
    let token = crypto_support::hex(&crypto_support::random::<16>()?);
    book_cache::zip_book(source, &target, &Staging::new(directory, &token)?, name)?;
    Ok(target)
}

pub fn metadata(book: &Book, source: &Source) -> Result<serde_json::Value> {
    let extension = book.extension().ok_or(Failure::InvalidType)?;
    let format = if extension.eq_ignore_ascii_case("fb2") {
        Format::Fb2
    } else if extension.eq_ignore_ascii_case("epub") {
        Format::Epub
    } else {
        return Ok(serde_json::Value::Null);
    };
    let input = book_source::resolve(
        &source.lib_dir,
        &book.folder,
        &format!("{}.{extension}", book.file),
    )?;
    Ok(crate::book_archive::metadata_input(
        input,
        format,
        64 * 1024 * 1024,
    )?)
}

pub struct Cached {
    pub hash: String,
    descriptor: Descriptor,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Representation {
    Raw,
    Gzip,
    Zip,
}

pub fn cache_directory(data: &Path) -> Result<PathBuf> {
    let root = data.canonicalize()?;
    let mut directory = root.clone();
    for part in ["public-files", "source-verified-v1", "book"] {
        directory.push(part);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir()
            || metadata.is_symlink()
            || !directory.canonicalize()?.starts_with(&root)
        {
            return Err("Invalid book cache directory".into());
        }
    }
    Ok(directory)
}

pub fn cached(directory: &Path, hash: &str) -> Result<Option<Cached>> {
    let value = book_cache::inspect(directory, hash, None, false, false)?;
    Ok(if value.is_null() {
        None
    } else {
        Some(Cached {
            hash: hash.into(),
            descriptor: serde_json::from_value(value)?,
        })
    })
}

pub fn prepare(directory: &Path, book: &Book, source: &Source) -> Result<Cached> {
    prepare_limited(directory, book, source, None)
}

pub fn prepare_limited(
    directory: &Path,
    book: &Book,
    source: &Source,
    limit: Option<u64>,
) -> Result<Cached> {
    let extension = book.extension().ok_or(Failure::InvalidType)?;
    let lib_file = format!("{}.{extension}", book.file);
    let input = book_source::resolve(&source.lib_dir, &book.folder, &lib_file)?;
    let temp = tempfile::Builder::new()
        .prefix(".extract-")
        .tempdir_in(directory)?;
    let raw = temp.path().join("book");
    let mut output = BufWriter::new(File::create_new(&raw)?);
    let fb2 = extension.eq_ignore_ascii_case("fb2");
    let cap = limit.unwrap_or(if fb2 { MAX_FB2 } else { u64::MAX });
    extract_input(input, &mut output, cap)?;
    output.flush()?;
    drop(output);
    if fb2 && fb2_prepare::normalize_bounded(&raw, cap)?.is_none() {
        return Err(Failure::Unsupported.into());
    }
    publish(directory, book, source, &raw)
}

pub fn too_large() -> Box<dyn std::error::Error> {
    Failure::Limit.into()
}

pub fn prepare_remote(
    directory: &Path,
    book: &Book,
    source: &Source,
    download: impl FnOnce(&Path, &dyn Fn(&str) -> bool) -> Result<String>,
) -> Result<Cached> {
    let temporary = tempfile::Builder::new()
        .prefix(".remote-")
        .tempdir_in(directory)?;
    let check = |hash: &str| {
        cached(directory, hash)
            .ok()
            .flatten()
            .is_some_and(|file| file.matches(book, source))
    };
    let hash = download(temporary.path(), &check)?;
    let raw = temporary.path().join("book");
    if !raw.exists() {
        return cached(directory, &hash)?
            .filter(|file| file.matches(book, source))
            .ok_or_else(|| Failure::Missing.into());
    }
    publish(directory, book, source, &raw)
}

fn publish(directory: &Path, book: &Book, source: &Source, raw: &Path) -> Result<Cached> {
    let extension = book.extension().ok_or(Failure::InvalidType)?;
    let mut descriptor = Descriptor {
        book_uid: book.uid.clone(),
        lib_folder: book.folder.clone(),
        lib_file: format!("{}.{extension}", book.file),
        source_lib_dir: source
            .lib_dir
            .to_str()
            .ok_or("Invalid library directory")?
            .into(),
        down_file_name: book_names::filename(book, "", extension)?,
        asset_version: ASSET_VERSION.into(),
        size: 0,
    };
    let token = crypto_support::hex(&crypto_support::random::<16>()?);
    let stage = Staging::new(directory, &token)?;
    let published = book_cache::publish(raw, &stage, descriptor.clone(), true)?;
    descriptor.size = published.size;
    Ok(Cached {
        hash: published.hash,
        descriptor,
    })
}

impl Cached {
    pub fn size(&self) -> u64 {
        self.descriptor.size
    }

    pub fn uid(&self) -> &str {
        &self.descriptor.book_uid
    }

    pub fn reader_file(&self, directory: &Path, extension: &str) -> Result<PathBuf> {
        let raw = self.file(directory, "", Representation::Raw)?;
        if extension.eq_ignore_ascii_case("fb2") {
            return Ok(raw);
        }
        if !extension.eq_ignore_ascii_case("epub") {
            return Err(Failure::Unsupported.into());
        }
        let target = directory.join(format!("{}.reader-epub-fb2-v1.fb2", self.hash));
        if book_cache::regular_file(&target, true)?.is_some() {
            return Ok(target);
        }
        let source = book_cache::regular_file(&raw, false)?.ok_or(Failure::Missing)?;
        let token = crypto_support::hex(&crypto_support::random::<16>()?);
        match book_cache::convert_epub(
            std::io::BufReader::new(source),
            &target,
            &token,
            crate::epub_fb2::MAX_OUTPUT,
        ) {
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::AlreadyExists)
                    && book_cache::regular_file(&target, true)?.is_some() => {}
            result => {
                result?;
            }
        }
        Ok(target)
    }

    pub fn matches(&self, book: &Book, source: &Source) -> bool {
        self.descriptor.asset_version == ASSET_VERSION
            && self.uid() == book.uid
            && self.descriptor.lib_folder == book.folder
            && Path::new(&self.descriptor.source_lib_dir) == source.lib_dir
            && book
                .extension()
                .is_some_and(|ext| self.descriptor.lib_file == format!("{}.{ext}", book.file))
    }

    pub fn file(&self, directory: &Path, name: &str, kind: Representation) -> Result<PathBuf> {
        let gzip = directory.join(&self.hash);
        if kind == Representation::Gzip {
            return Ok(gzip);
        }
        let token = crypto_support::hex(&crypto_support::random::<16>()?);
        let stage = Staging::new(directory, &token)?;
        let raw = directory.join(format!("{}.raw", self.hash));
        book_cache::inflate(&gzip, &raw, &stage, self.descriptor.size)?;
        if kind == Representation::Raw {
            return Ok(raw);
        }
        let digest = Sha256::digest(name.as_bytes());
        let zip = directory.join(format!(
            "{}.download-v3-{}.zip",
            self.hash,
            crypto_support::hex(&digest[..8])
        ));
        book_cache::zip_book(&raw, &zip, &stage, name)?;
        Ok(zip)
    }
}

pub enum DownloadError {
    Missing,
    Limit,
    Unsupported,
    Internal,
}

pub fn classify(error: &(dyn std::error::Error + 'static)) -> DownloadError {
    if error.is::<crate::epub_fb2::Invalid>() {
        return DownloadError::Unsupported;
    }
    if let Some(archive) = error.downcast_ref::<Failure>() {
        return match archive {
            Failure::Missing | Failure::InvalidType => DownloadError::Missing,
            Failure::Limit => DownloadError::Limit,
            Failure::Unsupported => DownloadError::Unsupported,
            Failure::Other(cause) => classify(cause.as_ref()),
        };
    }
    if error.downcast_ref::<io::Error>().is_some_and(|error| {
        matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::PermissionDenied
        )
    }) {
        DownloadError::Missing
    } else {
        DownloadError::Internal
    }
}

pub fn ascii_name(name: &str) -> String {
    book_names::ascii_name(name)
}

pub fn disposition(name: &str, ascii_only: bool) -> String {
    book_names::disposition(name, ascii_only)
}
