use std::fmt::Write;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::{Result, book_delivery::Book, crypto_support, fb2_prepare::js_space};

const CYRILLIC: &str = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяєіїґў";
const LATIN: [&str; 38] = [
    "a", "b", "v", "g", "d", "e", "yo", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r",
    "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya", "ye", "i",
    "yi", "g", "u",
];

pub(crate) fn filename(book: &Book, template: &str, ext: &str) -> Result<String> {
    let suffix = format!(".{ext}");
    let template = template.trim_matches(js_space);
    if !template.is_empty() {
        let value = render(book, template, ext)?;
        let stem = if value
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase())
        {
            &value[..value.len() - suffix.len()]
        } else {
            &value
        };
        let mut clean: String = stem
            .nfc()
            .map(|ch| {
                if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        let sanitized = clean
            .trim_start_matches('.')
            .trim_end_matches(['.', ' '])
            .trim_matches(js_space);
        let mut end = sanitized.len().min(200);
        while !sanitized.is_char_boundary(end) {
            end -= 1;
        }
        clean = sanitized[..end].trim_end_matches(['.', ' ']).to_owned();
        if reserved(&clean) {
            clean.insert(0, '_');
        }
        if !clean.is_empty() {
            return Ok(clean + &suffix);
        }
    }
    let mut authors = book.author.split(',');
    let mut parts = authors
        .next()
        .unwrap_or_default()
        .split(' ')
        .filter(|part| !part.trim_matches(js_space).is_empty());
    let mut author = parts.next().unwrap_or_default().to_owned();
    for (index, part) in parts.enumerate() {
        if let Some(letter) = part.chars().next() {
            if index == 0 {
                author.push(' ');
            }
            author.push(letter);
            author.push('.');
        }
    }
    if authors.next().is_some() {
        author.push_str(" и др.");
    }
    let title = if book.title.is_empty() {
        String::new()
    } else {
        format!("_{}", book.title)
    };
    let mut name = [format!("{author}{title}"), author, title, book.file.clone()]
        .into_iter()
        .map(|name| {
            name.replace(['\0', '\\', '/', ':', '*', '"', '<', '>', '|'], "_")
                .trim_matches(js_space)
                .trim_end_matches(['.', '_'])
                .to_owned()
        })
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| "book".into());
    if name.encode_utf16().count() > 50 {
        let mut remaining = 50;
        name = name
            .chars()
            .take_while(|ch| {
                if ch.len_utf16() > remaining {
                    return false;
                }
                remaining -= ch.len_utf16();
                true
            })
            .collect();
        name.push('_');
    }
    if !name.ends_with(&suffix) {
        name.push_str(&suffix);
    }
    Ok(name)
}

fn render(book: &Book, template: &str, ext: &str) -> Result<String> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    static CONDITIONAL: OnceLock<Regex> = OnceLock::new();
    let token = TOKEN.get_or_init(|| Regex::new(r"\$\{([A-Z_]+)\}").unwrap());
    let conditional = CONDITIONAL.get_or_init(|| Regex::new(r"\[([^\[\]]*)\]").unwrap());
    let number = book
        .serno
        .filter(|number| *number > 0.0 && number.is_finite())
        .map(|value| value.to_string())
        .unwrap_or_default();
    let padded = if !number.is_empty()
        && number
            .split('.')
            .next()
            .is_some_and(|first| first.len() == 1)
    {
        format!("0{number}")
    } else {
        number.clone()
    };
    let field = |key: &str| match key {
        "TITLE" => Some(book.title.as_str()),
        "AUTHOR" => Some(book.author.as_str()),
        "SERIES" => Some(book.series.as_str()),
        "NUMBER" => Some(number.as_str()),
        "NUMBER_PADDED" => Some(padded.as_str()),
        "EXT" => Some(ext),
        _ => None,
    };
    for capture in token.captures_iter(template) {
        if field(&capture[1]).is_none() {
            return Err(format!("Неизвестное поле шаблона книги: {}", &capture[0]).into());
        }
    }
    let selected = conditional.replace_all(template, |capture: &Captures<'_>| {
        let mut keys = token.captures_iter(&capture[1]).peekable();
        if keys.peek().is_none() {
            return capture[0].to_owned();
        }
        if keys.any(|key| field(&key[1]).unwrap_or_default().is_empty()) {
            return String::new();
        }
        capture[1].to_owned()
    });
    let expanded = token.replace_all(&selected, |capture: &Captures<'_>| {
        field(&capture[1]).unwrap_or_default().to_owned()
    });
    let printable: String = expanded
        .chars()
        .map(|ch| if ch.is_ascii_control() { ' ' } else { ch })
        .collect();
    Ok(printable
        .split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" "))
}

fn reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            lower
                .strip_prefix(prefix)
                .is_some_and(|value| matches!(value.as_bytes(), [b'1'..=b'9']))
        })
}

pub(crate) fn ascii_name(value: &str) -> String {
    let name = value.rsplit(['/', '\\']).next().unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    let extension = if lower.ends_with(".kepub.epub") {
        ".kepub.epub"
    } else {
        lower
            .rfind('.')
            .filter(|&index| index > 0)
            .map_or("", |index| &lower[index..])
    };
    let extension = if extension.strip_prefix('.').is_some_and(|ext| {
        !ext.is_empty()
            && ext.split('.').all(|part| {
                (1..=12).contains(&part.len())
                    && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
    }) {
        extension
    } else {
        ""
    };
    let mut transliterated = String::new();
    for ch in name[..name.len() - extension.len()].chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        if let Some(index) = CYRILLIC.chars().position(|letter| letter == lower) {
            let latin = LATIN[index];
            if let Some((first, tail)) = latin.split_at_checked(1) {
                if ch == lower {
                    transliterated.push_str(latin);
                } else {
                    transliterated.push_str(&first.to_ascii_uppercase());
                    transliterated.push_str(tail);
                }
            }
        } else {
            match ch {
                'ß' => transliterated.push_str("ss"),
                'ẞ' => transliterated.push_str("SS"),
                _ => transliterated.push(ch),
            }
        }
    }
    let normalized: String = transliterated
        .nfkd()
        .filter(|ch| {
            !matches!(
                get_general_category(*ch),
                GeneralCategory::NonspacingMark
                    | GeneralCategory::SpacingMark
                    | GeneralCategory::EnclosingMark
            )
        })
        .map(|ch| {
            if ch == '.' {
                '_'
            } else if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else {
                ' '
            }
        })
        .collect();
    let mut stem = normalized
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '_', '-'])
        .to_owned();
    let hash = || crypto_support::hex(&Sha256::digest(name.as_bytes())[..6]);
    if stem.is_empty() {
        stem = format!("book-{}", hash());
    }
    if stem.len() > 180 {
        stem = format!("{}-{}", stem[..167].trim_end(), hash());
    }
    if reserved(&stem) {
        stem = format!("book-{stem}");
    }
    stem + extension
}

pub(crate) fn disposition(name: &str, ascii_only: bool) -> String {
    let mut value = format!("attachment; filename=\"{}\"", ascii_name(name));
    if !ascii_only {
        value.push_str("; filename*=UTF-8''");
        for byte in name.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~') {
                value.push(char::from(byte));
            } else {
                write!(value, "%{byte:02X}").expect("writing to String");
            }
        }
    }
    value
}
