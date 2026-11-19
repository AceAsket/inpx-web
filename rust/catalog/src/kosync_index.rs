use std::cell::OnceCell;
use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use memchr::memchr2;
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tempfile::NamedTempFile;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::Result;
use crate::crypto_support::parse_hex;
use crate::fb2_prepare::js_space;
use crate::file_stamp::{FileStamp, path_stamp, stamp};
use crate::kosync::fingerprint;

const FB2_LIMIT: u64 = 64 * 1024 * 1024;
const INDEX_LIMIT: u64 = 8 * 1024 * 1024;
const MEMORY_INDEX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "direction",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Query {
    From { pointer: String },
    To { text_snippet: String, percent: f64 },
}

#[derive(Deserialize, Serialize)]
struct Block {
    path: String,
    text: String,
    offset: usize,
}

#[derive(Default, Deserialize, Serialize)]
struct Index {
    blocks: Vec<Block>,
    total: usize,
    #[serde(skip)]
    paths: OnceCell<HashMap<String, usize>>,
    #[serde(skip)]
    keys: OnceCell<Vec<String>>,
}

impl Index {
    fn lookup(&self, query: &Query) -> Value {
        match query {
            Query::From { pointer } => {
                let paths = self.paths.get_or_init(|| {
                    let mut paths = HashMap::with_capacity(self.blocks.len());
                    for (id, block) in self.blocks.iter().enumerate() {
                        paths.entry(normalize_path(&block.path)).or_insert(id);
                    }
                    paths
                });
                let normalized = normalize_path(pointer);
                let mut path = normalized.as_str();
                let mut first = None;
                // Preserve file order if a cache made by a previous version has nested paths.
                loop {
                    if let Some(&id) = paths.get(path) {
                        first = Some(first.map_or(id, |old: usize| old.min(id)));
                    }
                    let Some((parent, _)) = path.rsplit_once('/') else {
                        break;
                    };
                    path = parent;
                }
                first.map_or(Value::Null, |id| {
                    json!({
                        "textSnippet": utf16_prefix(&self.blocks[id].text, 240),
                        "textOffset": -1, "sectionId": "", "pageIndex": 0,
                    })
                })
            }
            Query::To {
                text_snippet,
                percent,
            } => {
                let cleaned = anchor_key(text_snippet);
                let needle = utf16_prefix(&cleaned, 80);
                let target = percent.clamp(0.0, 1.0) * self.total as f64;
                let mut closest = None;
                if utf16_len(needle) >= 8 {
                    let keys = self.keys.get_or_init(|| {
                        self.blocks
                            .iter()
                            .map(|block| anchor_key(&block.text))
                            .collect()
                    });
                    let mut distance = f64::INFINITY;
                    for (key, block) in keys.iter().zip(&self.blocks) {
                        let delta = (block.offset as f64 - target).abs();
                        if delta < distance && key.contains(needle) {
                            closest = Some(block);
                            distance = delta;
                        }
                    }
                }
                closest
                    .or_else(|| (*percent <= 0.0).then(|| self.blocks.first()).flatten())
                    .map_or(Value::Null, |block| {
                        json!(format!("{}/text().0", block.path))
                    })
            }
        }
    }
}

fn normalize_path(value: &str) -> String {
    static BOXES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"/(?:autoboxing|floatboxing|inlinebox|pseudoelem)(?:\[[0-9]+\])?").unwrap()
    });
    let lower = value.to_lowercase();
    let clean = BOXES.replace_all(&lower, "");
    let path = clean
        .split_once("/text()")
        .map_or(clean.as_ref(), |(path, _)| path);
    let mut result = String::with_capacity(path.len() + 12);
    for (position, name) in path.split('/').enumerate() {
        if position == 0 {
            result.push_str(name);
            continue;
        }
        result.push('/');
        let bound = name
            .bytes()
            .take_while(|c| c.is_ascii_lowercase() || *c == b'-')
            .count();
        if bound > 0 && name.as_bytes().get(bound) != Some(&b'[') {
            result.push_str(&name[..bound]);
            result.push_str("[1]");
            result.push_str(&name[bound..]);
        } else {
            result.push_str(name);
        }
    }
    const ROOT: &str = "/fictionbook";
    if result
        .strip_prefix(ROOT)
        .is_some_and(|suffix| suffix.starts_with("[1]"))
    {
        result.replace_range(ROOT.len()..ROOT.len() + "[1]".len(), "");
    }
    result
}

fn anchor_key(text: &str) -> String {
    use GeneralCategory::*;
    text.nfkc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .filter_map(|c| match get_general_category(c) {
            UppercaseLetter | LowercaseLetter | TitlecaseLetter | ModifierLetter | OtherLetter
            | DecimalNumber | LetterNumber | OtherNumber => Some(if c == 'ё' { 'е' } else { c }),
            _ => None,
        })
        .collect()
}

fn utf16_len(value: &str) -> usize {
    if value.is_ascii() {
        value.len()
    } else {
        value.encode_utf16().count()
    }
}

fn utf16_prefix(value: &str, mut limit: usize) -> &str {
    if value.is_ascii() {
        return &value[..value.len().min(limit)];
    }
    for (index, ch) in value.char_indices() {
        let width = ch.len_utf16();
        if width > limit {
            return &value[..index];
        }
        limit -= width;
    }
    value
}

struct Frame {
    restore_path: usize,
    children: HashMap<String, u32>,
    body: bool,
    skip: bool,
    text_frame: Option<usize>,
    text: String,
    length: usize,
    nested: bool,
}

#[derive(Default)]
struct Parser {
    index: Index,
    stack: Vec<Frame>,
    path: String,
    root: bool,
}

impl Parser {
    fn open(&mut self, node: &BytesStart<'_>) -> Result<()> {
        if self.stack.len() >= 512 {
            return Err("Слишком глубокая структура FB2 для KOSync".into());
        }
        let local = node.local_name();
        let name = local.as_ref().to_lowercase();
        let restore_path = self.path.len();
        let (ordinal, parent_body, parent_skip, parent_text) =
            if let Some(parent) = self.stack.last_mut() {
                let ordinal = if let Some(count) = parent.children.get_mut(&name) {
                    *count += 1;
                    *count
                } else {
                    parent.children.insert(name.clone(), 1);
                    1
                };
                (ordinal, parent.body, parent.skip, parent.text_frame)
            } else {
                if std::mem::replace(&mut self.root, true) {
                    return Err("Несколько корневых элементов FB2".into());
                }
                (1, false, false, None)
            };
        let body = parent_body || name == "body";
        let skip = parent_skip || name == "binary" || excluded(&name, node)?;
        let block = body
            && !skip
            && matches!(
                name.as_str(),
                "p" | "v" | "subtitle" | "text-author" | "td" | "th"
            );
        let text_frame = if block {
            if let Some(parent) = parent_text {
                self.stack[parent].nested = true;
            }
            Some(self.stack.len())
        } else if !skip {
            parent_text
        } else {
            None
        };
        if self.stack.is_empty() {
            self.path.push_str("/FictionBook");
        } else {
            write!(self.path, "/{name}[{ordinal}]")?;
        }
        self.stack.push(Frame {
            restore_path,
            children: HashMap::new(),
            body,
            skip,
            text_frame,
            text: String::new(),
            length: 0,
            nested: false,
        });
        Ok(())
    }

    fn text(&mut self, value: &str) -> Result<()> {
        if let Some(frame) = self.stack.last().and_then(|frame| frame.text_frame) {
            let block = &mut self.stack[frame];
            let cap = 4096_usize.saturating_sub(block.length);
            if cap != 0 {
                block.text.push_str(utf16_prefix(value, cap));
            }
            block.length += utf16_len(value);
        } else if self.stack.is_empty() && !value.chars().all(js_space) {
            return Err("Текст за пределами корневого элемента FB2".into());
        }
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        let frame = self.stack.pop().ok_or("Незакрытый элемент FB2")?;
        if frame.text_frame == Some(self.stack.len()) && !frame.nested {
            let text = normalized_text(&frame.text);
            if !text.is_empty() {
                if self.index.blocks.len() >= 50_000
                    || self.index.total + utf16_len(&text) > 2 * 1024 * 1024
                {
                    return Err("Слишком большой текстовый индекс KOSync".into());
                }
                self.index.blocks.push(Block {
                    path: self.path.clone(),
                    text,
                    offset: self.index.total,
                });
                self.index.total += frame.length;
            }
        }
        self.path.truncate(frame.restore_path);
        Ok(())
    }
}

fn excluded(name: &str, node: &BytesStart<'_>) -> Result<bool> {
    let key = match name {
        "body" => "name",
        "a" => "type",
        _ => return Ok(false),
    };
    let Some(attr) = node.try_get_attribute(key)? else {
        return Ok(false);
    };
    let value = quick_xml::escape::unescape(&attr.value)?;
    Ok(if name == "body" {
        value.eq_ignore_ascii_case("notes") || value.eq_ignore_ascii_case("comments")
    } else {
        value == "note"
    })
}

fn normalized_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut space = false;
    for ch in value.chars() {
        if js_space(ch) {
            space = !result.is_empty();
        } else {
            if space {
                result.push(' ');
            }
            result.push(ch);
            space = false;
        }
    }
    result
}

fn skip_plain_text(reader: &mut Reader<impl BufRead>) -> io::Result<()> {
    let mut stream = reader.stream();
    loop {
        let bytes = stream.fill_buf()?;
        if bytes.is_empty() {
            return Ok(());
        }
        let stop = memchr2(b'<', b'&', bytes);
        let count = stop.unwrap_or(bytes.len());
        stream.consume(count);
        if stop.is_some() {
            return Ok(());
        }
    }
}

fn read_index(file: &mut File) -> Result<Index> {
    if file.metadata()?.len() > FB2_LIMIT {
        return Err("FB2 превышает лимит KOSync (64 МБ)".into());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut reader = Reader::from_reader(BufReader::with_capacity(
        64 * 1024,
        file.take(FB2_LIMIT + 1),
    ));
    let mut parser = Parser::default();
    let mut buffer = Vec::with_capacity(4096);
    loop {
        match reader.read_event_into(&mut buffer)? {
            Event::Start(node) => parser.open(&node)?,
            Event::Empty(node) => {
                parser.open(&node)?;
                parser.close()?;
            }
            Event::End(_) => parser.close()?,
            Event::Text(text) => parser.text(text.as_ref())?,
            Event::CData(text) => parser.text(text.as_ref())?,
            Event::GeneralRef(reference) => {
                if let Some(ch) = reference.resolve_char_ref()? {
                    parser.text(ch.encode_utf8(&mut [0; 4]))?;
                } else {
                    let name = reference.as_ref();
                    let entity = format!("&{name};");
                    let decoded = html_escape::decode_html_entities(&entity);
                    if decoded == entity {
                        let lower = entity.to_ascii_lowercase();
                        let decoded = html_escape::decode_html_entities(&lower);
                        if decoded == lower {
                            return Err("Недопустимая ссылка в FB2".into());
                        }
                        parser.text(&decoded)?;
                    } else {
                        parser.text(&decoded)?;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        if parser.stack.last().is_some_and(|frame| frame.skip) {
            // A large base64 value is irrelevant to anchors. Advance without allocating its text.
            skip_plain_text(&mut reader)?;
        }
        buffer.clear();
    }
    if reader.buffer_position() > FB2_LIMIT {
        return Err("FB2 превышает лимит KOSync (64 МБ)".into());
    }
    if !parser.stack.is_empty() {
        return Err("Незакрытый элемент FB2".into());
    }
    Ok(parser.index)
}

struct CachedIndex {
    file: PathBuf,
    revision: FileStamp,
    index: Index,
}

#[derive(Default)]
pub(crate) struct Cache {
    recent: VecDeque<CachedIndex>,
}

impl Cache {
    pub fn lookup(&mut self, file: &Path, query: &Query) -> Result<Value> {
        let revision = match path_stamp(file) {
            Ok(revision) if revision.len <= INDEX_LIMIT => revision,
            Ok(_) => return Ok(json!({"ready":false})),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(json!({"ready":false}));
            }
            Err(error) => return Err(error.into()),
        };
        let existing = self.recent.iter().position(|item| item.file == file);
        if let Some(existing) = existing
            && let Some(item) = self.recent.remove(existing)
            && item.revision == revision
        {
            let value = item.index.lookup(query);
            self.remember(item);
            return Ok(json!({"ready":true,"value":value}));
        }
        let input = match File::open(file) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(json!({"ready":false}));
            }
            Err(error) => return Err(error.into()),
        };
        let revision = stamp(&input)?;
        let mut bytes = Vec::with_capacity(revision.len.min(INDEX_LIMIT) as usize);
        if input.take(INDEX_LIMIT + 1).read_to_end(&mut bytes)? as u64 > INDEX_LIMIT {
            return Ok(json!({"ready":false}));
        }
        let Ok(index) =
            serde_json::from_slice::<Index>(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))
        else {
            // Older JavaScript caches can contain a paragraph cut inside a surrogate pair.
            // Rebuild unreadable indexes from the verified source file.
            return Ok(json!({"ready":false}));
        };
        let value = index.lookup(query);
        self.remember(CachedIndex {
            file: file.to_owned(),
            revision,
            index,
        });
        Ok(json!({"ready":true,"value":value}))
    }

    pub fn build(cache: &Path, source: &Path, document: &str) -> Result<()> {
        let mut source = File::open(source)?;
        let source_revision = stamp(&source)?;
        if fingerprint(&mut source)? != document {
            return Err("Файл книги изменился. Скачайте его заново для KOSync".into());
        }
        let index = read_index(&mut source)?;
        if stamp(&source)? != source_revision {
            return Err("Файл книги изменился. Скачайте его заново для KOSync".into());
        }
        let directory = cache.parent().ok_or("Некорректный путь индекса KOSync")?;
        fs::create_dir_all(directory)?;
        let mut temp = NamedTempFile::new_in(directory)?;
        {
            let mut output = io::BufWriter::new(&mut temp);
            serde_json::to_writer(&mut output, &index)?;
            output.flush()?;
        }
        if temp.as_file().metadata()?.len() > INDEX_LIMIT {
            return Err("Слишком большой текстовый индекс KOSync".into());
        }
        temp.as_file().sync_all()?;
        temp.persist(cache)?;
        prune(directory)
    }

    fn remember(&mut self, index: CachedIndex) {
        self.recent.push_front(index);
        let keep = self
            .recent
            .iter()
            .take(32)
            .scan(0, |total, item| {
                *total += item.revision.len;
                Some(*total)
            })
            .take_while(|&total| total <= MEMORY_INDEX_BYTES)
            .count();
        self.recent.truncate(keep);
    }
}

fn prune(directory: &Path) -> Result<()> {
    let mut candidates: Vec<_> = fs::read_dir(directory)?
        .filter_map(|item| {
            let item = item.ok()?;
            let path = item.path();
            let name = path.file_stem()?.to_str()?;
            if path.extension()?.to_str()? != "json" || parse_hex::<16>(name).is_none() {
                return None;
            }
            let meta = item.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), path))
        })
        .collect();
    candidates
        .sort_unstable_by(|left, right| right.0.cmp(&left.0).then_with(|| left.2.cmp(&right.2)));
    let mut bytes = 0;
    for (position, (_, len, path)) in candidates.into_iter().enumerate() {
        bytes += len;
        if position >= 128 || bytes > 128 * 1024 * 1024 {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}
