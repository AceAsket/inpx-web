use std::collections::{BTreeMap, BTreeSet};

const MAX_PROFILES: usize = 4096;
const WINDOW_MS: i64 = 5 * 60 * 1000;
const MAX_ATTEMPTS: u8 = 8;

struct Entry {
    failures: u8,
    expires_at: i64,
}

#[derive(Default)]
pub struct TotpAttempts {
    failures: BTreeMap<Box<str>, Entry>,
    expiry: BTreeSet<(i64, Box<str>)>,
}

impl TotpAttempts {
    pub fn allows(&mut self, user: &str, now: i64) -> bool {
        self.prune(now);
        self.failures
            .get(user)
            .map_or(self.failures.len() < MAX_PROFILES, |entry| {
                entry.failures < MAX_ATTEMPTS
            })
    }

    pub fn failed(&mut self, user: &str, now: i64) {
        self.prune(now);
        if let Some(entry) = self.failures.get_mut(user) {
            entry.failures = entry.failures.saturating_add(1);
        } else if self.failures.len() < MAX_PROFILES {
            let expires_at = now.saturating_add(WINDOW_MS);
            self.failures.insert(
                user.into(),
                Entry {
                    failures: 1,
                    expires_at,
                },
            );
            self.expiry.insert((expires_at, user.into()));
        }
    }

    pub fn reset(&mut self, user: &str) {
        if let Some(entry) = self.failures.remove(user) {
            self.expiry.remove(&(entry.expires_at, user.into()));
        }
    }

    fn prune(&mut self, now: i64) {
        while self
            .expiry
            .first()
            .is_some_and(|(expires_at, _)| *expires_at <= now)
        {
            let (_, user) = self.expiry.pop_first().expect("checked first item");
            self.failures.remove(user.as_ref());
        }
    }
}
