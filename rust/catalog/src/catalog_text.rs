use std::borrow::Cow;

use inpx_reader::{Record, js_whitespace};
use serde::Serialize;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfkc_quick};

pub(crate) fn field<'a>(row: &'a Record, key: &str) -> &'a str {
    row.get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

pub(crate) fn number(row: &Record, key: &str) -> i64 {
    row.get(key)
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default()
}

pub(crate) fn supported_text(value: &str) -> bool {
    value.is_ascii()
        || value.chars().all(|c| {
            c.is_ascii()
                || ('\u{0400}'..='\u{045f}').contains(&c)
                || get_general_category(c) != GeneralCategory::Unassigned
        })
}

pub(crate) fn lower(s: &str) -> Cow<'_, str> {
    if s.chars()
        .any(|c| c.is_uppercase() || c.to_lowercase().next() != Some(c))
    {
        Cow::Owned(s.to_lowercase())
    } else {
        Cow::Borrowed(s)
    }
}

fn word_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    ('а'..='я').contains(&c)
        || matches!(
            get_general_category(c),
            GeneralCategory::UppercaseLetter
                | GeneralCategory::LowercaseLetter
                | GeneralCategory::TitlecaseLetter
                | GeneralCategory::ModifierLetter
                | GeneralCategory::OtherLetter
                | GeneralCategory::DecimalNumber
                | GeneralCategory::LetterNumber
                | GeneralCategory::OtherNumber
        )
}

fn mixed_letters(c: char) -> char {
    match c {
        'a' => 'а',
        'c' => 'с',
        'e' => 'е',
        'o' => 'о',
        'p' => 'р',
        'x' => 'х',
        c => c,
    }
}

pub(crate) fn words(text: &str, mut visit: impl FnMut(&str, &str)) {
    let normalized = if is_nfkc_quick(text.chars()) == IsNormalized::Yes {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.nfkc().collect())
    };
    let lowercase = lower(&normalized);
    for chunk in lowercase.split(js_whitespace) {
        let mut value = if chunk.contains('ё') {
            Cow::Owned(chunk.replace('ё', "е"))
        } else {
            Cow::Borrowed(chunk)
        };
        if value.as_bytes().iter().any(u8::is_ascii_lowercase)
            && value.chars().any(|c| ('а'..='я').contains(&c))
        {
            value = Cow::Owned(value.chars().map(mixed_letters).collect());
        }
        for word in value
            .split(|ch| !word_char(ch))
            .filter(|word| !word.is_empty())
        {
            visit(word, root(word));
        }
    }
}

fn root(word: &str) -> &str {
    if word.len() < 10 || !word.chars().all(|c| ('а'..='я').contains(&c)) {
        return word;
    }
    const ENDINGS: &[&str] = &[
        "иями", "ями", "ами", "ого", "ому", "ыми", "ими", "ах", "ях", "ов", "ев", "ая", "ое", "ую",
        "ые", "ых", "ой", "ей", "ий", "ый", "ам", "ям", "ом", "ем", "а", "я", "ы", "и", "у", "ю",
        "е", "о", "ь",
    ];
    ENDINGS
        .iter()
        .find_map(|suffix| word.strip_suffix(suffix))
        .filter(|root| root.len() >= 8)
        .unwrap_or(word)
}

pub(crate) fn normalize_key(value: &str) -> String {
    lower(value.trim_matches(js_whitespace))
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Serialize)]
pub(crate) struct SearchProjection {
    words: [Vec<String>; 3],
    physical: String,
    score: f64,
}

impl SearchProjection {
    pub fn from_book(row: &Record) -> Self {
        let words = ["author", "series", "title"].map(|key| {
            let mut result = Vec::new();
            words(field(row, key), |word, root| {
                result.extend([word.into(), root.into()]);
            });
            result
        });
        let source = field(row, "sourceId");
        let file = field(row, "file");
        let folder = field(row, "folder");
        let ext = field(row, "ext");
        let libid = field(row, "libid");
        let physical = if !libid.is_empty() && folder.is_empty() && file.is_empty() {
            format!("libid:{source}:{}:{libid}:{ext}", field(row, "sourcelib"))
        } else {
            let parts =
                [source, folder, file, ext, &number(row, "insno").to_string()].map(normalize_key);
            format!("file:{}", parts.join("|"))
        };
        let score = if number(row, "del") == 0 { 1000.0 } else { 0.0 }
            + number(row, "librate") as f64 * 100.0
            + if ext == "fb2" { 20.0 } else { 0.0 }
            + number(row, "size").min(100_000_000) as f64 / 1_000_000.0;
        Self {
            words,
            physical,
            score,
        }
    }
}
