use std::cell::Cell;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::PathBuf;
use std::rc::Rc;

use serde::Deserialize;
use zip::{
    CompressionMethod, DateTime, ZipWriter,
    result::ZipError,
    write::{SimpleFileOptions, StreamWriter},
};

use crate::Result;
use crate::framed_protocol::{Frames, complete, header, with_body};

const MAX_BOOKS: usize = 200;
const INPUT_LIMIT: u64 = 512 * 1024 * 1024;
const OUTPUT_LIMIT: u64 = 1024 * 1024 * 1024;
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

struct Batch {
    path: PathBuf,
    zip: Option<ZipWriter<StreamWriter<BudgetWriter>>>,
    names: HashSet<String>,
    expanded: u64,
    published: bool,
    exceeded: Rc<Cell<bool>>,
}

impl Batch {
    fn open(path: PathBuf, limit: u64) -> Result<Self> {
        let exceeded = Rc::new(Cell::new(false));
        let output = BudgetWriter {
            output: BufWriter::with_capacity(128 * 1024, File::create_new(&path)?),
            remaining: limit.min(OUTPUT_LIMIT),
            written: 0,
            exceeded: Rc::clone(&exceeded),
        };
        Ok(Self {
            path,
            zip: Some(ZipWriter::new_stream(output)),
            names: HashSet::new(),
            expanded: 0,
            published: false,
            exceeded,
        })
    }

    fn add(&mut self, entry: Entry, reader: impl Read) -> Result<()> {
        if self.names.len() >= MAX_BOOKS
            || !safe_name(&entry.name)
            || !self.names.insert(entry.name.to_lowercase())
        {
            return Err("Недопустимое имя или слишком много книг в пакетном ZIP".into());
        }
        self.expanded = self
            .expanded
            .checked_add(entry.size)
            .filter(|&bytes| bytes <= INPUT_LIMIT)
            .ok_or("ZIP превышает лимит 512 МБ")?;
        let [year, month, day, hour, minute, second] = entry.mtime;
        let mut options = SimpleFileOptions::default()
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
        if io::copy(&mut reader.take(entry.size + 1), zip)? != entry.size {
            return Err("Размер книги изменился при создании ZIP".into());
        }
        zip.flush()?;
        Ok(())
    }

    fn finish(mut self) -> Result<u64> {
        let mut output = self
            .zip
            .take()
            .expect("active batch writer")
            .finish()?
            .into_inner();
        output.flush()?;
        let bytes = output.written;
        drop(output);
        self.published = true;
        Ok(bytes)
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
                Batch::open(output, limit).map(|session| {
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
