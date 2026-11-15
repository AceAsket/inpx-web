//! Bulk snapshot for the uncompressed basic table in JembaDB 5.1.7.
//! The last block remains appendable so the catalogue can be updated by JembaDB.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue};
use sha2::{Digest, Sha256};

use crate::Result;

const BLOCK_BYTES: usize = 1024 * 1024;
const BUFFER_BYTES: usize = 128 * 1024;

fn output(path: &Path) -> Result<BufWriter<File>> {
    Ok(BufWriter::with_capacity(
        BUFFER_BYTES,
        File::create_new(path)?,
    ))
}

fn write_snapshot(path: &Path, data: &impl Serialize) -> Result<()> {
    let mut file = output(path)?;
    file.write_all(b"1")?;
    serde_json::to_writer(&mut file, data)?;
    file.flush()?;
    Ok(())
}

struct Array {
    file: BufWriter<File>,
    first: bool,
}

impl Array {
    fn new(path: &Path, prefix: &[u8]) -> Result<Self> {
        let mut file = output(path)?;
        file.write_all(prefix)?;
        Ok(Self { file, first: true })
    }

    fn push(&mut self, value: &impl Serialize) -> Result<()> {
        if !self.first {
            self.file.write_all(b",")?;
        }
        self.first = false;
        serde_json::to_writer(&mut self.file, value)?;
        Ok(())
    }

    fn finish(mut self, sorted: Option<&RawValue>) -> Result<()> {
        self.file.write_all(b"]")?;
        if let Some(sorted) = sorted {
            self.file.write_all(b",\"sorted\":")?;
            self.file.write_all(sorted.get().as_bytes())?;
            self.file.write_all(b",\"delCount\":0}")?;
        }
        self.file.flush()?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockInfo {
    index: usize,
    del_count: u32,
    add_count: u32,
    rows: Option<()>,
    size: usize,
    rows_length: u32,
    #[serde(rename = "final")]
    finalized: bool,
}

struct Block {
    file: BufWriter<File>,
    info: BlockInfo,
}

impl Block {
    fn new(directory: &Path, index: usize) -> Result<Self> {
        let width = if index < 1_000_000 { 6 } else { 12 };
        let mut file = output(&directory.join(format!("{index:0width$}.jem")))?;
        file.write_all(b"0[")?;
        Ok(Self {
            file,
            info: BlockInfo {
                index,
                del_count: 0,
                add_count: 0,
                rows: None,
                size: 2,
                rows_length: 0,
                finalized: false,
            },
        })
    }

    fn push(&mut self, id: u32, data: &RawValue, add_book_hash: bool) -> Result<()> {
        let prefix = format!("[{id},");
        self.file.write_all(prefix.as_bytes())?;
        let body = data.get();
        let row_bytes = if add_book_hash {
            let fields = body
                .strip_suffix('}')
                .ok_or("invalid JSON object for book hash")?;
            let separator = if fields[1..].trim().is_empty() {
                ""
            } else {
                ","
            };
            let suffix = format!(
                "{separator}\"_recordHash\":\"{:x}\",\"id\":{id}}}],",
                Sha256::digest(body.as_bytes())
            );
            self.file.write_all(fields.as_bytes())?;
            self.file.write_all(suffix.as_bytes())?;
            fields.len() + suffix.len()
        } else {
            self.file.write_all(body.as_bytes())?;
            self.file.write_all(b"],")?;
            body.len() + 2
        };
        self.info.size += prefix.len() + row_bytes;
        self.info.add_count += 1;
        self.info.rows_length += 1;
        Ok(())
    }

    fn finish(mut self, finalized: bool) -> Result<BlockInfo> {
        if finalized {
            self.file.seek(SeekFrom::End(-1))?;
            self.file.write_all(b"]")?;
            self.file.seek(SeekFrom::Start(0))?;
            self.file.write_all(b"1")?;
            self.info.finalized = true;
        }
        self.file.flush()?;
        Ok(self.info)
    }
}

#[derive(Deserialize)]
struct InputRow<'a>(
    u32,
    #[serde(borrow)] &'a RawValue,
    #[serde(borrow)] &'a RawValue,
    #[serde(default)] bool,
);

/// Input rows are JSON tuples [numeric id, unique book UID, encoded book].
/// An explicit completion record prevents publishing a truncated import.
pub fn build_book_table(
    path: &Path,
    mut input: impl BufRead,
    mut status: impl Write,
) -> Result<u32> {
    build_table(path, &mut input, &mut status, TableKind::Book)
}

/// Secondary rows use the same tuples with a value key. Jemba's comparator
/// determines the sorted runs, supplied as the final JSON line.
pub fn build_index_table(
    path: &Path,
    mut input: impl BufRead,
    mut status: impl Write,
) -> Result<u32> {
    build_table(path, &mut input, &mut status, TableKind::Text)
}

pub fn build_number_index_table(
    path: &Path,
    mut input: impl BufRead,
    mut status: impl Write,
) -> Result<u32> {
    build_table(path, &mut input, &mut status, TableKind::Number)
}

#[derive(Clone, Copy, PartialEq)]
enum TableKind {
    Book,
    Text,
    Number,
}

pub(crate) struct TableWriter {
    stage: tempfile::TempDir,
    ids: Array,
    keys: Array,
    blocks: Vec<BlockInfo>,
    block: Option<Block>,
    kind: TableKind,
    count: u32,
}

impl TableWriter {
    fn new(path: &Path, kind: TableKind) -> Result<Self> {
        let parent = path.parent().ok_or("missing JembaDB table directory")?;
        if path.try_exists()? {
            return Err("JembaDB table already exists".into());
        }
        let stage = tempfile::Builder::new()
            .prefix(".jemba-")
            .tempdir_in(parent)?;
        let directory = stage.path();
        let ids = Array::new(&directory.join("blockindex.0"), b"1[")?;
        let (key_file, key_prefix): (&str, &[u8]) = if kind != TableKind::Book {
            ("index1.0", b"1{\"hash\":[")
        } else {
            ("hash1.0", b"1[")
        };
        let keys = Array::new(&directory.join(key_file), key_prefix)?;
        Ok(Self {
            stage,
            ids,
            keys,
            blocks: Vec::new(),
            block: None,
            kind,
            count: 0,
        })
    }

    pub(crate) fn add(
        &mut self,
        id: u32,
        key: &impl Serialize,
        row: &RawValue,
        add_book_hash: bool,
    ) -> Result<()> {
        if self
            .block
            .as_ref()
            .is_some_and(|block| block.info.size > BLOCK_BYTES)
        {
            self.blocks
                .push(self.block.take().expect("open block").finish(true)?);
        }
        if self.block.is_none() {
            self.block = Some(Block::new(self.stage.path(), self.blocks.len() + 1)?);
        }
        let current = self.block.as_mut().expect("open block");
        current.push(id, row, add_book_hash)?;
        self.ids.push(&(id, current.info.index))?;
        self.keys.push(&(key, id))?;
        self.count = self.count.checked_add(1).ok_or("too many JembaDB rows")?;
        Ok(())
    }

    fn finish(mut self, path: &Path, sorted: Option<&RawValue>) -> Result<u32> {
        if let Some(block) = self.block {
            self.blocks.push(block.finish(false)?);
        }
        self.ids.finish(None)?;
        self.keys.finish(sorted)?;
        let directory = self.stage.path();
        write_snapshot(&directory.join("blocklist.0"), &self.blocks)?;
        let schema = if self.kind != TableKind::Book {
            let value_type = if self.kind == TableKind::Text {
                "string"
            } else {
                "number"
            };
            json!({"flag": [], "hash": [], "index": [
                {"field":"value","type":value_type,"depth":1000000,"unique":true,"fileName":"index1"}
            ]})
        } else {
            json!({
                "flag": [], "index": [], "hash": [
                    {"field":"_uid","type":"string","depth":100,"unique":true,"fileName":"hash1"}
                ]
            })
        };
        write_snapshot(&directory.join("meta.0"), &schema)?;
        fs::write(directory.join("type"), "basic")?;
        fs::write(directory.join("state"), "1")?;
        fs::rename(directory, path)?;
        Ok(self.count)
    }
}

pub(crate) fn write_updated_books(
    path: &Path,
    fill: impl FnOnce(&mut TableWriter) -> Result<()>,
) -> Result<u32> {
    let mut writer = TableWriter::new(path, TableKind::Book)?;
    fill(&mut writer)?;
    writer.finish(path, None)
}

fn build_table(
    path: &Path,
    input: &mut impl BufRead,
    status: &mut impl Write,
    kind: TableKind,
) -> Result<u32> {
    let mut writer = TableWriter::new(path, kind)?;
    let indexed = kind != TableKind::Book;
    let mut distinct_keys = HashSet::new();
    let mut distinct_ids = HashSet::new();
    status.write_all(b"ready\n")?;
    status.flush()?;

    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Err("incomplete JembaDB table import".into());
        }
        if let Some(end) = line.strip_prefix("finish ") {
            if end.trim().parse::<u32>()? != writer.count {
                return Err("JembaDB table count differs from completed import".into());
            }
            break;
        }
        let InputRow(id, key, row, add_book_hash) = serde_json::from_str(&line)?;
        let valid_id = if indexed {
            distinct_ids.insert(id)
        } else {
            writer.count.checked_add(1) == Some(id)
        };
        if !valid_id
            || indexed && add_book_hash
            || match kind {
                TableKind::Number => serde_json::from_str::<i64>(key.get()).is_err(),
                _ => !key.get().starts_with('"'),
            }
            || !distinct_keys.insert(Box::<str>::from(key.get()))
            || !row.get().starts_with('{')
        {
            return Err(format!("invalid or duplicate JembaDB row {id}").into());
        }
        writer.add(id, &key, row, add_book_hash)?;
    }
    let sorted = if indexed {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Err("missing JembaDB sorted runs".into());
        }
        let sorted: &RawValue = serde_json::from_str(&line)?;
        if !sorted.get().starts_with('[') {
            return Err("invalid JembaDB sorted runs".into());
        }
        Some(sorted)
    } else {
        None
    };
    writer.finish(path, sorted)
}
