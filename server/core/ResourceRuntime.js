const {AsyncLocalStorage} = require('async_hooks');
const policy = require('./ResourcePolicy');

const context = new AsyncLocalStorage();
const failure = (code, message) => Object.assign(new Error(message), {code});

class ResourceRuntime {
    constructor(settings = policy.resolve()) {
        this.settings = settings;
        this.active = 0;
        this.queue = [];
        this.normal = {active:0, kinds:{}, background:0};
        this.completed = 0; this.failed = 0; this.foregroundStreak = 0;
        this.waits = []; this.durations = [];
    }

    run(task, options = {}) {
        const scope = context.getStore() || {};
        const group = scope.group || this.normal;
        const limits = scope.limits || this.settings.limits;
        const kind = options.kind || 'conversions';
        const background = scope.priority === 'background' || !!scope.group;
        const signal = options.signal || scope.signal;
        const deadline = options.deadline || Date.now() + this.settings.taskTimeoutMs;
        if (signal?.aborted) return Promise.reject(failure('ABORT_ERR', 'Проверка отменена'));
        if (this.queue.length >= 256) return Promise.reject(failure('INPX_RESOURCE_QUEUE_FULL', 'Очередь обработки заполнена. Повторите позже.'));
        return new Promise((resolve, reject) => {
            const entry = {task, resolve, reject, group, limits, kind, background, signal, deadline,
                queuedAt:Date.now(), runInContext:AsyncLocalStorage.snapshot()};
            const remove = error => {
                const index = this.queue.indexOf(entry);
                if (index < 0) return;
                this.queue.splice(index, 1); this.clear(entry); reject(error); this.drain();
            };
            entry.abort = () => remove(failure('ABORT_ERR', 'Проверка отменена'));
            entry.timer = setTimeout(() => remove(failure('INPX_RESOURCE_QUEUE_TIMEOUT', 'Истекло время ожидания обработки.')), Math.max(1, deadline - Date.now()));
            signal?.addEventListener('abort', entry.abort, {once:true});
            this.queue.push(entry); this.drain();
        });
    }

    clear(entry) {
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.abort);
    }

    drain() {
        while (this.active < this.settings.hardMax) {
            const eligible = entry => entry.group.active < entry.limits.total
                && (entry.group.kinds[entry.kind] || 0) < (entry.limits[entry.kind] || entry.limits.total)
                && (!entry.background || entry.group !== this.normal || entry.group.background < entry.limits.background);
            // Benchmark groups may use their candidate's concurrency; background
            // production work remains limited so readers retain available slots.
            const candidates = this.queue.filter(eligible);
            if (!candidates.length) return;
            const foreground = candidates.find(entry => !entry.background);
            const background = candidates.find(entry => entry.background);
            const entry = this.foregroundStreak >= 8 && background ? background : foreground || background;
            this.foregroundStreak = entry.background ? 0 : this.foregroundStreak + 1;
            this.queue.splice(this.queue.indexOf(entry), 1); this.clear(entry);
            this.active++; entry.group.active++;
            entry.group.kinds[entry.kind] = (entry.group.kinds[entry.kind] || 0) + 1;
            if (entry.background) entry.group.background++;
            this.sample(this.waits, Date.now() - entry.queuedAt);
            const started = Date.now();
            entry.runInContext(async() => {
                try { entry.resolve(await entry.task()); this.completed++; }
                catch (error) { this.failed++; entry.reject(error); }
                finally {
                    this.sample(this.durations, Date.now() - started);
                    this.active--; entry.group.active--; entry.group.kinds[entry.kind]--;
                    if (entry.background) entry.group.background--;
                    this.drain();
                }
            });
        }
    }

    sample(list, value) {list.push(value); if (list.length > 120) list.shift();}

    snapshot() {
        const p95 = list => list.length ? list.slice().sort((a,b) => a-b)[Math.floor((list.length - 1) * 0.95)] : 0;
        return {active:this.active, queued:this.queue.length, foreground:this.normal.active - this.normal.background,
            background:this.normal.background, kinds:{...this.normal.kinds}, completed:this.completed, failed:this.failed,
            waitP95Ms:p95(this.waits), durationP95Ms:p95(this.durations)};
    }

    withBackground(task) {return context.run({...context.getStore(), priority:'background'}, task);}
    withBenchmark(limits, signal, task) {
        return context.run({group:{active:0, kinds:{}, background:0}, limits, signal, priority:'background'}, task);
    }
    signal() {return context.getStore()?.signal;}
    isBenchmark() {return !!context.getStore()?.group;}
    isBackground() {return context.getStore()?.priority === 'background';}
}

module.exports = new ResourceRuntime();
module.exports.ResourceRuntime = ResourceRuntime;
