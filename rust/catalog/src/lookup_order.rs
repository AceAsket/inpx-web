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

impl LabelOrder {
    pub(crate) fn sorted(labels: Vec<(u32, String)>) -> Self {
        let indices = (0..labels.len() as u32).collect();
        Self {
            labels,
            runs: vec![indices],
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
