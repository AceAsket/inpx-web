use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
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

#[derive(Default)]
struct Queue {
    sequence: u64,
    waiting: VecDeque<(u64, Kind)>,
    active: [usize; 4],
}

pub(crate) struct Budget {
    pub requested: String,
    pub automatic: &'static str,
    pub selected: Profile,
    pub profiles: [Profile; 4],
    pub hard_max: usize,
    pub launch_env: Value,
    pub(crate) timeout: Duration,
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

impl Budget {
    pub(crate) fn new(cpu: usize, memory: Option<u64>, config: &Value) -> Result<Self> {
        let mib = 1024 * 1024;
        let automatic = if cpu < 2 || memory.is_some_and(|size| size < 2048 * mib) {
            "economy"
        } else {
            "balanced"
        };
        let requested = std::env::var("INPX_RESOURCE_PROFILE")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "auto".into());
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
        let total = read("INPX_RESOURCE_TOTAL", 1, 16)?;
        let images = read("INPX_RESOURCE_IMAGES", 1, 16)?;
        let reviews = read("INPX_RESOURCE_REVIEWS", 1, 16)?;
        let conversions = read("INPX_RESOURCE_CONVERSIONS", 1, 16)?.or_else(|| {
            std::env::var("INPX_CONVERSION_CONCURRENCY")
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .or_else(|| {
                    (requested == "auto")
                        .then(|| {
                            config["conversionConcurrency"]
                                .as_u64()
                                .map(|n| n.min(16) as usize)
                        })
                        .flatten()
                })
                .map(|n| n.clamp(1, 16))
        });
        let background = read("INPX_RESOURCE_BACKGROUND", 1, 16)?;
        let timeout = read("INPX_RESOURCE_TASK_TIMEOUT_MS", 1000, 3_600_000)?.unwrap_or(120_000);
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
            requested,
            automatic,
            selected,
            profiles,
            hard_max,
            launch_env,
            timeout: Duration::from_millis(timeout as u64),
            queue: Mutex::default(),
            changed: Condvar::new(),
        })
    }

    pub(crate) fn acquire(&self, kind: Kind) -> Result<Permit<'_>> {
        let limits = self.selected.limits;
        let mut queue = self.queue.lock().expect("resource queue");
        let id = queue.sequence;
        queue.sequence = queue.sequence.wrapping_add(1);
        queue.waiting.push_back((id, kind));
        // Serve the oldest eligible waiter. A saturated category cannot block other work.
        let (mut queue, timed) = self
            .changed
            .wait_timeout_while(queue, self.timeout, |q| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_and_foreground_share_the_total_and_release_timed_out_waiters() {
        let mut budget = Budget::new(8, None, &Value::Null).unwrap();
        budget.selected.limits = Limits {
            total: 2,
            images: 1,
            reviews: 2,
            conversions: 2,
            background: 1,
        };
        budget.timeout = Duration::from_millis(10);
        let background = budget.acquire(Kind::Background).unwrap();
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
        assert!(budget.acquire(Kind::Conversions).is_ok());
    }
}
