const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const net = require('net');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const {setTimeout: sleep} = require('timers/promises');
const WebSocket = require('ws');
const yazl = require('yazl');

async function createFixture(dir) {
    await fs.ensureDir(dir);
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(path.join(dir, 'smoke.inpx'));
    const complete = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        zip.outputStream.on('error', reject);
    });
    zip.outputStream.pipe(output);
    zip.addBuffer(Buffer.from('Smoke library\n'), 'collection.info');
    zip.addBuffer(Buffer.from('20260914'), 'version.info');
    const row = ['Tester,Smoke:', 'sf:', 'Packaged smoke book', '', '0', '1', '100', '1', '0', 'fb2', '2026-09-14', 'en', '0', ''];
    zip.addBuffer(Buffer.from(row.join('\x04') + '\n'), 'smoke.inp');
    zip.end();
    await complete;
    await fs.writeJson(path.join(dir, 'config.json'), {
        loggingEnabled: false,
        opds: {enabled: true, auth: false},
        adminPassword: 'local-smoke-fixture',
    });
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function checkWebSocket(url) {
    await new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace(/^http/, 'ws'));
        const timer = setTimeout(() => finish(new Error('WebSocket response timed out')), 10000);
        const finish = error => {
            clearTimeout(timer);
            socket.terminate();
            if (error) reject(error);
            else resolve();
        };
        socket.once('error', finish);
        socket.once('open', () => socket.send(JSON.stringify({action: 'test', requestId: 'smoke'})));
        socket.on('message', raw => {
            try {
                const response = JSON.parse(raw);
                if (response._rok) return;
                assert.ok(!response.error, response.error);
                assert.match(response.message, /inpx-web/);
                finish();
            } catch (error) {
                finish(error);
            }
        });
    });
}

async function main() {
    const [target, imageName] = process.argv.slice(2);
    if (!target || (target === '--image' && !imageName))
        throw new Error('Usage: node scripts/binary-smoke-test.js <binary> | --image <local-image>');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-binary-smoke-'));
    const library = path.join(dir, 'library');
    const containerName = `inpx-smoke-${process.pid}-${Date.now()}`;
    let child;
    let exited;
    let output = '';
    try {
        await createFixture(library);
        const port = await unusedPort();
        let command;
        let args;
        if (target === '--image') {
            command = 'docker';
            args = ['run', '--rm', '--name', containerName,
                '-p', `127.0.0.1:${port}:12380`, '--tmpfs', '/data',
                '--mount', `type=bind,source=${library},target=/library,readonly`, imageName,
                'sh', '-c', 'cp /library/config.json /data/config.json && exec inpx-web --data-dir=/data --config=/data/config.json --lib-dir=/library --host=0.0.0.0 --port=12380'];
        } else {
            command = path.resolve(target);
            args = [`--data-dir=${path.join(dir, 'data')}`, `--lib-dir=${library}`,
                `--config=${path.join(library, 'config.json')}`, '--host=127.0.0.1', `--port=${port}`];
        }
        const env = {...process.env, INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
            INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ENABLE_CONVERSION: 'false'};
        child = spawn(command, args, {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        exited = new Promise(resolve => {
            child.once('exit', resolve);
            child.once('error', error => { output += error.message; resolve(); });
        });
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', data => { output = (output + data).slice(-16000); });
        const url = `http://127.0.0.1:${port}`;
        let ready = false;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && child.exitCode === null) {
            try {
                const response = await fetch(`${url}/ready`, {signal: AbortSignal.timeout(2000)});
                if (response.ok && (await response.json()).ready) {
                    ready = true;
                    break;
                }
            } catch (error) { /* Startup may not have bound the port yet. */ }
            await sleep(250);
        }
        assert.ok(ready, `Packaged application did not index the fixture and become ready:\n${output}`);
        const health = await fetch(`${url}/health`);
        assert.strictEqual(health.status, 200);
        assert.strictEqual((await health.json()).version, require('../package.json').version);
        const home = await fetch(url);
        assert.strictEqual(home.status, 200);
        assert.match(await home.text(), /<html/i);
        const opds = await fetch(`${url}/opds`);
        assert.strictEqual(opds.status, 200);
        assert.match(await opds.text(), /<feed/);
        await checkWebSocket(url);
        console.log(`ok packaged application: indexing, health, web UI, OPDS, WebSocket (${target === '--image' ? imageName : target})`);
    } finally {
        if (target === '--image')
            await promisify(execFile)('docker', ['rm', '-f', containerName], {windowsHide: true, timeout: 15000}).catch(() => {});
        if (child && child.exitCode === null)
            child.kill();
        if (exited) {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            try { await exited; } finally { clearTimeout(timer); }
        }
        await fs.remove(dir);
    }
}

module.exports = {createFixture, unusedPort};
if (require.main === module)
    main().catch(error => { console.error(error); process.exitCode = 1; });
