use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;

use crate::Result;
use crate::epub_fb2::{is_note, is_note_ref};
use crate::epub_fb2_images::image_key;
use crate::epub_fb2_input::{Child, Node, esc, fold_space, hash, ignored, reference};
use crate::fb2_prepare::js_space;

pub(crate) type Targets = HashMap<String, String>;

pub(crate) struct Note {
    pub node: Node,
    pub file: String,
}

pub(crate) struct Renderer<'a> {
    pub targets: &'a Targets,
    pub images: &'a HashMap<String, String>,
    pub notes: VecDeque<Note>,
}

pub(crate) fn node_id(file: &str, node: &Node) -> String {
    let key = node_anchor(node);
    let position = if key.is_empty() {
        node.index.to_string()
    } else {
        key.into()
    };
    format!("n_{}", hash(&format!("{file}\0{position}")))
}

pub(crate) fn node_anchor(node: &Node) -> &str {
    let primary = node.attr("id");
    if primary.is_empty() {
        node.attr("xml:id")
    } else {
        primary
    }
}

pub(crate) fn id(file: &str, node: &Node) -> String {
    if block(&node.name) || is_note(node) {
        format!(" id=\"{}\"", node_id(file, node))
    } else {
        String::new()
    }
}

pub(crate) fn block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "section"
            | "article"
            | "main"
            | "aside"
            | "header"
            | "footer"
            | "figure"
            | "figcaption"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "blockquote"
            | "pre"
            | "ul"
            | "ol"
            | "li"
            | "dl"
            | "dt"
            | "dd"
            | "table"
            | "hr"
    )
}

pub(crate) fn heading(name: &str) -> bool {
    matches!(name.as_bytes(), [b'h', b'1'..=b'6'])
}

pub(crate) fn image_href(node: &Node) -> &str {
    [node.attr("src"), node.attr("href"), node.attr("xlink:href")]
        .into_iter()
        .find(|attr| !attr.is_empty())
        .unwrap_or_default()
}

impl Renderer<'_> {
    pub(crate) fn lines(
        &self,
        children: impl IntoIterator<Item = impl std::borrow::Borrow<Child>>,
        file: &str,
        in_link: bool,
    ) -> Result<Vec<String>> {
        let mut lines = vec![String::new()];
        for child in children {
            let mut parts = self.inline(child.borrow(), file, in_link)?.into_iter();
            lines
                .last_mut()
                .expect("first line")
                .push_str(&parts.next().unwrap_or_default());
            lines.extend(parts);
        }
        Ok(lines)
    }

    fn inline(&self, child: &Child, file: &str, in_link: bool) -> Result<Vec<String>> {
        let node = match child {
            Child::Text(value) => return Ok(vec![esc(&fold_space(value))]),
            Child::Element(node) => node,
        };
        if ignored(&node.name) || is_note(node) {
            return Ok(vec![String::new()]);
        }
        match node.name.as_str() {
            "br" => return Ok(vec![String::new(), String::new()]),
            "image" | "img" => {
                let key = image_key(file, image_href(node))?;
                return Ok(vec![
                    key.as_ref()
                        .and_then(|key| self.images.get(key))
                        .map_or_else(
                            || esc(node.attr("alt")),
                            |image| format!("<image l:href=\"#{image}\"/>"),
                        ),
                ]);
            }
            _ => {}
        }
        let content = self.lines(&node.children, file, in_link || node.name == "a")?;
        let style = match node.name.as_str() {
            "b" | "strong" => "strong",
            "i" | "em" => "emphasis",
            "s" | "del" | "strike" => "strikethrough",
            "sup" => "sup",
            "sub" => "sub",
            "code" | "kbd" => "code",
            _ => "",
        };
        if !style.is_empty() {
            return Ok(content
                .into_iter()
                .map(|line| {
                    if line.is_empty() {
                        line
                    } else {
                        format!("<{style}>{line}</{style}>")
                    }
                })
                .collect());
        }
        if node.name == "a" && !in_link && !node.attr("href").is_empty() {
            let reference = reference(file, node.attr("href"))?;
            let destination = reference
                .file
                .as_ref()
                .and_then(|file| self.targets.get(&format!("{file}#{}", reference.fragment)));
            let href = destination.map(|target| format!("#{target}")).or_else(|| {
                let external = reference.external?;
                let lower = external.to_ascii_lowercase();
                ["http:", "https:", "mailto:"]
                    .iter()
                    .any(|scheme| lower.starts_with(scheme))
                    .then_some(external)
            });
            if let Some(href) = href {
                let kind = if destination.is_some() && is_note_ref(node) {
                    " type=\"note\""
                } else {
                    ""
                };
                let href = esc(&href);
                return Ok(content
                    .into_iter()
                    .map(|value| format!("<a l:href=\"{href}\"{kind}>{value}</a>"))
                    .collect());
            }
        }
        Ok(content)
    }

    pub(crate) fn flow(
        &mut self,
        output: &mut String,
        children: &[Child],
        file: &str,
        skip: Option<usize>,
    ) -> Result<()> {
        let start = output.len();
        self.render_flow(output, children, file, skip, false, false)?;
        if output.len() == start {
            output.push_str("<empty-line/>");
        }
        Ok(())
    }

    fn render_flow(
        &mut self,
        output: &mut String,
        children: &[Child],
        file: &str,
        skip: Option<usize>,
        in_quote: bool,
        blocks_only: bool,
    ) -> Result<()> {
        let mut pending = Vec::new();
        for child in children {
            if blocks_only && !is_block(child) {
                continue;
            }
            let Some(node) = child
                .element()
                .filter(|node| block(&node.name) || is_note(node))
            else {
                pending.push(child);
                continue;
            };
            self.flush(output, &mut pending, file)?;
            if ignored(&node.name) || skip == Some(node.index) {
                continue;
            }
            if is_note(node) {
                self.notes.push_back(Note {
                    node: node.clone(),
                    file: file.into(),
                });
                continue;
            }
            let identifier = id(file, node);
            if heading(&node.name) {
                paragraphs(
                    output,
                    self.lines(&node.children, file, false)?,
                    &identifier,
                    "subtitle",
                );
                continue;
            }
            match node.name.as_str() {
                "p" | "dt" | "dd" => paragraphs(
                    output,
                    self.lines(&node.children, file, false)?,
                    &identifier,
                    "p",
                ),
                "pre" => {
                    for (index, line) in node.text().split('\n').enumerate() {
                        let line = line.strip_suffix('\r').unwrap_or(line);
                        write!(
                            output,
                            "<p{}><code>{}</code></p>",
                            if index == 0 { identifier.as_str() } else { "" },
                            esc(line)
                        )?;
                    }
                }
                "hr" => write!(output, "<p{identifier}>⁂</p>")?,
                "ul" | "ol" => {
                    write!(output, "<p{identifier}/>")?;
                    let start = node
                        .attr("start")
                        .trim()
                        .parse::<f64>()
                        .ok()
                        .filter(|value| !value.is_nan() && *value != 0.0)
                        .unwrap_or(1.0)
                        .clamp(1.0, 1000000.0);
                    for (i, child) in node
                        .elements()
                        .filter(|child| child.name == "li")
                        .enumerate()
                    {
                        let prefix = if node.name == "ol" {
                            format!("{}. ", start + i as f64)
                        } else {
                            "• ".into()
                        };
                        let content = self
                            .lines(
                                child.children.iter().filter(|child| !is_block(child)),
                                file,
                                false,
                            )?
                            .join(" ");
                        write!(
                            output,
                            "<p{}>{}{content}</p>",
                            id(file, child),
                            esc(&prefix)
                        )?;
                        self.render_flow(output, &child.children, file, skip, in_quote, true)?;
                    }
                }
                "table" => self.table(node, file, &identifier, output)?,
                "blockquote" => {
                    if in_quote {
                        write!(output, "<p{identifier}/>")?;
                    } else {
                        write!(output, "<cite{identifier}>")?;
                    }
                    let start = output.len();
                    self.render_flow(output, &node.children, file, skip, true, false)?;
                    if output.len() == start {
                        output.push_str("<p/>");
                    }
                    if !in_quote {
                        output.push_str("</cite>");
                    }
                }
                _ => {
                    write!(output, "<p{identifier}/>")?;
                    self.render_flow(output, &node.children, file, skip, in_quote, false)?;
                }
            }
        }
        self.flush(output, &mut pending, file)
    }

    fn flush(&self, output: &mut String, pending: &mut Vec<&Child>, file: &str) -> Result<()> {
        if pending.iter().any(|node| match node {
            Child::Text(text) => !text.trim_matches(js_space).is_empty(),
            _ => true,
        }) {
            paragraphs(
                output,
                self.lines(pending.iter().copied(), file, false)?,
                "",
                "p",
            );
        }
        pending.clear();
        Ok(())
    }

    fn table(&self, node: &Node, file: &str, identifier: &str, output: &mut String) -> Result<()> {
        let mut rows = String::new();
        for row in node.all("tr") {
            let mut columns = String::new();
            for cell in row
                .elements()
                .filter(|cell| matches!(cell.name.as_str(), "td" | "th"))
            {
                write!(columns, "<{}", cell.name)?;
                for span in ["colspan", "rowspan"] {
                    let value = cell.attr(span);
                    if digits(value, 3)
                        && let Ok(number) = value.parse::<u16>()
                        && number > 0
                    {
                        write!(columns, " {span}=\"{number}\"")?;
                    }
                }
                write!(
                    columns,
                    ">{}</{}>",
                    self.lines(&cell.children, file, false)?.join(" "),
                    cell.name
                )?;
            }
            if !columns.is_empty() {
                write!(rows, "<tr>{columns}</tr>")?;
            }
        }
        if !rows.is_empty() {
            write!(output, "<table{identifier}>{rows}</table>")?;
        }
        Ok(())
    }
}

fn is_block(child: &Child) -> bool {
    child.element().is_some_and(|node| block(&node.name))
}

pub(crate) fn paragraphs(output: &mut String, lines: Vec<String>, identifier: &str, tag: &str) {
    for (index, line) in lines.into_iter().enumerate() {
        let identifier = if index == 0 { identifier } else { "" };
        write!(
            output,
            "<{tag}{identifier}>{}</{tag}>",
            line.trim_matches(js_space)
        )
        .expect("writing to a string");
    }
}

pub(crate) fn digits(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn book_description(
    metadata: &Node,
    package_path: &str,
    cover: Option<&str>,
) -> Result<String> {
    static BREAKS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<br\s*/?\s*>|</p\s*>").unwrap());
    static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
    static DATE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[0-9]{4}(?:-[0-9]{2})?(?:-[0-9]{2})?").unwrap());
    static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]{4}").unwrap());
    let values = |name: &str| {
        metadata
            .elements()
            .filter(|node| node.name == name)
            .map(Node::plain)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    };
    let first = |name: &str| values(name).into_iter().next().unwrap_or_default();
    let title = first("title");
    let title = if title.is_empty() {
        "Без названия"
    } else {
        &title
    };
    let authors = values("creator");
    let description_value = values("description").join("\n");
    let description = html_escape::decode_html_entities(&description_value);
    let description = BREAKS.replace_all(&description, "\n");
    let description = MARKUP.replace_all(&description, "");
    let description = description.trim_matches(js_space);
    let raw_date = first("date");
    let date = DATE
        .find(&raw_date)
        .map_or("2000-01-01", |value| value.as_str());
    let year = YEAR.find(&raw_date).map_or("", |value| value.as_str());
    let language = first("language");
    let language = if language.is_empty() {
        "und"
    } else {
        &language
    };
    let identifiers = values("identifier");
    let document_id = identifiers.first().cloned().unwrap_or_else(|| {
        format!(
            "urn:inpx:{}",
            hash(&format!("{package_path}\0{title}\0{}", authors.join(",")))
        )
    });
    let publisher = first("publisher");
    let isbn = crate::isbn::extract(&identifiers.join(" "))
        .into_iter()
        .next();
    let collection = metadata
        .elements()
        .find(|node| node.name == "meta" && node.attr("property") == "belongs-to-collection");
    let old_meta = |name: &str| {
        metadata
            .elements()
            .find(|node| node.name == "meta" && node.attr("name") == name)
            .map_or("", |node| node.attr("content"))
    };
    let series = collection
        .map(Node::plain)
        .unwrap_or_else(|| old_meta("calibre:series").into());
    let position = if let Some(collection) = collection {
        let target = format!("#{}", collection.attr("id"));
        metadata
            .elements()
            .find(|node| {
                node.name == "meta"
                    && node.attr("property") == "group-position"
                    && node.attr("refines") == target
            })
            .map_or(String::new(), Node::plain)
    } else {
        old_meta("calibre:series_index").into()
    };
    let mut output = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<FictionBook xmlns=\"http://www.gribuser.ru/xml/fictionbook/2.0\" xmlns:l=\"http://www.w3.org/1999/xlink\"><description><title-info><genre>other</genre>",
    );
    if authors.is_empty() {
        output.push_str("<author><nickname>Автор не указан</nickname></author>");
    } else {
        for author in authors {
            write!(
                output,
                "<author><nickname>{}</nickname></author>",
                esc(&author)
            )?;
        }
    }
    write!(output, "<book-title>{}</book-title>", esc(title))?;
    if !description.is_empty() {
        output.push_str("<annotation>");
        for line in description.split('\n').filter(|line| !line.is_empty()) {
            write!(output, "<p>{}</p>", esc(line))?;
        }
        output.push_str("</annotation>");
    }
    let keywords = values("subject");
    if !keywords.is_empty() {
        write!(output, "<keywords>{}</keywords>", esc(&keywords.join(", ")))?;
    }
    if let Some(cover) = cover {
        write!(
            output,
            "<coverpage><image l:href=\"#{cover}\"/></coverpage>"
        )?;
    }
    write!(output, "<lang>{}</lang>", esc(language))?;
    if !series.is_empty() {
        write!(output, "<sequence name=\"{}\"", esc(&series))?;
        if digits(&position, 6) {
            write!(output, " number=\"{}\"", position.parse::<u32>()?)?;
        }
        output.push_str("/>");
    }
    write!(
        output,
        "</title-info><document-info><author><nickname>INPX Web</nickname></author><program-used>INPX Web epub-fb2-v1</program-used><date>{date}</date><id>{}</id><version>1.0</version></document-info>",
        esc(&document_id)
    )?;
    if !publisher.is_empty() || !year.is_empty() || isbn.is_some() {
        write!(
            output,
            "<publish-info><book-name>{}</book-name>",
            esc(title)
        )?;
        if !publisher.is_empty() {
            write!(output, "<publisher>{}</publisher>", esc(&publisher))?;
        }
        if !year.is_empty() {
            write!(output, "<year>{year}</year>")?;
        }
        if let Some(isbn) = isbn {
            write!(output, "<isbn>{isbn}</isbn>")?;
        }
        output.push_str("</publish-info>");
    }
    output.push_str("</description><body>");
    Ok(output)
}
