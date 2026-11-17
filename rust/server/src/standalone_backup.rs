use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use inpx_catalog::Result;
use inpx_catalog::backup_snapshot::Backup;
use inpx_catalog::backup_vault::{Request as VaultRequest, ScheduleWindow};
use serde_json::Value;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

use super::{NAME, State, VERSION, socket::megabytes};
use crate::http::{Body, error};
use crate::request_access::Admission;
use crate::standalone_access::{self, BrowserProfileRequest};

pub(super) struct Backups {
    backup: Backup,
    root: String,
    route: String,
    operation: Mutex<()>,
    running: AtomicBool,
}

impl Backups {
    pub(super) fn new(data: &Path, file: &Path, root: &str, config: &Value) -> Self {
        let root = root.trim_end_matches('/');
        Self {
            backup: Backup::new(
                data,
                file,
                megabytes(&config["backupUploadLimitMb"], 32, 128) as u64,
                megabytes(&config["backupExpandedLimitMb"], 64, 256) as u64,
            ),
            root: root.into(),
            route: format!("{root}/admin-backups/"),
            operation: Mutex::new(()),
            running: AtomicBool::new(false),
        }
    }

    pub(super) fn request_limit(&self) -> usize {
        (self.backup.upload_limit as usize).div_ceil(3) * 4 + 65536
    }

    pub(super) fn dispatch(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let operation = request["operation"].as_str().unwrap_or_default();
        if action == "admin-backup-vault" && operation == "status" {
            state.access.backup(Some(profile), false, |_, _| Ok(()))?;
            return self.status();
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "Выполняется другая операция с резервными копиями")?;
        state.access.backup(Some(profile), false, |_, _| Ok(()))?;
        match action {
            "create-admin-backup" => self.create(state, Some(profile), false),
            "preview-admin-backup" | "import-admin-backup" => {
                self.restore(state, profile, action, request)
            }
            "admin-backup-vault" if matches!(operation, "preview" | "restore") => {
                self.restore(state, profile, action, request)
            }
            "admin-backup-vault" if operation == "update" => {
                self.backup.vault.update(&request["options"])?;
                self.status()
            }
            "admin-backup-vault" if operation == "delete" => {
                let name = request["options"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .into();
                self.backup.vault.execute(VaultRequest::Remove { name })?;
                self.status()
            }
            _ => Err("Неизвестное действие с резервной копией".into()),
        }
    }

    fn restore(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let stored = action == "admin-backup-vault";
        let preview =
            action == "preview-admin-backup" || (stored && request["operation"] == "preview");
        let archive = if stored {
            self.backup.stored(&request["options"])?
        } else {
            self.backup.upload(&request["data"])?
        };
        state.settings.with_backup(!preview, |current| {
            state.access.backup(Some(profile), !preview, |reader, _| {
                self.backup
                    .restore(archive, current, reader, &self.root, preview, |config| {
                        state.settings.validate_backup(config)
                    })
            })
        })
    }

    fn create(
        &self,
        state: &State,
        profile: Option<BrowserProfileRequest<'_>>,
        scheduled: bool,
    ) -> Result<Value> {
        self.running.store(true, Ordering::Relaxed);
        let result = (|| {
            let snapshot = state.settings.with_backup(false, |_| {
                state.access.backup(profile, false, |reader, stamp| {
                    self.backup.snapshot(reader, stamp, NAME, VERSION)
                })
            })?;
            let mut result = self.backup.publish(snapshot, scheduled)?;
            result["link"] = self
                .link(result["fileName"].as_str().expect("archive name"))
                .into();
            Ok(result)
        })();
        self.running.store(false, Ordering::Relaxed);
        result
    }

    fn status(&self) -> Result<Value> {
        let mut policy = self
            .backup
            .vault
            .execute(VaultRequest::Policy { window: None })?;
        let fields = policy.as_object_mut().expect("vault policy");
        let password_set = fields
            .remove("key")
            .and_then(|key| key.as_str().map(|key| !key.is_empty()))
            .unwrap_or(false);
        fields.remove("salt");
        fields.remove("version");
        let mut backups = self
            .backup
            .vault
            .execute(VaultRequest::List { scheduled: false })?;
        for row in backups.as_array_mut().expect("backup list") {
            let fields = row.as_object_mut().expect("backup entry");
            let modified = fields
                .remove("modifiedMs")
                .and_then(|value| value.as_i64())
                .unwrap_or_default();
            let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(modified) * 1_000_000)?
                .format(&Rfc3339)?;
            let link = self.link(fields["name"].as_str().expect("archive name"));
            fields.insert("createdAt".into(), date.into());
            fields.insert("link".into(), link.into());
        }
        policy["passwordSet"] = password_set.into();
        policy["running"] = self.running.load(Ordering::Relaxed).into();
        policy["timeZone"] = std::env::var("TZ")
            .unwrap_or_else(|_| {
                OffsetDateTime::now_local().map_or("UTC".into(), |date| date.offset().to_string())
            })
            .into();
        policy["uploadLimit"] = self.backup.upload_limit.into();
        policy["backups"] = backups;
        Ok(policy)
    }

    fn link(&self, name: &str) -> String {
        format!("{}{name}", self.route)
    }

    pub(super) async fn schedule(state: Arc<State>) {
        let mut retry_after = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if Instant::now() < retry_after {
                continue;
            }
            let server = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                server
                    .backups
                    .tick(&server)
                    .map_err(|error| error.to_string())
            })
            .await;
            match result {
                Ok(Ok(())) => (),
                Ok(Err(failure)) => {
                    eprintln!("Backup schedule: {failure}");
                    retry_after = Instant::now() + Duration::from_secs(3600);
                }
                Err(failure) => eprintln!("Backup worker: {failure}"),
            }
        }
    }

    fn tick(&self, state: &State) -> Result<()> {
        let Ok(_operation) = self.operation.try_lock() else {
            return Ok(());
        };
        let now = OffsetDateTime::now_utc();
        let local = now.to_offset(UtcOffset::local_offset_at(now).unwrap_or(UtcOffset::UTC));
        let window = ScheduleWindow::at(local)?;
        let policy = self.backup.vault.execute(VaultRequest::Policy {
            window: Some(window),
        })?;
        if policy.is_null() {
            return Ok(());
        }
        if let Err(failure) = self.create(state, None, true) {
            self.backup.vault.execute(VaultRequest::MarkFailed)?;
            return Err(failure);
        }
        self.backup.vault.execute(VaultRequest::MarkCreated {
            timestamp: OffsetDateTime::now_utc().format(&Rfc3339)?,
        })?;
        self.backup.vault.execute(VaultRequest::Rotate {
            keep: policy["keep"].as_u64().unwrap_or(7) as usize,
        })?;
        Ok(())
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.starts_with(&self.route)
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        request: Request<Incoming>,
        admission: Admission,
    ) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        let name = request
            .uri()
            .path()
            .strip_prefix(&self.route)
            .unwrap_or_default()
            .to_owned();
        let conditions = request.headers().clone();
        let state = state.clone();
        let file = tokio::task::spawn_blocking(move || {
            state
                .access
                .backup_download(request.headers(), &admission)
                .map_err(|rejected| rejected.response().status())?;
            state
                .backups
                .backup
                .vault
                .archive_path(&name)
                .map(|path| (path, name))
                .map_err(|_| StatusCode::NOT_FOUND)
        })
        .await;
        let (path, name) = match file {
            Ok(Ok(file)) => file,
            Ok(Err(status)) => return private_error(status),
            Err(_) => return private_error(StatusCode::INTERNAL_SERVER_ERROR),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(if name.ends_with(".enc") {
                "application/octet-stream"
            } else {
                "application/zip"
            }),
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
                .expect("validated archive name"),
        );
        standalone_access::private(&mut headers);
        let mut response = crate::download::send_local(path, headers, conditions, head).await;
        standalone_access::private(response.headers_mut());
        response
    }
}

fn private_error(status: StatusCode) -> Response<Body> {
    let mut response = error(status);
    standalone_access::private(response.headers_mut());
    response
}
