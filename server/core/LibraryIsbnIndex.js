const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {writeFileAtomic} = require('./FilePersistence');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const isbn = require('../../shared/Isbn');

class LibraryIsbnIndex {
    constructor(worker) {
        this.worker = worker;
        this.file = path.join(worker.config.dataDir, 'isbn-index.json');
        this.loading = null; this.state = null; this.job = null;
        this.lookup = new Map(); this.deleted = new Set();
    }
    async signature() {
        const rows = await this.worker.db.select({table:'config', where:"@@id(['inpxHash','indexUpdate'])"});
        return crypto.createHash('sha256').update(JSON.stringify(rows.map(row => [row.id,row.value]).sort((a,b) => a[0].localeCompare(b[0])))).digest('hex');
    }
    async load() {
        if (!this.loading) this.loading = (async() => {
            try {
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
        this.lookup = new Map(); this.deleted = new Set();
        for (const [id, numbers, deleted] of this.state?.entries || []) {
            if (!Number.isSafeInteger(id) || !Array.isArray(numbers)) throw new Error('Некорректная запись индекса ISBN');
            for (const number of numbers) {
                const key = isbn.normalize(number);
                if (!this.lookup.has(key)) this.lookup.set(key,new Set());
                this.lookup.get(key).add(id);
            }
            if (deleted) this.deleted.add(id);
        }
    }
    async status() {
        await this.load();
        const current = this.state?.signature === await this.signature();
        const running = !!this.job && !this.job.finishedAt;
        const {checked = 0,total = 0,found = 0,errors = 0,skipped = 0,complete = false,updatedAt} = current ? this.state : {};
        return {state:running ? 'running' : current && complete ? 'ready' : current ? 'paused' : 'empty',
            checked,total,found,errors,skipped,updatedAt,error:this.loadError || this.job?.error || '',remote:!!this.worker.remoteLib};
    }
    async save() {
        this.state.updatedAt = Date.now();
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
            this.state = {version:1,signature,revision:crypto.randomBytes(12).toString('hex'),lastId:0,checked:0,total:0,found:0,errors:0,skipped:0,complete:false,entries:[]};
            await this.save(); this.loadError = ''; this.rebuildLookup();
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
            });
        return this.status();
    }
    cancel() {this.job?.controller.abort();}
    async run(job) {
        const worker = this.worker, db = worker.db, generation = worker.libraryAssetGeneration;
        const signal = job.controller.signal, cache = new Map();
        const [{rawResult:ids}] = await db.select({table:'book',rawResult:true,where:'return Array.from(@all()).sort((a,b) => a-b);'});
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
                const books = await db.select({table:'book',where:`@@id(${db.esc(next)})`});
                for (const book of books.sort((a,b) => a.id - b.id)) {
                    guard();
                    let numbers = isbn.extract(book.isbn);
                    if (!numbers.length && !book.del && ['fb2','epub'].includes(String(book.ext).toLowerCase())) {
                        try {
                            const max = worker.config.isbnMaxBookBytes || 64 * 1024 * 1024;
                            const data = await require('./LibraryBookData').read(worker,book,cache,signal,max);
                            guard();
                            numbers = await require('./BookMetadata').isbnFromData(data,book.ext,worker.config,max);
                        } catch (error) {
                            guard();
                            if (['AUDIT_SOURCE_UNAVAILABLE','INPX_RESOURCE_QUEUE_FULL','INPX_RESOURCE_QUEUE_TIMEOUT','INPX_CONVERSION_TIMEOUT'].includes(error.code)) throw error;
                            this.state.errors++;
                        }
                    } else if (!numbers.length) this.state.skipped++;
                    guard();
                    if (numbers.length) {
                        this.state.entries.push([book.id,numbers,!!book.del]); this.state.found++;
                        for (const number of numbers) {
                            if (!this.lookup.has(number)) this.lookup.set(number,new Set());
                            this.lookup.get(number).add(book.id);
                        }
                        if (book.del) this.deleted.add(book.id);
                    }
                    this.state.checked++; this.state.lastId = book.id;
                }
                tasks.update(job.id,{phase:'Чтение ISBN',done:this.state.checked,total:this.state.total});
                if (offset % 5000 === 0) await this.save();
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
        return {ids:new Uint32Array(this.lookup.get(key) || []),deletedIds:this.deleted,signature:this.state.signature + ':' + this.state.revision};
    }
}

module.exports = LibraryIsbnIndex;
