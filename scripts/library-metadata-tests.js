const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {pipeline} = require('stream/promises');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const yazl = require('yazl');
const ZipReader = require('../server/core/ZipReader');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');
const review = {name: 'Reader', time: '2026-09-15 12:00:00', text: 'First review'};

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-metadata-test-'));
    try { await task(dir); } finally { await fs.remove(dir); }
}

async function archive(file, entries, sevenZip = false) {
    await fs.ensureDir(path.dirname(file));
    if (sevenZip) {
        const input = await fs.mkdtemp(path.join(path.dirname(file), 'input-'));
        try {
            for (const [name, value] of Object.entries(entries))
                await fs.outputFile(path.join(input, name), value);
            for (const command of new ZipReader().sevenZipCommands) {
                try {
                    await execFile(command, ['a', '-t7z', '-y', '-bd', file, '.'], {cwd: input, windowsHide: true});
                    return;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            throw new Error('7-Zip is required for library metadata tests');
        } finally { await fs.remove(input); }
    }
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(file));
    for (const [name, value] of Object.entries(entries))
        zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), name);
    zip.end();
    await done;
}

function worker(config) {
    const value = Object.create(require('../server/core/WebWorker').prototype);
    value.config = config;
    value.resetLibraryAssetCaches();
    return value;
}

async function testLibraryReviewsAndRatingsAreOptionalAndSourceScoped() {
    await temporary(async dir => {
        const libDir = path.join(dir, 'first', 'books');
        const otherDir = path.join(dir, 'second', 'books');
        await fs.ensureDir(libDir);
        await fs.ensureDir(otherDir);
        const value = worker({libDir: otherDir});
        const book = {folder: 'f.fb2-887686-891322.zip', file: '887700', ext: 'fb2', sourceLibDir: libDir};
        assert.deepStrictEqual(await value.getBookReviews(book), []);
        assert.strictEqual(await value.getBookLibraryRating(book), null);
        await archive(path.join(dir, 'first', 'reviews', '202609.7z'), {
            'f.fb2-887686-891322.7z#887700.fb2': JSON.stringify([review]),
        }, true);
        await archive(path.join(libDir, 'reviews', '202610.zip'), {
            'f.fb2-887686-891322.zip#887700.fb2': JSON.stringify([review, {...review, text: 'New<br/>review'}]),
        });
        await archive(path.join(dir, 'first', 'etc', 'reviews', 'additional.zip'), {
            'books.json': JSON.stringify([
                {folder: book.folder, file: '887700.fb2', sum: 13, count: 3},
                {folder: book.folder, file: 'invalid.fb2', sum: 99, count: 1},
            ]),
        });
        await archive(path.join(dir, 'second', 'reviews', '202609.zip'), {
            'f.fb2-887686-891322.zip#887700.fb2': JSON.stringify([{...review, text: 'Other source'}]),
        });
        assert.deepStrictEqual(await value.getBookReviews(book), [review, {...review, text: 'New\nreview'}]);
        assert.deepStrictEqual(await value.getBookLibraryRating(book), {value: 13 / 3, count: 3});
        assert.strictEqual(await value.getBookLibraryRating({...book, file: 'invalid'}), null);
        assert.deepStrictEqual(await value.getBookReviews({...book, sourceLibDir: otherDir}), [{...review, text: 'Other source'}]);
        assert.strictEqual(await value.getBookLibraryRating({...book, sourceLibDir: otherDir}), null);
    });
}

async function testBookInfoRefreshesChangedReviewsWithoutReparsingBook() {
    await temporary(async dir => {
        const config = {libDir: path.join(dir, 'library'), bookDir: path.join(dir, 'cache'), branch: 'test'};
        await fs.ensureDir(config.libDir);
        await fs.ensureDir(config.bookDir);
        const book = {id: 1, _uid: 'fixture', folder: 'collection.zip', file: '12345', ext: 'fb2', sourceLibDir: config.libDir};
        let parses = 0;
        const make = () => {
            const value = worker(config);
            value.checkMyState = () => true;
            value.db = {esc: JSON.stringify, select: async() => [book]};
            value.getBookLink = async() => ({link: '/book/hash', downFileName: 'fixture.fb2'});
            value.readingListStore = {getMetadataOverrides: async() => ({})};
            value.fb2Helper = {getDescAndCover: async() => {
                parses++;
                const parser = new (require('../server/core/fb2/Fb2Parser'))();
                parser.fromString('<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description><body><section><p>Text</p></section></body></FictionBook>');
                return {fb2: parser};
            }};
            return value;
        };
        const value = make();
        assert.deepStrictEqual((await value.getBookInfo('fixture')).bookInfo.reviews, []);
        const monthly = path.join(config.libDir, 'reviews', '202609.zip');
        const additional = path.join(config.libDir, 'etc', 'reviews', 'additional.zip');
        await archive(monthly, {'collection.zip#12345.fb2': JSON.stringify([review])});
        await archive(additional, {'books.json': JSON.stringify([{folder: 'collection.zip', file: '12345.fb2', sum: 9, count: 2}])});
        const first = (await value.getBookInfo('fixture')).bookInfo;
        assert.deepStrictEqual(first.reviews, [review]);
        assert.deepStrictEqual(first.libraryRating, {value: 4.5, count: 2});
        const disk = await fs.readJson(path.join(config.bookDir, 'hash.i.json'));
        delete disk.reviewSignature; // Cache written by versions before this fix.
        disk.reviews = [{...review, text: 'Stale cache'}];
        await fs.writeJson(path.join(config.bookDir, 'hash.i.json'), disk);
        assert.deepStrictEqual((await value.getBookInfo('fixture')).bookInfo.reviews, [review]);
        await archive(monthly, {'collection.zip#12345.fb2': JSON.stringify([{...review, text: 'Edited review'}])});
        // Restart with the same disk cache; archive changes must still be detected.
        const restarted = make();
        assert.deepStrictEqual((await restarted.getBookInfo('fixture')).bookInfo.reviews, [{...review, text: 'Edited review'}]);
        await archive(additional, {'books.json': 'not json'});
        assert.strictEqual((await restarted.getBookInfo('fixture')).bookInfo.libraryRating, null);
        await fs.remove(monthly);
        await fs.remove(additional);
        const empty = (await restarted.getBookInfo('fixture')).bookInfo;
        assert.deepStrictEqual(empty.reviews, []);
        assert.strictEqual(empty.libraryRating, null);
        assert.strictEqual(parses, 1, 'Review changes must preserve cached FB2 parsing');
    });
}

async function testReindexReloadsAuthorAndArchiveCaches() {
    await temporary(async dir => {
        const config = {...require('../server/config/base'), dataDir: path.join(dir, 'data'),
            libDir: path.join(dir, 'library'), inpxFile: path.join(dir, 'library', 'fixture.inpx'),
            bookDir: path.join(dir, 'cache'), publicFilesDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'), inpxFilterFile: path.join(dir, 'absent-filter.json'),
            rootPathStatic: '', bookPathStatic: '/book', publicDir: path.join(dir, 'public'),
            coverDir: path.join(dir, 'covers'), queryCacheEnabled: false};
        await Promise.all([config.dataDir, config.libDir, config.bookDir, config.publicFilesDir, config.tempDir].map(file => fs.ensureDir(file)));
        const row = id => ['Fixture,Author:', 'sf:', `Book ${id}`, '', '0', String(id), '100', String(id), '0', 'fb2', '2026-10-05', 'en', '0', ''].join('\x04');
        const inpx = async(ids) => archive(config.inpxFile, {'collection.info': 'Metadata regression',
            'version.info': '20261005', 'collection.inp': ids.map(row).join('\n') + '\n'});
        await inpx([60000]);
        const name = 'Fixture Author';
        const key = crypto.createHash('md5').update(name.toLowerCase()).digest('hex');
        const authors = path.join(config.libDir, 'etc', 'authors', '202609.zip');
        await archive(authors, {[key]: '<p>Old author biography</p>'});
        await archive(path.join(config.libDir, 'covers', '60000-60000.zip'), {'60000': png});
        const value = worker(config);
        value.setMyState = state => { value.myState = state; };
        value.logServerStats = () => {};
        value.inpxHashCreator = new (require('../server/core/InpxHashCreator'))(config);
        const app = require('express')();
        require('../server/static')(app, config, value);
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const cover = id => fetch(`http://127.0.0.1:${server.address().port}/cover/${id}`);
        try {
            await value.loadOrCreateDb();
            assert.strictEqual(value.myState, 'normal');
            assert.strictEqual((await value.getAuthorInfo(null, name)).authorInfo.text, 'Old author biography');
            assert.strictEqual((await value.getFblibraryArchives('covers', 70000)).length, 0);
            assert.strictEqual((await cover(60000)).status, 200); // Prime HTTP archive cache.
            assert.strictEqual((await cover(80000)).status, 404); // Prime embedded-cover archive cache.
            await archive(authors, {[key]: '<p>Updated author biography</p>'});
            await archive(path.join(config.libDir, 'covers', '70000-70000.zip'), {'70000': png});
            await archive(path.join(config.libDir, '80000-80000.zip'), {'80000.fb2':
                `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><coverpage><image l:href="#cover"/></coverpage></title-info></description><binary id="cover" content-type="image/png">${png.toString('base64')}</binary></FictionBook>`});
            await inpx([60000, 70000, 80000]);
            await value.recreateDb();
            assert.strictEqual(value.myState, 'normal');
            assert.strictEqual((await value.db.select({table: 'book'})).length, 3);
            assert.strictEqual((await value.getAuthorInfo(null, name)).authorInfo.text, 'Updated author biography');
            assert.strictEqual((await value.getFblibraryArchives('covers', 70000)).length, 1);
            for (const id of [70000, 80000]) {
                const response = await cover(id);
                assert.strictEqual(response.status, 200, `New cover ${id} after reindex`);
                assert.ok(Buffer.from(await response.arrayBuffer()).equals(png));
            }
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            if (value.dbSearcher) await value.dbSearcher.close();
            await value.closeDb();
        }
    });
}

module.exports = [testLibraryReviewsAndRatingsAreOptionalAndSourceScoped,
    testBookInfoRefreshesChangedReviewsWithoutReparsingBook, testReindexReloadsAuthorAndArchiveCaches];
