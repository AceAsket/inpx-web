use std::collections::HashMap;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::Result;

#[derive(Deserialize, Serialize)]
pub struct EntityBook {
    pub(crate) id: u32,
    #[serde(rename(deserialize = "_uid"))]
    uid: String,
    title: String,
    #[serde(default)]
    series: Option<String>,
    #[serde(default, rename(deserialize = "serno"))]
    number: Option<f64>,
    #[serde(skip_serializing)]
    pub(crate) del: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct EntityPageRequest {
    order: String,
    completed: Option<String>,
    page: u64,
    limit: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityPage {
    page: usize,
    page_count: usize,
    read: usize,
    next_id: Option<u32>,
    ids: Vec<u32>,
    books: Vec<Box<RawValue>>,
}

impl EntityPageRequest {
    pub(crate) fn prepare(
        self,
        mut read_book: impl FnMut(u32) -> Result<Option<Box<RawValue>>>,
    ) -> Result<EntityPage> {
        if !(1..=100).contains(&self.limit) {
            return Err("invalid catalogue entity page size".into());
        }
        let order = STANDARD.decode(self.order)?;
        let (ids, tail) = order.as_chunks::<4>();
        if !tail.is_empty() {
            return Err("invalid catalogue entity order".into());
        }
        let completed = self
            .completed
            .map(|bits| STANDARD.decode(bits))
            .transpose()?;
        if completed
            .as_ref()
            .is_some_and(|bits| bits.len() != ids.len().div_ceil(8))
        {
            return Err("invalid catalogue entity progress".into());
        }
        let (read, next_id) = if let Some(bits) = completed {
            let mut read = 0;
            let mut next = None;
            for (index, &id) in ids.iter().enumerate() {
                if bits[index / 8] & (1 << (index % 8)) != 0 {
                    read += 1;
                } else if next.is_none() {
                    next = Some(u32::from_le_bytes(id));
                }
            }
            (read, next)
        } else {
            (0, ids.first().copied().map(u32::from_le_bytes))
        };
        let page_count = ids.len().div_ceil(self.limit).max(1);
        let page = self.page.clamp(1, page_count as u64) as usize;
        let start = (page - 1) * self.limit;
        let end = (start + self.limit).min(ids.len());
        let ids: Vec<_> = ids[start..end]
            .iter()
            .copied()
            .map(u32::from_le_bytes)
            .collect();
        let mut books = Vec::with_capacity(ids.len() + 1);
        let wanted = ids
            .iter()
            .copied()
            .chain(next_id.filter(|id| !ids.contains(id)));
        for id in wanted {
            if let Some(book) = read_book(id)? {
                books.push(book);
            }
        }
        Ok(EntityPage {
            page,
            page_count,
            read,
            next_id,
            ids,
            books,
        })
    }
}

#[derive(Deserialize)]
pub(crate) struct SeriesVolume {
    #[serde(rename = "_uid")]
    uid: String,
    #[serde(default)]
    serno: Option<f64>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SeriesVolumes {
    Found { uids: Vec<String> },
    InvalidVolume,
    TooMany,
}

pub(crate) fn series_through(
    mut books: Vec<SeriesVolume>,
    target: &str,
    numbers: HashMap<String, Option<f64>>,
) -> SeriesVolumes {
    for book in &mut books {
        if let Some(number) = numbers.get(book.uid.trim_matches(inpx_reader::js_whitespace)) {
            book.serno = *number;
        }
    }
    let target = books
        .iter()
        .find(|book| book.uid == target)
        .and_then(|book| book.serno);
    let Some(target) = target.filter(|number| number.is_finite() && *number > 0.0) else {
        return SeriesVolumes::InvalidVolume;
    };
    let uids: Vec<_> = books
        .into_iter()
        .filter(|book| {
            book.serno
                .is_some_and(|number| number > 0.0 && number <= target)
        })
        .take(5001)
        .map(|book| book.uid)
        .collect();
    if uids.len() > 5000 {
        SeriesVolumes::TooMany
    } else {
        SeriesVolumes::Found { uids }
    }
}
