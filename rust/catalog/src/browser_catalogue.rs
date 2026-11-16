use std::collections::{HashMap, HashSet};

use inpx_reader::Record;
use serde_json::{Map, Value, json};

use crate::catalog_query::Filter;
use crate::catalog_text::{field, lower, number, words};
use crate::facets::Facet;
use crate::lookup::Table;
use crate::opds_catalogue::NameQuery;
use crate::standalone_catalogue::Catalogue;
use crate::{Result, StoreResponse};

struct Search {
    filters: Vec<Filter>,
    comparisons: Vec<(String, NameQuery)>,
    source: String,
    start: usize,
    limit: usize,
    hide_copies: bool,
}

impl Search {
    fn new(query: &Map<String, Value>, except: &str) -> Result<Self> {
        let mut filters = Vec::new();
        let mut comparisons = Vec::new();
        if query
            .get("ratingCount")
            .is_some_and(|value| !value.is_null() && value != "")
        {
            return Err("Индекс количества оценок пока недоступен".into());
        }
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
        !self.source.is_empty() || !self.filters.is_empty() || !self.comparisons.is_empty()
    }

    fn active_only(&self) -> bool {
        self.source.is_empty()
            && self.comparisons.is_empty()
            && matches!(&self.filters[..], [Filter::NumberValues { field, values }] if field == "del" && values == &[0.0])
    }
}

impl Catalogue {
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
        if query
            .get("isbn")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            return Err("Индекс ISBN пока недоступен".into());
        }
        let search = Search::new(query, "")?;
        self.store.browser_search_order(
            &self.generation,
            |book| search.matches(book),
            search.hide_copies,
        )
    }

    pub fn browser_books(&self, query: &Map<String, Value>) -> Result<Value> {
        let search = Search::new(query, "")?;
        let (found, total) = self.store.browser_search(
            &self.generation,
            |book| search.matches(book),
            search.hide_copies,
            search.start,
            search.limit,
        )?;
        Ok(json!({"found":found,"totalFound":total}))
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
        self.store.visit(|id, bytes| {
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
        let mut books = self.store.catalogue_rows(&self.generation, row.book_ids)?;
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
            self.lookup.visit_names(
                &self.lookup_generation,
                Table::Series,
                |key| key == name,
                |_, _, _, _, books| {
                    ids.extend(books.iter().copied().map(u32::from_le_bytes));
                    Ok(())
                },
            )?;
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
