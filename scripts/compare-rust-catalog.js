const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {access} = require('node:fs/promises');
const {performance} = require('node:perf_hooks');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const DatabaseThread = require('../server/core/DatabaseThread');
const {copyKey, rowQuality} = require('../server/core/DiscoverySelection');
const {catalogGeneration} = require('../server/core/RustShelfIndex');
const base = require('../server/config/base');

const daysWindows = [7, 30, 90, 180, 365];
const dateCollator = new Intl.Collator();
const textCollator = new Intl.Collator('ru');

async function* scanBooks(db) {
    const token = db.esc(`rust-catalog-${randomUUID()}`);
    try {
        while (true) {
            const [result] = await db.select({table:'book', rawResult:true, where:`
                let cursor = @getItem(${token});
                if (!cursor) {cursor = @all(); @setItem(${token}, cursor);}
                const rows = [];
                for (let visited = 0; visited < 4096; visited++) {
                    const next = cursor.next();
                    if (next.done) return {rows, done:true};
                    const row = @unsafeRow(next.value);
                    if (!row || row.del || !row.title) continue;
                    rows.push({id:row.id, _uid:row._uid, date:row.date, author:row.author,
                        title:row.title, series:row.series, ext:row.ext, librate:row.librate,
                        size:row.size, libid:row.libid, sourceId:row.sourceId, folder:row.folder,
                        file:row.file, insno:row.insno, serno:row.serno});
                }
                return {rows, done:false};
            `});
            yield* result.rawResult.rows;
            if (result.rawResult.done) break;
        }
    } finally {
        await db.select({table:'book', rawResult:true, where:`@delItem(${token}); return null;`});
    }
}

function ranks(values, collator) {
    const ordered = [...values].sort(collator.compare);
    const result = new Map();
    let rank = 0;
    for (const [index, value] of ordered.entries()) {
        if (index > 0 && collator.compare(ordered[index - 1], value) !== 0) rank++;
        result.set(value, rank);
    }
    return result;
}

async function sortOrders(db) {
    const dates = new Set(), authors = new Set(), titles = new Set();
    for await (const row of scanBooks(db)) {
        dates.add(String(row.date || ''));
        authors.add(row.author || '');
        titles.add(row.title);
    }
    return [ranks(dates, dateCollator), ranks(authors, textCollator), ranks(titles, textCollator)];
}

async function* snapshot(db, generation, orders) {
    const [dates, authors, titles] = orders;
    yield JSON.stringify({generation}) + '\n';
    let lines = '';
    for await (const row of scanBooks(db)) {
        const date = String(row.date || ''), author = row.author || '';
        lines += JSON.stringify({id:row.id, uid:row._uid, copyKey:copyKey(row), quality:rowQuality(row),
            dateMs:Date.parse(date), dateOrder:dates.get(date), rating:row.librate || 0,
            authorOrder:authors.get(author), titleOrder:titles.get(row.title),
            authorGroup:author.trim().toLowerCase(), seriesGroup:(row.series || '').trim().toLowerCase()}) + '\n';
        if (lines.length >= 256 * 1024) {yield lines; lines = '';}
    }
    if (lines) yield lines;
}

async function rust(executable, command, indexPath, input) {
    const child = spawn(executable, [command, indexPath], {windowsHide:true, stdio:['pipe','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
    child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-8192);});
    const finished = new Promise(resolve => {
        child.once('error', resolve);
        child.once('close', (code, signal) => resolve(code === 0 ? null : new Error(stderr.trim() || `Rust catalog exited with ${signal || code}`)));
    });
    const [transfer, exited] = await Promise.allSettled([pipeline(Readable.from(input), child.stdin), finished]);
    if (exited.value) throw exited.value;
    if (transfer.status === 'rejected') throw transfer.reason;
    return JSON.parse(stdout);
}

async function hasIndex(file) {
    try {await access(file);return true;}
    catch (error) {if (error.code === 'ENOENT') return false;throw error;}
}

async function main() {
    const [executable, dbPath, indexPath] = process.argv.slice(2);
    if (!executable || !dbPath || !indexPath || process.argv.length !== 5)
        throw new Error('Usage: node scripts/compare-rust-catalog.js <catalog-binary> <stopped-jembadb-copy> <index.redb>');
    await new (require('../server/core/AppLogger'))().init({...base, loggingEnabled:false});
    const WebWorker = require('../server/core/WebWorker');
    const db = new DatabaseThread(base);
    const times = [];
    try {
        await db.lock({dbPath, softLock:true});
        await db.open({table:'book', cacheSize:base.dbCacheSize});
        await db.open({table:'config'});
        const config = Object.fromEntries((await db.select({table:'config'})).map(row => [row.id,row.value]));
        const generation = catalogGeneration(config);
        assert(generation, 'The source must be a completed JembaDB catalog');
        if (!await hasIndex(indexPath)) {
            const started = performance.now();
            const orders = await sortOrders(db);
            const sortMs = Math.round(performance.now() - started);
            const result = await rust(executable, 'build', indexPath, snapshot(db, generation, orders));
            console.log(JSON.stringify({indexed:result.indexed, sortMs, totalBuildMs:Math.round(performance.now() - started)}));
        }
        const worker = Object.assign(Object.create(WebWorker.prototype), {db, dbSearcher:{dbConfig:config},
            myState:'normal', libraryAssetGeneration:1, addAdminEvent:() => assert.fail('Rust shelf lookup fell back to the Node.js query')});
        const nowMs = Date.now();
        const requests = [{name:'default', nowMs, newestLimit:8, popularLimit:8, scores:{}}];
        const select = (request, popularity) => worker.selectDiscoveryBookWindows(
            'newest', request.newestLimit, daysWindows, popularity, request.popularLimit, request.nowMs,
        );
        const run = async(request, popularity, useRust) => {
            if (useRust) {
                process.env.INPX_RUST_CATALOG_BINARY = executable;
                process.env.INPX_RUST_CATALOG_INDEX = indexPath;
            } else {
                delete process.env.INPX_RUST_CATALOG_BINARY;
                delete process.env.INPX_RUST_CATALOG_INDEX;
            }
            const start = performance.now();
            const shelves = (await select(request, popularity)).map(shelf => shelf.map(book => book._uid));
            return {shelves, ms:Math.round(performance.now() - start)};
        };
        let defaultShelves;
        for (const request of requests) {
            const popularity = Object.fromEntries(Object.entries(request.scores).map(([uid, score]) => [uid,{score}]));
            const {shelves:actual, ms:rustMs} = await run(request, popularity, true);
            const {shelves:expected, ms:nodeMs} = await run(request, popularity, false);
            assert.deepStrictEqual(actual, expected, `Shelf membership or order differs for ${request.name}`);
            const result = {case:request.name, windowLengths:actual.map(shelf => shelf.length), nodeMs, rustMs};
            times.push(result);
            console.log(JSON.stringify(result));
            if (request.name === 'default') {
                defaultShelves = expected;
                const scores = Object.fromEntries(expected.flat().slice(0, 7).map((uid, index) => [uid, index + 10]));
                requests.push({name:'activity',nowMs,newestLimit:24,popularLimit:24,scores});
                requests.push({name:'historical',nowMs:Date.UTC(2022, 6, 1),newestLimit:8,popularLimit:8,scores:{}});
            }
        }
        let fallbacks = 0;
        worker.addAdminEvent = () => {fallbacks++;};
        worker.dbSearcher.dbConfig = {...config, indexUpdate:{updatedAt:'stale-index-test'}};
        assert.deepStrictEqual((await run(requests[0], {}, true)).shelves, defaultShelves);
        assert.equal(fallbacks, 1, 'A stale Rust index must fall back to the current JembaDB catalog');
        console.log(JSON.stringify({matches:true, staleIndexFallback:true, cases:times}));
    } finally {await db.unlock();}
}

main().catch(error => {console.error(error);process.exitCode = 1;});
