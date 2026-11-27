use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use inpx_reader::Record;
use rquickjs::function::Constructor;
use rquickjs::{CatchResultExt, Coerced, Context, FromJs, Function, Persistent, Runtime};
use serde_json::Value;

use crate::Result;

const MAX_BYTES: usize = 8192;
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;
const COMPILE_LIMIT: Duration = Duration::from_secs(1);
const RECORD_LIMIT: Duration = Duration::from_millis(100);
const TOTAL_LIMIT: Duration = Duration::from_secs(60);

pub(crate) struct Filter {
    // Drop the persistent function before its context and runtime.
    predicate: Persistent<Function<'static>>,
    context: Context,
    epoch: Instant,
    deadline_ns: Arc<AtomicU64>,
    spent_ns: Cell<u64>,
    json: RefCell<Vec<u8>>,
}

impl Filter {
    pub(crate) fn compile(value: Option<&Value>) -> Result<Option<Self>> {
        let source = match value {
            None | Some(Value::Null | Value::Bool(false)) => return Ok(None),
            Some(Value::Number(number)) if number.as_f64() == Some(0.0) => return Ok(None),
            Some(Value::String(text)) if text.is_empty() => return Ok(None),
            Some(Value::String(text)) if text.len() <= MAX_BYTES => text,
            Some(Value::String(_)) => return Err("Поле filter файла INPX превышает 8 КБ".into()),
            _ => return Err("Поле filter файла INPX должно содержать функцию".into()),
        };

        let runtime = Runtime::new()?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(STACK_LIMIT);
        let epoch = Instant::now();
        let deadline_ns = Arc::new(AtomicU64::new(COMPILE_LIMIT.as_nanos() as u64));
        let interrupt = Arc::clone(&deadline_ns);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let limit = interrupt.load(Ordering::Relaxed);
            epoch.elapsed().as_nanos() >= u128::from(limit)
        })));
        // Only ECMAScript intrinsics are exposed. No host functions or module loader are installed.
        let context = Context::full(&runtime)?;
        let predicate = context.with(|ctx| {
            let compiled = (|| -> rquickjs::Result<_> {
                let constructor: Constructor = ctx.globals().get("Function")?;
                let factory: Function =
                    constructor.construct((format!("'use strict'; return (\n{source}\n)"),))?;
                let predicate: Function = factory.call(())?;
                Ok(Persistent::save(&ctx, predicate))
            })();
            compiled
                .catch(&ctx)
                .map_err(|error| format!("Некорректное правило filter INPX: {error}"))
        })?;
        Ok(Some(Self {
            predicate,
            context,
            epoch,
            deadline_ns,
            spent_ns: Cell::new(0),
            json: RefCell::new(Vec::new()),
        }))
    }

    pub(crate) fn includes(&self, record: &Record) -> Result<bool> {
        let budget = TOTAL_LIMIT.as_nanos() as u64;
        let used = self.spent_ns.get();
        if used >= budget {
            return Err("Превышен общий лимит времени выполнения filter INPX".into());
        }
        let mut json = self.json.borrow_mut();
        json.clear();
        serde_json::to_writer(&mut *json, record)?;
        let started = Instant::now();
        let remaining = Duration::from_nanos(budget - used).min(RECORD_LIMIT);
        let target = self
            .epoch
            .elapsed()
            .saturating_add(remaining)
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        self.deadline_ns.store(target, Ordering::Relaxed);
        let result = self.context.with(|ctx| {
            let evaluated = (|| -> rquickjs::Result<_> {
                let predicate = self.predicate.clone().restore(&ctx)?;
                let record = ctx.json_parse(json.as_slice())?;
                let answer: rquickjs::Value = predicate.call((record,))?;
                if answer.is_promise() {
                    return Err(rquickjs::Error::new_from_js(
                        "Promise",
                        "результат синхронного фильтра",
                    ));
                }
                let Coerced(accepted) = Coerced::<bool>::from_js(&ctx, answer)?;
                Ok(accepted)
            })();
            evaluated
                .catch(&ctx)
                .map_err(|error| format!("Ошибка выполнения filter INPX: {error}"))
        });
        let delta = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        self.spent_ns.set(used.saturating_add(delta));
        Ok(result?)
    }
}
