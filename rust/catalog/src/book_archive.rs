use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde::Deserialize;
use sevenz_rust2::{Archive, BlockDecoder, Password};
use zip::ZipArchive;
use zip::result::ZipError;

use crate::Result;
use crate::book_metadata::{self, Format};
use crate::book_source::Folder;
use crate::file_stamp::{FileStamp, stamp};
use crate::framed_protocol::{Frames, complete, header};

const READER_BYTES: usize = 128 * 1024;
const SEVEN_ZIP_MEMORY_KIB: usize = 128 * 1024;
// Flibusta uses PPMd with a 256 MiB model. Only one high-memory decoder
// may run at once, while ordinary archive reads remain independent.
const LARGE_DECODER_KIB: usize = 256 * 1024;
static LARGE_DECODER: std::sync::Mutex<()> = std::sync::Mutex::new(());
const ARCHIVES_PER_WORKER: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    source: PathBuf,
    name: Option<String>,
    legacy_zip_name: Option<String>,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Operation {
    Inspect(Inspect),
    Extract(Extract),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inspect {
    metadata: Format,
    limit: u64,
    #[serde(default)]
    isbn_only: bool,
}

#[derive(Deserialize)]
struct Extract {
    destination: PathBuf,
    limit: u64,
    prefix: u64,
}

#[derive(Debug)]
pub(crate) enum Failure {
    Unsupported,
    DecoderMemory { needed: usize, limit: usize },
    Missing,
    Limit,
    InvalidType,
    Other(Box<dyn std::error::Error>),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message().1)
    }
}

impl std::error::Error for Failure {}

impl Failure {
    fn message(&self) -> (&'static str, String) {
        match self {
            Self::DecoderMemory { needed, limit } => (
                "INPX_ARCHIVE_UNSUPPORTED",
                format!(
                    "Декодеру архива нужно {} МиБ памяти, лимит — {} МиБ",
                    needed.div_ceil(1024),
                    limit / 1024
                ),
            ),
            Self::Unsupported => (
                "INPX_ARCHIVE_UNSUPPORTED",
                "Архив требует другого декодера".into(),
            ),
            Self::Missing => ("ENOENT", "Файл отсутствует в архиве".into()),
            Self::Limit => (
                "INPX_RESOURCE_OUTPUT_LIMIT",
                "Превышен размер извлечённого файла".into(),
            ),
            Self::InvalidType => (
                "INPX_ARCHIVE_ENTRY_TYPE",
                "Недопустимый тип записи архива".into(),
            ),
            Self::Other(error) => ("INPX_ARCHIVE_READ", error.to_string()),
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Other(error.into())
    }
}

impl From<ZipError> for Failure {
    fn from(error: ZipError) -> Self {
        match error {
            ZipError::UnsupportedArchive(_) | ZipError::CompressionMethodNotSupported(_) => {
                Self::Unsupported
            }
            ZipError::FileNotFound => Self::Missing,
            _ => Self::Other(error.into()),
        }
    }
}

impl From<sevenz_rust2::Error> for Failure {
    fn from(error: sevenz_rust2::Error) -> Self {
        use sevenz_rust2::Error::*;
        match error {
            ExternalUnsupported
            | Unsupported(_)
            | UnsupportedVersion { .. }
            | UnsupportedCompressionMethod(_)
            | PasswordRequired => Self::Unsupported,
            MaxMemLimited { actaul_kb, max_kb } => Self::DecoderMemory {
                needed: actaul_kb,
                limit: max_kb,
            },
            FileNotFound => Self::Missing,
            _ => Self::Other(error.into()),
        }
    }
}

type Extraction<T> = std::result::Result<T, Failure>;

pub(crate) fn extract_input(
    input: crate::book_source::Input,
    output: &mut impl Write,
    limit: u64,
) -> Extraction<()> {
    let copy = |declared: u64, reader: &mut dyn Read, output: &mut dyn Write| {
        if declared > limit {
            return Err(Failure::Limit);
        }
        if io::copy(&mut reader.take(declared.saturating_add(1)), output)? != declared {
            return Err(io::Error::other("Размер файла книги изменился при извлечении").into());
        }
        Ok(())
    };
    let crate::book_source::Input { file, path, member } = input;
    if let Some(member) = member {
        read_member(&path, file, &member, |size, reader| {
            copy(size, reader, output)
        })
    } else {
        let declared = file.metadata()?.len();
        copy(
            declared,
            &mut BufReader::with_capacity(READER_BYTES, file),
            output,
        )
    }
}

pub(crate) fn read_member<T>(
    path: &Path,
    file: File,
    member: &str,
    process: impl FnMut(u64, &mut dyn Read) -> Extraction<T>,
) -> Extraction<T> {
    let legacy = legacy_zip_name(member);
    ArchiveReader::open(path, file)?
        .directory
        .read(member, legacy.as_deref(), process)
}

pub(crate) fn metadata_input(
    input: crate::book_source::Input,
    format: Format,
    limit: u64,
) -> Extraction<serde_json::Value> {
    let crate::book_source::Input { file, path, member } = input;
    if let Some(member) = member {
        read_member(&path, file, &member, |size, reader| {
            book_metadata::read_stream(&format, size, reader, limit, false)
        })
    } else if format == Format::Epub {
        book_metadata::read_epub(BufReader::with_capacity(READER_BYTES, file), false)
    } else {
        book_metadata::read_fb2(BufReader::with_capacity(READER_BYTES, file), limit, false)
    }
}

#[derive(Default)]
struct ArchiveCache(VecDeque<CachedArchive>);

#[derive(Default)]
pub(crate) struct IsbnReader(ArchiveCache);

pub(crate) struct IsbnMember {
    pub row: usize,
    pub name: String,
    pub format: Format,
}

#[derive(Default)]
pub(crate) struct AuditArchive(ArchiveCache);

impl AuditArchive {
    pub(crate) fn check<T>(
        &mut self,
        input: crate::book_source::Input,
        deep: bool,
        mut process: impl FnMut(u64, &mut dyn Read) -> Extraction<T>,
    ) -> Extraction<Option<T>> {
        let crate::book_source::Input { file, path, member } = input;
        let Some(member) = member else {
            return if deep {
                let size = file.metadata()?.len();
                process(size, &mut BufReader::new(file)).map(Some)
            } else {
                Ok(None)
            };
        };
        let archive = self.0.open(&path, file)?;
        let legacy = legacy_zip_name(&member);
        let result = if deep {
            archive
                .directory
                .read(&member, legacy.as_deref(), process)
                .map(Some)
        } else {
            archive
                .directory
                .check_member(&member, legacy.as_deref())
                .map(|()| None)
        };
        archive.source.detach();
        result
    }
}

impl IsbnMember {
    fn loose(&self, folder: &Folder, limit: u64) -> Extraction<Vec<String>> {
        let file = folder.open(self.name.clone())?.file;
        let size = file.metadata()?.len();
        if size > limit {
            return Err(Failure::Limit);
        }
        let mut reader = BufReader::with_capacity(READER_BYTES, file);
        let data = if self.format == Format::Epub {
            book_metadata::read_epub(reader, true)?
        } else {
            book_metadata::read_stream(&self.format, size, &mut reader, limit, true)?
        };
        serde_json::from_value(data).map_err(|e| Failure::Other(e.into()))
    }

    fn numbers(&self, size: u64, reader: &mut dyn Read, limit: u64) -> Extraction<Vec<String>> {
        let raw = book_metadata::read_stream(&self.format, size, reader, limit, true)?;
        serde_json::from_value(raw).map_err(|e| Failure::Other(e.into()))
    }
}

impl IsbnReader {
    pub(crate) fn read_group(
        &mut self,
        folder: &Folder,
        members: &[IsbnMember],
        limit: u64,
        cancelled: &impl Fn() -> bool,
        mut found: impl FnMut(usize, Vec<String>),
    ) -> Extraction<()> {
        if !folder.archived {
            for member in members {
                if cancelled() {
                    break;
                }
                if let Ok(numbers) = member.loose(folder, limit) {
                    found(member.row, numbers);
                }
            }
            return Ok(());
        }
        let archive = self.0.open(&folder.path, folder.open_archive()?)?;
        match &mut archive.directory {
            Directory::SevenZip(source, seven) => {
                seven.read_isbn_blocks(source, members, limit, cancelled, found)
            }
            directory => {
                for member in members {
                    if cancelled() {
                        break;
                    }
                    let legacy = legacy_zip_name(&member.name);
                    if let Ok(numbers) =
                        directory.read(&member.name, legacy.as_deref(), |size, reader| {
                            member.numbers(size, reader, limit)
                        })
                    {
                        found(member.row, numbers);
                    }
                }
            }
        }
        archive.source.detach();
        Ok(())
    }
}

struct CachedArchive {
    path: PathBuf,
    stamp: FileStamp,
    reader: ArchiveReader,
}

struct ArchiveReader {
    source: ArchiveFile,
    directory: Directory<ArchiveFile>,
}

pub(crate) enum Directory<R: Read + Seek> {
    Zip(ZipArchive<R>, Option<HashMap<String, usize>>),
    SevenZip(R, Box<SevenZip>),
}

pub(crate) struct SevenZip {
    archive: Archive,
    names: HashMap<String, usize>,
    password: Password,
}

// Keep ZIP directory offsets across requests while releasing the OS handle
// after each read, so another process can replace the archive on Windows.
#[derive(Clone)]
struct ArchiveFile(Rc<RefCell<Option<BufReader<File>>>>);

impl ArchiveFile {
    fn use_reader<T>(
        &self,
        operation: impl FnOnce(&mut BufReader<File>) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut reader = self.0.borrow_mut();
        operation(
            reader
                .as_mut()
                .ok_or_else(|| io::Error::other("Архив закрыт"))?,
        )
    }

    fn attach(&self, file: File) {
        self.0
            .replace(Some(BufReader::with_capacity(READER_BYTES, file)));
    }

    fn detach(&self) {
        self.0.take();
    }
}

impl Read for ArchiveFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.use_reader(|reader| reader.read(buffer))
    }
}

impl Seek for ArchiveFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.use_reader(|reader| reader.seek(position))
    }
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut archives = ArchiveCache(VecDeque::new());
    while let Some(request) = header::<Request>(&mut input)? {
        match run(&mut archives, &request) {
            Ok(result) => {
                if let Some(result) = result {
                    Frames(&mut output).write_all(&serde_json::to_vec(&result)?)?;
                }
                complete(&mut output, None, None)?;
            }
            Err(error) => {
                let (code, message) = error.message();
                complete(&mut output, Some(message), Some(code))?;
            }
        }
    }
    Ok(())
}

fn run(cache: &mut ArchiveCache, request: &Request) -> Extraction<Option<serde_json::Value>> {
    let process = |size: u64, reader: &mut dyn Read| match &request.operation {
        Operation::Extract(extract) => {
            if extract.limit != 0 && extract.prefix > extract.limit {
                return Err(Failure::Limit);
            }
            extract.write_output(size, reader)?;
            Ok(None)
        }
        Operation::Inspect(settings) => book_metadata::read_stream(
            &settings.metadata,
            size,
            reader,
            settings.limit,
            settings.isbn_only,
        )
        .map(Some),
    };
    let mut file = File::open(&request.source)?;
    if let Some(name) = &request.name {
        let archive = cache.open(&request.source, file)?;
        let result = archive
            .directory
            .read(name, request.legacy_zip_name.as_deref(), process);
        archive.source.detach();
        result
    } else {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(Failure::InvalidType);
        }
        if let Operation::Inspect(settings) = &request.operation {
            match settings.metadata {
                Format::Epub => {
                    if settings.isbn_only && metadata.len() > settings.limit {
                        return Err(Failure::Limit);
                    }
                    return book_metadata::read_epub(
                        BufReader::with_capacity(READER_BYTES, file),
                        settings.isbn_only,
                    )
                    .map(Some);
                }
                Format::FolderFb2 => return process(metadata.len(), &mut file),
                Format::Fb2 => {}
            }
        }
        process(
            metadata.len(),
            &mut BufReader::with_capacity(READER_BYTES, file),
        )
    }
}

impl ArchiveCache {
    fn open(&mut self, path: &Path, file: File) -> Extraction<&mut ArchiveReader> {
        let stamp = stamp(&file)?;
        let old = self
            .0
            .iter()
            .position(|entry| entry.path == path)
            .and_then(|index| self.0.remove(index));
        let entry = match old {
            Some(entry) if entry.stamp == stamp => {
                entry.reader.source.attach(file);
                entry
            }
            _ => CachedArchive {
                path: path.to_owned(),
                stamp,
                reader: ArchiveReader::open(path, file)?,
            },
        };
        if self.0.len() >= ARCHIVES_PER_WORKER {
            self.0.pop_back();
        }
        self.0.push_front(entry);
        Ok(&mut self.0.front_mut().expect("opened archive").reader)
    }
}

impl ArchiveReader {
    fn open(path: &Path, file: File) -> Extraction<Self> {
        let source = ArchiveFile(Rc::new(RefCell::new(None)));
        source.attach(file);
        let seven_zip = source
            .use_reader(|reader| Ok(reader.fill_buf()?.starts_with(b"7\x7a\xbc\xaf\x27\x1c")))?
            || path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("7z"));
        let directory = Directory::open(source.clone(), seven_zip)?;
        Ok(Self { source, directory })
    }
}

fn legacy_zip_name(name: &str) -> Option<String> {
    if name.is_ascii() {
        return None;
    }
    // ZIP exposes unflagged names as CP437. Russian archives often store CP866 bytes.
    const CP437_HIGH: [char; 128] = [
        'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ',
        'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú',
        'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡',
        '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟',
        '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘',
        '┌', '█', '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ',
        '∞', 'φ', 'ε', '∩', '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²',
        '■', '\u{a0}',
    ];
    let (bytes, _, unmappable) = encoding_rs::IBM866.encode(name);
    (!unmappable).then(|| {
        bytes
            .iter()
            .map(|&b| {
                if b < 128 {
                    char::from(b)
                } else {
                    CP437_HIGH[usize::from(b - 128)]
                }
            })
            .collect()
    })
}

fn zip_member_index<R: Read + Seek>(
    archive: &ZipArchive<R>,
    decoded: &mut Option<HashMap<String, usize>>,
    name: &str,
    alternate: Option<&str>,
) -> Option<usize> {
    archive.index_for_name(name).or_else(|| {
        if name.is_ascii() {
            return None;
        }
        // index_for_name compares raw UTF-8 bytes. Build the decoded-name index once,
        // from the central directory only, when a legacy lookup is actually needed.
        let index = decoded.get_or_insert_with(|| {
            let mut index = HashMap::new();
            for (i, display) in archive
                .file_names()
                .enumerate()
                .filter(|(_, n)| !n.is_ascii())
            {
                index.entry(display.to_owned()).or_insert(i);
            }
            index
        });
        index
            .get(name)
            .or_else(|| alternate.and_then(|alias| index.get(alias)))
            .copied()
    })
}

impl<R: Read + Seek> Directory<R> {
    fn check_member(&mut self, member: &str, legacy: Option<&str>) -> Extraction<()> {
        let regular = match self {
            Self::Zip(archive, decoded) => {
                let index =
                    zip_member_index(archive, decoded, member, legacy).ok_or(Failure::Missing)?;
                let entry = archive.by_index_raw(index)?;
                !entry.is_dir() && !entry.is_symlink()
            }
            Self::SevenZip(_, archive) => {
                let name = member.replace('\\', "/");
                let index = *archive.names.get(&name).ok_or(Failure::Missing)?;
                regular_7z(&archive.archive.files[index])
            }
        };
        if regular {
            Ok(())
        } else {
            Err(Failure::InvalidType)
        }
    }

    pub(crate) fn open(mut source: R, seven_zip: bool) -> Extraction<Self> {
        if seven_zip {
            let directory = SevenZip::open(&mut source)?;
            return Ok(Self::SevenZip(source, Box::new(directory)));
        }
        Ok(Self::Zip(ZipArchive::new(source)?, None))
    }

    pub(crate) fn find_file(&mut self, predicate: impl Fn(&str) -> bool) -> Option<String> {
        match self {
            Self::Zip(zip, _) => (0..zip.len()).find_map(|index| {
                let entry = zip.by_index_raw(index).ok()?;
                (!entry.is_dir() && !entry.is_symlink() && predicate(entry.name()))
                    .then(|| entry.name().to_owned())
            }),
            Self::SevenZip(_, archive) => archive
                .archive
                .files
                .iter()
                .find(|entry| regular_7z(entry) && predicate(&entry.name))
                .map(|entry| entry.name.clone()),
        }
    }

    pub(crate) fn read<T>(
        &mut self,
        name: &str,
        legacy_name: Option<&str>,
        mut process: impl FnMut(u64, &mut dyn Read) -> Extraction<T>,
    ) -> Extraction<T> {
        match self {
            Self::Zip(archive, decoded) => {
                let index = zip_member_index(archive, decoded, name, legacy_name)
                    .ok_or(Failure::Missing)?;
                let mut file = archive.by_index(index)?;
                if file.is_dir() || file.is_symlink() {
                    return Err(Failure::InvalidType);
                }
                process(file.size(), &mut file)
            }
            Self::SevenZip(source, archive) => archive.read(source, name, process),
        }
    }
}

pub(crate) fn open_directory(path: &Path) -> Extraction<Directory<impl Read + Seek>> {
    input_directory(path, File::open(path)?)
}

pub(crate) fn input_directory(path: &Path, file: File) -> Extraction<Directory<impl Read + Seek>> {
    let archive = ArchiveReader::open(path, file)?;
    Ok(archive.directory)
}

impl<R: Read + Seek> Directory<R> {
    pub(crate) fn files(&mut self, mut visit: impl FnMut(&str) -> bool) {
        match self {
            Self::Zip(archive, _) => {
                for index in 0..archive.len() {
                    if let Ok(entry) = archive.by_index_raw(index)
                        && !entry.is_dir()
                        && !entry.is_symlink()
                        && !visit(entry.name())
                    {
                        break;
                    }
                }
            }
            Self::SevenZip(_, archive) => {
                for entry in archive
                    .archive
                    .files
                    .iter()
                    .filter(|entry| regular_7z(entry))
                {
                    if !visit(&entry.name) {
                        break;
                    }
                }
            }
        }
    }
}

impl SevenZip {
    fn read_isbn_blocks(
        &self,
        source: &mut (impl Read + Seek),
        members: &[IsbnMember],
        limit: u64,
        cancelled: &impl Fn() -> bool,
        mut found: impl FnMut(usize, Vec<String>),
    ) {
        let mut blocks =
            std::collections::BTreeMap::<usize, HashMap<usize, Vec<&IsbnMember>>>::new();
        for member in members {
            let Some(&index) = self.names.get(&member.name) else {
                continue;
            };
            let entry = &self.archive.files[index];
            if !regular_7z(entry) || entry.size > limit {
                continue;
            }
            if !entry.has_stream {
                if let Ok(numbers) = member.numbers(entry.size, &mut io::empty(), limit) {
                    found(member.row, numbers);
                }
            } else if let Some(block) = self.archive.stream_map.file_block_index[index] {
                blocks
                    .entry(block)
                    .or_default()
                    .entry(index)
                    .or_default()
                    .push(member);
            }
        }
        for (block, mut targets) in blocks {
            if cancelled() {
                break;
            }
            let mut index = self.archive.stream_map.block_first_file_index[block];
            let _ = self.visit_block(source, block, |entry, reader| {
                if cancelled() {
                    return Ok(false);
                }
                if let Some(matches) = targets.remove(&index)
                    && let Ok(numbers) = matches[0].numbers(entry.size, reader, limit)
                {
                    for member in matches {
                        found(member.row, numbers.clone());
                    }
                }
                index += 1;
                Ok(!targets.is_empty())
            });
        }
    }

    fn open(reader: &mut (impl Read + Seek)) -> Extraction<Self> {
        let password = Password::empty();
        let archive = match Archive::read_with_memory_limit(reader, &password, SEVEN_ZIP_MEMORY_KIB)
        {
            Err(sevenz_rust2::Error::MaxMemLimited { .. }) => {
                let _guard = LARGE_DECODER.lock().unwrap_or_else(|e| e.into_inner());
                reader.rewind()?;
                Archive::read_with_memory_limit(reader, &password, LARGE_DECODER_KIB)?
            }
            result => result?,
        };
        let mut names = HashMap::with_capacity(archive.files.len());
        for (index, entry) in archive.files.iter().enumerate() {
            let name = entry.name.replace('\\', "/");
            if names.insert(name, index).is_some() {
                // 7-Zip can return multiple entries with the same name in archive order.
                return Err(Failure::Unsupported);
            }
        }
        Ok(Self {
            archive,
            names,
            password,
        })
    }

    fn read<T>(
        &self,
        source: &mut (impl Read + Seek),
        name: &str,
        mut process: impl FnMut(u64, &mut dyn Read) -> Extraction<T>,
    ) -> Extraction<T> {
        let name = name.replace('\\', "/");
        let index = self.names.get(&name).copied().ok_or(Failure::Missing)?;
        let entry = &self.archive.files[index];
        if !regular_7z(entry) {
            return Err(Failure::InvalidType);
        }
        if !entry.has_stream {
            return process(entry.size, &mut io::empty());
        }
        let block = self.archive.stream_map.file_block_index[index].ok_or(Failure::Missing)?;
        let mut result = Err(Failure::Missing);
        self.visit_block(source, block, |candidate, reader| {
            if !std::ptr::eq(entry, candidate) {
                return Ok(true);
            }
            result = process(entry.size, reader);
            Ok(false)
        })?;
        result
    }

    fn visit_block(
        &self,
        source: &mut (impl Read + Seek),
        block: usize,
        mut visit: impl FnMut(
            &sevenz_rust2::ArchiveEntry,
            &mut dyn Read,
        ) -> std::result::Result<bool, sevenz_rust2::Error>,
    ) -> Extraction<()> {
        let mut decode = |limit| {
            let decoder = BlockDecoder::new_with_memory_limit(
                1,
                limit,
                block,
                &self.archive,
                &self.password,
                &mut *source,
            );
            decoder.for_each_entries(&mut visit)
        };
        match decode(SEVEN_ZIP_MEMORY_KIB) {
            Err(sevenz_rust2::Error::MaxMemLimited { .. }) => {
                let _guard = LARGE_DECODER.lock().unwrap_or_else(|e| e.into_inner());
                decode(LARGE_DECODER_KIB)?
            }
            other => other?,
        };
        Ok(())
    }
}

fn regular_7z(entry: &sevenz_rust2::ArchiveEntry) -> bool {
    let attrs = entry.windows_attributes;
    !entry.is_directory
        && !entry.is_anti_item
        && attrs & 0x400 == 0
        && (attrs >> 16) & 0xf000 != 0xa000
}

impl Extract {
    fn write_output(&self, declared: u64, input: impl Read) -> Extraction<()> {
        let partial = self.prefix != 0 && self.prefix < declared;
        let expected = if partial { self.prefix } else { declared };
        if self.limit != 0 && expected > self.limit {
            return Err(Failure::Limit);
        }
        let file = File::create_new(&self.destination)?;
        let mut output = BufWriter::with_capacity(READER_BYTES, file);
        let result = (|| {
            let maximum = if partial {
                expected
            } else {
                expected.saturating_add(1)
            };
            let bytes = io::copy(&mut input.take(maximum), &mut output)?;
            if bytes != expected {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Размер распакованного файла не совпадает с оглавлением",
                )
                .into());
            }
            output.flush()?;
            Ok(())
        })();
        drop(output);
        if result.is_err() {
            let _ = fs::remove_file(&self.destination);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn standalone_audit_and_read_find_cp866_members() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("ABCDE.fb2", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"content").unwrap();
        let mut bytes = writer.finish().unwrap().into_inner();
        let offsets: Vec<_> = bytes
            .windows(9)
            .enumerate()
            .filter_map(|(at, name)| (name == b"ABCDE.fb2").then_some(at))
            .collect();
        assert_eq!(offsets.len(), 2);
        let name = "Книга.fb2";
        for at in offsets {
            bytes[at..at + 9].copy_from_slice(&encoding_rs::IBM866.encode(name).0);
        }
        let mut directory = Directory::open(Cursor::new(bytes), false).unwrap();
        let alias = legacy_zip_name(name);
        directory.check_member(name, alias.as_deref()).unwrap();
        let mut body = Vec::new();
        directory
            .read(name, alias.as_deref(), |_, reader| {
                reader.read_to_end(&mut body)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(body, b"content");
    }
}
