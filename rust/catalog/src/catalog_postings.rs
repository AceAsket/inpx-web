use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::hash::Hash;
use std::io::{BufWriter, Write};
use std::path::Path;

use inpx_reader::Record;
use serde::Serialize;

use crate::Result;
use crate::catalog_text::{field, lower, number, words};

const EMPTY: &str = "?";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    name: String,
    book_count: u32,
    book_del_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Posting<K> {
    id: usize,
    value: K,
    book_ids: Vec<u32>,
    #[serde(flatten)]
    counts: Option<Counts>,
}

struct Table<K> {
    positions: HashMap<K, usize>,
    rows: Vec<Posting<K>>,
}

impl<K> Default for Table<K> {
    fn default() -> Self {
        Self {
            positions: HashMap::new(),
            rows: Vec::new(),
        }
    }
}

impl<K: Eq + Hash + Clone> Table<K> {
    fn position(&mut self, value: K, name: Option<&str>) -> usize {
        *self.positions.entry(value.clone()).or_insert_with(|| {
            let id = self.rows.len();
            let counts = name.map(|name| Counts {
                name: name.into(),
                book_count: 0,
                book_del_count: 0,
            });
            self.rows.push(Posting {
                id,
                value,
                book_ids: Vec::new(),
                counts,
            });
            id
        })
    }

    fn append(&mut self, position: usize, id: u32) {
        let ids = &mut self.rows[position].book_ids;
        if ids.last() != Some(&id) {
            ids.push(id);
        }
    }

    fn add(&mut self, value: K, id: u32) {
        let position = self.position(value, None);
        self.append(position, id);
    }
}

impl Table<String> {
    fn text(&mut self, value: &str, name: Option<&str>) -> usize {
        let key = lower(if value.is_empty() { EMPTY } else { value });
        if let Some(&position) = self.positions.get(key.as_ref()) {
            return position;
        }
        self.position(key.into_owned(), name)
    }

    fn add_named(&mut self, name: &str, id: u32, deleted: bool, omit_empty: bool) {
        let name = if name.is_empty() { EMPTY } else { name };
        let position = self.text(name, Some(name));
        let counts = self.rows[position]
            .counts
            .as_mut()
            .expect("named posting count");
        if deleted {
            counts.book_del_count += 1;
        } else {
            counts.book_count += 1;
        }
        if !omit_empty || name != EMPTY {
            self.append(position, id);
        }
    }

    fn add_text(&mut self, value: &str, id: u32) {
        let position = self.text(value, None);
        self.append(position, id);
    }
}

#[derive(Default)]
pub(crate) struct Postings {
    author: Table<String>,
    series: Table<String>,
    title: Table<String>,
    word: Table<String>,
    genre: Table<String>,
    lang: Table<String>,
    del: Table<i64>,
    date: Table<String>,
    librate: Table<i64>,
    ext: Table<String>,
    source: Table<String>,
    word_cache: [HashMap<String, Vec<usize>>; 2],
    files: HashSet<String>,
    deleted_files: HashSet<String>,
    author_count: usize,
    book_count: usize,
    deleted_count: usize,
    no_author_count: usize,
    low_memory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountsSummary {
    files_count: usize,
    files_del_count: usize,
    author_count: usize,
    book_count: usize,
    book_del_count: usize,
    no_author_book_count: usize,
    genre_count: usize,
    lang_count: usize,
    name_counts: [usize; 4],
}

impl Postings {
    pub fn new(low_memory: bool) -> Self {
        Self {
            low_memory,
            ..Default::default()
        }
    }

    fn add_words(&mut self, field: &str, value: &str, id: u32, cache: Option<usize>) {
        if let Some(saved) = cache.and_then(|index| self.word_cache[index].get(value)) {
            for &position in saved {
                self.word.append(position, id);
            }
            return;
        }
        let mut positions = Vec::new();
        let mut key = String::new();
        words(value, |_, root| {
            key.clear();
            key.push_str(field);
            key.push(':');
            key.push_str(root);
            let position = self.word.text(&key, None);
            self.word.append(position, id);
            if cache.is_some() {
                positions.push(position);
            }
        });
        if let Some(index) = cache
            && value.encode_utf16().take(513).count() <= 512
        {
            let cache = &mut self.word_cache[index];
            let limit = if self.low_memory { 4096 } else { 32768 };
            if cache.len() >= limit {
                cache.clear();
            }
            cache.insert(value.into(), positions);
        }
    }

    pub fn add(&mut self, row: &Record, id: u32) {
        let author = field(row, "author");
        let title = field(row, "title");
        let series = field(row, "series");
        let ext = field(row, "ext");
        let del = number(row, "del");
        let deleted = del != 0;
        if deleted {
            self.deleted_count += 1;
        } else {
            self.book_count += 1;
            if author.is_empty() {
                self.no_author_count += 1;
            }
        }
        let file = format!("{}/{}.{}", field(row, "folder"), field(row, "file"), ext);
        if deleted {
            self.deleted_files.insert(file);
        } else {
            self.files.insert(file);
        }

        self.add_words("title", title, id, None);
        self.add_words("author", author, id, Some(0));
        self.add_words("series", series, id, Some(1));
        let author = if author.is_empty() { EMPTY } else { author };
        for name in author.split(',') {
            if !self.author.positions.contains_key(lower(name).as_ref()) {
                self.author_count += 1;
            }
            self.author.add_named(name, id, deleted, false);
        }
        if author.contains(',') {
            self.author.add_named(author, id, deleted, false);
        }
        self.series.add_named(series, id, deleted, true);
        self.title.add_named(title, id, deleted, false);
        for genre in field(row, "genre").split(',') {
            self.genre.add_text(genre, id);
        }
        self.lang.add_text(field(row, "lang"), id);
        self.del.add(del, id);
        self.date.add_text(field(row, "date"), id);
        self.librate.add(number(row, "librate"), id);
        self.ext.add_text(ext, id);
        self.source.add_text(field(row, "sourceId"), id);
    }

    pub fn save(self, directory: &Path, facets: &Path) -> Result<CountsSummary> {
        let genre_count = self.genre.rows.len();
        let lang_count = self.lang.rows.len();
        let name_counts = [
            self.author.rows.len(),
            self.series.rows.len(),
            self.title.rows.len(),
            self.word.rows.len(),
        ];
        fn write<K: Serialize>(directory: &Path, name: &str, rows: &[Posting<K>]) -> Result<()> {
            let mut output =
                BufWriter::with_capacity(128 * 1024, File::create_new(directory.join(name))?);
            serde_json::to_writer(&mut output, rows)?;
            output.flush()?;
            Ok(())
        }
        for (name, table) in [
            ("author", self.author),
            ("series", self.series),
            ("title", self.title),
            ("word", self.word),
        ] {
            write(directory, name, &table.rows)?;
        }
        for (name, table) in [
            ("genre", self.genre),
            ("lang", self.lang),
            ("date", self.date),
            ("ext", self.ext),
            ("source", self.source),
        ] {
            write(facets, name, &table.rows)?;
        }
        write(facets, "del", &self.del.rows)?;
        write(facets, "librate", &self.librate.rows)?;
        Ok(CountsSummary {
            files_count: self.files.len(),
            files_del_count: self.deleted_files.difference(&self.files).count(),
            author_count: self.author_count,
            book_count: self.book_count,
            book_del_count: self.deleted_count,
            no_author_book_count: self.no_author_count,
            genre_count,
            lang_count,
            name_counts,
        })
    }
}
