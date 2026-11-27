const assert = require('assert');
const {sessionCookieHeader} = require('./test-session-cookie');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const net = require('net');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const {setTimeout: sleep} = require('timers/promises');
const {createHash} = require('node:crypto');
const WebSocket = require('ws');
const yazl = require('yazl');
const rustPrograms = require('../server/core/RustPrograms');

async function isolateNativeJxl(binary, directory) {
    const bundledTools = path.join(path.dirname(binary), 'bin');
    const binDir = path.join(directory, 'bin');
    await fs.ensureDir(binDir);
    const executable = path.join(directory, path.basename(binary));
    await fs.copyFile(binary, executable);
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
    await fs.copyFile(path.join(bundledTools, 'inpx-jxl.node'), path.join(binDir, 'inpx-jxl.node'));
    const authState = require('../server/core/RustAuthState').fileName;
    await fs.copyFile(path.join(bundledTools,authState),path.join(binDir,authState));
    for (const program of ['server','catalog','reader']) {
        const name = rustPrograms.fileName(program);
        const input = path.join(bundledTools,name);
        if (!await fs.pathExists(input)) continue;
        const output = path.join(binDir,name);
        await fs.copyFile(input,output);
        if (process.platform!=='win32') await fs.chmod(output,0o755);
    }
    if (process.env.INPX_SMOKE_EPUB === 'true') {
        const suffix = process.platform === 'win32' ? '.exe' : '';
        for (const tool of [`fbc${suffix}`, `kindling${suffix}`]) {
            const source = path.join(bundledTools, tool);
            if (await fs.pathExists(source)) await fs.copy(source, path.join(binDir, tool));
        }
    }
    return executable;
}

async function checkCoverDownload(url, uid, jxlCover) {
    const location = `${url}/cover/by-uid?${new URLSearchParams({uid})}`;
    const response = await fetch(location, {signal: AbortSignal.timeout(30000)});
    if (response.status !== 200)
        throw new Error(`Packaged cover returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    assert.match(response.headers.get('content-type'), /^image\/png$/);
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepStrictEqual(png.subarray(0, 16), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const size = jxlCover ? 192 : 1;
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    if (process.env.INPX_SMOKE_REQUIRE_RUST_HTTP==='true') {
        const cached = await fetch(location,{signal:AbortSignal.timeout(30000)});
        assert.equal(cached.status,200);
        assert.equal(cached.headers.get('x-powered-by'),null,'Rust serves the cached cover');
        assert.deepEqual(Buffer.from(await cached.arrayBuffer()),png);
    }
    console.log(jxlCover ? 'ok packaged JPEG XL cover decoded over HTTP' : 'ok packaged embedded PNG cover over HTTP');
}

async function createFixture(dir, {nativeJxlCover = false, extendedJxlBox = false, disableDjxl = false, extraEpubs = [], defaultConversionFormats = false, includeEpubScript = true} = {}) {
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
    // Keep the 1×1 fixture distinct from the JXL cover and decodable by fb2cng.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    books.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Packaged smoke book</book-title><coverpage><image l:href="#cover"/></coverpage><lang>en</lang></title-info></description><body><section><p>Smoke text</p><p>Second paragraph for reader synchronization.</p><image l:href="#illustration"/></section></body><binary id="illustration" content-type="image/png">'+png+'</binary><binary id="cover" content-type="image/png">'+png+'</binary></FictionBook>'), '1.fb2');
    if (process.env.INPX_SMOKE_EPUB === 'true') {
        const epubFile = path.join(dir, 'original.epub');
        await require('./epub-fb2-tests').fixture(epubFile, [], {}, {includeScript:includeEpubScript});
        const epubData = await fs.readFile(epubFile);
        books.addBuffer(epubData, '2.epub');
        const epubRow = [...row]; epubRow[2] = 'EPUB original'; epubRow[5] = '2'; epubRow[6] = String(epubData.length); epubRow[7] = '2'; epubRow[9] = 'epub'; epubRow[11] = 'ru';
        rows += epubRow.join('\x04') + '\n';
    }
    for (const [index, [title, data]] of extraEpubs.entries()) {
        const id = String(index + 3);
        books.addBuffer(data,id+'.epub');
        const entry = [...row];
        entry[2] = title; entry[5] = id; entry[6] = String(data.length); entry[7] = id; entry[9] = 'epub';
        rows += entry.join('\x04') + '\n';
    }
    books.end(); await bookDone;
    if (nativeJxlCover) {
        const coverDir = path.join(dir, 'covers');
        await fs.ensureDir(coverDir);
        const covers = new yazl.ZipFile();
        const coversDone = require('stream/promises').pipeline(covers.outputStream, fs.createWriteStream(path.join(coverDir, 'smoke.zip')));
        let cover = require('../server/core/benchmarkFixture');
        if (extendedJxlBox) {
            // Signature and ftyp, followed by a codestream box with a 64-bit length.
            const header = Buffer.from('0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000016a786c63', 'hex');
            const length = Buffer.alloc(8);
            length.writeBigUInt64BE(BigInt(16 + cover.length));
            cover = Buffer.concat([header, length, cover]);
        }
        covers.addBuffer(cover, '1');
        covers.end();
        await coversDone;
    }
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
        ...(disableDjxl ? {converterPaths:{djxl:path.join(dir,'missing-djxl')}} : {}),
        ...(!defaultConversionFormats && process.env.INPX_SMOKE_EPUB === 'true' ? {conversionFormats:['fb2','epub']} : {}),
    });
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function checkWebSocket(url, rust) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace(/^http/, 'ws'),rust ? {headers:{origin:url}} : {});
        let bookUid;
        let epubUid;
        const timer = setTimeout(() => finish(new Error('WebSocket response timed out')), 60000);
        const finish = error => {
            clearTimeout(timer);
            socket.terminate();
            if (error) reject(error);
            else resolve({bookUid,link});
        };
        let link;
        socket.once('error', finish);
        socket.once('open', () => socket.send(JSON.stringify({action: 'test', requestId: 'smoke'})));
        socket.on('message', raw => {
            try {
                const response = JSON.parse(raw);
                if (response._rok) return;
                assert.ok(!response.error, response.error);
                if (response.requestId === 'smoke') {
                    assert.match(response.message, /inpx-web/);
                    const next = rust ? {action:'bookSearch',query:{author:'Tester Smoke'},requestId:'native-books'}
                        : {action:'search',from:'title',query:{ratingCount:'1'},requestId:'ratings'};
                    socket.send(JSON.stringify(next));
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
                } else if (response.requestId === 'author-page' || response.requestId === 'native-books') {
                    const books = rust ? response.found : response.books;
                    assert.strictEqual(rust ? response.totalFound : response.total, process.env.INPX_SMOKE_EPUB === 'true' ? 2 : 1);
                    assert(books.some(book => book.title === 'Packaged smoke book'));
                    if (process.env.INPX_SMOKE_EPUB === 'true') {
                        const epub = books.find(book => book.ext === 'epub'); assert(epub);
                        epubUid = epub._uid;
                    }
                    const book = books.find(book => book.ext === 'fb2'); assert(book);
                    bookUid = book._uid;
                    socket.send(JSON.stringify({action:'get-book-gallery', bookUid, requestId:'gallery'}));
                } else if (response.requestId === 'gallery') {
                    assert.strictEqual(response.images.length, 1, 'Packaged gallery includes its bounded parser and original FB2 image');
                    assert.strictEqual(response.images[0].id, 'illustration');
                    assert.strictEqual(response.images[0].contentType, 'image/png');
                    assert(Buffer.from(response.images[0].data, 'base64').length > 0);
                    if (epubUid) socket.send(JSON.stringify({action:'get-book-info', bookUid:epubUid, readerOnly:true, requestId:'epub-reader'}));
                    else socket.send(JSON.stringify({action:'get-book-link',bookUid,requestId:'book-link'}));
                } else if (response.requestId === 'epub-reader') {
                    const document = JSON.stringify(response.bookInfo.fb2);
                    assert.match(document, /Текст второй главы/);
                    assert.match(document, /fictionbook/i);
                    assert.equal(response.bookInfo.book.ext, 'epub');
                    console.log('ok packaged EPUB original → FB2 reader with image default formats');
                    socket.send(JSON.stringify({action:'get-book-link',bookUid,requestId:'book-link'}));
                } else if (response.requestId === 'book-link') {
                    assert.match(response.link,/^\/book\/[0-9a-f]{64}$/);
                    link = response.link;
                    finish();
                }
            } catch (error) {
                finish(error);
            }
        });
    });
}

async function checkCachedBookDownload(url,link,directory) {
    const compressed = await fetch(url+link,{headers:{'Accept-Encoding':'gzip'}});
    assert.equal(compressed.status,200);
    assert.equal(compressed.headers.get('content-encoding'),'gzip');
    const bytes = Buffer.from(await compressed.arrayBuffer());
    assert.match(bytes.toString('utf8'),/FictionBook/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),path.posix.basename(link));
    const range = await fetch(url+link,{headers:{'Accept-Encoding':'identity',Range:'bytes=0-15'}});
    assert.equal(range.status,206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(0,16));
    const zipped = await fetch(url+link+'/zip');
    assert.equal(zipped.status,200);
    assert.equal(zipped.headers.get('content-type'),'application/zip');
    if (process.env.INPX_SMOKE_REQUIRE_RUST_HTTP==='true') {
        for (const response of [compressed,range,zipped]) {
            assert.equal(response.headers.get('x-powered-by'),null,'Rust serves the cached book representation');
        }
    }
    const file = path.join(directory,'cached-download.zip');
    await fs.writeFile(file,Buffer.from(await zipped.arrayBuffer()));
    const StreamZip = require('node-stream-zip');
    const zip = new StreamZip.async({file});
    try {
        const names = Object.keys(await zip.entries());
        assert.equal(names.length,1);
        assert.match(names[0],/\.fb2$/i);
        assert.deepEqual(await zip.entryData(names[0]),bytes);
    } finally {await zip.close();}
    console.log('ok packaged cached GZIP, raw range and ZIP contain identical FB2');
}

async function checkEbookProfileDownload(url,html,password='local-smoke-fixture',format=process.env.INPX_SMOKE_EPUB==='true'?'epub':'fb2'){
    const login=await fetch(url+'/ebook/login');
    const cookie=sessionCookieHeader(login).split(';')[0];
    const csrf=(await login.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const post=(path,body)=>fetch(url+path,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
    assert.equal((await post('/ebook/login',{csrf,login:'admin',password})).status,303);
    assert.equal((await post('/ebook/format',{csrf,format})).status,303);
    const shelves=await fetch(url+'/ebook/shelves',{headers:{cookie}});assert.equal(shelves.status,200);assert.match(await shelves.text(),/Мои полки/);
    const encoded=html.match(/[?&](?:amp;)?uid=([^"&]+)/)?.[1];assert(encoded,'The ebook result has a stable UID');
    const card=await fetch(url+'/ebook/book?'+new URLSearchParams({uid:decodeURIComponent(encoded)}),{headers:{cookie}});
    const downloadHref=(await card.text()).match(/class="button" href="([^\"]*\/ebook\/download\/[^\"]+)"/)?.[1];
    assert(downloadHref,'The profile download is an ordinary link');
    let next=new URL(downloadHref.replace(/&amp;/g,'&'),url);assert(next.pathname.endsWith('.'+format));
    next.searchParams.set('format','raw');
    for(let redirects=0;redirects<4;redirects++){
        const step=await fetch(next,{headers:{cookie},redirect:'manual'});
        if(step.status!==302){assert.equal(step.status,200);await step.body.cancel();break;}
        next=new URL(step.headers.get('location'),next);assert(next.pathname.endsWith('.'+format),'Each redirect keeps the actual download extension');await step.body.cancel();
        assert(redirects<3,'The download redirect chain is bounded');
    }
    // An old or manipulated query must not replace the selected profile format.
    const response=await fetch(url+'/ebook/download?'+new URLSearchParams({uid:decodeURIComponent(encoded),format:'raw'}),{headers:{cookie}});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-disposition'),new RegExp('^attachment; filename="[A-Za-z0-9_ -]+\\.'+format+'"$'));
    assert(new URL(response.url).pathname.endsWith('.'+format),'The final URL has the actual file extension');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(format==='epub'){assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.match(response.headers.get('content-type'),/application\/epub\+zip/);}
    else if(format==='mobi'){assert.equal(bytes.toString('ascii',60,68),'BOOKMOBI');assert.match(response.headers.get('content-type'),/application\/x-mobipocket-ebook/);assert.match(response.headers.get('content-disposition'),/filename="[^".]+\.mobi"/);assert.equal(Number(response.headers.get('content-length')),bytes.length);}
    else assert.match(bytes.toString('utf8'),/FictionBook/);
    assert.equal((await post('/ebook/logout',{csrf})).status,303);
    console.log('ok packaged ebook profile → exact '+format.toUpperCase()+' download, no original fallback');
}

async function checkEbookGuestDownload(url,html,format='fb2'){
    const encoded=html.match(/[?&](?:amp;)?uid=([^"&]+)/)?.[1];assert(encoded);
    const card=await fetch(url+'/ebook/book?'+new URLSearchParams({uid:decodeURIComponent(encoded),format}));
    assert.equal(card.status,200);const text=await card.text();
    assert(text.includes('guest-format-form'),'This check uses a guest, not the configured profile');
    assert(!text.includes('action="'+new URL(url).pathname+'/book/by-uid"'),'The guest form must apply an HTML selection before downloading');
    const href=text.match(/class="button" href="([^\"]*\/ebook\/download\/[^\"]+)"/)?.[1];assert(href);
    const cookie=sessionCookieHeader(card)?.split(';')[0]||'';
    let next=new URL(href.replace(/&amp;/g,'&'),url),response;
    assert(next.pathname.endsWith('.'+format),'The first guest download URL includes the actual extension');
    for(let redirects=0;redirects<4;redirects++){
        response=await fetch(next,{headers:{cookie,'user-agent':'Mozilla/5.0 (Linux; U; en-US) AppleWebKit/534.26 Version/4.0 Kindle/3.0+'},redirect:'manual'});
        if(response.status!==302)break;
        next=new URL(response.headers.get('location'),next);assert(next.pathname.endsWith('.'+format),'Every guest redirect keeps the actual extension');await response.body.cancel();
    }
    if(response.status!==200)throw new Error('Guest '+format+' download returned HTTP '+response.status+': '+(await response.text()).slice(0,800));
    assert.match(response.headers.get('content-disposition'),new RegExp('^attachment; filename="[A-Za-z0-9_ -]+\\.'+format+'"$'));
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),bytes.length);
    if(format==='mobi'){assert.equal(bytes.toString('ascii',60,68),'BOOKMOBI');assert.match(response.headers.get('content-type'),/application\/x-mobipocket-ebook/);}
    else assert.match(bytes.toString('utf8'),/FictionBook/);
    console.log('ok packaged ebook guest → typed '+format.toUpperCase()+' URLs, exact headers/body, no original fallback');
}

async function main() {
    const options = process.argv.slice(2);
    const rust = options.includes('--rust');
    const requireConverters = options.includes('--require-converters');
    const [target, argument] = options.filter(value=>!['--rust','--require-converters','--bundled-djxl'].includes(value));
    const binary = target && target !== '--image' ? path.resolve(target) : null;
    const imageName = target === '--image' ? argument : null;
    const allowMissingNativeJxl = argument === '--allow-missing-native-jxl';
    const requireRustCatalogue = rust || process.env.INPX_SMOKE_REQUIRE_RUST_CATALOG==='true';
    const requireRustHttp = rust || process.env.INPX_SMOKE_REQUIRE_RUST_HTTP==='true';
    if (!target || (target === '--image' && !imageName))
        throw new Error('Usage: node scripts/binary-smoke-test.js <binary> [--allow-missing-native-jxl] | --image <local-image> [--rust]');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-binary-smoke-'));
    const library = path.join(dir, 'library');
    const containerName = `inpx-smoke-${process.pid}-${Date.now()}`;
    let child;
    let exited;
    let output = '';
    try {
        const nativeJxlCover = !rust && binary !== null && (!allowMissingNativeJxl
            || await fs.pathExists(path.join(path.dirname(binary), 'bin', 'inpx-jxl.node')));
        const jxlCover = nativeJxlCover || rust || options.includes('--bundled-djxl');
        await createFixture(library, {nativeJxlCover:jxlCover, extendedJxlBox:rust && Boolean(imageName),
            disableDjxl:Boolean(rust && binary), defaultConversionFormats:requireConverters});
        const port = await unusedPort();
        let command, cwd;
        let args;
        if (target === '--image') {
            command = 'docker';
            args = ['run', '--rm', '--name', containerName,
                '-p', `127.0.0.1:${port}:12380`, '--tmpfs', '/data',
                '-e', 'INPX_OPDS_FEEDS_FILE=/library/opds-feeds.json',
                '-e', 'INPX_ADMIN_PASSWORD=local-smoke-fixture',
                '-e', 'INPX_KOSYNC_ENABLED=true',
                ...(process.env.INPX_SMOKE_EPUB === 'true' ? [
                    '-e', 'INPX_ENABLE_CONVERSION=true', '-e', 'INPX_CONVERSION_FORMATS=fb2,epub',
                ] : []),
                '--mount', `type=bind,source=${library},target=/library,readonly`];
            if (rust) {
                args.push('-e','DATA_DIR=/data','-e','LIBDIR=/library','-e','INPX=/library/smoke.inpx',imageName);
            } else {
                args.push(imageName,'sh','-c','cp /library/config.json /data/config.json && exec inpx-web --data-dir=/data --config=/data/config.json --lib-dir=/library --host=0.0.0.0 --port=12380');
            }
        } else {
            command = binary;
            if (rust) cwd = dir;
            if (nativeJxlCover) {
                cwd = path.join(dir, 'standalone');
                command = await isolateNativeJxl(binary, cwd);
            }
            args = [`--data-dir=${path.join(dir, 'data')}`, `--lib-dir=${library}`,
                `--config=${path.join(library, 'config.json')}`, '--host=127.0.0.1', `--port=${port}`];
        }
        const env = {...process.env, INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
            INPX_ADMIN_PASSWORD:'local-smoke-fixture',
            INPX_KOSYNC_ENABLED:'true',
            INPX_OPDS_FEEDS_FILE:path.join(library, 'opds-feeds.json'),
            INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS:'true',
            INPX_ENABLE_CONVERSION: process.env.INPX_SMOKE_EPUB === 'true' ? 'true' : 'false'};
        if (nativeJxlCover || rust && binary) {
            for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
            env.PATH = rust ? '' : cwd;
            if (rust) {
                // Standalone must decode this sidecar with no decoder flag or djxl.
                delete env.INPX_JXL_DECODER;
            } else {
                env.INPX_JXL_DECODER = 'native';
            }
        }
        if (requireRustCatalogue) {
            delete env.INPX_RUST_READER_BINARY;
            delete env.INPX_RUST_CATALOG_BINARY;
        }
        if(process.env.INPX_SMOKE_EPUB==='true'){delete env.INPX_MOBI_ENABLED;env.INPX_CONVERSION_FORMATS='fb2,epub';}
        if (requireConverters) {
            delete env.INPX_ENABLE_CONVERSION;
            delete env.INPX_MOBI_ENABLED;
            delete env.INPX_CONVERSION_FORMATS;
            delete env.INPX_KINDLING_PATH;
        }
        child = spawn(command, args, {cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        exited = new Promise(resolve => {
            child.once('exit', resolve);
            child.once('error', error => { output += error.message; resolve(); });
        });
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', data => { output = (output + data).slice(-16000); });
        const url = `http://127.0.0.1:${port}`;
        let ready = false;
        let readiness = 'No response yet';
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && child.exitCode === null) {
            try {
                const response = await fetch(`${url}/ready`, {signal: AbortSignal.timeout(2000)});
                const body = await response.text();
                readiness = `HTTP ${response.status}: ${body.slice(0, 400)}`;
                if (response.ok && JSON.parse(body).ready) {
                    ready = true;
                    break;
                }
            } catch (error) {
                if (!(error instanceof SyntaxError)) readiness = error.cause?.message || error.message;
            }
            await sleep(250);
        }
        assert.ok(ready, `Packaged application did not index the fixture and become ready (${readiness}):\n${output}`);
        if (rust) {
            assert.match(output,/^inpx-web v[^\s]+ listening on /m);
            if (imageName) await promisify(execFile)('docker',['exec',containerName,'sh','-ec',
                'if command -v node >/dev/null; then exit 1; fi; test -s /usr/local/bin/bin/public.json']);
        }
        if (requireRustCatalogue) {
            if (target === '--image') {
                const tools = rust
                    ? 'test ! -e /usr/local/bin/bin/inpx-reader && test ! -e /usr/local/bin/bin/inpx-catalog'
                    : 'test -x /usr/local/bin/bin/inpx-reader && test -x /usr/local/bin/bin/inpx-catalog';
                await promisify(execFile)('docker',['exec',containerName,'sh','-ec',
                    `${tools} && test -f /data/db/catalogue.json && test -f /data/db/lookup.redb && test ! -e /data/db/book`]);
            } else {
                for (const name of ['catalog','reader']) {
                    const tool = path.join(path.dirname(command),'bin',rustPrograms.fileName(name));
                    assert.equal(await fs.pathExists(tool), !rust, `Unexpected availability of ${tool}`);
                }
                const rows = await fs.readdir(path.join(dir,'data','db'));
                assert(rows.includes('catalogue.json') && rows.includes('lookup.redb') && !rows.includes('book'),
                    'Packaged app must build the native catalogue without legacy book tables');
            }
        }
        const health = await fetch(`${url}/health`);
        if (requireRustHttp)
            assert.equal(health.headers.get('x-powered-by'),null,'Packaged health route must be served by Rust');
        assert.strictEqual(health.status, 200);
        assert.strictEqual((await health.json()).version, require('../package.json').version);
        const home = await fetch(url);
        assert.strictEqual(home.status, 200);
        assert.strictEqual(home.headers.get('x-robots-tag'),'noindex, nofollow');
        const homeHtml = await home.text();
        assert.match(homeHtml, /<html/i);
        if (requireRustHttp) {
            assert.strictEqual(home.headers.get('x-powered-by'),null,'Packaged home must be served by Rust');
            const scriptPath = homeHtml.match(/<script\b[^>]*\bsrc="(\/[^"?]+\.js)"/i)?.[1];
            assert(scriptPath,'Packaged web UI must have a JavaScript bundle');
            const script = await fetch(new URL(scriptPath,url));
            assert.equal(script.status,200);
            assert.equal(script.headers.get('x-powered-by'),null,'Packaged JavaScript must be served by Rust');
            assert.match(script.headers.get('cache-control'),/immutable/);
            assert((await script.arrayBuffer()).byteLength>0);
            const revalidated = await fetch(new URL(scriptPath,url),{headers:{'If-None-Match':script.headers.get('etag'),'Cache-Control':'max-age=0'}});
            assert.equal(revalidated.status,304);
        }
        const {bookUid,link} = await checkWebSocket(url,rust);
        if (!rust && requireRustHttp)
            await require('./profile-sessions-integration-test')(url,{adminPassword:'local-smoke-fixture'});
        try {await checkCachedBookDownload(url,link,dir);}
        catch (error) {throw new Error(`Packaged cached download failed: ${error.message}\n${output}`,{cause:error});}
        if (jxlCover || requireRustHttp) await checkCoverDownload(url, bookUid, jxlCover);
        if (rust) {
            if (requireConverters)
                await require('./rust-conversion-tests').checkPackagedConversions(url, bookUid, dir);
            const opds = await fetch(`${url}/opds`);
            assert.equal(opds.status,200);
            assert.match(await opds.text(),/Shared smoke shelf/);
            const shelf = await fetch(`${url}/opds/v2/catalog-shelves?id=smoke`);
            assert.equal(shelf.status,200);
            assert((await shelf.json()).publications.some(book=>book.metadata.title.includes('Packaged smoke book')));
            await require('./kosync-integration-test')(url,dir,{
                adminPassword:'local-smoke-fixture',
                firstSnippet:'Smoke text',secondSnippet:'Second paragraph for reader synchronization.',
            });
            console.log('ok packaged Rust application and assets without a Node.js runtime');
            return;
        }
        const ebook=await fetch(`${url}/ebook?q=Packaged&lang=en`);
        assert.strictEqual(ebook.status,200);
        const ebookHtml=await ebook.text();
        assert.match(ebookHtml,/Packaged smoke book/);
        assert(!/<script\b|\.woff2?\b/.test(ebookHtml),'The packaged electronic-reader interface needs no client bundle');
        const ebookSlash=await fetch(`${url}/ebook/`);assert.equal(ebookSlash.status,200);assert.match(await ebookSlash.text(),/Поиск книг/);
        await checkEbookProfileDownload(url,ebookHtml);
        if(process.env.INPX_SMOKE_EPUB==='true')await checkEbookProfileDownload(url,ebookHtml,'local-smoke-fixture','mobi');
        await checkEbookGuestDownload(url,ebookHtml);
        if(process.env.INPX_SMOKE_EPUB==='true')await checkEbookGuestDownload(url,ebookHtml,'mobi');
        assert.match(await (await fetch(`${url}/robots.txt`)).text(),/Disallow: \/\s*$/);
        const opds = await fetch(`${url}/opds`);
        assert.strictEqual(opds.status, 200);
        assert.match(await opds.text(), /Shared smoke shelf/);
        const shelf = await fetch(`${url}/opds/catalog-shelves?id=smoke`);
        assert.strictEqual(shelf.status, 200);
        assert.match(await shelf.text(), /Packaged smoke book/);
        await require('./opds2-integration-test')(url,{adminPassword:'local-smoke-fixture'});
        if (requireRustCatalogue) await require('./kosync-integration-test')(url,dir,{
            sessionPath:'/ebook/login',adminPassword:'local-smoke-fixture',
            firstSnippet:'Smoke text',secondSnippet:'Second paragraph for reader synchronization.',
        });
        console.log(`ok packaged application: indexing, health, web UI, OPDS, WebSocket (${target === '--image' ? imageName : target})`);
    } finally {
        if (target === '--image')
            await promisify(execFile)('docker', ['rm', '-f', containerName], {windowsHide: true, timeout: 15000}).catch(() => {});
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            if (process.platform === 'win32' && target !== '--image') {
                const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
                await promisify(execFile)(taskkill, ['/pid', String(child.pid), '/t', '/f'], {windowsHide:true, timeout:5000})
                    .catch(() => child.kill());
            } else {
                child.kill();
            }
        }
        if (exited) {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            try { await exited; } finally { clearTimeout(timer); }
        }
        await fs.rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:200});
    }
}

module.exports = {createFixture, unusedPort, checkEbookProfileDownload,checkEbookGuestDownload};
if (require.main === module)
    main().catch(error => { console.error(error); process.exitCode = 1; });
