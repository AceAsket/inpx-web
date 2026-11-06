const {words, root} = require('../../shared/CatalogSearch');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const TABLE = 'catalog_lookup', VERSION = 1;

// A separate inverted index maps words to author/series/title IDs, not to every
// book by a prolific author. Built incrementally in bounded batches; a marker
// makes interrupted builds distinguishable from complete ones after a restart.
class CatalogLookupIndex {
    constructor(worker) {
        this.worker = worker; this.db = worker.db; this.generation = worker.libraryAssetGeneration;
        this.controller = new AbortController(); this.ready = false;
    }
    check() {
        if (this.controller.signal.aborted || this.db !== this.worker.db || this.generation !== this.worker.libraryAssetGeneration)
            throw new Error('Подготовка подсказок отменена: библиотека обновилась');
    }
    async ensure() {
        if (this.retryAfter && Date.now() < this.retryAfter) return false;
        if (!this.initialization) this.initialization = (async() => {
            this.check();
            const signature = String(this.worker.dbSearcher.dbConfig?.inpxHash || '');
            if (await this.db.tableExists({table: TABLE})) {
                await this.db.open({table: TABLE, cacheSize: 5});
                const marker = await this.db.select({table: TABLE, where: '@@id(0)'});
                if (marker[0]?.complete && marker[0].version === VERSION && marker[0].signature === signature) {
                    this.ready = true; return;
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
                if (await this.db.tableExists({table: TABLE})) await this.db.drop({table: TABLE});
                this.check();
                await this.db.create({table: TABLE, cacheSize: 5, index: {field: 'value', unique: false, type: 'string', depth: 1000000}});
                await this.db.insert({table: TABLE, rows: [{id: 0, value: '', complete: false, version: VERSION, signature}]});
                let rowId = 0, done = 0;
                for (const kind of ['author', 'series', 'title']) {
                    let offset = 0;
                    while (!this.controller.signal.aborted) {
                        this.check();
                        const names = await runtime.run(() => this.db.select({table: kind, offset, limit: 2000, map: 'row => ({id: row.id, name: row.name})'}), {kind: 'background'});
                        if (!names.length) break;
                        const rows = [];
                        for (const name of names) for (const word of new Set(words(name.name).map(root)))
                            rows.push({id: ++rowId, value: `${kind}:${word}`, entityId: name.id});
                        if (rows.length) await runtime.run(() => this.db.insert({table: TABLE, rows}), {kind: 'background'});
                        offset += names.length; done += names.length;
                        tasks.update(id, {phase: 'Индекс имён, серий и названий', done});
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }
                }
                this.check();
                await this.db.insert({table: TABLE, replace: true, rows: [{id: 0, value: '', complete: true, version: VERSION, signature}]});
                this.ready = true;
            }));
            tasks.finish(id);
        } catch (error) {tasks.finish(id, error); throw error;}
    }
    async ids(kind, query) {
        this.check();
        const tokens = [...new Set(words(query).map(root))], db = this.db;
        const result = await db.select({table: TABLE, rawResult: true, where: `
            let result = null;
            for (const token of ${db.esc(tokens)}) {
                const prefix = ${db.esc(kind + ':')} + token, found = new Set();
                for (const id of @dirtyIndexLR('value', prefix, prefix + ${db.esc(String.fromCodePoint(0xFFFFF))})) {
                    const row = @unsafeRow(id); found.add(row.entityId);
                }
                result = result === null ? found : new Set([...result].filter(id => found.has(id)));
                if (!result.size) break;
            }
            return Array.from(result || []);
        `});
        this.check(); return result[0].rawResult;
    }
    async close() {this.controller.abort(); if (this.building) await this.building.catch(() => {});}
}
module.exports = CatalogLookupIndex;
