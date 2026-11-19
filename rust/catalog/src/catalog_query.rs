use std::borrow::Cow;
use std::cmp::Ordering;

use inpx_reader::{Record, js_whitespace};
use serde::Deserialize;
use serde_json::Value;

use crate::catalog_text::{field, lower, normalize_key, number, words};

#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Copies {
    #[default]
    Physical,
    Merge,
    Ranked,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Filter {
    Date {
        from: String,
        to: String,
    },
    Genre {
        values: Vec<String>,
    },
    TextValues {
        field: String,
        values: Vec<String>,
        #[serde(default, rename = "emptyAlias")]
        empty_alias: bool,
    },
    NumberValues {
        field: String,
        values: Vec<f64>,
    },
    NumberRange {
        field: String,
        from: f64,
        to: f64,
    },
    Empty {
        field: String,
    },
    Contains {
        field: String,
        value: String,
        special: bool,
    },
    Terms {
        field: String,
        terms: Vec<[String; 2]>,
    },
}

fn text_order(left: &str, right: &str) -> Ordering {
    if left.is_ascii() && right.is_ascii() {
        left.cmp(right)
    } else {
        left.encode_utf16().cmp(right.encode_utf16())
    }
}

fn date_matches(date: Option<&str>, from: &str, to: &str) -> bool {
    date.is_some_and(|date| {
        (from.is_empty() || text_order(date, from) != Ordering::Less)
            && (to.is_empty() || text_order(date, to) != Ordering::Greater)
    })
}

fn text_values_match(text: &str, values: &[String], empty_alias: bool) -> bool {
    let text = lower(text);
    values
        .iter()
        .any(|value| value == text.as_ref() || empty_alias && value == "?" && text.is_empty())
}

#[derive(Deserialize)]
pub(crate) struct BookScope<'a> {
    #[serde(borrow)]
    pub date: Option<Cow<'a, str>>,
    #[serde(borrow)]
    pub lang: Option<Cow<'a, str>>,
    #[serde(borrow)]
    pub ext: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "sourceId")]
    pub source: Option<Cow<'a, str>>,
}

impl Filter {
    pub fn scope_only(&self) -> bool {
        matches!(self, Self::Date { .. })
            || matches!(self,Self::TextValues{field,..} if matches!(field.as_str(),"lang"|"ext"))
    }

    pub fn matches_scope(&self, row: &BookScope<'_>) -> bool {
        match self {
            Self::Date { from, to } => date_matches(row.date.as_deref(), from, to),
            Self::TextValues {
                field,
                values,
                empty_alias,
            } => {
                let text = if field == "lang" { &row.lang } else { &row.ext };
                text_values_match(text.as_deref().unwrap_or_default(), values, *empty_alias)
            }
            _ => unreachable!("scope-only query"),
        }
    }

    pub fn matches(&self, row: &Record) -> bool {
        match self {
            Self::Date { from, to } => {
                date_matches(row.get("date").and_then(Value::as_str), from, to)
            }
            Self::Genre { values } => lower(field(row, "genre")).split(',').any(|part| {
                let trimmed = part.trim_matches(js_whitespace);
                values
                    .iter()
                    .any(|value| value == trimmed || (part.is_empty() && value == "?"))
            }),
            Self::TextValues {
                field: key,
                values,
                empty_alias,
            } => text_values_match(field(row, key), values, *empty_alias),
            Self::NumberValues { field, values } => row
                .get(field)
                .and_then(Value::as_f64)
                .is_some_and(|value| values.contains(&value)),
            Self::NumberRange { field, from, to } => row
                .get(field)
                .and_then(Value::as_f64)
                .is_some_and(|value| value >= *from && value <= *to),
            Self::Empty { field: key } => row
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| text.is_empty() || text.starts_with('?')),
            Self::Contains {
                field: key,
                value,
                special,
            } => {
                let Some(text) = row.get(key).and_then(Value::as_str) else {
                    return false;
                };
                let text = lower(text);
                if *special {
                    text.is_empty()
                        || text.chars().next().is_some_and(|ch| {
                            !ch.is_ascii_lowercase() && !matches!(ch, 'а'..='я' | 'ё')
                        }) && text.contains(value)
                } else {
                    !text.is_empty() && text.contains(value)
                }
            }
            Self::Terms { field: key, terms } => {
                if terms.is_empty() {
                    return false;
                }
                let mut matched = vec![false; terms.len()];
                words(field(row, key), |word, root| {
                    for ([want, stem], matched) in terms.iter().zip(&mut matched) {
                        *matched |= word.starts_with(want) || root.starts_with(stem);
                    }
                });
                matched.into_iter().all(|matched| matched)
            }
        }
    }
}

fn title_copy_key(title: &str, author: &str) -> Option<String> {
    let title = normalize_key(title);
    if title.is_empty() {
        return None;
    }
    let author = normalize_key(author);
    let mut key = String::with_capacity(author.len() + title.len() + "copy-title:".len());
    key.push_str("copy");
    let mut separator = ':';
    for name in author.split([';', ',', '\n']) {
        let mut parts = name.split(js_whitespace).filter(|part| !part.is_empty());
        if let Some(first) = parts.next() {
            key.push(separator);
            key.push_str(first);
            if let Some(last) = parts.next() {
                key.push(' ');
                key.push_str(last);
            }
            separator = '|';
        }
    }
    if separator == ':' {
        key.push_str("-title");
    }
    key.push(separator);
    key.push_str(&title);
    Some(key)
}

pub(crate) fn merged_key(row: &Record) -> String {
    if let Some(key) = title_copy_key(field(row, "title"), field(row, "author")) {
        return key;
    }
    let libid = field(row, "libid");
    let file = field(row, "file");
    let folder = field(row, "folder");
    let ext = field(row, "ext");
    if !libid.is_empty() && file.is_empty() && folder.is_empty() {
        format!("libid::{}:{libid}:{ext}", field(row, "sourcelib"))
    } else {
        let parts = ["", folder, file, ext, &number(row, "insno").to_string()].map(normalize_key);
        format!("file:{}", parts.join("|"))
    }
}

pub(crate) fn merged_key_from_record(record: &[u8]) -> crate::Result<String> {
    #[derive(Deserialize)]
    struct Names<'a> {
        #[serde(default, borrow)]
        title: Cow<'a, str>,
        #[serde(default, borrow)]
        author: Cow<'a, str>,
    }

    if let Ok(names) = serde_json::from_slice::<Names>(record)
        && let Some(key) = title_copy_key(&names.title, &names.author)
    {
        return Ok(key);
    }
    Ok(merged_key(&serde_json::from_slice(record)?))
}
