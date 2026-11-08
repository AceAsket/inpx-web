const {AsyncLocalStorage} = require('async_hooks');
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const resourceRuntime = require('./ResourceRuntime');

const context = new AsyncLocalStorage();
const defaults = {concurrency: 2, queueLimit: 16, timeoutMs: 120000, queueTimeoutMs: 120000, stderrBytes: 65536};

function limit(value, fallback, min, max) {
    if (value === undefined || value === null || value === '')
        return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function failure(code, message) {
    return Object.assign(new Error(message), {code});
}

class ConversionRuntime {
    constructor(config = {}) {
        this.active = 0;
        this.queue = [];
        this.configure(config);
    }

    configure(config = {}) {
        this.limits = {
            concurrency: limit(config.conversionConcurrency, resourceRuntime.settings.limits.conversions, 1, 16),
            queueLimit: limit(config.conversionQueueLimit, defaults.queueLimit, 0, 256),
            timeoutMs: limit(config.conversionTimeoutMs, defaults.timeoutMs, 100, 3600000),
            queueTimeoutMs: limit(config.conversionQueueTimeoutMs, defaults.queueTimeoutMs, 100, 3600000),
            stderrBytes: defaults.stderrBytes,
        };
    }

    run(task) {
        if (resourceRuntime.isBenchmark()) return Promise.resolve().then(task);
        if (this.active >= this.limits.concurrency && this.queue.length >= this.limits.queueLimit)
            return Promise.reject(failure('INPX_CONVERSION_QUEUE_FULL', 'Очередь конвертации заполнена. Повторите позже.'));
        return new Promise((resolve, reject) => {
            const entry = {task, resolve, reject, runInContext:AsyncLocalStorage.snapshot()};
            entry.timer = setTimeout(() => {
                const index = this.queue.indexOf(entry);
                if (index < 0) return;
                this.queue.splice(index, 1);
                reject(failure('INPX_CONVERSION_QUEUE_TIMEOUT', 'Истекло время ожидания конвертации в очереди.'));
            }, this.limits.queueTimeoutMs);
            this.queue.push(entry);
            this.drain();
        });
    }

    drain() {
        while (this.active < this.limits.concurrency && this.queue.length) {
            const entry = this.queue.shift();
            clearTimeout(entry.timer);
            this.active++;
            const scope = {...this.limits, deadline: Date.now() + this.limits.timeoutMs};
            entry.runInContext(() => context.run(scope, async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally { this.active--; this.drain(); }
            }));
        }
    }
}

function killTree(child) {
    if (!Number.isInteger(child.pid) || child.pid <= 0)
        return Promise.resolve();
    if (process.platform === 'win32') {
        const root = process.env.SystemRoot || process.env.WINDIR;
        const command = root ? path.join(root,'System32','taskkill.exe') : 'taskkill.exe';
        return new Promise(resolve => {
            const killer = spawn(command, ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
            let finished = false;
            const finish = failed => {
                if (finished) return;
                finished = true;clearTimeout(timer);
                if (failed) child.kill();
                resolve();
            };
            const timer = setTimeout(() => {killer.kill();finish(true);},5000);
            killer.once('error', () => finish(true));
            killer.once('close', code => finish(code !== 0));
        });
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
        return Promise.resolve();
    }
}

async function runProcess(command, args, options = {}) {
    if (options.capturePrefixBytes !== undefined && (!options.captureStdout || !Number.isSafeInteger(options.capturePrefixBytes) || options.capturePrefixBytes < 1))
        throw new Error('capturePrefixBytes requires captureStdout and a positive byte limit');
    if (options.capturePrefixBytes !== undefined && (options.outputFile || options.maxOutputBytes && options.maxOutputBytes < options.capturePrefixBytes))
        throw new Error('capturePrefixBytes cannot use outputFile or exceed maxOutputBytes');
    const inherited = context.getStore();
    const scope = inherited || {...defaults, deadline:Date.now() + resourceRuntime.settings.taskTimeoutMs};
    const signal = options.signal || resourceRuntime.signal();
    const effective = {...scope, deadline:Math.min(scope.deadline, Date.now() + (options.timeoutMs || resourceRuntime.settings.taskTimeoutMs))};
    return resourceRuntime.run(() => executeProcess(command, args, options, effective, signal),
        {kind:options.resourceKind || 'conversions', deadline:effective.deadline, signal});
}

async function executeProcess(command, args, options, scope, signal) {
    const timeoutError = () => failure('INPX_CONVERSION_TIMEOUT', 'Превышено время конвертации. Попробуйте другую книгу или формат.');
    if (scope.deadline <= Date.now())
        throw timeoutError();
    if (signal?.aborted) throw Object.assign(new Error('Проверка отменена'), {code:'ABORT_ERR'});
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', options.captureStdout || options.outputFile ? 'pipe' : 'ignore', 'pipe'], env: options.env || process.env,
            cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32',
        });
        let stderr = Buffer.alloc(0);
        let timedOut = false;
        let outputError = null, spawnError = null, outputBytes = 0, prefixComplete = false;
        let termination = null;
        const stop = () => {if (!termination) termination = killTree(child);};
        const chunks = [];
        let output = null, outputDone = Promise.resolve();
        const abort = () => {outputError = Object.assign(new Error('Проверка отменена'), {code:'ABORT_ERR'}); stop();};
        signal?.addEventListener('abort', abort, {once:true});
        if (options.outputFile) child.once('spawn', () => {
            output = fs.createWriteStream(options.outputFile);
            outputDone = new Promise(done => {
                output.once('finish', done);
                output.once('close', done);
                output.once('error', error => {outputError = error; stop(); done();});
            });
            if (options.maxOutputBytes > 0) child.stdout.on('data', data => {
                outputBytes += data.length;
                if (outputBytes > options.maxOutputBytes && !outputError) {
                    outputError = failure('INPX_RESOURCE_OUTPUT_LIMIT', 'Превышен размер результата проверки');
                    child.stdout.unpipe(output);
                    output.destroy();
                    stop();
                }
            });
            child.stdout.pipe(output);
        });
        else if (options.captureStdout) child.stdout.on('data', data => {
            if (outputError || prefixComplete) return;
            if (options.capturePrefixBytes) {
                const part = data.subarray(0, options.capturePrefixBytes - outputBytes);
                chunks.push(part); outputBytes += part.length;
                if (outputBytes >= options.capturePrefixBytes) {prefixComplete = true; stop();}
                return;
            }
            outputBytes += data.length;
            if (outputBytes > (options.maxOutputBytes || Infinity)) {
                outputError = Object.assign(new Error('Превышен размер результата проверки'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
                stop();
            } else chunks.push(data);
        });
        const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, scope.deadline - Date.now()));
        child.stderr.on('data', data => {
            stderr = Buffer.concat([stderr, data]).subarray(-scope.stderrBytes);
        });
        child.once('error', error => {
            spawnError = error.code === 'ENOENT' ? Object.assign(new Error(`${command} not found`), {code:'ENOENT'}) : error;
            if (output) output.destroy();
        });
        child.once('close', async code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            // On Windows the parent may close before taskkill has finished
            // terminating its descendants. Retain the resource slot until then.
            if (termination) await termination;
            await outputDone;
            if (spawnError) reject(spawnError);
            else if (timedOut) reject(timeoutError());
            else if (outputError) reject(outputError);
            else if (code === 0 || prefixComplete) resolve(options.captureStdout ? Buffer.concat(chunks, outputBytes) : undefined);
            else reject(new Error(`${command} failed with exit code ${code}: ${stderr.toString('utf8').trim()}`));
        });
    });
}

module.exports = {ConversionRuntime, runProcess, deadline: () => context.getStore()?.deadline};
