use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::backup_crypto::{MAX_PASSWORD_BYTES, SALT_BYTES};
use crate::crypto_support::{KEY_BYTES, Sensitive};
use crate::framed_protocol::{Frames, header, reply, with_body};
use crate::{Result, atomic_file, backup_crypto, backup_vault, file_stamp};

const NAMES: [&str; 6] = [
    "backup-info.json",
    "config.json",
    "reading-lists.json",
    "secret.key",
    "discovery-cache.json",
    "backup-vault.json",
];
const UNKNOWN_ENTRY: &str = "Неизвестный файл в бэкапе";
const ENTRY_COUNT: &str = "Слишком много файлов в бэкапе";
const EXPANDED: &str = "Превышен распакованный размер бэкапа";
const INVALID_ZIP: &str = "Повреждён ZIP резервной копии";
const INLINE_ZIP_LIMIT: u64 = 1024 * 1024;
const MAX_EXPANDED: u64 = 256 * 1024 * 1024;
const MAX_BACKUP: u64 = 128 * 1024 * 1024;

pub const INFO: &str = "backup-info.json";

#[derive(Deserialize)]
struct Pack {
    destination: PathBuf,
    #[serde(default)]
    encrypted: bool,
    timestamp: (u16, u8, u8, u8, u8, u8),
    files: Vec<Source>,
}

#[derive(Deserialize)]
struct Source {
    name: String,
    #[serde(flatten)]
    input: Input,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Input {
    File { path: PathBuf },
    Inline { size: u64 },
}

#[derive(Serialize)]
struct Entry {
    name: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Pack(Pack),
    Unpack {
        #[serde(flatten)]
        input: Input,
        limit: u64,
    },
    UnpackEncrypted {
        size: u64,
        #[serde(rename = "passwordBytes")]
        password_bytes: usize,
        limit: u64,
        folder: PathBuf,
    },
    Derive {
        #[serde(rename = "passwordBytes")]
        password_bytes: usize,
    },
    Saved {
        #[serde(rename = "dataDir")]
        data_dir: PathBuf,
        name: String,
        folder: PathBuf,
        fingerprint: Option<String>,
        #[serde(rename = "uploadLimit")]
        upload_limit: u64,
        limit: u64,
        #[serde(rename = "passwordBytes")]
        password_bytes: usize,
    },
}

#[derive(Serialize)]
struct ArchiveInspection {
    fingerprint: String,
    encrypted: bool,
}

#[derive(Serialize)]
struct SavedContents<'a> {
    files: &'a [Entry],
    #[serde(flatten)]
    inspection: &'a ArchiveInspection,
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    while let Some(request) = header(&mut input)? {
        let result = {
            let mut frames = BufWriter::with_capacity(128 * 1024, Frames(&mut output));
            match request {
                Request::Pack(request) => {
                    let encryption_bytes = if request.encrypted {
                        KEY_BYTES + SALT_BYTES
                    } else {
                        0
                    };
                    let size = request
                        .files
                        .iter()
                        .try_fold(encryption_bytes as u64, |total, file| match file.input {
                            Input::File { .. } => Some(total),
                            Input::Inline { size } => total.checked_add(size),
                        })
                        .ok_or("Слишком большой снимок резервной копии")?;
                    with_body(&mut input, size, |body| save_archive(request, body))?
                }
                Request::Unpack {
                    input: source,
                    limit,
                } => match source {
                    Input::File { path } => open(&path).map_err(Into::into).and_then(|file| {
                        unpack(
                            BufReader::with_capacity(64 * 1024, file),
                            limit,
                            &mut frames,
                            None,
                        )
                    }),
                    Input::Inline { size } => {
                        if size > INLINE_ZIP_LIMIT {
                            return Err("Слишком большой ZIP для передачи по каналу".into());
                        }
                        let mut zip = vec![0; size as usize];
                        input.read_exact(&mut zip)?;
                        unpack(Cursor::new(zip), limit, &mut frames, None)
                    }
                },
                Request::UnpackEncrypted {
                    size,
                    password_bytes,
                    limit,
                    folder,
                } => {
                    check_password_length(password_bytes)?;
                    if size > MAX_BACKUP {
                        return Err("Превышен размер бэкапа".into());
                    }
                    with_body(&mut input, size + password_bytes as u64, |body| {
                        let mut password = Sensitive([0; MAX_PASSWORD_BYTES]);
                        let password = &mut password.0[..password_bytes];
                        body.read_exact(password)?;
                        unpack_encrypted(body, size, password, &folder, limit, &mut frames, None)
                    })?
                }
                Request::Derive { password_bytes } => {
                    check_password_length(password_bytes)?;
                    with_body(&mut input, (SALT_BYTES + password_bytes) as u64, |body| {
                        let mut salt = [0; SALT_BYTES];
                        let mut password = Sensitive([0; MAX_PASSWORD_BYTES]);
                        let password = &mut password.0[..password_bytes];
                        body.read_exact(&mut salt)?;
                        body.read_exact(password)?;
                        let key = backup_crypto::derive(password, &salt)?;
                        frames.write_all(&key.0)?;
                        frames.flush()?;
                        Ok(())
                    })?
                }
                Request::Saved {
                    data_dir,
                    name,
                    folder,
                    fingerprint,
                    upload_limit,
                    limit,
                    password_bytes,
                } => {
                    check_password_length(password_bytes)?;
                    with_body(&mut input, password_bytes as u64, |body| {
                        let mut password = Sensitive([0; MAX_PASSWORD_BYTES]);
                        let password = &mut password.0[..password_bytes];
                        body.read_exact(password)?;
                        let file = backup_vault::Vault::new(&data_dir).open_archive(&name)?;
                        unpack_saved(
                            file,
                            password,
                            fingerprint.as_deref(),
                            &folder,
                            upload_limit,
                            limit,
                            &mut frames,
                        )
                    })?
                }
            }
        };
        reply(&mut output, result)?;
    }
    Ok(())
}

fn check_password_length(length: usize) -> Result<()> {
    if length > MAX_PASSWORD_BYTES {
        return Err("Слишком длинный пароль резервной копии".into());
    }
    Ok(())
}

fn save_archive(request: Pack, input: impl BufRead) -> Result<()> {
    write_archive(request, input, u64::MAX)
}

fn write_archive(request: Pack, mut input: impl BufRead, limit: u64) -> Result<()> {
    let directory = request
        .destination
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or("Отсутствует папка резервной копии")?;
    let mut file = tempfile::Builder::new()
        .prefix(".backup-")
        .tempfile_in(directory)?;
    let output = BufWriter::with_capacity(128 * 1024, file.as_file_mut());
    if request.encrypted {
        let mut key = Sensitive([0; KEY_BYTES]);
        let mut salt = [0; SALT_BYTES];
        input.read_exact(&mut key.0)?;
        input.read_exact(&mut salt)?;
        let mut encrypted = backup_crypto::Encrypt::new(output, &key.0, &salt)?;
        drop(key);
        pack(
            &request,
            input,
            BufWriter::with_capacity(128 * 1024, &mut encrypted),
        )?;
        encrypted.finish()?;
    } else {
        pack(&request, input, output)?;
    }
    if file.as_file().metadata()?.len() > limit {
        return Err(
            "Резервная копия превышает лимит восстановления. Увеличьте backupUploadLimitMb".into(),
        );
    }
    file.as_file().sync_all()?;
    file.persist(&request.destination)?;
    atomic_file::sync_parent(&request.destination)
}

pub(crate) fn write_snapshot(
    directory: &Path,
    destination: PathBuf,
    timestamp: time::OffsetDateTime,
    encryption: Option<&backup_vault::ArchiveKey>,
    upload_limit: u64,
    expanded_limit: u64,
) -> Result<()> {
    let mut total = 0;
    let mut files = Vec::new();
    for name in NAMES {
        let path = directory.join(name);
        if let Some(file) = fs::metadata(&path).map(Some).or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error)
            }
        })? {
            total += file.len();
            if total > expanded_limit {
                return Err(EXPANDED.into());
            }
            files.push(Source {
                name: name.into(),
                input: Input::File { path },
            });
        }
    }
    let request = Pack {
        destination,
        encrypted: encryption.is_some(),
        timestamp: (
            timestamp.year().try_into()?,
            timestamp.month() as u8,
            timestamp.day(),
            timestamp.hour(),
            timestamp.minute(),
            timestamp.second(),
        ),
        files,
    };
    if let Some(encryption) = encryption {
        write_archive(
            request,
            Cursor::new(&encryption.key.0).chain(&encryption.salt[..]),
            upload_limit,
        )
    } else {
        write_archive(request, io::empty(), upload_limit)
    }
}

pub(crate) fn read_snapshot(
    source: impl Read + Seek,
    password: &[u8],
    fingerprint: Option<&str>,
    folder: &Path,
    upload_limit: u64,
    expanded_limit: u64,
) -> Result<serde_json::Value> {
    check_password_length(password.len())?;
    let mut source = BufReader::with_capacity(128 * 1024, source);
    let encrypted = source.fill_buf()?.starts_with(backup_crypto::MAGIC);
    let mut digest = Sha256::new();
    let mut total = 0;
    loop {
        let bytes = source.fill_buf()?;
        if bytes.is_empty() {
            break;
        }
        let len = bytes.len();
        total += len as u64;
        if total > upload_limit {
            return Err("Превышен размер бэкапа".into());
        }
        digest.update(bytes);
        source.consume(len);
    }
    let actual = format!("{:x}", digest.finalize());
    if fingerprint.is_some_and(|expected| expected != actual) {
        return Err("Файл резервной копии изменился после проверки".into());
    }
    source.rewind()?;
    let files = if encrypted {
        let mut archive = tempfile::tempfile_in(folder)?;
        backup_crypto::decrypt(source, total, password, &mut archive)?;
        archive.rewind()?;
        extract_files(BufReader::new(archive), folder, expanded_limit)?
    } else {
        extract_files(source, folder, expanded_limit)?
    };
    Ok(serde_json::json!({"files":files,"fingerprint":actual,"encrypted":encrypted}))
}

fn extract_files(source: impl Read + Seek, folder: &Path, limit: u64) -> Result<Vec<Entry>> {
    let (mut zip, files) = inspect_zip(source, limit)?;
    for (index, entry) in files.iter().enumerate() {
        let mut staged = tempfile::NamedTempFile::new_in(folder)?;
        let mut output = BufWriter::new(staged.as_file_mut());
        extract_entry(&mut zip, index, entry.size, &mut output)?;
        output.flush()?;
        drop(output);
        staged.persist_noclobber(folder.join(&entry.name))?;
    }
    Ok(files)
}

fn pack(request: &Pack, mut input: impl BufRead, output: impl Write) -> Result<()> {
    validate_names(request.files.iter().map(|file| file.name.as_str()))?;
    let (year, month, day, hour, minute, second) = request.timestamp;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(DateTime::from_date_and_time(
            year, month, day, hour, minute, second,
        )?)
        .unix_permissions(0o600);
    let mut zip = ZipWriter::new_stream(output);
    for Source {
        name,
        input: source,
    } in &request.files
    {
        match source {
            Input::File { path } => {
                let mut file = match open(path) {
                    Ok(file) => file,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if !file.metadata()?.is_file() {
                    return Err(UNKNOWN_ENTRY.into());
                }
                zip.start_file(name, options)?;
                io::copy(&mut file, &mut zip)?;
            }
            Input::Inline { size } => {
                zip.start_file(name, options)?;
                if io::copy(&mut (&mut input).take(*size), &mut zip)? != *size {
                    return Err("Неполные данные для резервной копии".into());
                }
            }
        }
    }
    if !input.fill_buf()?.is_empty() {
        return Err("Лишние данные для резервной копии".into());
    }
    zip.finish()?.into_inner().flush()?;
    Ok(())
}

fn unpack_encrypted(
    input: impl Read,
    length: u64,
    password: &[u8],
    folder: &Path,
    limit: u64,
    output: impl Write,
    inspection: Option<&ArchiveInspection>,
) -> Result<()> {
    if length <= INLINE_ZIP_LIMIT + backup_crypto::OVERHEAD as u64 {
        let size = length.saturating_sub(backup_crypto::OVERHEAD as u64) as usize;
        let mut archive = Sensitive(vec![0; size]);
        backup_crypto::decrypt(input, length, password, &mut archive.0[..])?;
        return unpack(Cursor::new(archive.0.as_slice()), limit, output, inspection);
    }
    // The anonymous temporary never becomes an import result. Open the ZIP after its tag is verified.
    let mut archive = tempfile::tempfile_in(folder)?;
    backup_crypto::decrypt(input, length, password, &mut archive)?;
    archive.rewind()?;
    unpack(
        BufReader::with_capacity(64 * 1024, archive),
        limit,
        output,
        inspection,
    )
}

fn unpack_saved(
    file: File,
    password: &[u8],
    expected: Option<&str>,
    folder: &Path,
    upload_limit: u64,
    limit: u64,
    output: impl Write,
) -> Result<()> {
    const CHANGED: &str = "Файл резервной копии изменился после проверки";
    const TOO_LARGE: &str = "Превышен размер резервной копии";
    let initial = file_stamp::stamp(&file)?;
    let upload_limit = upload_limit.min(MAX_BACKUP);
    if initial.len > upload_limit {
        return Err(TOO_LARGE.into());
    }
    let mut source = BufReader::with_capacity(128 * 1024, file);
    let encrypted = source.fill_buf()?.starts_with(backup_crypto::MAGIC);
    let mut digest = Sha256::new();
    let mut total = 0;
    loop {
        let slice = source.fill_buf()?;
        if slice.is_empty() {
            break;
        }
        let size = slice.len();
        total += size as u64;
        if total > upload_limit {
            return Err(TOO_LARGE.into());
        }
        digest.update(slice);
        source.consume(size);
    }
    let fingerprint = format!("{:x}", digest.finalize());
    if total != initial.len
        || file_stamp::stamp(source.get_ref())? != initial
        || expected.is_some_and(|expected| expected != fingerprint)
    {
        return Err(CHANGED.into());
    }
    let inspection = ArchiveInspection {
        fingerprint,
        encrypted,
    };
    source.rewind()?;
    if encrypted {
        unpack_encrypted(
            &mut source,
            total,
            password,
            folder,
            limit,
            output,
            Some(&inspection),
        )?;
    } else {
        unpack(&mut source, limit, output, Some(&inspection))?;
    }
    if file_stamp::stamp(source.get_ref())? != initial {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn unpack(
    source: impl Read + Seek,
    limit: u64,
    mut output: impl Write,
    inspection: Option<&ArchiveInspection>,
) -> Result<()> {
    let (mut zip, files) = inspect_zip(source, limit)?;
    if let Some(inspection) = inspection {
        serde_json::to_writer(
            &mut output,
            &SavedContents {
                files: &files,
                inspection,
            },
        )?;
    } else {
        serde_json::to_writer(&mut output, &files)?;
    }
    output.write_all(b"\n")?;
    for (index, entry) in files.iter().enumerate() {
        extract_entry(&mut zip, index, entry.size, &mut output)?;
    }
    output.flush()?;
    Ok(())
}

fn inspect_zip<R: Read + Seek>(mut source: R, limit: u64) -> Result<(ZipArchive<R>, Vec<Entry>)> {
    let expected = directory(&mut source)?;
    let mut zip = ZipArchive::new(source).map_err(|_| INVALID_ZIP)?;
    if zip.len() != expected.entries || zip.central_directory_start() != expected.offset {
        return Err(ENTRY_COUNT.into());
    }
    validate_names(zip.file_names())?;
    if zip.index_for_name("backup-info.json").is_none()
        || (zip.index_for_name("config.json").is_none()
            && zip.index_for_name("reading-lists.json").is_none())
    {
        return Err("Файл не похож на полный бэкап inpx-web".into());
    }

    let mut files = Vec::with_capacity(zip.len());
    let mut remaining = limit.min(MAX_EXPANDED);
    for index in 0..zip.len() {
        let file = zip.by_index_raw(index).map_err(|_| INVALID_ZIP)?;
        if !file.is_file() {
            return Err(UNKNOWN_ENTRY.into());
        }
        let size = file.size();
        remaining = remaining.checked_sub(size).ok_or(EXPANDED)?;
        files.push(Entry {
            name: file.name().to_owned(),
            size,
        });
    }
    Ok((zip, files))
}

fn extract_entry(
    zip: &mut ZipArchive<impl Read + Seek>,
    index: usize,
    size: u64,
    mut output: impl Write,
) -> Result<()> {
    let file = zip.by_index(index).map_err(|_| INVALID_ZIP)?;
    let extracted = io::copy(&mut file.take(size + 1), &mut output)?;
    if extracted > size {
        return Err(EXPANDED.into());
    }
    if extracted != size {
        return Err(INVALID_ZIP.into());
    }
    Ok(())
}

fn open(path: &Path) -> io::Result<File> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path)
}

fn validate_names<'a>(names: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut unique = HashSet::with_capacity(NAMES.len());
    for name in names {
        if !NAMES.contains(&name) {
            return Err(UNKNOWN_ENTRY.into());
        }
        if !unique.insert(name) {
            return Err(ENTRY_COUNT.into());
        }
    }
    Ok(())
}

struct Directory {
    entries: usize,
    offset: u64,
}

// Bound the central directory before ZipArchive allocates per-entry metadata.
// ZipArchive indexes files by name, so the count also detects repeated names.
fn directory(input: &mut (impl Read + Seek)) -> Result<Directory> {
    const EOCD_LENGTH: usize = 22;
    const ZIP64_LOCATOR_LENGTH: usize = 20;
    let length = input.seek(SeekFrom::End(0))?;
    let tail_length =
        length.min((EOCD_LENGTH + usize::from(u16::MAX) + ZIP64_LOCATOR_LENGTH) as u64);
    let tail_start = length - tail_length;
    input.seek(SeekFrom::Start(tail_start))?;
    let mut tail = vec![0; tail_length as usize];
    input.read_exact(&mut tail)?;
    let at = (0..=tail.len().checked_sub(EOCD_LENGTH).ok_or(INVALID_ZIP)?)
        .rev()
        .find(|&at| {
            &tail[at..at + 4] == b"PK\x05\x06"
                && at + EOCD_LENGTH + usize::from(le16(&tail, at + 20)) == tail.len()
        })
        .ok_or(INVALID_ZIP)?;
    let end = &tail[at..];
    let mut boundary = tail_start + at as u64;
    let fields = match at
        .checked_sub(ZIP64_LOCATOR_LENGTH)
        .map(|start| &tail[start..at])
    {
        Some(locator) if &locator[..4] == b"PK\x06\x07" => {
            let zip64_offset = le64(locator, 8);
            let locator_offset = boundary - ZIP64_LOCATOR_LENGTH as u64;
            if le32(locator, 4) != 0
                || le32(locator, 16) != 1
                || zip64_offset
                    .checked_add(56)
                    .is_none_or(|minimum| minimum > locator_offset)
            {
                return Err(INVALID_ZIP.into());
            }
            input.seek(SeekFrom::Start(zip64_offset))?;
            let mut zip64 = [0; 56];
            input.read_exact(&mut zip64)?;
            if &zip64[..4] != b"PK\x06\x06"
                || le32(&zip64, 16) != 0
                || le32(&zip64, 20) != 0
                || le64(&zip64, 4) != locator_offset - zip64_offset - 12
                || le64(&zip64, 24) != le64(&zip64, 32)
            {
                return Err(INVALID_ZIP.into());
            }
            boundary = zip64_offset;
            (le64(&zip64, 32), le64(&zip64, 48), le64(&zip64, 40))
        }
        _ => {
            if le16(end, 4) != 0 || le16(end, 6) != 0 || le16(end, 8) != le16(end, 10) {
                return Err(INVALID_ZIP.into());
            }
            (
                u64::from(le16(end, 10)),
                u64::from(le32(end, 16)),
                u64::from(le32(end, 12)),
            )
        }
    };
    let (entries, offset, size) = fields;
    if entries > NAMES.len() as u64 {
        return Err(ENTRY_COUNT.into());
    }
    if offset.checked_add(size) != Some(boundary) {
        return Err(INVALID_ZIP.into());
    }
    check_directory_headers(input, offset, boundary, entries)?;
    Ok(Directory {
        entries: entries as usize,
        offset,
    })
}

fn check_directory_headers(
    input: &mut (impl Read + Seek),
    mut position: u64,
    end: u64,
    entries: u64,
) -> Result<()> {
    const HEADER_LENGTH: u64 = 46;
    let mut record = [0; HEADER_LENGTH as usize];
    for _ in 0..entries {
        if end - position < HEADER_LENGTH {
            return Err(INVALID_ZIP.into());
        }
        input.seek(SeekFrom::Start(position))?;
        input.read_exact(&mut record)?;
        if &record[..4] != b"PK\x01\x02" {
            return Err(INVALID_ZIP.into());
        }
        let variable = u64::from(le16(&record, 28))
            + u64::from(le16(&record, 30))
            + u64::from(le16(&record, 32));
        position += HEADER_LENGTH + variable;
        if position > end {
            return Err(INVALID_ZIP.into());
        }
    }
    if position != end {
        // An optional digital signature can follow the last central header.
        input.seek(SeekFrom::Start(position))?;
        let mut signature = [0; 6];
        if end - position < 6 {
            return Err(INVALID_ZIP.into());
        }
        input.read_exact(&mut signature)?;
        if &signature[..4] != b"PK\x05\x05" || position + 6 + u64::from(le16(&signature, 4)) != end
        {
            return Err(ENTRY_COUNT.into());
        }
    }
    Ok(())
}

fn le16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}

fn le32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn le64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}
