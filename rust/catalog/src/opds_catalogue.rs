//! Public catalogue queries over the same book, name and facet indexes as the API.
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};

use inpx_reader::Record;
use regex::{Regex, RegexBuilder};

use crate::Result;
use crate::catalog_text;
use crate::lookup_discovery::SelectedBooks;
use crate::standalone_catalogue::Catalogue;

pub use crate::lookup::Table as Field;

const INITIALS: &str = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяabcdefghijklmnopqrstuvwxyz";
const GROUP_THRESHOLD: usize = 50;
const SEARCH_LIMIT: usize = 120;

pub enum NameQuery {
    Prefix(String),
    Exact(String),
    Contains(String),
    Others(String),
    Pattern(Regex),
}

impl NameQuery {
    pub fn parse(query: &str) -> Result<Self> {
        let (prefix, value) = query.split_at_checked(1).unwrap_or(("", query));
        Ok(match prefix {
            "=" => Self::Exact(value.to_lowercase()),
            "*" => Self::Contains(value.to_lowercase()),
            "#" => Self::Others(value.to_lowercase()),
            "~" => Self::Pattern(
                RegexBuilder::new(value)
                    .case_insensitive(true)
                    .size_limit(128 * 1024)
                    .build()?,
            ),
            _ if query == "___others" => Self::Others(String::new()),
            _ => Self::Prefix(query.to_lowercase()),
        })
    }

    pub(crate) fn matches(&self, name: &str) -> bool {
        match self {
            Self::Prefix(prefix) => name.starts_with(prefix),
            Self::Exact(value) => name == value,
            Self::Contains(value) => name != "?" && name.contains(value),
            Self::Others(value) => {
                name != "?"
                    && name.chars().next().is_some_and(|ch| !INITIALS.contains(ch))
                    && name.contains(value)
            }
            Self::Pattern(pattern) => pattern.is_match(name),
        }
    }
}

pub struct Name {
    pub label: String,
    pub query: String,
    pub grouped: bool,
}

impl Catalogue {
    pub fn opds_genres(&self) -> Result<Vec<String>> {
        self.check_lease()?;
        if let Some(prepared) = &self.prepared_browse {
            return Ok(prepared.genres.clone());
        }
        self.store.opds_genres()
    }

    fn opds_selection(&self, genre: &str) -> Result<Cow<'_, SelectedBooks>> {
        let genre = catalog_text::lower(genre);
        let genres: Vec<_> = genre
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect();
        self.store.opds_books(&genres)
    }

    pub fn opds_names(
        &self,
        field: Field,
        query: &NameQuery,
        genre: &str,
        group: bool,
    ) -> Result<Vec<Name>> {
        self.check_lease()?;
        let scope = (!genre.is_empty())
            .then(|| self.opds_selection(genre))
            .transpose()?;
        let depth = match query {
            NameQuery::Prefix(prefix) | NameQuery::Others(prefix) => prefix.chars().count() + 1,
            _ => 1,
        };
        let initial = depth == 1 && !matches!(query, NameQuery::Others(_));
        let mut names = Vec::new();
        let mut groups = BTreeMap::<String, (String, usize)>::new();
        let mut total = 0;
        let mut other = false;
        self.lookup.visit_names(
            &self.lookup_generation,
            field,
            |label| query.matches(label),
            |_, key, label, count, books| {
                let count = match &scope {
                    Some(scope) => active_ids(books, scope).count(),
                    None => count as usize,
                };
                if count > 0 && key != "?" {
                    total += 1;
                    if !group || total <= GROUP_THRESHOLD {
                        names.push((key.to_owned(), label.to_owned()));
                    }
                    if group {
                        if initial && !key.starts_with(|ch| INITIALS.contains(ch)) {
                            other = true;
                        } else {
                            groups
                                .entry(key.chars().take(depth).collect())
                                .and_modify(|(_, count)| *count += 1)
                                .or_insert_with(|| (label.into(), 1));
                        }
                    }
                }
                Ok(())
            },
        )?;
        if !group || total <= GROUP_THRESHOLD {
            names.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            return Ok(names.into_iter().map(|(_, label)| exact(label)).collect());
        }
        let mut ordered: Vec<_> = groups.into_iter().collect();
        if initial {
            ordered.sort_by_key(|(key, _)| {
                !key.starts_with(|ch: char| ('а'..='я').contains(&ch) || ch == 'ё')
            });
        }
        let mut rows: Vec<_> = ordered
            .into_iter()
            .map(|(key, (name, count))| {
                if count == 1 {
                    exact(name)
                } else {
                    Name {
                        label: format!("{}~", key.to_uppercase().replace(' ', "·")),
                        query: key,
                        grouped: true,
                    }
                }
            })
            .collect();
        if other {
            rows.push(Name {
                label: String::new(),
                query: "___others".into(),
                grouped: true,
            });
        }
        Ok(rows)
    }

    pub fn opds_entity(&self, field: Field, query: &NameQuery, genre: &str) -> Result<Vec<Record>> {
        self.check_lease()?;
        let selected = self.opds_selection(genre)?;
        let ids = self.opds_matching_books(field, query, &selected)?;
        self.store.catalogue_rows(&self.generation, ids)
    }

    pub fn opds_entity_count(&self, field: Field, query: &NameQuery) -> Result<usize> {
        self.check_lease()?;
        let selected = self.opds_selection("")?;
        Ok(self.opds_matching_books(field, query, &selected)?.len())
    }

    pub fn opds_search(&self, term: &str, genre: &str, needed: usize) -> Result<Vec<Record>> {
        self.check_lease()?;
        let term = term.trim();
        if term.is_empty() {
            return Ok(Vec::new());
        }
        let term = catalog_text::lower(term);
        let query = NameQuery::Contains(term.to_string());
        let selected = self.opds_selection(genre)?;
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        for field in [Field::Title, Field::Series, Field::Author] {
            let candidates = self.opds_matching_books(field, &query, &selected)?;
            let matched = self.store.opds_ranked(
                &self.generation,
                candidates,
                field.name(),
                &term,
                SEARCH_LIMIT,
            )?;
            ids.extend(matched.into_iter().filter(|id| seen.insert(*id)));
            if ids.len() >= needed {
                break;
            }
        }
        self.store.catalogue_rows(&self.generation, ids)
    }

    fn opds_matching_books(
        &self,
        field: Field,
        query: &NameQuery,
        scope: &SelectedBooks,
    ) -> Result<Vec<u32>> {
        if scope.is_empty() {
            return Ok(Vec::new());
        }
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        self.lookup.visit_names(
            &self.lookup_generation,
            field,
            |label| query.matches(label),
            |_, _, _, _, books| {
                ids.extend(active_ids(books, scope).filter(|id| seen.insert(*id)));
                Ok(())
            },
        )?;
        Ok(ids)
    }
}

fn active_ids<'a>(
    books: &'a [[u8; 4]],
    selection: &'a SelectedBooks,
) -> impl Iterator<Item = u32> + 'a {
    books
        .iter()
        .copied()
        .map(u32::from_le_bytes)
        .filter(|id| selection.contains(*id))
}

fn exact(label: String) -> Name {
    Name {
        query: format!("={label}"),
        label,
        grouped: false,
    }
}
