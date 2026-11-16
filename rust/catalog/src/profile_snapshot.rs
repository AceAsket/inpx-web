use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};

use crate::{Result, atomic_file};

const MAX_INLINE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SnapshotRequest {
    Replace {
        expected: Option<String>,
        data: String,
    },
    Begin {
        expected: Option<String>,
        size: u64,
    },
    Finish,
    Cancel,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum SnapshotResponse {
    Staged { name: String },
    Stored,
    Changed,
    Canceled,
}

struct PendingSnapshot {
    file: NamedTempFile,
    expected: Option<String>,
    size: u64,
}

pub(crate) struct ProfileSnapshot {
    path: PathBuf,
    pending: RefCell<Option<PendingSnapshot>>,
}

impl ProfileSnapshot {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: RefCell::new(None),
        }
    }

    fn stage(&self) -> Result<NamedTempFile> {
        let parent = self.path.parent().ok_or("missing profile directory")?;
        Ok(Builder::new()
            .prefix(".reading-lists.")
            .tempfile_in(parent)?)
    }

    fn publish(&self, file: NamedTempFile, expected: Option<&str>) -> Result<SnapshotResponse> {
        if atomic_file::publish(file, &self.path, expected)?.is_some() {
            Ok(SnapshotResponse::Stored)
        } else {
            Ok(SnapshotResponse::Changed)
        }
    }

    pub(crate) fn apply(&self, request: SnapshotRequest) -> Result<SnapshotResponse> {
        let result = self.execute(request);
        if result.is_err() {
            self.pending.borrow_mut().take();
        }
        result
    }

    fn execute(&self, request: SnapshotRequest) -> Result<SnapshotResponse> {
        match request {
            SnapshotRequest::Replace { expected, data } => {
                if self.pending.borrow().is_some() {
                    return Err("another profile snapshot is staged".into());
                }
                let mut file = self.stage()?;
                file.write_all(&decode(&data)?)?;
                self.publish(file, expected.as_deref())
            }
            SnapshotRequest::Begin { expected, size } => {
                let mut pending = self.pending.borrow_mut();
                if pending.is_some() || size == 0 {
                    return Err("invalid profile snapshot start".into());
                }
                let file = self.stage()?;
                let name = file
                    .path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("invalid staging file name")?
                    .to_owned();
                *pending = Some(PendingSnapshot {
                    file,
                    expected,
                    size,
                });
                Ok(SnapshotResponse::Staged { name })
            }
            SnapshotRequest::Finish => {
                let snapshot = self
                    .pending
                    .borrow_mut()
                    .take()
                    .ok_or("missing staged profile snapshot")?;
                if snapshot.file.as_file().metadata()?.len() != snapshot.size {
                    return Err("incomplete staged profile snapshot".into());
                }
                self.publish(snapshot.file, snapshot.expected.as_deref())
            }
            SnapshotRequest::Cancel => {
                self.pending.borrow_mut().take();
                Ok(SnapshotResponse::Canceled)
            }
        }
    }
}

fn decode(encoded: &str) -> Result<Vec<u8>> {
    if encoded.len() > MAX_INLINE_BYTES.div_ceil(3) * 4 {
        return Err("inline profile snapshot exceeds its size limit".into());
    }
    let data = STANDARD.decode(encoded)?;
    if data.is_empty() || data.len() > MAX_INLINE_BYTES {
        return Err("invalid inline profile snapshot size".into());
    }
    Ok(data)
}
