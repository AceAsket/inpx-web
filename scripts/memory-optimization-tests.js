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

module.exports = [testAuthorArchiveBuildIsSharedAndRejectsOldLibraries,
    testMemoryCachesEnforceBytesTtlAndReleaseOnClose, testDatabaseCacheIsGlobalIdleSafeAndKeepsUnsavedRows,
    testBoundedDatabaseWorkerSupportsProtocolAndReopen, testReviewIndexesReleaseOnlyAfterLastConsumer, testLazyDetailsRejectLateResponsesAndRetry];
