use std::fmt::Write;
use std::sync::{Arc, Mutex};

use inpx_auth_state::{
    sessions::ProfileSessions, totp_attempts::TotpAttempts, totp_enrollment::TotpEnrollments,
};
use inpx_catalog::access_runtime::now_ms;
use inpx_catalog::profile_login;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, mpsc::UnboundedSender};

use crate::report::Event;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(crate) enum Command {
    Issue { user: String },
    Check { token: String },
    Close { token: String },
    Revoke { user: String, keep: String },
    Clear { keep: String },
    Enrollment { required: bool, request: Enrollment },
    TotpAttempt { request: TotpAttempt },
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(crate) enum TotpAttempt {
    Allows { user: String, now: i64 },
    Failed { user: String, now: i64 },
    Reset { user: String },
    Clear,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(crate) enum Enrollment {
    Prepare {
        key: String,
    },
    Create {
        key: String,
        user: String,
        secret: String,
    },
    Secret {
        key: String,
        user: String,
    },
    Failed {
        key: String,
        user: String,
    },
    Remove {
        key: String,
    },
    Revoke {
        user: String,
    },
    Clear,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum Reply {
    Text(String),
    Ready(bool),
    Done,
}

pub(crate) struct State {
    sessions: ProfileSessions,
    signed_in: TotpEnrollments,
    required: TotpEnrollments,
    attempts: Arc<Mutex<TotpAttempts>>,
    profile_store: Arc<Mutex<profile_login::Store>>,
    revision: u64,
}

pub(crate) const MAX_PROOF_USER: usize = 128;
pub(crate) const TOKEN_LENGTH: usize = 48;
pub(crate) type Shared = Arc<Mutex<State>>;

pub(crate) struct Proof {
    pub(crate) revision: u64,
    pub(crate) deadline: i64,
    pub(crate) user: String,
}

pub(crate) fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LENGTH
        && token
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl Default for State {
    fn default() -> Self {
        Self {
            sessions: ProfileSessions::default(),
            signed_in: TotpEnrollments::new(false),
            required: TotpEnrollments::new(true),
            attempts: Arc::default(),
            profile_store: Arc::default(),
            revision: 0,
        }
    }
}

impl State {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    fn lookup(&mut self, token: &str, now: i64) -> Option<(String, i64)> {
        let result = self
            .sessions
            .with_session_deadline(token, now, |user| Some(user.to_string()));
        if result.is_none() {
            self.signed_in.remove(token);
        }
        result
    }

    pub(crate) fn prove(&mut self, token: &str, now: i64) -> Option<Proof> {
        let (user, deadline) = self
            .lookup(token, now)
            .unwrap_or_else(|| (String::new(), now.saturating_add(30_000)));
        (user.len() <= MAX_PROOF_USER).then_some(Proof {
            revision: self.revision,
            deadline,
            user,
        })
    }

    pub(crate) fn handle(&mut self, command: Command) -> Result<Reply, &'static str> {
        let now = now_ms();
        match command {
            Command::Issue { user } => {
                let token = loop {
                    let mut bytes = [0; 24];
                    getrandom::fill(&mut bytes)
                        .map_err(|_| "Не удалось выпустить токен профиля")?;
                    let mut token = String::with_capacity(TOKEN_LENGTH);
                    for byte in bytes {
                        write!(token, "{byte:02x}").expect("writing to String cannot fail");
                    }
                    if !self.sessions.has(&token) {
                        break token;
                    }
                };
                self.sessions.insert(&token, user.into(), now);
                self.revision += 1;
                Ok(Reply::Text(token))
            }
            Command::Check { token } => Ok(Reply::Text(
                self.lookup(&token, now)
                    .map(|(user, _)| user)
                    .unwrap_or_default(),
            )),
            Command::Close { token } => {
                self.sessions.remove(&token);
                self.signed_in.remove(&token);
                self.revision += 1;
                Ok(Reply::Done)
            }
            Command::Revoke { user, keep } => {
                self.sessions.revoke(&user, &keep);
                self.signed_in.revoke(&user, &keep);
                self.required.revoke(&user, "");
                self.revision += 1;
                Ok(Reply::Done)
            }
            Command::Clear { keep } => {
                self.sessions.clear_except(&keep);
                self.signed_in.clear_except(&keep);
                if keep.is_empty() {
                    self.required.clear_except("");
                }
                self.revision += 1;
                Ok(Reply::Done)
            }
            Command::TotpAttempt { request } => {
                let mut attempts = self.attempts.lock().expect("TOTP attempts");
                match request {
                    TotpAttempt::Allows { user, now } => {
                        Ok(Reply::Ready(attempts.allows(&user, now)))
                    }
                    TotpAttempt::Failed { user, now } => {
                        attempts.failed(&user, now);
                        Ok(Reply::Done)
                    }
                    TotpAttempt::Reset { user } => {
                        attempts.reset(&user);
                        Ok(Reply::Done)
                    }
                    TotpAttempt::Clear => {
                        *attempts = TotpAttempts::default();
                        Ok(Reply::Done)
                    }
                }
            }
            Command::Enrollment { required, request } => {
                let rows = if required {
                    &mut self.required
                } else {
                    &mut self.signed_in
                };
                match request {
                    Enrollment::Prepare { key } => {
                        Ok(Reply::Ready(
                            rows.prepare(now, &key, |token| self.sessions.has(token)),
                        ))
                    }
                    Enrollment::Create { key, user, secret } => {
                        if (!required
                            && self
                                .sessions
                                .with_session(&key, now, |owner| {
                                    (owner.as_ref() == user).then_some(())
                                })
                                .is_none())
                            || !rows.create(&key, &user, &secret, now)
                        {
                            return Err("Повторите настройку позже");
                        }
                        Ok(Reply::Done)
                    }
                    Enrollment::Secret { key, user } => Ok(Reply::Text(
                        rows.secret(&key, &user, now, str::to_owned)
                            .unwrap_or_default(),
                    )),
                    Enrollment::Failed { key, user } => {
                        rows.failed(&key, &user);
                        Ok(Reply::Done)
                    }
                    Enrollment::Remove { key } => {
                        rows.remove(&key);
                        Ok(Reply::Done)
                    }
                    Enrollment::Revoke { user } => {
                        rows.revoke(&user, "");
                        Ok(Reply::Done)
                    }
                    Enrollment::Clear => {
                        rows.clear_except("");
                        Ok(Reply::Done)
                    }
                }
            }
        }
    }
}

pub(crate) fn authenticate(
    id: u64,
    request: profile_login::Request,
    profiles: Option<&Shared>,
    workers: &Arc<Semaphore>,
    reports: &UnboundedSender<Event>,
) -> Result<(), &'static str> {
    let reply_error = |message: &str| {
        reports
            .send(Event::ProfileLogin {
                id,
                result: Err(message.into()),
            })
            .map_err(|_| "failed to report profile login result")
    };
    let Some(profiles) = profiles else {
        return reply_error("Хранилище сеансов профилей недоступно");
    };
    let Ok(permit) = workers.clone().try_acquire_owned() else {
        return reply_error("Проверка паролей занята, повторите позже");
    };
    let (attempts, store) = {
        let state = profiles.lock().expect("profile sessions");
        (state.attempts.clone(), state.profile_store.clone())
    };
    let reports = reports.clone();
    tokio::task::spawn_blocking(move || {
        let result =
            profile_login::authenticate(request, &attempts, &mut store.lock().expect("profiles"))
                .map_err(|error| error.to_string());
        drop(permit);
        let _ = reports.send(Event::ProfileLogin { id, result });
    });
    Ok(())
}
