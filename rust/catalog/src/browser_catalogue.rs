use std::collections::{HashMap, HashSet};

use inpx_reader::{Record, js_whitespace};
use serde_json::{Map, Value, json};

use crate::catalog_entity::{
    EntityBook, EntitySelection, SeriesVolume, SeriesVolumes, normalize_entity_text, order_entity,
    series_through,
};
use crate::catalog_query::Filter;
use crate::catalog_text::{field, lower, number, shorter_search_roots, words};
use crate::facets::{Facet, Label};
use crate::lookup::Table;
use crate::lookup_discovery::{BrowseResults, SelectedBooks};
use crate::opds_catalogue::NameQuery;
use crate::reader_state::{CatalogueReading, number as query_number};
use crate::standalone_catalogue::Catalogue;
use crate::{Result, StoreResponse};

#[path = "catalog_suggest.rs"]
mod suggestions;

struct Search {
    filters: Vec<Filter>,
    comparisons: Vec<(String, NameQuery)>,
    source: String,
    start: usize,
    limit: usize,
    hide_copies: bool,
    ratings: Option<(u64, u64)>,
    isbn: Option<String>,
}

impl Search {
    fn new(query: &Map<String, Value>, except: &str) -> Result<Self> {
        let mut filters = Vec::new();
        let mut comparisons = Vec::new();
        let ratings = query
            .get("ratingCount")
            .filter(|value| !value.is_null())
            .map(|value| {
                crate::library_media::rating_range(&crate::library_sources::js_string(value))
            })
            .transpose()?
            .flatten();
        let isbn = query
            .get("isbn")
            .filter(|value| !value.is_null() && *value != "")
            .map(|value| {
                value
                    .as_str()
                    .and_then(crate::isbn::normalize)
                    .ok_or("Укажите корректный ISBN-10 или ISBN-13")
            })
            .transpose()?;
        for (key, value) in query {
            if key == except {
                continue;
            }
            let value = match value {
                Value::String(value) => value.trim().to_owned(),
                Value::Number(number) => number.to_string(),
                _ => continue,
            };
            if value.is_empty() {
                continue;
            }
            let text = value.as_str();
            let expression = text.starts_with(['=', '*', '#', '~']);
            match key.as_str() {
                "sz" | "size" | "serno" | "del" | "insno" | "librate" => {
                    if let Some((from, to)) = text.split_once("..") {
                        let bound = |part: &str| {
                            if part.is_empty() {
                                Ok(0.0)
                            } else {
                                part.parse::<f64>()
                            }
                        };
                        filters.push(Filter::NumberRange {
                            field: key.clone(),
                            from: bound(from)?,
                            to: bound(to)?,
                        });
                    } else {
                        let values: Vec<f64> = text
                            .split(',')
                            .map(|value| value.trim().parse())
                            .collect::<std::result::Result<_, _>>()?;
                        if values.iter().any(|value| !value.is_finite()) {
                            return Err("Некорректный числовой фильтр".into());
                        }
                        filters.push(Filter::NumberValues {
                            field: key.clone(),
                            values,
                        });
                    }
                }
                "genre" if !expression => filters.push(Filter::Genre {
                    values: split_values(text, &[',']),
                }),
                "date" if !expression => {
                    let (from, to) = text.split_once(',').unwrap_or((text, ""));
                    filters.push(Filter::Date {
                        from: from.into(),
                        to: to.into(),
                    });
                }
                "lang" | "ext" if !expression && text.contains([',', '|']) => {
                    filters.push(Filter::TextValues {
                        field: key.clone(),
                        values: split_values(text, &[',', '|']),
                        empty_alias: true,
                    })
                }
                "title" | "author" | "series" | "keywords" if !expression && text != "?" => {
                    let mut terms = Vec::new();
                    words(text, |word, root| terms.push([word.into(), root.into()]));
                    filters.push(Filter::Terms {
                        field: key.clone(),
                        terms,
                    });
                }
                "author" | "series" | "title" | "keywords" | "genre" | "lang" | "ext" | "date"
                | "file" | "libid" | "folder" => {
                    if text == "?" {
                        filters.push(Filter::Empty { field: key.clone() });
                    } else {
                        comparisons.push((key.clone(), NameQuery::parse(text)?));
                    }
                }
                _ => (),
            }
        }
        Ok(Self {
            filters,
            comparisons,
            ratings,
            isbn,
            source: query
                .get("sourceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .into(),
            start: limit_number(query.get("offset")).unwrap_or(0),
            limit: limit_number(query.get("limit"))
                .filter(|&limit| limit > 0)
                .unwrap_or(100)
                .min(1000),
            hide_copies: query
                .get("hideCopies")
                .is_some_and(|value| value == true || value == "true" || value == "1"),
        })
    }

    fn matches(&self, book: &Record) -> bool {
        (self.source.is_empty() || field(book, "sourceId") == self.source)
            && self.filters.iter().all(|filter| filter.matches(book))
            && self
                .comparisons
                .iter()
                .all(|(key, name)| name.matches(&lower(field(book, key))))
    }

    fn constrained(&self) -> bool {
        !self.source.is_empty()
            || !self.filters.is_empty()
            || !self.comparisons.is_empty()
            || self.ratings.is_some()
            || self.isbn.is_some()
    }

    fn active_only(&self) -> bool {
        self.source.is_empty()
            && self.ratings.is_none()
            && self.isbn.is_none()
            && self.comparisons.is_empty()
            && matches!(&self.filters[..], [Filter::NumberValues { field, values }] if field == "del" && values == &[0.0])
    }
}

impl Catalogue {
    pub fn browser_author_name(&self, id: u32) -> Result<Option<String>> {
        self.lookup
            .browser_label(&self.lookup_generation, Table::Author, id)
    }

    fn extra_candidates(&self, search: &Search) -> Result<Option<HashSet<u32>>> {
        let ratings = search
            .ratings
            .map(|range| self.rating_candidates(range))
            .transpose()?;
        let isbn = search
            .isbn
            .as_ref()
            .map(|value| self.isbn_candidates(value))
            .transpose()?;
        Ok(match (ratings, isbn) {
            (Some(ratings), Some(mut isbn)) => {
                isbn.retain(|id| ratings.contains(id));
                Some(isbn)
            }
            (ratings, isbn) => ratings.or(isbn),
        })
    }

    fn search_candidates(&self, search: &Search) -> Result<Option<Vec<u32>>> {
        let mut candidates = self.extra_candidates(search)?;
        if candidates.as_ref().is_some_and(|ids| ids.len() <= 1024) {
            let mut ids: Vec<_> = candidates
                .take()
                .expect("selected candidates")
                .into_iter()
                .collect();
            ids.sort_unstable();
            return Ok(Some(ids));
        }
        let mut narrow = |books: HashSet<u32>| {
            let selected = match &mut candidates {
                Some(selected) => {
                    selected.retain(|id| books.contains(id));
                    selected
                }
                slot @ None => slot.insert(books),
            };
            // Rechecking a short list is cheaper than reading more posting lists.
            selected.len() <= 1024
        };
        'indexed: {
            for (field, query) in &search.comparisons {
                let Ok(table) = name_table(field) else {
                    continue;
                };
                if query.matches("") || query.matches("?") {
                    // Empty values share a marker, and the series index omits it.
                    continue;
                }
                let prefix = match query {
                    NameQuery::Exact(value) | NameQuery::Prefix(value) => {
                        std::slice::from_ref(value)
                    }
                    _ => &[],
                };
                let prefixes: Vec<_> = prefix.iter().map(String::as_str).collect();
                let books = self.lookup.browser_candidates(
                    &self.lookup_generation,
                    table,
                    &prefixes,
                    |label| query.matches(label),
                )?;
                if narrow(books) {
                    break 'indexed;
                }
            }
            for filter in &search.filters {
                let Filter::Terms { field, terms } = filter else {
                    continue;
                };
                if terms.is_empty() {
                    return Ok(Some(Vec::new()));
                }
                if name_table(field).is_err() {
                    continue;
                }
                for [word, stem] in terms {
                    let prefix = format!("{field}:{stem}");
                    let shorter: Vec<_> = shorter_search_roots(word, stem)
                        .map(|root| format!("{field}:{root}"))
                        .collect();
                    let prefixes: Vec<_> = std::iter::once(prefix.as_str())
                        .chain(shorter.iter().map(String::as_str))
                        .collect();
                    let books = self.lookup.browser_candidates(
                        &self.lookup_generation,
                        Table::Word,
                        &prefixes,
                        |label| {
                            label.starts_with(&prefix) || shorter.iter().any(|root| root == label)
                        },
                    )?;
                    if narrow(books) {
                        break 'indexed;
                    }
                }
            }
        }
        Ok(candidates.map(|books| {
            // Preserve the order used to break ranking ties across physical copies.
            let mut ids: Vec<_> = books.into_iter().collect();
            ids.sort_unstable();
            ids
        }))
    }

    pub fn browser_book(&self, uid: &str) -> Result<Option<Value>> {
        Ok(self.browser_books_by_uid([uid])?.pop())
    }

    pub(crate) fn browser_books_by_uid<'a>(
        &self,
        uids: impl IntoIterator<Item = &'a str>,
    ) -> Result<Vec<Value>> {
        let uids: Vec<_> = uids.into_iter().collect();
        let StoreResponse::Rows(rows) = self.store.query(serde_json::from_value(json!({
            "op":"uids","uids":uids,"generation":self.generation,
        }))?)?
        else {
            unreachable!("book UID query returns rows");
        };
        rows.iter()
            .map(|row| serde_json::from_str(row.get()))
            .collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn browser_shelf_uids(&self, query: &Map<String, Value>) -> Result<Vec<String>> {
        let ids = self.filtered_shelf_ids(query)?;
        let mut books = Vec::with_capacity(ids.len());
        for batch in ids.chunks(500) {
            books.extend(
                self.store
                    .catalogue_rows(&self.generation, batch.to_vec())?
                    .into_iter()
                    .filter_map(|mut row| {
                        row.remove("_uid")
                            .and_then(|value| value.as_str().map(str::to_owned))
                    }),
            );
        }
        Ok(books)
    }

    pub(crate) fn filtered_shelf_ids(&self, query: &Map<String, Value>) -> Result<Vec<u32>> {
        let search = Search::new(query, "")?;
        let candidates = self.search_candidates(&search)?;
        self.store.browser_search_order(
            &self.generation,
            candidates.as_deref(),
            |book| search.matches(book),
            search.hide_copies,
        )
    }

    pub fn browser_books(&self, query: &Map<String, Value>) -> Result<Value> {
        let search = Search::new(query, "")?;
        let candidates = self.search_candidates(&search)?;
        let (found, total) = self.store.browser_search(
            &self.generation,
            candidates.as_deref(),
            |book| search.matches(book),
            search.hide_copies,
            search.start,
            search.limit,
        )?;
        Ok(json!({"found":found,"totalFound":total}))
    }

    pub fn browser_browse(&self, options: &Value) -> Result<Value> {
        let kind = options["kind"].as_str().unwrap_or_default();
        let table = match kind {
            "author" => Table::Author,
            "series" => Table::Series,
            _ => return Err("Укажите авторов или серии".into()),
        };
        let prefix = options
            .get("prefix")
            .map_or(Some(""), Value::as_str)
            .filter(|value| {
                value.chars().count() <= 500 && !value.chars().any(|ch| ch.is_ascii_control())
            })
            .ok_or("Некорректный префикс каталога")?;
        let prefix = lower(prefix);
        let selected = self.browse_selection(&options["filters"])?;
        let mut results = BrowseResults::default();
        if !selected.as_ref().is_some_and(SelectedBooks::is_empty) {
            self.lookup.visit_name_candidates(
                &self.lookup_generation,
                table,
                &[&prefix],
                |label| label != "?",
                |_, key, name, active, books| {
                    let count = selected.as_ref().map_or(u64::from(active), |selected| {
                        books
                            .iter()
                            .filter(|id| selected.contains(u32::from_le_bytes(**id)))
                            .count() as u64
                    });
                    results.add(&key[prefix.len()..], name, count);
                    Ok(())
                },
            )?;
        }
        let mut result = serde_json::to_value(results.finish(&prefix))?;
        result["kind"] = kind.into();
        result["prefix"] = prefix.into_owned().into();
        Ok(result)
    }

    pub fn browser_entity(&self, options: &Value, reading: &CatalogueReading) -> Result<Value> {
        let kind = options["kind"].as_str().unwrap_or_default();
        let table = match kind {
            "author" => Table::Author,
            "series" => Table::Series,
            _ => return Err("Укажите автора или серию".into()),
        };
        let original = options["name"]
            .as_str()
            .filter(|value| value.chars().count() <= 500)
            .ok_or("Укажите автора или серию")?;
        let name = normalize_entity_text(original);
        if name.is_empty() {
            return Err("Укажите автора или серию".into());
        }
        let page = query_number(&options["page"]).max(1.0) as u64;
        let limit = match query_number(&options["limit"]) {
            0.0 => 40,
            value => value.clamp(1.0, 100.0) as usize,
        };
        let scoped = self.browse_selection(&options["filters"])?;
        let mut ids: Vec<_> = self
            .entity_candidates(table, original, &name)?
            .into_iter()
            .filter(|&id| scoped.as_ref().is_none_or(|scope| scope.contains(id)))
            .collect();
        ids.sort_unstable();
        let mut rows = Vec::with_capacity(ids.len());
        self.store
            .visit_search_rows(&self.generation, Some(&ids), |_, bytes| {
                let row: EntityBook = serde_json::from_slice(bytes)?;
                if row.del.unwrap_or_default() == 0 {
                    rows.push(row);
                }
                Ok(())
            })?;
        let series = order_entity(&mut rows, table == Table::Author)?;
        let ordered: Vec<_> = rows.iter().map(|row| row.id).collect();
        let progress = |uid: &str| {
            reading
                .progress
                .as_ref()
                .and_then(|entries| entries.get(uid))
        };
        let page = EntitySelection::new(&ordered, page, limit, |index| {
            progress(&rows[index].uid).is_some_and(|entry| {
                entry["hidden"] != true && query_number(&entry["percent"]) >= 0.999
            })
        })?;
        let mut books = HashMap::new();
        for mut book in self
            .store
            .catalogue_rows(&self.generation, page.wanted().collect())?
        {
            let uid = field(&book, "_uid").to_owned();
            if let Some(override_) = reading.overrides[uid.trim()].as_object() {
                for field in ["title", "author", "series", "serno"] {
                    if let Some(value) = override_.get(field) {
                        book.insert(field.into(), value.clone());
                    }
                }
                book.insert("metadataOverridden".into(), true.into());
                book.insert(
                    "metadataOverrideUpdatedAt".into(),
                    override_
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                );
            }
            if let Some(progress) = progress(&uid) {
                book.insert("_readerProgress".into(), progress.clone());
            }
            books.insert(number(&book, "id") as u32, book);
        }
        let next = page.next_id.and_then(|id| books.get(&id)).cloned();
        let books: Vec<_> = page.ids.iter().filter_map(|id| books.remove(id)).collect();
        Ok(
            json!({"kind":kind,"name":name,"total":ordered.len(),"page":page.page,"pageCount":page.page_count,
            "limit":limit,"read":reading.progress.as_ref().map(|_| page.read),"next":next,"books":books,"series":series}),
        )
    }

    fn entity_candidates(&self, table: Table, original: &str, name: &str) -> Result<HashSet<u32>> {
        let select = |value: &str| {
            let key = lower(value);
            self.lookup
                .browser_candidates(&self.lookup_generation, table, &[&key], |label| {
                    label != "?" && label == key
                })
        };
        let ids = select(original)?;
        if ids.is_empty() && name != original {
            return select(name);
        }
        Ok(ids)
    }

    pub(crate) fn follow_uids(&self, kind: &str, name: &str, limit: usize) -> Result<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct BookUid {
            #[serde(rename = "_uid")]
            uid: String,
        }

        let table = match kind {
            "author" => Table::Author,
            "series" => Table::Series,
            _ => return Err("Укажите автора или серию (до 200 символов)".into()),
        };
        let mut ids = self.entity_candidates(table, name, name)?;
        let active = self.store.opds_books(&[])?;
        ids.retain(|id| active.contains(*id));
        if ids.len() > limit {
            return Err("Слишком много книг для одной подписки (лимит 5000)".into());
        }
        let mut ids: Vec<_> = ids.into_iter().collect();
        ids.sort_unstable();
        let mut uids = Vec::with_capacity(ids.len());
        self.store
            .visit_search_rows(&self.generation, Some(&ids), |_, bytes| {
                let book: BookUid = serde_json::from_slice(bytes)?;
                if !book.uid.is_empty() {
                    uids.push(book.uid);
                }
                Ok(())
            })?;
        uids.sort_unstable();
        uids.dedup();
        Ok(uids)
    }

    pub(crate) fn browser_series_through(
        &self,
        name: &str,
        normalized: &str,
        target: &str,
        overrides: &Value,
    ) -> Result<SeriesVolumes> {
        let mut ids: Vec<_> = self
            .entity_candidates(Table::Series, name, normalized)?
            .into_iter()
            .collect();
        ids.sort_unstable();
        let mut volumes = Vec::with_capacity(ids.len());
        self.store
            .visit_search_rows(&self.generation, Some(&ids), |_, bytes| {
                let book: SeriesVolume = serde_json::from_slice(bytes)?;
                if book.del.unwrap_or_default() == 0 {
                    volumes.push(book);
                }
                Ok(())
            })?;
        Ok(series_through(volumes, target, |uid| {
            overrides[uid]
                .get("serno")
                .map(|number| Some(query_number(number)))
        }))
    }

    fn browse_selection(&self, filters: &Value) -> Result<Option<SelectedBooks>> {
        let mut selected = None;
        for (field, facet, separators) in [
            ("lang", Facet::Lang, &[','][..]),
            ("ext", Facet::Ext, &[',', '|'][..]),
            ("genre", Facet::Genre, &[','][..]),
            ("sourceId", Facet::Source, &[][..]),
        ] {
            let Some(value) = filters.get(field) else {
                continue;
            };
            let value = value
                .as_str()
                .filter(|value| {
                    value.encode_utf16().count() <= 500 && !value.starts_with(['~', '*', '#', '='])
                })
                .ok_or("Некорректный фильтр каталога")?;
            if value.is_empty() {
                continue;
            }
            let values = split_values(value, separators);
            let active = self.store.opds_books(&[])?;
            selected = Some(self.store.select_facet(
                facet,
                Some(selected.as_ref().unwrap_or(&active)),
                |label| {
                    let Label::Text(label) = label else {
                        return false;
                    };
                    match facet {
                        Facet::Source => label == value.trim_matches(js_whitespace),
                        Facet::Genre => values
                            .iter()
                            .any(|value| value == label.trim_matches(js_whitespace)),
                        _ => values.contains(label),
                    }
                },
            )?);
        }
        Ok(selected)
    }

    pub fn browser_names(&self, field: &str, query: &Map<String, Value>) -> Result<Value> {
        let table = name_table(field)?;
        let term = NameQuery::parse(query.get(field).and_then(Value::as_str).unwrap_or_default())?;
        let search = Search::new(query, field)?;
        let non_deleted = search
            .active_only()
            .then(|| self.store.opds_books(&[]))
            .transpose()?;
        let matching = (non_deleted.is_none() && search.constrained())
            .then(|| self.matching(&search))
            .transpose()?;
        let mut found = Vec::new();
        let mut book_groups = Vec::new();
        let mut count = 0;
        self.lookup.visit_names(
            &self.lookup_generation,
            table,
            |key| term.matches(key),
            |id, _, name, active, ids| {
                if name.is_empty() {
                    return Ok(());
                }
                let (book_count, deleted) = if let Some(matching) = &matching {
                    count_matching(ids, matching)
                } else if non_deleted.is_some() {
                    (active as usize, 0)
                } else {
                    (active as usize, ids.len().saturating_sub(active as usize))
                };
                if book_count == 0 && deleted == 0 {
                    return Ok(());
                }
                if count >= search.start && found.len() < search.limit {
                    let mut row = json!({"id":id,"bookCount":book_count,"bookDelCount":deleted});
                    row[field] = Value::String(name.to_owned());
                    found.push(row);
                    if table == Table::Title {
                        let ids = ids
                            .iter()
                            .copied()
                            .map(u32::from_le_bytes)
                            .filter(|id| {
                                matching
                                    .as_ref()
                                    .is_none_or(|selected| selected.contains_key(id))
                                    && non_deleted
                                        .as_ref()
                                        .is_none_or(|selected| selected.contains(*id))
                            })
                            .collect();
                        book_groups.push(ids);
                    }
                }
                count += 1;
                Ok(())
            },
        )?;
        for (row, ids) in found.iter_mut().zip(book_groups) {
            row["books"] = serde_json::to_value(self.store.catalogue_rows(&self.generation, ids)?)?;
        }
        Ok(json!({"found":found,"totalFound":count}))
    }

    fn matching(&self, search: &Search) -> Result<HashMap<u32, bool>> {
        let mut selected = HashMap::new();
        let candidates = self.search_candidates(search)?;
        self.store
            .visit_search_rows(&self.generation, candidates.as_deref(), |id, bytes| {
                let row: Record = serde_json::from_slice(bytes)?;
                if search.matches(&row) {
                    selected.insert(id, number(&row, "del") != 0);
                }
                Ok(())
            })?;
        Ok(selected)
    }

    pub fn browser_author(
        &self,
        id: u32,
        query: &Map<String, Value>,
        series: bool,
    ) -> Result<Value> {
        let search = Search::new(query, "")?;
        let mut groups =
            self.lookup
                .postings(self.lookup_generation.clone(), Table::Author, vec![id])?;
        let Some(row) = groups.pop() else {
            return Ok(if series {
                json!({"author":"","series":[]})
            } else {
                json!({"author":"","books":[]})
            });
        };
        let mut ids = row.book_ids;
        if let Some(selected) = self.extra_candidates(&search)? {
            ids.retain(|id| selected.contains(id));
        }
        let mut books = self.store.catalogue_rows(&self.generation, ids)?;
        books.retain(|book| search.matches(book));
        if !series {
            return Ok(json!({"author":row.name,"books":books}));
        }
        let labels: HashSet<_> = books
            .iter()
            .filter_map(|book| {
                let label = field(book, "series");
                (!label.is_empty()).then(|| label.to_lowercase())
            })
            .collect();
        let mut volumes = Vec::new();
        self.lookup.visit_names(
            &self.lookup_generation,
            Table::Series,
            |key| labels.contains(key),
            |id, _, name, active, ids| {
                volumes.push(json!({"id":id,"series":name,"bookCount":active,
                    "bookDelCount":ids.len().saturating_sub(active as usize)}));
                Ok(())
            },
        )?;
        Ok(json!({"author":row.name,"series":volumes}))
    }

    pub fn browser_series(&self, name: &str, query: &Map<String, Value>) -> Result<Value> {
        let search = Search::new(query, "")?;
        let name = name.to_lowercase();
        let mut ids = Vec::new();
        if !name.is_empty() {
            self.lookup.visit_name_candidates(
                &self.lookup_generation,
                Table::Series,
                &[&name],
                |key| key == name,
                |_, _, _, _, books| {
                    ids.extend(books.iter().copied().map(u32::from_le_bytes));
                    Ok(())
                },
            )?;
        }
        if let Some(selected) = self.extra_candidates(&search)? {
            ids.retain(|id| selected.contains(id));
        }
        let mut books = self.store.catalogue_rows(&self.generation, ids)?;
        books.retain(|book| search.matches(book));
        Ok(json!({"books":books}))
    }

    pub fn browser_facets(&self) -> Result<(Vec<String>, Vec<String>)> {
        Ok((
            self.store.facet_text(Facet::Lang)?,
            self.store.facet_text(Facet::Ext)?,
        ))
    }
}

fn count_matching(ids: &[[u8; 4]], matching: &HashMap<u32, bool>) -> (usize, usize) {
    let mut counts = (0, 0);
    for &bytes in ids {
        match matching.get(&u32::from_le_bytes(bytes)) {
            Some(false) => counts.0 += 1,
            Some(true) => counts.1 += 1,
            None => (),
        }
    }
    counts
}

fn limit_number(value: Option<&Value>) -> Option<usize> {
    let value = value?;
    value
        .as_str()
        .and_then(|text| text.parse().ok())
        .or_else(|| value.as_u64().and_then(|value| value.try_into().ok()))
}

fn split_values(input: &str, separators: &[char]) -> Vec<String> {
    input
        .split(separators)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn name_table(field: &str) -> Result<Table> {
    match field {
        "author" => Ok(Table::Author),
        "series" => Ok(Table::Series),
        "title" => Ok(Table::Title),
        _ => Err(format!("Unknown value for param 'from': {field}").into()),
    }
}
