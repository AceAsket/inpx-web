use std::cell::RefCell;
use std::sync::{Arc, Mutex};
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

pub(crate) struct Filter {
    // Drop the persistent function before its context and runtime.
    predicate: Persistent<Function<'static>>,
    context: Context,
    deadline: Arc<Mutex<Instant>>,
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
        let deadline = Arc::new(Mutex::new(Instant::now() + COMPILE_LIMIT));
        let interrupt = Arc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            Instant::now() >= *interrupt.lock().expect("INPX filter deadline")
        })));
        // Only ECMAScript intrinsics are exposed. No host functions or module loader are installed.
        let context = Context::full(&runtime)?;
        let predicate = context.with(|ctx| {
            let compiled = (|| -> rquickjs::Result<_> {
                let constructor: Constructor = ctx.globals().get("Function")?;
                let factory: Function =
                    constructor.construct((format!("'use strict'; return {source}"),))?;
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
            deadline,
            json: RefCell::new(Vec::new()),
        }))
    }

    pub(crate) fn includes(&self, record: &Record) -> Result<bool> {
        let mut json = self.json.borrow_mut();
        json.clear();
        serde_json::to_writer(&mut *json, record)?;
        *self.deadline.lock().expect("INPX filter deadline") = Instant::now() + RECORD_LIMIT;
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
        Ok(result?)
    }
}
