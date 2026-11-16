use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct Deadlines<T> {
    entries: BTreeMap<Box<str>, (i64, T)>,
    deadlines: BTreeSet<(i64, Box<str>)>,
}

impl<T> Default for Deadlines<T> {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            deadlines: BTreeSet::new(),
        }
    }
}

impl<T> Deadlines<T> {
    pub(crate) fn put(&mut self, key: &str, deadline: i64, value: T) -> Option<T> {
        let old = self.remove(key);
        self.entries.insert(key.into(), (deadline, value));
        self.deadlines.insert((deadline, key.into()));
        old
    }

    pub(crate) fn remove(&mut self, key: &str) -> Option<T> {
        self.take(key).map(|(_, value)| value)
    }

    pub(crate) fn take(&mut self, key: &str) -> Option<(i64, T)> {
        let (deadline, value) = self.entries.remove(key)?;
        self.deadlines.remove(&(deadline, key.into()));
        Some((deadline, value))
    }

    pub(crate) fn get(&self, key: &str) -> Option<(i64, &T)> {
        self.entries
            .get(key)
            .map(|(deadline, value)| (*deadline, value))
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.entries.get_mut(key).map(|(_, value)| value)
    }

    pub(crate) fn expire(&mut self, now: i64, mut on_remove: impl FnMut(T)) {
        while self
            .deadlines
            .first()
            .is_some_and(|(deadline, _)| *deadline <= now)
        {
            let (_, key) = self.deadlines.pop_first().expect("checked first deadline");
            if let Some((_, value)) = self.entries.remove(key.as_ref()) {
                on_remove(value);
            }
        }
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&str, &T) -> bool) {
        let removed: Vec<_> = self
            .entries
            .iter()
            .filter(|(key, (_, value))| !keep(key, value))
            .map(|(key, _)| key.clone())
            .collect();
        for key in removed {
            self.remove(&key);
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
