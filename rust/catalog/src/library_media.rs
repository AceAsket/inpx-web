use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::STANDARD, read::DecoderReader};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::book_archive::{Failure, open_directory, read_member};
use crate::book_delivery::Book;
use crate::crypto_support::{hex, md5};
use crate::file_stamp::{FileStamp, stamp};
use crate::library_fs::{self, path_stamp};
use crate::library_sources::{Source, js_string};
use crate::reader_document::{IMAGE_LIMIT, Image};
use crate::standalone_catalogue::Catalogue;

const REVIEW_LIMIT: u64 = 16 * 1024 * 1024;
const BIO_LIMIT: u64 = 4 * 1024 * 1024;
pub const RATING_FILTER_PENDING: &str = "Индекс количества оценок пока недоступен";

#[derive(Clone, Copy, Serialize)]
pub struct Rating {
    pub value: f64,
    pub count: u64,
}

#[derive(Clone, PartialEq)]
struct Archive {
    path: PathBuf,
    id: String,
    source: usize,
    stamp: String,
}

#[derive(Default)]
pub struct LibraryMedia {
    ratings: Mutex<HashMap<PathBuf, Arc<Ratings>>>,
    review_indexes: Mutex<HashMap<PathBuf, Arc<ReviewIndex>>>,
}

pub struct Ratings {
    archives: Vec<Archive>,
    books: HashMap<String, Rating>,
}

pub struct RatingEntry {
    pub count: u64,
    pub id: u32,
    pub uid: String,
}

pub struct RatingIndex {
    pub revision: String,
    pub entries: Vec<RatingEntry>,
}

pub(crate) fn rating_range(value: &str) -> Result<Option<(u64, u64)>> {
    const MAX: u64 = (1 << 53) - 1;
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = "Число голосов: укажите N, N..M, N.. или ..M";
    let parse = |text: &str| -> Result<u64> {
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid.into());
        }
        text.parse::<u64>()
            .ok()
            .filter(|&count| count <= MAX)
            .ok_or_else(|| "Некорректный диапазон числа голосов".into())
    };
    let (min, max) = if let Some((left, right)) = value.split_once("..") {
        if left.is_empty() && right.is_empty() {
            return Err(invalid.into());
        }
        (
            if left.is_empty() { 0 } else { parse(left)? },
            if right.is_empty() { MAX } else { parse(right)? },
        )
    } else {
        let number = parse(value)?;
        (number, number)
    };
    if min > max {
        return Err("Некорректный диапазон числа голосов".into());
    }
    Ok(Some((min, max)))
}

impl Catalogue {
    pub fn publish_rating_filter(&self, ratings: Arc<RatingIndex>) {
        *self.rating_filter.lock().expect("catalogue rating filter") = Some(ratings);
    }

    pub fn build_remote_rating_index(
        &self,
        source: &str,
        revision: String,
        counts: &HashMap<String, u64>,
        mut progress: impl FnMut(u64),
    ) -> Result<RatingIndex> {
        let mut entries = Vec::new();
        let mut done = 0;
        if !counts.is_empty() {
            self.store
                .visit_search_rows(&self.generation, None, |id, bytes| {
                    let book: Book = serde_json::from_slice(bytes)?;
                    let (primary, legacy) = book.remote_ids(source)?;
                    if let Some(&count) = counts
                        .get(&primary)
                        .or_else(|| legacy.and_then(|uid| counts.get(uid)))
                    {
                        entries.push(RatingEntry {
                            count,
                            id,
                            uid: book.uid,
                        });
                    }
                    done += 1;
                    if done % 5000 == 0 {
                        progress(done);
                    }
                    Ok(())
                })?;
        }
        entries.sort_unstable_by_key(|row| (row.count, row.id));
        progress(done);
        Ok(RatingIndex { revision, entries })
    }

    pub(crate) fn rating_candidates(&self, (min, max): (u64, u64)) -> Result<HashSet<u32>> {
        let index = self
            .rating_filter
            .lock()
            .expect("catalogue rating filter")
            .clone()
            .ok_or(RATING_FILTER_PENDING)?;
        let from = index.entries.partition_point(|row| row.count < min);
        let to = index.entries.partition_point(|row| row.count <= max);
        Ok(index.entries[from..to].iter().map(|row| row.id).collect())
    }

    pub fn build_rating_index(
        &self,
        sources: &HashMap<&str, Arc<Ratings>>,
        revision: String,
        mut progress: impl FnMut(u64),
    ) -> Result<RatingIndex> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Row {
            #[serde(rename = "_uid")]
            uid: String,
            #[serde(default)]
            source_id: String,
            folder: String,
            file: String,
            ext: String,
        }
        let mut entries = Vec::new();
        if sources.values().all(|ratings| ratings.is_empty()) {
            return Ok(RatingIndex { revision, entries });
        }
        let fallback = (sources.len() == 1)
            .then(|| sources.values().next())
            .flatten();
        let mut done = 0;
        self.store
            .visit_search_rows(&self.generation, None, |id, bytes| {
                let row: Row = serde_json::from_slice(bytes)?;
                if let Some(rating) = sources
                    .get(row.source_id.as_str())
                    .or(fallback)
                    .and_then(|asset| asset.get(&row.folder, &row.file, &row.ext))
                {
                    entries.push(RatingEntry {
                        count: rating.count,
                        id,
                        uid: row.uid,
                    });
                }
                done += 1;
                if done % 5000 == 0 {
                    progress(done);
                }
                Ok(())
            })?;
        progress(done);
        entries.sort_unstable_by_key(|row| (row.count, row.id));
        Ok(RatingIndex { revision, entries })
    }
}

struct ReviewIndex {
    archives: Vec<Archive>,
    entries: HashMap<String, Vec<(usize, String)>>,
    fallback_start: usize,
}

impl Ratings {
    pub fn revision(&self) -> impl Iterator<Item = (&Path, &str)> {
        self.archives
            .iter()
            .map(|archive| (archive.path.as_path(), archive.stamp.as_str()))
    }

    pub fn is_empty(&self) -> bool {
        self.books.is_empty()
    }

    pub fn get(&self, folder: &str, file: &str, ext: &str) -> Option<Rating> {
        self.books
            .get(&entry_key(folder, &format!("{file}.{ext}")))
            .copied()
    }
}

impl LibraryMedia {
    pub fn ratings(&self, dir: &Path) -> Result<Arc<Ratings>> {
        let mut archives = review_archives(dir)?;
        archives.retain(|row| row.id.eq_ignore_ascii_case("additional"));
        let mut cache = self.ratings.lock().map_err(|_| "Кэш оценок недоступен")?;
        if let Some(result) = cache.get(dir).filter(|row| row.archives == archives) {
            return Ok(result.clone());
        }
        let mut books = HashMap::new();
        for archive in &archives {
            match rating_archive(&archive.path) {
                Ok(ratings) => {
                    for (key, rating) in ratings.0 {
                        books.entry(key).or_insert(rating);
                    }
                }
                Err(error) => eprintln!("Library ratings {}: {error}", archive.path.display()),
            }
        }
        let result = Arc::new(Ratings { archives, books });
        cache.insert(dir.into(), result.clone());
        Ok(result)
    }

    fn review_index(&self, dir: &Path) -> Result<Arc<ReviewIndex>> {
        let mut archives = review_archives(dir)?;
        archives.retain(|row| !row.id.eq_ignore_ascii_case("additional"));
        let mut cache = self
            .review_indexes
            .lock()
            .map_err(|_| "Кэш отзывов недоступен")?;
        if let Some(current) = cache.get(dir).filter(|index| index.archives == archives) {
            return Ok(current.clone());
        }
        let mut count = 0;
        let mut entries: HashMap<String, Vec<(usize, String)>> = HashMap::new();
        let mut fallback_start = archives.len();
        for (index, archive) in archives.iter().enumerate() {
            match open_directory(&archive.path) {
                Ok(mut directory) => directory.files(|name| {
                    if count >= 100_000 {
                        fallback_start = index;
                        return false;
                    }
                    if let Some(key) = review_key(name) {
                        entries.entry(key).or_default().push((index, name.into()));
                        count += 1;
                    }
                    true
                }),
                Err(error) => eprintln!("Review archive {}: {error}", archive.path.display()),
            }
            if fallback_start != archives.len() {
                break;
            }
        }
        let result = Arc::new(ReviewIndex {
            archives,
            entries,
            fallback_start,
        });
        cache.insert(dir.into(), result.clone());
        Ok(result)
    }

    pub fn reviews(&self, book: &Book, dir: &Path) -> Result<Vec<Value>> {
        let index = self.review_index(dir)?;
        let key = entry_key(&book.folder, &format!("{}.{}", book.file, book.ext));
        let mut matches = index.entries.get(&key).cloned().unwrap_or_default();
        for (idx, row) in index.archives.iter().enumerate().skip(index.fallback_start) {
            if let Ok(mut directory) = open_directory(&row.path) {
                directory.files(|name| {
                    if review_key(name).as_deref() == Some(key.as_str()) {
                        matches.push((idx, name.into()));
                    }
                    true
                });
            }
        }
        let mut visited = HashSet::new();
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for (idx, name) in matches {
            if !visited.insert((idx, name.clone())) {
                continue;
            }
            let path = &index.archives[idx].path;
            let raw = match read_asset(path, &name, REVIEW_LIMIT)
                .and_then(|bytes| Ok(serde_json::from_str::<Value>(decode(&bytes).as_ref())?))
            {
                Ok(raw) => raw,
                Err(error) => {
                    eprintln!("Review entry {}: {error}", path.display());
                    continue;
                }
            };
            for row in raw
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| row.is_object())
            {
                let name = string(&row["name"]);
                let time = string(&row["time"]);
                let text = LINE_BREAK
                    .replace_all(&string(&row["text"]), "\n")
                    .trim()
                    .to_owned();
                let name = if name.is_empty() {
                    "Аноним".into()
                } else {
                    name
                };
                if seen.insert((name.clone(), time.clone(), text.clone())) {
                    result.push(json!({"name":name,"time":time,"text":text}));
                }
            }
        }
        Ok(result)
    }
}

pub fn author_info(author: &str, sources: &[Source]) -> Result<Value> {
    let normalized = author
        .split(inpx_reader::js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if normalized.is_empty() {
        return Ok(Value::Null);
    }
    let key = hex(&md5(normalized.as_bytes())?);
    let authors = author_archives(sources, false)?;
    for archive in &authors {
        let entry = match open_directory(&archive.path) {
            Ok(mut directory) => directory.find_file(|name| {
                let filename = name.rsplit(['/', '\\']).next().unwrap_or_default();
                Path::new(filename)
                    .file_stem()
                    .is_some_and(|stem| stem.eq_ignore_ascii_case(&key))
            }),
            Err(error) => {
                eprintln!("Author archive {}: {error}", archive.path.display());
                continue;
            }
        };
        let Some(entry) = entry else {
            continue;
        };
        let Ok(bytes) = read_asset(&archive.path, &entry, BIO_LIMIT) else {
            continue;
        };
        let body = decode(&bytes);
        let (html, text) = safe_biography(&body);
        let photo = author_photo(&key, archive, sources)?;
        return Ok(json!({"key":key,"html":html,"text":text,"photo":photo}));
    }
    Ok(Value::Null)
}

fn author_photo(key: &str, source: &Archive, sources: &[Source]) -> Result<String> {
    let mut pictures = author_archives(sources, true)?;
    pictures.sort_by_key(|row| (row.source != source.source, row.id != source.id));
    let prefix = format!("{key}/");
    for archive in pictures {
        let Ok(mut directory) = open_directory(&archive.path) else {
            continue;
        };
        let mut entries = Vec::new();
        directory.files(|name| {
            if name.replace('\\', "/").starts_with(&prefix) {
                entries.push(name.to_owned());
            }
            true
        });
        entries.sort_unstable();
        for entry in entries {
            if let Ok(bytes) = read_asset(&archive.path, &entry, IMAGE_LIMIT as u64)
                && let Some(image) = Image::from_bytes(bytes)
            {
                return Ok(format!(
                    "data:{};base64,{}",
                    image.content_type,
                    STANDARD.encode(image.bytes)
                ));
            }
        }
    }
    Ok(String::new())
}

fn review_key(entry: &str) -> Option<String> {
    let (folder, file) = entry.rsplit_once('#')?;
    Some(entry_key(folder, file))
}

fn entry_key(folder: &str, file: &str) -> String {
    let mut folder = folder.replace('\\', "/");
    if let Some((dot, ext)) = folder.rsplit_once('.')
        && (ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("7z"))
    {
        folder.truncate(dot.len());
        folder.push_str(".zip");
    }
    format!("{folder}#{file}")
}

fn review_archives(lib: &Path) -> Result<Vec<Archive>> {
    let mut archives = Vec::new();
    let mut seen = HashSet::new();
    for dir in asset_dirs(lib, &["reviews", "etc/reviews"]) {
        archives.extend(scan(&dir, 0, false, &mut seen)?);
    }
    Ok(archives)
}

fn author_archives(sources: &[Source], pictures: bool) -> Result<Vec<Archive>> {
    let mut archives = Vec::new();
    let mut seen = HashSet::new();
    for (index, source) in sources.iter().enumerate() {
        for mut dir in asset_dirs(&source.lib_dir, &["etc/authors", "authors"]) {
            if pictures {
                dir.push("pictures");
            }
            archives.extend(scan(&dir, index, true, &mut seen)?);
        }
    }
    archives.sort_by(|a, b| {
        sources[a.source]
            .id
            .cmp(&sources[b.source].id)
            .then_with(|| a.id.parse::<u64>().ok().cmp(&b.id.parse::<u64>().ok()))
    });
    Ok(archives)
}

fn asset_dirs<'a>(lib: &'a Path, directories: &'a [&'a str]) -> impl Iterator<Item = PathBuf> + 'a {
    directories.iter().flat_map(move |sub| {
        std::iter::once(lib)
            .chain(lib.parent())
            .map(move |dir| dir.join(sub))
    })
}

fn scan(
    dir: &Path,
    source: usize,
    numeric: bool,
    seen: &mut HashSet<PathBuf>,
) -> Result<Vec<Archive>> {
    let dir = match library_fs::ordered_entries(dir) {
        Ok(dir) => dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let paths = dir.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut archives = Vec::new();
    for (_, entry) in paths {
        let path = entry.path();
        if path
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip") && !ext.eq_ignore_ascii_case("7z"))
        {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if numeric && (id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit())) {
            continue;
        }
        let stable = match library_fs::canonicalize(&path) {
            Ok(path) if library_fs::is_file(&path) => path,
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if seen.insert(stable.clone()) {
            let stamp = path_stamp(&stable)?;
            archives.push(Archive {
                path: stable,
                id: id.into(),
                source,
                stamp: stamp.to_string(),
            });
        }
    }
    Ok(archives)
}

fn read_asset(path: &Path, entry: &str, limit: u64) -> Result<Vec<u8>> {
    Ok(read_member(
        path,
        library_fs::open(path)?,
        entry,
        |size, reader| {
            if size > limit {
                return Err(Failure::Limit);
            }
            let mut bytes = Vec::new();
            reader
                .take(size.saturating_add(1))
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 != size {
                return Err(Failure::InvalidType);
            }
            Ok(bytes)
        },
    )?)
}

fn decode(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => std::borrow::Cow::Borrowed(text),
        Err(_) => encoding_rs::WINDOWS_1251.decode(bytes).0,
    }
}

fn string(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::Number(number) if number.as_f64() == Some(0.0) => String::new(),
        value => js_string(value).trim().into(),
    }
}

static LINE_BREAK: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)<br\s*/?>").expect("line break pattern"));

fn safe_biography(body: &str) -> (String, String) {
    static TAG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?is)<(/?)([a-z][a-z0-9:.-]*)(?:\s[^<>]*)?/?\s*>")
            .expect("HTML tag pattern")
    });
    const TAGS: &[&str] = &[
        "p",
        "br",
        "b",
        "i",
        "u",
        "em",
        "strong",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "sub",
        "sup",
        "ul",
        "ol",
        "li",
        "blockquote",
        "div",
        "span",
    ];
    let mut html = String::new();
    let mut text = String::new();
    let mut offset = 0;
    let append = |part: &str, html: &mut String, text: &mut String| {
        let decoded = html_escape::decode_html_entities(part);
        html.push_str(&html_escape::encode_text(&decoded));
        text.push_str(&decoded);
    };
    for row in TAG.captures_iter(body) {
        let span = row.get(0).expect("tag span");
        append(&body[offset..span.start()], &mut html, &mut text);
        let name = row[2].to_ascii_lowercase();
        if TAGS.contains(&name.as_str()) {
            html.push('<');
            html.push_str(&row[1]);
            html.push_str(&name);
            html.push('>');
        }
        text.push(' ');
        offset = span.end();
    }
    append(&body[offset..], &mut html, &mut text);
    (html, text.split_whitespace().collect::<Vec<_>>().join(" "))
}

#[derive(Default)]
struct RatingRecords(HashMap<String, Rating>);

impl RatingRecords {
    fn add(&mut self, row: Value) {
        let (Some(folder), Some(file), Some(sum), Some(count)) = (
            row["folder"].as_str(),
            row["file"].as_str(),
            row["sum"].as_f64(),
            row["count"].as_u64(),
        ) else {
            return;
        };
        if count == 0 || count > (1 << 53) - 1 || sum <= 0.0 || sum > count as f64 * 5.0 {
            return;
        }
        self.0.entry(entry_key(folder, file)).or_insert(Rating {
            value: sum / count as f64,
            count,
        });
    }
}

impl<'de> Deserialize<'de> for RatingRecords {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Rows;
        impl<'de> Visitor<'de> for Rows {
            type Value = RatingRecords;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("массив или объект оценок")
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut stream: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut rows = RatingRecords::default();
                while let Some(row) = stream.next_element()? {
                    rows.add(row);
                }
                Ok(rows)
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut stream: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut rows = RatingRecords::default();
                while let Some((_, row)) = stream.next_entry::<serde::de::IgnoredAny, Value>()? {
                    rows.add(row);
                }
                Ok(rows)
            }
        }
        deserializer.deserialize_any(Rows)
    }
}

fn rating_archive(path: &Path) -> Result<RatingRecords> {
    let result = read_member(path, library_fs::open(path)?, "books.json", |_, reader| {
        let mut reader = BufReader::with_capacity(64 * 1024, reader);
        use std::io::BufRead;
        if reader.fill_buf()?.starts_with(b"\xef\xbb\xbf") {
            reader.consume(3);
        }
        serde_json::from_reader::<_, RatingRecords>(reader)
            .map_err(|error| Failure::Other(error.into()))
    });
    match result {
        Ok(ratings) => Ok(ratings),
        Err(Failure::Other(_)) => {
            let bytes = read_asset(path, "books.json", 256 * 1024 * 1024)?;
            Ok(serde_json::from_str(&decode(&bytes))?)
        }
        Err(error) => Err(error.into()),
    }
}

pub struct InpxExchange {
    file: PathBuf,
    revision: Mutex<Option<(FileStamp, String)>>,
    transfer: Mutex<()>,
}

pub fn install_remote_inpx(path: &Path, encoded: &str, limit: u64) -> Result<()> {
    if encoded.is_empty() || encoded.len() as u64 > limit.div_ceil(3) * 4 {
        return Err("Недопустимый размер удалённого INPX".into());
    }
    let old = crate::atomic_file::current_stamp(path)?;
    let parent = path.parent().ok_or("Каталог удалённого INPX недоступен")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    let mut decoded = DecoderReader::new(encoded.as_bytes(), &STANDARD).take(limit + 1);
    let bytes = io::copy(&mut decoded, &mut file)?;
    std::io::Write::flush(&mut file)?;
    if bytes == 0 || bytes > limit {
        return Err("Недопустимый размер удалённого INPX".into());
    }
    let archive = zip::ZipArchive::new(file.reopen()?)?;
    if !archive
        .file_names()
        .any(|name| name.to_ascii_lowercase().ends_with(".inp"))
    {
        return Err("Удалённый INPX не содержит записей каталога".into());
    }
    drop(archive);
    if crate::atomic_file::publish(file, path, old.as_deref())?.is_none() {
        return Err("Локальный INPX изменился во время синхронизации".into());
    }
    Ok(())
}

impl InpxExchange {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            revision: Mutex::default(),
            transfer: Mutex::default(),
        }
    }

    pub fn current_hash(&self) -> Result<String> {
        match File::open(&self.file) {
            Ok(mut file) => {
                let current = stamp(&file)?;
                self.hash(&mut file, &current)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn hash(&self, file: &mut File, current: &FileStamp) -> Result<String> {
        let mut saved = self.revision.lock().map_err(|_| "Кэш INPX недоступен")?;
        if let Some((_, hash)) = saved.as_ref().filter(|(stamp, _)| stamp == current) {
            return Ok(hash.clone());
        }
        let mut hasher = Sha256::new();
        io::copy(file, &mut hasher)?;
        if stamp(file)? != *current {
            return Err("Файл INPX изменился. Повторите запрос.".into());
        }
        let hash = hex(&hasher.finalize());
        *saved = Some((stamp(file)?, hash.clone()));
        Ok(hash)
    }

    pub fn data(&self, previous: &str) -> Result<Value> {
        let _transfer = self.transfer.try_lock().map_err(|_| "server_busy")?;
        let mut file = File::open(&self.file)?;
        let current = stamp(&file)?;
        if !previous.is_empty() && previous == self.hash(&mut file, &current)? {
            return Ok(json!({"data":false}));
        }
        file.seek(SeekFrom::Start(0))?;
        let mut data = Vec::new();
        file.by_ref()
            .take(current.len.saturating_add(1))
            .read_to_end(&mut data)?;
        if data.len() as u64 != current.len || stamp(&file)? != current {
            return Err("Файл INPX изменился. Повторите запрос.".into());
        }
        let hash = hex(&Sha256::digest(&data));
        *self.revision.lock().map_err(|_| "Кэш INPX недоступен")? = Some((current, hash));
        Ok(json!({"data":STANDARD.encode(data)}))
    }
}
