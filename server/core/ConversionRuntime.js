const {AsyncLocalStorage} = require('async_hooks');
const {spawn} = require('child_process');

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
            concurrency: limit(config.conversionConcurrency, defaults.concurrency, 1, 16),
            queueLimit: limit(config.conversionQueueLimit, defaults.queueLimit, 0, 256),
            timeoutMs: limit(config.conversionTimeoutMs, defaults.timeoutMs, 100, 3600000),
            queueTimeoutMs: limit(config.conversionQueueTimeoutMs, defaults.queueTimeoutMs, 100, 3600000),
            stderrBytes: defaults.stderrBytes,
        };
    }

    run(task) {
        if (this.active >= this.limits.concurrency && this.queue.length >= this.limits.queueLimit)
            return Promise.reject(failure('INPX_CONVERSION_QUEUE_FULL', 'Очередь конвертации заполнена. Повторите позже.'));
        return new Promise((resolve, reject) => {
            const entry = {task, resolve, reject};
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
            context.run(scope, async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally { this.active--; this.drain(); }
            });
        }
    }
}

function killTree(child) {
    if (!Number.isInteger(child.pid) || child.pid <= 0)
        return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code) child.kill(); });
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
}

async function runProcess(command, args, options = {}) {
    const scope = context.getStore() || {...defaults, deadline: Date.now() + defaults.timeoutMs};
    const timeoutError = () => failure('INPX_CONVERSION_TIMEOUT', 'Превышено время конвертации. Попробуйте другую книгу или формат.');
    if (scope.deadline <= Date.now())
        throw timeoutError();
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'], env: options.env || process.env,
            cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32',
        });
        let stderr = Buffer.alloc(0);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1, scope.deadline - Date.now()));
        child.stderr.on('data', data => {
            stderr = Buffer.concat([stderr, data]).subarray(-scope.stderrBytes);
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error.code === 'ENOENT' ? Object.assign(new Error(`${command} not found`), {code: 'ENOENT'}) : error);
        });
        child.once('close', code => {
            clearTimeout(timer);
            if (timedOut) reject(timeoutError());
            else if (code === 0) resolve();
            else reject(new Error(`${command} failed with exit code ${code}: ${stderr.toString('utf8').trim()}`));
        });
    });
}

module.exports = {ConversionRuntime, runProcess};
