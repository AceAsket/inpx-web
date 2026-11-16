use std::collections::HashSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::Result;

#[derive(Deserialize, Serialize)]
#[serde(tag = "format", content = "data", rename_all = "lowercase")]
pub enum BrowseFilter {
    Bitmap(String),
    Ids(String),
}

pub(crate) enum SelectedBooks {
    Bitmap(Vec<u8>),
    Ids(HashSet<u32>),
}

impl BrowseFilter {
    pub(crate) fn decode(self) -> Result<SelectedBooks> {
        match self {
            Self::Bitmap(data) => Ok(SelectedBooks::Bitmap(STANDARD.decode(data)?)),
            Self::Ids(data) => {
                let bytes = STANDARD.decode(data)?;
                let (ids, tail) = bytes.as_chunks::<4>();
                if !tail.is_empty() {
                    return Err("invalid catalogue book selection".into());
                }
                Ok(SelectedBooks::Ids(
                    ids.iter().copied().map(u32::from_le_bytes).collect(),
                ))
            }
        }
    }
}

impl SelectedBooks {
    pub(crate) fn from_postings(rows: Vec<&[u32]>, previous: Option<&Self>) -> Self {
        let count: usize = rows.iter().map(|row| row.len()).sum();
        if count == 0 || previous.is_some_and(Self::is_empty) {
            return Self::Bitmap(Vec::new());
        }
        let bitmap_len = if let Some(Self::Bitmap(bitmap)) = previous {
            bitmap.len()
        } else {
            rows.iter()
                .flat_map(|row| row.iter())
                .max()
                .map_or(0, |id| (id / 8) as usize + 1)
        };
        let ids = rows
            .into_iter()
            .flatten()
            .copied()
            .filter(|id| previous.is_none_or(|selection| selection.contains(*id)));
        if bitmap_len <= count.saturating_mul(4) {
            let mut bitmap = vec![0; bitmap_len];
            for id in ids {
                bitmap[(id / 8) as usize] |= 1 << (id % 8);
            }
            Self::Bitmap(bitmap)
        } else {
            Self::Ids(ids.collect())
        }
    }

    pub(crate) fn encode(self) -> BrowseFilter {
        match self {
            Self::Bitmap(mut data) => {
                let used = data
                    .iter()
                    .rposition(|byte| *byte != 0)
                    .map_or(0, |index| index + 1);
                data.truncate(used);
                BrowseFilter::Bitmap(STANDARD.encode(data))
            }
            Self::Ids(ids) => {
                let data: Vec<u8> = ids.into_iter().flat_map(u32::to_le_bytes).collect();
                BrowseFilter::Ids(STANDARD.encode(data))
            }
        }
    }

    pub(crate) fn contains(&self, id: u32) -> bool {
        match self {
            Self::Bitmap(data) => data
                .get((id / 8) as usize)
                .is_some_and(|bits| bits & (1 << (id % 8)) != 0),
            Self::Ids(ids) => ids.contains(&id),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        match self {
            Self::Bitmap(data) => data.iter().all(|&byte| byte == 0),
            Self::Ids(ids) => ids.is_empty(),
        }
    }
}

const ITEM_LIMIT: usize = 200;

#[derive(Default, Serialize)]
pub struct BrowseResult {
    total: usize,
    groups: Vec<BrowseGroup>,
    items: Vec<BrowseItem>,
}

#[derive(Default, Serialize)]
struct BrowseGroup {
    prefix: String,
    count: usize,
    books: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize)]
struct BrowseItem {
    name: String,
    count: u64,
}

#[derive(Default)]
pub(crate) struct BrowseResults {
    groups: IndexMap<String, BrowseGroup>,
    items: Vec<BrowseItem>,
    total: usize,
}

impl BrowseResults {
    pub(crate) fn add(&mut self, suffix: &str, name: &str, count: u64) {
        if count == 0 {
            return;
        }
        self.total += 1;
        if self.items.len() < ITEM_LIMIT {
            self.items.push(BrowseItem {
                name: name.into(),
                count,
            });
        }
        let end = suffix
            .char_indices()
            .find_map(|(index, ch)| {
                (!inpx_reader::js_whitespace(ch)).then_some(index + ch.len_utf8())
            })
            .unwrap_or(suffix.len());
        let key = &suffix[..end];
        let group = if let Some(row) = self.groups.get_mut(key) {
            row
        } else {
            self.groups.entry(key.to_owned()).or_default()
        };
        if suffix.is_empty() {
            group.name = Some(name.into());
        }
        group.count += 1;
        group.books += count;
    }

    pub(crate) fn finish(self, prefix: &str) -> BrowseResult {
        let all_items = self.total <= ITEM_LIMIT;
        BrowseResult {
            total: self.total,
            groups: if all_items {
                Vec::new()
            } else {
                self.groups
                    .into_iter()
                    .map(|(suffix, mut row)| {
                        row.prefix = format!("{prefix}{suffix}");
                        row
                    })
                    .collect()
            },
            items: if all_items { self.items } else { Vec::new() },
        }
    }
}
