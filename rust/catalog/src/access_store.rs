use std::io::{BufRead, Read, Write};
use std::path::Path;

use inpx_auth_state::access_wire::{
    self, COUNTS_BYTES, Counts, REMOVAL_BYTES, SNAPSHOT_BYTES, TOKEN_BYTES, UPDATE_BYTES,
};
use inpx_auth_state::web_access_sessions::SessionValue;
use redb::{Database, ReadableDatabase, ReadableTable, Table, TableDefinition};
use serde::Deserialize;

use crate::framed_protocol::{Frames, header, reply, with_body};
use crate::{Result, jemba_identity::SnapshotRows};

const PASSWORD: TableDefinition<&str, &str> = TableDefinition::new("access_config_v1");
const SESSIONS: TableDefinition<&str, (u64, u64)> = TableDefinition::new("access_sessions_v1");
const FINGERPRINT: &str = "password";
const SNAPSHOT_BLOCK: usize = 1024 * SNAPSHOT_BYTES;

#[derive(Clone, Copy, Deserialize)]
struct Session {
    time: u64,
    used: u64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum AccessRequest {
    Init {
        fingerprint: String,
        #[serde(default, rename = "prepareOnly")]
        prepare_only: bool,
    },
    Apply {
        bytes: u64,
    },
}

pub(crate) struct AccessStore {
    db: Database,
    directory: std::path::PathBuf,
}

fn valid_hash(value: &str) -> bool {
    access_wire::token(value.as_bytes()).is_some()
}

#[derive(Deserialize)]
struct LegacyRow<T> {
    id: String,
    value: T,
}

fn rotate_or_import(directory: &Path, fingerprint: &str) -> Result<Vec<(String, Session)>> {
    let config = directory.join("config");
    let mut matches = false;
    if config.try_exists()? {
        SnapshotRows::<String>::open(&config)?.visit(|id, row: &LegacyRow<String>| {
            if id != row.id {
                return Err("invalid legacy access config row".into());
            }
            if id == "pass" {
                matches = row.value == fingerprint;
            }
            Ok(())
        })?;
    }
    let mut sessions = Vec::new();
    let access = directory.join("access");
    if matches && access.try_exists()? {
        SnapshotRows::<String>::open(&access)?.visit(|id, row: &LegacyRow<Session>| {
            if id != row.id || !valid_hash(&id) {
                return Err("invalid legacy session row".into());
            }
            sessions.push((id, row.value));
            Ok(())
        })?;
    }
    Ok(sessions)
}

impl AccessStore {
    pub(crate) fn open(file: &Path) -> Result<Self> {
        let directory = file
            .parent()
            .ok_or("missing access store directory")?
            .to_path_buf();
        let db = Database::create(file)?;
        Ok(Self { db, directory })
    }

    pub(crate) fn prepare(&self, fingerprint: &str) -> Result<bool> {
        if !valid_hash(fingerprint) {
            return Err("invalid access configuration fingerprint".into());
        }
        let empty = {
            let tx = self.db.begin_read()?;
            let config = match tx.open_table(PASSWORD) {
                Ok(table) => Some(table),
                Err(redb::TableError::TableDoesNotExist(_)) => None,
                Err(error) => return Err(error.into()),
            };
            let current = config
                .as_ref()
                .map(|table| table.get(FINGERPRINT))
                .transpose()?
                .flatten();
            if current
                .as_ref()
                .is_some_and(|value| value.value() == fingerprint)
            {
                tx.open_table(SESSIONS)?;
                return Ok(true);
            }
            current.is_none()
        };
        let sessions = if empty {
            let Ok(rows) = rotate_or_import(&self.directory, fingerprint) else {
                return Ok(false);
            };
            rows
        } else {
            Vec::new()
        };
        let tx = self.db.begin_write()?;
        {
            let mut table = tx.open_table(SESSIONS)?;
            table.retain(|_, _| false)?;
            for (token, value) in &sessions {
                table.insert(token.as_str(), (value.time, value.used))?;
            }
            tx.open_table(PASSWORD)?.insert(FINGERPRINT, fingerprint)?;
        }
        tx.commit()?;
        Ok(true)
    }

    fn snapshot(
        &self,
        fingerprint: &str,
        prepare_only: bool,
        mut output: impl Write,
    ) -> Result<()> {
        if !self.prepare(fingerprint)? {
            output.write_all(&[2])?;
            return Ok(());
        }
        output.write_all(&[1])?;
        if prepare_only {
            return Ok(());
        }
        let mut block = Vec::with_capacity(SNAPSHOT_BLOCK);
        self.visit_sessions(|token, time, used| {
            block.extend_from_slice(token.as_bytes());
            block.extend_from_slice(&(time as f64).to_le_bytes());
            block.extend_from_slice(&(used as f64).to_le_bytes());
            if block.len() == SNAPSHOT_BLOCK {
                output.write_all(&block)?;
                block.clear();
            }
            Ok(())
        })?;
        output.write_all(&block)?;
        Ok(())
    }

    pub(crate) fn visit_sessions(
        &self,
        mut visit: impl FnMut(&str, u64, u64) -> Result<()>,
    ) -> Result<()> {
        let tx = self.db.begin_read()?;
        let sessions = tx.open_table(SESSIONS)?;
        for row in sessions.iter()? {
            let (token, value) = row?;
            let token = token.value();
            if !valid_hash(token) {
                return Err("invalid stored session key".into());
            }
            let (time, used) = value.value();
            visit(token, time, used)?;
        }
        Ok(())
    }

    fn apply(&self, mut input: impl Read, bytes: u64) -> Result<()> {
        let mut header = [0; COUNTS_BYTES];
        input.read_exact(&mut header)?;
        let counts = Counts::read(&header);
        if counts.byte_len().map(|length| length as u64) != Some(bytes) {
            return Err("invalid access changes length".into());
        }
        self.write(|table| {
            let mut update = [0; UPDATE_BYTES];
            for _ in 0..counts.updates {
                input.read_exact(&mut update)?;
                let token =
                    access_wire::token(&update[..TOKEN_BYTES]).ok_or("invalid session key")?;
                let time = access_wire::number(&update[TOKEN_BYTES + 8..TOKEN_BYTES + 16])
                    .ok_or("invalid session timestamp")?;
                let used = access_wire::number(&update[TOKEN_BYTES + 16..])
                    .ok_or("invalid session use count")?;
                table.insert(token, (time, used))?;
            }
            let mut removal = [0; REMOVAL_BYTES];
            for _ in 0..counts.removals {
                input.read_exact(&mut removal)?;
                let token =
                    access_wire::token(&removal[..TOKEN_BYTES]).ok_or("invalid session key")?;
                table.remove(token)?;
            }
            Ok(())
        })
    }

    pub(crate) fn persist<'a>(
        &self,
        updates: impl IntoIterator<Item = (&'a str, SessionValue)>,
        removals: impl IntoIterator<Item = &'a str>,
    ) -> Result<()> {
        self.write(|table| {
            for (token, value) in updates {
                table.insert(token, (u64::try_from(value.time)?, value.used))?;
            }
            for token in removals {
                table.remove(token)?;
            }
            Ok(())
        })
    }

    fn write(
        &self,
        mutate: impl FnOnce(&mut Table<'_, &str, (u64, u64)>) -> Result<()>,
    ) -> Result<()> {
        let tx = self.db.begin_write()?;
        {
            let config = tx.open_table(PASSWORD)?;
            if config.get(FINGERPRINT)?.is_none() {
                return Err("access store is not initialized".into());
            }
            mutate(&mut tx.open_table(SESSIONS)?)?;
        }
        tx.commit()?;
        Ok(())
    }
}

pub fn serve(file: &Path, mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let store = AccessStore::open(file)?;
    while let Some(request) = header(&mut input)? {
        let result = match request {
            AccessRequest::Init {
                fingerprint,
                prepare_only,
            } => store.snapshot(&fingerprint, prepare_only, Frames(&mut output)),
            AccessRequest::Apply { bytes } => {
                with_body(&mut input, bytes, |body| store.apply(body, bytes))?
            }
        };
        reply(&mut output, result)?;
    }
    Ok(())
}
