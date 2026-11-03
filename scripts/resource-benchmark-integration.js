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
    try {
        const libDir = path.join(dir, 'library'); await fs.ensureDir(libDir);
        const source = path.join(libDir, 'book.fb2'), content = '<FictionBook>Read-only sample</FictionBook>';
        await fs.writeFile(source, content);
        const config = {dataDir:dir, tempDir:path.join(dir, 'tmp'), libDir, version:'integration', conversionEnabled:true,
            librarySources:[{id:'fixture', libDir, name:'Integration fixture'}],
            converterPaths:{fb2cng:path.resolve(args.fbc), djxl:path.resolve(args.djxl), sevenZip:path.resolve(args.sevenzip)}};
        const service = new (require('../server/core/ResourceBenchmark').ResourceBenchmark)(config);
        await service.start(); await service.completion;
        assert.strictEqual(service.job.state, 'completed', service.lastError?.stack || service.job.message);
        assert.deepStrictEqual(service.last.coverage, ['Изображения','Архивы','Конвертация EPUB','Хранилище']);
        assert.strictEqual(service.last.rows.length, 3);
        assert.strictEqual(await fs.readFile(source, 'utf8'), content);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
        assert.strictEqual(require('../server/core/ResourceRuntime').active, 0);
        console.log('Resource benchmark: real djxl, 7-Zip and fbc, all profiles, persisted recommendation and cleanup passed');
    } finally {await fs.remove(dir);}
})().catch(error => {console.error(error); process.exitCode = 1;});
