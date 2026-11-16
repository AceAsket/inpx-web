use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, ErrorKind};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::jemba_identity::{BookRows, snapshot};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Facet {
    Genre,
    Lang,
    Del,
    Date,
    Librate,
    Ext,
    Source,
}

impl Facet {
    fn table(self) -> &'static str {
        match self {
            Self::Genre => "genre",
            Self::Lang => "lang",
            Self::Del => "del",
            Self::Date => "date",
            Self::Librate => "librate",
            Self::Ext => "ext",
            Self::Source => "source",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: u32,
    value: Label,
    book_ids: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Label {
    Text(String),
    Number(i64),
}

#[derive(Deserialize)]
struct Index {
    hash: Vec<(Label, u32)>,
    sorted: Vec<Vec<Label>>,
}

pub(crate) struct Postings {
    rows: HashMap<u32, Row>,
    runs: Vec<Vec<(u32, Label)>>,
}

impl Postings {
    pub fn open(directory: &Path, facet: Facet) -> Result<Self> {
        match File::open(directory.join("facets").join(facet.table())) {
            Ok(file) => {
                let rows: Vec<Row> =
                    serde_json::from_reader(BufReader::with_capacity(128 * 1024, file))?;
                let labels = rows.iter().map(|row| (row.id, row.value.clone())).collect();
                return Ok(Self {
                    rows: rows.into_iter().map(|row| (row.id, row)).collect(),
                    runs: vec![labels],
                });
            }
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let table = directory.join(facet.table());
        let source = BookRows::open(&table)?;
        let mut rows = HashMap::with_capacity(source.count);
        source.visit::<Row>(|id, row| {
            if id != row.id {
                return Err("invalid facet row".into());
            }
            rows.insert(
                id,
                Row {
                    id,
                    value: row.value.clone(),
                    book_ids: row.book_ids.clone(),
                },
            );
            Ok(())
        })?;
        let dump = snapshot(&table.join("index1.0"))?.ok_or("missing facet index")?;
        let index: Index = serde_json::from_slice(&dump)?;
        let hash: HashMap<_, _> = index.hash.into_iter().collect();
        if hash.len() != rows.len()
            || rows
                .values()
                .any(|row| hash.get(&row.value) != Some(&row.id))
        {
            return Err("facet index and rows differ".into());
        }
        if let Some(delta) = snapshot(&table.join("index1.1"))? {
            let operations: Vec<(Label, u32, u8)> = serde_json::from_slice(&delta)?;
            if operations
                .iter()
                .any(|(value, id, add)| *add != 1 || hash.get(value) != Some(id))
            {
                return Err("facet index has unpublished changes".into());
            }
        }
        let runs: Vec<_> = index
            .sorted
            .into_iter()
            .map(|run| {
                run.into_iter()
                    .filter_map(|label| hash.get(&label).map(|id| (*id, label)))
                    .collect::<Vec<_>>()
            })
            .collect();
        if runs
            .iter()
            .flatten()
            .map(|(id, _)| *id)
            .collect::<HashSet<_>>()
            .len()
            != rows.len()
        {
            return Err("facet index runs are incomplete".into());
        }
        Ok(Self { rows, runs })
    }

    pub fn labels(&self) -> Vec<Vec<(u32, Label)>> {
        self.runs.clone()
    }

    pub fn book_lists(&self, ids: &[u32]) -> Result<Vec<&[u32]>> {
        ids.iter()
            .map(|id| {
                self.rows
                    .get(id)
                    .map(|row| row.book_ids.as_slice())
                    .ok_or_else(|| "unknown facet row".into())
            })
            .collect()
    }

    pub fn intersection(&self, rows: Vec<u32>, candidates: Option<Vec<u32>>) -> Result<Vec<u32>> {
        let mut candidates = candidates.map(|ids| ids.into_iter().collect::<HashSet<_>>());
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for id in rows {
            let row = self.rows.get(&id).ok_or("unknown facet row")?;
            for &book in &row.book_ids {
                if candidates
                    .as_mut()
                    .map_or_else(|| seen.insert(book), |ids| ids.remove(&book))
                {
                    result.push(book);
                }
                if candidates.as_ref().is_some_and(HashSet::is_empty) {
                    return Ok(result);
                }
            }
        }
        Ok(result)
    }
}
