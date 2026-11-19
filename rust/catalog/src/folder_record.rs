use std::fs::File;
use std::io::BufReader;
use std::path::{Component, Path};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{
    Value,
    value::{RawValue, to_raw_value},
};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::book_archive::Failure;
use crate::book_metadata::{FB2_PREFIX, read_epub};
use crate::fb2_prepare::js_space;
use crate::folder_inventory::{Entry, book_name};
use crate::{Result, folder_fb2};

pub(crate) struct BookPath<'a> {
    pub(crate) extension: &'static str,
    folder: &'a str,
    stem: &'a str,
}

impl<'a> BookPath<'a> {
    pub(crate) fn new(relative: &'a str) -> Result<Self> {
        let (folder, name) = relative.rsplit_once('/').unwrap_or((".", relative));
        if !book_name(name)
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
            || !Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("invalid folder book path".into());
        }
        let suffix = name.rfind('.').expect("known book suffix");
        let extension = if suffix == 0 {
            // Node's extname returns an empty string for a bare dotfile.
            ""
        } else if name[suffix..].eq_ignore_ascii_case(".epub") {
            "epub"
        } else {
            "fb2"
        };
        Ok(Self {
            extension,
            folder,
            stem: &name[..name.len() - extension.len() - 1],
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct Metadata {
    title: Option<String>,
    author: String,
    genre: Option<String>,
    series: Option<String>,
    serno: Option<f64>,
    lang: Option<String>,
    keywords: Option<String>,
}

fn text(value: &Value, field: &str) -> Option<String> {
    value[field].as_str().map(str::to_owned)
}

fn joined(value: &Value, field: &str) -> Option<String> {
    value[field].as_array().map(|values| {
        values
            .iter()
            .map(|value| value.as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(",")
    })
}

fn series_number(value: &str) -> std::result::Result<f64, Failure> {
    let value = value.trim_matches(js_space);
    if let Some((radix, digits)) = [(16, "0x", "0X"), (8, "0o", "0O"), (2, "0b", "0B")]
        .into_iter()
        .find_map(|(radix, lower, upper)| {
            value
                .strip_prefix(lower)
                .or_else(|| value.strip_prefix(upper))
                .map(|digits| (radix, digits))
        })
    {
        if digits
            .bytes()
            .all(|digit| char::from(digit).is_digit(radix))
            && !digits.is_empty()
        {
            let digits = digits.trim_start_matches('0');
            return u128::from_str_radix(if digits.is_empty() { "0" } else { digits }, radix)
                .map(|n| n as f64)
                .map_err(|_| Failure::Unsupported);
        }
        return Ok(0.0);
    }
    Ok(match value {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'.' | b'+' | b'-' | b'e' | b'E')) =>
        {
            value.parse().unwrap_or(0.0)
        }
        _ => 0.0,
    })
}

pub(crate) fn read(
    root: &Path,
    file: &Entry,
    path: &BookPath<'_>,
) -> std::result::Result<Metadata, Failure> {
    let file = File::open(root.join(&file.relative))?;
    if !file.metadata()?.is_file() {
        return Err(Failure::InvalidType);
    }
    if path.extension == "epub" {
        let value = read_epub(BufReader::with_capacity(128 * 1024, file), false)?;
        return Ok(Metadata {
            title: text(&value, "title"),
            author: joined(&value, "authors").unwrap_or_default(),
            lang: text(&value, "language"),
            keywords: joined(&value, "tags"),
            ..Metadata::default()
        });
    }
    let value = folder_fb2::read(file, FB2_PREFIX)?;
    Ok(Metadata {
        title: text(&value, "title"),
        author: text(&value, "author").unwrap_or_default(),
        genre: text(&value, "genre"),
        series: text(&value, "series"),
        serno: Some(series_number(value["seriesNumber"].as_str().unwrap_or(""))?),
        lang: text(&value, "lang"),
        keywords: text(&value, "keywords"),
    })
}

// Declaration order matches the existing catalogue record before its hash is computed.
#[derive(Serialize)]
struct Record<'a> {
    author: &'a str,
    title: &'a str,
    genre: &'a str,
    series: &'a str,
    serno: f64,
    lang: &'a str,
    keywords: &'a str,
    librate: u8,
    del: u8,
    insno: u8,
    folder: &'a str,
    file: &'a str,
    ext: &'a str,
    size: u64,
    libid: &'static str,
    date: String,
    #[serde(rename = "_uid")]
    uid: String,
}

pub(crate) fn encode(
    root: &str,
    source: &str,
    file: &Entry,
    path: &BookPath<'_>,
    metadata: &Metadata,
) -> Result<Box<RawValue>> {
    if !file.modified.is_finite() || file.modified.abs() > 8_640_000_000_000_000.0 {
        return Err("invalid folder timestamp".into());
    }
    let date =
        OffsetDateTime::from_unix_timestamp_nanos(file.modified.trunc() as i128 * 1_000_000)?
            .date();
    let year = date.year();
    let month = date.month() as u8;
    let day = date.day();
    let mut iso_date = if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:+07}-{month:02}-{day:02}")
    };
    iso_date.truncate(10);
    let title = metadata
        .title
        .as_deref()
        .unwrap_or("")
        .trim_matches(js_space);
    let uid = STANDARD.encode(Sha256::digest(format!(
        "folder:{source}:{root}:{}",
        file.relative
    )));
    Ok(to_raw_value(&Record {
        author: &metadata.author,
        title: if title.is_empty() { path.stem } else { title },
        genre: metadata.genre.as_deref().unwrap_or(""),
        series: metadata.series.as_deref().unwrap_or(""),
        serno: metadata.serno.unwrap_or(0.0),
        lang: metadata.lang.as_deref().unwrap_or(""),
        keywords: metadata.keywords.as_deref().unwrap_or(""),
        librate: 0,
        del: 0,
        insno: 0,
        folder: path.folder,
        file: path.stem,
        ext: path.extension,
        size: file.size,
        libid: "",
        date: iso_date,
        uid,
    })?)
}
