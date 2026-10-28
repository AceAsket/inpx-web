const os = require('os');
const {AsyncLocalStorage} = require('async_hooks');

// Share a small budget across books, covers and EPUB image decoders. Limiting
// each book separately multiplies native processes by the number of readers.
class ImageRuntime {
    constructor(concurrency = Math.min(2, os.availableParallelism())) {
        this.concurrency = Math.max(1, Math.min(2, Math.floor(Number(concurrency)) || 1));
        this.active = 0;
        this.queue = [];
        this.context = new AsyncLocalStorage();
    }

    run(task) {
        // An FB2 image job already holds a slot during extraction. Its single
        // decoder must reuse that slot, including when concurrency is one.
        if (this.context.getStore()?.active)
            return Promise.resolve().then(task);
        return new Promise((resolve, reject) => {
            this.queue.push({task, resolve, reject, runInContext:AsyncLocalStorage.snapshot()});
            this.drain();
        });
    }

    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            const entry = this.queue.shift();
            const lease = {active:true};
            this.active++;
            // Preserve the queued caller's other async contexts (in particular
            // conversion deadlines), rather than inheriting the previous job's.
            entry.runInContext(() => this.context.run(lease, async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally {
                    lease.active = false;
                    this.active--;
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
