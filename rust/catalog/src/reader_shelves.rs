use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value, json};
use time::{Date, Duration, Month, OffsetDateTime};

use super::{ReaderState, now, number, string};
use crate::catalog_entity::{SeriesVolumes, normalize_entity_text};
use crate::standalone_catalogue::Catalogue;
use crate::{Result, crypto_support};

const MAX_OVERVIEW_SHELVES: usize = 8;
const NOT_FOUND: &str = "Список не найден";
const SMART_MEMBERSHIP: &str = "Состав умной полки определяется фильтрами";
pub(crate) const FILTERS: &[&str] = &[
    "author",
    "title",
    "series",
    "genre",
    "lang",
    "ext",
    "date",
    "librate",
    "ratingCount",
    "keywords",
    "sourceId",
    "isbn",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub(super) book_uid: String,
    pub(super) read: bool,
}

impl ReaderState {
    pub fn ebook_shelves(&self, owner: &str, stamp: &str) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        Ok(
            json!(items(&snapshot.data["lists"]).iter().filter(|row| owned(row, owner))
            .map(|row| json!({"id":row["id"],"name":row["name"],"smart":row["filters"].is_object(),
                "bookCount":entries(row).len()})).collect::<Vec<_>>()),
        )
    }

    pub fn ebook_shelf(
        &self,
        owner: &str,
        stamp: &str,
        id: &str,
        offset: usize,
        limit: usize,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let data = &snapshot.data;
        let row = items(&data["lists"])
            .iter()
            .find(|row| row["id"] == id && owned(row, owner))
            .ok_or(NOT_FOUND)?;
        let mut cursor = offset;
        let mut books = Vec::new();
        let unread = row["filters"]["unreadOnly"] == true;
        let more = if let Some(mut filters) = smart_query(row) {
            let read = if unread {
                read_uids(data, super::transfer::user(data, owner)?, owner)
            } else {
                HashSet::new()
            };
            let mut more = true;
            while more && books.len() < limit && cursor - offset < 200 {
                filters.insert(
                    "limit".into(),
                    (limit - books.len()).min(200 - (cursor - offset)).into(),
                );
                filters.insert("offset".into(), cursor.into());
                let result = catalogue.browser_books(&filters)?;
                let found = items(&result["found"]);
                cursor += found.len();
                books.extend(
                    found
                        .iter()
                        .filter(|book| !read.contains(string(&book["_uid"])))
                        .cloned(),
                );
                more = !found.is_empty()
                    && (cursor as u64) < result["totalFound"].as_u64().unwrap_or_default();
            }
            more
        } else {
            let entries = entries(row);
            let page = entries.iter().skip(offset).take(limit).collect::<Vec<_>>();
            let mut by_uid: HashMap<_, _> = catalogue
                .browser_books_by_uid(page.iter().map(|entry| entry.book_uid.as_str()))?
                .into_iter()
                .map(|book| (string(&book["_uid"]).to_owned(), book))
                .collect();
            for entry in page {
                let mut book = by_uid
                    .remove(&entry.book_uid)
                    .unwrap_or_else(|| json!({"_uid":entry.book_uid,"unavailable":true}));
                book["_shelfRead"] = entry.read.into();
                books.push(book);
            }
            cursor += books.len();
            cursor < entries.len()
        };
        Ok(
            json!({"name":row["name"],"books":books,"next":more.then_some(cursor),"unreadOnly":unread}),
        )
    }

    pub fn ebook_recent(&self, owner: &str, stamp: &str, catalogue: &Catalogue) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let user = super::transfer::user(&snapshot.data, owner)?;
        let mut positions: Vec<_> = user["readerProgress"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, progress)| {
                progress["hidden"] != true
                    && string(&progress["relinkedTo"]).is_empty()
                    && !string(&progress["updatedAt"]).is_empty()
                    && number(&progress["percent"]) < 1.0
            })
            .collect();
        positions.sort_by(|(_, left), (_, right)| {
            string(&right["updatedAt"]).cmp(string(&left["updatedAt"]))
        });
        let mut books = Vec::new();
        for (uid, progress) in positions.into_iter().take(10) {
            let mut book = catalogue
                .browser_book(uid)?
                .unwrap_or_else(|| json!({"_uid":uid,"unavailable":true}));
            book["percent"] = progress["percent"].clone();
            books.push(book);
        }
        Ok(books.into())
    }

    pub fn telegram_shelves(
        &self,
        owner: &str,
        stamp: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let mut lists = items(&snapshot.data["lists"])
            .iter()
            .filter(|row| owned(row, owner))
            .map(|row| json!({"id":row["id"],"name":row["name"]}))
            .collect::<Vec<_>>();
        lists.sort_by_cached_key(|row| string(&row["name"]).to_lowercase().replace('ё', "е"));
        let more = lists.len() > offset.saturating_add(limit);
        Ok(
            json!({"more":more,"rows":lists.into_iter().skip(offset).take(limit).collect::<Vec<_>>()}),
        )
    }

    pub fn telegram_shelf_page(
        &self,
        owner: &str,
        stamp: &str,
        id: &str,
        offset: usize,
        limit: usize,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let data = &snapshot.data;
        let user = super::transfer::user(data, owner)?;
        let row = items(&data["lists"])
            .iter()
            .find(|row| row["id"] == id && owned(row, owner))
            .ok_or(NOT_FOUND)?;
        let (more, books) = if let Some(mut filters) =
            smart_query(row).filter(|filters| filters.get("unreadOnly") != Some(&Value::Bool(true)))
        {
            filters.insert("limit".into(), limit.into());
            filters.insert("offset".into(), offset.into());
            let mut result = catalogue.browser_books(&filters)?;
            (
                result["totalFound"].as_u64().unwrap_or_default()
                    > offset.saturating_add(limit) as u64,
                result["found"].take(),
            )
        } else {
            let selected = computed_entries(row, &read_uids(data, user, owner), catalogue)?;
            let ids = selected
                .iter()
                .skip(offset)
                .take(limit)
                .map(|entry| entry.book_uid.as_str());
            (
                selected.len() > offset.saturating_add(limit),
                json!(catalogue.browser_books_by_uid(ids)?),
            )
        };
        Ok(json!({"name":row["name"],"more":more,"rows":books}))
    }

    pub fn batch_shelf(
        &self,
        owner: &str,
        stamp: &str,
        id: &str,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let data = &snapshot.data;
        let user = super::transfer::user(data, owner)?;
        let row = items(&data["lists"])
            .iter()
            .find(|row| row["id"] == id && owned(row, owner))
            .ok_or(NOT_FOUND)?;
        let entries = computed_entries(row, &read_uids(data, user, owner), catalogue)?;
        if entries.len() > crate::book_batch::MAX_BOOKS {
            return Err("В одном ZIP может быть не больше 200 книг".into());
        }
        Ok(json!(
            entries
                .into_iter()
                .map(|entry| entry.book_uid)
                .collect::<Vec<_>>()
        ))
    }

    pub fn shelf_request(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let data = &mut snapshot.data;
        let index = items(&data["users"])
            .iter()
            .position(|row| row["id"] == owner)
            .ok_or("need_profile_login")?;
        let user = &data["users"][index];
        let list_id = string(&request["listId"]);
        match action {
            "get-reading-lists" => return listing(data, user, owner, request, catalogue),
            "get-reading-list" => return detail(data, user, owner, request, catalogue),
            "get-overview-pinned-shelves" => return overview_pins(data, user, owner, catalogue),
            "set-overview-pinned-shelves" => {
                let requested = request["shelfIds"]
                    .as_array()
                    .filter(|ids| ids.len() <= MAX_OVERVIEW_SHELVES)
                    .ok_or("Можно закрепить до 8 полок в Обзоре")?;
                let pins = pin_ids(data, owner, requested);
                if pins.len() != requested.len() {
                    return Err(
                        "Полки для Обзора должны существовать в вашем профиле и не повторяться"
                            .into(),
                    );
                }
                let reply = json!({"shelfIds":pins,"maxShelves":MAX_OVERVIEW_SHELVES});
                if reply["shelfIds"] != user["overviewShelfIds"] {
                    data["users"][index]["overviewShelfIds"] = reply["shelfIds"].clone();
                    self.publish(snapshot, stamp)?;
                }
                return Ok(reply);
            }
            _ => (),
        }
        let updated = now();
        let reply = match action {
            "create-reading-list" => {
                let name = shelf_name(&request["name"])?;
                check_name(data, owner, &name, "")?;
                let mut id = crypto_support::hex(&crypto_support::random::<8>()?);
                while items(&data["lists"]).iter().any(|list| list["id"] == id) {
                    id = crypto_support::hex(&crypto_support::random::<8>()?);
                }
                let item = json!({"id":id,"userId":owner,"name":name,"visibility":visibility(&request["visibility"]),
                    "books":[],"filters":normalize_filters(&request["filters"])? ,"opds":opds(&Value::Null),
                    "createdAt":updated,"updatedAt":updated});
                let result = json!({"list":stats(&item, owner, &[], "")});
                if data["lists"].is_null() {
                    data["lists"] = json!([]);
                }
                data["lists"]
                    .as_array_mut()
                    .ok_or("Некорректный файл профилей")?
                    .push(item);
                result
            }
            "mark-reader-books-read" => {
                let raw = &request["bookUids"];
                let inputs = raw
                    .as_array()
                    .map_or_else(|| std::slice::from_ref(raw), Vec::as_slice);
                let uids = unique_strings(inputs.iter().map(string));
                ensure_books(catalogue, &uids)?;
                let read = request.get("read").is_none_or(truthy);
                let lists = request["options"]["listIds"]
                    .as_array()
                    .map(|rows| unique_strings(rows.iter().map(string)));
                mark_books(data, index, owner, &uids, read, lists.as_deref(), &updated)?
            }
            "mark-series-read" => {
                let (series, uids) = series_books(catalogue, request)?;
                let mut result = mark_books(
                    data,
                    index,
                    owner,
                    &uids,
                    request.get("read").is_none_or(truthy),
                    None,
                    &updated,
                )?;
                result["series"] = series.into();
                result
            }
            "mark-series-until" => {
                let options = &request["options"];
                let original = string(&options["name"]);
                let uid = string(&options["bookUid"]);
                if original.chars().count() > 500 || uid.chars().count() > 512 {
                    return Err("Слишком длинный поисковый запрос".into());
                }
                let name = normalize_entity_text(original);
                let uid = normalize_entity_text(uid);
                if name.is_empty() || uid.is_empty() {
                    return Err("Выберите том серии".into());
                }
                let volumes = catalogue.browser_series_through(
                    original,
                    &name,
                    &uid,
                    &data["metadataOverrides"],
                )?;
                let uids = match volumes {
                    SeriesVolumes::Found { uids } => uids,
                    SeriesVolumes::InvalidVolume => {
                        return Err("Для этого тома не указан номер в серии".into());
                    }
                    SeriesVolumes::TooMany => {
                        return Err("В серии больше 5000 книг. Выберите меньший диапазон".into());
                    }
                };
                mark_books(data, index, owner, &uids, true, None, &updated)?
            }
            _ => {
                if list_id.is_empty() {
                    return Err("listId is empty".into());
                }
                let position = items(&data["lists"])
                    .iter()
                    .position(|row| row["id"] == list_id && owned(row, owner))
                    .ok_or(NOT_FOUND)?;
                change_list(
                    data,
                    (index, owner),
                    position,
                    action,
                    request,
                    catalogue,
                    &updated,
                )?
            }
        };
        self.publish(snapshot, stamp)?;
        Ok(reply)
    }
}

pub(super) fn listing(
    data: &Value,
    user: &Value,
    owner: &str,
    request: &Value,
    catalogue: &Catalogue,
) -> Result<Value> {
    let uid = string(&request["bookUid"]).trim();
    let requested_visibility = &request["options"]["visibility"];
    let read = read_uids(data, user, owner);
    let mut lists = Vec::new();
    for row in items(&data["lists"]).iter().filter(|row| owned(row, owner)) {
        if truthy(requested_visibility)
            && visibility(requested_visibility) != visibility(&row["visibility"])
        {
            continue;
        }
        let filters = &row["filters"];
        // Keep existing shelves listed while their specialised index is unavailable.
        let books = if !string(&filters["isbn"]).is_empty() && !catalogue.isbn_filter_ready() {
            entries(row)
        } else {
            computed_entries(row, &read, catalogue)?
        };
        lists.push(stats(row, owner, &books, uid));
    }
    lists.sort_by_cached_key(|row| string(&row["name"]).to_lowercase().replace('ё', "е"));
    let pins = pin_ids(data, owner, items(&user["overviewShelfIds"]));
    Ok(json!({"lists":lists,"overviewShelfIds":pins,"maxShelves":MAX_OVERVIEW_SHELVES}))
}

pub(super) fn pin_ids<'a>(data: &Value, owner: &str, ids: &'a [Value]) -> Vec<&'a str> {
    let owned_ids: HashSet<_> = items(&data["lists"])
        .iter()
        .filter(|row| owned(row, owner))
        .map(|row| string(&row["id"]))
        .collect();
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| string(id).trim())
        .filter(|id| !id.is_empty() && owned_ids.contains(id) && seen.insert(*id))
        .take(MAX_OVERVIEW_SHELVES)
        .collect()
}

fn overview_pins(data: &Value, user: &Value, owner: &str, catalogue: &Catalogue) -> Result<Value> {
    const CANDIDATES: usize = 256;
    const PREVIEW: usize = 8;
    let ids = pin_ids(data, owner, items(&user["overviewShelfIds"]));
    let mut shelves = Vec::new();
    let mut read = None;
    for id in &ids {
        let row = items(&data["lists"])
            .iter()
            .find(|row| row["id"] == *id && owned(row, owner))
            .expect("owned pinned shelf");
        let smart = row["filters"].is_object();
        let mut books = if let Some(mut filters) = smart_query(row) {
            let unread = filters.get("unreadOnly").is_some_and(|value| value == true);
            filters.insert(
                "limit".into(),
                (if unread { CANDIDATES } else { PREVIEW }).into(),
            );
            let mut result = catalogue.browser_books(&filters)?;
            let matched = result["found"].take();
            let read = unread.then(|| read.get_or_insert_with(|| read_uids(data, user, owner)));
            matched
                .as_array()
                .into_iter()
                .flatten()
                .filter(|book| {
                    read.as_ref()
                        .is_none_or(|read| !read.contains(string(&book["_uid"])))
                })
                .take(PREVIEW)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            let entries = entries(row);
            let candidates = entries.iter().take(CANDIDATES);
            let mut by_uid: HashMap<_, _> = catalogue
                .browser_books_by_uid(candidates.clone().map(|entry| entry.book_uid.as_str()))?
                .into_iter()
                .filter(|book| number(&book["del"]) == 0.0)
                .map(|book| (string(&book["_uid"]).to_owned(), book))
                .collect();
            candidates
                .filter_map(|entry| by_uid.remove(&entry.book_uid))
                .take(PREVIEW)
                .collect()
        };
        for book in &mut books {
            let uid = string(&book["_uid"]);
            let progress = &user["readerProgress"][uid];
            let overrides = &data["metadataOverrides"][uid];
            book["_readerProgress"] = if progress.is_object() {
                json!({"percent":number(&progress["percent"]),"started":truthy(&progress["updatedAt"])})
            } else {
                Value::Null
            };
            if let Some(overrides) = overrides.as_object() {
                for key in ["title", "author", "series", "serno"] {
                    if let Some(value) = overrides.get(key) {
                        book[key] = value.clone();
                    }
                }
                book["metadataOverridden"] = true.into();
                book["metadataOverrideUpdatedAt"] = string(&overrides["updatedAt"]).into();
            }
        }
        shelves.push(json!({"id":id,"title":row["name"],"smart":smart,"books":books}));
    }
    Ok(json!({"shelfIds":ids,"maxShelves":MAX_OVERVIEW_SHELVES,"shelves":shelves}))
}

fn detail(
    data: &Value,
    user: &Value,
    owner: &str,
    request: &Value,
    catalogue: &Catalogue,
) -> Result<Value> {
    let list_id = string(&request["listId"]).trim();
    if list_id.is_empty() {
        return Err("listId is empty".into());
    }
    let requested_visibility = &request["options"]["visibility"];
    let row = items(&data["lists"])
        .iter()
        .find(|row| {
            row["id"] == list_id
                && owned(row, owner)
                && (!truthy(requested_visibility)
                    || visibility(requested_visibility) == visibility(&row["visibility"]))
        })
        .ok_or(NOT_FOUND)?;
    detail_for(data, user, owner, row, catalogue)
}

pub(super) fn detail_for(
    data: &Value,
    user: &Value,
    owner: &str,
    row: &Value,
    catalogue: &Catalogue,
) -> Result<Value> {
    let entries = computed_entries(row, &read_uids(data, user, owner), catalogue)?;
    let mut books = Vec::new();
    for batch in entries.chunks(500) {
        let flags: HashMap<_, _> = batch
            .iter()
            .map(|entry| (entry.book_uid.as_str(), entry.read))
            .collect();
        for mut book in
            catalogue.browser_books_by_uid(batch.iter().map(|entry| entry.book_uid.as_str()))?
        {
            let uid = string(&book["_uid"]);
            let progress = &user["readerProgress"][uid];
            let read = flags.get(uid).copied().unwrap_or_default();
            book["_readerProgress"] = if progress.is_object() {
                json!({"percent":number(&progress["percent"]),"started":truthy(&progress["updatedAt"])})
            } else {
                Value::Null
            };
            book["_readingListRead"] = read.into();
            books.push(book);
        }
    }
    let mut list = stats(row, owner, &entries, "");
    let details = list.as_object_mut().expect("shelf stats");
    details.remove("containsBook");
    details.remove("readBook");
    Ok(json!({"list":list,"books":books}))
}

fn change_list(
    data: &mut Value,
    (user_index, owner): (usize, &str),
    position: usize,
    action: &str,
    request: &Value,
    catalogue: &Catalogue,
    updated: &str,
) -> Result<Value> {
    let list_id = string(&request["listId"]);
    let uid = string(&request["bookUid"]).trim();
    if action == "delete-reading-list" {
        data["lists"]
            .as_array_mut()
            .ok_or(NOT_FOUND)?
            .remove(position);
        if let Some(ids) = data["users"][user_index]["overviewShelfIds"].as_array_mut() {
            ids.retain(|id| id != list_id);
        }
        return Ok(json!({"success":true}));
    }
    let mut row = data["lists"][position].clone();
    let mut entries = entries(&row);
    let mut extra = Map::new();
    match action {
        "rename-reading-list" => {
            let name = shelf_name(&request["name"])?;
            check_name(data, owner, &name, list_id)?;
            row["name"] = name.into();
        }
        "set-reading-list-visibility" => {
            row["visibility"] = visibility(&request["visibility"]).into();
            if let Some(value) = request.get("opds") {
                row["opds"] = opds(value);
            }
        }
        "update-reading-list-book" => {
            ensure_books(catalogue, &[uid.to_owned()])?;
            if row["filters"].is_object() {
                return Err(SMART_MEMBERSHIP.into());
            }
            let enabled = truthy(&request["enabled"]);
            if enabled {
                if !entries.iter().any(|entry| entry.book_uid == uid) {
                    entries.push(Entry {
                        book_uid: uid.into(),
                        read: false,
                    });
                }
            } else {
                entries.retain(|entry| entry.book_uid != uid);
            }
            extra.extend([
                ("bookUid".into(), uid.into()),
                ("enabled".into(), enabled.into()),
            ]);
        }
        "set-reading-list-book-read" => {
            ensure_books(catalogue, &[uid.to_owned()])?;
            let read = truthy(&request["read"]);
            let uids = [uid.to_owned()];
            if row["filters"].is_object() {
                mark_books(data, user_index, owner, &uids, read, None, updated)?;
                let entries = computed_entries(
                    &data["lists"][position],
                    &read_uids(data, &data["users"][user_index], owner),
                    catalogue,
                )?;
                return Ok(
                    json!({"list":stats(&data["lists"][position], owner, &entries, ""),"bookUid":uid,"read":read}),
                );
            }
            if !entries.iter().any(|entry| entry.book_uid == uid) {
                return Err("Книга не найдена в списке".into());
            }
            set_progress(&mut data["users"][user_index], &uids, read, updated)?;
            for entry in entries.iter_mut().filter(|entry| entry.book_uid == uid) {
                entry.read = read;
            }
            extra.extend([("bookUid".into(), uid.into()), ("read".into(), read.into())]);
        }
        "add-series-to-reading-list" => {
            if row["filters"].is_object() {
                return Err(SMART_MEMBERSHIP.into());
            }
            let (series, uids) = series_books(catalogue, request)?;
            let existing: HashSet<_> = entries
                .iter()
                .map(|entry| entry.book_uid.as_str())
                .collect();
            let added: Vec<_> = uids
                .into_iter()
                .filter(|uid| !existing.contains(uid.as_str()))
                .map(|book_uid| Entry {
                    book_uid,
                    read: false,
                })
                .collect();
            extra.extend([
                ("series".into(), series.into()),
                ("addedBooks".into(), added.len().into()),
            ]);
            entries.extend(added);
        }
        _ => return Err("Некорректное действие полки".into()),
    }
    row["books"] = serde_json::to_value(&entries)?;
    row["updatedAt"] = updated.into();
    extra.insert("list".into(), stats(&row, owner, &entries, ""));
    data["lists"][position] = row;
    Ok(extra.into())
}

fn mark_books(
    data: &mut Value,
    index: usize,
    owner: &str,
    uids: &[String],
    read: bool,
    lists: Option<&[String]>,
    updated: &str,
) -> Result<Value> {
    set_progress(&mut data["users"][index], uids, read, updated)?;
    let requested: HashSet<_> = uids.iter().map(String::as_str).collect();
    let mut changes = Vec::new();
    for row in data["lists"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|row| owned(row, owner))
    {
        if lists.is_some_and(|lists| !lists.iter().any(|id| row["id"] == *id)) {
            continue;
        }
        let mut books = entries(row);
        let mut changed = false;
        for entry in books
            .iter_mut()
            .filter(|entry| requested.contains(entry.book_uid.as_str()) && entry.read != read)
        {
            entry.read = read;
            changed = true;
        }
        if changed {
            row["books"] = serde_json::to_value(&books)?;
            row["updatedAt"] = updated.into();
            changes.push(stats(row, owner, &books, ""));
        }
    }
    Ok(
        json!({"success":true,"read":read,"bookUids":uids,"changedBooks":uids.len(),"updatedLists":changes}),
    )
}

fn set_progress(user: &mut Value, uids: &[String], read: bool, updated: &str) -> Result<()> {
    if uids.is_empty() {
        return Err("bookUids is empty".into());
    }
    let generation = number(&user["readerProgressGeneration"]).max(0.0) as u64;
    if !user["readerProgress"].is_object() {
        user["readerProgress"] = json!({});
    }
    let progress = user["readerProgress"]
        .as_object_mut()
        .expect("reader progress");
    for uid in uids {
        if read {
            let revision = progress
                .get(uid)
                .map_or(0, |row| number(&row["revision"]).max(0.0) as u64)
                .saturating_add(1);
            progress.insert(
                uid.clone(),
                json!({"percent":1,"sectionId":"","updatedAt":updated,
                "hidden":false,"generation":generation,"revision":revision}),
            );
        } else {
            progress.remove(uid);
        }
    }
    user["updatedAt"] = updated.into();
    Ok(())
}

fn read_uids(data: &Value, user: &Value, owner: &str) -> HashSet<String> {
    let progress = user["readerProgress"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, progress)| number(&progress["percent"]) >= 0.999)
        .map(|(uid, _)| uid.clone());
    let lists = items(&data["lists"])
        .iter()
        .filter(|row| owned(row, owner))
        .flat_map(entries)
        .filter(|entry| entry.read)
        .map(|entry| entry.book_uid);
    progress.chain(lists).collect()
}

fn computed_entries(
    row: &Value,
    read: &HashSet<String>,
    catalogue: &Catalogue,
) -> Result<Vec<Entry>> {
    let Some(filters) = smart_query(row) else {
        return Ok(entries(row));
    };
    let unread = filters.get("unreadOnly") == Some(&Value::Bool(true));
    Ok(catalogue
        .browser_shelf_uids(&filters)?
        .into_iter()
        .filter_map(|book_uid| {
            let read = read.contains(&book_uid);
            (!unread || !read).then_some(Entry { book_uid, read })
        })
        .collect())
}

fn smart_query(row: &Value) -> Option<Map<String, Value>> {
    let mut filters = row["filters"].as_object()?.clone();
    filters.insert("del".into(), "0".into());
    if let Some(date) = filters
        .get("date")
        .and_then(Value::as_str)
        .and_then(relative_date)
    {
        filters.insert("date".into(), date.into());
    }
    Some(filters)
}

fn series_books<'a>(catalogue: &Catalogue, request: &'a Value) -> Result<(&'a str, Vec<String>)> {
    let series = string(&request["series"]).trim();
    if series.is_empty() {
        return Err("series is empty".into());
    }
    let books = catalogue.browser_series(series, &Map::new())?;
    Ok((
        series,
        unique_strings(
            items(&books["books"])
                .iter()
                .map(|row| string(&row["_uid"])),
        ),
    ))
}

fn ensure_books(catalogue: &Catalogue, uids: &[String]) -> Result<()> {
    if uids.is_empty() {
        return Err("bookUids is empty".into());
    }
    if uids.iter().any(String::is_empty) {
        return Err("bookUid is empty".into());
    }
    for part in uids.chunks(500) {
        if catalogue
            .browser_books_by_uid(part.iter().map(String::as_str))?
            .len()
            != part.len()
        {
            return Err("404 Файл не найден".into());
        }
    }
    Ok(())
}

fn stats(row: &Value, owner: &str, books: &[Entry], uid: &str) -> Value {
    let entry = books.iter().find(|book| book.book_uid == uid);
    json!({"id":row["id"],"userId":owner,"name":row["name"],"visibility":visibility(&row["visibility"]),
        "createdAt":row["createdAt"],"updatedAt":row["updatedAt"],"bookCount":books.len(),
        "readCount":books.iter().filter(|book| book.read).count(),"containsBook":entry.is_some(),
        "readBook":entry.is_some_and(|entry| entry.read),"filters":row["filters"],"opds":opds(&row["opds"])})
}

pub(super) fn discovery_lists(data: &Value, owner: &str) -> Vec<Value> {
    items(&data["lists"]).iter().filter(|row| owned(row, owner))
        .map(|row| json!({"books":entries(row),"updatedAt":row["updatedAt"],"createdAt":row["createdAt"]}))
        .collect()
}

pub(super) fn entries(row: &Value) -> Vec<Entry> {
    let mut seen = HashSet::new();
    items(&row["books"])
        .iter()
        .filter_map(|row| {
            let uid = row
                .as_str()
                .or_else(|| {
                    ["bookUid", "uid", "id"]
                        .into_iter()
                        .filter_map(|key| row[key].as_str())
                        .find(|value| !value.is_empty())
                })
                .unwrap_or_default()
                .trim();
            (!uid.is_empty() && seen.insert(uid)).then(|| Entry {
                book_uid: uid.into(),
                read: truthy(&row["read"]),
            })
        })
        .collect()
}

pub(super) fn discovery_scores(data: &Value) -> HashMap<String, u64> {
    let mut scores = HashMap::new();
    for user in items(&data["users"]) {
        for (uid, progress) in user["readerProgress"].as_object().into_iter().flatten() {
            let read = number(&progress["percent"]);
            let score = 8
                + u64::from(read >= 0.15) * 8
                + u64::from(read >= 0.5) * 12
                + u64::from(read >= 0.95) * 18;
            *scores.entry(uid.clone()).or_default() += score;
        }
    }
    for list in items(&data["lists"]) {
        for entry in entries(list) {
            *scores.entry(entry.book_uid).or_default() += if entry.read { 14 } else { 6 };
        }
    }
    scores
}

fn check_name(data: &Value, owner: &str, name: &str, excluded: &str) -> Result<()> {
    let name = name.to_lowercase();
    if items(&data["lists"]).iter().any(|row| {
        owned(row, owner) && row["id"] != excluded && string(&row["name"]).to_lowercase() == name
    }) {
        return Err("Список с таким названием уже существует".into());
    }
    Ok(())
}

pub(super) fn shelf_name(value: &Value) -> Result<String> {
    let name = string(value)
        .split(crate::fb2_prepare::js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return Err("Название списка не должно быть пустым".into());
    }
    if name.encode_utf16().count() > 120 {
        return Err("Название списка слишком длинное".into());
    }
    Ok(name)
}

pub(crate) fn normalize_filters(raw: &Value) -> Result<Value> {
    let Some(raw) = raw.as_object() else {
        return Ok(Value::Null);
    };
    let mut filters = Map::new();
    for &field in FILTERS {
        let Some(value) = raw
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        if value.encode_utf16().count() > 100 {
            return Err("Фильтр полки длиннее 100 символов".into());
        }
        if let Some(expr) = value.trim().strip_prefix('~') {
            crate::opds_catalogue::NameQuery::parse(&format!("~{expr}"))?;
        }
        let value = if field == "isbn" {
            crate::isbn::normalize(value).ok_or("Укажите корректный ISBN-10 или ISBN-13")?
        } else {
            value.trim().to_owned()
        };
        if field == "ratingCount" {
            crate::library_media::rating_range(&value)?;
        }
        filters.insert(field.into(), value.into());
    }
    if filters.is_empty() {
        return Err("Задайте хотя бы один фильтр умной полки".into());
    }
    filters.insert(
        "unreadOnly".into(),
        (raw.get("unreadOnly") == Some(&Value::Bool(true))).into(),
    );
    filters.insert(
        "hideCopies".into(),
        raw.get("hideCopies")
            .is_some_and(|value| value == true || value == "true")
            .into(),
    );
    filters.insert("del".into(), "0".into());
    Ok(filters.into())
}

pub(crate) fn relative_date(value: &str) -> Option<String> {
    let date = OffsetDateTime::from_unix_timestamp(crate::access_runtime::now_ms() / 1000)
        .ok()?
        .date();
    let days = match value {
        "today" => 0,
        "3days" => 3,
        "week" => 7,
        "2weeks" => 14,
        _ => -1,
    };
    if days >= 0 {
        return Some((date - Duration::days(days)).to_string());
    }
    let months = match value {
        "month" => 1,
        "2months" => 2,
        "3months" => 3,
        _ => return None,
    };
    let index = date.year() * 12 + i32::from(u8::from(date.month())) - 1 - months;
    let year = index.div_euclid(12);
    let month = Month::try_from((index.rem_euclid(12) + 1) as u8).ok()?;
    let day = date.day().min(month.length(year));
    Some(Date::from_calendar_date(year, month, day).ok()?.to_string())
}

fn unique_strings<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .map(str::trim)
        .filter(|value| !value.is_empty() && seen.insert(*value))
        .map(str::to_owned)
        .collect()
}

pub(super) fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(_) => number(value) != 0.0,
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub(super) fn owned(row: &Value, owner: &str) -> bool {
    row.is_object()
        && (row["userId"] == owner || owner == "default" && string(&row["userId"]).is_empty())
}

pub(super) fn visibility(value: &Value) -> &'static str {
    if value == "opds" { "opds" } else { "private" }
}

pub(super) fn opds(value: &Value) -> Value {
    let group = match string(&value["grouping"]) {
        "authors" => "authors",
        "series" => "series",
        _ => "books",
    };
    json!({"pinned":value["pinned"] == true,"grouping":group})
}
