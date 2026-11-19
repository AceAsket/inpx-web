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
        let version = read_info(&mut zip, "version.info");
        let mut structure = read_info(&mut zip, "structure.info");
        if structure.is_empty() {
            structure = DEFAULT_STRUCTURE.into();
        }

        let rec_struct = record_fields(&structure);
        Ok(Self {
            zip,
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
        let lower = self.info.structure.to_lowercase();
        let columns: Vec<_> = lower.split(';').collect();
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
            let entry = self.zip.by_index(index).map_err(io::Error::other)?;
            let mut input = BufReader::with_capacity(64 * 1024, entry);
            loop {
                row.clear();
                if input.read_until(b'\n', &mut row)? == 0 {
                    break;
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
                visit(Event::Record(record::parse(
                    &String::from_utf8_lossy(&row),
                    &columns,
                    &folder,
                )))?;
                count += 1;
            }
        }
        Ok(count)
    }
}

fn read_info<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> String {
    let Ok(mut entry) = zip.by_name(name) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    if entry.is_dir() || entry.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes)
        .trim_matches(js_whitespace)
        .into()
}
