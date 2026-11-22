use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::request_access::Live;
use inpx_auth_state::access_wire;
use inpx_auth_state::login_rate::{Kind, LoginRate};
use inpx_catalog::Result;
use inpx_catalog::access_runtime::{AccessCommand, AccessReply, AccessRuntime, now_ms};
use inpx_catalog::catalogue_lock::CatalogueLease;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

pub(crate) struct Library {
    protected: bool,
    store: Option<Mutex<Store>>,
    access: Arc<Live>,
}

struct Store {
    runtime: AccessRuntime,
    _lease: CatalogueLease,
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
    ) -> Result<Self> {
        let protected = !password.is_empty();
        let directory = data.join("web-access");
        let store = if protected || directory.try_exists()? {
            let mut create = fs::DirBuilder::new();
            create.recursive(true);
            #[cfg(unix)]
            create.mode(0o700);
            create.create(&directory)?;
            let lease = CatalogueLease::open(&directory)?;
            let file = directory.join("sessions.redb");
            let mut open = fs::OpenOptions::new();
            open.create(true).append(true);
            #[cfg(unix)]
            open.mode(0o600);
            drop(open.open(&file)?);
            let runtime = AccessRuntime::open(&file, password.as_bytes(), timeout)?
                .ok_or("Нужно восстановить прежнее хранилище сеансов доступа")?;
            Some(Mutex::new(Store {
                runtime,
                _lease: lease,
                attempts: LoginRate::default(),
            }))
        } else {
            None
        };
        Ok(Self {
            protected,
            store,
            access,
        })
    }

    pub(crate) fn protected(&self) -> bool {
        self.protected
    }

    pub(crate) fn allowed(&self, token: &str) -> Result<bool> {
        let Some(store) = self.store.as_ref().filter(|_| self.protected) else {
            return Ok(true);
        };
        if access_wire::token(token.as_bytes()).is_none() {
            return Ok(false);
        }
        let mut store = store
            .lock()
            .map_err(|_| "Хранилище сеансов доступа недоступно")?;
        check(&mut store, token, now_ms())
    }

    pub(crate) fn login_metrics(&self) -> [u64; inpx_auth_state::login_rate::METRIC_COUNT] {
        self.store
            .as_ref()
            .and_then(|store| store.lock().ok())
            .map_or(
                [0; inpx_auth_state::login_rate::METRIC_COUNT],
                |mut store| {
                    store
                        .attempts
                        .metrics(now_ms(), self.access.current().login_rate.max_attempts)
                },
            )
    }

    pub(crate) fn admit(&self, peer: IpAddr, token: &str) -> Result<Admission> {
        let Some(store) = self.store.as_ref().filter(|_| self.protected) else {
            return Ok(Admission::Allowed);
        };
        let mut store = store
            .lock()
            .map_err(|_| "Хранилище сеансов доступа недоступно")?;
        let now = now_ms();
        let policy = self.access.current().login_rate;
        let client = peer.to_string();
        let allowed =
            access_wire::token(token.as_bytes()).is_some() && check(&mut store, token, now)?;
        if !token.is_empty() {
            if !allowed {
                let retry = store
                    .attempts
                    .check(Kind::Access, &client, now, policy, false);
                if retry != 0 {
                    return Ok(Admission::RateLimited(retry));
                }
            }
            store
                .attempts
                .finish(Kind::Access, &client, now, policy, false, Some(allowed));
        }
        if allowed {
            return Ok(Admission::Allowed);
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
            store
                .lock()
                .map_err(|_| "Хранилище сеансов доступа недоступно")?
                .runtime
                .run(
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
            store
                .lock()
                .map_err(|_| "Хранилище сеансов доступа недоступно")?
                .runtime
                .flush(now_ms())?;
        }
        Ok(())
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        if let Err(error) = self.runtime.flush(now_ms()) {
            eprintln!("WebAccess flush: {error}");
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
