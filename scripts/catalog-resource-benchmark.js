// Isolated, synthetic catalog. No library files or running server are used.
// node scripts/catalog-resource-benchmark.js [names=20000] [lookup-source-file]
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {createRequire} = require('module');
const {performance} = require('perf_hooks');
const {JembaDb} = require('jembadb');

async function benchmark() {
    const count = Number(process.argv[2] || 20000);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error('Expected 1–1000000 names');
    const source = path.resolve(__dirname, '../server/core/CatalogLookupIndex.js');
    let Lookup = require(source);
    if (process.argv[3]) {
        const mod = {exports: {}};
        new Function('require', 'module', 'exports', await fs.readFile(process.argv[3], 'utf8'))(createRequire(source), mod, mod.exports);
        Lookup = mod.exports;
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-catalog-resource-'));
    const db = new JembaDb();
    let lookup, timer;
    try {
        await db.lock({dbPath: directory, create: true});
        for (const kind of ['author', 'series', 'title']) {
            await db.create({table: kind, cacheSize: 5});
            const length = kind === 'title' ? count : Math.ceil(count / 10);
            for (let offset = 0; offset < length; offset += 2000) {
                await db.insert({table: kind, rows: Array.from({length: Math.min(2000, length - offset)}, (_, i) => {
                    const id = offset + i + 1;
                    return {id, name: `Название ${kind} ${id} приключения героя`, bookIds: Array.from({length: 20}, (_, j) => id * 20 + j)};
                })});
            }
            await db.close({table: kind}); await db.open({table: kind, cacheSize: 5});
        }
        let reads = 0;
        for (const kind of ['author', 'series', 'title']) {
            const table = db.table.get(kind), getRow = table.rowsInterface.getRow.bind(table.rowsInterface);
            table.rowsInterface.getRow = id => {reads++; return getRow(id);};
        }
        const before = process.memoryUsage(), cpu = process.cpuUsage(), start = performance.now();
        let peak = before.rss;
        timer = setInterval(() => {peak = Math.max(peak, process.memoryUsage().rss);}, 10);
        lookup = new Lookup({db, dbSearcher: {dbConfig: {inpxHash: 'synthetic-v1'}}, libraryAssetGeneration: 1});
        await lookup.ensure(); await lookup.building;
        const after = process.memoryUsage(), usage = process.cpuUsage(cpu);
        const result = {names: Math.ceil(count / 10) * 2 + count, rowsRead: reads, milliseconds: Math.round(performance.now() - start),
            cpuMilliseconds: Math.round((usage.user + usage.system) / 1000), beforeRssMiB: Math.round(before.rss / 1048576),
            peakRssMiB: Math.round(Math.max(peak, after.rss) / 1048576), afterRssMiB: Math.round(after.rss / 1048576)};
        const queryStart = performance.now();
        result.matches = (await lookup.ids('title', 'приключ')).length;
        result.queryMilliseconds = Math.round(performance.now() - queryStart);
        clearInterval(timer);
        const idleWait = Number(process.env.INPX_BENCHMARK_IDLE_MS || 1500);
        await new Promise(resolve => setTimeout(resolve, idleWait));
        result.idleWaitMilliseconds = idleWait;
        result.lookupTableOpen = db.table.has('catalog_lookup');
        result.idleRssMiB = Math.round(process.memoryUsage().rss / 1048576);
        console.log(JSON.stringify(result));
    } finally {
        clearInterval(timer); await lookup?.close(); await db.unlock(); await fs.remove(directory);
    }
}
benchmark().catch(error => {console.error(error); process.exitCode = 1;});
