const path = require('path');
const crypto = require('crypto');
const {parse} = require('../../shared/RatingCount');
const {entryKey} = require('./LibraryReviews');
const {getEnabledLibrarySources} = require('./LibrarySources');
const tasks = require('./BackgroundTasks');

class LibraryRatingIndex {
    constructor(worker) {
        this.worker = worker;
        this.instanceId = crypto.randomBytes(16).toString('hex');
        this.cached = null;
        this.pending = new Map();
    }

    async load() {
        const worker = this.worker, db = worker.db, generation = worker.libraryAssetGeneration;
        const remote = worker.remoteLib?.metadata ? await worker.remoteLib.metadata.ratingIndex() : null;
        const dirs = [...new Set([worker.config.libDir, ...getEnabledLibrarySources(worker.config).map(source => source.libDir)].filter(Boolean).map(dir => path.resolve(dir)))];
        const states = remote ? [] : await Promise.all(dirs.map(dir => worker.getReviewArchiveState(dir)));
        const signature = crypto.createHash('sha256').update(JSON.stringify([this.instanceId, generation, remote?.signature, states.map(state => state.signature)])).digest('hex');
        if (this.cached?.signature === signature) return this.cached;
        if (this.pending.size && !this.pending.has(signature)) {
            await Promise.allSettled(this.pending.values());
            return this.load();
        }
        if (!this.pending.has(signature)) {
            const build = async() => {
                const task = this.taskId = tasks.start('ratings', 'Индекс числа голосов', {visibility:'public'});
                try {
                const ratings = await Promise.all(states.map(state => worker.ensureLibraryRatings(state)));
                if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Повторите поиск');
                const sources = new Map(dirs.map((dir, index) => [dir, ratings[index]]));
                const entries = [];
                if (remote ? !remote.counts.size : ratings.every(map => !map.size)) return (this.cached = {signature, entries});
                // JembaDb applies offset/limit after loading and cloning every matching row.
                // Enumerate lightweight IDs once, then restrict each read before materialization.
                const [{rawResult:ids}] = await db.select({table:'book', rawResult:true, where:'return Array.from(@all());'});
                tasks.update(task, {phase:'Обработка книг', total:ids.length});
                for (let offset = 0; offset < ids.length; offset += 5000) {
                    if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Повторите поиск');
                    const rows = await db.select({table:'book', where:`@@id(${db.esc(ids.slice(offset, offset + 5000))})`,
                        map:'row => ({id:row.id, _uid:row._uid, folder:row.folder, file:row.file, ext:row.ext, del:row.del, sourceLibDir:row.sourceLibDir})'});
                    for (const book of rows) {
                        const rating = remote ? (remote.counts.has(book._uid) ? {count:remote.counts.get(book._uid)} : null)
                            : sources.get(path.resolve(book.sourceLibDir || worker.config.libDir))?.get(entryKey(book.folder, `${book.file}.${book.ext}`));
                        if (rating && Number.isSafeInteger(rating.count) && rating.count >= 0) entries.push([rating.count, book.id, !!book.del]);
                    }
                    tasks.update(task, {done:Math.min(ids.length, offset + 5000)});
                    await require('./utils').processLoop();
                }
                entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
                if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Повторите поиск');
                return (this.cached = {signature, entries});
                } catch (error) { tasks.finish(task, error); throw error; }
                finally { if (tasks.tasks.get(task)?.state === 'running') tasks.finish(task); }
            };
            const promise = build().finally(() => this.pending.delete(signature));
            this.pending.set(signature, promise);
        }
        return this.pending.get(signature);
    }

    async status() {
        let state = 'running', error = '';
        const loading = this.load().then(() => {state = 'ready';}, reason => {state = 'error'; error = reason.message;});
        await Promise.race([loading, new Promise(resolve => setTimeout(resolve, 50))]);
        const task = this.taskId && tasks.tasks.get(this.taskId);
        return {state, error, phase:state === 'running' ? task?.phase || 'Чтение метаданных' : '', done:task?.done || 0, total:task?.total ?? null};
    }

    async select(value) {
        const range = parse(value);
        const index = await this.load();
        const boundary = (value, inclusive) => {
            let lo = 0, hi = index.entries.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1, count = index.entries[mid][0];
                if (count < value || inclusive && count === value) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        const entries = index.entries.slice(boundary(range.min, false), boundary(range.max, true));
        return {signature:index.signature, ids:new Uint32Array(entries.map(entry => entry[1])), deletedIds:new Set(entries.filter(entry => entry[2]).map(entry => entry[1]))};
    }
}

module.exports = LibraryRatingIndex;
