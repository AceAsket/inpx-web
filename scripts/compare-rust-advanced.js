const assert = require('node:assert/strict');
const {dirname,resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const {isDeepStrictEqual} = require('node:util');
const base = require('../server/config/base');

const cases = [
    ['combined', {author:'Толстой',title:'война',lang:'ru',ext:'fb2|epub',del:'0',hideCopies:true}],
    ['date-and-size', {title:'ёлка',date:'1990-01-01,2030-12-31',size:'0..4000000',librate:'0,1,2,3,4,5',del:'0'}],
    ['contains-and-format', {title:'*пикник на обочине',ext:'=fb2',del:'0'}],
    ['two-words-and-formats', {title:'война мир',lang:'ru',ext:'fb2,epub',del:'0',offset:7}],
    ['regexp-compatibility', {title:'~^пикник на обочине',del:'0'},false],
];

const median = values => Math.round(values.toSorted((a,b) => a-b)[values.length>>1]*10)/10;

async function main(binary,directory) {
    if (!binary || !directory) throw new Error('Usage: node scripts/compare-rust-advanced.js <catalog-binary> <db-dir>');
    process.env.INPX_RUST_CATALOG_BINARY = resolve(binary);
    const dir = resolve(directory);
    const config = {...base,dataDir:dirname(dir),queryCacheEnabled:false,loggingEnabled:false};
    await new (require('../server/core/AppLogger'))().init(config);
    const WebWorker = require('../server/core/WebWorker');
    const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config},dir);
    const store = db.bookStore;
    try {
        assert(db.bookStoreAdvanced,'Advanced book queries are unavailable');
        const query = store.run.bind(store);
        let nativeSearches = 0, nativeFacets = 0;
        store.run = (work,fallback) => query(process => work({query:async message => {
            const answer = await process.query(message);
            if (message.op === 'search') nativeSearches++;
            if (message.op === 'facetBooks') nativeFacets++;
            return answer;
        }}),fallback);
        await db.openLegacyBooks();
        for (const [label,filter,migrated = true] of cases) {
            const times = [[],[]];
            let found;
            for (let round=0;round<3;round++) {
                const pair = [];
                for (const active of round%2 ? [1,0] : [0,1]) {
                    db.bookStoreAdvanced = !!active;
                    const before = nativeSearches, facets = nativeFacets, start = performance.now();
                    pair[active] = await searcher.bookSearch({...filter,limit:20});
                    times[active].push(performance.now()-start);
                    assert.equal(nativeSearches - before,Number(active && migrated),`${label} did not take the expected path (${store.lastError || 'no Rust error'})`);
                    if (active && migrated) assert(nativeFacets > facets,`No Rust facet filter for ${label}`);
                }
                assert(isDeepStrictEqual(pair[1],pair[0]),`Results differ for ${label} (${pair[0].totalFound}/${pair[1].totalFound})`);
                found = pair[0].totalFound;
                assert(found > 0,`No matches for ${label}`);
            }
            console.log(JSON.stringify({case:label,found,beforeMs:median(times[0]),afterMs:median(times[1]),samples:times}));
        }
    } finally {
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

main(...process.argv.slice(2)).catch(error => {console.error(error);process.exitCode=1;});
