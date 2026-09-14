const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {setTimeout: sleep} = require('timers/promises');
const {ConversionRuntime, runProcess} = require('../server/core/ConversionRuntime');
const Security = require('../server/core/Security');

async function testConversionQueueLimitsAndRecovery() {
    const runtime = new ConversionRuntime({conversionConcurrency: 1, conversionQueueLimit: 1, conversionQueueTimeoutMs: 100});
    let release;
    const first = runtime.run(() => new Promise(resolve => { release = resolve; }));
    const waiting = runtime.run(() => assert.fail('Expired task must not execute'));
    await assert.rejects(runtime.run(() => {}), {code: 'INPX_CONVERSION_QUEUE_FULL'});
    await assert.rejects(waiting, {code: 'INPX_CONVERSION_QUEUE_TIMEOUT'});
    release();
    await first;
    await assert.rejects(runtime.run(() => { throw new Error('fixture'); }), /fixture/);
    assert.strictEqual(await runtime.run(() => 42), 42);
    assert.strictEqual(runtime.active, 0);
    let active = 0;
    let peak = 0;
    const parallel = new ConversionRuntime({conversionConcurrency: 2});
    await Promise.all(Array.from({length: 6}, () => parallel.run(async() => {
        active++; peak = Math.max(peak, active);
        await sleep(20);
        active--;
    })));
    assert.strictEqual(peak, 2);
}

async function testConverterProcessTimeoutAndBoundedErrors() {
    const runtime = new ConversionRuntime({conversionTimeoutMs: 1500});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-process-limits-'));
    try {
        const marker = path.join(dir, 'leaked-child');
        const ready = path.join(dir, 'child-ready');
        const grandchild = `require('fs').writeFileSync(process.argv[1], 'ready');setTimeout(()=>require('fs').writeFileSync(process.argv[2], 'leaked'), 2200);`;
        const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1],process.argv[2]],{stdio:'ignore',windowsHide:true});setInterval(()=>{},100);`;
        const start = Date.now();
        await assert.rejects(runtime.run(() => runProcess(process.execPath, ['-e', parent, ready, marker])), {code: 'INPX_CONVERSION_TIMEOUT'});
        assert.ok(Date.now() - start < 10000);
        assert.ok(await fs.pathExists(ready), 'Grandchild must have started before timeout');
        await sleep(1500);
        assert.strictEqual(await fs.pathExists(marker), false, 'Timeout must kill descendant processes');
        await assert.rejects(runtime.run(() => runProcess(process.execPath, ['-e', "process.stderr.write('x'.repeat(200000));process.exitCode=1"])), error => {
            assert.match(error.message, /exit code 1/);
            assert.ok(Buffer.byteLength(error.message) < 66000);
            return true;
        });
        await assert.rejects(runtime.run(() => runProcess(path.join(dir, 'missing-converter'), [])), {code: 'ENOENT'});
        await runtime.run(() => runProcess(process.execPath, ['-e', 'process.exit(0)']));
    } finally {
        await fs.remove(dir);
    }
}

async function testOpdsAuthenticationRateLimit() {
    const express = require('express');
    const app = express();
    const config = {loginRateLimitMaxAttempts: 2, opds: {user: 'global', password: 'secret'}};
    const security = new Security(config);
    const scopedConfig = {opds: {}};
    const verify = async(user, login, password) => ({user: {id: user, opdsAuthEnabled: true}, authorized: login === 'reader' && password === 'secret'});
    const middleware = require('../server/core/opds/Auth');
    app.use('/global', middleware(config, verify, security));
    app.use('/scoped', middleware(scopedConfig, verify, security));
    app.use((_req, res) => res.send('ok'));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const auth = (user, password) => ({authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')});
    const request = (route, headers = {}) => fetch(url + route, {headers});
    try {
        for (let i = 0; i < 4; i++)
            assert.strictEqual((await request('/global')).status, 401);
        assert.strictEqual(security.loginAttempts.size, 0);
        assert.strictEqual((await request('/global', auth('global', 'secret'))).status, 200);
        assert.strictEqual((await request('/global', auth('global', 'wrong'))).status, 401);
        assert.strictEqual((await request('/scoped?user=reader', auth('reader', 'secret'))).status, 200);
        assert.strictEqual((await request('/scoped?user=reader', auth('reader', 'wrong'))).status, 401);
        const blocked = await request('/global', auth('global', 'wrong'));
        assert.strictEqual(blocked.status, 429);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
        assert.doesNotThrow(() => security.checkLoginRate({headers: {}, socket: {remoteAddress: '127.0.0.1'}}, 'profile'));
        for (const rec of security.loginAttempts.values()) rec.resetAt = Date.now() - 1;
        assert.strictEqual((await request('/scoped?user=reader', auth('reader', 'secret'))).status, 200);
        config.loginRateLimitEnabled = false;
        for (let i = 0; i < 3; i++)
            assert.strictEqual((await request('/global', auth('global', 'wrong'))).status, 401);
        assert.ok(security.getLoginMetrics().attempts.some(row => row.labels.kind === 'opds' && row.labels.result === 'blocked' && row.value === 1));
        config.loginRateLimitEnabled = true;
        security.loginAttempts.clear();
        const burst = await Promise.all(Array.from({length: 12}, () => request('/scoped?user=reader', auth('reader', 'wrong'))));
        assert.strictEqual(burst.filter(response => response.status === 401).length, 2);
        assert.strictEqual(burst.filter(response => response.status === 429).length, 10);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testConversionPublishesOnlyCompletedFiles() {
    const Module = require('module');
    const filename = require.resolve('../server/core/BookConverter');
    const nativeRequire = Module.createRequire(filename);
    let release;
    let started;
    let calls = 0;
    let fail = false;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    // Replace only the external executable; exercise the real queue, filesystem,
    // cache check and duplicate-request handling of BookConverter.
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = module.paths;
    isolated.require = name => name === './ConversionRuntime'
        ? {ConversionRuntime, runProcess: async(_command, args) => {
            calls++;
            assert.strictEqual(await fs.readFile(args[3], 'utf8'), 'source');
            await fs.writeFile(args[2], 'partial');
            started();
            await gate;
            if (fail) throw new Error('conversion failed');
            await fs.writeFile(args[2], 'complete');
        }} : nativeRequire(name);
    isolated._compile(await fs.readFile(filename, 'utf8'), filename);
    const converter = isolated.exports;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-conversion-cache-'));
    try {
        const inputFile = path.join(dir, 'source.cache');
        await fs.writeFile(inputFile, 'source');
        const options = {inputFile, cacheBasePath: path.join(dir, 'result'), format: 'pdf',
            sourceFileName: 'book.fb2', downFileName: 'book.fb2', config: {conversionEnabled: true}};
        const cached = await converter.getConversionCacheInfo(options);
        const first = converter.prepareConvertedFile(options);
        await entered;
        assert.strictEqual(await fs.pathExists(cached.filePath), false);
        const second = converter.prepareConvertedFile(options);
        await sleep(30);
        assert.strictEqual(calls, 1);
        release();
        await Promise.all([first, second]);
        assert.strictEqual(await fs.readFile(cached.filePath, 'utf8'), 'complete');
        fail = true;
        await assert.rejects(converter.convert({inputFile, outputFile: cached.filePath, format: 'pdf', sourceFileName: 'book.fb2'}), /conversion failed/);
        assert.strictEqual(await fs.readFile(cached.filePath, 'utf8'), 'complete');
        assert.ok(!(await fs.readdir(dir)).some(name => /\.input-|\.work-/.test(name)));
    } finally { await fs.remove(dir); }
}

module.exports = [testConversionQueueLimitsAndRecovery, testConverterProcessTimeoutAndBoundedErrors,
    testOpdsAuthenticationRateLimit, testConversionPublishesOnlyCompletedFiles];
