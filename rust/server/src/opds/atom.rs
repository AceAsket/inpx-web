use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;

use super::xml::{self, Fields, Value};
use super::{ACQUISITION, Progress, progress_title, urls};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Atom<'a> {
    #[serde(borrow)]
    document: Fields<'a>,
    scope: String,
    root: String,
    tolino: bool,
    progress: Option<ReadingProgress>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingProgress {
    marks: HashMap<String, Progress>,
    show_unavailable: bool,
}

pub(super) fn render(input: &[u8]) -> Option<Vec<u8>> {
    let mut model: Atom<'_> = serde_json::from_slice(input).ok()?;
    let feed = model.document.get_mut("feed")?.object_mut()?;
    if let Some(links) = feed.get_mut("link") {
        scope_links(links, &model.root, &model.scope);
    }
    if let Some(entries) = feed.get_mut("entry") {
        for entry in entries
            .repeated_mut()
            .iter_mut()
            .filter_map(Value::object_mut)
        {
            if let Some(links) = entry.get_mut("link") {
                scope_links(links, &model.root, &model.scope);
                if model.tolino {
                    add_tolino_link(links);
                }
            }
            if let Some(progress) = &model.progress {
                apply_progress(entry, progress);
            }
        }
    }
    xml::document(&model.document, input.len())
}

fn attributes<'b, 'a>(link: &'b Value<'a>) -> Option<&'b Fields<'a>> {
    link.object()?.get("*ATTRS")?.object()
}

fn scope_links(links: &mut Value<'_>, root: &str, scope: &str) {
    if scope.is_empty() {
        return;
    }
    for link in links.repeated_mut() {
        if let Some(Value::Text(href)) = link
            .object_mut()
            .and_then(|link| link.get_mut("*ATTRS"))
            .and_then(Value::object_mut)
            .and_then(|attrs| attrs.get_mut("href"))
        {
            let decoded = html_escape::decode_html_entities(href);
            if let Some(scoped) = urls::scope_catalog_link(&decoded, root, scope) {
                *href = Cow::Owned(scoped);
            }
        }
    }
}

fn add_tolino_link(links: &mut Value<'_>) {
    let mut all = links.repeated().iter().filter_map(attributes);
    let navigation = all
        .clone()
        .find(|attributes| attributes.text("rel") == Some("subsection"));
    if let Some(attributes) = navigation
        && all.all(|attrs| attrs.text("rel").is_some_and(|rel| !rel.is_empty()))
    {
        let mut duplicate = attributes.clone();
        duplicate.0.retain(|(name, _)| *name != "rel");
        links.append(Value::Object(Fields(vec![(
            "*ATTRS",
            Value::Object(duplicate),
        )])));
    }
}

fn apply_progress(entry: &mut Fields<'_>, progress: &ReadingProgress) {
    let acquisition = entry.get("link").is_some_and(|links| {
        links.repeated().iter().filter_map(attributes).any(|link| {
            link.text("rel")
                .is_some_and(|rel| rel.starts_with(ACQUISITION))
                || link
                    .text("type")
                    .is_some_and(|kind| kind.contains("kind=acquisition"))
        })
    });
    let unavailable = progress.show_unavailable
        && entry
            .get("content")
            .and_then(attributes)
            .is_some_and(|attrs| attrs.text("type") == Some("text"));
    if !acquisition && !unavailable {
        return;
    }
    let row = progress.marks.get(entry.text("id").unwrap_or_default());
    const UNREAD: Progress = Progress {
        percent: None,
        relinked: false,
    };
    let row = row.unwrap_or(&UNREAD);
    if let Some(Value::Text(title)) = entry.get_mut("title") {
        if row.relinked || row.percent.unwrap_or(0.0) <= 0.0 && !title.starts_with('✓') {
            return;
        }
        let name = std::mem::take(title).into_owned();
        *title = Cow::Owned(progress_title(name, Some(row)));
    }
}

#[derive(Deserialize)]
struct OpenSearch {
    root: String,
    scope: String,
}

pub(super) fn opensearch(input: &[u8]) -> Option<Vec<u8>> {
    let model: OpenSearch = serde_json::from_slice(input).ok()?;
    let mut output = String::from(concat!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n",
        "<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n",
        "  <ShortName>inpx-web</ShortName>\n",
        "  <Description>Поиск по каталогу</Description>\n",
        "  <InputEncoding>UTF-8</InputEncoding>\n",
        "  <OutputEncoding>UTF-8</OutputEncoding>\n",
    ));
    let scope = (!model.scope.is_empty()).then(|| urls::component(&model.scope));
    for kind in ["title", "author", "series"] {
        output.push_str(
            "  <Url type=\"application/atom+xml;profile=opds-catalog;kind=navigation\" template=\"",
        );
        xml::escape(&mut output, &model.root, true);
        output.push_str("/search?type=");
        output.push_str(kind);
        output.push_str("&amp;term={searchTerms}");
        if let Some(scope) = &scope {
            output.push_str("&amp;user=");
            for part in scope.split_inclusive('\'') {
                if let Some(text) = part.strip_suffix('\'') {
                    output.push_str(text);
                    output.push_str("&#39;");
                } else {
                    output.push_str(part);
                }
            }
        }
        output.push_str("\"/>\n");
    }
    output.push_str("</OpenSearchDescription>\n");
    Some(output.into_bytes())
}
