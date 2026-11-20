const assert = require('node:assert/strict');
const {sessionCookieHeader} = require('./test-session-cookie');
const {execFileSync, spawn} = require('node:child_process');
const {once, on} = require('node:events');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const {setTimeout:delay} = require('node:timers/promises');
const WebSocket = require('ws');
const {createFixture, unusedPort} = require('./binary-smoke-test');

async function menuFormats(url, cookie) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', {headers:{cookie, origin:url}});
    const signal = AbortSignal.timeout(15000);
    try {
        await once(socket, 'open', {signal});
        const replies = on(socket, 'message', {signal, close:['close']});
        socket.send(JSON.stringify({action:'get-config', requestId:'pdf-test'}));
        for await (const [message] of replies) {
            const config = JSON.parse(message);
            if (config._rok || config.requestId !== 'pdf-test') continue;
            assert.ok(Array.isArray(config.conversionFormats), config.error);
            return config.conversionFormats;
        }
        throw new Error('WebSocket closed before get-config');
    } finally { socket.terminate(); }
}

async function check(directory, temp, tool, present) {
    const library = path.join(temp, 'library');
    await createFixture(library, {defaultConversionFormats:true});
    const configFile = path.join(library, 'config.json');
    const config = await fs.readJson(configFile);
    delete config.conversionFormats;
    // A developer machine or a CI runner may have a system-wide fallback.
    if (!present && (fs.existsSync('/usr/bin/mutool') || fs.existsSync('/usr/local/bin/mutool')))
        config.converterPaths = {mutool:path.join(temp, 'missing-mutool')};
    await fs.writeJson(configFile, config);
    const port = await unusedPort();
    const url = 'http://127.0.0.1:' + port;
    const env = {...process.env, INPX_ENABLE_CONVERSION:'true', INPX_REQUIRE_AUTH:'false',
        INPX_ALLOW_ANONYMOUS_ACCESS:'true', INPX_ADMIN_PASSWORD:'local-smoke-fixture'};
    delete env.INPX_CONVERSION_FORMATS;
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = temp;
    const server = spawn(path.join(directory, process.platform === 'win32' ? 'inpx-web.exe' : 'inpx-web'),
        ['--host=127.0.0.1', '--port=' + port, '--config=' + configFile,
            '--lib-dir=' + library, '--data-dir=' + path.join(temp, 'state')], {cwd:temp, env, stdio:'ignore'});
    const exited = once(server, 'exit');
    try {
        let ready = false;
        for (let i = 0; i < 200 && server.exitCode === null; i++) {
            try {
                const response = await fetch(url + '/ready', {signal:AbortSignal.timeout(2000)});
                ready = response.ok && (await response.json()).ready;
            } catch {}
            if (ready) break;
            await delay(200);
        }
        assert(ready, 'Packaged server must become ready');
        const login = await fetch(url + '/ebook/login');
        const cookie = sessionCookieHeader(login)?.split(';')[0];
        await login.body.cancel();
        assert(cookie, 'Expected a browser session');
        const formats = await menuFormats(url, cookie);
        assert.equal(formats.includes('pdf'), present, 'PDF in the web download menu');
        assert(formats.includes('epub'), 'Other formats remain available');
        for (const title of ['Packaged smoke book', 'EPUB original']) {
            const result = await fetch(url + '/ebook?' + new URLSearchParams({q:title}));
            const uid = (await result.text()).match(/[?&](?:amp;)?uid=([^"&]+)/)?.[1];
            assert(uid, 'Expected search result for ' + title);
            const query = new URLSearchParams({uid:decodeURIComponent(uid)});
            const card = await fetch(url + '/ebook/book?' + query);
            assert.equal((await card.text()).includes('value="pdf"'), present, title + ' ebook menu');
            if (!present) continue;
            query.set('format', 'pdf');
            const pdf = await fetch(url + '/book/by-uid?' + query, {headers:{cookie}, signal:AbortSignal.timeout(40000)});
            assert.equal(pdf.status, 200, title);
            assert.match(pdf.headers.get('content-type'), /^application\/pdf\b/);
            const bytes = Buffer.from(await pdf.arrayBuffer());
            assert.equal(bytes.toString('ascii', 0, 5), '%PDF-');
            const file = path.join(temp, 'download.pdf');
            await fs.writeFile(file, bytes);
            assert.match(execFileSync(tool, ['info', file], {encoding:'utf8'}), /^Pages: [1-9]\d*$/m);
        }
    } finally {
        server.kill();
        const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
        try { await exited; } finally { clearTimeout(timer); }
    }
}

async function main() {
    const directory = path.resolve(process.argv[2]);
    const tool = path.join(directory, 'bin', process.platform === 'win32' ? 'mutool.exe' : 'mutool');
    await fs.access(path.join(directory, 'bin', 'LICENSE.mupdf'));
    if (process.platform === 'linux') {
        const elf = execFileSync('readelf', ['-lWd', tool], {encoding:'utf8', env:{...process.env, LC_ALL:'C'}});
        assert.doesNotMatch(elf, /\bINTERP\b|\(NEEDED\)/, 'Linux mutool must run without host libraries');
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-pdf-'));
    process.env.INPX_SMOKE_EPUB = 'true'; // Include both source formats in the test library.
    try {
        await check(directory, path.join(temp, 'bundled'), tool, true);
        console.log('Bundled mutool: PDF offered, FB2 and EPUB downloaded as PDF');
        await fs.rename(tool, tool + '.test-disabled');
        try {
            await check(directory, path.join(temp, 'missing'), tool, false);
            console.log('Missing mutool: PDF hidden in web and ebook menus for both source formats');
        } finally { await fs.rename(tool + '.test-disabled', tool); }
    } finally { await fs.remove(temp); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
