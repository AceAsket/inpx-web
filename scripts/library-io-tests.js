const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeWorker = () => Object.create(require('../server/core/WebWorker').prototype);
async function until(fn) {
    const end = Date.now() + 2000;
    while (!fn() && Date.now() < end) await pause(5);
    assert(fn(), 'Operation did not settle');
}
async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-library-io-'));
    try {await fn(dir);} finally {await fs.remove(dir);}
}

async function testLibraryBackgroundQueueBoundAndImmediateCancellation() {
    const worker = makeWorker(); let release;
    const foreground = worker.runForeground(() => new Promise(resolve => {release = resolve;}));
    const controllers = Array.from({length:256}, () => new AbortController());
    let executed = 0;
    const jobs = controllers.map(controller => worker.runBackground(async() => {executed++;}, () => false, controller.signal));
    try {
        assert.strictEqual(worker.backgroundWaiters.length, 256);
        await assert.rejects(worker.runBackground(async() => {}), {code:'INPX_RESOURCE_IO_QUEUE_FULL'});
        controllers.forEach(controller => controller.abort());
        await Promise.all(jobs);
        assert.strictEqual(worker.foregroundJobs, 1, 'Cancellation must finish before the foreground work does');
        assert.strictEqual(worker.backgroundWaiters.length, 0);
        assert.strictEqual(executed, 0);
    } finally {controllers.forEach(controller => controller.abort()); release(); await foreground; await Promise.all(jobs);}
    await worker.runBackground(async() => {executed++;});
    assert.strictEqual(executed, 1);
}

async function testLibraryBackgroundDeadlineAndFailureRecovery() {
    const worker = makeWorker();
    await assert.rejects(worker.waitBackgroundTurn(undefined, Date.now() + 15), {code:'INPX_RESOURCE_IO_QUEUE_TIMEOUT'});
    assert.strictEqual(worker.backgroundWaiters.length, 0);
    await assert.rejects(worker.runBackground(async() => {throw new Error('Read failed');}), /Read failed/);
    await assert.rejects(worker.runForeground(async() => {throw new Error('Card failed');}), /Card failed/);
    assert.strictEqual(worker.backgroundJobs, 0); assert.strictEqual(worker.foregroundJobs, 0);
    assert.strictEqual(await worker.runBackground(async() => 'retry'), 'retry');
}

async function testLibraryDirectoryMissExpiresAndPositiveListingIsShared() {
    await temporary(async dir => {
        const worker = makeWorker(), missing = path.join(dir, 'missing'), empty = path.join(dir, 'empty');
        await fs.ensureDir(empty);
        assert.deepStrictEqual(await worker.readLibraryDirCached(missing), []);
        assert.deepStrictEqual(await worker.readLibraryDirCached(empty), []);
        await fs.ensureDir(missing);
        await fs.writeFile(path.join(missing, 'new.7z'), 'archive');
        await fs.writeFile(path.join(empty, 'new.zip'), 'archive');
        assert.deepStrictEqual(await worker.readLibraryDirCached(missing), [], 'Negative results briefly coalesce repeated reads');
        await pause(1100);
        assert.deepStrictEqual(await worker.readLibraryDirCached(missing), ['new.7z']);
        assert.deepStrictEqual(await worker.readLibraryDirCached(empty), ['new.zip']);
        assert.strictEqual(worker.readLibraryDirCached(missing), worker.readLibraryDirCached(missing));
    });
}

async function testOldDirectoryFailureCannotEvictCurrentGeneration() {
    const worker = makeWorker(), original = fs.readdir;
    let rejectOld, calls = 0;
    fs.readdir = async() => {
        calls++;
        if (calls === 1) return await new Promise((resolve, reject) => {rejectOld = reject;});
        return ['current.7z'];
    };
    try {
        const old = worker.readLibraryDirCached('/fixture');
        const rejected = assert.rejects(old, {code:'EIO'});
        worker.resetLibraryAssetCaches();
        const current = worker.readLibraryDirCached('/fixture');
        assert.deepStrictEqual(await current, ['current.7z']);
        rejectOld(Object.assign(new Error('Old mount failed'), {code:'EIO'})); await rejected;
        assert.strictEqual(worker.readLibraryDirCached('/fixture'), current);
        assert.strictEqual(calls, 2);
    } finally {fs.readdir = original;}
}

async function testQueuedBookFromOldLibraryGenerationIsSkipped() {
    const worker = makeWorker(); let release, calls = 0;
    worker.getBookLink = async() => {calls++;};
    const occupied = worker.runBackground(() => new Promise(resolve => {release = resolve;}));
    const book = worker.prepareBookInBackground('old');
    try {
        await until(() => worker.backgroundWaiters?.length === 1);
        worker.resetLibraryAssetCaches();
    } finally {release(); await occupied; await book;}
    assert.strictEqual(calls, 0);
    assert.strictEqual(worker.backgroundJobs, 0);
}

async function testCoverHttpAbortReleasesQueueAndBusyResponseIsNotCached() {
    await temporary(async dir => {
        const worker = makeWorker(), config = {libDir:dir, publicDir:dir, publicFilesDir:dir, rootPathStatic:'',
            bookDir:path.join(dir, 'book'), bookPathStatic:'/book', coverDir:path.join(dir, 'covers')};
        let calls = 0, release, request;
        worker.getBookRecordByUid = async uid => ({_uid:uid, ext:'fb2', folder:'books.zip', file:'1'});
        worker.getBookCover = async() => {calls++; return {contentType:'image/png', data:Buffer.from('cover')};};
        const app = require('express')(); require('../server/static')(app, config, worker);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/cover/by-uid`;
        const foreground = worker.runForeground(() => new Promise(resolve => {release = resolve;}));
        try {
            request = http.get(url + '?uid=cancelled'); request.on('error', () => {});
            await until(() => worker.backgroundWaiters?.length === 1);
            request.destroy();
            await until(() => worker.backgroundWaiters.length === 0);
            assert.strictEqual(worker.foregroundJobs, 1);
            assert.strictEqual(calls, 0);
            release(); await foreground;
            const response = await fetch(url + '?uid=available');
            assert.strictEqual(response.status, 200); await response.arrayBuffer();
            assert.strictEqual(calls, 1);
            worker.runBackground = async() => {throw Object.assign(new Error('Queue full'), {code:'INPX_RESOURCE_IO_QUEUE_FULL'});};
            const busy = await fetch(url + '?uid=busy');
            assert.strictEqual(busy.status, 503); assert.strictEqual(busy.headers.get('cache-control'), 'no-store');
            assert.strictEqual(busy.headers.get('retry-after'), '1'); await busy.text();
        } finally {
            request?.destroy(); release(); await foreground;
            server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        }
    });
}

module.exports = [testLibraryBackgroundQueueBoundAndImmediateCancellation, testLibraryBackgroundDeadlineAndFailureRecovery,
    testLibraryDirectoryMissExpiresAndPositiveListingIsShared, testOldDirectoryFailureCannotEvictCurrentGeneration,
    testQueuedBookFromOldLibraryGenerationIsSkipped, testCoverHttpAbortReleasesQueueAndBusyResponseIsNotCached];
