const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');
const imageRuntime = require('../server/core/ImageRuntime');
const {ImageRuntime} = imageRuntime;

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jxl = id => Buffer.concat([Buffer.from('ff0a', 'hex'), Buffer.from(String(id))]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isolatedImages(runner, runtime = imageRuntime) {
    const filename = require.resolve('../server/core/ImageUtils');
    const nativeRequire = Module.createRequire(filename);
    const loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded.require = name => name === './ConversionRuntime' ? {runProcess:runner}
        : name === './ImageRuntime' ? runtime : nativeRequire(name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    return loaded.exports;
}

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-images-test-'));
    try { await task(dir); } finally { await fs.remove(dir); }
}

async function testImagesShareBudgetAcrossBooksCoversAndEpub() {
    await temporary(async dir => {
        const imageUtils = require('../server/core/ImageUtils');
        const ZipReader = require('../server/core/ZipReader');
        const Worker = require('../server/core/WebWorker');
        const originalNormalize = imageUtils.normalizeForFb2;
        const originalExtract = ZipReader.prototype.extractToBuf;
        const ids = [123,456,789], count = 12;
        const file = path.join(dir, 'images.zip');
        const zip = new yazl.ZipFile(), complete = pipeline(zip.outputStream, fs.createWriteStream(file));
        for (const id of ids) for (let i = 0; i < count; i++) zip.addBuffer(jxl(`${id}/${i}`), `${id}/${i}`);
        zip.end(); await complete;
        let activeDecode = 0, peakDecode = 0, activeExtract = 0, peakExtract = 0;
        const calls = [];
        const images = isolatedImages(async(command, args) => {
            calls.push({command, args});
            peakDecode = Math.max(peakDecode, ++activeDecode);
            try {
                const data = await fs.readFile(args[0]);
                await sleep(10 + (count - Number(data.subarray(2).toString().split('/')[1] || 0)) % 3);
                if (data.subarray(2).toString() === '123/3') throw new Error('broken image fixture');
                await fs.writeFile(command === 'test-webp' ? args[2] : args[1], Buffer.concat([png, data.subarray(2)]));
            } finally { activeDecode--; }
        });
        const converterPaths = {djxl:'test-djxl', dwebp:'test-webp'};
        try {
            imageUtils.normalizeForFb2 = images.normalizeForFb2;
            ZipReader.prototype.extractToBuf = async function(...args) {
                peakExtract = Math.max(peakExtract, ++activeExtract);
                try { await sleep(5); return await originalExtract.apply(this, args); }
                finally { activeExtract--; }
            };
            const books = ids.map(id => {
                const worker = Object.create(Worker.prototype);
                worker.config = {libDir:dir, tempDir:dir, converterPaths};
                worker.getBookAssetArchives = async() => [{file}];
                return worker.getFblibraryImages(id, dir, 'collection.zip');
            });
            const webp = Buffer.from('RIFF0000WEBP', 'ascii');
            const others = [images.jxlToPng(jxl('cover'), dir, [], converterPaths),
                images.normalizeForEpub(jxl('epub'), 'picture.jpg', dir, [], converterPaths),
                images.normalizeForFb2(webp, dir, [], converterPaths)];
            const result = await Promise.all([...books, ...others]);
            assert.ok(peakDecode <= imageRuntime.concurrency, `Global decoder peak: ${peakDecode}`);
            assert.ok(peakExtract <= imageRuntime.concurrency, `Global archive extraction peak: ${peakExtract}`);
            assert.strictEqual(peakDecode, imageRuntime.concurrency, 'Keep useful parallelism within the shared budget');
            for (let i = 0; i < ids.length; i++) {
                const expected = Array.from({length:count}, (_, n) => String(n)).filter(n => !(i === 0 && n === '3'));
                assert.deepStrictEqual(result[i].map(image => image.id), expected);
                assert.deepStrictEqual(result[i].map(image => image.data.subarray(png.length).toString()), expected.map(n => `${ids[i]}/${n}`));
            }
            assert.strictEqual(calls.filter(call => call.command === 'test-webp').length, 1);
            assert.ok(calls.filter(call => call.command === 'test-djxl').every(call => call.args.includes('--num_threads=1')));
            assert.deepStrictEqual(await fs.readdir(dir), ['images.zip'], 'Clean decoder files after success and a broken image');
        } finally {
            imageUtils.normalizeForFb2 = originalNormalize;
            ZipReader.prototype.extractToBuf = originalExtract;
        }
        assert.strictEqual(imageRuntime.active, 0);
        assert.strictEqual(imageRuntime.queue.length, 0);
    });
}

async function testImageRuntimeOneSlotDoesNotDeadlockNestedDecoder() {
    await temporary(async dir => {
        const runtime = new ImageRuntime(1);
        const images = isolatedImages(async(command, args) => {await fs.writeFile(args[1], png);}, runtime);
        const result = await runtime.map([1,2,3], id => images.jxlToPng(jxl(id), dir, [], {djxl:'test-djxl'}));
        assert.strictEqual(result.length, 3);
        assert.ok(result.every(data => data.equals(png)));
        assert.strictEqual(runtime.active, 0);
        assert.strictEqual(runtime.queue.length, 0);
        assert.deepStrictEqual(await fs.readdir(dir), []);
    });
}

async function testImageMapWaitsForWorkersOnFailureAndRecovers() {
    const runtime = new ImageRuntime(2);
    let failFirst, releaseSecond;
    const first = new Promise((resolve, reject) => {failFirst = reject;});
    const second = new Promise(resolve => {releaseSecond = resolve;});
    const expected = new Error('fixture failure');
    let settled = false, active = 0;
    const mapped = runtime.map([0,1,2,3], async value => {
        active++;
        try { return await (value === 0 ? first : second); } finally { active--; }
    }).then(() => assert.fail('Map should reject'), error => {settled = true; return error;});
    assert.strictEqual(active, 2);
    failFirst(expected);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'Do not let callers close an archive while another worker is reading it');
    assert.strictEqual(active, 1);
    releaseSecond('done');
    assert.strictEqual(await mapped, expected);
    assert.strictEqual(active, 0);
    assert.strictEqual(await runtime.run(() => 42), 42);
    assert.strictEqual(runtime.active, 0);
    assert.deepStrictEqual(await runtime.map([], () => assert.fail('Empty input')), []);
}

async function testImageDecoderTimeoutCleansFilesAndReleasesSlot() {
    await temporary(async dir => {
        const runtime = new ImageRuntime(1);
        let failing = true;
        const images = isolatedImages(async(command, args) => {
            await fs.writeFile(args[1], png);
            if (failing) throw Object.assign(new Error('decoder deadline'), {code:'INPX_CONVERSION_TIMEOUT'});
        }, runtime);
        await assert.rejects(images.jxlToPng(jxl('failed'), dir, [], {djxl:'test-djxl'}), {code:'INPX_CONVERSION_TIMEOUT'});
        assert.deepStrictEqual(await fs.readdir(dir), []);
        failing = false;
        assert.ok((await images.jxlToPng(jxl('good'), dir, [], {djxl:'test-djxl'})).equals(png));
        assert.strictEqual(runtime.active, 0);
        assert.deepStrictEqual(await fs.readdir(dir), []);
    });
}

async function testQueuedImageJobsKeepTheirOwnRequestContext() {
    const {AsyncLocalStorage} = require('async_hooks');
    const context = new AsyncLocalStorage(), runtime = new ImageRuntime(1);
    let release;
    const held = new Promise(resolve => {release = resolve;});
    const first = context.run('first request', () => runtime.run(async() => {
        await held;
        return context.getStore();
    }));
    const second = context.run('second request', () => runtime.run(async() => context.getStore()));
    release();
    assert.deepStrictEqual(await Promise.all([first, second]), ['first request','second request']);
    assert.strictEqual(runtime.active, 0);
}

module.exports = [testImagesShareBudgetAcrossBooksCoversAndEpub, testImageRuntimeOneSlotDoesNotDeadlockNestedDecoder,
    testImageMapWaitsForWorkersOnFailureAndRecovers, testImageDecoderTimeoutCleansFilesAndReleasesSlot,
    testQueuedImageJobsKeepTheirOwnRequestContext];
