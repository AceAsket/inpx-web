use crate::deadlines::Deadlines;

const MAX_PENDING: usize = 128;
const MAX_ATTEMPTS: u8 = 8;
const LIFETIME_MS: i64 = 5 * 60 * 1000;

struct Enrollment {
    token: Box<str>,
    user: Box<str>,
    secret: Box<str>,
    attempts: u8,
}

pub struct TotpEnrollments {
    required: bool,
    pending: Deadlines<Enrollment>,
}

impl TotpEnrollments {
    pub fn new(required: bool) -> Self {
        Self {
            required,
            pending: Deadlines::default(),
        }
    }

    pub fn prepare(&mut self, now: i64, key: &str, live_session: impl FnMut(&str) -> bool) -> bool {
        self.pending.expire(now, |_| {});
        if self.required {
            self.pending.remove(key);
            return self.pending.len() < MAX_PENDING;
        }
        if self.pending.len() < MAX_PENDING || self.has(key) {
            return true;
        }
        let mut live_session = live_session;
        self.pending.retain(|key, _| live_session(key));
        self.pending.len() < MAX_PENDING
    }

    pub fn create(&mut self, key: &str, user: &str, secret: &str, now: i64) -> bool {
        let index = if self.required { user } else { key };
        if self.pending.len() >= MAX_PENDING && !self.has(index) {
            return false;
        }
        self.pending.put(
            index,
            now.saturating_add(LIFETIME_MS),
            Enrollment {
                token: key.into(),
                user: user.into(),
                secret: secret.into(),
                attempts: 0,
            },
        );
        true
    }

    pub fn secret<R>(
        &mut self,
        key: &str,
        user: &str,
        now: i64,
        read: impl FnOnce(&str) -> R,
    ) -> Option<R> {
        let index = if self.required { user } else { key };
        let (deadline, row) = self.pending.get(index)?;
        if row.user.as_ref() != user || row.token.as_ref() != key {
            return None;
        }
        if deadline <= now || row.attempts >= MAX_ATTEMPTS {
            self.pending.remove(index);
            return None;
        }
        Some(read(&row.secret))
    }

    pub fn failed(&mut self, key: &str, user: &str) {
        let index = if self.required { user } else { key };
        if let Some(row) = self.pending.get_mut(index)
            && row.user.as_ref() == user
            && row.token.as_ref() == key
        {
            row.attempts = row.attempts.saturating_add(1);
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.pending.get(key).is_some()
    }

    pub fn remove(&mut self, key: &str) {
        self.pending.remove(key);
    }

    pub fn revoke(&mut self, user: &str, keep: &str) {
        if self.required {
            self.pending.remove(user);
        } else {
            self.pending
                .retain(|key, row| key == keep || row.user.as_ref() != user);
        }
    }

    pub fn clear_except(&mut self, keep: &str) {
        if keep.is_empty() {
            self.pending = Deadlines::default();
        } else {
            self.pending.retain(|key, _| key == keep);
        }
    }
}
