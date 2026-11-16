use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

use hyper::{Method, Request, Response, StatusCode, Uri, body::Incoming, header};
use inpx_catalog::Result;
use inpx_catalog::opds_access::{Grant, Scope};
use inpx_catalog::opds_catalogue::{Field, NameQuery};
use inpx_catalog::reader_state::PublishedReading;
use inpx_catalog::standalone_catalogue::Catalogue;
use serde_json::{Value, json};

use super::{
    Book, Context, Description, Entry, Link, Model, PAGE_SIZE, acquisition, atom, response, urls,
};
use crate::http::{Body, error};
use crate::standalone_access;

#[path = "standalone_shelves.rs"]
mod shelves;

const ATOM: &str = "application/atom+xml";
const NAV: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ_FEED: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const SEARCH: &str = "application/opensearchdescription+xml";
const UNKNOWN_BOOK: &str = "Без названия";

pub(crate) struct Opds {
    root: String,
    json_root: String,
    static_root: String,
    book_path: String,
    tolino: bool,
    epub_reader: bool,
    shared_shelves: shelves::SharedShelves,
}

#[derive(Clone, Copy)]
struct Entity {
    key: &'static str,
    title: &'static str,
    field: Field,
    other: &'static str,
}

const AUTHOR: Entity = Entity {
    key: "author",
    title: "Авторы",
    field: Field::Author,
    other: "[Остальные авторы]",
};
const SERIES: Entity = Entity {
    key: "series",
    title: "Серии",
    field: Field::Series,
    other: "[Остальные серии]",
};
const TITLE: Entity = Entity {
    key: "title",
    title: "Книги",
    field: Field::Title,
    other: "[Остальные названия]",
};
const ENTITIES: [Entity; 3] = [AUTHOR, SERIES, TITLE];

struct Feed {
    id: String,
    title: String,
    links: Vec<Link>,
    navigation: Vec<Link>,
    entries: Vec<Entry>,
}

impl Feed {
    fn new(id: &str, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            links: Vec::new(),
            navigation: Vec::new(),
            entries: Vec::new(),
        }
    }
}

struct Page<'a> {
    root: &'a str,
    route: &'a str,
    uri: &'a Uri,
    query: HashMap<String, String>,
    json: bool,
    profile: Option<&'a Scope>,
}

impl Page<'_> {
    fn text(&self, key: &str) -> &str {
        self.query.get(key).map(String::as_str).unwrap_or_default()
    }

    fn number(&self, key: &str) -> usize {
        self.text(key).trim().parse::<usize>().unwrap_or(1).max(1)
    }

    fn scope(&self) -> &str {
        self.profile.map_or("", |profile| profile.id.as_str())
    }

    fn scope_url(&self, href: &str) -> String {
        if self.profile.is_none() {
            return href.into();
        }
        urls::scoped(href, "", Some(("user", self.scope())))
    }

    fn href(&self, route: &str, args: &[(&str, &str)]) -> String {
        let mut path = format!("{}{route}", self.root);
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.extend_pairs(args.iter().copied().filter(|(_, value)| !value.is_empty()));
        let query = query.finish();
        if !query.is_empty() {
            path.push('?');
            path.push_str(&query);
        }
        self.scope_url(&path)
    }

    fn nav(&self, title: impl Into<String>, route: &str, args: &[(&str, &str)]) -> Link {
        let mut link = Link::new(self.href(route, args), "subsection", NAV);
        link.title = Some(title.into());
        link
    }

    fn pages(&self, feed: &mut Feed, key: &str, current: usize, more: bool) {
        for (enabled, page, rel) in [
            (current > 1, current - 1, "previous"),
            (more, current.saturating_add(1), "next"),
        ] {
            if enabled {
                let href = urls::scoped(
                    &self.scope_url(&self.uri.to_string()),
                    "",
                    Some((key, &page.to_string())),
                );
                feed.links.push(Link::new(href, rel, NAV));
            }
        }
    }
}

impl Opds {
    pub(crate) fn new(
        root: &str,
        static_root: &str,
        book_path: &str,
        tolino: bool,
        epub_reader: bool,
        shelves_file: Option<PathBuf>,
    ) -> Self {
        let root = root.trim_end_matches('/');
        Self {
            root: root.into(),
            json_root: format!("{root}/v2"),
            static_root: static_root.into(),
            book_path: book_path.into(),
            tolino,
            epub_reader,
            shared_shelves: shelves::SharedShelves::new(shelves_file),
        }
    }

    pub(crate) fn matches(&self, path: &str) -> bool {
        path.strip_prefix(&self.root)
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('/'))
    }

    pub(crate) fn serve(
        &self,
        request: &Request<Incoming>,
        catalogue: &Catalogue,
        grant: &Grant,
        reading: Option<&PublishedReading>,
    ) -> Result<Response<Body>> {
        let uri = request.uri();
        let (root, route, json) = self.route(uri.path());
        match *request.method() {
            Method::GET | Method::HEAD => (),
            Method::POST if !json && self.tolino => (),
            Method::POST => return Ok(error(StatusCode::METHOD_NOT_ALLOWED)),
            _ => return Ok(error(StatusCode::NOT_FOUND)),
        }
        let mut query = HashMap::new();
        for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        {
            query
                .entry(key.into_owned())
                .or_insert_with(|| value.into_owned());
        }
        let page = Page {
            root,
            route,
            uri,
            query,
            json,
            profile: grant.scope.as_ref(),
        };
        let rendered = match self.render(catalogue, &page, reading) {
            Err(failure) if failure.is::<shelves::Unavailable>() => {
                return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
            }
            result => result?,
        };
        let Some((data, media)) = rendered else {
            return Ok(error(StatusCode::NOT_FOUND));
        };
        let (mut parts, _) = Response::builder()
            .header(header::CONTENT_TYPE, media)
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-robots-tag", "noindex, nofollow")
            .body(())?
            .into_parts();
        if grant.private() {
            standalone_access::private(&mut parts.headers);
        }
        response::document(
            parts,
            data,
            request.headers(),
            *request.method() == Method::HEAD,
        )
        .ok_or_else(|| "Invalid catalogue response".into())
    }

    pub(crate) fn published_reading(&self, path: &str) -> Option<bool> {
        match self.route(path).1 {
            "" | "/root" => Some(false),
            "/reading-profiles"
            | "/reading-lists"
            | "/reading-lists/list"
            | "/reading-progress" => Some(true),
            _ => None,
        }
    }

    fn route<'a>(&'a self, path: &'a str) -> (&'a str, &'a str, bool) {
        if let Some(route) = path
            .strip_prefix(&self.json_root)
            .filter(|route| route.is_empty() || route.starts_with('/'))
        {
            (
                &self.json_root,
                route.strip_suffix('/').unwrap_or(route),
                true,
            )
        } else {
            (
                &self.root,
                path.strip_prefix(&self.root)
                    .unwrap_or_default()
                    .trim_end_matches('/'),
                false,
            )
        }
    }

    fn render(
        &self,
        catalogue: &Catalogue,
        page: &Page<'_>,
        reading: Option<&PublishedReading>,
    ) -> Result<Option<(Vec<u8>, &'static str)>> {
        if page.route == "/opensearch" && !page.json {
            let model = serde_json::to_vec(&json!({"root":page.root,"scope":page.scope()}))?;
            return Ok(atom::opensearch(&model).map(|body| (body, SEARCH)));
        }
        let mut feed = match page.route {
            "" | "/root" => {
                let mut feed = root(catalogue, page);
                self.shared_shelves.append_root(&mut feed, page);
                if let Some(reading) = reading {
                    shelves::append_reading_root(&mut feed, page, reading);
                }
                feed
            }
            "/book" => {
                let uid = page.text("uid");
                if uid.is_empty() {
                    return Ok(None);
                }
                let Some(book) = catalogue.browser_book(uid)? else {
                    return Ok(None);
                };
                let book = entry(&book, false);
                let mut feed = Feed::new("book", &book.title);
                feed.entries.push(book);
                feed
            }
            "/search" => search(catalogue, page)?,
            "/genre" => genres(catalogue, page)?,
            "/author" => entity(catalogue, page, AUTHOR)?,
            "/series" => entity(catalogue, page, SERIES)?,
            "/title" => entity(catalogue, page, TITLE)?,
            "/catalog-shelves" => {
                let Some(feed) = self.shared_shelves.render(catalogue, page)? else {
                    return Ok(None);
                };
                feed
            }
            "/reading-profiles"
            | "/reading-lists"
            | "/reading-lists/list"
            | "/reading-progress" => {
                let reading = reading.ok_or(shelves::Unavailable)?;
                let Some(feed) = shelves::personal(catalogue, page, reading)? else {
                    return Ok(None);
                };
                feed
            }
            _ => return Ok(None),
        };
        let is_book = page.route == "/book";
        let content_type = if is_book { ACQ_FEED } else { NAV };
        feed.links.extend([
            Link::new(page.scope_url(&page.uri.to_string()), "self", content_type),
            Link::new(page.scope_url(page.root), "start", NAV),
            Link::new(page.href("/opensearch", &[]), "search", SEARCH),
            Link::new(
                if page.profile.is_some() {
                    format!(
                        "{}/search?term={{searchTerms}}&user={}",
                        page.root,
                        urls::component(page.scope())
                    )
                } else {
                    format!("{}/search?term={{searchTerms}}", page.root)
                },
                "search",
                ATOM,
            ),
        ]);
        let context = Context {
            root: page.root.into(),
            static_root: self.static_root.clone(),
            book_path: self.book_path.clone(),
            href: page.scope_url(&page.uri.to_string()),
            scope: page.scope().into(),
            template_scoped: page.profile.is_some(),
            conversion: self.epub_reader,
            formats: Some(vec!["fb2".into()]),
            mobi: false,
            preference: page
                .profile
                .map(|profile| profile.preferred_format.clone())
                .unwrap_or_default(),
            fallback_cover: Some(false),
        };
        let updated = catalogue.index_update["updatedAt"]
            .as_str()
            .map(str::to_owned);
        if !page.json {
            return Ok(render_atom(feed, context, updated, self.tolino)?.map(|bytes| (bytes, ATOM)));
        }
        let total = feed.entries.len();
        let current = page.number("v2page").min(total.div_ceil(PAGE_SIZE).max(1));
        let model = Model {
            context,
            is_book,
            title: feed.title,
            modified: updated,
            links: feed.links,
            navigation: feed.navigation,
            publications: feed
                .entries
                .into_iter()
                .skip((current - 1) * PAGE_SIZE)
                .take(PAGE_SIZE)
                .collect(),
            total,
            page: current,
        };
        Ok(super::render(model).map(|bytes| {
            (
                bytes,
                if is_book {
                    super::PUBLICATION
                } else {
                    super::FEED
                },
            )
        }))
    }
}

fn root(catalogue: &Catalogue, page: &Page<'_>) -> Feed {
    let title = catalogue.info["collection"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .trim();
    let mut feed = Feed::new(
        "root",
        if title.is_empty() {
            "Неизвестная коллекция"
        } else {
            title
        },
    );
    for kind in ENTITIES {
        feed.navigation
            .push(page.nav(kind.title, &format!("/{}", kind.key), &[]));
    }
    feed.navigation.push(page.nav("Жанры", "/genre", &[]));
    feed
}

fn search(catalogue: &Catalogue, page: &Page<'_>) -> Result<Feed> {
    let mut feed = Feed::new("search", "Поиск");
    let (kind, term) = if page.json && page.query.contains_key("query") {
        let kind = page.text("type");
        (
            if kind.is_empty() { "title" } else { kind },
            page.text("query"),
        )
    } else {
        (page.text("type"), page.text("term"))
    };
    let current = page.number("page");
    let start = (current - 1).saturating_mul(PAGE_SIZE);
    let end = start.saturating_add(PAGE_SIZE);
    let genre = page.text("genre");
    match kind {
        "title" => {
            let rows = catalogue.opds_search(term, genre, end.saturating_add(1))?;
            page.pages(&mut feed, "page", current, rows.len() > end);
            feed.entries = rows
                .into_iter()
                .skip(start)
                .take(PAGE_SIZE)
                .map(|row| entry(&Value::Object(row), true))
                .collect();
        }
        "" => {
            for (key, title) in [
                ("author", "Поиск авторов"),
                ("series", "Поиск серий"),
                ("title", "Поиск книг"),
            ] {
                feed.navigation
                    .push(page.nav(title, "/search", &[("type", key), ("term", term)]));
            }
            feed.navigation.push(page.nav(
                "Поиск книг в жанре",
                "/genre",
                &[("from", "search"), ("term", term)],
            ));
        }
        name => {
            if let Some(kind) = [AUTHOR, SERIES].into_iter().find(|kind| kind.key == name) {
                let Ok(query) = NameQuery::parse(term) else {
                    return Ok(feed);
                };
                let rows = catalogue.opds_names(kind.field, &query, genre, false)?;
                page.pages(&mut feed, "page", current, rows.len() > end);
                for name in rows.into_iter().skip(start).take(PAGE_SIZE) {
                    feed.navigation.push(page.nav(
                        entity_label(kind, name.label, false),
                        &format!("/{}", kind.key),
                        &[(kind.key, &name.query), ("genre", genre)],
                    ));
                }
            }
        }
    }
    Ok(feed)
}

fn entity(catalogue: &Catalogue, page: &Page<'_>, kind: Entity) -> Result<Feed> {
    let mut feed = Feed::new(kind.key, kind.title);
    let raw = page.text(kind.key);
    let genre = page.text("genre");
    let route = &format!("/{}", kind.key);
    let series = if kind.key == "author" {
        page.text("series")
    } else {
        ""
    };
    let all = !page.text("all").is_empty();
    if !series.is_empty() || raw.starts_with('=') {
        let key = if series.is_empty() {
            raw.to_owned()
        } else {
            format!("={series}")
        };
        let query = NameQuery::parse(&key)?;
        let field = if series.is_empty() {
            kind.field
        } else {
            Field::Series
        };
        let rows = catalogue.opds_entity(field, &query, if all { "" } else { genre })?;
        let mut books: Vec<_> = rows.into_iter().map(Value::Object).collect();
        let series_listing = kind.key == "series" || !series.is_empty();
        let initial = books.len();
        if !series.is_empty() && !all && !raw.is_empty() {
            let author = raw.trim_start_matches('=').to_lowercase();
            books.retain(|book| {
                authors(book)
                    .iter()
                    .any(|name| name.to_lowercase() == author)
            });
        }
        if series_listing
            && !all
            && (initial > books.len()
                || !genre.is_empty() && catalogue.opds_entity_count(field, &query)? > books.len())
        {
            let mut args = vec![(kind.key, raw), ("all", "1")];
            if !series.is_empty() {
                args.push(("series", series));
            }
            feed.navigation
                .push(page.nav("[Все книги серии]", route, &args));
        }
        books.sort_by(|a, b| {
            let order = if series_listing {
                number(a).total_cmp(&number(b))
            } else {
                std::cmp::Ordering::Equal
            };
            order
                .then_with(|| {
                    field_text(a, "title")
                        .to_lowercase()
                        .cmp(&field_text(b, "title").to_lowercase())
                })
                .then_with(|| field_text(a, "ext").cmp(field_text(b, "ext")))
        });
        let mut shown_series = HashSet::new();
        for book in &books {
            let collection = field_text(book, "series");
            if kind.key == "author" && series.is_empty() && !collection.is_empty() {
                if shown_series.insert(collection) {
                    feed.navigation.push(page.nav(
                        format!("Серия: {collection}"),
                        route,
                        &[("author", raw), ("series", collection), ("genre", genre)],
                    ));
                }
            } else {
                feed.entries
                    .push(entry(book, kind.key != "author" || !series.is_empty()));
            }
        }
        return Ok(feed);
    }
    if raw.is_empty() && genre.is_empty() {
        feed.navigation
            .push(page.nav("[Выбрать жанр]", "/genre", &[("from", kind.key)]));
    }
    let Ok(query) = NameQuery::parse(raw) else {
        return Ok(feed);
    };
    for name in catalogue.opds_names(kind.field, &query, genre, true)? {
        let label = if name.query == "___others" {
            kind.other.into()
        } else {
            entity_label(kind, name.label, name.grouped)
        };
        feed.navigation
            .push(page.nav(label, route, &[(kind.key, &name.query), ("genre", genre)]));
    }
    Ok(feed)
}

fn entity_label(kind: Entity, label: String, grouped: bool) -> String {
    if kind.key == "series" && !grouped {
        format!("Серия: {label}")
    } else {
        label
    }
}

fn number(row: &Value) -> f64 {
    row["serno"]
        .as_f64()
        .filter(|value| *value > 0.0)
        .unwrap_or(f64::MAX)
}

fn authors(row: &Value) -> Vec<String> {
    field_text(row, "author")
        .split([':', ','])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

fn field_text<'a>(row: &'a Value, field: &str) -> &'a str {
    row[field].as_str().unwrap_or_default()
}

fn entry(row: &Value, listing: bool) -> Entry {
    let title = field_text(row, "title");
    let title = if title.is_empty() {
        UNKNOWN_BOOK
    } else {
        title
    };
    let extension = field_text(row, "ext").to_ascii_lowercase();
    let series = field_text(row, "series");
    let position = row["serno"].as_f64().filter(|value| *value > 0.0);
    let title = if listing && !extension.is_empty() {
        let prefix = position.map_or_else(String::new, |value| format!("{value}. "));
        format!("{prefix}{title} ({extension})")
    } else {
        title.into()
    };
    let edition = (!extension.is_empty()
        && extension.bytes().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'-' | b'_')
        }))
    .then(|| Book {
        extension,
        series: series.into(),
        position,
    });
    let subjects = field_text(row, "genre")
        .split([':', ','])
        .filter(|code| !code.is_empty())
        .map(|code| genre_label(code).into())
        .collect();
    Entry {
        uid: field_text(row, "_uid").into(),
        title,
        authors: authors(row),
        language: field_text(row, "lang").into(),
        modified: row["date"].as_str().map(str::to_owned),
        description: None,
        subjects,
        links: Vec::new(),
        book: edition,
        progress: None,
    }
}

struct GenreGroup {
    name: &'static str,
    items: Vec<(&'static str, &'static str)>,
}

pub(crate) fn genre_label(code: &str) -> &str {
    genre_data()
        .iter()
        .flat_map(|group| &group.items)
        .find_map(|&(value, label)| (value == code).then_some(label))
        .unwrap_or(code)
}

fn genre_data() -> &'static [GenreGroup] {
    static DATA: OnceLock<Vec<GenreGroup>> = OnceLock::new();
    DATA.get_or_init(|| {
        let mut sections: Vec<GenreGroup> = Vec::new();
        let mut by_id = HashMap::new();
        let mut other = GenreGroup {
            name: "Прочее",
            items: Vec::new(),
        };
        let mut codes = HashSet::new();
        let mut extra = false;
        for row in include_str!("../../../../server/core/genres/genresText.js")
            .lines()
            .map(str::trim)
        {
            if row.starts_with("#nonfb2") {
                extra = true;
            }
            let Some((id, text)) = row.split_once(' ') else {
                continue;
            };
            let Some((head, tail)) = id.split_once('.') else {
                continue;
            };
            if head != "0" || tail == "0" {
                continue;
            }
            let Some((key, label)) = text.split_once(';') else {
                if !extra && !tail.contains('.') && tail != "20" {
                    by_id.insert(tail, sections.len());
                    sections.push(GenreGroup {
                        name: text,
                        items: Vec::new(),
                    });
                }
                continue;
            };
            let code = key.trim();
            if !codes.insert(code) {
                continue;
            }
            let label = label.trim();
            let number = tail.split('.').next().unwrap_or_default();
            if extra || number == "20" {
                other.items.push((code, label));
            } else if let Some(&index) = by_id.get(number) {
                sections[index].items.push((code, label));
            }
        }
        sections.push(other);
        sections
    })
}

type GenreSection<'a> = (&'static str, Vec<(&'a str, &'a str)>);

fn catalogue_genres(codes: &[String]) -> Vec<GenreSection<'_>> {
    let mut remaining: HashSet<_> = codes.iter().map(String::as_str).collect();
    let mut groups = Vec::new();
    for group in genre_data() {
        let items: Vec<_> = group
            .items
            .iter()
            .copied()
            .filter(|(code, _)| remaining.remove(code))
            .collect();
        groups.push((group.name, items));
    }
    if let Some((_, items)) = groups.last_mut() {
        let mut unknown: Vec<_> = remaining.into_iter().map(|code| (code, code)).collect();
        unknown.sort_unstable();
        items.extend(unknown);
    }
    groups.retain(|(_, items)| !items.is_empty());
    groups
}

pub(crate) fn genre_tree(catalogue: &Catalogue) -> Result<Value> {
    let codes = catalogue.opds_genres()?;
    let (langs, exts) = catalogue.browser_facets()?;
    let tree: Vec<_> = catalogue_genres(&codes)
        .into_iter()
        .map(|(name, items)| {
            let values: Vec<_> = items
                .into_iter()
                .map(|(code, name)| json!({"value":code,"name":name}))
                .collect();
            json!({"name":name,"value":values})
        })
        .collect();
    Ok(json!({"genreTree":tree,"langList":langs,"extList":exts,"inpxHash":catalogue.inpx_hash}))
}

fn genres(catalogue: &Catalogue, page: &Page<'_>) -> Result<Feed> {
    let mut feed = Feed::new("genre", "Жанры");
    let codes = catalogue.opds_genres()?;
    let term = page.text("term");
    let from = match page.text("from") {
        key @ ("author" | "series" | "title") => key,
        _ => "search",
    };
    let section = page.text("section");
    for (title, items) in catalogue_genres(&codes) {
        if section.is_empty() {
            feed.navigation.push(page.nav(
                title,
                "/genre",
                &[("from", from), ("section", title), ("term", term)],
            ));
        } else if section == title {
            let all = items
                .iter()
                .map(|(code, _)| *code)
                .collect::<Vec<_>>()
                .join(",");
            let route = &format!("/{from}");
            let kind = if from == "search" { "title" } else { "" };
            for (code, name) in std::iter::once((all.as_str(), "[Весь раздел]")).chain(items)
            {
                feed.navigation.push(page.nav(
                    name,
                    route,
                    &[("genre", code), ("type", kind), ("term", term)],
                ));
            }
        }
    }
    Ok(feed)
}

fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
}

fn xml_link(link: Link) -> Value {
    let mut attributes = json!({"href":xml_text(&link.href)});
    for (key, value) in [
        ("rel", link.rel),
        ("type", link.mime),
        ("title", link.title),
    ] {
        if let Some(value) = value {
            attributes[key] = Value::String(xml_text(&value));
        }
    }
    json!({"*ATTRS":attributes})
}

fn render_atom(
    feed: Feed,
    context: Context,
    updated: Option<String>,
    tolino: bool,
) -> Result<Option<Vec<u8>>> {
    let updated = updated.as_deref().unwrap_or("1970-01-01T00:00:00Z");
    let mut entries: Vec<_> = feed.navigation.into_iter().map(|link| {
        json!({"id":xml_text(&link.href),"title":xml_text(link.title.as_deref().unwrap_or_default()),
            "updated":updated,"link":xml_link(link)})
    }).collect();
    for book in feed.entries {
        let authors: Vec<_> = book.authors.iter().map(|name| {
            json!({"name":xml_text(name),"uri":xml_text(&context.catalog("/author", Some(("author", &format!("={name}")))))})
        }).collect();
        let mut links = vec![Link::new(
            context.catalog("/book", Some(("uid", &book.uid))),
            "subsection",
            ACQ_FEED,
        )];
        if let Some(edition) = book.book {
            links.extend(acquisition(
                &context,
                &urls::component(&book.uid),
                &edition.extension,
            ));
            if !edition.series.is_empty() {
                links.push(Link::new(
                    context.catalog("/series", Some(("series", &format!("={}", edition.series)))),
                    "collection",
                    NAV,
                ));
            }
        }
        let subjects: Vec<_> = book
            .subjects
            .iter()
            .map(|name| json!({"*ATTRS":{"label":xml_text(name),"term":xml_text(name)}}))
            .collect();
        let mut item = json!({"id":xml_text(&book.uid),"title":xml_text(&book.title),"author":authors,
            "updated":updated,"category":subjects,"link":links.into_iter().map(xml_link).collect::<Vec<_>>()});
        if !book.language.is_empty() {
            item["dc:language"] = json!(xml_text(&book.language));
        }
        if let Some(description) = book.description {
            item["content"] = json!({"*ATTRS":{"type":"text"},"*TEXT":xml_text(&description.body)});
        }
        entries.push(item);
    }
    let model = serde_json::to_vec(
        &json!({"root":context.root,"scope":context.scope,"tolino":tolino,"document":{"feed":{
            "*ATTRS":{"xmlns":"http://www.w3.org/2005/Atom","xmlns:dc":"http://purl.org/dc/terms/","xmlns:opds":"http://opds-spec.org/2010/catalog"},
            "id":feed.id,"title":xml_text(&feed.title),"updated":updated,"entry":entries,
            "link":feed.links.into_iter().map(xml_link).collect::<Vec<_>>(),
        }}}),
    )?;
    Ok(atom::render(&model))
}
