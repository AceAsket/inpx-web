use std::collections::HashMap;

use serde_json::{Value, json};

use super::{ReaderState, number, string};
use crate::Result;
use crate::standalone_catalogue::Catalogue;

impl ReaderState {
    pub fn reading_library(
        &self,
        owner: &str,
        stamp: &str,
        options: &Value,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let user = snapshot.data["users"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|user| user["id"] == owner)
            .ok_or("need_profile_login")?;
        reading_library(&snapshot.data, user, options, catalogue)
    }
}

pub(super) fn reading_library(
    data: &Value,
    user: &Value,
    options: &Value,
    catalogue: &Catalogue,
) -> Result<Value> {
    let state = match string(&options["state"]).trim() {
        state @ ("all" | "read" | "hidden") => state,
        _ => "reading",
    };
    let query = string(&options["query"]).trim().to_lowercase();
    let sort = string(&options["sort"]).trim();
    let sort = if sort.is_empty() { "updatedDesc" } else { sort };
    let limit = match number(&options["limit"]) {
        0.0 => 200,
        value => value.clamp(1.0, 500.0).trunc() as usize,
    };
    let mut counts = HashMap::from([("all", 0), ("reading", 0), ("read", 0), ("hidden", 0)]);
    let mut selected = Vec::new();
    for (uid, progress) in user["readerProgress"].as_object().into_iter().flatten() {
        if uid.trim().is_empty() || !string(&progress["relinkedTo"]).is_empty() {
            continue;
        }
        let percent = number(&progress["percent"]).clamp(0.0, 1.0);
        let hidden = progress["hidden"] == true;
        let status = if hidden {
            "hidden"
        } else if percent >= 0.999 {
            "read"
        } else {
            "reading"
        };
        *counts.get_mut("all").expect("all counter") += 1;
        *counts.get_mut(status).expect("status counter") += 1;
        if state == "all" || state == status {
            selected.push((uid.trim(), progress, status, percent));
        }
    }
    let mut items = Vec::new();
    for chunk in selected.chunks(500) {
        let mut books: HashMap<_, _> = catalogue
            .browser_books_by_uid(chunk.iter().map(|row| row.0))?
            .into_iter()
            .map(|row| (string(&row["_uid"]).to_owned(), row))
            .collect();
        for &(uid, progress, status, percent) in chunk {
            let book = books.remove(uid);
            let unavailable = book.is_none();
            let mut metadata = book.unwrap_or(Value::Null);
            if let Some(override_) = data["metadataOverrides"][uid]
                .as_object()
                .filter(|_| !unavailable)
            {
                for field in ["title", "author", "series", "serno"] {
                    if let Some(value) = override_.get(field) {
                        metadata[field] = value.clone();
                    }
                }
            }
            let title = match string(&metadata["title"]) {
                "" if unavailable => "Книга недоступна",
                "" => "Без названия",
                title => title,
            };
            let author = string(&metadata["author"]);
            let series = string(&metadata["series"]);
            if !query.is_empty()
                && !format!("{title} {author} {series}")
                    .to_lowercase()
                    .contains(&query)
            {
                continue;
            }
            let snip: String = string(&progress["textSnippet"])
                .trim()
                .chars()
                .take(240)
                .collect();
            let serno = match &metadata["serno"] {
                Value::Null => json!(""),
                value if value == 0 => json!(""),
                value => value.clone(),
            };
            items.push(json!({"bookUid":uid,"title":title,"author":author,"series":series,"serno":serno,
                    "ext":string(&metadata["ext"]),"librate":number(&metadata["librate"]),"del":number(&metadata["del"]),
                    "genre":string(&metadata["genre"]),"publishedYear":year(&metadata["publishedYear"]).or_else(|| year(&metadata["year"])).unwrap_or_default(),
                    "unavailable":unavailable,"percent":percent,"hidden":status=="hidden","state":status,
                    "revision":number(&progress["revision"]),"sectionId":string(&progress["sectionId"]).trim(),
                    "textSnippet":snip,"updatedAt":string(&progress["updatedAt"]).trim()}));
        }
    }
    items.sort_by(|left, right| {
        let newest = || string(&right["updatedAt"]).cmp(string(&left["updatedAt"]));
        let name = |key: &str| sort_key(&left[key]).cmp(&sort_key(&right[key]));
        match sort {
            "updatedAsc" => newest().reverse(),
            "titleAsc" => name("title"),
            "authorAsc" => name("author").then_with(|| name("title")),
            "progressAsc" => number(&left["percent"])
                .total_cmp(&number(&right["percent"]))
                .then_with(newest),
            "progressDesc" => number(&right["percent"])
                .total_cmp(&number(&left["percent"]))
                .then_with(newest),
            _ => newest(),
        }
    });
    let count = items.len();
    items.truncate(limit);
    Ok(json!({"state":state,"query":query,"sort":sort,
            "progressGeneration":number(&user["readerProgressGeneration"]).max(0.0) as u64,
            "counters":counts,"count":count,"items":items}))
}

fn sort_key(value: &Value) -> String {
    string(value).to_lowercase().replace('ё', "е")
}

fn year(value: &Value) -> Option<String> {
    let source = value.as_number().map(ToString::to_string);
    let text = source.as_deref().unwrap_or_else(|| string(value)).trim();
    let first = text.get(..4)?;
    if !first.starts_with('0')
        && first.bytes().all(|b| b.is_ascii_digit())
        && text[4..]
            .chars()
            .next()
            .is_none_or(|ch| matches!(ch, '-' | '/' | '.') || ch.is_whitespace())
    {
        Some(first.into())
    } else {
        None
    }
}
