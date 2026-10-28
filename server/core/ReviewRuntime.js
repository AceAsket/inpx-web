const {AsyncLocalStorage} = require('async_hooks');
const resourceRuntime = require('./ResourceRuntime');

// Reviews have their own I/O budget: startup indexing, ratings and every book
// request share these slots, independently of the image decoder pool.
const maxConcurrency = 16;

class ReviewRuntime {
    constructor(concurrency = resourceRuntime.settings.limits.reviews) {
        this.concurrency = Math.max(1, Math.min(maxConcurrency, Math.floor(Number(concurrency)) || 1));
        this.active = 0;
        this.backgroundActive = 0;
        this.foregroundStreak = 0;
        this.queue = [];
    }

    run(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({task, resolve, reject, background:resourceRuntime.isBackground(), runInContext:AsyncLocalStorage.snapshot()});
            this.drain();
        });
    }

    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            const background = this.backgroundActive < resourceRuntime.settings.limits.background
                ? this.queue.find(item => item.background) : null;
            const foreground = this.queue.find(item => !item.background);
            const entry = this.foregroundStreak >= 8 && background ? background : foreground || background;
            if (!entry) return;
            this.queue.splice(this.queue.indexOf(entry), 1);
            this.foregroundStreak = entry.background ? 0 : this.foregroundStreak + 1;
            this.active++;
            if (entry.background) this.backgroundActive++;
            entry.runInContext(async() => {
                try { entry.resolve(await entry.task()); }
                catch (error) { entry.reject(error); }
                finally {
                    this.active--;
                    if (entry.background) this.backgroundActive--;
                    this.drain();
                }
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
