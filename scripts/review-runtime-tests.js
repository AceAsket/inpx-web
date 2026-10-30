const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');
const {AsyncLocalStorage} = require('async_hooks');
const ZipReader = require('../server/core/ZipReader');
const runtime = require('../server/core/ReviewRuntime');
const {ReviewRuntime} = runtime;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const common = {name:'Reader', time:'2026-10-28', text:'Common review'};

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-review-runtime-'));
    try { await task(dir); } finally { await fs.remove(dir); }
}

async function archive(file, entries) {
    await fs.ensureDir(path.dirname(file));
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(file));
    for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
    zip.end(); await done;
}

function worker(config) {
    const value = Object.create(require('../server/core/WebWorker').prototype);
    value.config = config;
    value.resetLibraryAssetCaches();
    return value;
}

async function testReviewWarmupDoesNotAllocateIndexesByDefault() {
    for (const reviewWarmupEnabled of [undefined,false]) {
        const value = worker({libDir:'/large-library',reviewWarmupEnabled});
        value.getReviewArchiveState = async() => assert.fail('Startup must not enumerate review archives by default');
        value.dbSearcher = {ratingIndex:{load:async() => assert.fail('Startup must not scan the entire book database')}};
        await value.warmReviewIndexes();
    }
}

async function testRatingsStreamInASmallHeapAndKeepLegacyEncoding() {
    await temporary(async dir => {
        const file = path.join(dir,'books.json');
        const handle = await require('fs/promises').open(file,'w');
        try {
            await handle.write('[');
            const padding = 'x'.repeat(128 * 1024);
            for (let i = 0; i < 600; i++) await handle.write((i ? ',' : '') + JSON.stringify({folder:'books.zip',file:`${i}.fb2`,sum:4,count:1,padding}));
            await handle.write(']');
        } finally {await handle.close();}
        const script = `const fs=require('fs-extra');
            (async()=>{let count=0;
            await require(process.argv[1]).ratingRows({archiveType:'zip',zip:{stream:async()=>fs.createReadStream(process.argv[2])}},()=>count++);
            if(count!==600)throw new Error('Incomplete stream');console.log(JSON.stringify({count,rss:process.memoryUsage().rss}));
            })().catch(e=>{console.error(e);process.exitCode=1});`;
        const execFile = require('util').promisify(require('child_process').execFile);
        const result = await execFile(process.execPath,['--max-old-space-size=64','-e',script,require.resolve('../server/core/LibraryReviews'),file],{timeout:60000});
        assert.strictEqual(JSON.parse(result.stdout).count,600,'A 75 MiB JSON array must work in a 64 MiB JS heap');
        assert((await fs.stat(file)).size > 75 * 1024 * 1024);
        const raw = require('iconv-lite').encode(JSON.stringify([{folder:'Книги.zip',file:'one.fb2',sum:4,count:1}]),'win1251');
        await fs.writeFile(file,raw);
        const rows = [];
        await require('../server/core/LibraryReviews').ratingRows({archiveType:'zip',zip:{stream:async() => fs.createReadStream(file)}},row => rows.push(row));
        assert.strictEqual(rows.length,1); assert.strictEqual(rows[0].folder,'Книги.zip');
        const reader = {archiveType:'7z',extractToFile:async(name,target) => {
            assert.strictEqual(name,'books.json'); await fs.writeFile(target,raw);
        },extractToBuf:() => assert.fail('7z ratings must use a temporary file instead of buffering stdout')};
        const temporaryDir = path.join(dir,'tmp');
        await require('../server/core/LibraryReviews').ratingRows(reader,() => {},temporaryDir);
        assert.deepStrictEqual(await fs.readdir(temporaryDir),[]);
    });
}

async function testReviewReadsShareBudgetWithWarmupAndRatings() {
    await temporary(async dir => {
        const dirs = ['first','second','third'].map(name => path.join(dir, name, 'books'));
        const ids = ['123','456','789'], count = 8;
        for (const libDir of dirs) {
            await fs.ensureDir(libDir);
            for (let i = 0; i < count; i++) await archive(path.join(libDir, 'reviews', `${100 + i}.zip`),
                Object.fromEntries(ids.map(id => [`collection.zip#${id}.fb2`, JSON.stringify([
                    common, {...common, text:`${id}/${i}`}, common,
                ])])));
            await archive(path.join(libDir, 'reviews', 'additional.zip'), {'books.json':JSON.stringify([
                {folder:'collection.zip', file:'123.fb2', sum:9, count:2},
            ])});
        }
        const value = worker({reviewWarmupEnabled:true,libDir:dirs[0], librarySources:dirs.map(libDir => ({libDir}))});
        const original = {open:ZipReader.prototype.open, close:ZipReader.prototype.close, cpu:os.availableParallelism};
        let active = 0, peak = 0, opened = 0, closed = 0;
        const ratingsReads = [];
        ZipReader.prototype.open = async function(file, entries) {
            this.reviewTestOpen = true;
            peak = Math.max(peak, ++active); opened++;
            if (path.basename(file) === 'additional.zip') ratingsReads.push(file);
            await pause(3);
            return original.open.call(this, file, entries);
        };
        ZipReader.prototype.close = async function() {
            try { return await original.close.call(this); }
            finally { if (this.reviewTestOpen) {this.reviewTestOpen = false; active--; closed++;} }
        };
        try {
            os.availableParallelism = () => 64;
            const warming = value.warmReviewIndexes();
            const books = ids.map(file => ({folder:'collection.zip', file, ext:'fb2', sourceLibDir:dirs[0]}));
            const results = await Promise.all([warming, ...books.map(book => value.getBookReviews(book))]);
            for (let i = 0; i < ids.length; i++) assert.deepStrictEqual(results[i + 1], [common,
                ...Array.from({length:count}, (_, n) => ({...common, text:`${ids[i]}/${n}`})),
            ]);
            assert.strictEqual(peak, runtime.concurrency, 'Several books, sources and ratings must share the configured archive budget');
            assert.strictEqual(active, 0);
            assert.strictEqual(opened, closed, 'Every archive is closed before its slot is released');
            assert.deepStrictEqual(ratingsReads.sort(), dirs.map(libDir => path.join(libDir, 'reviews', 'additional.zip')).sort());
            const state = await value.getReviewArchiveState(dirs[0]);
            assert.deepStrictEqual(await value.getBookLibraryRating(books[0], state), {value:4.5, count:2});
            assert.strictEqual(ratingsReads.length, dirs.length, 'Reuse warmed ratings');
            assert.strictEqual(runtime.active, 0);
            assert.strictEqual(runtime.queue.length, 0);
        } finally {
            os.availableParallelism = original.cpu;
            ZipReader.prototype.open = original.open;
            ZipReader.prototype.close = original.close;
        }
    });
}

async function testBoundedReviewIndexKeepsAllMatchesWithLazyArchiveFallback() {
    await temporary(async dir => {
        await fs.ensureDir(dir);
        for (let i = 0; i < 5; i++) await archive(path.join(dir,'reviews',`${i}.zip`),{
            'collection.zip#1.fb2':JSON.stringify([{...common,text:'First ' + i}]),
            'collection.zip#2.fb2':JSON.stringify([{...common,text:'Second ' + i}]),
            'collection.7z#3.fb2':JSON.stringify([{...common,text:'Third ' + i}]),
        });
        const value = worker({libDir:dir,reviewIndexMaxEntries:2});
        const state = await value.getReviewArchiveState(dir);
        const index = await value.ensureReviewIndex(dir,state);
        assert.strictEqual([...index.values()].reduce((total,rows) => total + rows.length,0),2);
        assert.strictEqual(index.fallbackArchives.length,5);
        for (let id = 1; id <= 3; id++) {
            const result = await value.getBookReviews({folder:'collection.zip',file:String(id),ext:'fb2'},state);
            const prefix = ['First','Second','Third'][id - 1];
            assert.deepStrictEqual(result.map(row => row.text),Array.from({length:5},(_,i) => prefix + ' ' + i));
        }
        assert.strictEqual([...index.values()].reduce((total,rows) => total + rows.length,0),2,'Reading fallback books does not grow the index');
    });
}

async function testMalformedReviewsDoNotBreakBookInformation() {
    await temporary(async dir => {
        const config = {libDir:path.join(dir, 'books'), bookDir:path.join(dir, 'cache'), branch:'test'};
        await fs.ensureDir(config.bookDir);
        const before = {...common, text:'Before'}, after = {...common, text:'After'}, last = {...common, text:'Last'};
        const entry = 'collection.zip#123.fb2';
        await archive(path.join(config.libDir, 'reviews', '100.zip'), {[entry]:JSON.stringify([
            before, {name:{toString:'invalid'}, text:'bad name'}, {time:{toString:null}, text:'bad time'},
            {text:{toString:false}}, null, 'invalid row', [], after, before,
        ])});
        await archive(path.join(config.libDir, 'reviews', '101.zip'), {[entry]:'not JSON'});
        await archive(path.join(config.libDir, 'reviews', '102.zip'), {[entry]:JSON.stringify([last, after])});
        const book = {id:1, _uid:'fixture', folder:'collection.zip', file:'123', ext:'fb2', sourceLibDir:config.libDir};
        const value = worker(config);
        value.checkMyState = () => {};
        value.db = {esc:JSON.stringify, select:async() => [book]};
        value.getBookLink = async() => ({link:'/book/fixture', downFileName:'fixture.fb2'});
        value.readingListStore = {getMetadataOverrides:async() => ({})};
        value.fb2Helper = {getDescAndCover:async() => {
            const fb2 = new (require('../server/core/fb2/Fb2Parser'))();
            fb2.fromString('<FictionBook><body><section><p>Fixture text</p></section></body></FictionBook>');
            return {fb2};
        }};
        const result = (await value.getBookInfo('fixture')).bookInfo;
        assert.deepStrictEqual(result.reviews, [before, after, last]);
        assert.strictEqual(result.book._uid, 'fixture');
        assert.deepStrictEqual((await fs.readJson(path.join(config.bookDir, 'fixture.i.json'))).reviews, result.reviews);
        assert.strictEqual(runtime.active, 0);
    });
}

async function testReviewWarmupIsBackgroundAndIsolatesSourceFailures() {
    const value = worker({reviewWarmupEnabled:true,libDir:'/broken', librarySources:[
        {libDir:'/broken'}, {libDir:'/healthy'}, {libDir:'/disabled', enabled:false},
    ]});
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const state = {archives:[]}, requested = [];
    let indexes = 0, ratings = 0;
    value.getReviewArchiveState = async dir => {
        requested.push(dir);
        if (dir === '/broken') throw new Error('fixture source unavailable');
        return state;
    };
    value.createReviewIndex = async() => {indexes++; await gate; return new Map();};
    value.readLibraryRatings = async() => {ratings++; return new Map();};
    let ready = false;
    const warming = value.warmReviewIndexes().then(() => {ready = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(ready, false, 'Starting warmup must return while the index is still being built');
    const foreground = value.ensureReviewIndex('/healthy', state);
    release(); await Promise.all([warming, foreground]);
    assert.strictEqual(indexes, 1, 'The foreground request must reuse the startup index');
    assert.strictEqual(ratings, 1);
    assert.deepStrictEqual(requested.sort(), ['/broken','/healthy']);
}

async function testReviewPoolDoesNotWaitForImageDecoders() {
    const images = require('../server/core/ImageRuntime');
    let release, timer;
    const gate = new Promise(resolve => {release = resolve;});
    const busy = Array.from({length:images.concurrency}, () => images.run(() => gate));
    try {
        assert.strictEqual(images.active, images.concurrency);
        const result = await Promise.race([
            runtime.run(() => 'review completed'),
            new Promise(resolve => {timer = setTimeout(() => resolve('blocked by images'), 1000);}),
        ]);
        assert.strictEqual(result, 'review completed');
    } finally {clearTimeout(timer); release(); await Promise.all(busy);}
}

async function testReviewQueuePreservesCallerContext() {
    const pool = new ReviewRuntime(1), context = new AsyncLocalStorage();
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const first = context.run('first request', () => pool.run(async() => {await gate; return context.getStore();}));
    const second = context.run('second request', () => pool.run(() => context.getStore()));
    release();
    assert.deepStrictEqual(await Promise.all([first, second]), ['first request','second request']);
    assert.strictEqual(pool.active, 0);
    assert.strictEqual(pool.queue.length, 0);
}

async function testReviewMapWaitsForReadersAndRecoversAfterFailure() {
    const pool = new ReviewRuntime(2);
    let fail, release;
    const first = new Promise((resolve, reject) => {fail = reject;});
    const second = new Promise(resolve => {release = resolve;});
    let settled = false, started = 0;
    const error = new Error('fixture archive failure');
    const pending = pool.map([0,1,2,3], index => {started++; return index === 0 ? first : second;})
        .then(() => assert.fail('Expected archive failure'), reason => {settled = true; return reason;});
    fail(error); await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'Finish the other active reader before rejecting');
    release(); assert.strictEqual(await pending, error);
    assert.strictEqual(started, 2, 'Stop scheduling this request after a failure');
    assert.strictEqual(pool.active, 0);
    assert.strictEqual(await pool.run(() => 'next request'), 'next request');
    assert.deepStrictEqual(await pool.map([], () => assert.fail('Empty input')), []);
}

module.exports = [testBoundedReviewIndexKeepsAllMatchesWithLazyArchiveFallback,testRatingsStreamInASmallHeapAndKeepLegacyEncoding,
    testReviewWarmupDoesNotAllocateIndexesByDefault,
    testReviewReadsShareBudgetWithWarmupAndRatings, testMalformedReviewsDoNotBreakBookInformation,
    testReviewWarmupIsBackgroundAndIsolatesSourceFailures, testReviewPoolDoesNotWaitForImageDecoders,
    testReviewQueuePreservesCallerContext, testReviewMapWaitsForReadersAndRecoversAfterFailure];
