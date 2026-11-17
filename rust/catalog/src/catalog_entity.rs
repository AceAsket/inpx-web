use std::collections::HashSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use icu_collator::Collator;
use icu_locale_core::locale;
use inpx_reader::js_whitespace;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use unicode_normalization::UnicodeNormalization;

use crate::Result;

pub(crate) fn normalize_entity_text(value: &str) -> String {
    let normalized: String = value.nfkc().collect();
    normalized
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Deserialize, Serialize)]
pub struct EntityBook {
    pub(crate) id: u32,
    #[serde(rename(deserialize = "_uid"))]
    pub(crate) uid: String,
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
    #[serde(flatten)]
    selection: EntitySelection,
    books: Vec<Box<RawValue>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitySelection {
    pub page: usize,
    pub page_count: usize,
    pub read: usize,
    pub next_id: Option<u32>,
    pub ids: Vec<u32>,
}

impl EntitySelection {
    pub fn new(
        ordered: &[u32],
        page: u64,
        limit: usize,
        mut completed: impl FnMut(usize) -> bool,
    ) -> Result<Self> {
        if !(1..=100).contains(&limit) {
            return Err("invalid catalogue entity page size".into());
        }
        let mut read = 0;
        let mut next_id = None;
        for (index, &id) in ordered.iter().enumerate() {
            if completed(index) {
                read += 1;
            } else {
                next_id.get_or_insert(id);
            }
        }
        let page_count = ordered.len().div_ceil(limit).max(1);
        let page = page.clamp(1, page_count as u64) as usize;
        let start = (page - 1) * limit;
        let end = (start + limit).min(ordered.len());
        Ok(Self {
            page,
            page_count,
            read,
            next_id,
            ids: ordered[start..end].to_vec(),
        })
    }

    pub fn wanted(&self) -> impl Iterator<Item = u32> + '_ {
        self.ids
            .iter()
            .copied()
            .chain(self.next_id.filter(|id| !self.ids.contains(id)))
    }
}

pub(crate) fn order_entity(rows: &mut [EntityBook], author: bool) -> Result<Vec<String>> {
    let names = Collator::try_new(locale!("ru").into(), Default::default())?;
    let uids = Collator::try_new(locale!("en").into(), Default::default())?;
    rows.sort_by(|left, right| {
        let series = if author {
            names.compare(
                left.series.as_deref().unwrap_or_default(),
                right.series.as_deref().unwrap_or_default(),
            )
        } else {
            std::cmp::Ordering::Equal
        };
        series
            .then_with(|| {
                left.number
                    .unwrap_or_default()
                    .total_cmp(&right.number.unwrap_or_default())
            })
            .then_with(|| names.compare(&left.title, &right.title))
            .then_with(|| uids.compare(&left.uid, &right.uid))
    });
    if !author {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    Ok(rows
        .iter()
        .filter_map(|row| row.series.as_deref())
        .filter(|series| !series.is_empty() && seen.insert(*series))
        .take(200)
        .map(str::to_owned)
        .collect())
}

impl EntityPageRequest {
    pub(crate) fn prepare(
        self,
        mut read_book: impl FnMut(u32) -> Result<Option<Box<RawValue>>>,
    ) -> Result<EntityPage> {
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
        let ordered: Vec<_> = ids.iter().copied().map(u32::from_le_bytes).collect();
        let selection = EntitySelection::new(&ordered, self.page, self.limit, |index| {
            completed
                .as_ref()
                .is_some_and(|bits| bits[index / 8] & (1 << (index % 8)) != 0)
        })?;
        let mut books = Vec::with_capacity(selection.ids.len() + 1);
        for id in selection.wanted() {
            if let Some(book) = read_book(id)? {
                books.push(book);
            }
        }
        Ok(EntityPage { selection, books })
    }
}

#[derive(Deserialize)]
pub(crate) struct SeriesVolume {
    #[serde(rename = "_uid")]
    uid: String,
    #[serde(default)]
    serno: Option<f64>,
    #[serde(default)]
    pub(crate) del: Option<i64>,
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
    numbers: impl Fn(&str) -> Option<Option<f64>>,
) -> SeriesVolumes {
    for book in &mut books {
        if let Some(number) = numbers(book.uid.trim_matches(js_whitespace)) {
            book.serno = number;
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
