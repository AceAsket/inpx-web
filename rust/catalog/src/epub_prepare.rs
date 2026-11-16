use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufWriter, Cursor, Read, Seek, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sevenz_rust2::{ArchiveReader, Password};
use zip::{CompressionMethod, ZipArchive, ZipWriter, result::ZipError, write::SimpleFileOptions};

use crate::Result;
use crate::epub_input::EpubInput;

const MIMETYPE: &str = "application/epub+zip";
const CONTAINER: &str = "META-INF/container.xml";
const INDEX: &str = "FLibraryImageIndex.json";
const ARCHIVE_LIMIT: u64 = 512 * 1024 * 1024;
const ENTRY_LIMIT: u64 = 128 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 64 * 1024 * 1024;
const META_LIMIT: u64 = 4 * 1024 * 1024;
const COUNT_LIMIT: usize = 20_000;
const BUFFER: usize = 128 * 1024;

#[derive(Debug)]
pub(crate) struct OutputLimit;

impl std::fmt::Display for OutputLimit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Превышен лимит распаковки EPUB")
    }
}

impl std::error::Error for OutputLimit {}

#[derive(Deserialize)]
struct ImageIndexRow {
    id: String,
    num: f64,
}

#[derive(Serialize)]
pub(crate) struct Image {
    name: String,
    num: f64,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Prepared {
    Fallback,
    Unchanged,
    Repacked { images: Vec<Image>, remaining: u64 },
}

struct Entry {
    source: String,
    normalized: String,
    size: u64,
    directory: bool,
}

enum Source<R: BufRead + Seek> {
    Zip(Box<ZipArchive<R>>),
    SevenZip(Box<ArchiveReader<R>>),
}

#[derive(Clone, Copy)]
enum Use {
    Ignore,
    Mimetype,
    Index,
    File,
}

struct Plan {
    prefix: String,
    usage: Vec<Use>,
    files: HashMap<String, u64>,
    index_names: Vec<String>,
    count: usize,
    remaining: u64,
}

pub(crate) fn repack(input: &Path, output: &Path) -> Result<Prepared> {
    repack_from(
        EpubInput::open(input)?,
        input
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("7z")),
        output,
    )
}

pub(crate) fn repack_bytes(input: Vec<u8>, output: &Path) -> Result<Prepared> {
    repack_from(Cursor::new(input), false, output)
}

fn repack_from(input: impl BufRead + Seek, seven_zip: bool, output: &Path) -> Result<Prepared> {
    match Source::open(input, seven_zip).and_then(|source| try_repack(source, output)) {
        Err(error) if unsupported(error.as_ref()) => Ok(Prepared::Fallback),
        result => result,
    }
}

fn try_repack<R: BufRead + Seek>(mut source: Source<R>, output: &Path) -> Result<Prepared> {
    let (entries, exotic) = source.entries()?;
    let Some(plan) = Plan::new(&entries, exotic)? else {
        return Ok(Prepared::Unchanged);
    };
    let output = BufWriter::with_capacity(BUFFER, File::create_new(output)?);
    let mut zip = ZipWriter::new(output);
    zip.start_file(
        "mimetype",
        zip_options()
            .compression_method(CompressionMethod::Stored)
            .compression_level(None),
    )?;
    zip.write_all(MIMETYPE.as_bytes())?;

    let mut raw_index = Vec::new();
    let mut seen_mimetype = false;
    source.read_selected(&entries, &plan.usage, exotic, |index, reader| {
        let entry = &entries[index];
        match plan.usage[index] {
            Use::Ignore => {
                if exotic && !entry.directory {
                    copy_exact(reader, &mut io::sink(), entry.size)?;
                }
            }
            Use::Mimetype => {
                let mut bytes = Vec::new();
                copy_exact(reader, &mut bytes, entry.size)?;
                if String::from_utf8_lossy(&bytes).trim_matches(crate::fb2_prepare::js_space)
                    != MIMETYPE
                {
                    return Err("Некорректный mimetype EPUB".into());
                }
                seen_mimetype = true;
            }
            Use::Index => copy_exact(reader, &mut raw_index, entry.size)?,
            Use::File if entry.size != 0 => {
                zip.start_file(&entry.normalized[plan.prefix.len()..], zip_options())?;
                copy_exact(reader, &mut zip, entry.size)?;
            }
            Use::File => copy_exact(reader, &mut io::sink(), entry.size)?,
        }
        Ok(())
    })?;
    if !seen_mimetype {
        return Err("Некорректный mimetype EPUB".into());
    }
    let images = plan.missing_images(&raw_index)?;
    let omitted: HashSet<_> = images.iter().map(|image| image.name.as_str()).collect();
    let mut empty: Vec<_> = plan
        .files
        .iter()
        .filter_map(|(name, &size)| {
            (size == 0 && !omitted.contains(name.as_str())).then_some(name.as_str())
        })
        .collect();
    empty.sort_unstable();
    for name in empty {
        zip.start_file(name, zip_options())?;
    }
    zip.finish()?.flush()?;
    Ok(Prepared::Repacked {
        images,
        remaining: plan.remaining,
    })
}

pub(crate) fn append_images(output: &Path, manifest: &Path, mut remaining: u64) -> Result<()> {
    let file = File::open(manifest)?;
    let files: Vec<String> = serde_json::from_reader(file.take(META_LIMIT * 2))?;
    let directory = manifest
        .parent()
        .ok_or("Не задан каталог изображений EPUB")?;
    if files.len() > COUNT_LIMIT {
        return Err(OutputLimit.into());
    }
    let output = OpenOptions::new().read(true).write(true).open(output)?;
    let mut zip = ZipWriter::new_append(output)?;
    let mut names = HashSet::new();
    for (index, file) in files.into_iter().enumerate() {
        let name = safe_path(&file)?;
        if name != file
            || matches!(name.as_str(), "mimetype" | CONTAINER)
            || !names.insert(name.clone())
        {
            return Err(format!("Некорректное имя изображения EPUB: {name}").into());
        }
        let mut source = File::open(directory.join(index.to_string()))?;
        let size = source.metadata()?.len();
        if size == 0 || size > IMAGE_LIMIT || size > remaining {
            return Err(OutputLimit.into());
        }
        remaining -= size;
        zip.start_file(name, zip_options())?;
        copy_exact(&mut source, &mut zip, size)?;
    }
    zip.finish()?.flush()?;
    Ok(())
}

impl<R: BufRead + Seek> Source<R> {
    fn open(mut reader: R, seven_zip: bool) -> Result<Self> {
        if seven_zip || reader.fill_buf()?.starts_with(b"7z\xbc\xaf\x27\x1c") {
            let mut archive =
                ArchiveReader::new_with_memory_limit(reader, Password::empty(), 128 * 1024)?;
            archive.set_thread_count(1);
            return Ok(Self::SevenZip(Box::new(archive)));
        }
        Ok(Self::Zip(Box::new(ZipArchive::new(reader)?)))
    }

    fn entries(&mut self) -> Result<(Vec<Entry>, bool)> {
        match self {
            Self::Zip(zip) => {
                if zip.len() > COUNT_LIMIT {
                    return Err(OutputLimit.into());
                }
                let mut entries = Vec::with_capacity(zip.len());
                let mut exotic = false;
                for index in 0..zip.len() {
                    let entry = zip.by_index_raw(index)?;
                    exotic |= !entry.is_dir()
                        && !matches!(
                            entry.compression(),
                            CompressionMethod::Stored | CompressionMethod::Deflated
                        );
                    entries.push(Entry::new(
                        entry.name(),
                        entry.size(),
                        entry.is_dir(),
                        entry.is_symlink(),
                    )?);
                }
                Ok((entries, exotic))
            }
            Self::SevenZip(archive) => {
                if archive.archive().files.len() > COUNT_LIMIT {
                    return Err(OutputLimit.into());
                }
                let entries = archive
                    .archive()
                    .files
                    .iter()
                    .map(|entry| {
                        let attrs = entry.windows_attributes;
                        let linked = attrs & 0x400 != 0
                            || (attrs >> 16) & 0xf000 == 0xa000
                            || entry.is_anti_item;
                        Entry::new(&entry.name, entry.size, entry.is_directory, linked)
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok((entries, true))
            }
        }
    }

    fn read_selected(
        &mut self,
        entries: &[Entry],
        usage: &[Use],
        verify_all: bool,
        mut process: impl FnMut(usize, &mut dyn Read) -> Result<()>,
    ) -> Result<()> {
        match self {
            Self::Zip(zip) => {
                for (index, action) in usage.iter().enumerate() {
                    if !entries[index].directory && (verify_all || !matches!(action, Use::Ignore)) {
                        process(index, &mut zip.by_index(index)?)?;
                    }
                }
            }
            Self::SevenZip(archive) => {
                let positions: HashMap<_, _> = entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| (entry.source.as_str(), index))
                    .collect();
                let mut failure = None;
                let result = archive.for_each_entries_with_decision(|entry, reader| {
                    use sevenz_rust2::EntryDecision;
                    let Some(&index) = positions.get(entry.name.as_str()) else {
                        return Ok(EntryDecision::Continue);
                    };
                    if let Err(error) = process(index, reader) {
                        failure = Some(error);
                        return Ok(EntryDecision::Stop);
                    }
                    Ok(EntryDecision::Continue)
                });
                if let Some(error) = failure {
                    return Err(error);
                }
                result?;
            }
        }
        Ok(())
    }
}

impl Entry {
    fn new(name: &str, size: u64, directory: bool, linked: bool) -> Result<Self> {
        if linked {
            return Err(format!("Ссылка внутри EPUB: {name}").into());
        }
        let raw_name = if directory {
            name.trim_end_matches(['/', '\\'])
        } else {
            name
        };
        Ok(Self {
            source: name.into(),
            normalized: safe_path(raw_name)?,
            size,
            directory,
        })
    }
}

impl Plan {
    fn new(entries: &[Entry], exotic: bool) -> Result<Option<Self>> {
        let mut containers = entries.iter().filter(|entry| {
            !entry.directory
                && (entry.normalized == CONTAINER
                    || entry
                        .normalized
                        .strip_suffix(CONTAINER)
                        .is_some_and(|prefix| prefix.ends_with('/')))
        });
        let container = containers
            .next()
            .filter(|_| containers.next().is_none())
            .ok_or("EPUB должен содержать один META-INF/container.xml")?;
        let prefix =
            container.normalized[..container.normalized.len() - CONTAINER.len()].to_owned();
        let mut selected_names = HashSet::new();
        let mut archive_names = HashSet::new();
        let mut usage = Vec::with_capacity(entries.len());
        let mut files = HashMap::new();
        let mut index_names = Vec::new();
        let mut count = 0;
        let mut bytes = 0_u64;
        let mut limit_exceeded = false;
        for entry in entries {
            if exotic && !archive_names.insert(entry.normalized.to_lowercase()) {
                return Err(format!("Повторяющийся путь в EPUB: {}", entry.normalized).into());
            }
            if entry.directory {
                usage.push(Use::Ignore);
                continue;
            }
            count += 1;
            let label = entry.normalized.strip_prefix(&prefix);
            if let Some(label) = label
                && !selected_names.insert(label)
            {
                return Err(format!("Повторяющийся файл в EPUB: {label}").into());
            }
            let index = entry
                .normalized
                .rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case(INDEX));
            let limit = if index || label == Some(CONTAINER) || label == Some("mimetype") {
                META_LIMIT
            } else {
                ENTRY_LIMIT
            };
            bytes = bytes.saturating_add(entry.size);
            limit_exceeded |= entry.size > limit || bytes > ARCHIVE_LIMIT;
            let action = if index {
                index_names.push(label.unwrap_or(&entry.normalized).to_owned());
                Use::Index
            } else if let Some(label) = label {
                if label == "mimetype" {
                    Use::Mimetype
                } else {
                    files.insert(label.into(), entry.size);
                    Use::File
                }
            } else {
                Use::Ignore
            };
            usage.push(action);
        }
        if !exotic && index_names.is_empty() {
            return Ok(None);
        }
        if index_names.len() > 1 {
            return Err("Несколько индексов изображений EPUB".into());
        }
        if limit_exceeded {
            return Err(OutputLimit.into());
        }
        if !usage.iter().any(|action| matches!(action, Use::Mimetype)) {
            return Err("Некорректный mimetype EPUB".into());
        }
        Ok(Some(Self {
            prefix,
            usage,
            files,
            index_names,
            count,
            remaining: ARCHIVE_LIMIT - bytes,
        }))
    }

    fn missing_images(&self, input: &[u8]) -> Result<Vec<Image>> {
        if self.index_names.is_empty() {
            return Ok(Vec::new());
        }
        let parsed: Vec<ImageIndexRow> = serde_json::from_slice(input)
            .map_err(|error| format!("Некорректный индекс изображений EPUB: {error}"))?;
        if parsed.len() + self.count > COUNT_LIMIT {
            return Err(OutputLimit.into());
        }
        let mut seen = HashSet::new();
        let mut images = Vec::new();
        for image in parsed {
            if !image.num.is_finite() || image.num.fract() != 0.0 || image.num < -1.0 {
                return Err("Некорректная запись индекса изображений EPUB".into());
            }
            let normalized = safe_path(&image.id)?;
            let name = normalized.strip_prefix(&self.prefix).unwrap_or(&normalized);
            if matches!(name, "mimetype" | CONTAINER)
                || self.index_names.iter().any(|index| index == name)
                || !seen.insert(name.to_owned())
            {
                return Err(format!("Некорректное имя изображения EPUB: {name}").into());
            }
            if self.files.get(name).copied().unwrap_or_default() == 0 {
                images.push(Image {
                    name: name.into(),
                    num: image.num,
                });
            }
        }
        Ok(images)
    }
}

fn safe_path(name: &str) -> Result<String> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.ends_with('/')
        || normalized.bytes().any(|byte| byte == b':' || byte < 32)
        || normalized.split('/').any(|part| part == "..")
    {
        return Err(format!("Некорректный путь в EPUB: {normalized}").into());
    }
    let relative = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if relative.is_empty() {
        return Err(format!("Некорректный путь в EPUB: {normalized}").into());
    }
    Ok(relative)
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(
            zip::DateTime::from_date_and_time(2000, 1, 1, 0, 0, 0).expect("valid EPUB timestamp"),
        )
}

fn copy_exact(reader: &mut dyn Read, writer: &mut dyn Write, size: u64) -> Result<()> {
    if io::copy(&mut reader.take(size + 1), writer)? != size {
        return Err("Неверный размер распакованного EPUB".into());
    }
    Ok(())
}

fn unsupported(error: &(dyn std::error::Error + 'static)) -> bool {
    use sevenz_rust2::Error::*;
    matches!(
        error.downcast_ref::<ZipError>(),
        Some(ZipError::UnsupportedArchive(_))
    ) || matches!(
        error.downcast_ref::<sevenz_rust2::Error>(),
        Some(
            ExternalUnsupported
                | Unsupported(_)
                | UnsupportedVersion { .. }
                | UnsupportedCompressionMethod(_)
                | MaxMemLimited { .. }
                | PasswordRequired
        )
    )
}
