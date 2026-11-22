use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::Result;
use inpx_catalog::opds_shelves::{self, CatalogShelf, Grouping, Selection};
use inpx_catalog::reader_state::PublishedReading;
use inpx_catalog::standalone_catalogue::Catalogue;
use serde_json::{Map, Value};

use super::{Description, Feed, Link, Page, entry, field_text};

const MAX_PAGE_ITEMS: usize = 50;
const SHARED: &str = "/catalog-shelves";
const PROFILES: &str = "/reading-profiles";
const LISTS: &str = "/reading-lists";
const LIST: &str = "/reading-lists/list";
const PROGRESS: &str = "/reading-progress";

#[derive(Debug)]
pub(super) struct Unavailable;

impl fmt::Display for Unavailable {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("Подборки OPDS временно недоступны")
    }
}

impl Error for Unavailable {}

pub(super) struct SharedShelves {
    path: Option<PathBuf>,
    state: Mutex<SharedState>,
}

#[derive(Default)]
struct SharedState {
    selections: VecDeque<Cached>,
    failure: Option<(String, Instant)>,
}

struct Cached {
    generation: String,
    query: Map<String, Value>,
    grouping: Grouping,
    selection: Arc<Selection>,
    loaded: Instant,
}

impl SharedShelves {
    pub(super) fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            state: Mutex::new(SharedState::default()),
        }
    }

    fn load(&self) -> Result<Vec<CatalogShelf>> {
        let Some(path) = &self.path else {
            return Ok(Vec::new());
        };
        let mut state = self.state.lock().expect("OPDS collections");
        match opds_shelves::load(path) {
            Ok(shelves) => {
                state.failure = None;
                Ok(shelves)
            }
            Err(error) => {
                let message = error.to_string();
                if state.failure.as_ref().is_none_or(|(previous, observed)| {
                    previous != &message || observed.elapsed() >= Duration::from_secs(60)
                }) {
                    log::warn!(target: "inpx::opds", "Не удалось обновить общие подборки OPDS");
                    state.failure = Some((message, Instant::now()));
                }
                Err(Unavailable.into())
            }
        }
    }

    pub(super) fn append_root(&self, feed: &mut Feed, page: &Page<'_>) {
        match self.load() {
            Ok(shelves) => feed.navigation.extend(
                shelves
                    .into_iter()
                    .map(|shelf| page.nav(shelf.name, SHARED, &[("id", &shelf.id)])),
            ),
            Err(_) => {
                feed.navigation
                    .push(page.nav("Общие подборки временно недоступны", SHARED, &[]))
            }
        }
    }

    fn select(&self, catalogue: &Catalogue, shelf: &CatalogShelf) -> Result<Arc<Selection>> {
        let query = shelf.query();
        let mut state = self.state.lock().expect("OPDS collections");
        state.selections.retain(|item| {
            item.generation == catalogue.generation
                && item.loaded.elapsed() < Duration::from_secs(30)
        });
        if let Some(cached) = state
            .selections
            .iter()
            .find(|item| item.grouping == shelf.grouping && item.query == query)
        {
            return Ok(cached.selection.clone());
        }
        let selection = Arc::new(Selection::build(catalogue, &query, shelf.grouping).map_err(
            |_| {
                log::warn!(target: "inpx::opds", "Ошибка чтения подборки OPDS");
                Unavailable
            },
        )?);
        if state.selections.len() == 2 {
            state.selections.pop_front();
        }
        state.selections.push_back(Cached {
            generation: catalogue.generation.clone(),
            query,
            grouping: shelf.grouping,
            selection: selection.clone(),
            loaded: Instant::now(),
        });
        Ok(selection)
    }

    pub(super) fn render(&self, catalogue: &Catalogue, page: &Page<'_>) -> Result<Option<Feed>> {
        let shelves = self.load()?;
        let Some(shelf) = shelves.iter().find(|shelf| shelf.id == page.text("id")) else {
            return Ok(None);
        };
        let selection = self.select(catalogue, shelf)?;
        let number = shelf_page(page);
        let offset = (number - 1) * MAX_PAGE_ITEMS;
        let group = match shelf.grouping {
            Grouping::Books => "",
            _ => page.text("group"),
        };
        let mut feed = Feed::new("catalog-shelf", &shelf.name);
        let more = if shelf.grouping != Grouping::Books && group.is_empty() {
            for item in selection.groups.iter().skip(offset).take(MAX_PAGE_ITEMS) {
                feed.navigation.push(page.nav(
                    format!("{} ({})", item.name, item.count()),
                    SHARED,
                    &[("id", &shelf.id), ("group", &item.id.to_string())],
                ));
            }
            offset + MAX_PAGE_ITEMS < selection.groups.len()
        } else {
            let item = if group.is_empty() {
                None
            } else {
                let Some(item) = selection
                    .groups
                    .iter()
                    .find(|item| item.id.to_string() == group)
                else {
                    return Ok(None);
                };
                use_group(&mut feed, page, &shelf.id, &shelf.name, &item.name);
                Some(item)
            };
            let (rows, more) = selection.page(catalogue, item, offset, MAX_PAGE_ITEMS)?;
            feed.entries
                .extend(rows.iter().map(|row| book_entry(row, None)));
            more
        };
        finish_shelf(&mut feed, page, &shelf.id, group, number, more, "/root");
        Ok(Some(feed))
    }
}

pub(super) fn append_reading_root(feed: &mut Feed, page: &Page<'_>, reading: &PublishedReading) {
    let owner = page.scope();
    if reading.enabled(owner) {
        for state in ["reading", "read", "hidden"] {
            feed.navigation
                .push(page.nav(state_title(state), PROGRESS, &[("state", state)]));
        }
        feed.navigation.push(page.nav("Списки чтения", LISTS, &[]));
        for (id, name) in reading.pinned(owner) {
            feed.navigation.push(page.nav(name, LIST, &[("id", id)]));
        }
    } else if page.profile.is_none() && !reading.profiles(None).is_empty() {
        feed.navigation
            .push(page.nav("Подборки пользователей", PROFILES, &[]));
    }
}

pub(super) fn personal(
    catalogue: &Catalogue,
    page: &Page<'_>,
    reading: &PublishedReading,
) -> Result<Option<Feed>> {
    let owner = page.scope();
    match page.route {
        PROFILES => {
            let mut feed = Feed::new("reading-profiles", "Подборки пользователей");
            for profile in reading.profiles(page.profile.map(|_| owner)) {
                let public_id = if profile.login.is_empty() {
                    &profile.id
                } else {
                    &profile.login
                };
                feed.navigation
                    .push(page.nav(&profile.name, "/root", &[("user", public_id)]));
            }
            if feed.navigation.is_empty() {
                feed.navigation
                    .push(page.nav("[Публичных подборок пока нет]", PROFILES, &[]));
            }
            Ok(Some(feed))
        }
        LISTS => {
            let mut feed = Feed::new("reading-lists", "Списки чтения");
            if owner.is_empty() {
                feed.navigation
                    .push(page.nav("[Выберите профиль пользователя]", PROFILES, &[]));
            } else if !reading.enabled(owner) {
                return Ok(None);
            } else {
                let lists = reading.lists(owner, catalogue)?;
                for list in rows(&lists["lists"]) {
                    feed.navigation.push(page.nav(
                        field_text(list, "name"),
                        LIST,
                        &[("id", field_text(list, "id"))],
                    ));
                }
                if feed.navigation.is_empty() {
                    feed.navigation
                        .push(page.nav("[Списков пока нет]", LISTS, &[]));
                }
            }
            Ok(Some(feed))
        }
        LIST => {
            let id = page.text("id");
            let Some(detail) = reading.list(owner, id, catalogue)? else {
                return Ok(None);
            };
            Ok(Some(personal_shelf(page, id, &detail)))
        }
        PROGRESS => {
            let Some(progress) = reading.progress(owner, page.text("state"), catalogue)? else {
                return Ok(None);
            };
            Ok(Some(progress_feed(page, &progress)))
        }
        _ => Ok(None),
    }
}

fn personal_shelf(page: &Page<'_>, id: &str, detail: &Value) -> Feed {
    let list = &detail["list"];
    let name = field_text(list, "name");
    let mut feed = Feed::new("reading-list", name);
    let books = rows(&detail["books"]);
    let group = page.text("group");
    let grouping = list["opds"]["grouping"].as_str().unwrap_or("books");
    let number = shelf_page(page);
    let offset = (number - 1) * MAX_PAGE_ITEMS;
    let more = if matches!(grouping, "authors" | "series") && group.is_empty() {
        let mut by_name = HashMap::new();
        for book in books {
            for label in labels(book, grouping) {
                *by_name.entry(label).or_insert(0) += 1;
            }
        }
        let mut groups: Vec<_> = by_name.into_iter().collect();
        groups.sort_by_cached_key(|(label, _)| label.to_lowercase());
        for (label, count) in groups.iter().skip(offset).take(MAX_PAGE_ITEMS) {
            feed.navigation.push(page.nav(
                format!("{label} ({count})"),
                LIST,
                &[("id", id), ("group", label)],
            ));
        }
        offset + MAX_PAGE_ITEMS < groups.len()
    } else {
        if !group.is_empty() {
            use_group(&mut feed, page, id, name, group);
        }
        let mut selected = books
            .iter()
            .filter(|book| grouping == "books" || labels(book, grouping).contains(&group))
            .skip(offset);
        feed.entries.extend(
            selected
                .by_ref()
                .take(MAX_PAGE_ITEMS)
                .map(|row| book_entry(row, Some(row["_readingListRead"] == true))),
        );
        selected.next().is_some()
    };
    finish_shelf(&mut feed, page, id, group, number, more, LISTS);
    feed
}

fn labels<'a>(book: &'a Value, grouping: &str) -> Vec<&'a str> {
    if grouping != "authors" {
        let label = field_text(book, "series").trim();
        return vec![if label.is_empty() {
            "Без серии"
        } else {
            label
        }];
    }
    let mut seen = HashSet::new();
    let labels: Vec<_> = field_text(book, "author")
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty() && seen.insert(*name))
        .collect();
    if labels.is_empty() {
        vec!["Без автора"]
    } else {
        labels
    }
}

fn use_group(feed: &mut Feed, page: &Page<'_>, id: &str, name: &str, group: &str) {
    feed.title = format!("{name} — {group}");
    feed.navigation
        .push(page.nav("[Все группы]", page.route, &[("id", id)]));
}

fn shelf_page(page: &Page<'_>) -> usize {
    page.number("page").min(1_000_000)
}

fn finish_shelf(
    feed: &mut Feed,
    page: &Page<'_>,
    id: &str,
    group: &str,
    number: usize,
    more: bool,
    empty_path: &str,
) {
    if feed.entries.is_empty()
        && feed
            .navigation
            .iter()
            .all(|link| link.title.as_deref() == Some("[Все группы]"))
    {
        feed.navigation
            .push(page.nav("[Список пуст]", empty_path, &[]));
    }
    for (enabled, target, rel, title) in [
        (number > 1, number - 1, "previous", "[Предыдущая страница]"),
        (more, number + 1, "next", "[Следующая страница]"),
    ] {
        if enabled {
            let args = [("id", id), ("group", group), ("page", &target.to_string())];
            let href = page.href(page.route, &args);
            feed.links.push(Link::new(href.clone(), rel, super::NAV));
            if !page.json {
                let mut link = Link::new(href, rel, super::NAV);
                link.title = Some(title.into());
                feed.navigation.push(link);
            }
        }
    }
}

fn progress_feed(page: &Page<'_>, progress: &Value) -> Feed {
    let state = field_text(progress, "state");
    let mut feed = Feed::new("reading-progress", state_title(state));
    for book in rows(&progress["items"]) {
        let percent = book["percent"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
        if book["unavailable"] == true {
            feed.navigation.push(page.nav(
                format!("{} ({:.0}%)", field_text(book, "title"), percent * 100.0),
                PROGRESS,
                &[("state", state)],
            ));
            continue;
        }
        let mut row = book.clone();
        row["_uid"] = book["bookUid"].clone();
        let mut publication = book_entry(&row, None);
        if book["state"] == "read" {
            publication.title.insert_str(0, "✓ ");
        }
        publication.description = Some(Description {
            body: format!("{:.0}%", percent * 100.0),
            html: false,
        });
        feed.entries.push(publication);
    }
    if feed.entries.is_empty() && feed.navigation.is_empty() {
        feed.navigation
            .push(page.nav("[Книг пока нет]", PROGRESS, &[("state", state)]));
    }
    feed
}

fn book_entry(row: &Value, read: Option<bool>) -> super::Entry {
    let mut publication = entry(row, true);
    if read == Some(true) {
        publication.title.insert_str(0, "✓ ");
    }
    let series = field_text(row, "series");
    let series = (!series.is_empty()).then(|| format!("Серия: {series}"));
    let read_status = read.map(|read| {
        if read {
            "Прочитано"
        } else {
            "Не прочитано"
        }
    });
    let details = [
        Some(field_text(row, "author")),
        series.as_deref(),
        read_status,
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    if !details.is_empty() {
        publication.description = Some(Description {
            body: details,
            html: false,
        });
    }
    publication
}

fn state_title(state: &str) -> &'static str {
    match state {
        "read" => "Прочитано",
        "hidden" => "Скрыто",
        "all" => "Все книги профиля",
        _ => "Продолжить чтение",
    }
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
