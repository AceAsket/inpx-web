use std::fs::{self, File};
use std::io::{BufRead, BufWriter, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serializer, ser::SerializeSeq};

use crate::Result;
use crate::framed_protocol::header;
use crate::lookup::{Posting, Table, build_lookup_with_cache};

const MAGIC: &[u8; 4] = b"LKP1";
const ROW_HEADER: usize = 24;

pub(crate) struct StagedPosting<'a> {
    pub id: usize,
    pub label: &'a str,
    pub name: &'a str,
    pub active: u32,
    pub deleted: u32,
    pub books: &'a [u32],
}

pub(crate) fn write_table<'a>(
    directory: &Path,
    name: &str,
    rows: impl ExactSizeIterator<Item = StagedPosting<'a>>,
) -> Result<()> {
    let count = rows.len();
    let mut packed = BufWriter::with_capacity(128 * 1024, File::create_new(directory.join(name))?);
    packed.write_all(MAGIC)?;
    packed.write_all(&u32::try_from(count)?.to_le_bytes())?;
    let mut labels = BufWriter::with_capacity(
        128 * 1024,
        File::create_new(directory.join(format!("{name}.labels")))?,
    );
    let mut json = serde_json::Serializer::new(&mut labels);
    let mut sequence = json.serialize_seq(Some(count))?;
    for row in rows {
        let lengths = [
            u32::try_from(row.id)?,
            u32::try_from(row.label.len())?,
            u32::try_from(row.name.len())?,
            u32::try_from(row.books.len())?,
            row.active,
            row.deleted,
        ];
        for value in lengths {
            packed.write_all(&value.to_le_bytes())?;
        }
        packed.write_all(row.label.as_bytes())?;
        packed.write_all(row.name.as_bytes())?;
        for book in row.books {
            packed.write_all(&book.to_le_bytes())?;
        }
        sequence.serialize_element(row.label)?;
    }
    sequence.end()?;
    labels.flush()?;
    packed.flush()?;
    Ok(())
}

struct PackedRow<'a> {
    id: u32,
    label: &'a [u8],
    name: &'a [u8],
    books: &'a [u8],
    active: u32,
    deleted: u32,
}

fn split_row(data: &[u8]) -> Result<(PackedRow<'_>, &[u8])> {
    let (metadata, tail) = data
        .split_first_chunk::<ROW_HEADER>()
        .ok_or("missing staged lookup row")?;
    let fields = metadata.as_chunks::<4>().0;
    let [id, label_len, name_len, book_count, active, deleted]: [u32; 6] =
        std::array::from_fn(|index| u32::from_le_bytes(fields[index]));
    let (label, tail) = tail
        .split_at_checked(label_len as usize)
        .ok_or("invalid staged lookup label length")?;
    let (name, tail) = tail
        .split_at_checked(name_len as usize)
        .ok_or("invalid staged lookup name length")?;
    let book_bytes = (book_count as usize)
        .checked_mul(4)
        .ok_or("staged lookup book count is too large")?;
    let (books, tail) = tail
        .split_at_checked(book_bytes)
        .ok_or("invalid staged lookup book count")?;
    Ok((
        PackedRow {
            id,
            label,
            name,
            books,
            active,
            deleted,
        },
        tail,
    ))
}

struct OrderedTable {
    table: Table,
    data: Vec<u8>,
    offsets: Vec<usize>,
    positions: std::vec::IntoIter<u32>,
    omitted: Vec<u8>,
    rank: u32,
}

impl OrderedTable {
    fn open(directory: &Path, table: Table, count: u32, input: &mut impl Read) -> Result<Self> {
        let data = fs::read(directory.join(table.name()))?;
        let tail = data
            .strip_prefix(MAGIC)
            .ok_or("invalid staged lookup format")?;
        let (size, mut tail) = tail
            .split_first_chunk::<4>()
            .ok_or("missing staged lookup row count")?;
        let length = count as usize;
        if u32::from_le_bytes(*size) != count || tail.len() / ROW_HEADER < length {
            return Err("staged lookup row count differs".into());
        }
        let mut offsets = Vec::with_capacity(length);
        for _ in 0..count {
            offsets.push(data.len() - tail.len());
            tail = split_row(tail)?.1;
        }
        if !tail.is_empty() {
            return Err("unexpected data after staged lookup table".into());
        }

        // The order uses zero-based ordinals, in the application's stable locale order.
        let order_len = length
            .checked_mul(4)
            .ok_or("staged lookup order is too large")?;
        let mut order = vec![0; order_len];
        input.read_exact(&mut order)?;
        let mut seen = vec![false; length];
        let mut positions = Vec::with_capacity(length);
        for &bytes in order.as_chunks::<4>().0 {
            let position = u32::from_le_bytes(bytes);
            let visited = seen
                .get_mut(position as usize)
                .ok_or("invalid staged lookup ordinal")?;
            if std::mem::replace(visited, true) {
                return Err("duplicate staged lookup ordinal".into());
            }
            positions.push(position);
        }
        let mut omitted = vec![
            0;
            if table == Table::Series {
                length.div_ceil(8)
            } else {
                0
            }
        ];
        input.read_exact(&mut omitted)?;
        Ok(Self {
            table,
            data,
            offsets,
            positions: positions.into_iter(),
            omitted,
            rank: 0,
        })
    }

    fn posting(&self, position: u32, rank: u32) -> Result<Posting> {
        let (row, _) = split_row(&self.data[self.offsets[position as usize]..])?;
        let label = std::str::from_utf8(row.label)?.to_owned();
        let word = self.table == Table::Word;
        let ordinal = (rank - 1) as usize;
        let omit = self
            .omitted
            .get(ordinal / 8)
            .is_some_and(|mask| mask & (1 << (ordinal % 8)) != 0);
        Ok(Posting {
            table: self.table,
            id: if word { row.id } else { rank },
            name: if word {
                label.clone()
            } else {
                std::str::from_utf8(row.name)?.to_owned()
            },
            value: Some(label),
            count: row.active,
            deleted: (!word).then_some(row.deleted),
            omit_from_book_map: omit,
            book_ids: row
                .books
                .as_chunks::<4>()
                .0
                .iter()
                .copied()
                .map(u32::from_le_bytes)
                .collect(),
        })
    }
}

impl Iterator for OrderedTable {
    type Item = Result<Posting>;

    fn next(&mut self) -> Option<Self::Item> {
        let position = self.positions.next()?;
        self.rank += 1;
        Some(self.posting(position, self.rank))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupHeader {
    generation: String,
    name_counts: [u32; 4],
    #[serde(default)]
    low_memory: bool,
}

pub fn publish(path: &Path, mut input: impl BufRead) -> Result<u64> {
    let LookupHeader {
        generation,
        name_counts,
        low_memory,
    } = header(&mut input)?.ok_or("missing staged lookup header")?;
    let directory = path
        .parent()
        .ok_or("missing catalogue lookup directory")?
        .join(".postings");
    let mut tables = Table::ALL.into_iter().zip(name_counts);
    let mut current: Option<OrderedTable> = None;
    let mut checked_end = false;
    let rows = std::iter::from_fn(|| {
        loop {
            if let Some(row) = current.as_mut().and_then(Iterator::next) {
                return Some(row);
            }
            current = None;
            if let Some((table, count)) = tables.next() {
                match OrderedTable::open(&directory, table, count, &mut input) {
                    Ok(table) => current = Some(table),
                    Err(error) => return Some(Err(error)),
                }
            } else {
                if !checked_end {
                    checked_end = true;
                    match input.fill_buf() {
                        Ok([]) => (),
                        Ok(_) => {
                            return Some(Err("unexpected data after staged lookup order".into()));
                        }
                        Err(error) => return Some(Err(error.into())),
                    }
                }
                return None;
            }
        }
    });
    build_lookup_with_cache(
        path,
        &generation,
        name_counts.into_iter().map(u64::from).sum(),
        true,
        low_memory,
        rows,
    )
}

pub(crate) fn publish_sorted(
    path: &Path,
    generation: &str,
    name_counts: [usize; 4],
    low_memory: bool,
) -> Result<usize> {
    let directory = path
        .parent()
        .ok_or("missing catalogue lookup directory")?
        .join(".postings");
    let mut input = serde_json::to_vec(
        &serde_json::json!({"generation":generation,"nameCounts":name_counts,"lowMemory":low_memory}),
    )?;
    input.push(b'\n');
    let mut series = name_counts[1];
    for (table, count) in Table::ALL.into_iter().zip(name_counts) {
        let labels: Vec<String> = serde_json::from_reader(File::open(
            directory.join(format!("{}.labels", table.name())),
        )?)?;
        if labels.len() != count {
            return Err("staged lookup label count differs".into());
        }
        let mut positions = (0..u32::try_from(count)?).collect::<Vec<_>>();
        positions.sort_by(|&left, &right| {
            labels[left as usize]
                .encode_utf16()
                .cmp(labels[right as usize].encode_utf16())
        });
        let mut omitted = (table == Table::Series).then(|| vec![0u8; count.div_ceil(8)]);
        for (rank, position) in positions.into_iter().enumerate() {
            input.extend_from_slice(&position.to_le_bytes());
            if let Some(omitted) = &mut omitted
                && labels[position as usize] == "?"
            {
                omitted[rank / 8] |= 1 << (rank % 8);
                series -= 1;
            }
        }
        if let Some(omitted) = omitted {
            input.extend_from_slice(&omitted);
        }
    }
    publish(path, input.as_slice())?;
    Ok(series)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_ordinals_leave_the_lookup_unpublished() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let staging = temporary.path().join(".postings");
        fs::create_dir(&staging)?;
        write_table(
            &staging,
            "author",
            ["first", "second"]
                .into_iter()
                .enumerate()
                .map(|(id, name)| StagedPosting {
                    id,
                    label: name,
                    name,
                    active: 1,
                    deleted: 0,
                    books: &[1],
                }),
        )?;
        let mut input = b"{\"generation\":\"fixture\",\"nameCounts\":[2,0,0,0]}\n".to_vec();
        input.extend_from_slice(&0u32.to_le_bytes());
        input.extend_from_slice(&0u32.to_le_bytes());
        let path = temporary.path().join("lookup.redb");
        assert!(
            publish(&path, input.as_slice())
                .unwrap_err()
                .to_string()
                .contains("duplicate staged lookup ordinal")
        );
        assert!(!path.exists());
        Ok(())
    }
}
