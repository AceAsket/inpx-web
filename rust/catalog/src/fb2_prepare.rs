use std::borrow::Cow;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::ops::Range;
use std::path::Path;

use encoding_rs::{
    Encoding, IBM866, ISO_8859_5, KOI8_R, KOI8_U, UTF_16BE, UTF_16LE, WINDOWS_1250, WINDOWS_1251,
    WINDOWS_1252, WINDOWS_1254, X_MAC_CYRILLIC,
};
use memchr::{memchr, memchr_iter};
use serde::Serialize;

use crate::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Prepared {
    has_binary: bool,
}

pub(crate) fn normalize(source: &Path) -> Result<Option<Prepared>> {
    normalize_bytes(source, &fs::read(source)?)
}

pub(crate) fn normalize_bytes(source: &Path, input: &[u8]) -> Result<Option<Prepared>> {
    let mut bytes = Cow::Borrowed(input);
    let compressed = bytes.starts_with(b"\x1f\x8b");
    if compressed {
        let mut plain = Vec::new();
        crate::gzip::inflate(bytes.as_ref(), &mut plain, u64::MAX)?;
        bytes = Cow::Owned(plain);
    }
    let Some(text) = decode(&bytes) else {
        return Ok(None);
    };
    let clean = text.trim_start_matches(js_space);
    let encoding = xml_declaration(clean)
        .and_then(encoding_attribute)
        .map(|(range, _)| range);
    let replacement = encoding.filter(|range| &clean[range.clone()] != "encoding=\"utf-8\"");
    let has_binary = memchr_iter(b'<', clean.as_bytes())
        .any(|start| tag_name(&clean.as_bytes()[start + 1..], b"binary"));
    if compressed
        || matches!(text, Cow::Owned(_))
        || clean.len() != text.len()
        || replacement.is_some()
    {
        // restoreBook owns this private file and removes it if writing fails.
        let mut output = BufWriter::with_capacity(128 * 1024, File::create(source)?);
        if let Some(range) = replacement {
            output.write_all(&clean.as_bytes()[..range.start])?;
            output.write_all(b"encoding=\"utf-8\"")?;
            output.write_all(&clean.as_bytes()[range.end..])?;
        } else {
            output.write_all(clean.as_bytes())?;
        }
        output.flush()?;
    }
    Ok(Some(Prepared { has_binary }))
}

pub(crate) fn decode(bytes: &[u8]) -> Option<Cow<'_, str>> {
    let encoding = match bytes {
        [0xff, 0xfe, ..] | [b'<', 0, _, 0, ..] => UTF_16LE,
        [0xfe, 0xff, ..] | [0, b'<', 0, ..] => UTF_16BE,
        bytes => {
            if let Ok(text) = std::str::from_utf8(bytes) {
                return Some(Cow::Borrowed(text));
            }
            // Charset guesses and uncommon declarations retain the existing decoder.
            let head = &bytes[..bytes.len().min(1024)];
            let head = head.trim_ascii_start();
            let end = head.windows(2).position(|pair| pair == b"?>")? + 2;
            let declaration = xml_declaration(std::str::from_utf8(&head[..end]).ok()?)?;
            let (_, value) = encoding_attribute(declaration)?;
            declared_encoding(value, bytes)?
        }
    };
    encoding.decode_without_bom_handling_and_without_replacement(bytes)
}

fn declared_encoding(name: &str, bytes: &[u8]) -> Option<&'static Encoding> {
    let key: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    // iconv-lite and encoding_rs treat undefined Windows code-page bytes differently.
    let is_defined = |undefined: &[u8]| undefined.iter().all(|byte| memchr(*byte, bytes).is_none());
    Some(match key.as_str() {
        "windows1250" | "cp1250" | "win1250" | "1250"
            if is_defined(&[0x81, 0x83, 0x88, 0x90, 0x98]) =>
        {
            WINDOWS_1250
        }
        "windows1251" | "cp1251" | "win1251" | "1251" if is_defined(&[0x98]) => WINDOWS_1251,
        "windows1252" | "cp1252" | "win1252" | "1252"
            if is_defined(&[0x81, 0x8d, 0x8f, 0x90, 0x9d]) =>
        {
            WINDOWS_1252
        }
        "windows1254" | "cp1254" | "win1254" | "1254"
            if is_defined(&[0x81, 0x8d, 0x8e, 0x8f, 0x90, 0x9d, 0x9e]) =>
        {
            WINDOWS_1254
        }
        "cp866" | "ibm866" | "866" => IBM866,
        "koi8r" => KOI8_R,
        "koi8u" => KOI8_U,
        "iso88595" => ISO_8859_5,
        "maccyrillic" | "xmaccyrillic" => X_MAC_CYRILLIC,
        _ => return None,
    })
}

pub(crate) fn js_space(ch: char) -> bool {
    ch.is_whitespace() && ch != '\u{85}' || ch == '\u{feff}'
}

fn ascii_word(byte: &u8) -> bool {
    byte.is_ascii_alphanumeric() || *byte == b'_'
}

fn tag_name(bytes: &[u8], name: &[u8]) -> bool {
    bytes
        .get(..name.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(name))
        && !bytes.get(name.len()).is_some_and(ascii_word)
}

fn xml_declaration(text: &str) -> Option<&str> {
    let bytes = text.as_bytes().strip_prefix(b"<?")?;
    if !tag_name(bytes, b"xml") {
        return None;
    }
    let boundary = memchr(b'?', bytes)? + 2;
    (text.as_bytes().get(boundary + 1) == Some(&b'>')).then(|| &text[..boundary + 2])
}

fn encoding_attribute(declaration: &str) -> Option<(Range<usize>, &str)> {
    let bytes = declaration.as_bytes();
    for (start, prefix) in bytes.windows(8).enumerate() {
        if !prefix.eq_ignore_ascii_case(b"encoding") || start > 0 && ascii_word(&bytes[start - 1]) {
            continue;
        }
        let Some(value) = declaration[start + 8..]
            .trim_start_matches(js_space)
            .strip_prefix('=')
        else {
            continue;
        };
        let value = value.trim_start_matches(js_space);
        let Some(&quote @ (b'\'' | b'"')) = value.as_bytes().first() else {
            continue;
        };
        let Some(end) = value.as_bytes()[1..]
            .iter()
            .position(|byte| matches!(byte, b'\'' | b'"'))
        else {
            continue;
        };
        if end == 0 || value.as_bytes()[end + 1] != quote {
            continue;
        }
        let stop = declaration.len() - value.len() + end + 2;
        return Some((start..stop, &value[1..end + 1]));
    }
    None
}
