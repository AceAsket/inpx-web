use std::collections::{BTreeMap, BTreeSet};

const MAX_CLIENTS: usize = 10_000;
pub const METRIC_COUNT: usize = 11;

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
pub enum Kind {
    Access,
    Profile,
    Opds,
}

#[derive(Clone, Copy)]
pub struct Policy {
    pub enabled: bool,
    pub window_ms: i64,
    pub max_attempts: u32,
}

struct Failure {
    count: u32,
    resets_at: i64,
}

#[derive(Default)]
pub struct LoginRate {
    active: [BTreeMap<Box<str>, u32>; 3],
    failures: [BTreeMap<Box<str>, Failure>; 3],
    resets: BTreeSet<(i64, Kind, Box<str>)>,
    totals: [[u64; 3]; 3],
}

impl LoginRate {
    pub fn check(&mut self, kind: Kind, ip: &str, now: i64, policy: Policy, reserve: bool) -> u32 {
        if !policy.enabled {
            return 0;
        }
        self.prune(now);
        let index = kind as usize;
        let failure = self.failures[index].get(ip);
        let count = failure.map_or(0, |row| row.count);
        let active = self.active[index].get(ip).copied().unwrap_or_default();
        let retry = if count >= policy.max_attempts
            || (failure.is_none() && self.resets.len() >= MAX_CLIENTS)
        {
            let remaining =
                failure.map_or(policy.window_ms, |row| row.resets_at.saturating_sub(now));
            u32::try_from((remaining.saturating_add(999) / 1000).max(1)).unwrap_or(u32::MAX)
        } else if count.saturating_add(active) >= policy.max_attempts
            || (active == 0 && self.active.iter().map(BTreeMap::len).sum::<usize>() >= MAX_CLIENTS)
        {
            1
        } else {
            0
        };
        if retry != 0 {
            self.totals[index][2] += 1;
        } else if reserve {
            if let Some(active) = self.active[index].get_mut(ip) {
                *active += 1;
            } else {
                self.active[index].insert(ip.into(), 1);
            }
        }
        retry
    }

    pub fn finish(
        &mut self,
        kind: Kind,
        ip: &str,
        now: i64,
        policy: Policy,
        reserved: bool,
        outcome: Option<bool>,
    ) {
        if reserved {
            let active = &mut self.active[kind as usize];
            if let Some(count) = active.get_mut(ip) {
                *count -= 1;
                if *count == 0 {
                    active.remove(ip);
                }
            }
        }
        if let Some(success) = outcome {
            self.record(kind, ip, now, policy, success);
        }
    }

    fn record(&mut self, kind: Kind, ip: &str, now: i64, policy: Policy, success: bool) {
        let index = kind as usize;
        self.totals[index][usize::from(!success)] += 1;
        if !policy.enabled {
            return;
        }
        if success {
            if kind == Kind::Access
                && let Some(row) = self.failures[index].remove(ip)
            {
                self.resets.remove(&(row.resets_at, kind, ip.into()));
            }
            return;
        }
        self.prune(now);
        if let Some(row) = self.failures[index].get_mut(ip) {
            row.count = row.count.saturating_add(1);
        } else if self.resets.len() < MAX_CLIENTS {
            let resets_at = now.saturating_add(policy.window_ms);
            self.failures[index].insert(
                ip.into(),
                Failure {
                    count: 1,
                    resets_at,
                },
            );
            self.resets.insert((resets_at, kind, ip.into()));
        }
    }

    fn prune(&mut self, now: i64) {
        while self.resets.first().is_some_and(|(at, _, _)| *at < now) {
            let (_, kind, ip) = self.resets.pop_first().expect("checked first entry");
            self.failures[kind as usize].remove(&ip);
        }
    }

    pub fn metrics(&mut self, now: i64, max_attempts: u32) -> [u64; METRIC_COUNT] {
        self.prune(now);
        let mut values = [0; METRIC_COUNT];
        for (output, value) in values.iter_mut().zip(self.totals.into_iter().flatten()) {
            *output = value;
        }
        for row in self.failures.iter().flat_map(BTreeMap::values) {
            values[9] += u64::from(row.count);
            values[10] += u64::from(row.count >= max_attempts);
        }
        values
    }
}
