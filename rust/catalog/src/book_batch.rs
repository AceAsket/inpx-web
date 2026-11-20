use std::cell::Cell;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;
use zip::{
    CompressionMethod, DateTime, ZipWriter,
    result::ZipError,
    write::{SimpleFileOptions, StreamWriter},
};

use crate::Result;
use crate::framed_protocol::{Frames, complete, header, with_body};

#[derive(Clone, Copy)]
pub struct BatchLimits {
    pub books: usize,
    pub output_bytes: u64,
    input_bytes: u64,
}

impl BatchLimits {
    pub const STANDARD: Self = Self {
        books: 200,
        input_bytes: 512 << 20,
        output_bytes: 1 << 30,
    };
    pub const UNLIMITED: Self = Self {
        books: usize::MAX,
        input_bytes: u64::MAX,
        output_bytes: u64::MAX,
    };
}
const INLINE_LIMIT: u64 = 8 * 1024 * 1024;
const FULL: &str = "Кэш пакетных ZIP заполнен. Повторите через 15 минут.";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Begin { output: PathBuf, limit: u64 },
    Add { entry: Entry, inline: bool },
    Finish,
    Abort,
}

#[derive(Deserialize)]
struct Entry {
    source: PathBuf,
    name: String,
    size: u64,
    mode: u32,
    mtime: [u16; 6],
}

struct BudgetWriter {
    output: BufWriter<File>,
    remaining: u64,
    written: u64,
    exceeded: Rc<Cell<bool>>,
}

impl Write for BudgetWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() as u64 > self.remaining {
            self.exceeded.set(true);
            return Err(io::Error::other(FULL));
        }
        let written = self.output.write(buf)?;
        self.remaining -= written as u64;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

pub struct Batch {
    path: PathBuf,
    zip: Option<ZipWriter<StreamWriter<BudgetWriter>>>,
    names: HashSet<String>,
    expanded: u64,
    limits: BatchLimits,
    published: bool,
    exceeded: Rc<Cell<bool>>,
}

impl Batch {
    pub fn open(path: PathBuf, limits: BatchLimits, output_budget: u64) -> Result<Self> {
        let exceeded = Rc::new(Cell::new(false));
        let output = BudgetWriter {
            output: BufWriter::with_capacity(128 * 1024, File::create_new(&path)?),
            remaining: output_budget.min(limits.output_bytes),
            written: 0,
            exceeded: Rc::clone(&exceeded),
        };
        Ok(Self {
            path,
            zip: Some(ZipWriter::new_stream(output)),
            names: HashSet::new(),
            expanded: 0,
            limits,
            published: false,
            exceeded,
        })
    }

    fn add(&mut self, entry: Entry, reader: impl Read) -> Result<()> {
        if self.names.len() >= self.limits.books
            || !safe_name(&entry.name)
            || !self.names.insert(entry.name.to_lowercase())
        {
            return Err("Недопустимое имя или слишком много книг в пакетном ZIP".into());
        }
        self.expanded = self
            .expanded
            .checked_add(entry.size)
            .filter(|&bytes| bytes <= self.limits.input_bytes)
            .ok_or("Общий размер книг в ZIP превышает лимит 512 МиБ")?;
        let [year, month, day, hour, minute, second] = entry.mtime;
        let mut options = SimpleFileOptions::default()
            // Leave room for deflate overhead when an entry approaches the ZIP32 limit.
            .large_file(entry.size >= 1 << 31)
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6))
            .unix_permissions(entry.mode);
        if let Ok(date) = DateTime::from_date_and_time(
            year,
            month as u8,
            day as u8,
            hour as u8,
            minute as u8,
            second as u8,
        ) {
            options = options.last_modified_time(date);
        }
        let zip = self.zip.as_mut().expect("active batch writer");
        zip.start_file(entry.name, options)?;
        if io::copy(&mut reader.take(entry.size.saturating_add(1)), zip)? != entry.size {
            return Err("Размер книги изменился при создании ZIP".into());
        }
        zip.flush()?;
        Ok(())
    }

    pub fn add_file(&mut self, path: &Path, name: String) -> Result<()> {
        let reader = File::open(path)?;
        let size = reader.metadata()?.len();
        self.add(
            Entry {
                source: path.to_path_buf(),
                name,
                size,
                mode: 0o644,
                mtime: [1980, 1, 1, 0, 0, 0],
            },
            reader,
        )
    }

    pub fn finish(mut self) -> Result<u64> {
        let output = self.zip.take().expect("active batch writer").finish();
        if self.exceeded.get() {
            return Err(FULL.into());
        }
        let mut output = output?.into_inner();
        output.flush()?;
        let bytes = output.written;
        drop(output);
        self.published = true;
        Ok(bytes)
    }
}

pub fn entry_name(
    book: &crate::book_delivery::Book,
    template: &str,
    index: usize,
    names: &mut HashSet<String>,
) -> Result<String> {
    let ext = book.extension().ok_or("Недопустимое расширение книги")?;
    let folder = segment(&book.series, "Вне серий");
    let order = book
        .serno
        .filter(|value| *value != 0.0)
        .map_or_else(String::new, |value| format!("{value}. "));
    let label = segment(
        &format!("{order}{} — {}", book.author, book.title),
        &format!("Книга-{}", index + 1),
    );
    let filename = if template.trim().is_empty() {
        format!("{:03}_{label}.{ext}", index + 1)
    } else {
        book.filename(template)?
    };
    let stem = filename
        .strip_suffix(&format!(".{ext}"))
        .unwrap_or(&filename);
    let mut entry = format!("{folder}/{filename}");
    let mut duplicate = 1;
    while !names.insert(entry.to_lowercase()) {
        duplicate += 1;
        entry = format!("{folder}/{stem}_{duplicate}.{ext}");
    }
    Ok(entry)
}

fn segment(value: &str, fallback: &str) -> String {
    let safe: String = value
        .nfc()
        .filter(|ch| !ch.is_ascii_control())
        .map(|ch| {
            if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let safe: String = safe
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take(120)
        .collect();
    if safe.is_empty() {
        fallback.to_owned()
    } else {
        safe
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        drop(self.zip.take());
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn safe_name(name: &str) -> bool {
    !name
        .bytes()
        .any(|byte| byte < 32 || matches!(byte, b':' | b'\\'))
        && name.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn active(batch: &mut Option<Batch>) -> Result<&mut Batch> {
    batch
        .as_mut()
        .ok_or_else(|| "Пакетный ZIP ещё не начат".into())
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut batch: Option<Batch> = None;
    while let Some(request) = header::<Request>(&mut input)? {
        let exceeded = batch.as_ref().map(|session| Rc::clone(&session.exceeded));
        let result = match request {
            Request::Begin { output, limit } if batch.is_none() => {
                Batch::open(output, BatchLimits::STANDARD, limit).map(|session| {
                    batch = Some(session);
                    None
                })
            }
            Request::Begin { .. } => Err("Другой ZIP уже готовится".into()),
            Request::Add {
                entry,
                inline: true,
            } => with_body(&mut input, entry.size, |reader| {
                if entry.size > INLINE_LIMIT {
                    return Err("Слишком большой запрос пакетного ZIP".into());
                }
                active(&mut batch)?.add(entry, reader).map(|()| None)
            })?,
            Request::Add {
                entry,
                inline: false,
            } => active(&mut batch).and_then(|batch| {
                let reader = File::open(&entry.source)?;
                batch.add(entry, reader).map(|()| None)
            }),
            Request::Finish => batch
                .take()
                .ok_or_else(|| "Пакетный ZIP ещё не начат".into())
                .and_then(|batch| batch.finish().map(Some)),
            Request::Abort => {
                batch = None;
                Ok(None)
            }
        };
        match result {
            Ok(bytes) => {
                if let Some(bytes) = bytes {
                    let data = serde_json::to_vec(&bytes)?;
                    Frames(&mut output).write_all(&data)?;
                }
                complete(&mut output, None, None)?;
            }
            Err(error) => {
                batch = None;
                if exceeded.is_some_and(|flag| flag.get()) {
                    complete(&mut output, Some(FULL.into()), None)?;
                } else {
                    let io_error = error.downcast_ref::<io::Error>().or_else(|| {
                        match error.downcast_ref::<ZipError>() {
                            Some(ZipError::Io(error)) => Some(error),
                            _ => None,
                        }
                    });
                    let code = io_error.and_then(|error| match error.kind() {
                        io::ErrorKind::NotFound => Some("ENOENT"),
                        io::ErrorKind::StorageFull => Some("ENOSPC"),
                        io::ErrorKind::PermissionDenied => Some("EACCES"),
                        io::ErrorKind::AlreadyExists => Some("EEXIST"),
                        _ => None,
                    });
                    complete(&mut output, Some(error.to_string()), code)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_limits_follow_the_selected_profile() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("last.txt");
        fs::write(&source, b"book")?;
        for (name, limits) in [
            ("balanced", BatchLimits::STANDARD),
            ("unlimited", BatchLimits::UNLIMITED),
        ] {
            let path = dir.path().join(format!("{name}.zip"));
            let mut archive = Batch::open(path.clone(), limits, limits.output_bytes)?;
            archive.expanded = BatchLimits::STANDARD.input_bytes;
            let result = archive.add_file(&source, "last.txt".into());
            if name == "balanced" {
                assert!(result.unwrap_err().to_string().contains("512"));
                drop(archive);
                assert!(!path.exists());
            } else {
                result?;
                assert!(archive.finish()? > 0);
            }
        }
        Ok(())
    }
}
