use std::path::Path;

use redb::{Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::{Deserialize, Serialize};

use crate::{Result, jemba_identity::SnapshotRows};

const PASSWORD: TableDefinition<&str, &str> = TableDefinition::new("access_config_v1");
const SESSIONS: TableDefinition<&str, (u64, u64)> = TableDefinition::new("access_sessions_v1");
const FINGERPRINT: &str = "password";

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Session {
    time: u64,
    used: u64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AccessRequest {
    Init {
        fingerprint: String,
    },
    Apply {
        updates: Vec<(String, Session)>,
        removals: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AccessResponse {
    Ready { sessions: Vec<(String, Session)> },
    Applied,
    RepairLegacy,
}

pub struct AccessStore {
    db: Database,
    directory: std::path::PathBuf,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte,b'0'..=b'9'|b'a'..=b'f'))
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
    pub fn open(file: &Path) -> Result<Self> {
        let directory = file
            .parent()
            .ok_or("missing access store directory")?
            .to_path_buf();
        let db = Database::create(file)?;
        Ok(Self { db, directory })
    }

    fn initialize(&self, fingerprint: &str) -> Result<AccessResponse> {
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
                let table = tx.open_table(SESSIONS)?;
                let mut sessions = Vec::with_capacity(table.len()? as usize);
                for entry in table.iter()? {
                    let (token, value) = entry?;
                    let (time, used) = value.value();
                    sessions.push((token.value().into(), Session { time, used }));
                }
                return Ok(AccessResponse::Ready { sessions });
            }
            current.is_none()
        };
        let sessions = if empty {
            let Ok(rows) = rotate_or_import(&self.directory, fingerprint) else {
                return Ok(AccessResponse::RepairLegacy);
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
        Ok(AccessResponse::Ready { sessions })
    }

    fn apply(
        &self,
        updates: Vec<(String, Session)>,
        removals: Vec<String>,
    ) -> Result<AccessResponse> {
        let tx = self.db.begin_write()?;
        {
            let config = tx.open_table(PASSWORD)?;
            if config.get(FINGERPRINT)?.is_none() {
                return Err("access store is not initialized".into());
            }
            let mut table = tx.open_table(SESSIONS)?;
            for (token, value) in updates {
                if !valid_hash(&token) {
                    return Err("invalid session key".into());
                }
                table.insert(token.as_str(), (value.time, value.used))?;
            }
            for token in removals {
                if !valid_hash(&token) {
                    return Err("invalid session key".into());
                }
                table.remove(token.as_str())?;
            }
        }
        tx.commit()?;
        Ok(AccessResponse::Applied)
    }

    pub fn query(&self, request: AccessRequest) -> Result<AccessResponse> {
        match request {
            AccessRequest::Init { fingerprint } => self.initialize(&fingerprint),
            AccessRequest::Apply { updates, removals } => self.apply(updates, removals),
        }
    }
}
