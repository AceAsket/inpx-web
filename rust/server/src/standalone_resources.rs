use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use inpx_catalog::Result;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Archives,
    Images,
    Conversions,
    Background,
}

#[derive(Clone, Copy, Serialize)]
pub(crate) struct Limits {
    #[serde(serialize_with = "limit_value")]
    pub total: usize,
    #[serde(serialize_with = "limit_value")]
    pub images: usize,
    #[serde(serialize_with = "limit_value")]
    pub reviews: usize,
    #[serde(serialize_with = "limit_value")]
    pub conversions: usize,
    #[serde(serialize_with = "limit_value")]
    pub background: usize,
}

const UNLIMITED: usize = tokio::sync::Semaphore::MAX_PERMITS;

fn limit_value<S: Serializer>(
    limit: &usize,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    (*limit != UNLIMITED).then_some(limit).serialize(serializer)
}

impl Limits {
    fn category(self, kind: Kind) -> usize {
        match kind {
            Kind::Archives => self.reviews,
            Kind::Images => self.images,
            Kind::Conversions => self.conversions,
            Kind::Background => self.background,
        }
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct Profile {
    pub id: &'static str,
    pub name: &'static str,
    pub limits: Limits,
}

struct Queue {
    policy: Policy,
    sequence: u64,
    waiting: VecDeque<(u64, Kind)>,
    active: [usize; 4],
}

#[derive(Clone)]
pub(crate) struct Policy {
    pub requested: String,
    pub stored: Option<String>,
    pub automatic: &'static str,
    pub selected: Profile,
    pub profiles: [Profile; 4],
    pub hard_max: usize,
    pub launch_env: Value,
    pub file_conversion_limit: Option<usize>,
    pub(crate) timeout: Duration,
}

pub(crate) struct Budget {
    queue: Mutex<Queue>,
    changed: Condvar,
}

pub(crate) struct Permit<'a>(&'a Budget, Kind);

fn number(name: &str, min: usize, max: usize) -> Result<Option<usize>> {
    let Some(value) = std::env::var(name).ok().filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    value
        .trim()
        .parse()
        .ok()
        .filter(|n| (min..=max).contains(n))
        .map(Some)
        .ok_or_else(|| format!("{name}: ожидается целое число от {min} до {max}").into())
}

impl Policy {
    pub(crate) fn new(cpu: usize, memory: Option<u64>, config: &Value) -> Result<Self> {
        let mib = 1024 * 1024;
        let automatic = if cpu < 2 || memory.is_some_and(|size| size < 2048 * mib) {
            "economy"
        } else {
            "balanced"
        };
        let requested = config["resourceProfile"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                std::env::var("INPX_RESOURCE_PROFILE")
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| "unlimited".into());
        let estimated = cpu
            .saturating_mul(2)
            .min(memory.map_or(8, |size| ((size / mib * 7 / 10) / 256).min(8) as usize))
            .clamp(1, 8);
        let explicit_max = number("INPX_RESOURCE_MAX_PROCESSES", 1, 16)?;
        let hard_max = explicit_max.unwrap_or(estimated);
        let mut launch_env = json!({});
        let mut read = |key, min, max| -> Result<Option<usize>> {
            let value = number(key, min, max)?;
            if let Some(n) = value {
                launch_env[key] = n.to_string().into();
            }
            Ok(value)
        };
        let local = |key: &str| {
            config[key]
                .as_u64()
                .map(|limit| limit.clamp(1, 16) as usize)
        };
        let total = read("INPX_RESOURCE_TOTAL", 1, 16)?.or_else(|| local("resourceTotal"));
        let images = read("INPX_RESOURCE_IMAGES", 1, 16)?.or_else(|| local("resourceImages"));
        let reviews = read("INPX_RESOURCE_REVIEWS", 1, 16)?.or_else(|| local("resourceReviews"));
        let conversion_env = match read("INPX_RESOURCE_CONVERSIONS", 1, 16)? {
            Some(limit) => Some(limit),
            None => read("INPX_CONVERSION_CONCURRENCY", 1, 16)?,
        };
        // Older Node installations wrote 2 even when the operator never chose a limit.
        let file_conversion_limit = config["conversionConcurrency"]
            .as_u64()
            .filter(|&n| {
                n != 2
                    && conversion_env.is_none()
                    && matches!(requested.as_str(), "auto" | "unlimited")
            })
            .map(|n| n.clamp(1, 16) as usize);
        let conversions = conversion_env
            .or_else(|| local("resourceConversions"))
            .or(file_conversion_limit);
        let background =
            read("INPX_RESOURCE_BACKGROUND", 1, 16)?.or_else(|| local("resourceBackground"));
        let timeout = read("INPX_RESOURCE_TASK_TIMEOUT_MS", 1000, 3_600_000)?
            .or_else(|| {
                config["resourceTaskTimeoutMs"]
                    .as_u64()
                    .map(|ms| ms.clamp(1000, 3_600_000) as usize)
            })
            .unwrap_or(120_000);
        if std::env::var("INPX_RESOURCE_MAX_PROCESSES").is_ok_and(|s| !s.is_empty()) {
            launch_env["INPX_RESOURCE_MAX_PROCESSES"] = hard_max.to_string().into();
        }
        let profiles = [
            ("economy", "Бережный", 2, 1, 1),
            ("balanced", "Сбалансированный", 4, 2, 1),
            ("performance", "Производительный", 6, 3, 2),
            (
                "unlimited",
                "Без ограничений",
                UNLIMITED,
                UNLIMITED,
                UNLIMITED,
            ),
        ]
        .map(|(id, name, count, parallel, bg)| {
            let total = if id == "unlimited" {
                total
                    .unwrap_or(UNLIMITED)
                    .min(explicit_max.unwrap_or(UNLIMITED))
            } else {
                total.unwrap_or(count.min(estimated)).min(hard_max)
            };
            Profile {
                id,
                name,
                limits: Limits {
                    total,
                    images: images.unwrap_or(parallel).min(total),
                    reviews: reviews.unwrap_or(count).min(total),
                    conversions: conversions.unwrap_or(parallel).min(total),
                    background: background.unwrap_or(bg).min(total),
                },
            }
        });
        let selected = profiles
            .iter()
            .find(|p| {
                p.id == if requested == "auto" {
                    automatic
                } else {
                    requested.as_str()
                }
            })
            .ok_or("INPX_RESOURCE_PROFILE: auto, economy, balanced, performance или unlimited")?
            .clone();
        Ok(Self {
            stored: config["resourceProfile"].as_str().map(str::to_owned),
            requested,
            automatic,
            selected,
            profiles,
            hard_max,
            launch_env,
            file_conversion_limit,
            timeout: Duration::from_millis(timeout as u64),
        })
    }
}

impl Budget {
    pub(crate) fn new(policy: Policy) -> Self {
        Self {
            queue: Mutex::new(Queue {
                policy,
                sequence: 0,
                waiting: VecDeque::new(),
                active: [0; 4],
            }),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn policy(&self) -> Policy {
        self.queue.lock().expect("resource queue").policy.clone()
    }

    pub(crate) fn configure(&self, policy: Policy) {
        self.queue.lock().expect("resource queue").policy = policy;
        self.changed.notify_all();
    }

    /// Optional workers only take idle slots and never queue ahead of user requests.
    pub(crate) fn spare_background(&self, count: usize) -> Vec<Permit<'_>> {
        let mut q = self.queue.lock().expect("resource queue");
        if !q.waiting.is_empty() {
            return Vec::new();
        }
        let limits = q.policy.selected.limits;
        let kind = Kind::Background;
        let count = count
            .min(limits.total.saturating_sub(q.active.iter().sum()))
            .min(limits.background.saturating_sub(q.active[kind as usize]));
        q.active[kind as usize] += count;
        (0..count).map(|_| Permit(self, kind)).collect()
    }

    pub(crate) fn acquire(&self, kind: Kind) -> Result<Permit<'_>> {
        let mut queue = self.queue.lock().expect("resource queue");
        let timeout = queue.policy.timeout;
        let id = queue.sequence;
        queue.sequence = queue.sequence.wrapping_add(1);
        queue.waiting.push_back((id, kind));
        // Serve the oldest eligible waiter. A saturated category cannot block other work.
        let (mut queue, timed) = self
            .changed
            .wait_timeout_while(queue, timeout, |q| {
                let limits = q.policy.selected.limits;
                q.active.iter().sum::<usize>() >= limits.total
                    || q.waiting
                        .iter()
                        .find(|(_, k)| q.active[*k as usize] < limits.category(*k))
                        .is_none_or(|(first, _)| *first != id)
            })
            .expect("resource wait");
        queue.waiting.retain(|(waiting, _)| *waiting != id);
        if timed.timed_out() {
            self.changed.notify_all();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Истекло время ожидания ресурсов сервера",
            )
            .into());
        }
        queue.active[kind as usize] += 1;
        self.changed.notify_all();
        Ok(Permit(self, kind))
    }

    pub(crate) fn runtime(&self) -> Value {
        let q = self.queue.lock().expect("resource queue");
        let active: usize = q.active.iter().sum();
        let background = q.active[Kind::Background as usize];
        json!({"active":active,"queued":q.waiting.len(),"foreground":active-background,"background":background})
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut queue = self.0.queue.lock().expect("resource queue");
        queue.active[self.1 as usize] -= 1;
        self.0.changed.notify_all();
    }
}

/// Request admission is independent from the shared processing budget. Keep
/// counting existing requests when an administrator changes its capacity.
pub(crate) struct AdmissionSlots {
    counts: tokio::sync::watch::Sender<(usize, usize)>,
}

pub(crate) struct AdmissionPermit(Arc<AdmissionSlots>);

impl AdmissionSlots {
    pub(crate) fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            counts: tokio::sync::watch::channel((0, limit)).0,
        })
    }

    pub(crate) fn resize(&self, limit: usize) {
        self.counts.send_modify(|state| state.1 = limit);
    }

    pub(crate) fn try_take(self: &Arc<Self>) -> Option<AdmissionPermit> {
        let mut taken = false;
        self.counts.send_if_modified(|(active, limit)| {
            if *active < *limit {
                *active += 1;
                taken = true;
            }
            false // Taking a slot cannot wake another waiter.
        });
        taken.then(|| AdmissionPermit(self.clone()))
    }

    pub(crate) async fn take(self: &Arc<Self>) -> AdmissionPermit {
        let mut state = self.counts.subscribe();
        loop {
            if let Some(permit) = self.try_take() {
                return permit;
            }
            state.changed().await.expect("live admission slots");
        }
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        self.0.counts.send_modify(|(active, _)| *active -= 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_and_foreground_share_the_total_and_release_timed_out_waiters() {
        let mut policy = Policy::new(8, None, &Value::Null).unwrap();
        policy.selected.limits = Limits {
            total: 2,
            images: 1,
            reviews: 2,
            conversions: 2,
            background: 1,
        };
        policy.timeout = Duration::from_millis(10);
        let budget = Budget::new(policy);
        let background = budget.acquire(Kind::Background).unwrap();
        assert!(budget.spare_background(3).is_empty());
        let image = budget.acquire(Kind::Images).unwrap();
        assert!(budget.acquire(Kind::Conversions).is_err());
        drop(image);
        assert!(budget.acquire(Kind::Background).is_err());
        let archive = budget.acquire(Kind::Archives).unwrap();
        assert_eq!(
            budget.runtime(),
            json!({"active":2,"queued":0,"foreground":1,"background":1})
        );
        drop((background, archive));
        let spare = budget.spare_background(3);
        assert_eq!(spare.len(), 1);
        assert!(budget.spare_background(1).is_empty());
        drop(spare);
        assert!(budget.acquire(Kind::Conversions).is_ok());
    }
}
