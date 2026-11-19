use std::cell::RefCell;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};

use crate::crypto_support::Secret;
use crate::profile_bootstrap::{self, Options};
use crate::profile_store::{CredentialPatch, CredentialUpdate, Store};
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
    Credentials {
        expected: Option<String>,
        user: String,
        patch: CredentialPatch,
    },
    BootstrapAdmin {
        expected: Option<String>,
        options: Options,
    },
    Finish,
    Cancel,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum SnapshotResponse {
    Staged {
        name: String,
    },
    Stored,
    Changed,
    Canceled,
    Legacy,
    Missing,
    AdminReady {
        stamp: String,
        #[serde(rename = "generatedPassword", skip_serializing_if = "Option::is_none")]
        generated_password: Option<Secret>,
    },
    AdminLoginConflict,
}

struct PendingSnapshot {
    file: NamedTempFile,
    expected: Option<String>,
    size: u64,
}

pub(crate) struct ProfileSnapshot {
    path: PathBuf,
    pending: RefCell<Option<PendingSnapshot>>,
    profiles: RefCell<Store>,
}

impl ProfileSnapshot {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: RefCell::new(None),
            profiles: RefCell::default(),
        }
    }

    fn stage(&self) -> Result<NamedTempFile> {
        stage(&self.path)
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
            SnapshotRequest::Credentials {
                expected,
                user,
                patch,
            } => {
                if self.pending.borrow().is_some() {
                    return Err("another profile snapshot is staged".into());
                }
                let result = self.profiles.borrow_mut().update_credentials(
                    &self.path,
                    expected.as_deref(),
                    &user,
                    patch,
                )?;
                Ok(match result {
                    CredentialUpdate::Stored => SnapshotResponse::Stored,
                    CredentialUpdate::Legacy => SnapshotResponse::Legacy,
                    CredentialUpdate::Changed => SnapshotResponse::Changed,
                    CredentialUpdate::Missing => SnapshotResponse::Missing,
                })
            }
            SnapshotRequest::BootstrapAdmin { expected, options } => {
                if self.pending.borrow().is_some() {
                    return Err("another profile snapshot is staged".into());
                }
                Ok(
                    match profile_bootstrap::run(&self.path, expected.as_deref(), options)? {
                        profile_bootstrap::Outcome::Ready {
                            stamp,
                            generated_password,
                        } => SnapshotResponse::AdminReady {
                            stamp,
                            generated_password,
                        },
                        profile_bootstrap::Outcome::Changed => SnapshotResponse::Changed,
                        profile_bootstrap::Outcome::Legacy => SnapshotResponse::Legacy,
                        profile_bootstrap::Outcome::LoginConflict => {
                            SnapshotResponse::AdminLoginConflict
                        }
                    },
                )
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

pub(crate) fn stage(path: &Path) -> Result<NamedTempFile> {
    let parent = path.parent().ok_or("missing profile directory")?;
    Ok(Builder::new()
        .prefix(".reading-lists.")
        .tempfile_in(parent)?)
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
