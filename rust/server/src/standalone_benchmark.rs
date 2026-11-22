use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::{
    Result,
    book_audit::{self, Outcome},
    book_delivery::Book,
    library_sources::Source,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Job, SOURCE_CHANGED, State, integer, percentile, process, timestamp};
use crate::standalone::resources::{Budget, Limits, Policy, Profile as Candidate};
use crate::standalone_access::BrowserProfileRequest;

const MIB: u64 = 1024 * 1024;
const ITEMS: usize = 12;
const ROUNDS: usize = 6;
const TIMEOUT: &str = "Проверка остановлена по лимиту времени";
const MEMORY: &str = "Проверка остановлена из-за нагрузки на память";

pub(super) struct Benchmark {
    file: PathBuf,
    report: Mutex<Value>,
    job: Mutex<Option<Arc<Job>>>,
}

pub(in crate::standalone) fn hardware() -> (usize, Option<u64>) {
    let machine = Machine::sample();
    (machine.cpu, machine.limit)
}

struct Machine {
    cpu: usize,
    scope: &'static str,
    limit: Option<u64>,
    used: Option<u64>,
    available: Option<u64>,
    cpu_us: Option<u64>,
}

impl Machine {
    fn sample() -> Self {
        let cpu = std::thread::available_parallelism().map_or(1, |count| count.get());
        let machine = Self {
            cpu,
            scope: "process",
            limit: None,
            used: process::rss(),
            available: None,
            cpu_us: None,
        };
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let machine = machine.with_linux_metrics();
        machine
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn with_linux_metrics(mut self) -> Self {
        use std::fs;
        let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let field = |key| {
            meminfo
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .and_then(|line| line.split_whitespace().next()?.parse::<u64>().ok())
                .and_then(|kb| kb.checked_mul(1024))
        };
        let host_limit = field("MemTotal:");
        let host_available = field("MemAvailable:");
        let read = |file: &str| fs::read_to_string(Path::new("/sys/fs/cgroup").join(file)).ok();
        let number = |file: &str| read(file).and_then(|value| value.trim().parse::<u64>().ok());
        if let Some(quota) = read("cpu.max").and_then(|value| {
            let (quota, period) = value.trim().split_once(' ')?;
            let period = period.trim().parse::<u64>().ok()?.max(1);
            Some(quota.parse::<u64>().ok()?.div_ceil(period))
        }) {
            self.cpu = self.cpu.min(quota.max(1) as usize);
        }
        if let (Some(limit), Some(used)) = (number("memory.max"), number("memory.current"))
            && limit > 0
            && host_limit.is_none_or(|host| limit <= host)
        {
            self.scope = "cgroup";
            self.limit = Some(limit);
            self.used = Some(used);
            self.available = Some(limit.saturating_sub(used));
            self.cpu_us = read("cpu.stat").and_then(|status| {
                status.lines().find_map(|line| {
                    line.strip_prefix("usage_usec ")
                        .and_then(|value| value.trim().parse().ok())
                })
            });
        } else {
            self.limit = host_limit;
            self.available = host_available;
        }
        self
    }

    fn view(&self) -> Value {
        json!({"cpu":self.cpu,"memoryScope":self.scope,"memoryLimit":self.limit,"memoryUsed":self.used,
            "memoryAvailable":self.available,"cpuUsageUs":self.cpu_us})
    }

    fn ratio(&self) -> Option<f64> {
        if self.scope != "cgroup" {
            return None;
        }
        Some(self.used? as f64 / self.limit?.max(1) as f64)
    }

    fn pressure(&self) -> bool {
        self.ratio().is_some_and(|ratio| ratio >= 0.90)
            || self.available.is_some_and(|bytes| bytes < 128 * MIB)
    }

    fn cpu_millis(&self) -> Option<f64> {
        self.cpu_us
            .map(|cpu| cpu as f64 / 1000.0)
            .or_else(|| process::cpu().map(|(user, system)| (user + system) * 1000.0))
    }
}

struct Settings {
    enabled: bool,
    timeout: u64,
    budget: Policy,
}

impl Settings {
    fn new(budget: &Arc<Budget>) -> Self {
        Self {
            enabled: std::env::var("INPX_RESOURCE_BENCH_ENABLED").as_deref() != Ok("false"),
            timeout: environment_number("INPX_RESOURCE_BENCH_TIMEOUT_MS", 60000)
                .clamp(10000, 180000),
            budget: budget.policy(),
        }
    }

    fn select(&self, mode: &str, options: &Value) -> Result<Vec<Candidate>> {
        match mode {
            "compare" => Ok(self
                .budget
                .profiles
                .iter()
                .filter(|profile| profile.id != "unlimited")
                .cloned()
                .collect()),
            "profile" => Ok(vec![
                self.budget
                    .profiles
                    .iter()
                    .find(|item| options["profileId"] == item.id)
                    .ok_or("Выберите стандартный профиль для проверки")?
                    .clone(),
            ]),
            "custom" => {
                let value = |field: &str, max: usize| -> Result<usize> {
                    let result = integer(&options["limits"][field], 0);
                    if (1..=max).contains(&result) {
                        Ok(result)
                    } else {
                        Err(format!("Укажите целый лимит {field} от 1 до {max}").into())
                    }
                };
                let total = value("total", self.budget.hard_max)?;
                let images = value("images", total)?;
                Ok(vec![Candidate {
                    id: "custom",
                    name: "Свои значения",
                    limits: Limits {
                        total,
                        images,
                        reviews: value("reviews", total)?,
                        conversions: value("conversions", total)?,
                        background: 1,
                    },
                }])
            }
            _ => Err("Неизвестный режим проверки".into()),
        }
    }

    fn view(&self) -> Value {
        let policy = &self.budget;
        json!({"native":true,"requested":policy.requested,"storedProfile":policy.stored,"selected":policy.selected.id,"automatic":policy.automatic,
            "limits":policy.selected.limits,"hardMax":policy.hard_max,"profiles":policy.profiles,"fileConversionLimit":policy.file_conversion_limit,
            "benchmarkEnabled":self.enabled,"benchmarkTimeoutMs":self.timeout,"launchEnv":policy.launch_env})
    }
}

impl Benchmark {
    pub(super) fn new(data: &Path) -> Self {
        let file = data.join("resource-benchmark.json");
        let report: Value = File::open(&file)
            .ok()
            .and_then(|file| serde_json::from_reader(BufReader::new(file.take(256 * 1024))).ok())
            .unwrap_or(Value::Null);
        let report = if report["schema"] == 2
            && report["rows"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty() && rows.len() <= 3)
        {
            report
        } else {
            Value::Null
        };
        Self {
            file,
            report: Mutex::new(report),
            job: Mutex::default(),
        }
    }

    pub(super) fn view(&self) -> Value {
        self.job
            .lock()
            .expect("benchmark slot")
            .as_ref()
            .map_or(Value::Null, |job| job.view())
    }

    pub(super) fn cancel(&self) -> Value {
        self.job
            .lock()
            .expect("benchmark slot")
            .as_ref()
            .map_or(Value::Null, |job| job.cancel())
    }

    pub(super) fn snapshot(&self, state: &State) -> Result<Value> {
        let machine = Machine::sample();
        let settings = Settings::new(&state.resources);
        let sources = state.index.sources();
        let mut report = self.report.lock().expect("benchmark report").clone();
        let mut recommendation = provisional(
            settings.budget.automatic,
            "Предварительная оценка по доступным ресурсам. Для замера выберите источник.",
        );
        let mut cache = json!({"available":false,"error":"Каталог недоступен"});
        if let Some(catalogue) = state
            .index
            .catalogue
            .read()
            .expect("open catalogue")
            .as_ref()
        {
            cache = json!({"available":true,"readCacheBytes":catalogue.store.read_cache_bytes(),"engine":"redb"});
            if !report.is_null() {
                let source = sources
                    .iter()
                    .find(|source| report["source"]["id"] == source.id);
                let legacy = report["engine"] != "rust";
                let stale = legacy
                    || source.is_none_or(|source| {
                        report["fingerprint"]
                            != fingerprint(source, &catalogue.generation, &machine, &settings)
                    });
                report["legacy"] = legacy.into();
                report["stale"] = stale.into();
                recommendation = if stale {
                    provisional(
                        settings.budget.automatic,
                        "Условия замера изменились. Повторите проверку.",
                    )
                } else {
                    report["recommendation"].clone()
                };
            }
        }
        let process_cpu = process::cpu()
            .map(|(user, system)| json!({"user":user*1_000_000.0,"system":system*1_000_000.0}));
        Ok(
            json!({"settings":settings.view(),"benchmarkSampleSize":ITEMS,"machine":machine.view(),"runtime":state.resources.runtime(),
            "sources":sources.iter().filter(|source| !source.lib_dir.as_os_str().is_empty())
                .map(|source| json!({"id":source.id,"name":source.name})).collect::<Vec<_>>(),
            "job":self.view(),"report":report,"recommendation":recommendation,"databaseCache":cache,
            "processMemory":{"rss":process::rss()},"processCpu":process_cpu}),
        )
    }

    pub(super) fn start(
        &self,
        state: &Arc<State>,
        owner: BrowserProfileRequest<'_>,
        options: &Value,
    ) -> Result<Value> {
        let settings = Settings::new(&state.resources);
        if !settings.enabled {
            return Err("Проверка отключена параметром INPX_RESOURCE_BENCH_ENABLED".into());
        }
        let mut slot = self.job.lock().expect("benchmark slot");
        if slot
            .as_ref()
            .is_some_and(|job| job.view()["running"] == true)
        {
            return Err("Проверка производительности уже выполняется".into());
        }
        if state.index.snapshot()["updating"] == true {
            return Err("Каталог ещё не готов к проверке".into());
        }
        let sources = state.index.sources();
        let requested = options["sourceId"].as_str().unwrap_or_default();
        let source = sources
            .iter()
            .position(|source| {
                (requested.is_empty() || source.id == requested) && source.lib_dir.is_dir()
            })
            .ok_or("Выберите доступный источник библиотеки")?;
        let mode = options["mode"].as_str().unwrap_or("compare").to_owned();
        let candidates = settings.select(&mode, options)?;
        let job = Job::new(
            owner,
            json!({"progress":0,"stage":"Подготовка образцов","startedAt":timestamp(),
            "sourceName":sources[source].name,"mode":mode,"candidates":candidates}),
        )?;
        job.owner.authorize(state)?;
        let initial = job.view();
        *slot = Some(job.clone());
        let generation = state.index.generation();
        state.diagnostics.log(
            state,
            "info",
            "benchmark",
            "Запущена проверка производительности",
        );
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let bench = &state.diagnostics.benchmark;
            let runner = Run {
                state: &state,
                job: &job,
                generation,
                deadline: Instant::now() + Duration::from_millis(settings.timeout),
            };
            let outcome = runner
                .execute(&sources[source], &candidates, &mode, &settings)
                .and_then(|report| {
                    runner.check()?;
                    inpx_catalog::save_json(&bench.file, &report)?;
                    *bench.report.lock().expect("benchmark report") = report;
                    Ok(())
                });
            let error = outcome
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            let label = match error.as_str() {
                TIMEOUT => "timed-out",
                MEMORY => "memory-pressure",
                other => job.state_for(other),
            };
            job.change(|view| {
                view["state"] = label.into();
                view["running"] = false.into();
                view["finishedAt"] = timestamp().into();
                if error.is_empty() {
                    view["progress"] = 1.into();
                    view["stage"] = "Проверка завершена".into();
                } else {
                    view["message"] = error.as_str().into();
                }
            });
            state.diagnostics.log(
                &state,
                if label == "failed" { "error" } else { "info" },
                "benchmark",
                if error.is_empty() {
                    "Проверка производительности завершена"
                } else {
                    &error
                },
            );
        });
        Ok(initial)
    }
}

struct Run<'a> {
    state: &'a State,
    job: &'a Job,
    generation: u64,
    deadline: Instant,
}

impl Run<'_> {
    fn check(&self) -> Result<()> {
        self.job.ensure(self.state, self.generation)?;
        if Instant::now() >= self.deadline {
            return Err(TIMEOUT.into());
        }
        Ok(())
    }

    fn execute(
        &self,
        source: &Source,
        candidates: &[Candidate],
        mode: &str,
        settings: &Settings,
    ) -> Result<Value> {
        let machine = Machine::sample();
        if machine.pressure() {
            return Err(MEMORY.into());
        }
        let (files, contents) = self.samples(source)?;
        let uid = files[0]["_uid"].as_str().ok_or(SOURCE_CHANGED)?;
        let mut rows = Vec::new();
        for (index, candidate) in candidates.iter().enumerate() {
            let completed = |round: usize| {
                self.job.change(|view| {
                    view["stage"] = candidate.name.into();
                    view["progress"] = ((index * ROUNDS + round) as f64
                        / (candidates.len() * ROUNDS) as f64)
                        .into();
                })
            };
            completed(0);
            rows.push(self.measure(candidate, source, uid, &files, &contents, completed)?);
        }
        self.check()?;
        let mut coverage = vec!["Файлы и архивы"];
        if !contents.is_empty() {
            coverage.push("Проверка содержимого FB2/EPUB");
        }
        let warnings = if contents.is_empty() {
            vec!["В выбранном источнике нет подходящего образца FB2 или EPUB."]
        } else {
            Vec::new()
        };
        let guard = self.state.index.catalogue.read().expect("open catalogue");
        let generation = &guard.as_ref().ok_or(SOURCE_CHANGED)?.generation;
        Ok(
            json!({"schema":2,"engine":"rust","mode":mode,"criteria":{"probeP95Ms":100,"probeTimeoutMs":250,
            "timerLagP95Ms":100,"memoryRatio":0.85,"minProbeSamples":5},
            "measuredAt":timestamp(),"source":{"id":source.id,"name":source.name},
            "fingerprint":fingerprint(source,generation,&machine,settings),"machine":machine.view(),"rows":rows,
            "coverage":coverage,"warnings":warnings,"confidence":"partial",
            "recommendation":provisional(settings.budget.automatic,"Замер охватывает чтение источника и отклик каталога. Серверные лимиты выбираются по общей нагрузке.")}),
        )
    }

    fn samples(&self, source: &Source) -> Result<(Vec<Value>, Vec<Value>)> {
        let mut files = Vec::new();
        let mut contents = Vec::new();
        let mut cursor = None;
        let mut reader = book_audit::Reader::default();
        let sources = std::slice::from_ref(source);
        let mut inspected = 0;
        loop {
            self.check()?;
            let (rows, next) = self
                .state
                .index
                .catalogue
                .read()
                .expect("open catalogue")
                .as_ref()
                .ok_or(SOURCE_CHANGED)?
                .source_book_batch(cursor)?;
            for row in rows {
                if row["del"].as_i64().is_some_and(|value| value != 0) || row["del"] == true {
                    continue;
                }
                let book: Book = serde_json::from_value(row.clone())?;
                if book.source(sources).is_none() {
                    continue;
                }
                self.check()?;
                inspected += 1;
                if files.len() < 6
                    && matches!(
                        reader.check(&row, sources, false, 4 * MIB, || self.job.cancelled())?,
                        Outcome::Valid
                    )
                {
                    files.push(row.clone());
                }
                if contents.len() < 4
                    && book.extension().is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("fb2") || ext.eq_ignore_ascii_case("epub")
                    })
                    && matches!(
                        reader.check(&row, sources, true, 4 * MIB, || self.job.cancelled()
                            || Instant::now() >= self.deadline)?,
                        Outcome::Valid
                    )
                {
                    contents.push(row);
                }
                if (files.len() >= 6 && contents.len() >= 4) || inspected >= 96 {
                    break;
                }
            }
            if (files.len() >= 6 && contents.len() >= 4) || inspected >= 96 || next.is_none() {
                break;
            }
            cursor = next;
        }
        self.check()?;
        if files.is_empty() {
            return Err("В источнике не найдено доступных файлов для замера".into());
        }
        Ok((files, contents))
    }

    fn measure(
        &self,
        candidate: &Candidate,
        source: &Source,
        uid: &str,
        files: &[Value],
        contents: &[Value],
        progress: impl Fn(usize),
    ) -> Result<Value> {
        let start = Instant::now();
        let before = Machine::sample();
        let mut peak = before.used;
        let mut ratio = before.ratio();
        let mut rounds = Vec::new();
        let mut probe = Vec::new();
        let mut lag = Vec::new();
        let mut other_work = false;
        for round in 0..ROUNDS {
            self.check()?;
            let begin = Instant::now();
            probe.push(self.round(source, files, false, candidate.limits.reviews, uid)?);
            if !contents.is_empty() {
                probe.push(self.round(
                    source,
                    contents,
                    true,
                    candidate.limits.conversions,
                    uid,
                )?);
            }
            rounds.push(begin.elapsed().as_secs_f64() * 1000.0);
            let machine = Machine::sample();
            if machine.pressure() {
                return Err(MEMORY.into());
            }
            peak = peak.max(machine.used);
            if let Some(value) = machine.ratio() {
                ratio = Some(ratio.map_or(value, |current| current.max(value)));
            }
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let spent = machine
                .cpu_millis()
                .zip(before.cpu_millis())
                .map(|(current, before)| (current - before).max(0.0));
            self.job.change(|view| {
                view["sample"] = json!({"memoryUsed":machine.used,"peakMemory":peak,
                "cpuPercent":spent.map(|spent| spent / elapsed.max(1.0) * 100.0)})
            });
            other_work |= self
                .state
                .diagnostics
                .runtime
                .in_flight
                .load(std::sync::atomic::Ordering::Relaxed)
                > 0
                || super::super::tasks::resources(self.state, "", true)["foreground"]
                    .as_u64()
                    .unwrap_or(0)
                    > 0;
            progress(round + 1);
            let pause = Instant::now() + Duration::from_millis(65);
            std::thread::sleep(Duration::from_millis(65));
            lag.push(pause.elapsed().as_secs_f64() * 1000.0);
        }
        self.check()?;
        let after = Machine::sample();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let spent = after
            .cpu_millis()
            .zip(before.cpu_millis())
            .map(|(current, before)| (current - before).max(0.0));
        let timeouts = probe.iter().filter(|duration| **duration >= 250.0).count();
        let first = rounds[0];
        let repeat = rounds[1];
        Ok(
            json!({"profile":candidate.id,"limits":candidate.limits,"completed":true,
            "firstPassMs":first,"repeatPassMs":repeat,"elapsedMs":percentile(&mut rounds[1..],0.5),"rounds":ROUNDS,
            "totalDurationMs":elapsed,"tasksPerPass":ITEMS*(if contents.is_empty(){1}else{2}),"tasksPerStage":ITEMS,
            "probeP95Ms":percentile(&mut probe,0.95),"probeSamples":probe.len(),"probeTimeouts":timeouts,"probeFailures":0,
            "probeSuccessfulSamples":probe.len()-timeouts,"timerLagP95Ms":percentile(&mut lag,0.95),
            "memoryScope":before.scope,"memoryBefore":before.used,"peakMemory":peak,"memoryUsed":after.used,
            "memoryDelta":peak.zip(before.used).map(|(peak,initial)| peak.saturating_sub(initial)),
            "cpuTimeMs":spent,"cpuPercent":spent.map(|spent| spent/elapsed.max(1.0)*100.0),"memoryRatio":ratio,"otherWork":other_work}),
        )
    }

    fn round(
        &self,
        source: &Source,
        samples: &[Value],
        deep: bool,
        width: usize,
        uid: &str,
    ) -> Result<f64> {
        let width = width.min(ITEMS);
        let sources = std::slice::from_ref(source);
        let limit = 4 * MIB;
        std::thread::scope(|thread| {
            let workers = (0..width.min(ITEMS))
                .map(|offset| {
                    thread.spawn(move || {
                        let mut reader = book_audit::Reader::default();
                        for index in (offset..ITEMS).step_by(width) {
                            self.check().map_err(|error| error.to_string())?;
                            let _permit = self
                                .state
                                .resources
                                .acquire(if deep {
                                    crate::standalone::resources::Kind::Conversions
                                } else {
                                    crate::standalone::resources::Kind::Archives
                                })
                                .map_err(|error| error.to_string())?;
                            self.check().map_err(|error| error.to_string())?;
                            let row = &samples[index % samples.len()];
                            let outcome = reader
                                .check(row, sources, deep, limit, || {
                                    self.job.cancelled() || Instant::now() >= self.deadline
                                })
                                .map_err(|error| error.to_string())?;
                            if let Outcome::Issue(_, message) = outcome {
                                self.check().map_err(|error| error.to_string())?;
                                return Err(message);
                            }
                        }
                        Ok::<_, String>(())
                    })
                })
                .collect::<Vec<_>>();
            let started = Instant::now();
            let select = self.state.index.catalogue.read().expect("open catalogue");
            select
                .as_ref()
                .ok_or(SOURCE_CHANGED)?
                .browser_book(uid)?
                .ok_or(SOURCE_CHANGED)?;
            drop(select);
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            for worker in workers {
                worker.join().map_err(|_| "Ошибка тестовой задачи")??;
            }
            Ok(elapsed)
        })
    }
}

fn provisional(profile: &str, reason: &str) -> Value {
    json!({"profile":profile,"measured":false,"reason":reason})
}

fn fingerprint(
    source: &Source,
    generation: &str,
    machine: &Machine,
    settings: &Settings,
) -> String {
    let data = json!([
        source.id,
        source.lib_dir,
        generation,
        machine.cpu,
        machine.limit,
        settings.budget.selected,
        settings.budget.profiles,
        settings.budget.hard_max,
        settings.timeout
    ]);
    Sha256::digest(data.to_string())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn environment_number(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(fallback)
}
