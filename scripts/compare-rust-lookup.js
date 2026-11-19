const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {readFile, stat} = require('node:fs/promises');
const {dirname, join, resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const base = require('../server/config/base');
const {buildIndexInWorker} = require('../server/core/IndexBuilder');
const {fileName} = require('../server/core/RustLookupIndex');
const Discovery = require('../server/core/CatalogDiscovery');
const DatabaseThread = require('../server/core/DatabaseThread');

function elapsed(start) {
    return Math.round((performance.now() - start) * 10) / 10;
}

async function build(index, destination, binary, reader, previous = null, options = {}) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
    if (reader) process.env.INPX_RUST_READER_BINARY = reader;
    else delete process.env.INPX_RUST_READER_BINARY;
    const config = {...base, dataDir:dirname(destination), inpxFilterFile:join(dirname(destination), 'inpx-filter.json'), ...options,
        rustCompatibilityTables:true,
        librarySources:[{id:'benchmark', name:'Benchmark', type:'inpx', enabled:true, inpxFile:index, libDir:dirname(index)}]};
    let phase, phaseStart, records = 0;
    let usedRustReader = false, nativeBookMaps = false, nativeBook = false, nativeIdentities = false, reusedUidIndex = false;
    const phasesMs = {}, nativeIndexes = [];
    let bookStoreMode, nativeUpdate = false;
    const started = performance.now();
    await buildIndexInWorker(config, destination, previous, progress => {
        if (progress.recsLoaded) records = progress.recsLoaded;
        if (progress.rustReader) usedRustReader = true;
        if (progress.nativeBookMaps) nativeBookMaps = true;
        if (progress.nativeBook) nativeBook = true;
        if (progress.rustBookWarning) console.error(progress.rustBookWarning);
        if (progress.nativeIndex) nativeIndexes.push(progress.nativeIndex);
        if (progress.rustTableWarning) console.error(progress.rustTableWarning);
        if (progress.rustIdentityWarning) console.error(progress.rustIdentityWarning);
        if (progress.rustStoreWarning) console.error(progress.rustStoreWarning);
        if (progress.rustUpdateWarning) console.error(progress.rustUpdateWarning);
        if (progress.nativeUpdate) nativeUpdate = true;
        if (progress.bookStoreMode) bookStoreMode = progress.bookStoreMode;
        if (progress.nativeIdentities) nativeIdentities = true;
        if (progress.reusedUidIndex) reusedUidIndex = true;
        if (progress.job && progress.job !== phase) {
            if (phase) phasesMs[phase] = (phasesMs[phase] || 0) + elapsed(phaseStart);
            phase = progress.job;
            phaseStart = performance.now();
            if (phase === 'rust lookup unavailable') console.error(progress.jobMessage);
        }
    });
    const wallMs = elapsed(started);
    const changes = previous ? await updateStats(destination) : undefined;
    if (previous) assert(changes.incremental, 'The benchmark must update an existing book table');
    const lookupBytes = binary ? (await stat(join(destination, fileName))).size : 0;
    assert.equal(usedRustReader, nativeUpdate || !!reader, 'The build must use the Rust INPX reader for the selected update mode');
    console.log(JSON.stringify({stage:previous ? 'update' : 'build', rust:!!binary, rustReader:usedRustReader,
        nativeBook, nativeBookMaps, nativeIndexes, nativeIdentities, reusedUidIndex, bookStoreMode, nativeUpdate, records, changes, wallMs, phasesMs, lookupBytes,
        peakNodeRssKiB:process.resourceUsage().maxRSS}));
}

async function updateStats(dbPath) {
    const db = new DatabaseThread(base);
    try {
        await db.lock({dbPath, softLock:true});
        await db.open({table:'config'});
        const [{value}] = await db.select({table:'config', where:"@@id('indexUpdate')"});
        const {incremental, recordsChanged, recordsRemoved} = value;
        return {incremental, recordsChanged, recordsRemoved};
    } finally {await db.unlock();}
}

function requests() {
    const search = (label, table, query) => ({label, run:({searcher}) => searcher.search(table, {...query, limit:15})});
    const books = (label, query) => ({label, run:({searcher}) => searcher.bookSearch({...query, limit:20})});
    const suggest = (label, options) => ({label, run:({discovery}) => discovery.suggest(options)});
    return [
        search('title-common', 'title', {title:'война', del:'0'}),
        search('title-multiword', 'title', {title:'война мир', del:'0'}),
        search('title-exact', 'title', {title:'=Мастер и Маргарита'}),
        search('title-broad', 'title', {title:'про'}),
        search('author-common', 'author', {author:'Стругацкий'}),
        search('author-multiword', 'author', {author:'Лев Ник'}),
        search('author-exact', 'author', {author:'=Толстой Лев Николаевич'}),
        search('author-no-result', 'author', {author:'ыыыыыыыыыыыы'}),
        books('books-paired', {author:'Толстой', title:'война', lang:'ru', del:'0', hideCopies:true}),
        books('books-yo', {title:'ёлка', del:'0'}),
        books('books-explicit', {title:'*пикник на обочине', del:'0'}),
        suggest('suggest-author', {query:'Стругац', kind:'author'}),
        suggest('suggest-name-accent', {query:'елка', kind:'title'}),
        suggest('suggest-title', {query:'Мастер', kind:'title'}),
        suggest('suggest-typo', {query:'толстйо', kind:'author'}),
        suggest('suggest-scoped', {query:'война', kind:'title', filters:{lang:'ru', ext:'fb2|epub'}}),
        suggest('suggest-mixed', {query:'фантастика'}),
    ];
}

async function referenceResults(WebWorker, config, dbPath) {
    const started = performance.now();
    const {db, searcher} = await WebWorker.prototype.openCatalogue.call({config}, dbPath);
    const openMs = elapsed(started);
    const discovery = new Discovery({db, dbSearcher:searcher, libraryAssetGeneration:1});
    await searcher.rustLookup.close();
    searcher.rustLookup = null;
    try {
        const results = new Map();
        for (const request of requests()) results.set(request.label, await request.run({searcher, discovery}));
        console.log(JSON.stringify({stage:'reference-open', openMs}));
        return results;
    } finally {
        discovery.close();
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

async function compare(binary, dbPath, referencePath) {
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    const config = {...base, dataDir:dirname(dbPath), queryCacheEnabled:false};
    await new (require('../server/core/AppLogger'))().init({...config, loggingEnabled:false});
    const WebWorker = require('../server/core/WebWorker');
    const reference = referencePath ? await referenceResults(WebWorker, config, referencePath) : null;
    const started = performance.now();
    const {db, searcher} = await WebWorker.prototype.openCatalogue.call({config}, dbPath);
    console.log(JSON.stringify({stage:'open', openMs:elapsed(started)}));
    const lookup = searcher.rustLookup;
    const discovery = new Discovery({db, dbSearcher:searcher, libraryAssetGeneration:1});
    const runLookup = lookup.run.bind(lookup);
    let operations = 0;
    lookup.run = (work, fallback) => runLookup(process => work({query:async query => {
        const response = await process.query(query);
        operations++;
        return response;
    }}), fallback);
    const options = {searcher, discovery};
    async function run(request, native) {
        searcher.rustLookup = native ? lookup : null;
        discovery.close();
        const before = operations, started = performance.now();
        const result = await request.run(options);
        return {result, ms:elapsed(started), operations:operations-before};
    }
    try {
        const cases = requests();
        for (const [index, request] of cases.entries()) {
            const times = {node:[],rust:[]};
            let found, corrections, nativeReads = 0;
            for (let round = 0; round < 3; round++) {
                const nativeFirst = (index + round) % 2 === 0;
                const first = await run(request, nativeFirst);
                const second = await run(request, !nativeFirst);
                const [rust, node] = nativeFirst ? [first, second] : [second, first];
                assert.deepEqual(rust.result, node.result, 'Result differs for ' + request.label);
                if (reference) assert.deepEqual(rust.result, reference.get(request.label), 'Result differs from original catalog for ' + request.label);
                if (!/explicit|no-result/.test(request.label))
                    assert(rust.operations > 0, `No native lookup for ${request.label} (${lookup.lastError || 'no response'})`);
                times.node.push(node.ms);
                times.rust.push(rust.ms);
                found = node.result.totalFound ?? node.result.groups.flatMap(group => group.items).length;
                corrections = node.result.corrections?.length;
                nativeReads += rust.operations;
            }
            console.log(JSON.stringify({case:request.label, nodeMs:times.node.toSorted((a,b) => a-b)[1],
                rustMs:times.rust.toSorted((a,b) => a-b)[1], firstNodeMs:times.node[0], firstRustMs:times.rust[0],
                nativeReads, found, corrections}));
        }
        const expected = await run(cases[2], false);
        await lookup.process?.close();
        lookup.process = null;
        lookup.generation = 'stale-snapshot';
        const actual = await run(cases[2], true);
        assert.equal(actual.operations, 0);
        assert(lookup.retryAt > Date.now());
        assert.deepEqual(actual.result, expected.result);
        console.log(JSON.stringify({stage:'parity', cases:cases.length, nativeReads:operations, staleFallback:true}));
    } finally {
        discovery.close();
        searcher.rustLookup = lookup;
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

async function fingerprint(dbPath) {
    const db = new DatabaseThread(base);
    const hash = createHash('sha256');
    let count = 0;
    try {
        await db.lock({dbPath, softLock:true});
        await db.open({table:'book', cacheSize:base.dbCacheSize});
        while (true) {
            const [{rawResult:rows}] = await db.select({table:'book', rawResult:true, where:`
                let cursor = @getItem('rust-build-verification');
                if (!cursor) {cursor = @all(); @setItem('rust-build-verification', cursor);}
                const rows = [];
                while (rows.length < 4096) {
                    const next = cursor.next();
                    if (next.done) break;
                    const book = @unsafeRow(next.value);
                    rows.push([book.id, book._uid, book._recordHash]);
                }
                return rows;
            `});
            if (!rows.length) break;
            count += rows.length;
            hash.update(JSON.stringify(rows));
        }
        await db.open({table:'config'});
        const [stats] = await db.select({table:'config', where:"@@id('stats')"});
        return {count, digest:hash.digest('hex'), stats:stats?.value};
    } finally {await db.unlock();}
}

async function compareBuilds(nodePath, rustPath) {
    const expected = await fingerprint(nodePath);
    const actual = await fingerprint(rustPath);
    assert.deepEqual(actual, expected, 'Book identity, content, or order differs between initial builds');
    const [beforeUpdate, afterUpdate] = await Promise.all([updateStats(nodePath), updateStats(rustPath)]);
    if (beforeUpdate.incremental && afterUpdate.incremental) assert.deepEqual(afterUpdate, beforeUpdate);
    for (const table of ['author','series','title']) {
        const file = `${table}_id.map`;
        const load = async path => JSON.parse(await readFile(join(path, file), 'utf8'));
        const [left, right] = await Promise.all([load(nodePath), load(rustPath)]);
        assert.deepEqual(new Uint32Array(right.arr), new Uint32Array(left.arr), file + ' single book mapping differs');
        assert.deepEqual(new Map(right.map), new Map(left.map), file + ' multiple book mapping differs');
    }
    console.log(JSON.stringify({stage:'build-parity', ...actual, bookMapsMatch:true,
        ...(beforeUpdate.incremental && afterUpdate.incremental ? {changes:afterUpdate} : {})}));
}

async function main([command, ...args]) {
    if (command === 'build' && args.length >= 2 && args.length <= 4) return build(...args.map(file => resolve(file)));
    const options = {};
    if (command === 'update' && args.at(-1) === '--without-book-store') {
        args.pop();
        options.rustBookStoreEnabled = false;
    } else if (command === 'update' && args.at(-1) === '--legacy-update') {
        args.pop();
        options.rustCatalogUpdateEnabled = false;
    }
    if (command === 'update' && args.length >= 3 && args.length <= 5) {
        const [index, destination, previous, binary, reader] = args.map(file => resolve(file));
        return build(index, destination, binary, reader, previous, options);
    }
    if (command === 'compare' && [2,3].includes(args.length)) return compare(...args.map(file => resolve(file)));
    if (command === 'verify' && args.length === 2) return compareBuilds(...args.map(file => resolve(file)));
    throw new Error('Usage: compare-rust-lookup.js build <library.inpx> <new-db-dir> [catalog-binary] [reader-binary] | update <library.inpx> <new-db-dir> <previous-db-dir> [catalog-binary] [reader-binary] [--legacy-update|--without-book-store] | compare <catalog-binary> <db-dir> [baseline-db-dir] | verify <baseline-db-dir> <rust-db-dir>');
}

main(process.argv.slice(2)).catch(error => {console.error(error);process.exitCode = 1;});
