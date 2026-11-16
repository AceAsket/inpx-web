use std::collections::{BTreeMap, BTreeSet};

use crate::web_access_challenges::CHALLENGE_LIFETIME_MS;

#[derive(Clone, Copy)]
pub struct SessionValue {
    pub time: i64,
    pub used: u64,
}

struct Entry {
    version: u64,
    value: SessionValue,
    indexed_expiry: Option<i64>,
    durable: bool,
    dirty: bool,
}

pub enum Access {
    Denied,
    Allowed,
    Save(u64),
}

pub struct Refresh {
    pub token: Box<str>,
    pub version: u64,
    pub value: SessionValue,
}

pub struct Revocation {
    pub token: Box<str>,
    pub version: u64,
}

pub struct Changes {
    pub updates: Vec<Refresh>,
    pub removals: Vec<Revocation>,
}

#[derive(Default)]
pub struct WebAccessSessions {
    timeout: Option<i64>,
    sequence: u64,
    sessions: BTreeMap<Box<str>, Entry>,
    expiry: BTreeSet<(i64, Box<str>)>,
    dirty: BTreeSet<Box<str>>,
    revoked: BTreeMap<Box<str>, u64>,
}

fn expiry(value: SessionValue, timeout: Option<i64>) -> Option<i64> {
    let lifetime = if value.used == 0 {
        Some(
            timeout
                .unwrap_or(CHALLENGE_LIFETIME_MS)
                .min(CHALLENGE_LIFETIME_MS),
        )
    } else {
        timeout
    };
    lifetime.map(|lifetime| value.time.saturating_add(lifetime))
}

impl WebAccessSessions {
    pub fn new(timeout: Option<i64>) -> Self {
        Self {
            timeout,
            ..Self::default()
        }
    }

    fn next_version(&mut self) -> u64 {
        // 0 and 1 are reserved for denied and already durable decisions.
        self.sequence += 1;
        self.sequence + 1
    }

    fn register(&mut self, token: &str, value: SessionValue, durable: bool) -> u64 {
        let version = self.next_version();
        let indexed_expiry = expiry(value, self.timeout);
        if let Some(at) = indexed_expiry {
            self.expiry.insert((at, token.into()));
        }
        self.sessions.insert(
            token.into(),
            Entry {
                version,
                value,
                indexed_expiry,
                durable,
                dirty: false,
            },
        );
        version
    }

    pub fn restore(&mut self, token: &str, value: SessionValue) {
        self.forget(token);
        self.register(token, value, true);
    }

    pub fn use_token(&mut self, token: &str, now: i64, challenge: impl FnOnce() -> bool) -> Access {
        let Some(row) = self.sessions.get_mut(token) else {
            if !challenge() || self.timeout.is_some_and(|timeout| timeout <= 0) {
                return Access::Denied;
            }
            return Access::Save(self.register(token, SessionValue { time: now, used: 1 }, false));
        };
        if self
            .timeout
            .is_some_and(|timeout| now >= row.value.time.saturating_add(timeout))
        {
            return Access::Denied;
        }
        let clock_reversed = now < row.value.time;
        row.value.time = now;
        row.value.used = row.value.used.saturating_add(1);
        if clock_reversed {
            if let Some(at) = row.indexed_expiry {
                self.expiry.remove(&(at, token.into()));
            }
            row.indexed_expiry = expiry(row.value, self.timeout);
            if let Some(at) = row.indexed_expiry {
                self.expiry.insert((at, token.into()));
            }
        }
        if !row.durable {
            return Access::Save(row.version);
        }
        if !row.dirty {
            row.dirty = true;
            self.dirty.insert(token.into());
        }
        Access::Allowed
    }

    pub fn grant(&self, token: &str, version: u64) -> Option<SessionValue> {
        self.sessions
            .get(token)
            .filter(|row| row.version == version)
            .map(|row| row.value)
    }

    pub fn finish_grant(&mut self, token: &str, version: u64, saved_used: u64) -> bool {
        let Some(row) = self
            .sessions
            .get_mut(token)
            .filter(|row| row.version == version)
        else {
            return false;
        };
        row.durable = true;
        self.revoked.remove(token);
        if row.value.used != saved_used && !row.dirty {
            row.dirty = true;
            self.dirty.insert(token.into());
        }
        true
    }

    fn forget(&mut self, token: &str) -> bool {
        let Some(row) = self.sessions.remove(token) else {
            return false;
        };
        if let Some(at) = row.indexed_expiry {
            self.expiry.remove(&(at, token.into()));
        }
        self.dirty.remove(token);
        true
    }

    pub fn revoke(&mut self, token: &str) -> Option<u64> {
        if self.forget(token) {
            let version = self.next_version();
            self.revoked.insert(token.into(), version);
            Some(version)
        } else {
            self.revoked.get(token).copied()
        }
    }

    pub fn finish_revocation(&mut self, token: &str, version: u64) {
        if self.revoked.get(token) == Some(&version) {
            self.revoked.remove(token);
        }
    }

    pub fn retry_refresh(&mut self, token: &str, version: u64) {
        if let Some(row) = self
            .sessions
            .get_mut(token)
            .filter(|row| row.version == version)
            && !row.dirty
        {
            row.dirty = true;
            self.dirty.insert(token.into());
        }
    }

    fn expire(&mut self, now: i64) {
        while self.expiry.first().is_some_and(|(at, _)| *at <= now) {
            let (_, token) = self.expiry.pop_first().expect("checked first deadline");
            let row = self
                .sessions
                .get_mut(token.as_ref())
                .expect("indexed session");
            row.indexed_expiry = expiry(row.value, self.timeout);
            match row.indexed_expiry {
                Some(at) if at <= now => {
                    let version = self.next_version();
                    self.sessions.remove(token.as_ref());
                    self.dirty.remove(token.as_ref());
                    self.revoked.insert(token, version);
                }
                Some(at) => {
                    self.expiry.insert((at, token));
                }
                None => {}
            }
        }
    }

    pub fn collect(&mut self, now: i64) -> Changes {
        self.expire(now);
        let dirty = std::mem::take(&mut self.dirty);
        let updates = dirty
            .into_iter()
            .map(|token| {
                let row = self
                    .sessions
                    .get_mut(token.as_ref())
                    .expect("dirty session");
                row.dirty = false;
                Refresh {
                    token,
                    version: row.version,
                    value: row.value,
                }
            })
            .collect();
        let removals = self
            .revoked
            .iter()
            .filter(|(token, _)| !self.sessions.contains_key(token.as_ref()))
            .map(|(token, &version)| Revocation {
                token: token.clone(),
                version,
            })
            .collect();
        Changes { updates, removals }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}
