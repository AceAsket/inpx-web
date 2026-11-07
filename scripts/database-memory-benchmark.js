// A separate process per variant, identical disk fixture, no forced GC.
// node scripts/database-memory-benchmark.js [rows=30000]
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFile} = require('child_process');
const run = require('util').promisify(execFile);
const JembaDb = require('jembadb/src/JembaDb');
const MiB = 1024 ** 2;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const [arg, directory] = process.argv.slice(2);
    if (directory) {
        const db = new JembaDb(); let cache;
        try {
            await db.lock({dbPath:directory}); await db.open({table:'book', cacheSize:500});
            if (arg === 'bounded') {cache = new (require('../server/core/DatabaseCache').DatabaseCache)(db, {budgetBytes:64 * MiB, idleMs:1000}); cache.attach();}
            const before = process.memoryUsage(), cpu = process.cpuUsage(), start = performance.now();
            let peak = before.rss;
            const timer = setInterval(() => {peak = Math.max(peak, process.memoryUsage().rss);}, 10);
            const rows = await db.select({table:'book', rawResult:true, where:`
                const result = [];
                for (const id of @all()) {const row = @unsafeRow(id); if (row) result.push(row.id);}
                return result;
            `});
            const ids = rows[0].rawResult;
            const elapsedMs = Math.round(performance.now() - start), usage = process.cpuUsage(cpu);
            const after = process.memoryUsage(); peak = Math.max(peak, after.rss); clearInterval(timer);
            await wait(2500);
            const idle = process.memoryUsage();
            const loaded = [...db.table.get('book').tableRowsFile.blockList.values()].filter(block => block.rows);
            console.log(JSON.stringify({mode:arg, rows:ids.length, elapsedMs, cpuMs:Math.round((usage.user + usage.system) / 1000),
                peakRssMiB:Math.round(peak / MiB), afterHeapMiB:Math.round(after.heapUsed / MiB), idleRssMiB:Math.round(idle.rss / MiB),
                idleHeapMiB:Math.round(idle.heapUsed / MiB), retainedDecodedBlocks:loaded.length, encodedRetainedMiB:Math.round(loaded.reduce((sum, b) => sum + b.size, 0) / MiB),
                cache:cache?.snapshot()}));
        } finally {clearInterval(cache?.timer); await db.unlock();}
        return;
    }
    const count = Number(arg || 30000);
    if (!Number.isInteger(count) || count < 1000 || count > 100000) throw new Error('Expected 1000–100000 rows');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-db-memory-benchmark-'));
    const db = new JembaDb();
    try {
        await db.lock({dbPath:dir, create:true}); await db.create({table:'book'});
        for (let offset = 0; offset < count; offset += 500)
            await db.insert({table:'book', rows:Array.from({length:Math.min(500, count - offset)}, (_, i) =>
                ({id:offset + i, title:`Книга ${offset + i}`, annotation:'длинная аннотация '.repeat(180)}))});
        await db.unlock();
        const results = [];
        for (const mode of ['legacy', 'bounded']) {
            const {stdout} = await run(process.execPath, [__filename, mode, dir], {timeout:120000, windowsHide:true});
            results.push(JSON.parse(stdout.trim()));
        }
        console.log(JSON.stringify({fixtureRows:count, forcedGc:false, idleMs:2500, results}, null, 2));
    } finally {await db.unlock().catch(() => {}); await fs.remove(dir);}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
