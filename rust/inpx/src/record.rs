use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

pub type Record = Map<String, Value>;

pub(crate) const DEFAULT_STRUCTURE: &str =
    "AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS";

const NUMERIC_FIELDS: [&str; 5] = ["serno", "size", "del", "insno", "librate"];

pub(crate) fn field_type(name: &str) -> Option<char> {
    match name {
        "author" | "genre" | "title" | "series" | "file" | "libid" | "ext" | "date" | "folder"
        | "lang" | "keywords" => Some('S'),
        name if NUMERIC_FIELDS.contains(&name) => Some('N'),
        _ => None,
    }
}

// Use the same whitespace rules as String.trim() and parseInt() in the Node importer.
pub fn js_whitespace(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn parse_number(text: &str) -> Value {
    let text = text.trim_start_matches(js_whitespace);
    let sign = usize::from(text.starts_with(['+', '-']));
    let digits = text.as_bytes()[sign..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return 0.into();
    }
    let parsed = &text[..sign + digits];
    if let Ok(integer) = parsed.parse::<i64>()
        && integer.unsigned_abs() < (1 << 53)
    {
        return integer.into();
    }
    // Values beyond the integer precision of JS are rounded as doubles.
    let number = parsed.parse::<f64>().unwrap_or(0.0);
    Number::from_f64(number).map_or(Value::Null, Value::Number)
}

pub(crate) fn parse(line: &str, columns: &[&str], default_folder: &str) -> Record {
    // Reserve the folder, numeric defaults and source fields added by the importer as well.
    let mut record = Record::with_capacity(columns.len() + 8);
    record.insert("_uid".into(), STANDARD.encode(Sha256::digest(line)).into());
    for (name, value) in columns.iter().copied().zip(line.split('\x04')) {
        // This setter does not create an own property on the JS record.
        if !name.is_empty() && name != "__proto__" {
            record.insert(name.into(), value.into());
        }
    }

    if let Some(Value::String(author)) = record.get_mut("author")
        && !author.is_empty()
    {
        *author = author
            .split(':')
            .map(|part| {
                part.replace(',', " ")
                    .trim_matches(js_whitespace)
                    .to_owned()
            })
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(",");
    }
    if let Some(Value::String(genre)) = record.get_mut("genre")
        && !genre.is_empty()
    {
        *genre = genre
            .split(':')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(",");
    }
    if record
        .get("folder")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty()
    {
        record.insert("folder".into(), default_folder.into());
    }
    for field in NUMERIC_FIELDS {
        let number = record
            .get(field)
            .and_then(Value::as_str)
            .map_or(0.into(), parse_number);
        record.insert(field.into(), number);
    }
    record
}
