const {AsyncLocalStorage} = require('async_hooks');
const resourceRuntime = require('./ResourceRuntime');

// Share a small budget across books, covers and EPUB image decoders. Limiting
// each book separately multiplies native processes by the number of readers.
class ImageRuntime {
    constructor(concurrency = resourceRuntime.settings.limits.images, resources = resourceRuntime) {
        this.concurrency = Math.max(1, Math.min(16, Math.floor(Number(concurrency)) || 1));
        this.resources = resources;
        this.backgroundConcurrency = Math.min(resources.settings.limits.background, Math.max(1, this.concurrency - 1));
        this.active = 0;
        this.backgroundActive = 0;
        this.foregroundStreak = 0;
        this.queue = [];
        this.context = new AsyncLocalStorage();
    }

    run(task) {
        if (this.resources.isBenchmark()) return Promise.resolve().then(task);
        // An FB2 image job already holds a slot during extraction. Its single
        // decoder must reuse that slot, including when concurrency is one.
        if (this.context.getStore()?.active)
            return Promise.resolve().then(task);
        return new Promise((resolve, reject) => {
            this.queue.push({task, resolve, reject, background:this.resources.isBackground(), runInContext:AsyncLocalStorage.snapshot()});
            this.drain();
        });
    }

    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            // Background jobs waiting for the shared process budget must not
            // reserve every image slot before a reader reaches this queue.
            const background = this.backgroundActive < this.backgroundConcurrency
                ? this.queue.find(entry => entry.background) : null;
            const foreground = this.queue.find(entry => !entry.background);
            const entry = this.foregroundStreak >= 8 && background ? background : foreground || background;
            if (!entry) return;
            this.queue.splice(this.queue.indexOf(entry), 1);
            this.foregroundStreak = entry.background ? 0 : this.foregroundStreak + 1;
            const lease = {active:true};
            this.active++;
            if (entry.background) this.backgroundActive++;
            // Preserve the queued caller's other async contexts (in particular
            // conversion deadlines), rather than inheriting the previous job's.
            entry.runInContext(() => this.context.run(lease, async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally {
                    lease.active = false;
                    this.active--;
                    if (entry.background) this.backgroundActive--;
                    this.drain();
                }
            }));
        }
    }

    async map(items, task) {
        const results = new Array(items.length);
        let next = 0, failure, failed = false;
        const worker = async() => {
            while (!failed && next < items.length) {
                const index = next++;
                try { results[index] = await this.run(() => task(items[index], index)); }
                catch (error) { if (!failed) failure = error; failed = true; }
            }
        };
        // At most two waiting jobs per book, rather than one per illustration.
        const workers = this.context.getStore()?.active ? 1 : Math.min(this.concurrency, items.length);
        await Promise.all(Array.from({length:workers}, worker));
        // Wait for all workers before a caller can close its archive on failure.
        if (failed) throw failure;
        return results;
    }
}

module.exports = new ImageRuntime();
module.exports.ImageRuntime = ImageRuntime;
