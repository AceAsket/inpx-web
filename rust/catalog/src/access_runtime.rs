use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use inpx_auth_state::access_wire;
use inpx_auth_state::library_password::LibraryPassword;
use inpx_auth_state::web_access_challenges::{Issue, WebAccessChallenges};
use inpx_auth_state::web_access_sessions::{Access, SessionValue, WebAccessSessions};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::access_store::AccessStore;
use crate::crypto_support::{Sensitive, hex, random};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AccessCommand {
    Check { token: String },
    Issue { client: String },
    Login { client: String, password: String },
    Revoke { token: String },
    Flush,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AccessReply {
    Allowed,
    Denied,
    Applied,
    Challenge { salt: String },
    Granted { token: String },
    ChallengeLimit,
    Unavailable,
    GrantFailed,
}

#[derive(Clone)]
pub struct AccessSessions(Arc<Mutex<WebAccessSessions>>);

impl AccessSessions {
    pub fn check_durable(&self, token: &str, now: i64) -> bool {
        access_wire::token(token.as_bytes()).is_some()
            && self
                .0
                .lock()
                .expect("library sessions")
                .use_durable(token, now)
    }
}

pub struct AccessRuntime {
    store: AccessStore,
    sessions: AccessSessions,
    challenges: WebAccessChallenges,
    password: LibraryPassword,
    free_access: bool,
    timeout: Option<i64>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

impl AccessRuntime {
    pub fn open(file: &Path, password: &[u8], timeout: Option<i64>) -> Result<Option<Self>> {
        let free_access = password.is_empty();
        let password = LibraryPassword::new(password);
        let store = AccessStore::open(file)?;
        let fingerprint = password.fingerprint();
        let fingerprint = std::str::from_utf8(&fingerprint).expect("hex fingerprint");
        if !store.prepare(fingerprint)? {
            return Ok(None);
        }
        let mut sessions = WebAccessSessions::new(timeout);
        store.visit_sessions(|token, time, used| {
            sessions.restore(
                token,
                SessionValue {
                    time: time.min(i64::MAX as u64) as i64,
                    used,
                },
            );
            Ok(())
        })?;
        Ok(Some(Self {
            store,
            sessions: AccessSessions(Arc::new(Mutex::new(sessions))),
            challenges: WebAccessChallenges::default(),
            password,
            free_access,
            timeout,
        }))
    }

    pub fn sessions(&self) -> AccessSessions {
        self.sessions.clone()
    }

    pub fn run(&mut self, command: AccessCommand, now: i64) -> Result<AccessReply> {
        match command {
            AccessCommand::Check { token } => self.check(&token, now),
            AccessCommand::Issue { client } => Ok(self.issue(&client, now)),
            AccessCommand::Login { client, password } => {
                let password = Sensitive(password.into_bytes());
                self.login(&client, &password.0, now)
            }
            AccessCommand::Revoke { token } => {
                self.revoke(&token)?;
                Ok(AccessReply::Applied)
            }
            AccessCommand::Flush => {
                self.flush(now)?;
                Ok(AccessReply::Applied)
            }
        }
    }

    fn issue(&mut self, client: &str, now: i64) -> AccessReply {
        match self.challenges.issue_configured(
            client,
            &self.password,
            now,
            self.timeout.unwrap_or(0),
            || random().ok(),
        ) {
            Issue::Salt(salt) => AccessReply::Challenge {
                salt: String::from_utf8(salt.to_vec()).expect("hex salt"),
            },
            Issue::Limited => AccessReply::ChallengeLimit,
            Issue::EntropyUnavailable => AccessReply::Unavailable,
        }
    }

    fn check(&mut self, token: &str, now: i64) -> Result<AccessReply> {
        if self.free_access {
            return Ok(AccessReply::Allowed);
        }
        if access_wire::token(token.as_bytes()).is_none() {
            return Ok(AccessReply::Denied);
        }
        let access =
            self.sessions
                .0
                .lock()
                .expect("library sessions")
                .use_token(token, now, || self.challenges.take(token, now));
        match access {
            Access::Denied => Ok(AccessReply::Denied),
            Access::Allowed => Ok(AccessReply::Allowed),
            Access::Save(version) => {
                self.confirm_grant(token, version)?;
                Ok(AccessReply::Allowed)
            }
        }
    }

    fn login(&mut self, client: &str, supplied: &[u8], now: i64) -> Result<AccessReply> {
        if !self.password.verify(supplied) {
            return Ok(AccessReply::Denied);
        }
        if !self.challenges.has_capacity(client, now) {
            return Ok(AccessReply::ChallengeLimit);
        }
        let Ok(entropy) = random::<32>() else {
            return Ok(AccessReply::Unavailable);
        };
        let token = hex(&entropy);
        if self.free_access {
            return Ok(AccessReply::Granted { token });
        }
        let version = self
            .sessions
            .0
            .lock()
            .expect("library sessions")
            .issue_verified(&token, now);
        let Some(version) = version else {
            return Ok(AccessReply::Unavailable);
        };
        if let Err(error) = self.confirm_grant(&token, version) {
            self.sessions
                .0
                .lock()
                .expect("library sessions")
                .revoke(&token);
            eprintln!("Could not persist a new library session: {error}");
            return Ok(AccessReply::GrantFailed);
        }
        Ok(AccessReply::Granted { token })
    }

    fn confirm_grant(&self, token: &str, version: u64) -> Result<()> {
        let value = self
            .sessions
            .0
            .lock()
            .expect("library sessions")
            .grant(token, version)
            .ok_or("Library grant disappeared before persistence")?;
        self.store.persist([(token, value)], [])?;
        self.sessions
            .0
            .lock()
            .expect("library sessions")
            .finish_grant(token, version, value.used);
        Ok(())
    }

    fn revoke(&mut self, token: &str) -> Result<()> {
        self.challenges.remove(token);
        let version = self
            .sessions
            .0
            .lock()
            .expect("library sessions")
            .revoke(token);
        if let Some(version) = version {
            self.store.persist([], [token])?;
            self.sessions
                .0
                .lock()
                .expect("library sessions")
                .finish_revocation(token, version);
        }
        Ok(())
    }

    pub fn flush(&mut self, now: i64) -> Result<()> {
        self.challenges.prune(now);
        let rows = self
            .sessions
            .0
            .lock()
            .expect("library sessions")
            .collect(now);
        if rows.updates.is_empty() && rows.removals.is_empty() {
            return Ok(());
        }
        let saved = self.store.persist(
            rows.updates
                .iter()
                .map(|row| (row.token.as_ref(), row.value)),
            rows.removals.iter().map(|row| row.token.as_ref()),
        );
        let mut sessions = self.sessions.0.lock().expect("library sessions");
        if saved.is_ok() {
            for row in rows.removals {
                sessions.finish_revocation(&row.token, row.version);
            }
        } else {
            for row in rows.updates {
                sessions.retry_refresh(&row.token, row.version);
            }
        }
        saved
    }
}
