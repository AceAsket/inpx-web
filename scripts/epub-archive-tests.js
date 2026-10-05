const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {promisify} = require('util');
const {pipeline} = require('stream/promises');
const execFile = promisify(require('child_process').execFile);
const yazl = require('yazl');
const ZipReader = require('../server/core/ZipReader');
const epubRestorer = require('../server/core/EpubRestorer');
const utils = require('../server/core/utils');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');
const contents = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item href="cover.png" media-type="image/png"/><item href="image.png" media-type="image/png"/></manifest></package>',
    'OEBPS/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body>Original fixture <img src="image.png"/></body></html>',
    'OEBPS/styles.css': 'body { font-family: Fixture; }',
    'OEBPS/font.otf': Buffer.from([0, 1, 2, 3]),
    'OEBPS/рисунок.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-epub-test-'));
    try { await task(dir); } finally { await fs.remove(dir); }
}

async function testAtomicBookCacheFilesAndRecovery() {
    await temporary(async dir => {
        const target = path.join(dir, 'book.raw');
        let startWrite, completeWrite;
        const started = new Promise(resolve => { startWrite = resolve; });
        const continueWriting = new Promise(resolve => { completeWrite = resolve; });
        let writes = 0;
        const writer = async file => {
            writes++;
            await fs.writeFile(file, 'first');
            startWrite();
            await continueWriting;
            await fs.appendFile(file, '-complete');
        };
        const first = utils.prepareCachedFile(target, writer, 14);
        await started;
        const second = utils.prepareCachedFile(target, writer, 14);
        try {
            assert.strictEqual(await fs.pathExists(target), false, 'A second download must not see a partially written file');
            assert.strictEqual(writes, 1, 'Concurrent requests must share the same file preparation');
        } finally {
            completeWrite();
        }
        await Promise.all([first, second]);
        assert.strictEqual(await fs.readFile(target, 'utf8'), 'first-complete');
        assert.strictEqual(await utils.prepareCachedFile(target, writer, 14), false);
        const gzip = path.join(dir, 'book.gz');
        const content = Buffer.from('Complete book contents. '.repeat(4096));
        await fs.writeFile(gzip, await utils.gzipBuffer(content));
        for (const old of [Buffer.alloc(0), Buffer.from('truncated')]) {
            await fs.writeFile(target, old);
            await Promise.all([utils.ensureGunzipFile(gzip, target, content.length),
                utils.ensureGunzipFile(gzip, target, content.length)]);
            assert.ok((await fs.readFile(target)).equals(content), 'Partial old raw caches must be repaired');
        }
        await fs.remove(target);
        await fs.writeFile(gzip, 'invalid gzip');
        await assert.rejects(utils.ensureGunzipFile(gzip, target, content.length));
        assert.strictEqual(await fs.pathExists(target), false);
        assert.ok(!(await fs.readdir(dir)).some(name => name.includes('.cache-tmp-')));
        await fs.writeFile(gzip, await utils.gzipBuffer(content));
        await utils.ensureGunzipFile(gzip, target, content.length);
        assert.ok((await fs.readFile(target)).equals(content), 'A failed preparation must not prevent retry');
    });
}

async function archive(file, entries, sevenZip = false) {
    await fs.ensureDir(path.dirname(file));
    if (sevenZip) {
        const input = await fs.mkdtemp(path.join(path.dirname(file), 'archive-input-'));
        try {
            for (const [name, value] of Object.entries(entries))
                await fs.outputFile(path.join(input, name), value);
            for (const command of new ZipReader().sevenZipCommands) {
                try {
                    const compression = sevenZip === 'PPMd' ? ['-m0=PPMd', '-ms=on'] : [];
                    await execFile(command, ['a', '-t7z', '-y', '-bd', ...compression, `${file}.7z`, '.'], {cwd: input, windowsHide: true});
                    await fs.move(`${file}.7z`, file, {overwrite: true});
                    return;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            throw new Error('7-Zip is required for EPUB archive regression tests');
        } finally { await fs.remove(input); }
    }
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(file));
    for (const [name, value] of Object.entries(entries))
        zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), name, {compress: name !== 'mimetype'});
    zip.end();
    await done;
}

async function inspectEpub(file) {
    const bytes = await fs.readFile(file);
    assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50);
    assert.strictEqual(bytes.readUInt16LE(8), 0, 'mimetype must be stored without compression');
    assert.strictEqual(bytes.subarray(30, 38).toString(), 'mimetype', 'mimetype must be first');
    const reader = new ZipReader();
    await reader.open(file);
    try {
        assert.strictEqual((await reader.extractToBuf('mimetype')).toString(), 'application/epub+zip');
        const names = Object.values(reader.entries).map(entry => entry.name);
        for (const [name, original] of Object.entries(contents)) {
            assert.ok(names.includes(name), `Missing ${name}: ${names.join(', ')}`);
            assert.ok((await reader.extractToBuf(name)).equals(Buffer.isBuffer(original) ? original : Buffer.from(original)), name);
        }
        return Object.values(reader.entries).map(entry => entry.name);
    } finally { await reader.close(); }
}

async function testCompressedEpubDownloadsRestoreImagesAndInvalidateCache() {
    await temporary(async dir => {
        const source = path.join(dir, 'source');
        const otherSource = path.join(dir, 'other-source');
        const bookDir = path.join(dir, 'book');
        const tempDir = path.join(dir, 'tmp');
        await Promise.all([source, otherSource, bookDir, tempDir].map(value => fs.ensureDir(value)));
        // Heimdall's fb2cut stores book files under the book id, but the index
        // and FBD metadata sit beside that directory at the archive root.
        const indexed = {...Object.fromEntries(Object.entries({...contents,
            'OEBPS/image.png': Buffer.alloc(0),
        }).map(([name, value]) => [`12345/${name}`, value])),
            '12345.fbd': '<FictionBook/>',
            'FLibraryImageIndex.json': JSON.stringify([{id: 'OEBPS/cover.png', num: -1}, {id: 'OEBPS/image.png', num: 0}]),
        };
        const inner = path.join(dir, 'compressed.epub');
        await archive(inner, indexed, true);
        await archive(path.join(source, 'collection.7z'), {'12345.epub': await fs.readFile(inner)}, true);
        await archive(path.join(source, 'covers', 'collection.zip'), {'12345': png});
        await archive(path.join(source, 'images', 'collection.7z'), {'12345/0': png}, true);
        await archive(path.join(otherSource, 'covers', 'collection.zip'), {'12345': 'wrong source'});
        // A file with the old INPX name is actually a 7z archive, too.
        await fs.rename(path.join(source, 'collection.7z'), path.join(source, 'collection.zip'));
        const config = {libDir: otherSource, tempDir, bookDir, publicFilesDir: dir, publicDir: dir,
            rootPathStatic: '', bookPathStatic: '/book', converterPaths: {}};
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = config;
        worker.checkMyState = () => true;
        worker.scheduleCacheClean = () => {};
        const record = {_uid: 'epub-fixture', author: 'Fixture Author', title: 'Compressed EPUB', file: '12345',
            ext: 'epub', folder: 'collection.zip', sourceLibDir: source};
        let fileHash = {hash: 'old-cache'};
        worker.db = {
            esc: value => JSON.stringify(value),
            select: async({table}) => table === 'book' ? [record] : fileHash ? [fileHash] : [],
            insert: async({rows}) => { fileHash = rows[0]; },
        };
        const cached = path.join(dir, 'cached-without-images.epub');
        await archive(cached, contents);
        await utils.gzipFile(cached, path.join(bookDir, 'old-cache'));
        await fs.writeJson(path.join(bookDir, 'old-cache.d.json'), {assetVersion: 'fblibrary-assets-v3'});
        const app = require('express')();
        require('../server/static')(app, config, worker);
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const raw = await fetch(`${base}/book/by-uid?uid=epub-fixture&format=raw`);
            assert.strictEqual(raw.status, 200);
            assert.strictEqual(raw.headers.get('content-type'), 'application/epub+zip');
            const download = path.join(dir, 'download.epub');
            const rawBytes = Buffer.from(await raw.arrayBuffer());
            await fs.writeFile(download, rawBytes);
            const names = await inspectEpub(download);
            assert.ok(!names.includes('FLibraryImageIndex.json'));
            assert.ok(!names.includes('12345.fbd'));
            assert.ok(names.every(name => !name.startsWith('12345/')));
            const reader = new ZipReader();
            await reader.open(download);
            try {
                assert.ok((await reader.extractToBuf('OEBPS/cover.png')).equals(png));
                assert.ok((await reader.extractToBuf('OEBPS/image.png')).equals(png));
            } finally { await reader.close(); }
            assert.notStrictEqual(fileHash.hash, 'old-cache');
            const firstHash = fileHash.hash;
            const desc = await fs.readJson(path.join(bookDir, `${firstHash}.d.json`));
            assert.notStrictEqual(desc.assetVersion, 'fblibrary-assets-v3');
            const wrapped = await fetch(`${base}/book/by-uid?uid=epub-fixture&zip=1`);
            assert.strictEqual(wrapped.status, 200);
            const wrapper = path.join(dir, 'download.zip');
            await fs.writeFile(wrapper, Buffer.from(await wrapped.arrayBuffer()));
            await reader.open(wrapper);
            try {
                const name = Object.values(reader.entries).find(entry => !entry.isDirectory).name;
                assert.ok(name.endsWith('.epub'));
                assert.ok((await reader.extractToBuf(name)).equals(rawBytes));
            } finally { await reader.close(); }
            const direct = await fetch(`${base}/book/${firstHash}`);
            assert.ok(Buffer.from(await direct.arrayBuffer()).equals(rawBytes));
            const prepared = await worker.getPreparedBookFile('epub-fixture', 'epub');
            assert.ok((await fs.readFile(prepared.rawFile)).equals(rawBytes));
            assert.strictEqual(fileHash.hash, firstHash, 'Repeat requests must reuse the restored cache');
            assert.deepStrictEqual(await fs.readdir(tempDir), []);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}

async function testEpubContainersPreserveResourcesAndOrdinaryEpubBytes() {
    await temporary(async dir => {
        const ordinary = path.join(dir, 'ordinary.epub');
        await archive(ordinary, contents);
        const original = await fs.readFile(ordinary);
        assert.strictEqual(await epubRestorer.restore(ordinary), false);
        assert.ok((await fs.readFile(ordinary)).equals(original));
        const prefixed = Object.fromEntries(Object.entries({...contents, 'OEBPS/cover.png': png,
            'FLibraryImageIndex.json': JSON.stringify([{id: '12345/OEBPS/cover.png', num: -1}]),
        }).map(([name, value]) => [`12345/${name}`, value]));
        const compressed = path.join(dir, 'extensionless');
        await archive(compressed, prefixed, true);
        assert.strictEqual(await epubRestorer.restore(compressed, {}, () => { throw new Error('Embedded image must be kept'); }), true);
        const names = await inspectEpub(compressed);
        assert.ok(names.every(name => !name.startsWith('12345/')));
        // Repacking is stable and stripped ZIP containers also restore their assets.
        const first = await fs.readFile(compressed);
        const second = path.join(dir, 'second');
        await archive(second, prefixed, true);
        await epubRestorer.restore(second);
        assert.ok((await fs.readFile(second)).equals(first));
        const strippedZip = path.join(dir, 'stripped.epub');
        await archive(strippedZip, {...contents, 'FLibraryImageIndex.json': JSON.stringify([{id: 'OEBPS/image.png', num: 0}])});
        await epubRestorer.restore(strippedZip, {}, async() => png);
        await inspectEpub(strippedZip);
        const heimdallZip = path.join(dir, 'heimdall.epub');
        await archive(heimdallZip, {...Object.fromEntries(Object.entries(contents).map(([name, value]) => [`12345/${name}`, value])),
            'FLibraryImageIndex.json': JSON.stringify([{id: 'OEBPS/cover.png', num: -1}, {id: 'OEBPS/image.png', num: 0}]),
        });
        const requested = [];
        assert.strictEqual(await epubRestorer.restore(heimdallZip, {}, async(num, name) => {
            requested.push({num, name});
            return png;
        }), true);
        const heimdallNames = await inspectEpub(heimdallZip);
        assert.deepStrictEqual(requested, [{num: -1, name: 'OEBPS/cover.png'}, {num: 0, name: 'OEBPS/image.png'}]);
        assert.ok(!heimdallNames.includes('FLibraryImageIndex.json'));
    });
}

async function testInvalidCompressedEpubDoesNotPublishPartialResults() {
    await temporary(async dir => {
        const cases = [
            [{...Object.fromEntries(Object.entries(contents).map(([name, value]) => [`12345/${name}`, value])),
                'FLibraryImageIndex.json': 'not json'}, /индекс/],
            [{...Object.fromEntries(Object.entries(contents).map(([name, value]) => [`12345/${name}`, value])),
                'FLibraryImageIndex.json': '[]', '12345/FLibraryImageIndex.json': '[]'}, /Несколько индексов/],
            [{...contents, 'FLibraryImageIndex.json': JSON.stringify([{id: '../escape.png', num: 0}])}, /путь/],
            [{...contents, 'FLibraryImageIndex.json': 'not json'}, /индекс/],
            [{...contents, 'FLibraryImageIndex.json': JSON.stringify([{id: 'OEBPS/missing.png', num: 0}])}, /Не найдено изображение/],
            [{mimetype: 'application/epub+zip', 'OEBPS/book.opf': '<package/>'}, /container.xml/],
        ];
        for (let index = 0; index < cases.length; index++) {
            const file = path.join(dir, `bad-${index}.epub`);
            await archive(file, cases[index][0], true);
            const original = await fs.readFile(file);
            await assert.rejects(epubRestorer.restore(file), cases[index][1]);
            assert.ok((await fs.readFile(file)).equals(original));
        }
        assert.ok(!(await fs.readdir(dir)).some(name => name.startsWith('epub-')));
        assert.strictEqual(await fs.pathExists(path.join(dir, 'escape.png')), false);
    });
}

async function testJxlCodestreamAndContainerImagesAreRecognized() {
    const imageUtils = require('../server/core/ImageUtils');
    assert.strictEqual(imageUtils.contentType(Buffer.from('ff0a00112233', 'hex')), 'image/jxl');
    assert.strictEqual(imageUtils.contentType(Buffer.from('0000000c4a584c200d0a870a00000014667479706a786c20', 'hex')), 'image/jxl');
    assert.strictEqual(imageUtils.contentType(png), 'image/png');
    assert.strictEqual(imageUtils.contentType(Buffer.from('ffd8ffe000104a464946', 'hex')), 'image/jpeg');
}

async function testSameFilenameEpubAndFb2KeepTheirOwnAssetsAndDownloads() {
    await temporary(async dir => {
        const source = path.join(dir, 'library');
        const config = {libDir: source, tempDir: path.join(dir, 'tmp'), bookDir: path.join(dir, 'book'),
            coverDir: path.join(dir, 'cover'), publicFilesDir: dir, publicDir: dir,
            rootPathStatic: '', bookPathStatic: '/book', converterPaths: {}};
        await Promise.all([source, config.tempDir, config.bookDir, config.coverDir].map(value => fs.ensureDir(value)));
        const epubCover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
        const epubUid = 'epub/UID+504942=';
        const records = [
            {_uid: 'fb2/UID+504942=', file: '504942', libid: 504942, ext: 'fb2', folder: 'f.fb2-502689-505100.zip',
                title: 'Other FB2', author: 'Other Author', genre: '', sourceId: 'main', sourceLibDir: source},
            {_uid: epubUid, file: '504942', libid: 504942, ext: 'epub', folder: 'usr-500000-504999.zip',
                title: 'Keeping My Home', author: 'EPUB Author', genre: '', size: 42, sourceId: 'main', sourceLibDir: source},
        ];
        for (const record of records)
            Object.assign(record, {id: record._uid, series: '', serno: 0, lang: 'en', keywords: '',
                librate: 0, insno: 0, del: 0, date: '2026-09-01'});
        const inner = path.join(dir, 'inner.epub');
        await archive(inner, {...Object.fromEntries(Object.entries(contents).map(([name, value]) => [`504942/${name}`, value])),
            'FLibraryImageIndex.json': JSON.stringify([{id: 'OEBPS/cover.png', num: -1}, {id: 'OEBPS/image.png', num: 0}]),
        }, 'PPMd');
        await archive(path.join(source, 'usr-500000-504999.7z'), {'504942.epub': await fs.readFile(inner)}, true);
        const fb2 = `<FictionBook><description><title-info><book-title>Other FB2</book-title></title-info></description><body><section><p>FB2 text</p></section></body></FictionBook>`;
        await archive(path.join(source, 'f.fb2-502689-505100.7z'), {'504942.fb2': fb2}, true);
        for (const [folder, data] of [['f.fb2-502689-505100', png], ['usr-500000-504999', epubCover]]) {
            await archive(path.join(source, 'covers', `${folder}.zip`), {'504942': data});
            await archive(path.join(source, 'images', `${folder}.zip`), {'504942/0': data});
        }
        // Old disk/browser URLs selected the narrower FB2 range for both books.
        await fs.writeFile(path.join(config.coverDir, 'main-504942.png'), png);
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = config;
        worker.checkMyState = () => {};
        worker.scheduleCacheClean = () => {};
        worker.resetLibraryAssetCaches();
        worker.readingListStore = {getMetadataOverrides: async() => ({})};
        worker.fb2Helper = new (require('../server/core/fb2/Fb2Helper'))();
        const hashes = new Map();
        hashes.set(epubUid, {id: epubUid, hash: 'rc4-wrong-cover'});
        await utils.gzipFile(inner, path.join(config.bookDir, 'rc4-wrong-cover'));
        await fs.writeJson(path.join(config.bookDir, 'rc4-wrong-cover.d.json'), {assetVersion: 'fblibrary-assets-v4'});
        worker.db = {
            esc: value => JSON.stringify(value),
            select: async({table, where}) => table === 'book'
                ? records.filter(book => where.includes(JSON.stringify(book._uid)))
                : [...hashes.values()].filter(row => where.includes(JSON.stringify(row.id))),
            insert: async({rows}) => rows.forEach(row => hashes.set(row.id, row)),
        };
        let restores = 0;
        const restore = worker.restoreBook.bind(worker);
        worker.restoreBook = async(...args) => { restores++; return await restore(...args); };
        const app = require('express')();
        require('../server/static')(app, config, worker);
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const coverUrl = book => `${base}/cover/by-uid?uid=${encodeURIComponent(book._uid)}`;
        try {
            for (let repeat = 0; repeat < 2; repeat++) {
                for (const [book, data] of [[records[0], png], [records[1], epubCover]]) {
                    const response = await fetch(coverUrl(book));
                    assert.strictEqual(response.status, 200);
                    assert.ok(Buffer.from(await response.arrayBuffer()).equals(data));
                }
            }
            assert.strictEqual(restores, 0, 'Cover requests must not prepare the EPUB');
            const unknown = await fetch(`${base}/cover/by-uid?uid=unknown`);
            assert.strictEqual(unknown.status, 404);
            const page = Object.create(require('../server/core/opds/BookPage').prototype);
            Object.assign(page, {config, webWorker: worker, rootTag: 'feed', opdsRoot: '/opds', id: 'book', title: 'Книга'});
            worker.getGenreMap = async() => new Map();
            page.getGenres = async() => ({genreMap: new Map()});
            const coldXml = await page.body({query: {uid: epubUid}, originalUrl: `/opds/book?uid=${encodeURIComponent(epubUid)}`});
            assert.strictEqual(restores, 0, 'OPDS must return an EPUB acquisition link before preparing the book');
            assert.ok(coldXml.includes(`/book/by-uid?uid=${encodeURIComponent(epubUid)}&amp;format=raw`));
            const [{bookInfo}, raw, wrapped, rawAgain, wrappedAgain, prepared] = await Promise.all([
                worker.getBookInfo(epubUid),
                fetch(`${base}/book/by-uid?uid=${encodeURIComponent(epubUid)}&format=raw`),
                fetch(`${base}/book/by-uid?uid=${encodeURIComponent(epubUid)}&zip=1`),
                fetch(`${base}/book/by-uid?uid=${encodeURIComponent(epubUid)}&format=raw`),
                fetch(`${base}/book/by-uid?uid=${encodeURIComponent(epubUid)}&zip=1`),
                worker.getPreparedBookFile(epubUid, 'epub'),
            ]);
            assert.strictEqual(restores, 1, 'Concurrent info and download requests must share one preparation');
            assert.strictEqual(raw.status, 200);
            assert.strictEqual(wrapped.status, 200);
            const rawBytes = Buffer.from(await raw.arrayBuffer());
            assert.ok(Buffer.from(await rawAgain.arrayBuffer()).equals(rawBytes));
            assert.ok((await fs.readFile(prepared.rawFile)).equals(rawBytes));
            for (const [index, response] of [wrapped, wrappedAgain].entries()) {
                assert.strictEqual(response.status, 200);
                const wrappedFile = path.join(dir, `wrapped-${index}.zip`);
                await fs.writeFile(wrappedFile, Buffer.from(await response.arrayBuffer()));
                const wrappedReader = new ZipReader();
                await wrappedReader.open(wrappedFile);
                try {
                    const entry = Object.values(wrappedReader.entries).find(item => item.name.endsWith('.epub'));
                    assert.ok(entry);
                    assert.ok((await wrappedReader.extractToBuf(entry.name)).equals(rawBytes), 'Concurrent ZIP downloads must contain the complete EPUB');
                } finally { await wrappedReader.close(); }
            }
            assert.strictEqual(bookInfo.book.title, 'Keeping My Home');
            assert.strictEqual(bookInfo.book.size, rawBytes.length, 'The INPX stub size must use restored EPUB size');
            assert.strictEqual(bookInfo.book.inpxSize, 42);
            assert.notStrictEqual(hashes.get(epubUid).hash, 'rc4-wrong-cover');
            const result = path.join(dir, 'result.epub');
            await fs.writeFile(result, rawBytes);
            const reader = new ZipReader();
            await reader.open(result);
            try {
                assert.ok((await reader.extractToBuf('OEBPS/cover.png')).equals(epubCover));
                assert.ok((await reader.extractToBuf('OEBPS/image.png')).equals(epubCover));
            } finally { await reader.close(); }
            const xml = await page.body({query: {uid: epubUid}, originalUrl: `/opds/book?uid=${encodeURIComponent(epubUid)}`});
            assert.ok(xml.includes(`/cover/by-uid?uid=${encodeURIComponent(epubUid)}`));
            const acquisition = await fetch(`${base}/book/by-uid?uid=${encodeURIComponent(epubUid)}&format=raw`);
            assert.strictEqual(acquisition.status, 200);
            assert.ok(Buffer.from(await acquisition.arrayBuffer()).equals(rawBytes));
            const fb2Download = await fetch(`${base}/book/by-uid?uid=${encodeURIComponent(records[0]._uid)}&format=raw`);
            assert.strictEqual(fb2Download.status, 200);
            const fb2Text = await fb2Download.text();
            assert.ok(fb2Text.includes('Other FB2'));
            assert.ok(fb2Text.includes(png.toString('base64')));
            assert.ok(!fb2Text.includes(epubCover.toString('base64')));
            // Removing EPUB assets must not substitute colliding FB2 images.
            worker.requireAdmin = async() => {};
            worker.addAdminEvent = () => {};
            const reset = await worker.rebuildCoverCacheForBook('', '', epubUid);
            assert.strictEqual(reset.removed, 1);
            assert.ok(reset.coverUrl.includes('/cover/by-uid?uid='));
            await fs.remove(path.join(source, 'covers', 'usr-500000-504999.zip'));
            await fs.remove(path.join(source, 'images', 'usr-500000-504999.zip'));
            const missing = await fetch(coverUrl(records[1]));
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(await worker.getEpubImage('504942', 0, 'OEBPS/image.png', records[1].folder, source), null);
            const fb2Cover = await fetch(coverUrl(records[0]));
            assert.ok(Buffer.from(await fb2Cover.arrayBuffer()).equals(png));
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}

async function testSolidEpubExtractsAllChaptersOnce() {
    await temporary(async dir => {
        const chapters = Object.fromEntries(Array.from({length: 128}, (_, index) =>
            [`504942/OEBPS/chapter-${index}.xhtml`, `<html><body>${index}: ${'Keeping my home. A chapter with text. '.repeat(1024)}</body></html>`]));
        const resources = {...Object.fromEntries(Object.entries(contents).map(([name, data]) => [`504942/${name}`, data])), ...chapters};
        const file = path.join(dir, 'solid.epub');
        await archive(file, resources, 'PPMd');
        let extractions = 0;
        const originals = {};
        for (const method of ['run7z', 'run7zStdout']) {
            originals[method] = ZipReader.prototype[method];
            ZipReader.prototype[method] = function(args, ...rest) {
                if (args[0] === 'x') extractions++;
                return originals[method].call(this, args, ...rest);
            };
        }
        try {
            await epubRestorer.restore(file);
        } finally {
            Object.assign(ZipReader.prototype, originals);
        }
        assert.strictEqual(extractions, 1, 'Solid EPUB must be decompressed once regardless of chapter count');
        const reader = new ZipReader();
        await reader.open(file);
        try {
            for (const [name, data] of Object.entries(chapters))
                assert.strictEqual((await reader.extractToBuf(name.slice('504942/'.length))).toString(), data);
        } finally { await reader.close(); }
    });
}

async function testEpubReusesImageArchiveReadersAndClosesOnFailure() {
    await temporary(async dir => {
        const source = path.join(dir, 'source');
        const config = {libDir: source, tempDir: path.join(dir, 'tmp'), bookDir: path.join(dir, 'book'), bookPathStatic: '/book'};
        await Promise.all([source, config.tempDir, config.bookDir].map(file => fs.ensureDir(file)));
        for (const missing of [false, true]) {
            const folder = `collection-${missing ? 'bad' : 'good'}.zip`;
            const inner = path.join(dir, 'inner.epub');
            const index = Array.from({length: 8}, (_, num) => ({id: `OEBPS/picture-${num}.png`, num}));
            await archive(inner, {...contents, 'FLibraryImageIndex.json': JSON.stringify(index)});
            await archive(path.join(source, folder), {'12345.epub': await fs.readFile(inner)});
            const images = Object.fromEntries(index.slice(0, missing ? 1 : 8).map(item => [`12345/${item.num}`, png]));
            // A realistic sidecar has many entries unrelated to this book.
            for (let num = 0; num < 5000; num++) images[`other/${num}`] = 'unrelated';
            await archive(path.join(source, 'images', folder), images);
            const worker = Object.create(require('../server/core/WebWorker').prototype);
            worker.config = config; worker.checkMyState = () => {}; worker.scheduleCacheClean = () => {};
            const record = {_uid: folder, author: 'Fixture Author', title: 'Images', file: '12345', ext: 'epub', folder};
            worker.db = {esc: JSON.stringify, select: async({table}) => table === 'book' ? [record] : [], insert: async() => {}};
            const opened = [];
            const original = ZipReader.prototype.open;
            ZipReader.prototype.open = async function(file, ...args) {
                if (path.basename(path.dirname(file)) === 'images') opened.push(this);
                return await original.call(this, file, ...args);
            };
            try {
                if (missing) {
                    await assert.rejects(worker.getBookLink(folder), /Не найдено изображение/);
                } else {
                    const result = await worker.getPreparedBookFile(folder, 'epub');
                    const reader = new ZipReader();
                    await reader.open(result.rawFile);
                    try {
                        for (const item of index) assert.ok((await reader.extractToBuf(item.id)).equals(png));
                    } finally { await reader.close(); }
                }
            } finally {
                ZipReader.prototype.open = original;
            }
            assert.strictEqual(opened.length, 1, 'The same image archive must open once per EPUB');
            assert.ok(opened.every(reader => !reader.zip && !reader.archiveFile), 'All image archives must close on success and failure');
        }
    });
}

module.exports = [testAtomicBookCacheFilesAndRecovery, testJxlCodestreamAndContainerImagesAreRecognized, testCompressedEpubDownloadsRestoreImagesAndInvalidateCache,
    testEpubContainersPreserveResourcesAndOrdinaryEpubBytes, testInvalidCompressedEpubDoesNotPublishPartialResults,
    testSameFilenameEpubAndFb2KeepTheirOwnAssetsAndDownloads, testSolidEpubExtractsAllChaptersOnce,
    testEpubReusesImageArchiveReadersAndClosesOnFailure];
