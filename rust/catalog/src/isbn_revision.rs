use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use crate::{Result, book_delivery::book_source, book_source::Folder, crypto_support::hex};
use crate::{folder_inventory, isbn, library_sources::Source};

type Location = (String, String, String);

#[derive(Deserialize, Serialize)]
pub(crate) struct IsbnInputs {
    books: String,
    locations: BTreeSet<Location>,
}

#[derive(Default)]
pub(crate) struct IsbnInputBuilder {
    books: Sha256,
    locations: BTreeSet<Location>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IsbnRow<'a> {
    #[serde(default, borrow)]
    ext: Cow<'a, str>,
    #[serde(default, borrow)]
    folder: Cow<'a, str>,
    #[serde(default, borrow)]
    file: Cow<'a, str>,
    #[serde(default, borrow)]
    source_id: Cow<'a, str>,
    #[serde(default, borrow)]
    source_lib_dir: Cow<'a, str>,
    #[serde(default, borrow)]
    isbn: Option<&'a RawValue>,
}

fn hash_bytes(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value);
}

impl IsbnInputBuilder {
    pub(crate) fn add(&mut self, id: u32, deleted: bool, record: &[u8]) -> Result<()> {
        let row: IsbnRow = serde_json::from_slice(record)?;
        let isbn = row
            .isbn
            .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok());
        let numbers = isbn.as_deref().map(isbn::extract).unwrap_or_default();
        self.books.update(id.to_le_bytes());
        self.books.update([u8::from(deleted)]);
        for number in &numbers {
            hash_bytes(&mut self.books, number.as_bytes());
        }
        self.books.update([0xff]);
        if numbers.is_empty()
            && !deleted
            && (row.ext.eq_ignore_ascii_case("fb2") || row.ext.eq_ignore_ascii_case("epub"))
        {
            for value in [
                &row.source_id,
                &row.source_lib_dir,
                &row.folder,
                &row.file,
                &row.ext,
            ] {
                hash_bytes(&mut self.books, value.as_bytes());
            }
            self.locations.insert((
                row.source_id.into_owned(),
                row.source_lib_dir.into_owned(),
                row.folder.into_owned(),
            ));
        }
        self.books.update([0xfe]);
        Ok(())
    }

    pub(crate) fn finish(self) -> IsbnInputs {
        IsbnInputs {
            books: hex(&self.books.finalize()),
            locations: self.locations,
        }
    }
}

impl IsbnInputs {
    pub(crate) fn signature(&self, sources: &[Source]) -> String {
        let mut hash = Sha256::new();
        hash.update(b"inpx-isbn-inputs-v1\0");
        hash.update(self.books.as_bytes());
        let mut loose = BTreeSet::<PathBuf>::new();
        for (id, directory, name) in &self.locations {
            let folder = book_source(sources, id, directory)
                .and_then(|source| Folder::resolve(&source.lib_dir, name).ok());
            match folder {
                Some(folder) => {
                    hash_bytes(&mut hash, folder.path.as_os_str().as_encoded_bytes());
                    if folder.archived {
                        let metadata = fs::metadata(&folder.path)
                            .and_then(|meta| Ok((meta.len(), meta.modified()?)));
                        if let Ok((size, modified)) = metadata {
                            hash.update([1]);
                            hash.update(size.to_le_bytes());
                            hash.update(folder_inventory::modified_ms(modified).to_le_bytes());
                        } else {
                            hash.update([2]);
                        }
                    } else {
                        hash.update([3]);
                        loose.insert(folder.path);
                    }
                }
                None => hash.update([4]),
            }
        }
        let mut parent = None::<PathBuf>;
        for directory in loose {
            if parent
                .as_ref()
                .is_some_and(|path| directory.starts_with(path))
            {
                continue;
            }
            hash_bytes(&mut hash, directory.as_os_str().as_encoded_bytes());
            let result = folder_inventory::visit_inventory(&directory, |file| {
                hash_bytes(&mut hash, file.relative.as_bytes());
                hash.update(file.size.to_le_bytes());
                hash.update(file.modified.to_le_bytes());
                Ok(())
            });
            hash.update([u8::from(result.is_ok())]);
            parent = Some(directory);
        }
        hex(&hash.finalize())
    }
}
