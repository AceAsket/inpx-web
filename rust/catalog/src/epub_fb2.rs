use std::collections::{HashMap, HashSet};
use std::fmt::{self, Write as _};
use std::io::{Read, Seek, Write};
use std::sync::LazyLock;

use regex::Regex;

use crate::Result;
use crate::epub_fb2_images::{Images, check_svg};
use crate::epub_fb2_input::{MB, Node, Source, esc, hash, reference, words};
use crate::epub_fb2_render::{
    Renderer, Targets, block, book_description, heading, id, image_href, node_anchor, node_id,
    paragraphs,
};

pub(crate) const MAX_OUTPUT: u64 = 256 * MB;
const CHAPTER_LIMIT: u64 = 16 * MB;
const TREE_CACHE: usize = 32 * MB as usize;

#[derive(Debug)]
pub(crate) struct Invalid(String);

impl fmt::Display for Invalid {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "Не удалось преобразовать EPUB в FB2: {}", self.0)
    }
}

impl std::error::Error for Invalid {}

pub(crate) fn invalid(message: impl Into<String>) -> Box<dyn std::error::Error> {
    Box::new(Invalid(message.into()))
}

pub(crate) fn is_note(node: &Node) -> bool {
    static KIND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)(?:footnote|endnote)(?-u:\b)").unwrap());
    static ROLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)doc-(?:footnote|endnote)(?-u:\b)").unwrap());
    KIND.is_match(node.attr("epub:type")) || ROLE.is_match(node.attr("role"))
}

pub(crate) fn is_note_ref(node: &Node) -> bool {
    static KIND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)noteref(?-u:\b)").unwrap());
    KIND.is_match(node.attr("epub:type")) || node.attr("role") == "doc-noteref"
}

struct Item<'a> {
    file: Option<String>,
    media_type: &'a str,
    properties: &'a str,
    fallback: &'a str,
}

struct Package<'a> {
    items: Vec<Item<'a>>,
    ids: HashMap<&'a str, usize>,
    files: HashMap<String, usize>,
    encrypted: HashSet<String>,
}

impl<'a> Package<'a> {
    fn read(
        opf: &'a Node,
        package_path: &str,
        source: &mut Source<impl Read + Seek>,
    ) -> Result<Self> {
        let mut package = Self {
            items: Vec::new(),
            ids: HashMap::new(),
            files: HashMap::new(),
            encrypted: HashSet::new(),
        };
        for item in opf.all("manifest").into_iter().flat_map(Node::elements) {
            let id = item.attr("id");
            let index = package.items.len();
            if id.is_empty() || package.ids.insert(id, index).is_some() {
                return Err(invalid("неверный manifest OPF"));
            }
            let file = reference(package_path, item.attr("href"))?.file;
            if let Some(file) = &file {
                package.files.insert(file.clone(), index);
            }
            package.items.push(Item {
                file,
                media_type: item.attr("media-type"),
                properties: item.attr("properties"),
                fallback: item.attr("fallback"),
            });
        }
        if source.has("META-INF/encryption.xml") {
            let (encryption, _) = source.document("META-INF/encryption.xml", MB)?;
            for node in encryption.all("cipherreference") {
                if let Some(file) = reference("encryption.xml", node.attr("uri"))?.file {
                    package.encrypted.insert(file);
                }
            }
        }
        Ok(package)
    }

    fn media_type(&self, file: &str) -> &str {
        self.files
            .get(file)
            .map_or("", |&index| self.items[index].media_type)
    }

    fn cover(&self, metadata: &Node) -> Option<&str> {
        let legacy = metadata
            .elements()
            .find(|node| node.name == "meta" && node.attr("name") == "cover");
        self.items
            .iter()
            .find(|item| words(item.properties).any(|word| word == "cover-image"))
            .or_else(|| {
                self.ids
                    .get(legacy?.attr("content"))
                    .map(|&index| &self.items[index])
            })?
            .file
            .as_deref()
    }

    fn chapter(&self, mut index: usize) -> Result<Option<&str>> {
        let mut remaining = self.items.len();
        let item = loop {
            let item = &self.items[index];
            if is_chapter(item.media_type) {
                break item;
            }
            if remaining == 0 || item.fallback.is_empty() {
                return Err(invalid("неподдерживаемый документ в порядке чтения"));
            }
            remaining -= 1;
            index = *self
                .ids
                .get(item.fallback)
                .ok_or_else(|| invalid("не найден локальный документ главы"))?;
        };
        let file = item
            .file
            .as_deref()
            .ok_or_else(|| invalid("не найден локальный документ главы"))?;
        if self.encrypted.contains(file) {
            return Err(invalid("содержимое защищено шифрованием"));
        }
        Ok((!words(item.properties).any(|word| word == "nav")).then_some(file))
    }
}

fn is_chapter(media_type: &str) -> bool {
    matches!(media_type, "application/xhtml+xml" | "text/html")
}
fn chapter_id(file: &str) -> String {
    format!("c_{}", hash(file))
}

struct Chapter<'a> {
    file: &'a str,
    linear: bool,
    title: String,
    heading: Option<usize>,
    document: Option<Node>,
}

#[derive(Default)]
struct Chapters<'a> {
    queue: Vec<Chapter<'a>>,
    queued: HashSet<&'a str>,
    targets: Targets,
    labels: HashMap<String, String>,
}

impl<'a> Chapters<'a> {
    fn add(&mut self, package: &'a Package<'_>, index: usize, linear: bool) -> Result<()> {
        if let Some(file) = package.chapter(index)?
            && self.queued.insert(file)
        {
            if self.queue.len() >= 2000 {
                return Err(invalid("слишком много глав"));
            }
            self.queue.push(Chapter {
                file,
                linear,
                title: String::new(),
                heading: None,
                document: None,
            });
        }
        Ok(())
    }

    fn read(
        &mut self,
        opf: &Node,
        package: &'a Package<'_>,
        source: &mut Source<impl Read + Seek>,
        images: &mut Images,
    ) -> Result<()> {
        let spine = opf
            .all("spine")
            .into_iter()
            .next()
            .ok_or_else(|| invalid("не найден порядок чтения spine"))?;
        for item in spine.elements().filter(|node| node.name == "itemref") {
            let index = package
                .ids
                .get(item.attr("idref"))
                .ok_or_else(|| invalid("не найден локальный документ главы"))?;
            self.add(package, *index, item.attr("linear") != "no")?;
        }
        if !self.queue.iter().any(|chapter| chapter.linear) {
            return Err(invalid("в книге нет глав для чтения"));
        }
        let mut cache = TREE_CACHE;
        let mut i = 0;
        while i < self.queue.len() {
            let file = self.queue[i].file;
            let (doc, size) = source.document(file, CHAPTER_LIMIT)?;
            let body = body(&doc)?;
            let chapter_id = chapter_id(file);
            self.targets.insert(format!("{file}#"), chapter_id.clone());
            index_nodes(body, file, &chapter_id, None, &mut self.targets)?;
            let mut chapter_heading = None;
            for node in body.all("") {
                if chapter_heading.is_none() && heading(&node.name) {
                    let title = node.plain();
                    if !title.is_empty() {
                        chapter_heading = Some((node.index, title));
                    }
                }
                match node.name.as_str() {
                    "svg" => check_svg(node)?,
                    "img" | "image" => {
                        images.add(
                            source,
                            &package.encrypted,
                            |file| package.media_type(file).to_owned(),
                            file,
                            image_href(node),
                        )?;
                    }
                    "a" if !node.attr("href").is_empty() => {
                        let target = reference(file, node.attr("href"))?;
                        if let Some(file) = target.file {
                            if let Some(&index) = package.files.get(&file)
                                && is_chapter(package.items[index].media_type)
                            {
                                self.add(package, index, false)?;
                            }
                            if is_note_ref(node) {
                                self.labels
                                    .insert(format!("{file}#{}", target.fragment), node.plain());
                            }
                        }
                    }
                    _ => {}
                }
            }
            let chapter = &mut self.queue[i];
            if let Some((index, title)) = chapter_heading {
                chapter.heading = Some(index);
                chapter.title = title;
            } else {
                chapter.title = doc
                    .all("title")
                    .into_iter()
                    .map(Node::plain)
                    .find(|title| !title.is_empty())
                    .unwrap_or_default();
            }
            if size <= cache {
                cache -= size;
                chapter.document = Some(doc);
            }
            i += 1;
        }
        Ok(())
    }
}

fn body(document: &Node) -> Result<&Node> {
    document
        .all("body")
        .into_iter()
        .next()
        .ok_or_else(|| invalid("в главе нет body"))
}

fn index_nodes(
    node: &Node,
    file: &str,
    chapter: &str,
    parent: Option<&Node>,
    targets: &mut Targets,
) -> Result<()> {
    let parent = if block(&node.name) || is_note(node) {
        Some(node)
    } else {
        parent
    };
    for anchor in [
        node.attr("id"),
        node.attr("xml:id"),
        if node.name == "a" {
            node.attr("name")
        } else {
            ""
        },
    ] {
        if !anchor.is_empty()
            && targets
                .insert(
                    format!("{file}#{anchor}"),
                    parent.map_or_else(|| chapter.to_owned(), |node| node_id(file, node)),
                )
                .is_some()
        {
            return Err(invalid("повторяющийся идентификатор в главе"));
        }
    }
    for child in node.elements() {
        index_nodes(child, file, chapter, parent, targets)?;
    }
    Ok(())
}

pub(crate) struct Output<W> {
    writer: W,
    remaining: u64,
}

impl<W: Write> Output<W> {
    pub(crate) fn write(&mut self, value: &str) -> Result<()> {
        self.remaining = self
            .remaining
            .checked_sub(value.len() as u64)
            .ok_or_else(|| invalid("превышен размер результата"))?;
        self.writer.write_all(value.as_bytes())?;
        Ok(())
    }
}

fn render_chapter(
    chapter: &mut Chapter<'_>,
    source: &mut Source<impl Read + Seek>,
    renderer: &mut Renderer<'_>,
    write_title: bool,
) -> Result<String> {
    let document = match chapter.document.take() {
        Some(doc) => doc,
        None => source.document(chapter.file, CHAPTER_LIMIT)?.0,
    };
    let body = body(&document)?;
    let heading = chapter.heading.filter(|_| write_title);
    let mut content = format!("<section id=\"{}\">", chapter_id(chapter.file));
    if write_title && !chapter.title.is_empty() {
        content.push_str("<title>");
        if let Some(node) =
            heading.and_then(|index| body.all("").into_iter().find(|node| node.index == index))
        {
            paragraphs(
                &mut content,
                renderer.lines(&node.children, chapter.file, false)?,
                &id(chapter.file, node),
                "p",
            );
        } else {
            paragraphs(&mut content, vec![esc(&chapter.title)], "", "p");
        }
        content.push_str("</title>");
    }
    renderer.flow(&mut content, &body.children, chapter.file, heading)?;
    content.push_str("</section>");
    Ok(content)
}

pub(crate) fn convert(reader: impl Read + Seek, writer: impl Write, maximum: u64) -> Result<()> {
    let mut source = Source::open(reader)?;
    if String::from_utf8_lossy(&source.read("mimetype", 128)?).trim() != "application/epub+zip" {
        return Err(invalid("неверный mimetype"));
    }
    let (container, _) = source.document("META-INF/container.xml", MB)?;
    let rootfiles = container.all("rootfile");
    let rootfile = rootfiles
        .iter()
        .copied()
        .find(|node| node.attr("media-type") == "application/oebps-package+xml")
        .or_else(|| rootfiles.first().copied());
    let package_path = reference(
        "container.xml",
        rootfile
            .ok_or_else(|| invalid("не найден OPF"))?
            .attr("full-path"),
    )?
    .file
    .ok_or_else(|| invalid("не найден OPF"))?;
    let (opf, _) = source.document(&package_path, 4 * MB)?;
    let metadata = opf
        .all("metadata")
        .into_iter()
        .next()
        .ok_or_else(|| invalid("не найдены метаданные OPF"))?;
    let package = Package::read(&opf, &package_path, &mut source)?;
    let mut chapters = Chapters::default();
    let mut images = Images::default();
    chapters.read(&opf, &package, &mut source, &mut images)?;
    let cover = package
        .cover(metadata)
        .map(|file| {
            images.add_file(
                &mut source,
                &package.encrypted,
                |file| package.media_type(file).to_owned(),
                file,
            )
        })
        .transpose()?;
    let mut output = Output {
        writer,
        remaining: maximum.min(MAX_OUTPUT),
    };
    output.write(&book_description(
        metadata,
        &package_path,
        cover.as_deref(),
    )?)?;
    let mut renderer = Renderer {
        targets: &chapters.targets,
        images: &images.aliases,
        notes: Default::default(),
    };
    for chapter in chapters.queue.iter_mut().filter(|item| item.linear) {
        output.write(&render_chapter(chapter, &mut source, &mut renderer, true)?)?;
    }
    output.write("</body>")?;
    if chapters.queue.iter().any(|item| !item.linear) || !renderer.notes.is_empty() {
        output.write("<body name=\"notes\">")?;
        for chapter in chapters.queue.iter_mut().filter(|item| !item.linear) {
            output.write(&render_chapter(chapter, &mut source, &mut renderer, false)?)?;
        }
        let mut i = 0;
        while let Some(crate::epub_fb2_render::Note { node, file }) = renderer.notes.pop_front() {
            let label = chapters
                .labels
                .get(&format!("{file}#{}", node_anchor(&node)))
                .filter(|label| !label.is_empty());
            let label = label.map_or_else(|| (i + 1).to_string(), |label| esc(label));
            let mut section = String::new();
            write!(
                section,
                "<section{}><title><p>{label}</p></title>",
                id(&file, &node)
            )?;
            renderer.flow(&mut section, &node.children, &file, None)?;
            section.push_str("</section>");
            output.write(&section)?;
            i += 1;
        }
        output.write("</body>")?;
    }
    images.render(&mut source, &mut output)?;
    output.write("</FictionBook>")?;
    output.writer.flush()?;
    Ok(())
}
