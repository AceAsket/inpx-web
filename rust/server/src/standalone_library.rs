use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::request_access::Live;
use inpx_auth_state::access_wire;
use inpx_auth_state::login_rate::{Kind, LoginRate};
use inpx_catalog::Result;
use inpx_catalog::access_runtime::{AccessCommand, AccessReply, AccessRuntime, now_ms};
use inpx_catalog::catalogue_lock::{CatalogueLease, OnLost};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

pub(crate) struct Library {
    protected: bool,
    store: Option<Mutex<Option<Store>>>,
    access: Arc<Live>,
    lease_lost: Arc<AtomicBool>,
}

struct Store {
    runtime: AccessRuntime,
    lease: CatalogueLease,
    attempts: LoginRate,
}

pub(crate) enum Admission {
    Allowed,
    Challenge(String),
    RateLimited(u32),
}

impl Library {
    pub(crate) fn login_password(
        &self,
        peer: IpAddr,
        password: &str,
    ) -> Result<(Admission, String)> {
        let Admission::Challenge(salt) = self.admit(peer, "")? else {
            return Ok((
                if self.protected {
                    Admission::RateLimited(300)
                } else {
                    Admission::Allowed
                },
                String::new(),
            ));
        };
        let mut value = Sha256::new();
        value.update(password.as_bytes());
        value.update(salt.as_bytes());
        let token = value
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok((self.admit(peer, &token)?, token))
    }
    pub(crate) fn open(
        data: &Path,
        password: &str,
        timeout: Option<i64>,
        access: Arc<Live>,
        on_lease_lost: Option<OnLost>,
    ) -> Result<Self> {
        let protected = !password.is_empty();
        let directory = data.join("web-access");
        let lease_lost = Arc::new(AtomicBool::new(false));
        let store = if protected || directory.try_exists()? {
            let mut create = fs::DirBuilder::new();
            create.recursive(true);
            #[cfg(unix)]
            create.mode(0o700);
            create.create(&directory)?;
            let lib_lost = Arc::clone(&lease_lost);
            let on_lost: OnLost = Arc::new(move |reason| {
                lib_lost.store(true, Ordering::Release);
                if let Some(notify) = &on_lease_lost {
                    notify(reason);
                }
            });
            let lease = CatalogueLease::open_with_on_lost(&directory, Some(on_lost))?;
            let file = directory.join("sessions.redb");
            let mut open = fs::OpenOptions::new();
            open.create(true).append(true);
            #[cfg(unix)]
            open.mode(0o600);
            drop(open.open(&file)?);
            let runtime = AccessRuntime::open(&file, password.as_bytes(), timeout)?
                .ok_or("Нужно восстановить прежнее хранилище сеансов доступа")?;
            Some(Mutex::new(Some(Store {
                runtime,
                lease,
                attempts: LoginRate::default(),
            })))
        } else {
            None
        };
        Ok(Self {
            protected,
            store,
            access,
            lease_lost,
        })
    }

    pub(crate) fn is_lease_lost(&self) -> bool {
        self.lease_lost.load(Ordering::Acquire)
    }

    pub(crate) fn close(&self) {
        self.lease_lost.store(true, Ordering::Release);
        if let Some(store) = &self.store {
            let mut guard = store.lock().unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }
    }

    pub(crate) fn protected(&self) -> bool {
        self.protected
    }

    pub(crate) fn allowed(&self, token: &str) -> Result<bool> {
        let Some(store) = self.store.as_ref().filter(|_| self.protected) else {
            return Ok(true);
        };
        if self.is_lease_lost() {
            return Err("Catalogue lease lost".into());
        }
        if access_wire::token(token.as_bytes()).is_none() {
            return Ok(false);
        }
        let mut guard = store
            .lock()
            .map_err(|_| "Хранилище сеансов доступа недоступно")?;
        let Some(store) = guard.as_mut() else {
            return Err("Catalogue lease lost".into());
        };
        store.lease.check()?;
        check(store, token, now_ms())
    }

    pub(crate) fn login_metrics(&self) -> [u64; inpx_auth_state::login_rate::METRIC_COUNT] {
        if self.is_lease_lost() {
            return [0; inpx_auth_state::login_rate::METRIC_COUNT];
        }
        self.store
            .as_ref()
            .and_then(|store| store.lock().ok())
            .map_or(
                [0; inpx_auth_state::login_rate::METRIC_COUNT],
                |mut guard| {
                    guard
                        .as_mut()
                        .map_or([0; inpx_auth_state::login_rate::METRIC_COUNT], |store| {
                            store
                                .attempts
                                .metrics(now_ms(), self.access.current().login_rate.max_attempts)
                        })
                },
            )
    }

    pub(crate) fn admit(&self, peer: IpAddr, token: &str) -> Result<Admission> {
        let Some(store) = self.store.as_ref().filter(|_| self.protected) else {
            return Ok(Admission::Allowed);
        };
        if self.is_lease_lost() {
            return Err("Catalogue lease lost".into());
        }
        let mut guard = store
            .lock()
            .map_err(|_| "Хранилище сеансов доступа недоступно")?;
        let Some(store) = guard.as_mut() else {
            return Err("Catalogue lease lost".into());
        };
        store.lease.check()?;
        let now = now_ms();
        let policy = self.access.current().login_rate;
        let client = peer.to_string();
        if !token.is_empty() {
            if store.runtime.sessions().check_durable(token, now) {
                return Ok(Admission::Allowed);
            }
            let retry = store
                .attempts
                .check(Kind::Access, &client, now, policy, false);
            if retry != 0 {
                return Ok(Admission::RateLimited(retry));
            }
            let allowed =
                access_wire::token(token.as_bytes()).is_some() && check(store, token, now)?;
            store
                .attempts
                .finish(Kind::Access, &client, now, policy, false, Some(allowed));
            if allowed {
                return Ok(Admission::Allowed);
            }
        }
        match store.runtime.run(AccessCommand::Issue { client }, now)? {
            AccessReply::Challenge { salt } => Ok(Admission::Challenge(salt)),
            AccessReply::ChallengeLimit => Ok(Admission::RateLimited(300)),
            _ => Err("Не удалось получить случайные данные для токена доступа".into()),
        }
    }

    pub(crate) fn logout(&self, token: &str) -> Result<()> {
        if let Some(store) = self.store.as_ref().filter(|_| self.protected)
            && access_wire::token(token.as_bytes()).is_some()
        {
            if self.is_lease_lost() {
                return Err("Catalogue lease lost".into());
            }
            let mut guard = store
                .lock()
                .map_err(|_| "Хранилище сеансов доступа недоступно")?;
            let Some(store) = guard.as_mut() else {
                return Err("Catalogue lease lost".into());
            };
            store.lease.check()?;
            store.runtime.run(
                AccessCommand::Revoke {
                    token: token.into(),
                },
                now_ms(),
            )?;
        }
        Ok(())
    }

    pub(crate) fn flush(&self) -> Result<()> {
        if let Some(store) = &self.store {
            if self.is_lease_lost() {
                return Err("Catalogue lease lost".into());
            }
            let mut guard = store
                .lock()
                .map_err(|_| "Хранилище сеансов доступа недоступно")?;
            let Some(store) = guard.as_mut() else {
                return Err("Catalogue lease lost".into());
            };
            store.lease.check()?;
            store.runtime.flush(now_ms())?;
        }
        Ok(())
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        if self.lease.is_lost() {
            return;
        }
        if let Err(error) = self.runtime.flush(now_ms()) {
            log::error!(target: "inpx::auth", "WebAccess flush: {error}");
        }
    }
}

fn check(store: &mut Store, token: &str, now: i64) -> Result<bool> {
    Ok(matches!(
        store.runtime.run(
            AccessCommand::Check {
                token: token.into()
            },
            now
        )?,
        AccessReply::Allowed
    ))
}
