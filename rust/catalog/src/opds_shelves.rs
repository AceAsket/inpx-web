use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;

use serde_json::{Map, Value};

use crate::Result;
use crate::lookup::Table;
use crate::reader_state::{FILTERS, normalize_filters, relative_date};
use crate::standalone_catalogue::Catalogue;

const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Grouping {
    Books,
    Authors,
    Series,
}

impl Grouping {
    fn empty_group(self) -> &'static str {
        if self == Self::Authors {
            "Без автора"
        } else {
            "Без серии"
        }
    }
}

pub struct CatalogShelf {
    pub id: String,
    pub name: String,
    pub grouping: Grouping,
    filters: Map<String, Value>,
}

pub fn load(path: &Path) -> Result<Vec<CatalogShelf>> {
    if !fs::metadata(path)?.is_file() {
        return Err("Настройки подборок должны быть обычным файлом".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err("Настройки подборок должны быть обычным файлом".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Файл подборок превышает 256 КиБ".into());
    }
    let data: Value =
        serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))?;
    let entries = data["shelves"]
        .as_array()
        .filter(|rows| rows.len() <= 64 && data["version"] == 1)
        .ok_or("Ожидается version: 1 и массив shelves, не более 64 подборок")?;
    let mut ids = HashSet::new();
    let mut shelves = Vec::new();
    for row in entries.iter().filter(|row| row["active"] != false) {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_id(id) && ids.insert(*id))
            .ok_or("Некорректный или повторяющийся id подборки")?;
        let name = row["name"]
            .as_str()
            .filter(|s| {
                !s.trim().is_empty()
                    && s.encode_utf16().count() <= 100
                    && !s.chars().any(|ch| ch < ' ')
            })
            .ok_or("Задайте название подборки длиной до 100 символов")?;
        let grouping = match row.get("grouping") {
            None => Grouping::Books,
            Some(value) if value == "books" => Grouping::Books,
            Some(value) if value == "authors" => Grouping::Authors,
            Some(value) if value == "series" => Grouping::Series,
            _ => return Err("Некорректная группировка подборки".into()),
        };
        let filters = row["filters"]
            .as_object()
            .ok_or("Задайте filters подборки")?;
        for (key, value) in filters {
            let allowed = if key == "hideCopies" {
                value.is_boolean()
            } else {
                FILTERS.contains(&key.as_str()) && value.is_string()
            };
            if !allowed {
                return Err(format!("Неподдерживаемый фильтр подборки: {key}").into());
            }
        }
        let Value::Object(filters) = normalize_filters(&row["filters"])? else {
            unreachable!("object filters");
        };
        shelves.push(CatalogShelf {
            id: id.into(),
            name: name.trim().into(),
            grouping,
            filters,
        });
    }
    Ok(shelves)
}

fn valid_id(id: &str) -> bool {
    id.len() <= 64
        && id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl CatalogShelf {
    pub fn query(&self) -> Map<String, Value> {
        let mut query = self.filters.clone();
        if let Some(date) = query
            .get("date")
            .and_then(Value::as_str)
            .and_then(relative_date)
        {
            query.insert("date".into(), date.into());
        }
        query
    }
}

pub struct Group {
    pub id: u32,
    pub name: String,
    books: Vec<u32>,
}

impl Group {
    pub fn count(&self) -> usize {
        self.books.len()
    }
}

pub struct Selection {
    pub groups: Vec<Group>,
    books: Vec<u32>,
    generation: String,
}

impl Selection {
    pub fn build(
        catalogue: &Catalogue,
        query: &Map<String, Value>,
        grouping: Grouping,
    ) -> Result<Self> {
        let books = catalogue.filtered_shelf_ids(query)?;
        let generation = catalogue.generation.clone();
        let groups = match grouping {
            Grouping::Books => Vec::new(),
            Grouping::Authors | Grouping::Series => groups(catalogue, &books, grouping)?,
        };
        Ok(Self {
            groups,
            books,
            generation,
        })
    }

    pub fn page(
        &self,
        catalogue: &Catalogue,
        group: Option<&Group>,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<Value>, bool)> {
        if self.generation != catalogue.generation {
            return Err("Каталог обновился. Откройте подборку ещё раз.".into());
        }
        let books = group.map_or(self.books.as_slice(), |group| group.books.as_slice());
        let ids = books
            .iter()
            .skip(offset)
            .take(limit)
            .copied()
            .collect::<Vec<_>>();
        let rows = catalogue.store.catalogue_rows(&self.generation, ids)?;
        Ok((
            rows.into_iter().map(Value::Object).collect(),
            offset.saturating_add(limit) < books.len(),
        ))
    }
}

fn groups(catalogue: &Catalogue, books: &[u32], grouping: Grouping) -> Result<Vec<Group>> {
    let table = if grouping == Grouping::Authors {
        Table::Author
    } else {
        Table::Series
    };
    let positions: HashMap<_, _> = books
        .iter()
        .enumerate()
        .map(|(position, &id)| (id, position))
        .collect();
    let mut represented = HashSet::new();
    let mut groups = Vec::new();
    catalogue.lookup.visit_names(
        &catalogue.lookup_generation,
        table,
        |_| true,
        |id, key, name, _, entries| {
            if id == 0
                || key.is_empty()
                || key == "?"
                || grouping == Grouping::Authors && name.contains(',')
            {
                return Ok(());
            }
            let mut books: Vec<_> = entries
                .iter()
                .copied()
                .map(u32::from_le_bytes)
                .filter(|book| positions.contains_key(book))
                .collect();
            if !books.is_empty() {
                represented.extend(books.iter().copied());
                books.sort_unstable_by_key(|id| positions[id]);
                if grouping == Grouping::Series {
                    books = catalogue
                        .store
                        .order_shelf_volumes(&catalogue.generation, books)?;
                }
                groups.push(Group {
                    id,
                    name: name.into(),
                    books,
                });
            }
            Ok(())
        },
    )?;
    let missing: Vec<_> = books
        .iter()
        .copied()
        .filter(|id| !represented.contains(id))
        .collect();
    if !missing.is_empty() {
        groups.push(Group {
            id: 0,
            name: grouping.empty_group().into(),
            books: missing,
        });
    }
    groups.sort_by_cached_key(|group| (group.name.to_lowercase(), group.id));
    Ok(groups)
}
