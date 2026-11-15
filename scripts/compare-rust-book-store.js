const assert = require('node:assert/strict');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const base = require('../server/config/base');

const fields = ['id','_uid','_recordHash'];
const searches = [
    ['title', {title:'ёлка'}],
    ['title-del', {title:'ёлка',del:'0'}],
    ['title-two-words', {title:'война мир'}],
    ['author', {author:'Стругацкий Аркадий'}],
];

const median = values => Math.round(values.toSorted((a,b) => a-b)[values.length>>1]*10)/10;

async function runCatalog(WebWorker, dir, expectedStore) {
    const config = {...base,dataDir:path.dirname(dir),queryCacheEnabled:false};
    let start = performance.now();
    const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config},dir);
    const openMs = performance.now()-start;
    assert.equal(!!db.bookStore,expectedStore);
    const native = [];
    if (db.bookStore) {
        const run = db.bookStore.run.bind(db.bookStore);
        db.bookStore.run = (work,fallback) => run(process => work({query:async query => {
            const value = await process.query(query);
            native.push(query.op);
            return value;
        }}),fallback);
    }
    const results = new Map();
    const timings = new Map();
    const record = async (label,work,operation) => {
        const before = native.length;
        start = performance.now();
        const result = await work();
        timings.set(label,performance.now()-start);
        results.set(label,result);
        if (expectedStore) assert(native.slice(before).includes(operation), `Rust operation ${operation} did not run for ${label}`);
    };
    try {
        for (const [label, query] of searches) await record(label,() => searcher.bookSearch({...query,limit:20}),'search');
        const books = results.get('title').found;
        assert(books.length > 0);
        await record('row-by-uid',() => WebWorker.prototype.getBookRecordByUid.call({db},books[0]._uid),'uids');
        await record('cards-by-id',() => db.booksByIds(books.map(row => row.id),fields),'rows');
        if (expectedStore) assert.equal(db.legacyBookOpen,undefined,'Native requests unexpectedly opened the JembaDB book table');
        return {openMs,results,timings};
    } finally {
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

async function verifyStore(WebWorker, dir) {
    const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config:{...base,dataDir:path.dirname(dir),queryCacheEnabled:false}},dir);
    try {
        assert(db.bookStore,'Book store missing');
        let count = 0;
        for (;;) {
            const [{rawResult:rows}] = await db.select({table:'book',rawResult:true,where:`
                let cursor=@getItem('book-store-test');
                if (!cursor) {cursor=@all(); @setItem('book-store-test',cursor);}
                const result=[];
                while (result.length<4096) {
                    const next=cursor.next();
                    if (next.done) break;
                    const r=@unsafeRow(next.value);
                    result.push({id:r.id,_uid:r._uid,_recordHash:r._recordHash});
                }
                return result;
            `});
            if (!rows.length) break;
            const actual = await db.bookStore.run(process => process.query({op:'rows',ids:rows.map(row => row.id),fields}),
                () => assert.fail('Failed to read verified rows from Rust'));
            assert.deepEqual(actual,rows);
            count += rows.length;
        }
        console.log(JSON.stringify({stage:'verified-storage',count}));
    } finally {
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

async function compareReadPaths(WebWorker, dir) {
    const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config:{...base,dataDir:path.dirname(dir),queryCacheEnabled:false}},dir);
    const store = db.bookStore;
    try {
        assert(store,'Book store missing');
        const prefix = 'стругацкий аркадий';
        const authors = await db.select({table:'author',where:`@@indexLR('value',${db.esc(prefix)},${db.esc(prefix + String.fromCodePoint(0xfffff))})`});
        const author = authors.sort((left,right) => right.bookIds.length-left.bookIds.length)[0];
        assert(author?.bookIds.length,'The comparison author is absent');
        const uids = (await db.booksByIds(author.bookIds.slice(0,500),['_uid'])).map(row => row._uid);
        const select = db.select.bind(db), insert = db.insert.bind(db);
        // Exercise the hydration path on every round without saving its results to disk.
        db.select = query => query.table === 'author_book' ? Promise.resolve([]) : select(query);
        db.insert = query => query.table === 'author_book' ? Promise.resolve() : insert(query);
        await db.openLegacyBooks();
        for (const [label,records,work] of [['grouped-books',author.bookIds.length,() => searcher.restoreBooks('author',[author.id])],
            ['reading-list-lookup',uids.length,() => db.booksByUids(uids)]]) {
            const samples = [[],[]];
            for (let round=0;round<5;round++) {
                const order = round%2 ? [1,0] : [0,1];
                const results = [];
                for (const native of order) {
                    db.bookStore = native ? store : null;
                    const started = performance.now();
                    results[native] = await work();
                    samples[native].push(performance.now()-started);
                }
                assert.deepEqual(results[0],results[1]);
            }
            console.log(JSON.stringify({case:label,records,beforeMs:median(samples[0]),afterMs:median(samples[1]),samples}));
        }
    } finally {
        db.bookStore = store;
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

async function main(binary,before,after) {
    process.env.INPX_RUST_CATALOG_BINARY = path.resolve(binary);
    const original = path.resolve(before), candidate = path.resolve(after);
    await new (require('../server/core/AppLogger'))().init({...base,loggingEnabled:false});
    const WebWorker = require('../server/core/WebWorker');
    if (before === '--read-paths') {
        await compareReadPaths(WebWorker,candidate);
        return verifyStore(WebWorker,candidate);
    }
    const open = [[],[]], times = new Map();
    for (let round=0;round<3;round++) {
        const order = round % 2 ? [true,false] : [false,true];
        const results = [];
        for (const native of order) results[Number(native)] = await runCatalog(WebWorker,native ? candidate : original,native);
        assert.deepEqual(results[0].results,results[1].results);
        results.forEach(({openMs,timings},index) => {
            open[index].push(openMs);
            for (const [label,ms] of timings) {
                if (!times.has(label)) times.set(label,[[],[]]);
                times.get(label)[index].push(ms);
            }
        });
    }
    for (const [label,values] of [['open',open],...times]) {
        console.log(JSON.stringify({case:label,beforeMs:median(values[0]),afterMs:median(values[1]),samples:values}));
    }
    await verifyStore(WebWorker,candidate);
}

main(...process.argv.slice(2)).catch(error => {console.error(error);process.exitCode=1;});
