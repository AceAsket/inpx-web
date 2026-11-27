use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Seek};
use std::path::Path;

use serde::Serialize;
use zip::{ZipArchive, result::ZipError};

use crate::record::{self, DEFAULT_STRUCTURE, Record, field_type, js_whitespace};

#[derive(Debug, Serialize)]
pub struct Field {
    pub field: String,
    #[serde(rename = "type")]
    pub kind: char,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub collection: String,
    pub structure: String,
    pub version: String,
    pub rec_struct: Vec<Field>,
}

impl Info {
    pub fn folder(collection: String) -> Self {
        Self {
            collection,
            structure: "folder".into(),
            version: String::new(),
            rec_struct: record_fields(DEFAULT_STRUCTURE),
        }
    }
}

fn record_fields(structure: &str) -> Vec<Field> {
    let lower = structure.to_lowercase();
    let mut fields: Vec<_> = lower.split(';').collect();
    if !fields.contains(&"folder") {
        fields.push("folder");
    }
    fields
        .into_iter()
        .filter_map(|field| {
            field_type(field).map(|kind| Field {
                field: field.into(),
                kind,
            })
        })
        .collect()
}

pub struct Archive<R> {
    zip: ZipArchive<R>,
    info: Info,
    columns: String,
    libid_from_file: bool,
}

// LightLib lists one zero-based column per line. Comments may contain semicolons.
fn numbered_columns(structure: &str) -> io::Result<Option<String>> {
    let mut lines = structure
        .lines()
        .map(|line| {
            line.split_once("//")
                .map_or(line, |(field, _)| field)
                .trim()
        })
        .filter(|line| !line.is_empty())
        .peekable();
    if !lines
        .peek()
        .and_then(|line| line.split_whitespace().next())
        .is_some_and(|token| token.bytes().all(|b| b.is_ascii_digit()))
    {
        return Ok(None);
    }
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid numbered INPX structure.info",
        )
    };
    let mut fields = Vec::new();
    for line in lines {
        let (index, name) = line.split_once(char::is_whitespace).ok_or_else(invalid)?;
        let index = index.parse::<usize>().map_err(|_| invalid())?;
        let name = name.trim().trim_end_matches(';').trim();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(invalid());
        }
        let field = match name.to_ascii_lowercase().as_str() {
            "rate" => "librate".into(),
            "keyword" => "keywords".into(),
            field => field.to_owned(),
        };
        fields.push((index, field));
    }
    fields.sort_unstable_by_key(|(index, _)| *index);
    if fields.iter().enumerate().any(|(i, (index, _))| i != *index) {
        return Err(invalid());
    }
    Ok(Some(
        fields
            .into_iter()
            .map(|(_, name)| name)
            .collect::<Vec<_>>()
            .join(";"),
    ))
}

pub enum Event<'a> {
    File(&'a str),
    Record(Record),
}

fn is_inp(name: &str) -> bool {
    !name.ends_with(['/', '\\']) && Path::new(name).extension() == Some(OsStr::new("inp"))
}

impl<R: Read + Seek> Archive<R> {
    pub fn open(source: R) -> Result<Self, ZipError> {
        let mut zip = ZipArchive::new(source)?;
        let collection = read_info(&mut zip, "collection.info");
        let mut version = read_info(&mut zip, "version.info");
        if version.is_empty() {
            version = read_info(&mut zip, "version.inf");
        }
        let mut structure = read_info(&mut zip, "structure.info");
        if structure.is_empty() {
            structure = DEFAULT_STRUCTURE.into();
        }

        let numbered = numbered_columns(&structure)?;
        let libid_from_file = numbered
            .as_ref()
            .is_some_and(|s| !s.split(';').any(|field| field == "libid"));
        let columns = numbered.unwrap_or_else(|| structure.to_lowercase());
        let mut rec_struct = record_fields(&columns);
        if libid_from_file {
            rec_struct.push(Field {
                field: "libid".into(),
                kind: 'S',
            });
        }
        Ok(Self {
            zip,
            columns,
            libid_from_file,
            info: Info {
                collection,
                structure,
                version,
                rec_struct,
            },
        })
    }

    pub fn info(&self) -> &Info {
        &self.info
    }

    pub fn columns(&self) -> impl Iterator<Item = &str> {
        self.columns.split(';')
    }

    pub fn into_info(self) -> Info {
        self.info
    }

    pub fn input_files(&self) -> usize {
        (0..self.zip.len())
            .filter(|&index| self.zip.name_for_index(index).is_some_and(is_inp))
            .count()
    }

    /// Visit each decoded record in archive order. The visitor can stop on an I/O error.
    pub fn records(&mut self, mut visit: impl FnMut(Record) -> io::Result<()>) -> io::Result<u64> {
        self.scan(|event| match event {
            Event::File(_) => Ok(()),
            Event::Record(record) => visit(record),
        })
    }

    pub fn scan(&mut self, mut visit: impl FnMut(Event<'_>) -> io::Result<()>) -> io::Result<u64> {
        let columns: Vec<_> = self.columns.split(';').collect();
        let mut row = Vec::new();
        let mut count = 0;

        for index in 0..self.zip.len() {
            let Some(name) = self.zip.name_for_index(index) else {
                continue;
            };
            if !is_inp(name) {
                continue;
            }
            visit(Event::File(name))?;
            let path = Path::new(name);
            let folder = format!(
                "{}.zip",
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
            const MAX_INP_LINE: u64 = 1024 * 1024;
            const MAX_INP_ENTRY: u64 = 512 * 1024 * 1024;
            let entry = self.zip.by_index(index).map_err(io::Error::other)?;
            let mut input = BufReader::with_capacity(64 * 1024, entry);
            let mut entry_bytes = 0u64;
            loop {
                row.clear();
                let read = (&mut input)
                    .take(MAX_INP_LINE + 1)
                    .read_until(b'\n', &mut row)?;
                if read == 0 {
                    break;
                }
                if read as u64 > MAX_INP_LINE {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("INP line exceeds {MAX_INP_LINE} bytes in {folder}"),
                    ));
                }
                entry_bytes = entry_bytes.saturating_add(read as u64);
                if entry_bytes > MAX_INP_ENTRY {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("INP entry exceeds {MAX_INP_ENTRY} bytes: {folder}"),
                    ));
                }
                if row.last() == Some(&b'\n') {
                    row.pop();
                }
                if row.is_empty() {
                    continue;
                }
                if row.last() == Some(&b'\r') {
                    row.pop();
                }
                let mut record = record::parse(&String::from_utf8_lossy(&row), &columns, &folder);
                if self.libid_from_file
                    && let Some(file) = record.get("file")
                {
                    record.insert("libid".into(), file.clone());
                }
                visit(Event::Record(record))?;
                count += 1;
            }
        }
        Ok(count)
    }
}

fn read_info<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> String {
    const MAX_INFO: u64 = 1024 * 1024;
    let Ok(entry) = zip.by_name(name) else {
        return String::new();
    };
    if entry.is_dir() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if entry.take(MAX_INFO + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_INFO {
        return String::new();
    }
    String::from_utf8_lossy(&bytes)
        .trim_matches(js_whitespace)
        .into()
}
