'use strict';

const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const {setTimeout: sleep} = require('node:timers/promises');
const yazl = require('yazl');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '../..');

async function stageRuntime(directory) {
    const runtime = path.join(directory, 'runtime');
    for (const part of ['server', 'shared', 'package.json', 'build/appdir.js'])
        await fs.copy(path.join(root, part), path.join(runtime, part));
    await fs.writeFile(path.join(runtime, 'server/config/application_env'), 'production');
    const zip = new yazl.ZipFile(), chunks = [];
    zip.addBuffer(Buffer.from('<html lang="ru"></html>'), 'index.html');
    zip.end();
    for await (const chunk of zip.outputStream) chunks.push(chunk);
    await fs.outputJson(path.join(runtime, 'dist/public.json'), {data:Buffer.concat(chunks).toString('base64')});
}

async function fixture(library, count, revision = 0) {
    const zip = new yazl.ZipFile();
    const target = path.join(library, 'test.inpx');
    const done = pipeline(zip.outputStream, fs.createWriteStream(target + '.tmp'));
    zip.addBuffer(Buffer.from('Android large-index fixture'), 'collection.info');
    zip.addBuffer(Buffer.from('AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER'), 'structure.info');
    zip.addBuffer(Buffer.from('2026111' + revision), 'version.info');
    for (let offset = 1; offset <= count; offset += 2000) {
        const rows = [];
        for (let i = offset; i < offset + 2000 && i <= count; i++) {
            if (revision && i === 2) continue;
            const author = 'Автор ' + (i % 71317) + (i % 5 === 0 ? ':Соавтор ' + i % 917 : '');
            const title = i === 1 ? (revision ? 'Сменённое Заглавие' : 'Уникальный Маркер') :
                'Книга ' + (i % 52991).toString(36) + ' приключение ' + i.toString(36) + ' исследование';
            rows.push([author, 'sf:adventure:', title, i % 4 ? '' : 'Цикл ' + (i % 9117), i % 10,
                i, 1048, i, i % 79 === 0 ? 1 : 0, 'fb2', '2026-11-10', i % 21 ? 'ru' : 'en', i % 5,
                'образец', 'part-' + offset + '.zip'].join('\x04'));
        }
        zip.addBuffer(Buffer.from(rows.join('\n') + '\n'), 'part-' + offset + '.inp');
        if (offset % 20000 === 1) await sleep(1);
    }
    zip.end();
    await done;
    await fs.move(target + '.tmp', target, {overwrite:true});
}

async function port() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const value = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return value;
}

async function search(url, title) {
    const response = await fetch(url + '/ebook?q=' + encodeURIComponent(title), {signal:AbortSignal.timeout(30000)});
    assert.equal(response.status, 200);
    const html = await response.text();
    const result = [...html.matchAll(/<h3><a href="([^"]*\/ebook\/book\?[^"]+)">([^<]+)<\/a><\/h3>/g)]
        .find(match => match[2] === title);
    assert.ok(result, 'Search must return an indexed book: ' + title);
    const uid = new URL(result[1].replace(/&amp;/g, '&'), url).searchParams.get('uid');
    assert.ok(uid, 'Search result must link to a book by UID');
    return uid;
}

async function browse(url, query, expected) {
    await new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', {origin:url});
        const finish = error => {
            clearTimeout(timer);
            socket.terminate();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Book list did not respond')), 90000);
        socket.once('error', finish);
        socket.once('open', () => socket.send(JSON.stringify({
            action:'bookSearch', requestId:'browse', query:{...query, offset:0, limit:20},
        })));
        socket.on('message', raw => {
            try {
                const message = JSON.parse(raw);
                if (message.requestId !== 'browse' || message._rok || message._progress) return;
                assert.ok(!message.error, message.error);
                assert.equal(message.totalFound, expected);
                assert.equal(message.found.length, Math.min(20, expected));
                finish();
            } catch (error) {finish(error);}
        });
    });
}

async function run(directory, name, heap, body) {
    const dataDir = path.join(directory, 'data'), library = path.join(directory, 'library');
    const config = path.join(directory, 'config.json'), listener = await port();
    await fs.ensureDir(dataDir);
    await fs.writeJson(config, {lowMemoryMode:true, fullOptimization:false, dbCacheSize:32, queryCacheMemSize:8388608,
        authExemptHealth:true, loggingEnabled:false});
    const env = {...process.env, NODE_PATH:path.join(root, 'node_modules'), INPX_LIBRARY_SOURCES:'', LIBRARY_SOURCES:'',
        INPX_INSTALL_MODE:process.env.INPX_TEST_NATIVE === '1' ? 'native' : 'android',
        INPX_REQUIRE_AUTH:'false', INPX_AUTH_MODE:'local', INPX_ALLOW_ANONYMOUS_ACCESS:'true',
        INPX_ENABLE_CONVERSION:'false', INPX_ADMIN_PASSWORD:'local-index-fixture'};
    const output = fs.createWriteStream(path.join(directory, name + '.log'));
    const child = spawn(process.execPath, ['--max-old-space-size=' + heap, '--expose-gc',
        path.join(directory, 'runtime/server/index.js'), '--data-dir=' + dataDir, '--lib-dir=' + library,
        '--config=' + config, '--host=127.0.0.1', '--port=' + listener],
    {env, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']});
    let ended = false, exit, tail = '', reported = 0;
    const closed = new Promise(resolve => {
        child.once('close', (code, signal) => {ended = true; exit = {code, signal}; resolve();});
        child.once('error', error => {ended = true; exit = {error:error.message}; resolve();});
    });
    const report = chunk => {
        output.write(chunk);
        tail = (tail + chunk).slice(-16000);
        const progress = [...String(chunk).matchAll(/processed (\d+) records/g)].at(-1);
        if (progress && Number(progress[1]) >= reported + 100000) {
            reported = Number(progress[1]); console.log(name, 'records:', reported);
        }
    };
    child.stdout.on('data', report); child.stderr.on('data', report);
    const url = 'http://127.0.0.1:' + listener, started = Date.now(), deadline = started + 45 * 60000;
    try {
        let index;
        while (!ended && Date.now() < deadline) {
            try {
                const result = await fetch(url + '/ready', {signal:AbortSignal.timeout(3000)});
                if (result.ok && (index = await result.json()).ready) break;
            } catch { /* server still starting */ }
            await sleep(500);
        }
        assert.ok(index?.ready, name + ' did not become ready: ' + JSON.stringify(exit) + '\n' + tail);
        const result = await body(url, dataDir);
        console.log(name, 'passed in', ((Date.now() - started) / 1000).toFixed(1), 's');
        return result;
    } finally {
        if (!ended) child.kill();
        await closed;
        await new Promise(resolve => output.end(resolve));
    }
}

async function main() {
    const count = Number(process.argv[2] || 650000);
    assert(Number.isSafeInteger(count) && count >= 3 && count <= 2000000);
    const heap = Number(process.env.INPX_TEST_HEAP_MB || 512);
    const output = path.resolve(process.argv[3] || 'output/android-large-index');
    await fs.ensureDir(output);
    const directory = await fs.mkdtemp(path.join(output, 'run-'));
    const library = path.join(directory, 'library');
    await fs.ensureDir(library);
    console.log('Fixture:', directory, 'records:', count, 'old-space MiB:', heap);
    await stageRuntime(directory);
    await fixture(library, count);
    const orphan = path.join(directory, 'data/db.building-0123456789abcdef');
    await fs.outputFile(path.join(orphan, 'interrupted'), '');
    const inspect = async(url, title, expected) => {
        const result = await fetch(url + '/api/index-status');
        const info = await result.json();
        assert.equal(info.stats?.bookCountAll, expected, 'All INPX records must be indexed');
        if (process.env.INPX_TEST_NATIVE !== '1')
            assert(!await fs.pathExists(orphan), 'Staging left by an interrupted import must be cleaned');
        return search(url, title);
    };
    const first = await run(directory, 'first', heap, async url => {
        const uid = await inspect(url, 'Уникальный Маркер', count);
        if (process.argv.includes('--browse')) {
            await browse(url, {del:'0'}, count - Math.floor(count / 79));
            // With no filters, the server also has to scan the book table.
            if (count <= 10000) await browse(url, {}, count);
        }
        return uid;
    });
    if (process.argv.includes('--update')) {
        await fixture(library, count, 1);
        const second = await run(directory, 'update', heap,
            url => inspect(url, 'Сменённое Заглавие', count - 1));
        assert.ok(first && second, 'Fixture should expose book detail URLs');
        assert.equal(second, first, 'Metadata update preserves the book URL');
    }
    console.log('PASS: full index, readiness and search', directory);
}

main().catch(error => {console.error(error.stack); process.exitCode = 1;});
