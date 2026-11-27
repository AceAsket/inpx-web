use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use icu_collator::Collator;
use inpx_reader::Record;
use serde_json::{Map, Value, json};

use super::Search;
use crate::Result;
use crate::catalog_entity::normalize_entity_text;
use crate::catalog_text::{field, words};
use crate::lookup::{Sample, SuggestionSamples, Table};
use crate::standalone_catalogue::Catalogue;

const KINDS: [(&str, Table); 3] = [
    ("author", Table::Author),
    ("series", Table::Series),
    ("title", Table::Title),
];
const PREVIEW_FIELDS: &[&str] = &[
    "id",
    "_uid",
    "_recordHash",
    "title",
    "author",
    "series",
    "serno",
    "folder",
    "file",
    "ext",
    "size",
    "inpxSize",
    "date",
    "genre",
    "lang",
    "del",
    "librate",
    "libid",
    "insno",
    "sourcelib",
    "sourceId",
    "sourceName",
    "sourceLibDir",
    "sourceType",
    "unavailable",
];

impl Catalogue {
    pub fn browser_suggest(&self, options: &Value) -> Result<Value> {
        self.check_lease()?;
        let original = options
            .get("query")
            .filter(|value| !value.is_null())
            .unwrap_or(&Value::Null);
        let original = if original.is_null() {
            ""
        } else {
            original
                .as_str()
                .ok_or("Слишком длинный поисковый запрос")?
        };
        if original.chars().count() > 120 {
            return Err("Слишком длинный поисковый запрос".into());
        }
        let query = normalize_entity_text(original);
        let requested = options.get("kind").filter(|value| !value.is_null());
        let requested = requested
            .map_or(Some(""), Value::as_str)
            .ok_or("Укажите title, author или series для подсказок")?;
        if !requested.is_empty() && !KINDS.iter().any(|(kind, _)| *kind == requested) {
            return Err("Укажите title, author или series для подсказок".into());
        }
        let mut filters = Map::from_iter([("del".into(), "0".into())]);
        for key in ["lang", "ext", "sourceId", "genre"] {
            if let Some(raw) = options["filters"].get(key) {
                let value = raw
                    .as_str()
                    .filter(|value| {
                        value.encode_utf16().count() <= 500
                            && !value.starts_with(['~', '*', '#', '='])
                    })
                    .ok_or("Некорректный фильтр каталога")?;
                if !value.is_empty() {
                    filters.insert(key.into(), raw.clone());
                }
            }
        }
        let terms = tokenize(&query);
        if query.chars().count() < 3
            || terms.is_empty()
            || query.starts_with(['=', '~', '*', '#', '?'])
        {
            return Ok(json!({"query":query,"groups":[],"corrections":[]}));
        }
        let scoped = filters.len() > 1;
        let filters = Search::new(&filters, "")?;
        let collation =
            Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        let fields: Vec<_> = KINDS
            .into_iter()
            .filter(|(kind, _)| requested.is_empty() || *kind == requested)
            .collect();
        let mut groups = Vec::new();
        let mut limited = false;
        for &(kind, table) in &fields {
            let (folded, keys) = suggest_keys(&query);
            let mut samples =
                self.lookup
                    .browser_samples(&self.lookup_generation, table, &keys, true, 32)?;
            samples
                .rows
                .retain(|row| row.name != "?" && matches_words(&row.name, &terms));
            let mut books = HashMap::new();
            if scoped || samples.rows.iter().filter(|row| row.count > 0).count() < 6 {
                let root = terms
                    .iter()
                    .max_by_key(|(_, root)| root.chars().count())
                    .map(|(_, root)| root.as_str())
                    .unwrap_or_default();
                let word_samples = self.suggest_words(kind, root)?;
                limited |=
                    word_samples.limited || word_samples.rows.iter().any(|row| !row.complete);
                self.add_sample_books(&word_samples.rows, &mut books)?;
                let mut names = Vec::new();
                let mut seen = HashSet::new();
                for &id in word_samples.rows.iter().flat_map(|row| &row.book_ids) {
                    let Some(book) = books.get(&id) else { continue };
                    let name = field(book, kind);
                    for name in name
                        .split(if kind == "author" { ',' } else { '\0' })
                        .chain(std::iter::once(name))
                    {
                        let name = name.trim();
                        if !name.is_empty()
                            && matches_words(name, &terms)
                            && seen.insert(name.to_lowercase())
                        {
                            names.push(name.to_lowercase());
                        }
                    }
                }
                limited |= names.len() > 32;
                names.truncate(32);
                if !names.is_empty() {
                    let extra = self.lookup.browser_samples(
                        &self.lookup_generation,
                        table,
                        &names,
                        false,
                        32,
                    )?;
                    let seen: HashSet<_> = samples.rows.iter().map(|row| row.id).collect();
                    samples
                        .rows
                        .extend(extra.rows.into_iter().filter(|row| !seen.contains(&row.id)));
                    limited |= extra.limited;
                }
            }
            limited |= samples.limited;
            samples.rows.retain(|row| row.count > 0);
            let wanted = folded.as_str();
            samples.rows.sort_by(|a, b| {
                relevance(&b.name, wanted, &terms)
                    .cmp(&relevance(&a.name, wanted, &terms))
                    .then_with(|| b.count.cmp(&a.count))
                    .then_with(|| collation.compare(&a.name, &b.name))
            });
            if scoped || kind == "title" {
                limited |= self.add_sample_books(&samples.rows, &mut books)?;
            }
            let mut items = Vec::new();
            for row in samples.rows {
                let matching: Vec<_> = row
                    .book_ids
                    .iter()
                    .filter_map(|id| books.get(id))
                    .filter(|book| filters.matches(book))
                    .collect();
                if (scoped || kind == "title") && matching.is_empty() {
                    limited |= !row.complete;
                    continue;
                }
                let complete = row.complete && row.book_ids.iter().all(|id| books.contains_key(id));
                let count = if scoped {
                    complete.then_some(matching.len())
                } else {
                    Some(row.count as usize)
                };
                let mut item = json!({"name":row.name,"count":count});
                if scoped && !complete {
                    limited = true;
                    item["limited"] = true.into();
                }
                if kind == "title" {
                    let book = matching[0];
                    item["book"] = Value::Object(
                        PREVIEW_FIELDS
                            .iter()
                            .filter_map(|&key| {
                                book.get(key).map(|value| (key.to_owned(), value.clone()))
                            })
                            .collect(),
                    );
                }
                items.push(item);
                if items.len() == 6 {
                    break;
                }
            }
            groups.push(json!({"kind":kind,"items":items}));
        }
        let corrections = if groups.iter().any(|group| {
            group["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }) {
            Vec::new()
        } else {
            self.suggest_corrections(&fields, &terms, &filters)?
        };
        let mut reply = json!({"query":query,"groups":groups,"corrections":corrections});
        if limited {
            reply["limited"] = true.into();
        }
        Ok(reply)
    }

    fn suggest_words(&self, kind: &str, root: &str) -> Result<SuggestionSamples> {
        self.lookup.browser_samples(
            &self.lookup_generation,
            Table::Word,
            &[format!("{kind}:{root}")],
            true,
            16,
        )
    }

    fn add_sample_books(&self, rows: &[Sample], books: &mut HashMap<u32, Record>) -> Result<bool> {
        let mut seen = HashSet::new();
        let mut ids: Vec<_> = rows
            .iter()
            .flat_map(|row| row.book_ids.iter().copied())
            .filter(|id| !books.contains_key(id) && seen.insert(*id))
            .collect();
        let truncated = ids.len() > 128;
        ids.truncate(128);
        for book in self.store.catalogue_rows(&self.generation, ids)? {
            if let Some(id) = book.get("id").and_then(Value::as_u64) {
                books.insert(id as u32, book);
            }
        }
        Ok(truncated)
    }

    fn suggest_corrections(
        &self,
        fields: &[(&str, Table)],
        terms: &[Term],
        filters: &Search,
    ) -> Result<Vec<Value>> {
        let started = Instant::now();
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        if terms.len() > 6 {
            return Ok(found);
        }
        for &(field_name, _) in fields {
            for (position, (word, root)) in terms.iter().enumerate() {
                if !(4..=40).contains(&word.chars().count()) {
                    continue;
                }
                if started.elapsed() >= Duration::from_millis(240) {
                    return Ok(found);
                }
                let prefix: String = root.chars().take(2).collect();
                let sample = self.suggest_words(field_name, &prefix)?;
                let rows: Vec<_> = sample
                    .rows
                    .into_iter()
                    .filter(|row| {
                        row.name
                            .split_once(':')
                            .is_some_and(|(_, candidate)| one_edit(candidate, root))
                    })
                    .collect();
                let mut books = HashMap::new();
                self.add_sample_books(&rows, &mut books)?;
                for row in rows {
                    let Some(book) = row
                        .book_ids
                        .iter()
                        .filter_map(|id| books.get(id))
                        .find(|book| filters.matches(book))
                    else {
                        continue;
                    };
                    let Some((_, correction)) = row.name.split_once(':') else {
                        continue;
                    };
                    let name = field(book, field_name);
                    let tokens = tokenize(name);
                    let Some((word, _)) = tokens.iter().find(|(_, root)| root == correction) else {
                        continue;
                    };
                    let mut corrected = terms.to_vec();
                    corrected[position] = (word.clone(), correction.into());
                    let query = corrected
                        .iter()
                        .map(|(word, _)| word.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    if matches_words(name, &corrected) && seen.insert((field_name, query.clone())) {
                        found.push(json!({"kind":field_name,"query":query}));
                        if found.len() >= 3 {
                            return Ok(found);
                        }
                    }
                }
            }
        }
        Ok(found)
    }
}

type Term = (String, String);

fn tokenize(value: &str) -> Vec<Term> {
    let mut output = Vec::new();
    words(value, |word, root| output.push((word.into(), root.into())));
    output
}

fn matches_words(value: &str, terms: &[Term]) -> bool {
    let available = tokenize(value);
    terms.iter().all(|(word, root)| {
        available
            .iter()
            .any(|(candidate, stem)| candidate.starts_with(word) || stem.starts_with(root))
    })
}

fn relevance(name: &str, query: &str, terms: &[Term]) -> u32 {
    let name = normalize_entity_text(name).to_lowercase().replace('ё', "е");
    if name == query {
        return 1000;
    }
    if name.starts_with(query) {
        return 800;
    }
    let available = tokenize(&name);
    if available.len() >= terms.len()
        && terms
            .iter()
            .zip(&available)
            .all(|((word, _), (candidate, _))| candidate.starts_with(word))
    {
        return 600;
    }
    if name.contains(query) { 400 } else { 200 }
}

fn one_edit(left: &str, right: &str) -> bool {
    let mut a: Vec<_> = left.chars().collect();
    let mut b: Vec<_> = right.chars().collect();
    if a.len() > b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    let at = a
        .iter()
        .zip(&b)
        .position(|(a, b)| a != b)
        .unwrap_or(a.len());
    if a.len() + 1 == b.len() {
        return a[at..] == b[at + 1..];
    }
    if a.len() != b.len() || at == a.len() {
        return false;
    }
    a[at + 1..] == b[at + 1..]
        || (at + 1 < a.len()
            && a[at] == b[at + 1]
            && a[at + 1] == b[at]
            && a[at + 2..] == b[at + 2..])
}

fn suggest_keys(query: &str) -> (String, Vec<String>) {
    let lowered = query.to_lowercase();
    let folded = lowered.replace('ё', "е");
    let mut keys = vec![lowered.clone()];
    if folded != lowered {
        keys.push(folded.clone());
    }
    for (pos, ch) in folded.char_indices() {
        if ch == 'е' && keys.len() < 6 {
            let mut variant = String::with_capacity(folded.len());
            variant.push_str(&folded[..pos]);
            variant.push('ё');
            variant.push_str(&folded[pos + ch.len_utf8()..]);
            if !keys.contains(&variant) {
                keys.push(variant);
            }
        }
    }
    (folded, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_keys_handles_queries_with_and_without_yo_or_ye() {
        let (folded, keys) = suggest_keys("Маршрут 00");
        assert_eq!(folded, "маршрут 00");
        assert_eq!(keys, vec!["маршрут 00"]);
        let terms = tokenize("Маршрут 00");
        assert_eq!(relevance("Маршрут 00", folded.as_str(), &terms), 1000);

        let (folded, keys) = suggest_keys("Ёлка");
        assert_eq!(folded, "елка");
        assert_eq!(keys, vec!["ёлка", "елка"]);
        let terms = tokenize("Ёлка");
        assert_eq!(relevance("Елка", folded.as_str(), &terms), 1000);
        assert_eq!(relevance("Ёлка", folded.as_str(), &terms), 1000);

        let (folded, keys) = suggest_keys("Лес");
        assert_eq!(folded, "лес");
        assert_eq!(keys, vec!["лес", "лёс"]);
        let terms = tokenize("Лес");
        assert_eq!(relevance("Лес", folded.as_str(), &terms), 1000);
        assert_eq!(relevance("Лёс", folded.as_str(), &terms), 1000);

        let (folded, keys) = suggest_keys("перепереперепере");
        assert_eq!(folded, "перепереперепере");
        assert!(keys.len() <= 6);
        assert_eq!(keys[0], "перепереперепере");
    }
}
