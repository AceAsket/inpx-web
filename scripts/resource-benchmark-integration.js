const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

(async() => {
    // Docker executable adapters add container startup overhead to each sample.
    process.env.INPX_RESOURCE_BENCH_TIMEOUT_MS ||= '180000';
    require('../server/core/Logger');
    await new (require('../server/core/AppLogger'))().init({loggingEnabled:false, name:'benchmark-integration'});
    const args = require('minimist')(process.argv.slice(2));
    assert(args.fbc && args.djxl && args.sevenzip, '--fbc, --djxl and --sevenzip required');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-benchmark-integration-'));
    let db;
    try {
        const libDir = path.join(dir, 'library'); await fs.ensureDir(libDir);
        const source = path.join(libDir, 'book.fb2'), content = '<FictionBook>Read-only sample</FictionBook>';
        await fs.writeFile(source, content);
        const config = {dataDir:dir, tempDir:path.join(dir, 'tmp'), libDir, version:'integration', conversionEnabled:true,
            librarySources:[{id:'fixture', libDir, name:'Integration fixture'}],
            converterPaths:{fb2cng:path.resolve(args.fbc), djxl:path.resolve(args.djxl), sevenZip:path.resolve(args.sevenzip)}};
        // Exercise the application's actual DB probe alongside real native
        // converters, rather than measuring a no-op responsiveness callback.
        db = new (require('../server/core/DatabaseThread'))({dbCacheBudgetMb:4});
        await db.lock({dbPath:path.join(dir,'db'),create:true}); await db.create({table:'book'});
        await db.insert({table:'book',rows:Array.from({length:1000},(_,id)=>({id,title:`Fixture ${id}`}))});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = config; worker.db = db; worker.checkMyState = () => {};
        const service = worker.getResourceBenchmark();
        await service.start(); await service.completion;
        assert.strictEqual(service.job.state, 'completed', service.lastError?.stack || service.job.message);
        assert.deepStrictEqual(service.last.coverage, ['Изображения','Архивы','Конвертация EPUB','Хранилище']);
        assert.strictEqual(service.last.rows.length, 3);
        for (const row of service.last.rows.filter(row=>row.completed)) {
            assert(row.probeSamples > 0); assert(row.cpuTimeMs >= 0); assert(row.peakRss > 0);
            assert(Number.isFinite(row.cpuPercent)); assert(Number.isFinite(row.memoryDelta));
        }
        const runtime = require('../server/core/ResourceRuntime'), before = JSON.stringify(runtime.settings);
        const total = Math.min(3,runtime.settings.hardMax);
        const limits = {total,images:Math.min(2,total),reviews:total,conversions:Math.min(2,total)};
        await service.start({mode:'custom',limits}); await service.completion;
        assert.strictEqual(service.job.state,'completed',service.lastError?.stack || service.job.message);
        assert.strictEqual(service.last.mode,'custom'); assert.strictEqual(service.last.rows.length,1);
        const custom = service.last.rows[0]; assert(custom.completed);
        for (const key of Object.keys(limits)) assert.strictEqual(custom.limits[key],limits[key]);
        assert(Number.isFinite(custom.cpuTimeMs) && Number.isFinite(custom.cpuPercent));
        assert(custom.peakRss > 0 && Number.isFinite(custom.memoryDelta));
        assert.strictEqual(JSON.stringify(runtime.settings),before,'Real custom runs must not apply their test limits');
        assert.strictEqual(await fs.readFile(source, 'utf8'), content);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
        assert.strictEqual(require('../server/core/ResourceRuntime').active, 0);
        console.log('Resource benchmark: real djxl, 7-Zip, fbc and DB probe, standard/custom profiles, measured CPU/RAM and cleanup passed');
    } finally {await db?.unlock(); await fs.remove(dir);}
})().catch(error => {console.error(error); process.exitCode = 1;});
