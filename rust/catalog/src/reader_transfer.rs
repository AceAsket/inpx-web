use std::collections::{HashMap, HashSet};

use icu_collator::Collator;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::bookmarks::{normalize_rows, words};
use super::preferences::{self, clip, integer, text};
use super::shelves::{
    entries, items, normalize_filters, opds, owned, pin_ids, shelf_name, truthy, visibility,
};
use super::{ReaderState, assign, bounded, discovery, follows, now, number, numeric, string};
use crate::{Result, crypto_support};

impl ReaderState {
    pub fn audio_position(
        &self,
        owner: &str,
        stamp: &str,
        uid: &str,
        variant: &str,
        patch: Option<&Value>,
    ) -> Result<Value> {
        let uid = uid.trim();
        if uid.is_empty()
            || uid.encode_utf16().count() > 447
            || variant.is_empty()
            || variant.encode_utf16().count() > 12000
        {
            return Err("Некорректный идентификатор аудио".into());
        }
        let key = format!(
            "{uid}:{}",
            crypto_support::hex(&Sha256::digest(variant.as_bytes()))
        );
        let mut snapshot = self.snapshot(stamp)?;
        let mut positions = normalize_audio(&user(&snapshot.data, owner)?["audioProgress"]);
        let mut current = positions
            .get(&key)
            .cloned()
            .unwrap_or_else(|| json!({"revision":0}));
        if let Some(patch) = patch {
            let rev = revision(&current["revision"]);
            let base = patch.get("baseRevision").and_then(|value| {
                if value.is_null() {
                    Some(0.0)
                } else {
                    numeric(value)
                }
            });
            if base != Some(rev as f64) {
                current["conflict"] = true.into();
            } else {
                let mut next = audio_row(patch);
                next["revision"] = rev.saturating_add(1).into();
                next["updatedAt"] = now().into();
                if positions.len() >= 2000
                    && !positions.contains_key(&key)
                    && let Some(oldest) = positions
                        .iter()
                        .min_by(|a, b| string(&a.1["updatedAt"]).cmp(string(&b.1["updatedAt"])))
                        .map(|(key, _)| key.clone())
                {
                    positions.remove(&oldest);
                }
                positions.insert(key, next.clone());
                user_mut(&mut snapshot.data, owner)?["audioProgress"] = positions.into();
                self.publish(snapshot, stamp)?;
                current = next;
            }
        }
        Ok(json!({"progress":current}))
    }

    pub fn delete_progress(&self, owner: &str, stamp: &str, uid: Option<&str>) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let user = user_mut(&mut snapshot.data, owner)?;
        let time = now();
        let result = if let Some(uid) = uid {
            let uid = bounded(uid, 512)?;
            if uid.is_empty() {
                return Err("bookUid is empty".into());
            }
            if let Some(progress) = user["readerProgress"].as_object_mut() {
                progress.remove(uid);
            }
            json!({"success":true})
        } else {
            let book_uids: Vec<_> = user["readerProgress"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(uid, _)| uid.clone())
                .collect();
            let generation = revision(&user["readerProgressGeneration"]).saturating_add(1);
            user["readerProgress"] = json!({});
            user["readerProgressGeneration"] = generation.into();
            user["readerProgressResetAt"] = time.as_str().into();
            json!({"success":true,"count":book_uids.len(),"bookUids":book_uids,"resetAt":time,"generation":generation})
        };
        user["updatedAt"] = time.into();
        self.publish(snapshot, stamp)?;
        Ok(result)
    }

    pub fn relink_progress(
        &self,
        owner: &str,
        stamp: &str,
        source: &str,
        target: &str,
        base: &Value,
    ) -> Result<Value> {
        let source = bounded(source, 512)?;
        let target = bounded(target, 512)?;
        if source.is_empty() || target.is_empty() || source == target {
            return Err("Выберите другую книгу".into());
        }
        let mut snapshot = self.snapshot(stamp)?;
        let user = user_mut(&mut snapshot.data, owner)?;
        let old = &user["readerProgress"][source];
        let rev = revision(&old["revision"]);
        if !old.is_object() || truthy(&old["relinkedTo"]) || numeric(base) != Some(rev as f64) {
            return Err("Прогресс изменился. Обновите список и повторите выбор книги".into());
        }
        if !user["readerProgress"][target].is_null()
            || !items(&user["readerBookmarks"][target]).is_empty()
        {
            return Err("У выбранной книги уже есть прогресс или закладки. Перенос отменён".into());
        }
        let updated = now();
        let mut progress = old.clone();
        progress["sectionId"] = "".into();
        progress["pageIndex"] = 0.into();
        progress["textOffset"] = (-1).into();
        progress["hidden"] = false.into();
        progress["updatedAt"] = updated.as_str().into();
        progress["revision"] = 1.into();
        progress["generation"] = revision(&user["readerProgressGeneration"]).into();
        let mut original = old.clone();
        original["hidden"] = true.into();
        original["relinkedTo"] = target.into();
        original["updatedAt"] = updated.as_str().into();
        original["revision"] = rev.saturating_add(1).into();
        let mut bookmarks = normalize_rows(items(&user["readerBookmarks"][source]), &updated)?;
        for bookmark in &mut bookmarks {
            bookmark["sectionId"] = "".into();
        }
        assign(user, source, original, &updated);
        assign(user, target, progress.clone(), &updated);
        object(user, "readerBookmarks").insert(target.into(), json!(bookmarks));
        self.publish(snapshot, stamp)?;
        Ok(json!({"bookUid":target,"progress":progress}))
    }

    pub fn export_reading_lists(&self, owner: &str, stamp: &str) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let data = &snapshot.data;
        let user = user(data, owner)?;
        let collator =
            Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        let mut shelves: Vec<_> = items(&data["lists"])
            .iter()
            .filter(|list| owned(list, owner))
            .collect();
        shelves.sort_by(|a, b| collator.compare(string(&a["name"]), string(&b["name"])));
        let names: HashMap<_, _> = shelves
            .iter()
            .map(|line| (string(&line["id"]), string(&line["name"])))
            .collect();
        let lists: Vec<_> = shelves.into_iter().map(|shelf| {
            Ok(json!({"name":shelf["name"],"visibility":visibility(&shelf["visibility"]),
                "createdAt":shelf["createdAt"],"updatedAt":shelf["updatedAt"],
                "books":entries(shelf),"filters":normalize_filters(&shelf["filters"])?,"opds":opds(&shelf["opds"])}))
        }).collect::<Result<_>>()?;
        let pinned: Vec<_> = pin_ids(data, owner, items(&user["overviewShelfIds"]))
            .into_iter()
            .filter_map(|id| names.get(id))
            .collect();
        let mut preferences = preferences::normalize(&user["readerPreferences"]);
        self.inline_preferences(owner, &mut preferences)?;
        let updated = now();
        let bookmarks = all_bookmarks(&user["readerBookmarks"], &updated)?;
        let default_format = format(&user["defaultDownloadFormat"]);
        let channel = |key| user.get(key).map_or(default_format, format);
        Ok(json!({"version":4,"exportedAt":updated,"user":{
            "id":owner,"name":user["name"],"emailTo":text(&user["emailTo"]).trim(),
            "telegramChatId":text(&user["telegramChatId"]).trim(),
            "defaultDownloadFormat":default_format,"defaultEmailFormat":channel("defaultEmailFormat"),
            "defaultTelegramFormat":channel("defaultTelegramFormat"),"defaultOpdsFormat":format(&user["defaultOpdsFormat"]),
            "emailAsZip":user["emailAsZip"]==true,"telegramAsZip":user["telegramAsZip"]==true,
            "opdsEnabled":user["opdsEnabled"]!=false,"opdsAuthEnabled":user["opdsAuthEnabled"]==true,
            "personalRecommendationsEnabled":user["personalRecommendationsEnabled"]!=false,
            "readerPreferences":preferences,"readerProgress":normalize_progress(&user["readerProgress"]),
            "readerBookmarks":bookmarks,"audioProgress":normalize_audio(&user["audioProgress"]),
            "discoveryPreferences":discovery::preferences(&user["discoveryPreferences"]),
            "libraryFollows":follows::normalize_follows(&user["libraryFollows"]),"overviewShelfNames":pinned,
        },"lists":lists}))
    }

    pub fn import_reading_lists(
        &self,
        owner: &str,
        stamp: &str,
        data: &Value,
        root: &str,
        limit: usize,
    ) -> Result<Value> {
        if serde_json::to_vec(data)?.len() > limit {
            return Err("Превышен размер файла импорта".into());
        }
        let lists = data["lists"]
            .as_array()
            .ok_or("Некорректный файл импорта списков")?;
        if lists.len() > 1000 {
            return Err("В импорте больше 1000 списков".into());
        }
        if lists
            .iter()
            .map(|row| items(&row["books"]).len())
            .sum::<usize>()
            > 100000
        {
            return Err("В импорте больше 100000 записей книг".into());
        }
        let mut snapshot = self.snapshot(stamp)?;
        let updated = now();
        let incoming = &data["user"];
        let mut summary = ImportCounts::default();
        let imported = import_shelves(&mut snapshot.data, owner, lists, &updated, &mut summary)?;
        let name = incoming.get("name").map(words);
        let name = if let Some(name) = name {
            if name.is_empty() {
                return Err("Имя пользователя не должно быть пустым".into());
            }
            if name.encode_utf16().count() > 80 {
                return Err("Имя пользователя слишком длинное".into());
            }
            let lower = name.to_lowercase();
            (!items(&snapshot.data["users"])
                .iter()
                .any(|row| row["id"] != owner && string(&row["name"]).to_lowercase() == lower))
            .then_some(name)
        } else {
            None
        };
        let pins = incoming["overviewShelfNames"]
            .as_array()
            .map(|names| {
                let user = user(&snapshot.data, owner)?;
                let ids = names
                    .iter()
                    .take(8)
                    .filter_map(|value| {
                        imported
                            .get(&string(value).trim().to_lowercase())
                            .cloned()
                            .map(Value::String)
                    })
                    .chain(items(&user["overviewShelfIds"]).iter().cloned())
                    .collect::<Vec<_>>();
                Ok::<_, Box<dyn std::error::Error>>(json!(pin_ids(&snapshot.data, owner, &ids)))
            })
            .transpose()?;
        let user = user_mut(&mut snapshot.data, owner)?;
        if let Some(name) = name {
            user["name"] = name.into();
        }
        if let Some(pins) = pins {
            user["overviewShelfIds"] = pins;
        }
        import_settings(user, incoming)?;
        import_positions(user, incoming, &updated, &mut summary)?;
        if incoming.get("readerPreferences").is_some() {
            let mut preferences = preferences::normalize(&incoming["readerPreferences"]);
            self.externalize_preferences(owner, root, &mut preferences)?;
            user["readerPreferences"] = preferences;
        }
        user["updatedAt"] = updated.into();
        self.publish(snapshot, stamp)?;
        Ok(
            json!({"importedLists":summary.lists,"importedBooks":summary.books,
            "importedProgress":summary.progress,"importedBookmarks":summary.bookmarks}),
        )
    }
}

#[derive(Default)]
struct ImportCounts {
    lists: usize,
    books: usize,
    progress: usize,
    bookmarks: usize,
}

fn import_shelves(
    data: &mut Value,
    owner: &str,
    lists: &[Value],
    updated: &str,
    summary: &mut ImportCounts,
) -> Result<HashMap<String, String>> {
    if data["lists"].is_null() {
        data["lists"] = json!([]);
    }
    let existing = data["lists"]
        .as_array_mut()
        .ok_or("Некорректный файл профилей")?;
    let mut ids: HashSet<_> = existing
        .iter()
        .map(|row| string(&row["id"]).to_owned())
        .collect();
    let mut by_name = HashMap::new();
    for (index, row) in existing
        .iter()
        .enumerate()
        .filter(|(_, row)| owned(row, owner))
    {
        by_name
            .entry(string(&row["name"]).to_lowercase())
            .or_insert(index);
    }
    let mut imported = HashMap::new();
    for incoming in lists {
        let name = shelf_name(&Value::String(words(&incoming["name"])))?;
        let lower = name.to_lowercase();
        let index = if let Some(&index) = by_name.get(&lower) {
            index
        } else {
            let id = loop {
                let id = crypto_support::hex(&crypto_support::random::<8>()?);
                if ids.insert(id.clone()) {
                    break id;
                }
            };
            let index = existing.len();
            existing.push(json!({"id":id,"userId":owner,"name":name,
                "visibility":visibility(&incoming["visibility"]),"books":[],
                "createdAt":timestamp(&incoming["createdAt"], updated)}));
            by_name.insert(lower.clone(), index);
            summary.lists += 1;
            index
        };
        let shelf = &mut existing[index];
        imported.insert(lower, string(&shelf["id"]).to_owned());
        let mut books = entries(shelf);
        let mut positions: HashMap<_, _> = books
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.book_uid.clone(), index))
            .collect();
        for entry in entries(incoming) {
            if let Some(&index) = positions.get(&entry.book_uid) {
                books[index].read |= entry.read;
            } else {
                positions.insert(entry.book_uid.clone(), books.len());
                books.push(entry);
                summary.books += 1;
            }
        }
        shelf["visibility"] = visibility(if truthy(&shelf["visibility"]) {
            &shelf["visibility"]
        } else {
            &incoming["visibility"]
        })
        .into();
        shelf["books"] = json!(books);
        shelf["filters"] = normalize_filters(&incoming["filters"])?;
        if let Some(value) = incoming.get("opds") {
            shelf["opds"] = opds(value);
        }
        shelf["updatedAt"] = updated.into();
    }
    Ok(imported)
}

fn import_settings(user: &mut Value, incoming: &Value) -> Result<()> {
    for key in ["emailTo", "telegramChatId"] {
        if let Some(value) = incoming.get(key) {
            user[key] = text(value).trim().into();
        }
    }
    for key in [
        "defaultDownloadFormat",
        "defaultEmailFormat",
        "defaultTelegramFormat",
        "defaultOpdsFormat",
    ] {
        if let Some(value) = incoming.get(key) {
            user[key] = format(value).into();
        }
    }
    for key in ["emailAsZip", "telegramAsZip", "opdsAuthEnabled"] {
        if let Some(value) = incoming.get(key) {
            user[key] = (value == true).into();
        }
    }
    for key in ["opdsEnabled", "personalRecommendationsEnabled"] {
        if let Some(value) = incoming.get(key) {
            user[key] = (value != false).into();
        }
    }
    if truthy(&user["isAdmin"]) {
        user["opdsEnabled"] = false.into();
        user["opdsAuthEnabled"] = false.into();
    }
    if user["opdsEnabled"] == false
        || incoming.get("opdsAuthEnabled").is_some() && user["opdsAuthEnabled"] == false
    {
        user.as_object_mut()
            .expect("user")
            .remove("opdsAppPasswordHash");
    }
    if let Some(value) = incoming.get("discoveryPreferences") {
        user["discoveryPreferences"] = discovery::preferences(value);
    }
    if let Some(value) = incoming.get("libraryFollows") {
        user["libraryFollows"] = serde_json::to_value(follows::normalize_follows(value))?;
    }
    Ok(())
}

fn import_positions(
    user: &mut Value,
    incoming: &Value,
    updated: &str,
    summary: &mut ImportCounts,
) -> Result<()> {
    if let Some(value) = incoming.get("audioProgress") {
        let target = object(user, "audioProgress");
        for (key, mut row) in normalize_audio(value) {
            row["revision"] = next_revision(target.get(&key)).into();
            target.insert(key, row);
        }
    }
    if let Some(value) = incoming.get("readerProgress") {
        let generation = revision(&user["readerProgressGeneration"]);
        let target = object(user, "readerProgress");
        for (uid, mut row) in normalize_progress(value) {
            row["revision"] = next_revision(target.get(&uid)).into();
            row["generation"] = generation.into();
            target.insert(uid, row);
            summary.progress += 1;
        }
    }
    if let Some(value) = incoming.get("readerBookmarks") {
        let target = object(user, "readerBookmarks");
        for (uid, incoming) in all_bookmarks(value, updated)? {
            let mut merged = normalize_rows(target.get(&uid).map_or(&[], items), updated)?;
            let mut ids: HashSet<_> = merged
                .iter()
                .map(|row| string(&row["id"]).to_owned())
                .collect();
            for row in incoming {
                if ids.insert(string(&row["id"]).to_owned()) {
                    merged.push(row);
                    summary.bookmarks += 1;
                }
            }
            target.insert(uid, json!(normalize_rows(&merged, updated)?));
        }
    }
    Ok(())
}

fn normalize_progress(value: &Value) -> Map<String, Value> {
    value.as_object().into_iter().flatten().filter_map(|(uid, row)| {
        let uid = uid.trim();
        if uid.is_empty() || !row.is_object() { return None; }
        let mut normalized = json!({
            "percent":number(&row["percent"]).clamp(0.0,1.0),"sectionId":text(&row["sectionId"]).trim(),
            "pageIndex":(number(&row["pageIndex"])+0.5).floor().max(0.0) as u64,
            "textOffset":(numeric(&row["textOffset"]).unwrap_or(-1.0)+0.5).floor().max(-1.0) as i64,
            "textSnippet":clip(text(&row["textSnippet"]).trim(),240),
            "updatedAt":text(&row["updatedAt"]).trim(),"hidden":row["hidden"]==true,
            "generation":revision(&row["generation"]),"revision":revision(&row["revision"]),
        });
        if truthy(&row["relinkedTo"]) { normalized["relinkedTo"] = text(&row["relinkedTo"]).trim().into(); }
        Some((uid.into(),normalized))
    }).collect()
}

fn normalize_audio(value: &Value) -> Map<String, Value> {
    value
        .as_object()
        .into_iter()
        .rev()
        .flat_map(|map| map.iter().rev())
        .take(2000)
        .filter(|(key, row)| key.encode_utf16().count() <= 512 && row.is_object())
        .map(|(key, row)| (key.clone(), audio_row(row)))
        .collect()
}

fn audio_row(row: &Value) -> Value {
    let rate = number(&row["rate"]);
    json!({
        "chapter":number(&row["chapter"]).floor().clamp(0.0,100000.0) as u64,
        "time":number(&row["time"]).clamp(0.0,604800.0),
        "rate":(if rate==0.0 {1.0} else {rate}).clamp(0.5,3.0),
        "revision":revision(&row["revision"]),
        "updatedAt":clip(&text(&row["updatedAt"]),40),
    })
}

fn all_bookmarks(value: &Value, updated: &str) -> Result<HashMap<String, Vec<Value>>> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(uid, rows)| {
            let uid = uid.trim();
            let rows = rows.as_array()?;
            (!uid.is_empty())
                .then(|| normalize_rows(rows, updated).map(|rows| (uid.to_owned(), rows)))
        })
        .collect()
}

fn timestamp(value: &Value, updated: &str) -> String {
    if truthy(value) {
        text(value)
    } else {
        updated.into()
    }
}

fn revision(value: &Value) -> u64 {
    integer(value).max(0) as u64
}

fn next_revision(row: Option<&Value>) -> u64 {
    row.map_or(0, |row| revision(&row["revision"]))
        .saturating_add(1)
}

pub(super) fn format(value: &Value) -> &'static str {
    match text(value).trim().to_lowercase().as_str() {
        "fb2" => "fb2",
        "epub" => "epub",
        "epub3" => "epub3",
        "kepub" => "kepub",
        "kfx" => "kfx",
        "azw8" => "azw8",
        "pdf" => "pdf",
        "mobi" => "mobi",
        _ => "original",
    }
}

fn object<'a>(user: &'a mut Value, field: &str) -> &'a mut Map<String, Value> {
    if !user[field].is_object() {
        user[field] = json!({});
    }
    user[field].as_object_mut().expect("profile field")
}

pub(super) fn user<'a>(data: &'a Value, owner: &str) -> Result<&'a Value> {
    items(&data["users"])
        .iter()
        .find(|row| row["id"] == owner)
        .ok_or_else(|| "need_profile_login".into())
}

pub(super) fn user_mut<'a>(data: &'a mut Value, owner: &str) -> Result<&'a mut Value> {
    data["users"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .find(|row| row["id"] == owner)
        .ok_or_else(|| "need_profile_login".into())
}
