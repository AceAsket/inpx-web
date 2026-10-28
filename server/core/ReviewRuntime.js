const {AsyncLocalStorage} = require('async_hooks');

// Reviews have their own I/O budget: startup indexing, ratings and every book
// request share these slots, independently of the image decoder pool.
const maxConcurrency = 4;

class ReviewRuntime {
    constructor(concurrency = maxConcurrency) {
        this.concurrency = Math.max(1, Math.min(maxConcurrency, Math.floor(Number(concurrency)) || 1));
        this.active = 0;
        this.queue = [];
    }

    run(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({task, resolve, reject, runInContext:AsyncLocalStorage.snapshot()});
            this.drain();
        });
    }

    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            const entry = this.queue.shift();
            this.active++;
            entry.runInContext(async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally { this.active--; this.drain(); }
            });
        }
    }

    async map(items, task) {
        const results = new Array(items.length);
        let next = 0, failed = false, failure;
        const worker = async() => {
            while (!failed && next < items.length) {
                const index = next++;
                try { results[index] = await this.run(() => task(items[index], index)); }
                catch (error) { if (!failed) failure = error; failed = true; }
            }
        };
        // Do not enqueue an entire library's archive list for every request.
        await Promise.all(Array.from({length:Math.min(this.concurrency, items.length)}, worker));
        // Finish the other readers before propagating a failure to the caller.
        if (failed) throw failure;
        return results;
    }
}

module.exports = new ReviewRuntime();
module.exports.ReviewRuntime = ReviewRuntime;
