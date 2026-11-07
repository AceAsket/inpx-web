const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {MemoryCache} = require('../server/core/MemoryCache');
const {DatabaseCache} = require('../server/core/DatabaseCache');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(work) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-memory-'));
    try {await work(dir);} finally {await fs.remove(dir);}
}

async function testMemoryCachesEnforceBytesTtlAndReleaseOnClose() {
    const cache = new MemoryCache({bytes:3000, entries:10, ttl:30});
    try {
        cache.set('one', new Uint32Array(250)); cache.set('two', new Uint32Array(250));
        assert.equal(cache.size, 2); cache.get('one'); cache.set('three', new Uint32Array(250));
        assert(!cache.has('two')); assert(cache.has('one')); assert(cache.bytes <= 3000);
        cache.set('oversized', new Uint32Array(2000)); assert(!cache.has('oversized'));
        await pause(120); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
        cache.set('again', 'data'); cache.close(); assert.equal(cache.bytes, 0); assert.equal(cache.size, 0);
        assert.throws(() => new MemoryCache({bytes:NaN}));
    } finally {cache.close();}
}

async function populate(db) {
    for (const table of ['book', 'author']) {
        await db.create({table, cacheSize:500});
        for (let offset = 0; offset < 1200; offset += 200)
            await db.insert({table, rows:Array.from({length:200}, (_, i) => ({id:offset + i, data:`${offset + i}:` + 'я'.repeat(6000)}))});
        await db.close({table}); await db.open({table, cacheSize:500});
    }
}

async function testDatabaseCacheIsGlobalIdleSafeAndKeepsUnsavedRows() {
    await temporary(async dir => {
        const db = new (require('jembadb').JembaDb)();
        let cache;
        try {
            await db.lock({dbPath:dir, create:true}); await populate(db);
            cache = new DatabaseCache(db, {budgetBytes:8 * 1024 ** 2, idleMs:30}); cache.attach();
            for (const table of ['book', 'author']) {
                assert.equal((await db.select({table, map:'r => r.id'})).length, 1200);
                cache.trim();
                const stats = cache.snapshot();
                assert(stats.estimatedBytes <= stats.budgetBytes + stats.pinnedBytes, JSON.stringify(stats));
            }
            assert(cache.snapshot().evictions > 0);
            cache.budgetBytes = cache.snapshot().pinnedBytes + 8 * 1024 ** 2;
            await db.select({table:'author', where:'@@id(0)'});
            await db.insert({table:'book', rows:[{id:9999, data:'not yet flushed'}]});
            await pause(120);
            const read = () => db.select({table:'book', where:'@@id(9999)'});
            assert.equal((await read())[0].data, 'not yet flushed');
            assert(cache.snapshot().idleEvictions > 0);
            const results = await Promise.all(Array.from({length:6}, (_, i) => db.select({table:'book', where:`@@id(${i * 200})`})));
            assert.deepEqual(results.map(rows => rows[0].id), [0, 200, 400, 600, 800, 1000]);
            await db.closeAll(); cache.trim(); assert.equal(cache.snapshot().blocks, 0);
            await db.openAll(); cache.attach(); assert.equal((await read())[0].data, 'not yet flushed');
        } finally {clearInterval(cache?.timer); await db.unlock();}
    });
}

async function testBoundedDatabaseWorkerSupportsProtocolAndReopen() {
    await temporary(async dir => {
        const db = new (require('../server/core/DatabaseThread'))({dbCacheBudgetMb:4});
        try {
            await db.lock({dbPath:dir, create:true}); await db.create({table:'book'});
            await db.insert({table:'book', rows:[{id:1, title:'Книга'}]});
            await db.closeAll(); await db.openAll();
            assert.equal((await db.select({table:'book'}))[0].title, 'Книга');
            const stats = await db.cacheStats(); assert.equal(stats.budgetBytes, 4 * 1024 ** 2);
            assert(stats.blocks > 0); assert(stats.workerHeapUsed > 0);
            await db.closeAll(); assert.equal((await db.cacheStats()).blocks, 0);
        } finally {await db.unlock();}
        assert.equal(db.listeners.size, 0); assert.equal(db.worker, null);
    });
}

async function testDatabaseWorkerFailureFailsClosedAndDoesNotLeakPendingRequests() {
    await temporary(async dir => {
        const db=new (require('../server/core/DatabaseThread'))({dbCacheBudgetMb:4});
        const unavailable={code:'INPX_DATABASE_UNAVAILABLE'};
        try {
            for(let i=0;i<5;i++)await assert.rejects(db.cacheStats(),unavailable);
            assert.equal(db.listeners.size,0,'Closed-worker requests must not leave unresolved listeners');
            await db.lock({dbPath:dir,create:true,softLock:true});await db.create({table:'book'});
            await db.insert({table:'book',rows:[{id:1,title:'persisted fixture'}]});
            await db.closeAll();await db.openAll();
            await assert.rejects(db.select({table:'book',where:()=>true}),error=>error.name==='DataCloneError');
            assert.equal(db.listeners.size,0,'postMessage serialization errors must also release their listener');
            assert.equal(db.available,true,'A malformed request must not kill a healthy DB worker');
            const stats=await db.cacheStats();assert(stats.workerHeapLimit>=stats.workerHeapUsed);
            const oldWorker=db.worker;
            const pending=Array.from({length:3},()=>db.select({table:'book',rawResult:true,
                where:'return new Promise(resolve => setTimeout(() => resolve([1]),1000));'}));
            const rejected=pending.map(request=>assert.rejects(request,error=>error.code==='INPX_DATABASE_UNAVAILABLE'&&error.causeCode==='ERR_WORKER_OUT_OF_MEMORY'));
            oldWorker.emit('error',Object.assign(new Error('fixture heap limit'),{code:'ERR_WORKER_OUT_OF_MEMORY'}));
            await Promise.all(rejected);await db.termination;
            assert.equal(db.worker,null);assert.equal(db.available,false);assert.equal(db.listeners.size,0);
            assert.equal(db.failure.code,'ERR_WORKER_OUT_OF_MEMORY','A later exit event must not overwrite the original failure');
            for(let i=0;i<5;i++)await assert.rejects(db.select({table:'book',where:'@@id(1)'}),unavailable);
            assert.equal(db.listeners.size,0);assert.equal(db.worker,null,'Queries must not silently restart or replay writes');
            await db.unlock();await db.lock({dbPath:dir,softLock:true});await db.openAll();
            assert.equal(db.available,true);assert.equal(db.failure,null);
            assert.equal((await db.select({table:'book',where:'@@id(1)'}))[0].title,'persisted fixture','Explicit reopening preserves committed data');
            await db.worker.terminate();
            assert.equal(db.available,false);assert.equal(db.failure.code,'INPX_DATABASE_WORKER_EXIT');
            assert.equal(db.listeners.size,0);
        } finally {await db.unlock();}
    });
}

async function testIndexReadinessRejectsUnavailableDatabaseWorker() {
    const worker=Object.create(require('../server/core/WebWorker').prototype);
    worker.myState='normal';worker.wState={get:()=>({state:'normal'})};
    worker.config={version:'fixture',librarySources:[]};worker.dbSearcher={};
    worker.db={available:false,failure:{code:'ERR_WORKER_OUT_OF_MEMORY'}};
    worker.dbConfig=async()=>assert.fail('Readiness must not query a terminated database worker');
    const failed=await worker.getIndexStatus();
    assert.equal(failed.ready,false);assert.equal(failed.dbLoaded,false);assert.equal(failed.searchReady,false);
    assert.equal(failed.state,'database_unavailable');assert.match(failed.error,/Каталог недоступен/);
    assert.equal(failed.serverMessage,failed.error);
    worker.db.available=true;worker.dbConfig=async()=>({stats:{bookCount:1}});
    const available=await worker.getIndexStatus();
    assert.equal(available.ready,true);assert.equal(available.dbLoaded,true);assert.equal(available.searchReady,true);
    worker.db=null;
    const closed=await worker.getIndexStatus();
    assert.equal(closed.ready,false);assert.equal(closed.dbLoaded,false);assert.equal(closed.searchReady,false);
}

async function testReviewIndexesReleaseOnlyAfterLastConsumer() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const original = global.setTimeout;
    const timers = [];
    global.setTimeout = (fn, delay) => {assert.equal(delay, 30000); const timer = original(fn, 5); timers.push(timer); return timer;};
    try {
        const state = {indexPromise:Promise.resolve(new Map()), ratingsPromise:Promise.resolve(new Map())};
        let release; const gate = new Promise(resolve => {release = resolve;});
        const first = worker.withReviewAssets(state, () => gate);
        await worker.withReviewAssets(state, async() => {});
        assert.equal(timers.length, 0, 'A concurrent reader still owns the indexes');
        release(); await first;
        await new Promise(resolve => original(resolve, 20));
        assert.equal(state.indexPromise, null); assert.equal(state.ratingsPromise, null);
    } finally {global.setTimeout = original; for (const timer of timers) clearTimeout(timer);}
}

async function testLazyDetailsRejectLateResponsesAndRetry() {
    const source = await fs.readFile(path.join(__dirname, '../client/components/Search/BookInfoDialog/BookInfoDialog.vue'), 'utf8');
    const methods = source.slice(source.indexOf('    invalidateExtras()'), source.indexOf('    extractContents('));
    const Details = new Function(`return class {${methods}}`)();
    const value = new Details(); Object.assign(value, {extrasActive:true, dialogVisible:true, extrasGeneration:0, bookUid:'old'});
    const replies = []; let count = 0;
    value.api = {getBookReviews:() => {count++; return new Promise(done => {replies.push(done);});}};
    value.invalidateExtras(); const old = value.loadReviews(); await value.loadReviews(); assert.equal(count, 1);
    value.invalidateExtras(); value.bookUid = 'new'; const current = value.loadReviews();
    replies[1]({reviews:[{text:'new'}]}); await current; assert.equal(value.reviews[0].text, 'new');
    // The first request is deliberately completed after closing and reopening.
    value.invalidateExtras(); value.api.getBookReviews = async() => {throw new Error('offline');};
    await value.loadReviews(); assert.match(value.reviewsError, /offline/); assert(!value.reviewsLoaded);
    value.api.getBookReviews = async() => ({reviews:[]}); await value.loadReviews(); assert(value.reviewsLoaded);
    replies[0]({reviews:[{text:'obsolete'}]}); await old;
    assert.deepEqual(value.reviews, []);
}

async function testAuthorArchiveBuildIsSharedAndRejectsOldLibraries() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    worker.resetLibraryAssetCaches();
    const releases = []; let builds = 0;
    worker.buildAuthorInfoArchives = () => {builds++; return new Promise(resolve => releases.push(resolve));};
    const old = Promise.allSettled([worker.ensureAuthorInfoArchives(), worker.ensureAuthorInfoArchives()]);
    assert.equal(builds, 1); assert.equal(worker.authorToArchive, null, 'An incomplete index must not be published');
    worker.resetLibraryAssetCaches(); const current = worker.ensureAuthorInfoArchives(); assert.equal(builds, 2);
    releases[1]({authorToArchive:new Map([['current', []]]), authorInfoArchives:[], authorPictureArchives:[]}); await current;
    releases[0]({authorToArchive:new Map([['old', []]])});
    assert((await old).every(result => result.status === 'rejected' && result.reason.code === 'INPX_LIBRARY_CHANGED'));
    assert(worker.authorToArchive.has('current')); assert(!worker.authorToArchive.has('old'));
    worker.authorInfoCache.close();
}

async function testMemoryBudgetEnvironmentOverridesPreviouslySavedValues() {
    const keys = ['INPX_DB_CACHE_BUDGET_MB', 'INPX_QUERY_CACHE_MEM_MB'];
    const previous = keys.map(key => process.env[key]);
    try {
        const manager = Object.create(require('../server/config').prototype);
        manager.inited = true; manager._config = {dbCacheBudgetMb:64, queryCacheMemMb:32};
        process.env[keys[0]] = '12'; process.env[keys[1]] = '20';
        assert.equal(manager.config.dbCacheBudgetMb, 12); assert.equal(manager.config.queryCacheMemMb, 20);
        process.env[keys[0]] = ''; delete process.env[keys[1]];
        assert.equal(manager.config.dbCacheBudgetMb, 64); assert.equal(manager.config.queryCacheMemMb, 32);
    } finally {for (let i = 0; i < keys.length; i++) {if (previous[i] === undefined) delete process.env[keys[i]]; else process.env[keys[i]] = previous[i];}}
}

module.exports = [testMemoryBudgetEnvironmentOverridesPreviouslySavedValues, testAuthorArchiveBuildIsSharedAndRejectsOldLibraries,
    testMemoryCachesEnforceBytesTtlAndReleaseOnClose, testDatabaseCacheIsGlobalIdleSafeAndKeepsUnsavedRows,
    testBoundedDatabaseWorkerSupportsProtocolAndReopen, testDatabaseWorkerFailureFailsClosedAndDoesNotLeakPendingRequests,
    testIndexReadinessRejectsUnavailableDatabaseWorker,
    testReviewIndexesReleaseOnlyAfterLastConsumer, testLazyDetailsRejectLateResponsesAndRetry];
