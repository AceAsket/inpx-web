mod atom;
mod html;
pub(crate) mod response;
mod urls;
mod xml;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const FEED: &str = "application/opds+json";
const PUBLICATION: &str = "application/opds-publication+json";
const ACQUISITION: &str = "http://opds-spec.org/acquisition";
const IMAGE: &str = "http://opds-spec.org/image";
const PAGE_SIZE: usize = 100;
const FORMATS: [&str; 8] = [
    "fb2", "epub", "epub3", "kepub", "kfx", "azw8", "pdf", "mobi",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    #[serde(flatten)]
    context: Context,
    is_book: bool,
    title: String,
    modified: Option<String>,
    links: Vec<Link>,
    navigation: Vec<Link>,
    publications: Vec<Entry>,
    total: usize,
    page: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    root: String,
    static_root: String,
    book_path: String,
    href: String,
    scope: String,
    template_scoped: bool,
    conversion: bool,
    formats: Option<Vec<String>>,
    mobi: bool,
    preference: String,
}

#[derive(Deserialize)]
struct Entry {
    uid: String,
    title: String,
    authors: Vec<String>,
    language: String,
    modified: Option<String>,
    description: Option<Description>,
    subjects: Vec<String>,
    links: Vec<Link>,
    book: Option<Book>,
    progress: Option<Progress>,
}

#[derive(Deserialize)]
struct Progress {
    percent: Option<f64>,
    relinked: bool,
}

#[derive(Deserialize)]
struct Description {
    body: String,
    html: bool,
}

#[derive(Deserialize)]
struct Book {
    extension: String,
    series: String,
    position: Option<f64>,
}

#[derive(Deserialize, Serialize)]
struct Link {
    href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    rel: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    templated: bool,
    #[serde(skip_serializing)]
    progress: Option<Progress>,
}

impl Link {
    fn new(href: String, rel: &str, mime: &str) -> Self {
        Self {
            href,
            rel: (!rel.is_empty()).then(|| rel.into()),
            mime: (!mime.is_empty()).then(|| mime.into()),
            title: None,
            templated: false,
            progress: None,
        }
    }

    fn is_image(&self) -> bool {
        self.rel
            .as_deref()
            .is_some_and(|rel| rel.starts_with(IMAGE))
    }
}

#[derive(Serialize)]
struct Feed {
    metadata: FeedMetadata,
    links: Vec<Link>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    publications: Vec<Publication>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    navigation: Vec<Link>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedMetadata {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    number_of_items: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    items_per_page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_page: Option<usize>,
}

#[derive(Serialize)]
struct Publication {
    metadata: PublicationMetadata,
    links: Vec<Link>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<Link>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationMetadata {
    title: String,
    identifier: String,
    #[serde(rename = "@type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    author: Vec<Contributor>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    language: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    subject: Vec<Subject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    belongs_to: Option<Collection>,
}

#[derive(Serialize)]
struct Contributor {
    name: String,
    links: [Link; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<f64>,
}

#[derive(Serialize)]
struct Collection {
    series: [Contributor; 1],
}

#[derive(Serialize)]
struct Subject {
    name: String,
}

impl Context {
    fn prepare(&mut self) {
        let formats = self
            .formats
            .get_or_insert_with(|| FORMATS.iter().map(|format| (*format).into()).collect());
        for format in formats.iter_mut() {
            *format = format.to_lowercase();
        }
        formats.retain(|format| {
            self.conversion && FORMATS.contains(&format.as_str()) && (format != "mobi" || self.mobi)
        });
        self.preference = trim_spaces(&self.preference).to_lowercase();
    }

    fn catalog(&self, path: &str, parameter: Option<(&str, &str)>) -> String {
        urls::scoped(&format!("{}{path}", self.root), &self.scope, parameter)
    }

    fn contributor(&self, field: &str, name: String, position: Option<f64>) -> Contributor {
        let href = self.catalog(&format!("/{field}"), Some((field, &format!("={name}"))));
        Contributor {
            name,
            links: [Link::new(href, "", FEED)],
            position,
        }
    }

    fn normalize_link(&self, mut link: Link) -> Link {
        if self.template_scoped
            && let Some(href) = urls::scope_catalog_link(&link.href, &self.root, &self.scope)
        {
            link.href = href;
        }
        if let Some(title) = link.title.take() {
            link.title = Some(progress_title(title, link.progress.as_ref()));
        }
        if link
            .mime
            .as_deref()
            .is_some_and(|kind| kind.starts_with("application/atom+xml"))
        {
            let target = link.href.split('?').next().unwrap_or_default();
            link.mime = Some(
                if target.strip_prefix(&self.root) == Some("/book") {
                    PUBLICATION
                } else {
                    FEED
                }
                .into(),
            );
        }
        link
    }
}

pub(crate) fn render(model: Model) -> Option<Vec<u8>> {
    let Model {
        mut context,
        is_book,
        title,
        modified,
        links,
        navigation,
        publications,
        total,
        page,
    } = model;
    context.prepare();
    if is_book {
        return serde_json::to_vec(&publication(publications.into_iter().next()?, &context)).ok();
    }
    if page == 0
        || page > total.div_ceil(PAGE_SIZE).max(1)
        || publications.len() != total.saturating_sub((page - 1) * PAGE_SIZE).min(PAGE_SIZE)
    {
        return None;
    }
    let mut links: Vec<_> = links
        .into_iter()
        .map(|link| context.normalize_link(link))
        .filter(|link| link.mime.as_deref() != Some("application/opensearchdescription+xml"))
        .collect();
    if let Some(search) = links
        .iter_mut()
        .find(|link| link.rel.as_deref() == Some("search"))
    {
        search.href = context.catalog("/search", None);
        search.href.push_str(if context.template_scoped {
            "{&query}"
        } else {
            "{?query}"
        });
        search.mime = Some(FEED.into());
        search.templated = true;
    }
    let mut items = Vec::with_capacity(navigation.len());
    for link in navigation {
        let link = context.normalize_link(link);
        if matches!(
            link.rel.as_deref(),
            Some("next" | "previous" | "first" | "last")
        ) {
            if !links
                .iter()
                .any(|other| other.rel == link.rel && other.href == link.href)
            {
                links.push(link);
            }
        } else {
            items.push(link);
        }
    }
    let paginated = total > PAGE_SIZE || page > 1;
    let empty = publications.is_empty() && items.is_empty();
    if paginated {
        for (enabled, other, rel) in [
            (page > 1, page - 1, "previous"),
            (page < total.div_ceil(PAGE_SIZE), page + 1, "next"),
        ] {
            if enabled {
                let href = urls::scoped(
                    &context.href,
                    &context.scope,
                    Some(("v2page", &other.to_string())),
                );
                links.push(Link::new(href, rel, FEED));
            }
        }
    }
    if empty {
        let mut link = Link::new(context.catalog("", None), "start", FEED);
        link.title = Some("В каталог".into());
        items.push(link);
    }
    serde_json::to_vec(&Feed {
        metadata: FeedMetadata {
            title,
            modified,
            number_of_items: (paginated || empty).then_some(total),
            items_per_page: paginated.then_some(PAGE_SIZE),
            current_page: paginated.then_some(page),
        },
        links,
        publications: publications
            .into_iter()
            .map(|entry| publication(entry, &context))
            .collect(),
        navigation: items,
    })
    .ok()
}

fn publication(entry: Entry, context: &Context) -> Publication {
    let language = entry
        .language
        .split(',')
        .map(trim_spaces)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    let description = entry.description.map_or_else(String::new, |desc| {
        if desc.html {
            html::sanitize(&desc.body)
        } else {
            html::escape(&desc.body)
        }
    });
    let mut used = HashSet::new();
    let subject = entry
        .subjects
        .iter()
        .filter(|name| used.insert(name.as_str()))
        .map(|name| Subject { name: name.clone() })
        .collect();
    let author = entry
        .authors
        .into_iter()
        .filter(|name| !name.is_empty())
        .map(|name| context.contributor("author", name, None))
        .collect();
    let uid = urls::component(&entry.uid);
    let mut links = Vec::with_capacity(entry.links.len() + 2);
    let mut images = Vec::new();
    for value in entry.links {
        let value = context.normalize_link(value);
        if value.is_image() {
            let Link { href, mime, .. } = value;
            images.push(Link {
                href,
                mime,
                rel: None,
                title: None,
                templated: false,
                progress: None,
            });
        } else {
            links.push(value);
        }
    }
    let belongs_to = entry.book.and_then(|book| {
        for link in acquisition(context, &uid, &book.extension) {
            if !links
                .iter()
                .any(|item| item.href == link.href && item.mime == link.mime)
            {
                links.push(link);
            }
        }
        if images.is_empty() {
            images.push(Link::new(
                format!("{}/cover/by-uid?uid={uid}", context.static_root),
                "",
                "image/jpeg",
            ));
        }
        (!book.series.is_empty()).then(|| Collection {
            series: [context.contributor(
                "series",
                book.series,
                book.position
                    .filter(|value| *value > 0.0 && value.is_finite()),
            )],
        })
    });
    let self_href = context.catalog("/book", Some(("uid", &entry.uid)));
    if let Some(link) = links.iter_mut().find(|value| {
        value.mime.as_deref() == Some(PUBLICATION) && urls::same_link(&value.href, &self_href)
    }) {
        link.href = self_href;
        link.rel = Some("self".into());
    } else if !entry.uid.is_empty() {
        links.insert(0, Link::new(self_href, "self", PUBLICATION));
    }
    unique(&mut links);
    unique(&mut images);
    Publication {
        metadata: PublicationMetadata {
            title: progress_title(entry.title, entry.progress.as_ref()),
            identifier: format!("urn:inpx:book:{uid}"),
            kind: "http://schema.org/Book",
            author,
            language,
            modified: entry.modified,
            description,
            subject,
            belongs_to,
        },
        links,
        images,
    }
}

fn unique(links: &mut Vec<Link>) {
    // Lists are small, and the first title wins when the same link appears twice.
    let mut index = 0;
    while index < links.len() {
        let link = &links[index];
        if links[..index].iter().any(|other| {
            other.href == link.href && other.mime == link.mime && other.rel == link.rel
        }) {
            links.remove(index);
        } else {
            index += 1;
        }
    }
}

fn acquisition(context: &Context, uid: &str, extension: &str) -> Vec<Link> {
    let preferred = &context.preference;
    let mut offered = vec![extension];
    if matches!(extension, "fb2" | "epub") {
        for format in context.formats.iter().flatten().map(String::as_str) {
            if !offered.contains(&format) {
                offered.push(format);
            }
        }
    }
    if let Some(index) = offered.iter().position(|format| format == preferred) {
        offered[..=index].rotate_right(1);
    }
    let base = format!("{}/by-uid?uid={uid}", context.book_path);
    let mut links = Vec::new();
    for format in offered {
        let title = format.to_uppercase()
            + if format == extension {
                " (исходный)"
            } else if format == preferred {
                " — предпочитаемый"
            } else {
                ""
            };
        let href = format!(
            "{base}&format={}",
            if format == extension { "raw" } else { format }
        );
        let mime = media_type(format);
        for kind in std::iter::once(mime.as_str())
            .chain((format == "fb2").then_some("application/x-fictionbook+xml"))
        {
            let mut link = Link::new(href.clone(), ACQUISITION, kind);
            link.title = Some(title.clone());
            links.push(link);
        }
    }
    if !matches!(extension, "fb2" | "epub" | "mobi") {
        let mut link = Link::new(format!("{base}&zip=1"), ACQUISITION, "application/zip");
        link.title = Some(format!("ZIP ({})", extension.to_uppercase()));
        links.push(link);
    }
    links
}

fn media_type(format: &str) -> String {
    match format {
        "fb2" => "application/fb2+xml",
        "epub" | "epub3" | "kepub" => "application/epub+zip",
        "mobi" => "application/x-mobipocket-ebook",
        "pdf" => "application/pdf",
        "kfx" | "azw8" => "application/vnd.amazon.ebook",
        ext if !ext.is_empty()
            && ext.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            }) =>
        {
            return format!("application/{ext}");
        }
        _ => "application/octet-stream",
    }
    .into()
}

fn trim_spaces(value: &str) -> &str {
    value.trim_matches(js_space)
}

fn js_space(ch: char) -> bool {
    ch.is_whitespace() && ch != '\u{85}' || ch == '\u{feff}'
}

fn progress_title(title: String, progress: Option<&Progress>) -> String {
    let Some(progress) = progress.filter(|value| !value.relinked) else {
        return title;
    };
    let read = title
        .strip_prefix('✓')
        .filter(|value| value.starts_with(js_space));
    let percent = progress
        .percent
        .filter(|value| value.is_finite())
        .unwrap_or(0.0);
    let icon = if read.is_some() || percent >= 0.999 {
        "⬤"
    } else if percent <= 0.0 {
        return title;
    } else if percent <= 0.25 {
        "◔"
    } else if percent <= 0.5 {
        "◑"
    } else {
        "◕"
    };
    format!(
        "{icon} {}",
        read.map_or(title.as_str(), |name| name.trim_start_matches(js_space))
    )
}
