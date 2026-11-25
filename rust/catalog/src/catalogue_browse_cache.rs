use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::catalog_text::{shorter_search_roots, words};
use crate::isbn_revision::IsbnInputs;
use crate::lookup_discovery::SelectedBooks;
use crate::standalone_catalogue::Catalogue;

// The version covers ranking, physical copy selection and the directory responses.
const FILE: &str = "browser-catalogue-v1.cache";

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct ActiveOrders {
    pub(crate) combined: Vec<u32>,
    pub(crate) by_source: HashMap<String, Vec<u32>>,
}

impl ActiveOrders {
    pub(crate) fn ids(&self, source: &str) -> &[u32] {
        if !source.is_empty() {
            return self
                .by_source
                .get(source)
                .map(Vec::as_slice)
                .unwrap_or_default();
        }
        if self.by_source.len() == 1 {
            return self.by_source.values().next().unwrap();
        }
        &self.combined
    }
}

pub(crate) struct ActiveBrowseOrders {
    pub(crate) all: ActiveOrders,
    pub(crate) languages: LanguageOrders,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct LanguageOrders {
    pub(crate) exact: HashMap<String, ActiveOrders>,
    pub(crate) prefixes: HashMap<String, ActiveOrders>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct FacetOrder {
    pub(crate) rows: Vec<u32>,
    pub(crate) physical_copies: Vec<Vec<u32>>,
    pub(crate) ties: Vec<[usize; 2]>,
    #[serde(default)]
    pub(crate) merged_copies: Option<Vec<Vec<u32>>>,
}

impl FacetOrder {
    pub(crate) fn select(&self, selected: Option<SelectedBooks>, merge: bool) -> Vec<u32> {
        let copies = if merge {
            self.merged_copies
                .as_deref()
                .expect("prepared edition groups")
        } else {
            &self.physical_copies
        };
        let mut selected =
            selected.unwrap_or_else(|| SelectedBooks::from_postings(vec![&self.rows], None));
        let size = selected.len();
        let mut first_ids = HashMap::new();
        for copies in copies {
            // Copies are stored in preference order. The first matching row
            // in catalogue storage order still breaks ties between books.
            let Some(winner) = copies.iter().copied().find(|&id| selected.contains(id)) else {
                continue;
            };
            let mut first = winner;
            for &id in copies {
                if id != winner && selected.contains(id) {
                    first = first.min(id);
                    selected.remove(id);
                }
            }
            if first != winner {
                first_ids.insert(winner, first);
            }
        }

        let mut result = Vec::with_capacity(size.min(self.rows.len()));
        let append = |result: &mut Vec<u32>, rows: &[u32]| {
            result.extend(rows.iter().copied().filter(|&id| selected.contains(id)));
        };
        let mut previous = 0;
        if !first_ids.is_empty() {
            for &[start, end] in &self.ties {
                append(&mut result, &self.rows[previous..start]);
                let offset = result.len();
                append(&mut result, &self.rows[start..end]);
                let tied = &mut result[offset..];
                if tied.iter().any(|id| first_ids.contains_key(id)) {
                    tied.sort_unstable_by_key(|id| first_ids.get(id).copied().unwrap_or(*id));
                }
                previous = end;
            }
        }
        append(&mut result, &self.rows[previous..]);
        result
    }
}

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct KeywordPostings(BTreeMap<String, Vec<u32>>);

impl KeywordPostings {
    pub(crate) fn add(&mut self, id: u32, keywords: &str) {
        words(keywords, |_, root| {
            let ids = self.0.entry(root.to_owned()).or_default();
            if ids.last() != Some(&id) {
                ids.push(id);
            }
        });
    }

    pub(crate) fn candidates(&self, word: &str, stem: &str) -> HashSet<u32> {
        self.0
            .range(stem.to_owned()..)
            .take_while(|(root, _)| root.starts_with(stem))
            .map(|(_, ids)| ids)
            .chain(shorter_search_roots(word, stem).filter_map(|root| self.0.get(root)))
            .flatten()
            .copied()
            .collect()
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct PreparedBrowse {
    generation: String,
    pub(crate) active: ActiveOrders,
    pub(crate) genres: Vec<String>,
    pub(crate) facets: (Vec<String>, Vec<String>),
    pub(crate) authors: Value,
    pub(crate) series: Value,
    // Older prepared caches are rebuilt once without rebuilding the catalogue.
    #[serde(default)]
    pub(crate) languages: Option<LanguageOrders>,
    #[serde(default)]
    pub(crate) facet_order: Option<FacetOrder>,
    #[serde(default)]
    pub(crate) keywords: Option<KeywordPostings>,
    #[serde(default)]
    pub(crate) isbn_inputs: Option<IsbnInputs>,
}

impl PreparedBrowse {
    pub(crate) fn load(directory: &Path, generation: &str) -> Result<Option<Self>> {
        let data = match fs::read(directory.join(FILE)) {
            Ok(data) => data,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let (digest, json) = data
            .split_at_checked(32)
            .ok_or("Truncated catalogue cache")?;
        if Sha256::digest(json)[..] != *digest {
            return Err("Invalid catalogue cache checksum".into());
        }
        let saved: Self = serde_json::from_slice(json)?;
        Ok((saved.generation == generation
            && saved.languages.is_some()
            && saved
                .facet_order
                .as_ref()
                .is_some_and(|order| order.merged_copies.is_some())
            && saved.keywords.is_some()
            && saved.isbn_inputs.is_some())
        .then_some(saved))
    }

    pub(crate) fn build(catalogue: &Catalogue) -> Result<Self> {
        let orders = catalogue
            .store
            .active_browser_orders(&catalogue.generation)?;
        let (facet_order, keywords, isbn_inputs) =
            catalogue.store.active_facet_order(&catalogue.generation)?;
        Ok(Self {
            generation: catalogue.generation.clone(),
            active: orders.all,
            genres: catalogue.opds_genres()?,
            facets: catalogue.browser_facets()?,
            authors: catalogue.browser_browse(&json!({"kind":"author"}))?,
            series: catalogue.browser_browse(&json!({"kind":"series"}))?,
            languages: Some(orders.languages),
            facet_order: Some(facet_order),
            keywords: Some(keywords),
            isbn_inputs: Some(isbn_inputs),
        })
    }

    pub(crate) fn save(&self, directory: &Path) -> Result<()> {
        let json = serde_json::to_vec(self)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&Sha256::digest(&json))?;
        file.write_all(&json)?;
        file.as_file().sync_all()?;
        file.persist(directory.join(FILE))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn facet_order_uses_the_best_matching_copy_and_its_first_matching_id() {
        let order = FacetOrder {
            rows: vec![8, 1, 2, 3, 4, 5, 9],
            physical_copies: vec![vec![4, 1], vec![5, 9]],
            ties: vec![[1, 6]],
            merged_copies: Some(vec![vec![4, 1, 5, 9]]),
        };
        let select = |ids: &[u32]| {
            order.select(
                Some(SelectedBooks::Ids(HashSet::from_iter(ids.iter().copied()))),
                false,
            )
        };
        assert_eq!(select(&[8, 1, 2, 3, 4, 5, 9]), [8, 4, 2, 3, 5]);
        assert_eq!(select(&[2, 4, 9]), [2, 4, 9]);
        assert_eq!(select(&[1, 2, 5]), [1, 2, 5]);
        assert_eq!(order.select(None, true), [8, 4, 2, 3]);
    }
}
