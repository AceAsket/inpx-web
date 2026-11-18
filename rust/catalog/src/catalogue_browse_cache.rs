use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Result;
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

#[derive(Deserialize, Serialize)]
pub(crate) struct PreparedBrowse {
    generation: String,
    pub(crate) active: ActiveOrders,
    pub(crate) genres: Vec<String>,
    pub(crate) facets: (Vec<String>, Vec<String>),
    pub(crate) authors: Value,
    pub(crate) series: Value,
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
        Ok((saved.generation == generation).then_some(saved))
    }

    pub(crate) fn build(catalogue: &Catalogue) -> Result<Self> {
        Ok(Self {
            generation: catalogue.generation.clone(),
            active: catalogue
                .store
                .active_browser_orders(&catalogue.generation)?,
            genres: catalogue.opds_genres()?,
            facets: catalogue.browser_facets()?,
            authors: catalogue.browser_browse(&json!({"kind":"author"}))?,
            series: catalogue.browser_browse(&json!({"kind":"series"}))?,
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
