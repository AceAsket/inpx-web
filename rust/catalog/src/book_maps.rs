use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::Serialize;
use tempfile::NamedTempFile;

use crate::Result;

#[derive(Default)]
pub(crate) struct BookIds {
    single: Vec<Option<u32>>,
    multiple: BTreeMap<u32, Vec<u32>>,
}

impl BookIds {
    pub(crate) fn add(&mut self, id: u32, books: &[u32]) -> Result<()> {
        if id == 0 {
            return Err("book map labels must have nonzero IDs".into());
        }
        for &book in books {
            let at = book as usize;
            if at >= self.single.len() {
                self.single.try_reserve(at + 1 - self.single.len())?;
                self.single.resize(at + 1, None);
            }
            match self.single[at] {
                None => self.single[at] = Some(id),
                Some(0) => self
                    .multiple
                    .get_mut(&book)
                    .ok_or("missing book map entry")?
                    .push(id),
                Some(previous) => {
                    self.single[at] = Some(0);
                    self.multiple.insert(book, vec![previous, id]);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn save(&self, path: &Path) -> Result<()> {
        #[derive(Serialize)]
        struct LegacyMap<'a> {
            arr: &'a [Option<u32>],
            map: Vec<(&'a u32, &'a Vec<u32>)>,
        }

        let parent = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut file = NamedTempFile::new_in(parent)?;
        {
            let mut output = BufWriter::new(file.as_file_mut());
            serde_json::to_writer(
                &mut output,
                &LegacyMap {
                    arr: &self.single,
                    map: self.multiple.iter().collect(),
                },
            )?;
            output.flush()?;
        }
        file.as_file().sync_all()?;
        file.persist_noclobber(path)?;
        Ok(())
    }
}
