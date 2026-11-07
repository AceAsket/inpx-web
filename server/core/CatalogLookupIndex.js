const {words, root} = require('../../shared/CatalogSearch');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const crypto = require('crypto');
const TABLE = 'catalog_lookup', VERSION = 2;
const BATCH_SIZE = 1000, IDLE_MS = 30000;
const FAST_LIMITS = {names:32, wordRows:16, wordBooks:64, books:128, perName:4};
const SUGGEST_BOOK_FIELDS = ['id','_uid','_recordHash','title','author','series','serno','folder','file','ext','size','inpxSize',
    'date','genre','lang','del','librate','libid','insno','sourcelib','sourceId','sourceName','sourceLibDir','sourceType','unavailable'];

// Jemba 5.1.7's range reducer first materializes EVERY matching ID; select.limit
// is applied even later, after loading rows. Seek its existing sorted runs and
// merge only a bounded prefix instead. This adapter is read-only and guarded:
// an unsupported index returns no candidates, never a full-table fallback.
function boundedRange(index, from, to, limit) {
    if (!index?.unique || !Array.isArray(index.sorted) || index.sorted.length>64 || !index.sorted.every(Array.isArray)
        || typeof index.hash?.get !== 'function'
        || typeof index.cmp !== 'function' || typeof index.prepareValue !== 'function')
        return {ids:[],limited:true};
    from=index.prepareValue(from); to=index.prepareValue(to);
    const runs=index.sorted.map(values=>{
        let left=0,right=values.length;
        while(left<right) {const middle=(left+right)>>>1;if(index.cmp(values[middle],from)<0)left=middle+1;else right=middle;}
        return {values,at:left};
    });
    const valid=run=>run.at<run.values.length && index.cmp(run.values[run.at],to)<=0;
    const ids=new Set();let inspected=0;
    while(ids.size<limit && inspected++<limit*4+128) {
        let next;
        for(const run of runs)if(valid(run) && (!next || index.cmp(run.values[run.at],next.values[next.at])<0))next=run;
        if(!next)break;
        const id=index.hash.get(next.values[next.at++]);
        if(id!==undefined)ids.add(id);
    }
    return {ids:[...ids],limited:runs.some(valid)};
}

function sampleIds(ids, limit) {
    if (!ids?.length || !limit) return [];
    const size=Math.min(limit,ids.length), result=[];
    // Diverse samples avoid spending the entire budget on one early edition or
    // one prolific author, without copying/scanning a large posting list.
    for(let i=0;i<size;i++)result.push(ids[Math.floor(i*(ids.length-1)/Math.max(1,size-1))]);
    return result;
}

// A separate inverted index maps words to author/series/title IDs, not to every
// book by a prolific author. Built incrementally in bounded batches; a marker
// makes interrupted builds distinguishable from complete ones after a restart.
class CatalogLookupIndex {
    static get fastLimits() {return FAST_LIMITS;}

    static async names(db, kind, query, exactNames = null) {
        const keys=exactNames || [...new Set([query.toLowerCase(),require('../../shared/CatalogSearch').normalize(query)])];
        const result=await db.select({table:kind,rawResult:true,where:`
            const range=${boundedRange.toString()}, sample=${sampleIds.toString()};
            const ids=new Set(), index=__tr._index?.get('value');let limited=false;
            for(const key of ${db.esc(keys)}) {
                const exact=range(index,key,key,${FAST_LIMITS.names});
                for(const id of exact.ids)ids.add(id);
                limited ||= exact.limited;
                ${exactNames ? '' : `const prefix=range(index,key,key+${db.esc(String.fromCodePoint(0xFFFFF))},${FAST_LIMITS.names});
                for(const id of prefix.ids)if(ids.size<${FAST_LIMITS.names})ids.add(id);else limited=true;
                limited ||= prefix.limited;`}
            }
            const rows=[];
            for(const id of ids) {
                const row=@unsafeRow(id);
                if(row && row.value!=='?')rows.push({id:row.id,name:row.name,count:row.bookCount,
                    bookIds:sample(row.bookIds,${FAST_LIMITS.perName}),complete:row.bookIds.length<=${FAST_LIMITS.perName}});
                if(rows.length>=${FAST_LIMITS.names})break;
            }
            return {rows,limited};
        `});
        return result[0].rawResult;
    }

    static async wordCandidates(db, kind, token, {typo = false} = {}) {
        if (!await db.tableExists({table:'word'})) return {rows:[],limited:false};
        const prefix=kind+':'+(typo ? token.slice(0,2):token);
        const result=await db.select({table:'word',rawResult:true,where:`
            const range=${boundedRange.toString()}, sample=${sampleIds.toString()};
            const index=__tr._index?.get('value'), ids=new Set();let limited=false;
            const exact=range(index,${db.esc(prefix)},${db.esc(prefix)},${FAST_LIMITS.wordRows});
            for(const id of exact.ids)ids.add(id);
            const prefix=range(index,${db.esc(prefix)},${db.esc(prefix+String.fromCodePoint(0xFFFFF))},${FAST_LIMITS.wordRows});
            for(const id of prefix.ids)if(ids.size<${FAST_LIMITS.wordRows})ids.add(id);else limited=true;
            limited ||= exact.limited || prefix.limited;
            const rows=[];
            for(const id of ids) {
                const row=@unsafeRow(id);
                if(!row || !row.value.startsWith(${db.esc(kind+':')}))continue;
                rows.push({word:row.value.slice(${kind.length+1}),bookIds:sample(row.bookIds,${FAST_LIMITS.wordBooks/FAST_LIMITS.wordRows}),
                    complete:row.bookIds.length<=${FAST_LIMITS.wordBooks/FAST_LIMITS.wordRows}});
                limited ||= row.bookIds.length>${FAST_LIMITS.wordBooks/FAST_LIMITS.wordRows};
            }
            return {rows,limited};
        `});
        return result[0].rawResult;
    }

    static async books(db, ids) {
        if (!ids.length) return [];
        const result=await db.select({table:'book',rawResult:true,where:`
            const rows=[];
            const fields=${db.esc(SUGGEST_BOOK_FIELDS)};
            for(const id of ${db.esc(ids.slice(0,FAST_LIMITS.books))}) {
                const row=@unsafeRow(id);
                if(row) {const book={};for(const field of fields)if(row[field]!==undefined)book[field]=row[field];rows.push(book);}
            }
            return rows;
        `});
        return result[0].rawResult;
    }

    static async candidates(db, kind, query, scoped) {
        const search=require('../../shared/CatalogSearch');
        const direct=await this.names(db,kind,query);
        direct.rows=direct.rows.filter(row=>search.match(row.name,query));
        // Full-name prefixes outrank matches later in a name. Six useful direct
        // answers need no word posting reads in the common unfiltered case.
        if (!scoped && direct.rows.filter(row=>row.count>0).length>=6) return direct;
        const tokens=[...new Set(search.words(query).map(search.root))].sort((a,b)=>b.length-a.length);
        const words=await this.wordCandidates(db,kind,tokens[0]);
        const books=await this.books(db,[...new Set(words.rows.flatMap(row=>row.bookIds))]);
        const names=new Set();
        for(const book of books) {
            const values=kind==='author' ? [...String(book.author || '').split(','),book.author]:[book[kind]];
            for(const value of values)if(value && search.match(value,query))names.add(value.toLowerCase());
        }
        const extra=names.size ? await this.names(db,kind,query,[...names].slice(0,FAST_LIMITS.names)):{rows:[],limited:false};
        return {rows:[...new Map([...direct.rows,...extra.rows].map(row=>[row.id,row])).values()],
            books,limited:direct.limited || words.limited || extra.limited || names.size>FAST_LIMITS.names};
    }

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
