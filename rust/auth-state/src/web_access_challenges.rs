use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::{deadlines::Deadlines, hex::hex32};

const MAX_CLIENT: u8 = 16;
const MAX_PENDING: usize = 4096;
pub const CHALLENGE_LIFETIME_MS: i64 = 5 * 60 * 1000;

pub enum Issue {
    Limited,
    EntropyUnavailable,
    Salt([u8; 64]),
}

#[derive(Default)]
pub struct WebAccessChallenges {
    pending: Deadlines<Box<str>>,
    clients: BTreeMap<Box<str>, u8>,
}

fn release(clients: &mut BTreeMap<Box<str>, u8>, client: &str) {
    if let Some(count) = clients.get_mut(client) {
        *count -= 1;
        if *count == 0 {
            clients.remove(client);
        }
    }
}

impl WebAccessChallenges {
    pub fn prune(&mut self, now: i64) {
        self.pending
            .expire(now, |client| release(&mut self.clients, &client));
    }

    fn allows(&mut self, client: &str, now: i64) -> bool {
        self.prune(now);
        self.pending.len() < MAX_PENDING
            && self.clients.get(client).copied().unwrap_or_default() < MAX_CLIENT
    }

    pub fn issue(
        &mut self,
        client: &str,
        password: &[u8],
        now: i64,
        timeout: i64,
        random: impl FnOnce() -> Option<[u8; 32]>,
    ) -> Issue {
        if !self.allows(client, now) {
            return Issue::Limited;
        }
        let Some(entropy) = random() else {
            return Issue::EntropyUnavailable;
        };
        let salt = hex32(&entropy);
        let mut hash = Sha256::new();
        hash.update(password);
        hash.update(salt);
        let token = hex32(&hash.finalize().into());
        let token = std::str::from_utf8(&token).expect("hex is ASCII");
        let lifetime = if timeout > 0 {
            timeout.min(CHALLENGE_LIFETIME_MS)
        } else {
            CHALLENGE_LIFETIME_MS
        };
        if let Some(previous) = self
            .pending
            .put(token, now.saturating_add(lifetime), client.into())
        {
            release(&mut self.clients, &previous);
        }
        if let Some(count) = self.clients.get_mut(client) {
            *count += 1;
        } else {
            self.clients.insert(client.into(), 1);
        }
        Issue::Salt(salt)
    }

    pub fn take(&mut self, token: &str, now: i64) -> bool {
        let Some((deadline, client)) = self.pending.take(token) else {
            return false;
        };
        release(&mut self.clients, &client);
        deadline > now
    }

    pub fn remove(&mut self, token: &str) {
        if let Some(client) = self.pending.remove(token) {
            release(&mut self.clients, &client);
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
