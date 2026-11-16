use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, ErrorKind, Write};
use std::ops::RangeInclusive;
use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use redb::ReadOnlyTable;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::{
    Result,
    catalog_query::{BookScope, Copies, Filter, merged_key, merged_key_from_record},
    jemba_identity::BookRows,
    store::decode,
};

type Rows = ReadOnlyTable<u32, &'static [u8]>;
const BOOK_SEQUENCE: &str = "books-sequence.bin";

pub fn seal_book_order(directory: &Path, generation: &str) -> Result<()> {
    let book = directory.join("book");
    let rows = BookRows::open(&book)?;
    write_book_order(directory, generation, rows.ids())
}

pub(crate) fn write_book_order(
    directory: &Path,
    generation: &str,
    ids: impl IntoIterator<Item = u32>,
) -> Result<()> {
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    {
        let mut out = BufWriter::with_capacity(64 * 1024, staged.as_file_mut());
        out.write_all(b"INPXSEQ1")?;
        out.write_all(generation.as_bytes())?;
        for id in ids {
            out.write_all(&id.to_le_bytes())?;
        }
        out.flush()?;
    }
    staged.persist_noclobber(directory.join(BOOK_SEQUENCE))?;
    Ok(())
}

pub(crate) fn source_order(directory: &Path, generation: &str) -> Result<Vec<u32>> {
    match fs::read(directory.join(BOOK_SEQUENCE)) {
        Ok(data) => {
            let seq = data
                .strip_prefix(b"INPXSEQ1")
                .and_then(|value| value.strip_prefix(generation.as_bytes()))
                .ok_or("catalogue sequence generation differs")?;
            let (ids, remainder) = seq.as_chunks::<4>();
            if !remainder.is_empty() {
                return Err("invalid catalogue sequence length".into());
            }
            Ok(ids.iter().copied().map(u32::from_le_bytes).collect())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            Ok(BookRows::open(&directory.join("book"))?.ids().collect())
        }
        Err(error) => Err(error.into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WideSearch {
    order_key: String,
    ids: Option<String>,
    limit: usize,
    terms: [Vec<[String; 2]>; 3],
    filters: Vec<Filter>,
    source: Option<String>,
    copies: Copies,
}

impl WideSearch {
    pub(crate) fn order_key(&self) -> &str {
        &self.order_key
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WideResult {
    ids: Vec<u32>,
    total_found: usize,
}

#[derive(Clone, Copy)]
struct Key {
    author: u32,
    series: u32,
    title: u32,
    serno: f64,
    order: u32,
}

impl Key {
    fn fields(self, other: Self) -> Ordering {
        self.author
            .cmp(&other.author)
            .then_with(|| self.series.cmp(&other.series))
            .then_with(|| {
                self.serno
                    .partial_cmp(&other.serno)
                    .expect("finite series numbers")
            })
            .then_with(|| self.title.cmp(&other.title))
    }

    fn cmp(self, other: Self) -> Ordering {
        self.fields(other)
            .then_with(|| self.order.cmp(&other.order))
    }
}

struct Rank {
    id: u32,
    key: Key,
    deleted: f64,
}

pub(crate) struct WideOrder {
    rows: Vec<Rank>,
}

impl WideOrder {
    pub fn open(directory: &Path, key: &str, generation: &str) -> Result<Self> {
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid catalogue order identifier".into());
        }
        let bytes = fs::read(directory.join(format!("book-order-{key}.bin")))?;
        let content = bytes
            .strip_prefix(b"INPXORD1")
            .and_then(|bytes| bytes.strip_prefix(generation.as_bytes()))
            .ok_or("catalogue order generation differs")?;
        let (rows, extra) = content.as_chunks::<36>();
        if !extra.is_empty() {
            return Err("invalid catalogue order length".into());
        }
        let mut previous = None;
        let mut result = Vec::with_capacity(rows.len());
        for bytes in rows {
            let n = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let id = n(0);
            let serno = f64::from_le_bytes(bytes[20..28].try_into()?);
            let deleted = f64::from_le_bytes(bytes[28..36].try_into()?);
            if previous.is_some_and(|old| id <= old) || !serno.is_finite() || !deleted.is_finite() {
                return Err("invalid catalogue order row".into());
            }
            previous = Some(id);
            result.push(Rank {
                id,
                key: Key {
                    author: n(4),
                    series: n(8),
                    title: n(12),
                    order: n(16),
                    serno,
                },
                deleted,
            });
        }
        Ok(Self { rows: result })
    }
}

pub(crate) fn visit_rows(
    records: &Rows,
    updated: Option<&Rows>,
    bounds: RangeInclusive<u32>,
    read: &mut impl FnMut(u32, &[u8]) -> Result<()>,
) -> Result<()> {
    let mut patch = updated
        .map(|table| table.range::<u32>(bounds.clone()))
        .transpose()?
        .into_iter()
        .flatten();
    let mut change = patch.next().transpose()?;
    for entry in records.range::<u32>(bounds)? {
        let (id, row) = entry?;
        let id = id.value();
        while change.as_ref().is_some_and(|(other, _)| other.value() < id) {
            let (other, value) = change.take().unwrap();
            if !value.value().is_empty() {
                read(other.value(), value.value())?;
            }
            change = patch.next().transpose()?;
        }
        if change
            .as_ref()
            .is_some_and(|(other, _)| other.value() == id)
        {
            let (_, value) = change.take().unwrap();
            if !value.value().is_empty() {
                read(id, value.value())?;
            }
            change = patch.next().transpose()?;
        } else {
            read(id, row.value())?;
        }
    }
    if let Some((id, row)) = change
        && !row.value().is_empty()
    {
        read(id.value(), row.value())?;
    }
    for item in patch {
        let (id, row) = item?;
        if !row.value().is_empty() {
            read(id.value(), row.value())?;
        }
    }
    Ok(())
}

fn candidate_ranges(positions: Option<&HashMap<u32, u32>>, len: usize) -> Vec<RangeInclusive<u32>> {
    let Some(positions) = positions.filter(|values| values.len() < len / 2) else {
        return std::iter::once(0..=u32::MAX).collect();
    };
    let mut ids: Vec<_> = positions.keys().copied().collect();
    ids.sort_unstable();
    let mut groups = Vec::new();
    for run in ids.chunk_by(|left, right| right - left <= 48) {
        groups.push(run[0]..=*run.last().unwrap());
    }
    groups
}

#[derive(Deserialize)]
struct Projection<'a> {
    #[serde(borrow)]
    physical: Cow<'a, str>,
    score: f64,
    #[serde(borrow)]
    words: Option<&'a RawValue>,
}

struct Candidate {
    id: u32,
    key: Key,
    score: f64,
    copy: Option<String>,
}

impl Candidate {
    fn preferred(&self, other: &Self) -> bool {
        self.score > other.score || self.score == other.score && self.id < other.id
    }
}

fn candidate_order(encoded: Option<String>) -> Result<Option<HashMap<u32, u32>>> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let bytes = STANDARD.decode(encoded)?;
    let (ids, extra) = bytes.as_chunks::<4>();
    if !extra.is_empty() || ids.len() > 2_000_000 {
        return Err("invalid broad search candidates".into());
    }
    let mut order = HashMap::with_capacity(ids.len());
    for (offset, id) in ids.iter().enumerate() {
        order
            .entry(u32::from_le_bytes(*id))
            .or_insert(offset as u32);
    }
    Ok(Some(order))
}

pub(crate) fn search(
    records: &Rows,
    updated: Option<&Rows>,
    order: &WideOrder,
    request: WideSearch,
) -> Result<WideResult> {
    use std::collections::hash_map::Entry;
    let positions = candidate_order(request.ids)?;
    let use_terms = request.terms.iter().any(|terms| !terms.is_empty());
    let (del,filters):(Vec<_>,Vec<_>) = request.filters.iter().partition(|filter|
        matches!(filter,Filter::NumberValues{field,..}|Filter::NumberRange{field,..} if field == "del"));
    let use_record =
        request.source.is_some() || !filters.is_empty() || request.copies != Copies::Physical;
    let scope_only = use_record
        && request.copies == Copies::Physical
        && filters.iter().all(|filter| filter.scope_only());
    let copy_only =
        request.copies != Copies::Physical && request.source.is_none() && filters.is_empty();
    let mut ranks = order.rows.iter().peekable();
    let capacity = if filters.is_empty() && !use_terms && request.source.is_none() {
        positions.as_ref().map_or(order.rows.len(), HashMap::len)
    } else {
        0
    };
    let mut found = HashMap::<String, Candidate>::with_capacity(capacity);
    let mut read =
        |id, value: &[u8]| {
            while ranks.peek().is_some_and(|rank| rank.id < id) {
                ranks.next();
            }
            let rank = ranks
                .next()
                .filter(|rank| rank.id == id)
                .ok_or("catalogue order does not cover the active store")?;
            let mut key = rank.key;
            if let Some(positions) = &positions {
                let Some(&position) = positions.get(&id) else {
                    return Ok(());
                };
                key.order = position;
            }
            if del.iter().any(|filter| match filter {
                Filter::NumberValues { values, .. } => !values.contains(&rank.deleted),
                Filter::NumberRange { from, to, .. } => rank.deleted < *from || rank.deleted > *to,
                _ => unreachable!(),
            }) {
                return Ok(());
            }
            let (record, projection) = decode(value)?;
            let projection: Projection = serde_json::from_slice(projection)?;
            if use_terms {
                let words: [Vec<String>; 3] =
                    serde_json::from_str(projection.words.ok_or("missing catalogue terms")?.get())?;
                if !request.terms.iter().zip(&words).all(|(wanted, words)| {
                    wanted.iter().all(|term| {
                        words.as_chunks::<2>().0.iter().any(|word| {
                            word[0].starts_with(&term[0]) || word[1].starts_with(&term[1])
                        })
                    })
                }) {
                    return Ok(());
                }
            }
            let copy =
                if scope_only {
                    let scope: BookScope = serde_json::from_slice(record)?;
                    if request
                        .source
                        .as_ref()
                        .is_some_and(|source| scope.source.as_deref().unwrap_or_default() != source)
                        || !filters.iter().all(|filter| filter.matches_scope(&scope))
                    {
                        return Ok(());
                    }
                    None
                } else if copy_only {
                    Some(merged_key_from_record(record)?)
                } else if use_record {
                    let row: inpx_reader::Record = serde_json::from_slice(record)?;
                    if request.source.as_ref().is_some_and(|source| {
                        crate::catalog_text::field(&row, "sourceId") != source
                    }) || !filters.iter().all(|filter| filter.matches(&row))
                    {
                        return Ok(());
                    }
                    (request.copies != Copies::Physical).then(|| merged_key(&row))
                } else {
                    None
                };
            let (group, copy) = if request.copies == Copies::Merge {
                (copy.expect("source-independent copy key"), None)
            } else {
                (projection.physical.into_owned(), copy)
            };
            let mut candidate = Candidate {
                id,
                key,
                score: projection.score,
                copy,
            };
            match found.entry(group) {
                Entry::Vacant(entry) => {
                    entry.insert(candidate);
                }
                Entry::Occupied(mut entry) => {
                    let stored = entry.get_mut();
                    let first = candidate.key.order.min(stored.key.order);
                    if candidate.preferred(stored) {
                        candidate.key.order = first;
                        *stored = candidate;
                    } else {
                        stored.key.order = first;
                    }
                }
            }
            Ok(())
        };
    for bounds in candidate_ranges(positions.as_ref(), order.rows.len()) {
        visit_rows(records, updated, bounds, &mut read)?;
    }
    if positions.is_none() && ranks.next().is_some() {
        return Err("catalogue order contains inactive books".into());
    }

    let mut result: Vec<(Candidate, Key)> = if request.copies == Copies::Ranked {
        let mut groups = HashMap::<String, (Candidate, Key)>::new();
        for mut row in found.into_values() {
            let key = row.copy.take().expect("ranked copy key");
            match groups.entry(key) {
                Entry::Vacant(entry) => {
                    let first = row.key;
                    entry.insert((row, first));
                }
                Entry::Occupied(mut entry) => {
                    let (preferred, first) = entry.get_mut();
                    if row.key.cmp(*first).is_lt() {
                        *first = row.key;
                    }
                    if row.preferred(preferred) {
                        *preferred = row;
                    }
                }
            }
        }
        groups.into_values().collect()
    } else {
        found
            .into_values()
            .map(|row| {
                let key = row.key;
                (row, key)
            })
            .collect()
    };
    let total_found = result.len();
    let compare = |a: &(Candidate, Key), b: &(Candidate, Key)| {
        a.0.key.fields(b.0.key).then_with(|| a.1.cmp(b.1))
    };
    if request.limit > 0 && request.limit < result.len() {
        result.select_nth_unstable_by(request.limit, compare);
        result.truncate(request.limit);
    }
    result.sort_unstable_by(compare);
    Ok(WideResult {
        ids: result.into_iter().map(|(row, _)| row.id).collect(),
        total_found,
    })
}
