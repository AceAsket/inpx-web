use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{ReaderState, now, string};
use crate::Result;
use crate::file_stamp::stamp;

impl ReaderState {
    pub fn metadata_overrides(&self, expected: &str) -> Result<Arc<Value>> {
        if let Some((_, cached)) = self
            .metadata
            .borrow()
            .as_ref()
            .filter(|(stamp, _)| stamp == expected)
        {
            return Ok(cached.clone());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields {
            #[serde(default)]
            metadata_overrides: Value,
        }
        let file = File::open(&self.file)?;
        if stamp(&file)?.to_string() != expected {
            return Err("Файл профилей изменился, повторите запрос".into());
        }
        let fields: Fields = serde_json::from_reader(BufReader::new(file))?;
        let overrides = Arc::new(fields.metadata_overrides);
        self.metadata
            .replace(Some((expected.into(), overrides.clone())));
        Ok(overrides)
    }

    pub fn update_book_metadata(
        &self,
        owner: &str,
        expected: &str,
        uid: &str,
        patch: &Value,
    ) -> Result<Value> {
        let uid = uid.trim();
        if uid.is_empty() {
            return Err("Не указан идентификатор книги".into());
        }
        let mut snapshot = self.snapshot(expected)?;
        if !snapshot.data["users"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|user| user["id"] == owner && user["isAdmin"] == true)
        {
            return Err("Требуются права администратора".into());
        }
        let changes = metadata_patch(patch)?;
        if !snapshot.data["metadataOverrides"].is_object() {
            snapshot.data["metadataOverrides"] = json!({});
        }
        let target = &mut snapshot.data["metadataOverrides"][uid];
        let mut fields = target.as_object().cloned().unwrap_or_default();
        fields.extend(changes);
        fields.insert("updatedAt".into(), now().into());
        *target = Value::Object(fields);
        let reply = json!({"bookUid":uid,"override":target});
        self.publish(snapshot, expected)?;
        Ok(reply)
    }
}

fn metadata_patch(patch: &Value) -> Result<Map<String, Value>> {
    let mut changes = Map::new();
    for (field, missing) in [
        ("title", "Название книги не должно быть пустым"),
        ("author", "Автор книги не должен быть пустым"),
        ("series", ""),
    ] {
        if let Some(value) = patch.get(field) {
            let name = if super::shelves::truthy(value) {
                crate::library_sources::js_string(value)
            } else {
                String::new()
            };
            let name = name
                .split(inpx_reader::js_whitespace)
                .filter(|word| !word.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if !missing.is_empty() && name.is_empty() {
                return Err(missing.into());
            }
            changes.insert(field.into(), name.into());
        }
    }
    if let Some(value) = patch.get("serno") {
        let source = crate::library_sources::js_string(value);
        let text = source
            .trim_start()
            .strip_prefix('+')
            .unwrap_or(source.trim_start());
        let end = text
            .find(|ch: char| !ch.is_ascii_digit())
            .unwrap_or(text.len());
        let volume = text[..end].parse::<u64>().ok().filter(|&value| value > 0);
        changes.insert(
            "serno".into(),
            volume.map_or_else(|| "".into(), Value::from),
        );
    }
    if changes.is_empty() {
        return Err("Не указаны данные для сохранения".into());
    }
    Ok(changes)
}

pub fn apply_metadata_override(book: &mut Map<String, Value>, overrides: &Value) {
    let uid = book.get("_uid").map_or("", string).trim();
    if uid.is_empty() {
        return;
    }
    if let Some(fields) = overrides[uid].as_object() {
        for name in ["title", "author", "series", "serno"] {
            if let Some(value) = fields.get(name) {
                book.insert(name.into(), value.clone());
            }
        }
        book.insert("metadataOverridden".into(), true.into());
        book.insert(
            "metadataOverrideUpdatedAt".into(),
            fields.get("updatedAt").map_or("", string).into(),
        );
    }
}

pub fn apply_search_metadata(result: &mut Value, overrides: &Value) {
    for key in ["found", "books"] {
        for row in result
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(row) = row.as_object_mut() {
                apply_metadata_override(row, overrides);
                for book in row
                    .get_mut("books")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_object_mut)
                {
                    apply_metadata_override(book, overrides);
                }
            }
        }
    }
}
