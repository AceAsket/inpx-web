use std::collections::{BTreeMap, BTreeSet};

pub(crate) const MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const IDLE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS: usize = 10_000;

pub trait SessionData {
    fn owner(&self) -> Option<&str> {
        None
    }
}

impl SessionData for Box<str> {
    fn owner(&self) -> Option<&str> {
        Some(self)
    }
}

struct Session<T> {
    id: u64,
    value: T,
    created_at: i64,
    expires_at: i64,
}

pub struct SessionTable<T> {
    sequence: u64,
    tokens: BTreeMap<Box<str>, Session<T>>,
    order: BTreeMap<u64, Box<str>>,
    users: BTreeMap<Box<str>, BTreeSet<u64>>,
    expiry: BTreeSet<(i64, u64)>,
}

impl<T> Default for SessionTable<T> {
    fn default() -> Self {
        Self {
            sequence: 0,
            tokens: BTreeMap::new(),
            order: BTreeMap::new(),
            users: BTreeMap::new(),
            expiry: BTreeSet::new(),
        }
    }
}

pub type ProfileSessions = SessionTable<Box<str>>;

impl<T: SessionData> SessionTable<T> {
    pub fn insert(&mut self, token: &str, value: T, now: i64) {
        while let Some(&(time, id)) = self.expiry.first() {
            if time > now {
                break;
            }
            self.remove_id(id);
        }
        self.remove(token);
        if self.tokens.len() >= MAX_SESSIONS {
            self.remove_id(
                *self
                    .order
                    .first_key_value()
                    .expect("nonempty session order")
                    .0,
            );
        }
        self.sequence += 1;
        let id = self.sequence;
        let expires_at = now.saturating_add(IDLE_MS);
        self.register(
            token,
            Session {
                id,
                value,
                created_at: now,
                expires_at,
            },
        );
    }

    fn register(&mut self, token: &str, session: Session<T>) {
        self.order.insert(session.id, token.into());
        if let Some(owner) = session.value.owner() {
            self.users
                .entry(owner.into())
                .or_default()
                .insert(session.id);
        }
        self.expiry.insert((session.expires_at, session.id));
        self.tokens.insert(token.into(), session);
    }

    pub fn has(&self, token: &str) -> bool {
        self.tokens.contains_key(token)
    }

    pub fn get(&self, token: &str) -> Option<&T> {
        self.tokens.get(token).map(|entry| &entry.value)
    }

    pub fn update(&mut self, mut refresh: impl FnMut(&T) -> Option<T>) {
        for session in self.tokens.values_mut() {
            if let Some(value) = refresh(&session.value) {
                assert_eq!(session.value.owner(), value.owner());
                session.value = value;
            }
        }
    }

    pub(crate) fn get_mut(&mut self, token: &str) -> Option<&mut T> {
        self.tokens.get_mut(token).map(|entry| &mut entry.value)
    }

    pub fn with_session<R>(
        &mut self,
        token: &str,
        now: i64,
        read: impl FnOnce(&T) -> Option<R>,
    ) -> Option<R> {
        self.with_session_deadline(token, now, read)
            .map(|(value, _)| value)
    }

    pub fn with_session_deadline<R>(
        &mut self,
        token: &str,
        now: i64,
        read: impl FnOnce(&T) -> Option<R>,
    ) -> Option<(R, i64)> {
        let session = self.tokens.get_mut(token)?;
        if session.expires_at <= now {
            self.remove(token);
            return None;
        }
        let result = read(&session.value)?;
        let expires_at = now
            .saturating_add(IDLE_MS)
            .min(session.created_at.saturating_add(MAX_AGE_MS));
        if expires_at != session.expires_at {
            self.expiry.remove(&(session.expires_at, session.id));
            self.expiry.insert((expires_at, session.id));
            session.expires_at = expires_at;
        }
        Some((result, expires_at))
    }

    pub fn remove(&mut self, token: &str) {
        let Some(session) = self.tokens.remove(token) else {
            return;
        };
        self.order.remove(&session.id);
        self.remove_indexes(session);
    }

    fn remove_id(&mut self, id: u64) {
        let Some(token) = self.order.remove(&id) else {
            return;
        };
        if let Some(session) = self.tokens.remove(token.as_ref()) {
            self.remove_indexes(session);
        }
    }

    fn remove_indexes(&mut self, session: Session<T>) {
        self.expiry.remove(&(session.expires_at, session.id));
        if let Some(owner) = session.value.owner()
            && let Some(ids) = self.users.get_mut(owner)
        {
            ids.remove(&session.id);
            if ids.is_empty() {
                self.users.remove(owner);
            }
        }
    }

    pub fn revoke(&mut self, user: &str, keep: &str) {
        let keep_id = self.tokens.get(keep).map(|session| session.id);
        let Some(ids) = self.users.get(user) else {
            return;
        };
        let removed: Vec<_> = ids
            .iter()
            .copied()
            .filter(|id| Some(*id) != keep_id)
            .collect();
        for id in removed {
            self.remove_id(id);
        }
    }

    pub fn clear_except(&mut self, keep: &str) {
        let saved = self.tokens.remove(keep);
        *self = Self::default();
        if let Some(session) = saved {
            self.sequence = session.id;
            self.register(keep, session);
        }
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}
