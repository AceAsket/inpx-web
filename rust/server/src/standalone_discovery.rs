use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use inpx_catalog::Result;
use inpx_catalog::service_cache::{CacheRequest, CacheResponse, ServiceCache};
use inpx_catalog::standalone_catalogue::Catalogue;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::Url;

const MAX_PAGE: u64 = 10 * 1024 * 1024;
const STALE_GRACE: i64 = 86_400_000;

pub(super) struct ExternalDiscovery {
    path: PathBuf,
    storage: Mutex<Option<ServiceCache>>,
    fetch_slot: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Feed {
    fetched: i64,
    items: Vec<Item>,
}

#[derive(Default, Serialize, Deserialize)]
struct Item {
    title: String,
    author: String,
    url: String,
    cover: String,
    rating: f64,
    genre: bool,
    best: bool,
    new: bool,
}

pub(super) struct ExternalOptions {
    title: String,
    base: String,
    source: String,
    genre: String,
    feed_limit: usize,
    limit: usize,
    ttl: i64,
    refresh: bool,
}

impl ExternalOptions {
    pub(super) fn new(config: &Value, request: &Value) -> Option<Self> {
        if config["externalSource"] == "none" {
            return None;
        }
        let base = text(config, "externalUrl").to_owned();
        let browse = address(&base, None).and_then(|base| {
            address(text(request, "externalBrowseUrl"), Some(&base))
                .filter(|target| target.origin() == base.origin())
        });
        let source = browse
            .as_ref()
            .map_or_else(|| base.clone(), ToString::to_string);
        let title = text(config, "externalName");
        let feed_limit = config["externalLimit"].as_u64().unwrap_or(8) as usize;
        Some(Self {
            title: if title.is_empty() {
                "Внешний источник".into()
            } else {
                title.into()
            },
            base,
            source,
            genre: if browse.is_some() {
                text(request, "externalBrowseName").into()
            } else {
                String::new()
            },
            feed_limit,
            limit: limit(&request["externalLimit"], feed_limit, 120),
            ttl: config["externalTtlMinutes"].as_i64().unwrap_or(1440) * 60_000,
            refresh: request["forceRefresh"] == true,
        })
    }

    pub(super) fn error_shelf(&self, error: &dyn std::fmt::Display) -> Value {
        json!({"id":"external-error","title":self.title,"source":"external","sourceName":self.title,
            "sourceUrl":self.base,"items":[],"subtitle":"Внешний источник временно недоступен",
            "emptyMessage":format!("Не удалось обновить внешний источник \"{}\": {error}",self.title)})
    }
}

impl ExternalDiscovery {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            path: data.join("discovery-feeds.redb"),
            storage: Mutex::default(),
            fetch_slot: Mutex::default(),
        }
    }

    fn cache(&self, request: CacheRequest) -> Option<CacheResponse> {
        let mut storage = self.storage.lock().ok()?;
        if storage.is_none() {
            *storage = Some(ServiceCache::open(&self.path).ok()?);
        }
        storage.as_ref()?.query(request).ok()
    }

    fn cached(&self, key: &str) -> Option<Feed> {
        match self.cache(CacheRequest::Get { key: key.into() })? {
            CacheResponse::Value(Some(body)) => serde_json::from_str(body.get()).ok(),
            _ => None,
        }
    }

    pub(super) fn feed(&self, options: &ExternalOptions) -> Result<(Feed, Option<String>)> {
        let key = format!("v1:{}", options.source);
        let now = inpx_catalog::access_runtime::now_ms();
        let recent = |feed: &Feed, ttl| feed.fetched <= now && now - feed.fetched < ttl;
        let mut saved = self.cached(&key);
        if !options.refresh && saved.as_ref().is_some_and(|feed| recent(feed, options.ttl)) {
            return Ok((saved.take().expect("cached feed"), None));
        }
        let _fetch = self
            .fetch_slot
            .lock()
            .map_err(|_| "Кэш внешней витрины недоступен")?;
        if let Some(latest) = self.cached(&key)
            && saved
                .as_ref()
                .is_none_or(|before| latest.fetched > before.fetched)
            && recent(&latest, options.ttl)
        {
            return Ok((latest, None));
        }
        match fetch(&options.source) {
            Ok(items) => {
                let feed = Feed {
                    fetched: inpx_catalog::access_runtime::now_ms(),
                    items,
                };
                self.cache(CacheRequest::Put {
                    key,
                    value: serde_json::to_string(&feed)?,
                    max_count: 64,
                    max_bytes: 8 * 1024 * 1024,
                });
                Ok((feed, None))
            }
            Err(error)
                if saved
                    .as_ref()
                    .is_some_and(|feed| recent(feed, options.ttl + STALE_GRACE)) =>
            {
                Ok((saved.expect("cached feed"), Some(error.to_string())))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn build_shelf(
        &self,
        catalogue: &Catalogue,
        options: &ExternalOptions,
        feed: (Feed, Option<String>),
    ) -> Result<Value> {
        let (feed, error) = feed;
        let target = address(&options.source, None).ok_or("Недопустимый URL внешней витрины")?;
        let mut genres = Vec::new();
        let mut candidates = Vec::new();
        let mut genre_urls = HashSet::new();
        let mut has_more = false;
        for item in &feed.items {
            if item.genre {
                if let Some(url) = address(&item.url, None)
                    && url.origin() == target.origin()
                    && genre_urls.insert(&item.url)
                {
                    genres.push(json!({"label":item.title,"value":item.url}));
                }
                continue;
            }
            if candidates.len() == options.feed_limit {
                has_more = true;
                break;
            }
            candidates.push(item);
        }
        let mut used = HashSet::new();
        let mut items = Vec::new();
        let mut matched = 0;
        let mut missing = 0;
        for item in candidates {
            let (mut book, kind) = match local_match(catalogue, item)? {
                Some((book, kind)) => {
                    let uid = text(&book, "_uid").to_owned();
                    if !used.insert(uid) {
                        continue;
                    }
                    matched += 1;
                    (book, kind)
                }
                None => {
                    missing += 1;
                    let id = Sha256::digest(item.url.as_bytes())
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    (
                        json!({"_uid":format!("external:{id}"),"id":format!("external-{}",&id[..12]),
                        "title":item.title,"author":item.author,"series":"","ext":"web","del":false,"discoveryMissingLocal":true}),
                        "missing-local",
                    )
                }
            };
            book["discoveryUrl"] = item.url.clone().into();
            book["discoveryCoverUrl"] = item.cover.clone().into();
            book["discoveryRating"] = item.rating.into();
            book["discoveryMatchType"] = kind.into();
            book["discoveryItemKind"] = "book".into();
            book["discoveryFlags"] = json!({"bestseller":item.best,"isNew":item.new});
            let reason = match kind {
                "exact" => "Точное совпадение",
                "title-author" => "Совпали название и автор",
                "title" => "Совпало название",
                "title-partial" => "Похожее название",
                _ => "Нет в локальной библиотеке",
            };
            book["discoveryReason"] = format!("{} · {reason}", options.title).into();
            items.push(book);
            if items.len() >= options.limit {
                break;
            }
        }
        let prefix = if options.genre.is_empty() {
            String::new()
        } else {
            format!("Жанр: {} · ", options.genre)
        };
        let mut shelf = json!({
            "id":"external-source","title":options.title,"source":"external","sourceName":options.title,
            "sourceUrl":options.source,"updatedAt":feed.fetched,"discoveryStale":error.is_some(),
            "discoveryHasMore":has_more,"genreOptions":genres,"activeGenreName":options.genre,
            "activeGenreUrl":if options.base == options.source {""} else {&options.source},
            "subtitle":format!("{prefix}В библиотеке {matched} · вне библиотеки {missing}"),
            "items":items,"emptyMessage":"Во внешнем источнике пока ничего не найдено."
        });
        if let Some(error) = error {
            shelf["discoveryRefreshError"] = error.into();
        }
        Ok(shelf)
    }
}

fn address(value: &str, base: Option<&Url>) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut url = if let Some(base) = base {
        base.join(value).ok()?
    } else {
        Url::parse(value).ok()?
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

fn fetch(source: &str) -> Result<Vec<Item>> {
    let url = address(source, None).ok_or("Недопустимый URL внешней витрины")?;
    let origin = url.origin();
    let client = Client::builder().timeout(Duration::from_secs(20)).redirect(Policy::custom(move |next|{
        if next.previous().len() > 4 || next.url().origin() != origin
            || !next.url().username().is_empty() || next.url().password().is_some()
        {
            next.error("Переадресация внешней витрины на другой сайт запрещена")
        } else {next.follow()}
    })).user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36").build()?;
    let reply = client
        .get(url)
        .header("accept-language", "ru-RU,ru;q=0.9,en;q=0.7")
        .send()?
        .error_for_status()?;
    let url = reply.url().clone();
    let mut bytes = Vec::new();
    reply.take(MAX_PAGE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PAGE {
        return Err("Страница внешней витрины превышает 10 МиБ".into());
    }
    let rows = parse(&String::from_utf8_lossy(&bytes), &url);
    if rows.is_empty() {
        return Err("Не удалось прочитать внешнюю витрину".into());
    }
    Ok(rows)
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static HTML selector")
}

fn clean(value: &str) -> String {
    html_escape::decode_html_entities(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default().trim()
}

fn first<'a>(values: impl IntoIterator<Item = &'a str>) -> &'a str {
    values
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn url_string(base: &Url, value: &str) -> String {
    address(value, Some(base)).map_or_else(String::new, |url| url.to_string())
}

fn flags(url: &Url) -> (bool, bool) {
    let address = url.as_str().to_lowercase();
    (
        [
            "/popular/",
            "/bestseller/",
            "/bestsellers/",
            "best-seller",
            "best_seller",
            "popular",
        ]
        .iter()
        .any(|path| address.contains(path)),
        [
            "/showroom/new/",
            "/catalog/new/",
            "/novinki/",
            "/new/",
            "?new",
            "&new",
        ]
        .iter()
        .any(|path| address.contains(path)),
    )
}

fn new_item(base: &Url, title: &str, author: &str, url: &str, cover: &str) -> Item {
    let (best, new) = flags(base);
    Item {
        title: clean(title),
        author: clean(author),
        url: url_string(base, url),
        cover: url_string(base, cover),
        best,
        new,
        ..Default::default()
    }
}

fn unique(rows: Vec<Item>) -> Vec<Item> {
    let mut seen = HashSet::new();
    rows.into_iter()
        .filter(|row| {
            let key = (
                row.genre,
                normalized(&row.title),
                normalized(first([row.author.as_str(), row.url.as_str()])),
            );
            !row.title.is_empty() && !row.url.is_empty() && seen.insert(key)
        })
        .take(144)
        .collect()
}

fn parse(html: &str, base: &Url) -> Vec<Item> {
    let doc = Html::parse_document(html);
    let next = unique(next_data(&doc, base));
    if !next.is_empty() {
        return next;
    }
    let host = base.host_str().unwrap_or_default();
    let parsers: [fn(&Html, &Url) -> Vec<Item>; 4] = if host.ends_with("litres.ru") {
        [litres, product, mif, alpina]
    } else if host.ends_with("mann-ivanov-ferber.ru") {
        [mif, product, litres, alpina]
    } else if host.ends_with("alpinabook.ru") {
        [alpina, product, mif, litres]
    } else {
        [product, mif, litres, alpina]
    };
    parsers
        .into_iter()
        .map(|parse| unique(parse(&doc, base)))
        .find(|items| !items.is_empty())
        .unwrap_or_default()
}

fn descend<'a>(root: &'a Value, visit: &mut impl FnMut(&'a Value)) {
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        match node {
            Value::Array(rows) => pending.extend(rows.iter().rev()),
            Value::Object(fields) => {
                visit(node);
                pending.extend(fields.values().rev());
            }
            _ => (),
        }
    }
}

fn script(element: ElementRef<'_>) -> Option<Value> {
    serde_json::from_str(&element.text().collect::<String>()).ok()
}

fn next_data(doc: &Html, base: &Url) -> Vec<Item> {
    let Some(root) = doc
        .select(&selector("script#__NEXT_DATA__"))
        .next()
        .and_then(script)
    else {
        return Vec::new();
    };
    let initial = &root["props"]["pageProps"]["initialState"];
    let decoded = initial
        .as_str()
        .and_then(|value| serde_json::from_str(value).ok());
    let mut result = Vec::new();
    for row in decoded.as_ref().unwrap_or(initial)["rtkqApi"]["queries"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, value)| value)
    {
        descend(&row["data"], &mut |item| {
            if result.len() >= 432 {
                return;
            }
            let title = first([text(item, "title"), text(item, "name")]);
            let link = first([text(item, "url"), text(item, "link")]);
            let Some(url) = address(link, Some(base)) else {
                return;
            };
            let genre = url.path().contains("/genre/");
            if title.is_empty()
                || (url
                    .host_str()
                    .is_some_and(|host| host.ends_with("litres.ru"))
                    && !genre
                    && !url.path().contains("/book/"))
            {
                return;
            }
            let authors = |entries: &Value| {
                entries
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|author| {
                        author
                            .as_str()
                            .unwrap_or_else(|| text(author, "name"))
                            .to_owned()
                    })
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let mut author = authors(&item["authors"]);
            if author.is_empty() {
                author = authors(&item["persons"]);
            }
            let image = first([
                text(item, "cover_url"),
                text(&item["cover"], "large"),
                text(&item["cover"], "small"),
                text(&item["picture"], "large"),
                text(&item["picture"], "small"),
                text(&item["image"], "large"),
                text(&item["image"], "small"),
                text(item, "image"),
            ]);
            let mut row = new_item(base, title, &author, link, image);
            row.genre = genre;
            row.rating = item["rating"]["rated_avg"]
                .as_f64()
                .or_else(|| item["rating"].as_f64())
                .unwrap_or_default();
            row.best |= item["labels"]["is_bestseller"] == true
                || item["labels"]["is_sales_hit"] == true
                || item["specialTypes"]["best"] == true
                || item["specialTypes"]["bestseller"] == true;
            row.new |= item["labels"]["is_new"] == true
                || item["specialTypes"]["new"] == true
                || item["specialTypes"]["soon"] == true;
            result.push(row);
        });
    }
    result
}

fn product(doc: &Html, base: &Url) -> Vec<Item> {
    let mut result = Vec::new();
    for node in doc
        .select(&selector("script[type='application/ld+json']"))
        .filter_map(script)
    {
        descend(&node, &mut |row| {
            if result.len() >= 432 || !matches!(text(row, "@type"), "Product" | "Book") {
                return;
            }
            let cover = row["image"]
                .as_array()
                .and_then(|rows| rows.first())
                .and_then(Value::as_str)
                .unwrap_or(text(row, "image"));
            result.push(new_item(
                base,
                first([text(row, "name"), text(&row["offers"], "name")]),
                first([text(&row["author"], "name"), text(row, "author")]),
                first([text(&row["offers"], "url"), text(row, "url")]),
                first([cover, text(&row["offers"], "image")]),
            ));
        });
    }
    result
}

fn displayed(element: ElementRef<'_>) -> String {
    clean(&element.text().collect::<Vec<_>>().join(" "))
}

fn cover<'a>(element: ElementRef<'a>, images: &Selector) -> &'a str {
    element
        .select(images)
        .find_map(|img| {
            ["data-original", "data-src", "src"]
                .into_iter()
                .filter_map(|attr| img.value().attr(attr))
                .next()
        })
        .unwrap_or_default()
}

fn litres(doc: &Html, base: &Url) -> Vec<Item> {
    let images = selector("img, source");
    let mut result: Vec<Item> = Vec::new();
    let mut covers = std::collections::HashMap::new();
    for node in doc.select(&selector(
        "a[href*='/book/'],a[href*='/author/'],a[href*='/genre/']",
    )) {
        let link = node.value().attr("href").unwrap_or_default();
        let title = displayed(node);
        let image = cover(node, &images);
        if link.contains("/author/") {
            if let Some(previous) = result.last_mut()
                && !previous.genre
                && previous.author.is_empty()
            {
                previous.author = title;
            }
        } else if !title.is_empty() {
            let mut row = new_item(
                base,
                &title,
                "",
                link,
                first([image, covers.get(link).copied().unwrap_or_default()]),
            );
            row.genre = link.contains("/genre/");
            result.push(row);
            if result.len() >= 432 {
                break;
            }
        } else if !image.is_empty() {
            covers.insert(link, image);
        }
    }
    result
}

fn mif(doc: &Html, base: &Url) -> Vec<Item> {
    let images = selector("img, source");
    let links = selector("a[href*='/catalog/product/']");
    let titles = selector(".lego-book__cover-loading-title p");
    doc.select(&selector(".lego-book"))
        .take(432)
        .filter_map(|node| {
            let link = node.select(&links).next()?.value().attr("href")?;
            let mut texts = node
                .select(&titles)
                .map(displayed)
                .filter(|text| !text.is_empty());
            let mut row = new_item(
                base,
                &texts.next()?,
                &texts.next().unwrap_or_default(),
                link,
                cover(node, &images),
            );
            row.new |= displayed(node).contains("Новинка");
            Some(row)
        })
        .collect()
}

fn alpina(doc: &Html, base: &Url) -> Vec<Item> {
    let images = selector("img, source");
    let links = selector("a[href*='/catalog/book-']");
    let authors = selector(".book-item-authors [itemprop='name']");
    doc.select(&selector("[data-book-name]"))
        .take(432)
        .filter_map(|node| {
            let link = node.select(&links).next()?.value().attr("href")?;
            let title = node.value().attr("data-book-name")?;
            let author = node
                .select(&authors)
                .map(displayed)
                .collect::<Vec<_>>()
                .join(", ");
            let mut row = new_item(base, title, &author, link, cover(node, &images));
            let description = displayed(node);
            row.new |= description.contains("Новинка");
            row.best |= description.contains("Бестселлер");
            Some(row)
        })
        .collect()
}

fn normalized(value: &str) -> String {
    value
        .to_lowercase()
        .replace('ё', "е")
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn limit(value: &Value, default: usize, maximum: i64) -> usize {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .filter(|&value| value != 0)
        .map_or(default, |value| value.clamp(1, maximum) as usize)
}

fn local_match(catalogue: &Catalogue, item: &Item) -> Result<Option<(Value, &'static str)>> {
    let title = normalized(&item.title);
    if title.is_empty() {
        return Ok(None);
    }
    let name = normalized(&item.author);
    let tokens: Vec<_> = name
        .split_whitespace()
        .filter(|part| part.chars().count() >= 2)
        .collect();
    let mut best = None;
    let mut score = 449;
    let prefix: String = item.title.chars().take(80).collect();
    for query in [format!("={}", item.title), format!("*{prefix}")] {
        let response = catalogue.browser_books(&Map::from_iter([
            ("title".into(), query.into()),
            ("del".into(), "0".into()),
            ("limit".into(), 32.into()),
        ]))?;
        for book in response["found"].as_array().into_iter().flatten() {
            let current = normalized(text(book, "title"));
            if current.is_empty() {
                continue;
            }
            let exact = current == title;
            let mut weight = if exact {
                1000
            } else if current.starts_with(&title) || title.starts_with(&current) {
                700
            } else if current.contains(&title) || title.contains(&current) {
                450
            } else {
                continue;
            };
            let author = normalized(text(book, "author"));
            let overlap = tokens
                .iter()
                .filter(|&&token| author.contains(token))
                .count() as i64;
            weight += 15
                + 90 * overlap
                + 12 * i64::from(book["ext"] == "fb2")
                + book["librate"].as_i64().unwrap_or_default();
            if overlap == 0 && !tokens.is_empty() {
                weight -= 180;
            }
            if weight > score {
                score = weight;
                let kind = match (exact, overlap > 0) {
                    (true, true) => "exact",
                    (false, true) => "title-author",
                    (true, false) => "title",
                    (false, false) => "title-partial",
                };
                best = Some((book.clone(), kind));
            }
        }
        if score >= 1000 {
            break;
        }
    }
    Ok(best)
}
