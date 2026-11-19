const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {writeFileAtomic} = require('./FilePersistence');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const isbn = require('../../shared/Isbn');

class LibraryIsbnIndex {
    constructor(worker, {idleMs = 30000, cacheBytes = 32 * 1024 ** 2} = {}) {
        this.worker = worker;
        this.file = path.join(worker.config.dataDir, 'isbn-index.json');
        this.native = require('./RustIsbnStore').open(this.file);
        this.recentSelections = new Map();
        this.loading = null; this.state = null; this.job = null;
        this.lookup = new Map(); this.deleted = new Set();
        this.idleMs = idleMs; this.cacheBytes = cacheBytes; this.users = 0; this.retainedBytes = 0;
    }
    release() {
        clearTimeout(this.idleTimer);
        const closing = this.loading && this.native?.release();
        this.recentSelections.clear();
        this.state = null; this.loading = null; this.lookup = new Map(); this.deleted = new Set(); this.retainedBytes = 0;
        return closing?.catch(()=>{});
    }
    scheduleRelease() {
        clearTimeout(this.idleTimer);
        if (this.users || this.job && !this.job.finishedAt) return;
        if (this.retainedBytes > this.cacheBytes) {this.release(); return;}
        this.idleTimer = setTimeout(() => this.release(),this.idleMs);
        this.idleTimer.unref?.();
    }
    async use(work) {
        clearTimeout(this.idleTimer); this.users++;
        try {return await work();} finally {this.users--; this.scheduleRelease();}
    }
    async close() {
        this.cancel(); await this.pending; await this.release();
    }
    async signature() {
        const db = this.worker.db;
        const rows = db.nativeCatalogue ? ['inpxHash','indexUpdate'].map(id=>({id,value:db.nativeCatalogue[id]}))
            : await db.select({table:'config',where:"@@id(['inpxHash','indexUpdate'])"});
        return crypto.createHash('sha256').update(JSON.stringify(rows.map(row => [row.id,row.value]).sort((a,b) => a[0].localeCompare(b[0])))).digest('hex');
    }
    async load() {
        if (!this.loading) this.loading = (async() => {
            try {
                if (this.native) {
                    const saved = await this.native.load();
                    this.state = saved && {...saved,entries:[]};
                    this.loadError = '';
                    return;
                }
                const saved = await fs.readJson(this.file);
                if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Некорректный индекс ISBN');
                this.state = saved;
                this.rebuildLookup();
            } catch (error) {
                this.state = null; this.lookup.clear(); this.deleted.clear();
                if (error.code !== 'ENOENT') this.loadError = 'Не удалось прочитать индекс ISBN. Запустите полную перестройку.';
            }
        })();
        await this.loading;
    }
    rebuildLookup() {
        this.lookup = new Map(); this.deleted = new Set(); this.retainedBytes = 0;
        for (const [id, numbers, deleted] of this.state?.entries || []) {
            if (!Number.isSafeInteger(id) || !Array.isArray(numbers)) throw new Error('Некорректная запись индекса ISBN');
            this.addLookup(id,numbers,deleted);
        }
    }
    addLookup(id,numbers,deleted) {
        this.retainedBytes += 128 + numbers.length * 96;
        for (const number of numbers) {
            const key = isbn.normalize(number);
            if (!this.lookup.has(key)) {this.lookup.set(key,new Set()); this.retainedBytes += 160 + key.length * 2;}
            this.lookup.get(key).add(id);
        }
        if (deleted) {this.deleted.add(id); this.retainedBytes += 32;}
    }
    async status() {
        await this.load();
        const current = this.state?.signature === await this.signature();
        const running = !!this.job && !this.job.finishedAt;
        const {checked = 0,total = 0,found = 0,errors = 0,skipped = 0,complete = false,updatedAt} = current ? this.state : {};
        return {state:running ? 'running' : current && complete ? 'ready' : current ? 'paused' : 'empty',
            checked,total,found,errors,skipped,updatedAt,error:this.loadError || this.job?.error || '',remote:!!this.worker.remoteLib};
    }
    async save(reset = false) {
        this.state.updatedAt = Date.now();
        if (this.native) {
            await this.native.save(this.state,reset);
            this.state.entries.length = 0;
            return;
        }
        await writeFileAtomic(this.file,JSON.stringify(this.state));
    }
    async start(options = {}) {
        if (this.starting) throw new Error('Подготовка ISBN уже выполняется');
        this.starting = true;
        try {return await this.startInternal(options);} finally {this.starting = false;}
    }
    async startInternal(options) {
        if (this.job && !this.job.finishedAt) throw new Error('Подготовка ISBN уже выполняется');
        if (this.worker.remoteLib) throw new Error('Индекс ISBN подготавливается на сервере с исходными книгами');
        await this.load();
        const signature = await this.signature();
        if (this.loadError && !options.force) throw new Error(this.loadError);
        if (options.force || this.state?.signature !== signature) {
            const previous = this.state;
            this.state = {version:1,signature,revision:crypto.randomBytes(12).toString('hex'),lastId:0,checked:0,total:0,found:0,errors:0,skipped:0,complete:false,entries:[]};
            try {await this.save(true);}
            catch (error) {this.state = previous; throw error;}
            this.loadError = '';
            this.recentSelections.clear();
            if (!this.native) this.rebuildLookup();
        }
        if (this.state.complete) return this.status();
        const job = this.job = {id:tasks.start('isbn','Индекс ISBN'),controller:new AbortController()};
        this.pending = runtime.withSignal(job.controller.signal,() => runtime.withTask(job.id,() => this.run(job)))
            .then(() => tasks.finish(job.id)).catch(error => {
                job.error = job.controller.signal.aborted ? 'Подготовка ISBN отменена' : error.message;
                tasks.finish(job.id,job.controller.signal.aborted ? null : error);
            }).finally(() => {
                job.finishedAt = Date.now();
                if (job.controller.signal.aborted) tasks.update(job.id,{state:'cancelled'});
                this.scheduleRelease();
            });
        return this.status();
    }
    cancel() {this.job?.controller.abort();}
    async run(job) {
        const worker = this.worker, db = worker.db, generation = worker.libraryAssetGeneration;
        const signal = job.controller.signal, cache = new Map();
        let checkpointAt = Date.now();
        const {byIds,orderedIds} = require('./CatalogueRows');
        const ids = db.nativeCatalogue ? (await orderedIds(db)).sort((a,b)=>a-b)
            : (await db.select({table:'book',rawResult:true,where:'return Array.from(@all()).sort((a,b) => a-b);'}))[0].rawResult;
        this.state.total = ids.length;
        const guard = () => {
            signal.throwIfAborted();
            if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Запустите подготовку ISBN заново');
        };
        try {
            for (let offset = 0; offset < ids.length; offset += 250) {
                guard();
                const next = ids.slice(offset,offset + 250).filter(id => id > this.state.lastId);
                if (!next.length) continue;
                const books = await byIds(db,next);
                for (const book of books.sort((a,b) => a.id - b.id)) {
                    guard();
                    let numbers = isbn.extract(book.isbn);
                    if (!numbers.length && !book.del && ['fb2','epub'].includes(String(book.ext).toLowerCase())) {
                        try {
                            const max = worker.config.isbnMaxBookBytes || 64 * 1024 * 1024;
                            const data = await require('./LibraryBookData').read(worker,book,cache,signal,max,'isbn');
                            guard();
                            numbers = Array.isArray(data) ? data : await require('./BookMetadata').isbnFromData(data,book.ext,worker.config,max);
                        } catch (error) {
                            guard();
                            if (['AUDIT_SOURCE_UNAVAILABLE','INPX_RESOURCE_QUEUE_FULL','INPX_RESOURCE_QUEUE_TIMEOUT','INPX_RESOURCE_TIMEOUT','INPX_CONVERSION_TIMEOUT'].includes(error.code)) throw error;
                            this.state.errors++;
                        }
                    } else if (!numbers.length) this.state.skipped++;
                    guard();
                    if (numbers.length) {
                        this.state.entries.push([book.id,numbers,!!book.del]); this.state.found++;
                        if (!this.native) this.addLookup(book.id,numbers,!!book.del);
                    }
                    this.state.checked++; this.state.lastId = book.id;
                }
                tasks.update(job.id,{phase:'Чтение ISBN',done:this.state.checked,total:this.state.total});
                // Bound pending Rust writes while keeping whole-file legacy checkpoints infrequent.
                if (Date.now() - checkpointAt >= 30000 || this.native && this.state.entries.length>=4096) {
                    await this.save(); checkpointAt = Date.now();
                }
                await require('./utils').processLoop();
            }
            guard(); this.state.complete = true;
        } finally {
            for (const state of cache.values()) await state.reader?.close().catch(() => {});
            await this.save();
        }
    }
    async select(value) {
        if (this.worker.remoteLib) throw new Error('Поиск ISBN пока недоступен для удалённой библиотеки');
        const key = isbn.normalize(value);
        const status = await this.status();
        if (status.state !== 'ready') throw new Error('Индекс ISBN ещё не готов. Администратор может подготовить его в разделе «Задачи»');
        if (this.native) {
            const state = this.state;
            const signature = state.signature + ':' + state.revision;
            const cached = this.recentSelections.get(key);
            const selected = cached?.signature === signature ? cached : {...await this.native.select(state,key),signature};
            if (state === this.state && selected.ids.length <= 4096) {
                this.recentSelections.delete(key);
                this.recentSelections.set(key,selected);
                if (this.recentSelections.size > 64) this.recentSelections.delete(this.recentSelections.keys().next().value);
            }
            return {ids:Uint32Array.from(selected.ids),deletedIds:new Set(selected.deletedIds),signature};
        }
        return {ids:new Uint32Array(this.lookup.get(key) || []),deletedIds:this.deleted,signature:this.state.signature + ':' + this.state.revision};
    }
}

// Nested operations share the lease; an idle/oversized cache is dropped only
// after the outermost consumer finishes, never during an active build.
for (const name of ['load','status','start','select']) {
    const method = LibraryIsbnIndex.prototype[name];
    LibraryIsbnIndex.prototype[name] = function(...args) {return this.use(() => method.apply(this,args));};
}

module.exports = LibraryIsbnIndex;
