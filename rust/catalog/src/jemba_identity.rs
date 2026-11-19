//! Project active book identities in JembaDB 5.1.7 table order.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::Hash;
use std::io::{ErrorKind, Write};
use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Result;

pub(crate) fn snapshot(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut data = match fs::read(path) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match data.first() {
        Some(b'1') => (),
        Some(b'0') if data.last() == Some(&b',') => {
            *data.last_mut().expect("append delimiter") = b']';
        }
        Some(b'0') if data == b"0[" => data.push(b']'),
        _ => return Err(format!("unsupported JembaDB snapshot {}", path.display()).into()),
    }
    data[0] = b' ';
    Ok(Some(data))
}

struct RowOrder<K> {
    slots: Vec<Option<(K, u32)>>,
    positions: HashMap<K, usize>,
}

impl<K: Clone + Eq + Hash> RowOrder<K> {
    fn new() -> Self {
        Self {
            slots: Vec::new(),
            positions: HashMap::new(),
        }
    }

    fn set(&mut self, id: K, block: u32) {
        let next = self.slots.len();
        let slot = *self.positions.entry(id.clone()).or_insert(next);
        if slot == next {
            self.slots.push(Some((id, block)));
        } else {
            self.slots[slot] = Some((id, block));
        }
    }

    fn remove(&mut self, id: K) {
        if let Some(slot) = self.positions.remove(&id) {
            self.slots[slot] = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity {
    pub id: u32,
    #[serde(rename = "_uid")]
    pub uid: String,
    #[serde(rename = "_legacyUid")]
    pub legacy_uid: Option<Value>,
    #[serde(rename = "_recordHash")]
    pub hash: Option<Value>,
    source_id: Option<Value>,
    folder: Option<Value>,
    file: Option<Value>,
    ext: Option<Value>,
    insno: Option<Value>,
    libid: Option<Value>,
    sourcelib: Option<Value>,
}

fn text(field: &Option<Value>) -> Option<&str> {
    match field {
        None | Some(Value::Null) => Some(""),
        Some(Value::String(value)) if !value.chars().any(char::is_control) => Some(value),
        _ => None,
    }
}

impl Identity {
    pub(crate) fn physical_identity(&self) -> Option<String> {
        let ext = text(&self.ext)?;
        if !ext.is_ascii() {
            return None;
        }
        physical_identity(
            text(&self.source_id)?,
            text(&self.folder)?,
            text(&self.file)?,
            ext,
            match &self.insno {
                None | Some(Value::Null) => 0,
                Some(value) => value.as_i64().filter(|i| i.unsigned_abs() < (1 << 53))?,
            },
            text(&self.libid)?,
            text(&self.sourcelib)?,
        )
        .ok()
    }

    fn project(&self, mut output: impl Write) -> Result<()> {
        if let Some(identity) = self.physical_identity() {
            serde_json::to_writer(
                &mut output,
                &(self.id, &self.uid, &self.legacy_uid, &self.hash, identity),
            )?;
        } else {
            let fields = [
                &self.source_id,
                &self.folder,
                &self.file,
                &self.ext,
                &self.insno,
                &self.libid,
                &self.sourcelib,
            ];
            serde_json::to_writer(
                &mut output,
                &(self.id, &self.uid, &self.legacy_uid, &self.hash, fields),
            )?;
        }
        Ok(())
    }
}

pub(crate) fn physical_identity(
    source: &str,
    folder: &str,
    file: &str,
    ext: &str,
    insno: i64,
    libid: &str,
    sourcelib: &str,
) -> Result<String> {
    let ext = ext.to_lowercase();
    let encoded = if !file.is_empty() {
        let folder = folder.replace('\\', "/");
        serde_json::to_vec(&("file", source, folder, file, ext, insno))?
    } else if !libid.is_empty() {
        serde_json::to_vec(&("libid", source, sourcelib, libid, ext))?
    } else {
        return Ok(String::new());
    };
    let mut hash = Sha256::new();
    hash.update(b"inpx-physical-v1:");
    hash.update(encoded);
    Ok(STANDARD.encode(hash.finalize()))
}

pub(crate) type BookRows<'a> = SnapshotRows<'a, u32>;

pub(crate) struct SnapshotRows<'a, K> {
    directory: &'a Path,
    slots: Vec<Option<(K, u32)>>,
    pub count: usize,
}

impl<'a, K: Clone + Eq + Hash + DeserializeOwned> SnapshotRows<'a, K> {
    pub fn open(directory: &'a Path) -> Result<Self> {
        if fs::read(directory.join("state"))? != b"1"
            || fs::read(directory.join("type"))? != b"basic"
        {
            return Err("unsupported legacy table state or type".into());
        }
        let mut order = RowOrder::new();
        for (file, delta) in [("blockindex.0", false), ("blockindex.1", true)] {
            if let Some(data) = snapshot(&directory.join(file))? {
                for (id, block) in serde_json::from_slice::<Vec<(K, u32)>>(&data)? {
                    if delta && block == 0 {
                        order.remove(id);
                    } else {
                        order.set(id, block);
                    }
                }
            }
        }
        Ok(Self {
            directory,
            slots: order.slots,
            count: order.positions.len(),
        })
    }

    pub fn ids(&self) -> impl Iterator<Item = K> + '_ {
        self.slots.iter().flatten().map(|(id, _)| id.clone())
    }

    pub fn visit<T: DeserializeOwned>(
        &self,
        mut visit: impl FnMut(K, &T) -> Result<()>,
    ) -> Result<()> {
        let mut cache: VecDeque<(u32, HashMap<K, T>)> = VecDeque::new();
        for (id, block) in self.slots.iter().flatten() {
            let block = *block;
            if let Some(index) = cache.iter().position(|(number, _)| *number == block) {
                let hit = cache.remove(index).expect("cached book block");
                cache.push_front(hit);
            } else {
                let width = if block < 1_000_000 { 6 } else { 12 };
                let file = self.directory.join(format!("{block:0width$}.jem"));
                let data = snapshot(&file)?.ok_or("missing legacy table block")?;
                let rows = serde_json::from_slice::<Vec<(K, T)>>(&data)?
                    .into_iter()
                    .collect();
                if cache.len() >= 5 {
                    cache.pop_back();
                }
                cache.push_front((block, rows));
            }
            let row = cache[0]
                .1
                .get(id)
                .ok_or("legacy row is missing from its block")?;
            visit(id.clone(), row)?;
        }
        Ok(())
    }
}

pub fn read_book_identities(directory: &Path, mut output: impl Write) -> Result<()> {
    let native = directory.join("catalogue.json");
    let rows = if native.try_exists()? {
        None
    } else {
        Some(BookRows::open(directory)?)
    };
    let count = if let Some(rows) = &rows {
        rows.count as u64
    } else {
        let metadata: Value = serde_json::from_reader(fs::File::open(native)?)?;
        metadata["stats"]["bookCountAll"]
            .as_u64()
            .ok_or("missing native catalogue book count")?
    };
    serde_json::to_writer(&mut output, &json!({"records":count}))?;
    output.write_all(b"\n")?;
    let mut batch = 0;
    let mut emit = |id, row: &Identity| {
        if row.id != id {
            return Err("catalogue book ID differs from its row key".into());
        }
        output.write_all(if batch == 0 { b"[" } else { b"," })?;
        row.project(&mut output)?;
        batch += 1;
        if batch == 512 {
            output.write_all(b"]\n")?;
            batch = 0;
        }
        Ok(())
    };
    if let Some(rows) = rows {
        rows.visit(emit)?;
    } else {
        crate::store::BookStore::open(directory)?
            .visit(|id, raw| emit(id, &serde_json::from_slice(raw)?))?;
    }
    if batch > 0 {
        output.write_all(b"]\n")?;
    }
    output.flush()?;
    Ok(())
}
