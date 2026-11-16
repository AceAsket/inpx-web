use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Result, jemba_identity::snapshot};

#[derive(Clone, Deserialize, Serialize)]
pub struct LabelOrder {
    // The label list retains insertion order for predicates that iterate the index.
    labels: Vec<(u32, String)>,
    runs: Vec<Vec<u32>>,
}

/// A bounded directory of comparison points in the saved order. The application
/// compares these labels with the same ICU collation as its legacy range search.
#[derive(Serialize)]
pub struct NameRunDirectory {
    length: usize,
    pivots: Vec<(usize, String)>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NameSelection {
    All,
    Windows {
        ranges: Vec<Vec<[usize; 2]>>,
    },
    Contains {
        text: String,
        #[serde(default)]
        symbol: bool,
    },
}

const NAME_PAGE: usize = 128;
const ORDINARY_INITIALS: &str = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяabcdefghijklmnopqrstuvwxyz";

impl LabelOrder {
    pub(crate) fn sorted(labels: Vec<(u32, String)>) -> Self {
        let indices = (0..labels.len() as u32).collect();
        Self {
            labels,
            runs: vec![indices],
        }
    }

    pub(crate) fn directory(&self) -> Result<Vec<NameRunDirectory>> {
        self.runs
            .iter()
            .map(|run| {
                let mut pivots = Vec::new();
                let mut intervals = vec![(0, run.len())];
                while let Some((left, right)) = intervals.pop() {
                    if right - left <= NAME_PAGE {
                        continue;
                    }
                    let middle = left + (right - left) / 2;
                    pivots.push((middle, self.label(run[middle])?.1.clone()));
                    intervals.push((middle + 1, right));
                    intervals.push((left, middle));
                }
                Ok(NameRunDirectory {
                    length: run.len(),
                    pivots,
                })
            })
            .collect()
    }

    fn label(&self, position: u32) -> Result<&(u32, String)> {
        self.labels
            .get(position as usize)
            .ok_or_else(|| "invalid name index position".into())
    }

    pub(crate) fn slices(&self, windows: Vec<[usize; 3]>) -> Result<Vec<Vec<String>>> {
        if windows.len() > 32 {
            return Err("too many name label slices".into());
        }
        windows
            .into_iter()
            .map(|[run, start, end]| {
                let labels = self
                    .runs
                    .get(run)
                    .and_then(|row| row.get(start..end))
                    .ok_or("invalid name label slice")?;
                if labels.len() > NAME_PAGE {
                    return Err("name label slice is too wide".into());
                }
                labels
                    .iter()
                    .map(|&position| Ok(self.label(position)?.1.clone()))
                    .collect()
            })
            .collect()
    }

    pub(crate) fn select(&self, selection: NameSelection) -> Result<Vec<u32>> {
        match selection {
            NameSelection::All => Ok(self.labels.iter().map(|(id, _)| *id).collect()),
            NameSelection::Contains { text, symbol } => Ok(self
                .labels
                .iter()
                .filter_map(|(id, label)| {
                    (label != "?"
                        && (!symbol
                            || label
                                .chars()
                                .next()
                                .is_some_and(|ch| !ORDINARY_INITIALS.contains(ch)))
                        && label.contains(&text))
                    .then_some(*id)
                })
                .collect()),
            NameSelection::Windows { ranges } => {
                let mut ids = Vec::new();
                let mut seen = HashSet::new();
                for range in ranges {
                    if range.len() != self.runs.len() {
                        return Err("name run count differs".into());
                    }
                    let mut groups: Vec<Vec<u32>> = Vec::with_capacity(range.len());
                    let mut largest = 0;
                    for (run, [start, end]) in self.runs.iter().zip(range) {
                        if start > run.len() || end > run.len() {
                            return Err("invalid name range".into());
                        }
                        let mut group = Vec::new();
                        let mut unique = HashSet::new();
                        for &position in &run[start..end.max(start)] {
                            let id = self.label(position)?.0;
                            if unique.insert(id) {
                                group.push(id);
                            }
                        }
                        if !groups.is_empty() && group.len() > groups[largest].len() {
                            largest = groups.len();
                        }
                        groups.push(group);
                    }
                    // The legacy merge starts with the largest run, with first run on ties.
                    for group in groups.get(largest).into_iter().chain(
                        groups
                            .iter()
                            .enumerate()
                            .filter_map(|(index, group)| (index != largest).then_some(group)),
                    ) {
                        ids.extend(group.iter().copied().filter(|id| seen.insert(*id)));
                    }
                }
                Ok(ids)
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    hash: Vec<(String, u32)>,
    sorted: Vec<Vec<String>>,
    del_count: usize,
}

pub(crate) fn load_order(table: &Path) -> Result<LabelOrder> {
    let schema = snapshot(&table.join("meta.0"))?.ok_or("missing name index schema")?;
    let schema: serde_json::Value = serde_json::from_slice(&schema)?;
    let index = &schema["index"][0];
    if index["field"] != "value"
        || index["type"] != "string"
        || index["unique"] != true
        || index["fileName"] != "index1"
        || index["depth"] != 1_000_000
    {
        return Err("unsupported name index schema".into());
    }
    let dump = snapshot(&table.join("index1.0"))?.ok_or("missing name index")?;
    let Dump {
        hash,
        mut sorted,
        mut del_count,
    } = serde_json::from_slice(&dump)?;
    let values: HashMap<_, _> = hash.iter().map(|(key, id)| (key.as_str(), *id)).collect();
    if values.len() != hash.len() {
        return Err("duplicate name index key".into());
    }
    let mut removed = HashSet::new();
    if let Some(data) = snapshot(&table.join("index1.1"))? {
        for (value, id, add) in serde_json::from_slice::<Vec<(String, u32, u8)>>(&data)? {
            match add {
                1 if values.get(value.as_str()) == Some(&id) && !removed.contains(&id) => (),
                0 => {
                    if values.get(value.as_str()) == Some(&id) && removed.insert(id) {
                        del_count += 1;
                    }
                    if del_count > sorted.first().map_or(0, Vec::len) / 4 {
                        for run in &mut sorted {
                            run.retain(|key| {
                                values
                                    .get(key.as_str())
                                    .is_some_and(|id| !removed.contains(id))
                            });
                        }
                        sorted.retain(|run| !run.is_empty());
                        if sorted.is_empty() {
                            sorted.push(Vec::new());
                        } else {
                            sorted.sort_by_key(|run| Reverse(run.len()));
                        }
                        del_count = 0;
                    }
                }
                _ => return Err("name index has unpublished additions".into()),
            }
        }
    }
    let labels: Vec<_> = hash
        .into_iter()
        .filter_map(|(value, id)| (!removed.contains(&id)).then_some((id, value)))
        .collect();
    let positions: HashMap<_, _> = labels
        .iter()
        .enumerate()
        .map(|(offset, (_, value))| (value.as_str(), offset as u32))
        .collect();
    let runs: Vec<Vec<u32>> = sorted
        .iter()
        .map(|run| {
            run.iter()
                .filter_map(|value| positions.get(value.as_str()).copied())
                .collect()
        })
        .collect();
    if runs.iter().flatten().copied().collect::<HashSet<_>>().len() != labels.len() {
        return Err("name index runs are incomplete".into());
    }
    Ok(LabelOrder { labels, runs })
}
