const {words, root} = require('../../shared/CatalogSearch');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const crypto = require('crypto');
const TABLE = 'catalog_lookup', VERSION = 2;
const BATCH_SIZE = 1000, IDLE_MS = 30000;

// A separate inverted index maps words to author/series/title IDs, not to every
// book by a prolific author. Built incrementally in bounded batches; a marker
// makes interrupted builds distinguishable from complete ones after a restart.
class CatalogLookupIndex {
    constructor(worker, {idleMs = IDLE_MS} = {}) {
        this.worker = worker; this.db = worker.db; this.generation = worker.libraryAssetGeneration;
        this.controller = new AbortController(); this.ready = false;
        this.cursor = 'catalog-lookup-' + crypto.randomBytes(12).toString('hex');
        this.idleMs = idleMs; this.readers = new Set();
        this.progress = {done:0, total:null};
    }
    async open() {
        clearTimeout(this.idleTimer);
        await this.closing;
        this.check();
        if (!this.opening) this.opening = this.db.open({table: TABLE, cacheSize: 5}).catch(error => {this.opening = null; throw error;});
        await this.opening;
    }
    release() {
        clearTimeout(this.idleTimer);
        if (this.controller.signal.aborted || this.readers.size || !this.ready) return;
        this.idleTimer = setTimeout(() => {
            this.opening = null;
            this.closing = this.db.close({table: TABLE}).catch(error => this.worker.addAdminEvent?.('warn', 'search', error.message));
        }, this.idleMs);
        this.idleTimer.unref?.();
    }
    check() {
        if (this.controller.signal.aborted || this.db !== this.worker.db || this.generation !== this.worker.libraryAssetGeneration)
            throw new Error('Подготовка подсказок отменена: библиотека обновилась');
    }
    async background(work) {
        const run = async() => {
            this.check();
            return runtime.run(work, {kind: 'background'});
        };
        // Wait for foreground I/O BEFORE reserving a runtime slot. A reader
        // may be awaiting an existing background preparation that needs it.
        const result = this.worker.runBackground
            ? await this.worker.runBackground(run, () => this.controller.signal.aborted, this.controller.signal)
            : await run();
        this.check();
        return result;
    }
    async readNames(kind) {
        // Jemba applies offset/limit AFTER loading and cloning every matching
        // row, including bookIds. Project inside a persistent database cursor.
        const batch = await this.background(() => this.db.select({table: kind, rawResult: true, where: `
            let cursor = @getItem(${this.db.esc(this.cursor)});
            if (!cursor) {cursor = @all(); @setItem(${this.db.esc(this.cursor)}, cursor);}
            const names = [];
            while (names.length < ${BATCH_SIZE}) {
                const next = cursor.next();
                if (next.done) break;
                const row = @unsafeRow(next.value);
                if (row) names.push({id: row.id, name: row.name});
            }
            return names;
        `}));
        return batch[0].rawResult;
    }
    async ensure() {
        if (this.retryAfter && Date.now() < this.retryAfter) return false;
        if (!this.initialization) this.initialization = (async() => {
            this.check();
            const signature = String(this.worker.dbSearcher.dbConfig?.inpxHash || '');
            if (await this.db.tableExists({table: TABLE})) {
                await this.open();
                const marker = await this.db.select({table: TABLE, where: '@@id(0)'});
                if (marker[0]?.complete && marker[0].version === VERSION && marker[0].signature === signature) {
                    this.ready = true; this.release(); return;
                }
            }
            this.building = this.build(signature);
            this.building.catch(error => {
                this.initialization = null; this.ready = false; this.retryAfter = Date.now() + 60000;
                this.worker.addAdminEvent?.('warn', 'search', error.message);
            });
        })();
        await this.initialization;
        return this.ready;
    }
    async build(signature) {
        const id = tasks.start('catalog-lookup', 'Подготовка подсказок каталога');
        try {
            await runtime.withBackground(() => runtime.withSignal(this.controller.signal, async() => {
                clearTimeout(this.idleTimer); await this.closing; this.opening = null;
                if (await this.db.tableExists({table: TABLE})) await this.db.drop({table: TABLE});
                this.check();
                await this.db.create({table: TABLE, cacheSize: 5, index: {field: 'value', unique: false, type: 'string', depth: 1000000}});
                await this.db.insert({table: TABLE, rows: [{id: 0, value: '', complete: false, version: VERSION, signature}]});
                const metadata = await this.db.getDbInfo();
                this.progress = {done:0, total:['author', 'series', 'title'].reduce((sum, kind) => sum + (metadata[kind]?.count || 0), 0)};
                tasks.update(id, {total:this.progress.total});
                let rowId = 0, done = 0;
                for (const kind of ['author', 'series', 'title']) {
                    try {
                        while (!this.controller.signal.aborted) {
                            this.check();
                            const names = await this.readNames(kind);
                            if (!names.length) break;
                            // One posting list per word/batch instead of a row for
                            // every word/name pair. The vocabulary stays bounded.
                            const postings = new Map();
                            for (const name of names) for (const word of new Set(words(name.name).map(root))) {
                                if (!postings.has(word)) postings.set(word, []);
                                postings.get(word).push(name.id);
                            }
                            const rows = Array.from(postings, ([word, entityIds]) => ({id: ++rowId, value: `${kind}:${word}`, entityIds}));
                            if (rows.length) await this.background(() => this.db.insert({table: TABLE, rows}));
                            done += names.length;
                            this.progress.done = done;
                            tasks.update(id, {phase: 'Индекс имён, серий и названий', done});
                            // Leave time for searches/readers on a single-core NAS.
                            await new Promise(resolve => setTimeout(resolve, 25));
                        }
                    } finally {
                        await this.db.select({table: kind, rawResult: true, where: `@delItem(${this.db.esc(this.cursor)}); return null;`});
                    }
                }
                this.check();
                await this.db.insert({table: TABLE, replace: true, rows: [{id: 0, value: '', complete: true, version: VERSION, signature}]});
                this.ready = true;
                this.release();
            }));
            tasks.finish(id);
        } catch (error) {
            tasks.finish(id, error);
            this.opening = null;
            await this.db.close({table: TABLE});
            throw error;
        }
    }
    async ids(kind, query) {
        this.check();
        const read = this.readIds(kind, query);
        this.readers.add(read);
        try {return await read;}
        finally {this.readers.delete(read); this.release();}
    }
    async readIds(kind, query) {
        await this.open();
        const tokens = [...new Set(words(query).map(root))], db = this.db;
        const result = await db.select({table: TABLE, rawResult: true, where: `
            let result = null;
            for (const token of ${db.esc(tokens)}) {
                const prefix = ${db.esc(kind + ':')} + token, found = new Set();
                for (const id of @dirtyIndexLR('value', prefix, prefix + ${db.esc(String.fromCodePoint(0xFFFFF))})) {
                    const row = @unsafeRow(id);
                    for (const entityId of row.entityIds) found.add(entityId);
                }
                result = result === null ? found : new Set([...result].filter(id => found.has(id)));
                if (!result.size) break;
            }
            return Array.from(result || []);
        `});
        this.check(); return result[0].rawResult;
    }
    async close() {
        this.controller.abort(); clearTimeout(this.idleTimer);
        if (this.building) await this.building.catch(() => {});
        await Promise.allSettled([...this.readers]);
        await this.closing;
        await this.db.close({table: TABLE});
        this.opening = null;
    }
}
module.exports = CatalogLookupIndex;
