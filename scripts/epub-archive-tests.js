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

async function archive(file, entries, sevenZip = false) {
    await fs.ensureDir(path.dirname(file));
    if (sevenZip) {
        const input = await fs.mkdtemp(path.join(path.dirname(file), 'archive-input-'));
        try {
            for (const [name, value] of Object.entries(entries))
                await fs.outputFile(path.join(input, name), value);
            for (const command of new ZipReader().sevenZipCommands) {
                try {
                    await execFile(command, ['a', '-t7z', '-y', '-bd', `${file}.7z`, '.'], {cwd: input, windowsHide: true});
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
        const indexed = {...contents,
            'OEBPS/image.png': Buffer.alloc(0),
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
        await utils.gzipFile(inner, path.join(bookDir, 'old-cache'));
        await fs.writeJson(path.join(bookDir, 'old-cache.d.json'), {assetVersion: 'fblibrary-assets-v2'});
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
            const reader = new ZipReader();
            await reader.open(download);
            try {
                assert.ok((await reader.extractToBuf('OEBPS/cover.png')).equals(png));
                assert.ok((await reader.extractToBuf('OEBPS/image.png')).equals(png));
            } finally { await reader.close(); }
            assert.notStrictEqual(fileHash.hash, 'old-cache');
            const firstHash = fileHash.hash;
            const desc = await fs.readJson(path.join(bookDir, `${firstHash}.d.json`));
            assert.notStrictEqual(desc.assetVersion, 'fblibrary-assets-v2');
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
    });
}

async function testInvalidCompressedEpubDoesNotPublishPartialResults() {
    await temporary(async dir => {
        const cases = [
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

module.exports = [testJxlCodestreamAndContainerImagesAreRecognized, testCompressedEpubDownloadsRestoreImagesAndInvalidateCache,
    testEpubContainersPreserveResourcesAndOrdinaryEpubBytes, testInvalidCompressedEpubDoesNotPublishPartialResults];
