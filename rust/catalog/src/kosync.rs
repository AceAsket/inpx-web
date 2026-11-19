use std::fs::File;
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{Sensitive, hex, md5, parse_hex, random};
use crate::framed_protocol::{Frames, header, reply};
use crate::kosync_index::{Cache, Query};
use crate::kosync_store::{Client, Store};

#[path = "kosync_service.rs"]
mod service;
pub use service::{KoSync, ProgressRequest, Push, Session, valid_document};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Command {
    Fingerprint {
        source: PathBuf,
    },
    Link {
        file: PathBuf,
        source: PathBuf,
        book_uid: String,
        ext: String,
        now: u64,
    },
    Lookup {
        file: PathBuf,
        query: Query,
    },
    Build {
        file: PathBuf,
        source: PathBuf,
        document: String,
    },
    Pair,
    ClientKey {
        password: String,
    },
    Account {
        file: PathBuf,
        #[serde(flatten)]
        client: Client,
        key: Option<String>,
    },
    SetAccount {
        file: PathBuf,
        user_id: String,
        verifier: String,
        web_password_hash: Option<String>,
    },
    DisableAccount {
        file: PathBuf,
        user_id: String,
    },
    Progress {
        file: PathBuf,
        #[serde(flatten)]
        client: Client,
        document: String,
    },
    SaveProgress {
        file: PathBuf,
        user_id: String,
        document: String,
        stamp: String,
        record: String,
        prune: bool,
    },
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut cache = Cache::default();
    let mut store = Store::default();
    while let Some(request) = header(&mut input)? {
        let result = run(request, &mut cache, &mut store).and_then(|value| {
            Frames(&mut output).write_all(value.get().as_bytes())?;
            Ok(())
        });
        reply(&mut output, result)?;
    }
    Ok(())
}

fn run(request: Command, cache: &mut Cache, store: &mut Store) -> Result<Box<RawValue>> {
    // A stored progress record may contain JSON escapes preserved verbatim across upgrades.
    let response = match request {
        Command::Fingerprint { source } => json!(fingerprint(&mut File::open(source)?)?),
        Command::Link {
            file,
            source,
            book_uid,
            ext,
            now,
        } => {
            store.link(&file, &book_uid, &ext, now, || Ok(source))?;
            Value::Null
        }
        Command::Lookup { file, query } => cache.lookup(&file, &query)?,
        Command::Build {
            file,
            source,
            document,
        } => {
            if parse_hex::<16>(&document).is_none()
                || file.file_stem().and_then(|name| name.to_str()) != Some(document.as_str())
            {
                return Err("Некорректный документ KOSync".into());
            }
            Cache::build(&file, &source, &document)?;
            Value::Null
        }
        Command::Pair => {
            let (password, verifier) = pair()?;
            json!({"password":password,"verifier":verifier})
        }
        Command::ClientKey { password } => json!(hex(&md5(password.as_bytes())?)),
        Command::Account { file, client, key } => store.account(&file, &client, key.as_deref())?,
        Command::SetAccount {
            file,
            user_id,
            verifier,
            web_password_hash,
        } => {
            store.set_account(&file, &user_id, verifier, web_password_hash.as_deref())?;
            Value::Null
        }
        Command::DisableAccount { file, user_id } => {
            store.disable_account(&file, &user_id)?;
            Value::Null
        }
        Command::Progress {
            file,
            client,
            document,
        } => return store.progress(&file, &client, &document),
        Command::SaveProgress {
            file,
            user_id,
            document,
            stamp,
            record,
            prune,
        } => {
            store.save_progress(
                &file,
                &user_id,
                &document,
                &stamp,
                RawValue::from_string(record)?,
                prune,
            )?;
            Value::Null
        }
    };
    Ok(serde_json::value::to_raw_value(&response)?)
}

fn pair() -> Result<(String, String)> {
    let entropy = Sensitive(random::<24>()?);
    let password = URL_SAFE_NO_PAD.encode(entropy.0);
    let key = Sensitive(hex(&md5(password.as_bytes())?).into_bytes());
    Ok((password, hex(&Sha256::digest(&key.0))))
}

pub(crate) fn fingerprint(file: &mut File) -> Result<String> {
    // KOReader's document ID is an MD5 of at most twelve sparse blocks.
    const BLOCK: usize = 1024;
    let size = file.metadata()?.len();
    let mut bytes = [0; 12 * BLOCK];
    let mut count = 0;
    for offset in std::iter::once(0).chain((0..11).map(|i| 1024_u64 << (2 * i))) {
        if offset >= size {
            break;
        }
        file.seek(SeekFrom::Start(offset))?;
        let expected = (size - offset).min(BLOCK as u64) as usize;
        file.read_exact(&mut bytes[count..count + expected])?;
        count += expected;
    }
    Ok(hex(&md5(&bytes[..count])?))
}
