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
    let rows = row.join('\x04') + '\n';
    const books = new yazl.ZipFile();
    const bookDone = require('stream/promises').pipeline(books.outputStream, fs.createWriteStream(path.join(dir, 'smoke.zip')));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=';
    books.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Packaged smoke book</book-title><lang>en</lang></title-info></description><body><section><p>Smoke text</p><image l:href="#illustration"/></section></body><binary id="illustration" content-type="image/png">'+png+'</binary></FictionBook>'), '1.fb2');
    if (process.env.INPX_SMOKE_EPUB === 'true') {
        const epubFile = path.join(dir, 'original.epub'); await require('./epub-fb2-tests').fixture(epubFile);
        const epubData = await fs.readFile(epubFile);
        books.addBuffer(epubData, '2.epub');
        const epubRow = [...row]; epubRow[2] = 'EPUB original'; epubRow[5] = '2'; epubRow[6] = String(epubData.length); epubRow[7] = '2'; epubRow[9] = 'epub'; epubRow[11] = 'ru';
        rows += epubRow.join('\x04') + '\n';
    }
    books.end(); await bookDone;
    zip.addBuffer(Buffer.from(rows), 'smoke.inp');
    zip.end();
    await complete;
    const ratings = new yazl.ZipFile();
    await fs.ensureDir(path.join(dir,'reviews'));
    const ratingOutput = fs.createWriteStream(path.join(dir,'reviews','additional.zip'));
    const ratingDone = require('stream/promises').pipeline(ratings.outputStream,ratingOutput);
    ratings.addBuffer(Buffer.from(JSON.stringify([{folder:'smoke.zip',file:'1.fb2',sum:5,count:1}])),'books.json');
    ratings.end(); await ratingDone;
    await fs.writeJson(path.join(dir, 'opds-feeds.json'), {version:1, shelves:[
        {id:'smoke', name:'Shared smoke shelf', filters:{lang:'en'}},
    ]});
    await fs.writeJson(path.join(dir, 'config.json'), {
        loggingEnabled: false,
        opds: {enabled: true, auth: false},
        adminPassword: 'local-smoke-fixture',
        onlineReaderEnabled: true,
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
        let epubUid;
        const timer = setTimeout(() => finish(new Error('WebSocket response timed out')), 60000);
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
                if (response.requestId === 'smoke') {
                    assert.match(response.message, /inpx-web/);
                    socket.send(JSON.stringify({action:'search',from:'title',query:{ratingCount:'1'},requestId:'ratings'}));
                } else if (response.requestId === 'ratings') {
                    assert.strictEqual(response.totalFound,1,'Packaged ratings search must load its streaming JSON dependency');
                    socket.send(JSON.stringify({action: 'catalog-suggest', options: {query: 'Packaged'}, requestId: 'suggestions'}));
                } else if (response.requestId === 'suggestions') {
                    if (response.warming) {
                        setTimeout(() => {if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({action: 'catalog-suggest', options: {query: 'Packaged'}, requestId: 'suggestions'}));}, 100);
                        return;
                    }
                    assert.strictEqual(response.groups.find(group => group.kind === 'title').items[0].book.title, 'Packaged smoke book');
                    socket.send(JSON.stringify({action: 'catalog-browse', options: {kind: 'author'}, requestId: 'authors'}));
                } else if (response.requestId === 'authors') {
                    assert.strictEqual(response.total, 1);
                    socket.send(JSON.stringify({action: 'catalog-entity', options: {kind: 'author', name: response.items[0].name}, requestId: 'author-page'}));
                } else if (response.requestId === 'author-page') {
                    assert.strictEqual(response.total, process.env.INPX_SMOKE_EPUB === 'true' ? 2 : 1);
                    assert(response.books.some(book => book.title === 'Packaged smoke book'));
                    if (process.env.INPX_SMOKE_EPUB === 'true') {
                        const epub = response.books.find(book => book.ext === 'epub'); assert(epub);
                        epubUid = epub._uid;
                    }
                    const book = response.books.find(book => book.ext === 'fb2'); assert(book);
                    socket.send(JSON.stringify({action:'get-book-gallery', bookUid:book._uid, requestId:'gallery'}));
                } else if (response.requestId === 'gallery') {
                    assert.strictEqual(response.images.length, 1, 'Packaged gallery includes its bounded parser and original FB2 image');
                    assert.strictEqual(response.images[0].id, 'illustration');
                    assert.strictEqual(response.images[0].contentType, 'image/png');
                    assert(Buffer.from(response.images[0].data, 'base64').length > 0);
                    if (epubUid) socket.send(JSON.stringify({action:'get-book-info', bookUid:epubUid, readerOnly:true, requestId:'epub-reader'}));
                    else finish();
                } else if (response.requestId === 'epub-reader') {
                    const document = JSON.stringify(response.bookInfo.fb2);
                    assert.match(document, /Текст второй главы/);
                    assert.match(document, /fictionbook/i);
                    assert.equal(response.bookInfo.book.ext, 'epub');
                    console.log('ok packaged EPUB original → FB2 reader with image default formats'); finish();
                }
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
                '-e', 'INPX_OPDS_FEEDS_FILE=/library/opds-feeds.json',
                '--mount', `type=bind,source=${library},target=/library,readonly`, imageName,
                'sh', '-c', 'cp /library/config.json /data/config.json && exec inpx-web --data-dir=/data --config=/data/config.json --lib-dir=/library --host=0.0.0.0 --port=12380'];
        } else {
            command = path.resolve(target);
            args = [`--data-dir=${path.join(dir, 'data')}`, `--lib-dir=${library}`,
                `--config=${path.join(library, 'config.json')}`, '--host=127.0.0.1', `--port=${port}`];
        }
        const env = {...process.env, INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
            INPX_OPDS_FEEDS_FILE:path.join(library, 'opds-feeds.json'),
            INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS:'true',
            INPX_ENABLE_CONVERSION: process.env.INPX_SMOKE_EPUB === 'true' ? 'true' : 'false'};
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
        assert.strictEqual(home.headers.get('x-robots-tag'),'noindex, nofollow');
        assert.match(await home.text(), /<html/i);
        assert.match(await (await fetch(`${url}/robots.txt`)).text(),/Disallow: \/\s*$/);
        const opds = await fetch(`${url}/opds`);
        assert.strictEqual(opds.status, 200);
        assert.match(await opds.text(), /Shared smoke shelf/);
        const shelf = await fetch(`${url}/opds/catalog-shelves?id=smoke`);
        assert.strictEqual(shelf.status, 200);
        assert.match(await shelf.text(), /Packaged smoke book/);
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
