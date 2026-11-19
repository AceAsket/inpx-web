use std::collections::HashSet;

use inpx_reader::js_whitespace;
use serde_json::{Value, json};

use super::{ReaderState, bounded, now, number, shelves::truthy, string};
use crate::{Result, crypto_support, library_sources::js_string};

impl ReaderState {
    pub fn bookmark_request(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let uid = bounded(string(&request["bookUid"]), 512)?;
        if uid.is_empty() {
            return Err("bookUid is empty".into());
        }
        let mut snapshot = self.snapshot(stamp)?;
        let user = snapshot.data["users"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|user| user["id"] == owner)
            .ok_or("need_profile_login")?;
        let updated = now();
        let bookmarks = user["readerBookmarks"][uid]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        let mut normalized = normalize_rows(bookmarks, &updated)?;
        match action {
            "add-reader-bookmark" => {
                let id = loop {
                    let id = crypto_support::hex(&crypto_support::random::<8>()?);
                    if !normalized.iter().any(|row| row["id"] == id) {
                        break id;
                    }
                };
                let mut bookmark = normalize(&request["bookmark"], id, &updated);
                bookmark["createdAt"] = updated.as_str().into();
                normalized.insert(0, bookmark);
            }
            "delete-reader-bookmark" => {
                let id = string(&request["bookmarkId"]).trim_matches(js_whitespace);
                if id.is_empty() {
                    return Err("bookmarkId is empty".into());
                }
                normalized.retain(|row| row["id"] != id);
            }
            _ => return Err("Некорректное действие с закладкой".into()),
        }
        normalized
            .sort_by(|left, right| string(&right["createdAt"]).cmp(string(&left["createdAt"])));
        if !user["readerBookmarks"].is_object() {
            user["readerBookmarks"] = json!({});
        }
        user["readerBookmarks"][uid] = serde_json::to_value(&normalized)?;
        user["updatedAt"] = updated.into();
        self.publish(snapshot, stamp)?;
        Ok(json!({"bookmarks":normalized}))
    }
}

pub(super) fn normalize_rows(rows: &[Value], updated: &str) -> Result<Vec<Value>> {
    let mut ids = HashSet::new();
    let mut normalized = Vec::with_capacity(rows.len());
    for row in rows {
        let mut id = text(&row["id"]).trim_matches(js_whitespace).to_owned();
        if id.is_empty() {
            id = crypto_support::hex(&crypto_support::random::<8>()?);
        }
        if ids.insert(id.clone()) {
            normalized.push(normalize(row, id, updated));
        }
    }
    normalized.sort_by(|left, right| string(&right["createdAt"]).cmp(string(&left["createdAt"])));
    Ok(normalized)
}

fn normalize(row: &Value, id: String, stamp: &str) -> Value {
    let title = words(&row["title"]);
    let created = text(&row["createdAt"]);
    let created = created.trim_matches(js_whitespace);
    let percent = match &row["percent"] {
        Value::Bool(true) => 1.0,
        value => number(value).clamp(0.0, 1.0),
    };
    json!({
        "id":id,
        "sectionId":text(&row["sectionId"]).trim_matches(js_whitespace),
        "title":if title.is_empty() { "Закладка" } else { &title },
        "excerpt":words(&row["excerpt"]),
        "note":words(&row["note"]),
        "percent":percent,
        "createdAt":if created.is_empty() { stamp } else { created },
    })
}

pub(super) fn words(value: &Value) -> String {
    text(value)
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn text(value: &Value) -> String {
    if truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}
