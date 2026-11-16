use std::borrow::Cow;
use std::fs::{self, File, FileTimes};
use std::io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::{Compression, write::GzEncoder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::Result;
use crate::framed_protocol::{Frames, complete, header, with_body};

const BUFFER_BYTES: usize = 128 * 1024;
const DESCRIPTOR_BYTES: u64 = 48 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    Publish {
        source: PathBuf,
        directory: PathBuf,
        token: String,
        descriptor: Descriptor,
        raw: bool,
    },
    RegisterRemote {
        directory: PathBuf,
        hash: String,
        token: String,
        descriptor: Descriptor,
    },
    Inspect {
        directory: PathBuf,
        hash: String,
        asset_version: Option<String>,
        touch: bool,
        #[serde(default)]
        probe_raw: bool,
    },
    RawReady {
        output: PathBuf,
        expected_size: u64,
    },
    Inflate {
        source: PathBuf,
        output: PathBuf,
        token: String,
        expected_size: u64,
    },
    Zip {
        source: PathBuf,
        output: PathBuf,
        token: String,
        name: String,
    },
    NormalizeFb2 {
        source: PathBuf,
    },
    NormalizeFb2Bytes {
        source: PathBuf,
        size: u64,
    },
    RepackEpub {
        source: PathBuf,
        output: PathBuf,
    },
    RepackEpubBytes {
        output: PathBuf,
        size: u64,
    },
    ConvertEpub {
        source: PathBuf,
        output: PathBuf,
        token: String,
        maximum: u64,
    },
    ConvertEpubBytes {
        output: PathBuf,
        token: String,
        maximum: u64,
        size: u64,
    },
    AppendEpubImages {
        output: PathBuf,
        manifest: PathBuf,
        remaining: u64,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Descriptor {
    pub(crate) book_uid: String,
    pub(crate) lib_folder: String,
    pub(crate) lib_file: String,
    pub(crate) source_lib_dir: String,
    pub(crate) down_file_name: String,
    pub(crate) asset_version: String,
    #[serde(default)]
    pub(crate) size: u64,
}

#[derive(Serialize)]
pub(crate) struct Published {
    pub(crate) hash: String,
    pub(crate) size: u64,
}

pub(crate) struct Staging<'a> {
    directory: Cow<'a, Path>,
    token: &'a str,
}

impl<'a> Staging<'a> {
    pub(crate) fn new(directory: &'a Path, token: &'a str) -> Result<Self> {
        if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Некорректный идентификатор операции с кэшем книг".into());
        }
        // tempfile publishes through Win32 APIs that need the extended-length path.
        let directory = if cfg!(windows) {
            Cow::Owned(directory.canonicalize()?)
        } else {
            Cow::Borrowed(directory)
        };
        Ok(Self { directory, token })
    }

    fn file(&self, extension: &str) -> io::Result<NamedTempFile> {
        tempfile::Builder::new()
            .prefix(&format!(".book-cache-{}-{extension}", self.token))
            .rand_bytes(0)
            .tempfile_in(&self.directory)
    }

    fn descriptor(&self, output: &Path, descriptor: &Descriptor) -> Result<()> {
        // Readers see the descriptor only when the corresponding book is complete.
        let mut temporary = self.file("json")?;
        let data = serde_json::to_vec(descriptor)?;
        if data.len() as u64 > DESCRIPTOR_BYTES {
            return Err("Слишком большое описание файла кэша".into());
        }
        temporary.write_all(&data)?;
        temporary.as_file().sync_all()?;
        temporary.persist(output)?;
        Ok(())
    }

    fn destination(&self, output: &Path) -> Result<PathBuf> {
        Ok(self
            .directory
            .join(output.file_name().ok_or("Не указано имя файла кэша")?))
    }
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    while let Some(request) = header::<Request>(&mut input)? {
        let result = match request {
            Request::NormalizeFb2Bytes { source, size } => {
                prepared_bytes(&mut input, size, |bytes| {
                    Ok(serde_json::to_value(crate::fb2_prepare::normalize_bytes(
                        &source, &bytes,
                    )?)?)
                })?
            }
            Request::RepackEpubBytes { output, size } => {
                prepared_bytes(&mut input, size, |bytes| {
                    Ok(serde_json::to_value(crate::epub_prepare::repack_bytes(
                        bytes, &output,
                    )?)?)
                })?
            }
            Request::ConvertEpubBytes {
                output,
                token,
                maximum,
                size,
            } => prepared_bytes(&mut input, size, |bytes| {
                convert_epub(Cursor::new(bytes), &output, &token, maximum)
            })?,
            request => query(request),
        };
        let result = result.and_then(|result| {
            // Serialize once before sending any framed data.
            let bytes = serde_json::to_vec(&result)?;
            Frames(&mut output).write_all(&bytes)?;
            Ok(())
        });
        match result {
            Ok(()) => complete(&mut output, None, None)?,
            Err(error) => {
                let code = if error.is::<crate::epub_prepare::OutputLimit>() {
                    Some("INPX_RESOURCE_OUTPUT_LIMIT")
                } else if error.is::<crate::epub_fb2::Invalid>() {
                    Some("INPX_INVALID_EPUB")
                } else {
                    error
                        .downcast_ref::<io::Error>()
                        .and_then(|io| match io.kind() {
                            io::ErrorKind::NotFound => Some("ENOENT"),
                            io::ErrorKind::PermissionDenied => Some("EACCES"),
                            io::ErrorKind::AlreadyExists => Some("EEXIST"),
                            io::ErrorKind::StorageFull => Some("ENOSPC"),
                            _ => None,
                        })
                };
                let message =
                    code.map_or_else(|| error.to_string(), |code| format!("{code}: {error}"));
                complete(&mut output, Some(message), code)?;
            }
        }
    }
    Ok(())
}

fn prepared_bytes<R: BufRead>(
    input: &mut R,
    size: u64,
    prepare: impl FnOnce(Vec<u8>) -> Result<Value>,
) -> Result<Result<Value>> {
    with_body(input, size, |reader| {
        if size > 8 * 1024 * 1024 {
            return Err("Превышен размер передачи книги рабочему процессу".into());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        reader.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != size {
            return Err("Неполные данные книги".into());
        }
        prepare(bytes)
    })
}

fn query(request: Request) -> Result<Value> {
    match request {
        Request::Publish {
            source,
            directory,
            token,
            descriptor,
            raw,
        } => Ok(serde_json::to_value(publish(
            &source,
            &Staging::new(&directory, &token)?,
            descriptor,
            raw,
        )?)?),
        Request::RegisterRemote {
            directory,
            hash,
            token,
            descriptor,
        } => {
            let stage = Staging::new(&directory, &token)?;
            let (cache, description) = paths(&stage.directory, &hash)?;
            touch(open_file(&cache, true)?, SystemTime::now())?;
            stage.descriptor(&description, &descriptor)?;
            Ok(Value::Null)
        }
        Request::Inspect {
            directory,
            hash,
            asset_version,
            touch: refresh,
            probe_raw,
        } => inspect(
            &directory,
            &hash,
            asset_version.as_deref(),
            refresh,
            probe_raw,
        ),
        Request::RawReady {
            output,
            expected_size,
        } => Ok(Value::Bool(valid_raw(&output, expected_size)?)),
        Request::Inflate {
            source,
            output,
            token,
            expected_size,
        } => {
            let parent = output.parent().ok_or("Не задан каталог файла кэша")?;
            let stage = Staging::new(parent, &token)?;
            let created = inflate(&source, &stage.destination(&output)?, &stage, expected_size)?;
            Ok(Value::Bool(created))
        }
        Request::Zip {
            source,
            output,
            token,
            name,
        } => {
            let parent = output.parent().ok_or("Не задан каталог файла кэша")?;
            let stage = Staging::new(parent, &token)?;
            Ok(Value::Bool(zip_book(
                &source,
                &stage.destination(&output)?,
                &stage,
                &name,
            )?))
        }
        Request::NormalizeFb2 { source } => Ok(serde_json::to_value(
            crate::fb2_prepare::normalize(&source)?,
        )?),
        Request::RepackEpub { source, output } => Ok(serde_json::to_value(
            crate::epub_prepare::repack(&source, &output)?,
        )?),
        Request::ConvertEpub {
            source,
            output,
            token,
            maximum,
        } => convert_epub(
            BufReader::new(File::open(&source)?),
            &output,
            &token,
            maximum,
        ),
        Request::AppendEpubImages {
            output,
            manifest,
            remaining,
        } => {
            crate::epub_prepare::append_images(&output, &manifest, remaining)?;
            Ok(Value::Null)
        }
        Request::NormalizeFb2Bytes { .. }
        | Request::RepackEpubBytes { .. }
        | Request::ConvertEpubBytes { .. } => {
            unreachable!("framed input handled by serve")
        }
    }
}

pub(crate) fn convert_epub(
    source: impl Read + Seek,
    output: &Path,
    token: &str,
    maximum: u64,
) -> Result<Value> {
    let stage = Staging::new(output.parent().ok_or("Не задан каталог результата")?, token)?;
    let target = stage.destination(output)?;
    let mut temporary = stage.file("convert")?;
    crate::epub_fb2::convert(
        source,
        BufWriter::with_capacity(BUFFER_BYTES, &mut temporary),
        maximum,
    )?;
    temporary
        .persist_noclobber(&target)
        .map_err(|error| error.error)?;
    Ok(Value::Null)
}

fn paths(directory: &Path, hash: &str) -> Result<(PathBuf, PathBuf)> {
    if hash.is_empty() || hash.len() > 128 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Некорректный хеш файла кэша".into());
    }
    Ok((
        directory.join(hash),
        directory.join(format!("{hash}.d.json")),
    ))
}

fn open_file(path: &Path, refresh: bool) -> io::Result<File> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::GENERIC_READ;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_ATTRIBUTES,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if refresh {
            options.access_mode(GENERIC_READ | FILE_WRITE_ATTRIBUTES);
        }
    }
    let _ = refresh;
    options.open(path)
}

pub(crate) fn regular_file(path: &Path, refresh: bool) -> io::Result<Option<File>> {
    match open_file(path, refresh) {
        Ok(file) => {
            let metadata = file.metadata()?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Ok(None);
                }
            }
            Ok(metadata.is_file().then_some(file))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => Ok(None),
        Err(error) => Err(error),
    }
}

fn touch(file: File, time: SystemTime) -> io::Result<()> {
    file.set_times(FileTimes::new().set_accessed(time).set_modified(time))
}

pub(crate) fn inspect(
    directory: &Path,
    hash: &str,
    asset_version: Option<&str>,
    refresh: bool,
    probe_raw: bool,
) -> Result<Value> {
    let (cache, description) = paths(directory, hash)?;
    let Some(descriptor) = regular_file(&description, refresh)? else {
        return Ok(Value::Null);
    };
    let mut bytes = Vec::new();
    (&descriptor)
        .take(DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > DESCRIPTOR_BYTES {
        return Ok(Value::Null);
    }
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let Ok(Value::Object(mut value)) = serde_json::from_slice::<Value>(text) else {
        return Ok(Value::Null);
    };
    if asset_version
        .is_some_and(|expected| value.get("assetVersion").and_then(Value::as_str) != Some(expected))
    {
        return Ok(Value::Null);
    }
    let Some(book) = regular_file(&cache, refresh)? else {
        return Ok(Value::Null);
    };
    if refresh {
        let time = SystemTime::now();
        touch(book, time)?;
        touch(descriptor, time)?;
    }
    if probe_raw {
        let size = value
            .get("size")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let raw = valid_raw(&directory.join(format!("{hash}.raw")), size)?;
        value.insert("rawReady".into(), Value::Bool(raw));
    }
    Ok(Value::Object(value))
}

pub(crate) fn publish(
    source: &Path,
    stage: &Staging<'_>,
    mut descriptor: Descriptor,
    raw: bool,
) -> Result<Published> {
    let mut input = File::open(source)?;
    let mut temporary = stage.file("gzip")?;
    let mut encoder = GzEncoder::new(
        BufWriter::with_capacity(BUFFER_BYTES, &mut temporary),
        Compression::new(4),
    );
    let mut digest = Sha256::new();
    let mut buffer = vec![0; BUFFER_BYTES];
    let mut size = 0;
    loop {
        let length = input.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        let block = &buffer[..length];
        digest.update(block);
        encoder.write_all(block)?;
        size += length as u64;
    }
    encoder.finish()?.flush()?;
    drop(input);

    let hash = format!("{:x}", digest.finalize());
    let (cache, description) = paths(&stage.directory, &hash)?;
    match temporary.persist_noclobber(&cache) {
        Ok(_) => {}
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            let file = regular_file(&cache, true)?.ok_or("Invalid existing book cache file")?;
            touch(file, SystemTime::now())?;
        }
        Err(error) => return Err(error.into()),
    }
    if raw && size != 0 {
        let raw_path = stage.directory.join(format!("{hash}.raw"));
        if !valid_raw(&raw_path, size)? {
            match fs::rename(source, &raw_path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                    let mut raw = stage.file("raw")?;
                    let bytes = io::copy(&mut File::open(source)?, raw.as_file_mut())?;
                    if bytes != size {
                        return Err("Размер файла книги изменился при копировании".into());
                    }
                    raw.persist(&raw_path)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    descriptor.size = size;
    stage.descriptor(&description, &descriptor)?;
    Ok(Published { hash, size })
}

fn valid_raw(path: &Path, expected: u64) -> io::Result<bool> {
    let Some(file) = regular_file(path, false)? else {
        return Ok(false);
    };
    let len = file.metadata()?.len();
    Ok(len != 0 && (expected == 0 || len == expected))
}

pub(crate) fn inflate(
    source: &Path,
    output: &Path,
    stage: &Staging<'_>,
    expected: u64,
) -> Result<bool> {
    if valid_raw(output, expected)? {
        return Ok(false);
    }
    let reader = BufReader::with_capacity(BUFFER_BYTES, open_cached(source)?);
    let mut temporary = stage.file("raw")?;
    let maximum = if expected == 0 {
        u64::MAX
    } else {
        expected.saturating_add(1)
    };
    let mut writer = BufWriter::with_capacity(BUFFER_BYTES, &mut temporary);
    let bytes = crate::gzip::inflate(reader, &mut writer, maximum)?;
    if bytes == 0 || (expected != 0 && bytes != expected) {
        return Err("Подготовленный файл кэша пуст или имеет неверный размер".into());
    }
    writer.flush()?;
    drop(writer);
    temporary.persist(output)?;
    Ok(true)
}

pub(crate) fn zip_book(
    source: &Path,
    output: &Path,
    stage: &Staging<'_>,
    name: &str,
) -> Result<bool> {
    if valid_raw(output, 0)? {
        return Ok(false);
    }
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err("Недопустимое имя книги в ZIP".into());
    }
    let mut source = open_cached(source)?;
    let stat = source.metadata()?;
    let mut temporary = stage.file("zip")?;
    let mut zip = ZipWriter::new(temporary.as_file_mut());
    let mut options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .large_file(stat.len() >= 0xffff_0000);
    if let Ok(modified) = stat.modified()
        && let Ok(elapsed) = modified.duration_since(UNIX_EPOCH)
        && let Ok(date) = time::OffsetDateTime::from_unix_timestamp(elapsed.as_secs() as i64)
        && let Ok(dos) = zip::DateTime::from_date_and_time(
            date.year() as u16,
            date.month() as u8,
            date.day(),
            date.hour(),
            date.minute(),
            date.second(),
        )
    {
        options = options.last_modified_time(dos);
    }
    zip.start_file(name, options)?;
    if io::copy(&mut source, &mut zip)? != stat.len() {
        return Err("Размер книги изменился при создании ZIP".into());
    }
    zip.finish()?;
    temporary.persist(output)?;
    Ok(true)
}

fn open_cached(path: &Path) -> io::Result<File> {
    regular_file(path, false)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Book cache file not found"))
}
