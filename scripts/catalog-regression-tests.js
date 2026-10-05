const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {JembaDb} = require('jembadb');
const DbSearcher = require('../server/core/DbSearcher');

async function database(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-catalog-test-'));
    const db = new JembaDb();
    const dbPath = path.join(dir, 'db');
    await fs.ensureDir(dbPath);
    await db.lock({dbPath});
    try {
        await db.create({table: 'book', hash: {field: '_uid', unique: true, type: 'string'}});
        await db.create({table: 'file_hash'});
        await task(dir, db);
    } finally {
        await db.unlock();
        await fs.remove(dir);
    }
}

function searcher(db) {
    const value = Object.create(DbSearcher.prototype);
    Object.assign(value, {db, closed: false, searchFlag: 0});
    value.recStruct = ['author', 'title', 'folder', 'file', 'ext', 'lang', 'libid'].map(field => ({field, type: 'S'}));
    value.recStruct.push({field: 'del', type: 'N'});
    const cache = new Map();
    value.getCached = async key => cache.has(key) ? cache.get(key) : null;
    value.putCached = async(key, data) => cache.set(key, data);
    return value;
}

async function testCatalogLanguageListsAndCollidingBookNumbers() {
    await database(async(dir, db) => {
        const base = {author: 'Huh Christopher', title: 'Keeping My Hope', series: '', serno: 0, size: 42,
            librate: 0, del: 0, sourceId: 'main', insno: 0};
        await db.insert({table: 'book', rows: [
            {...base, id: 1, _uid: 'epub', folder: 'usr-500000-504999.zip', file: '504942', libid: '504942', ext: 'epub', lang: 'en'},
            {...base, id: 2, _uid: 'fb2-collision', folder: 'f.fb2-502689-505100.zip', file: '504942', libid: '504942',
                author: 'Гудман Элисон', title: 'Клуб «Темные времена»', ext: 'fb2', lang: 'ru', librate: 5},
            {...base, id: 3, _uid: 'fb2-format', folder: 'fb2-500000-504999.zip', file: '504943', libid: '504943', ext: 'fb2', lang: 'en'},
            {...base, id: 4, _uid: 'french', folder: 'usr-500000-504999.zip', file: '504944', libid: '504944', ext: 'epub', lang: 'fr'},
            {...base, id: 5, _uid: 'unknown-language', folder: 'usr-500000-504999.zip', file: '504945', libid: '504945', ext: 'epub', lang: ''},
        ]});
        const value = searcher(db);
        const find = async query => (await value.bookSearch(query)).found.map(book => book._uid).sort();
        assert.deepStrictEqual(await find({file: '=504942'}), ['epub', 'fb2-collision']);
        assert.deepStrictEqual(await find({libid: '=504942'}), ['epub', 'fb2-collision']);
        assert.deepStrictEqual(await find({title: 'Keeping My Hope', lang: 'ru,en'}), ['epub', 'fb2-format']);
        assert.deepStrictEqual(await find({title: 'Keeping My Hope', lang: 'ru,en', ext: 'fb2,epub'}), ['epub', 'fb2-format']);
        assert.deepStrictEqual(await find({title: 'Keeping My Hope', lang: 'en,?', ext: 'epub'}), ['epub', 'unknown-language']);
        assert.deepStrictEqual(await find({title: 'Keeping My Hope', lang: 'ru,en', hideCopies: true}), ['fb2-format']);
        assert.deepStrictEqual(await find({title: 'Keeping My Hope', lang: '~^(en|ru)$'}), ['epub', 'fb2-format']);
        // Cached queries must retain the same complete set of files.
        assert.deepStrictEqual(await find({file: '=504942'}), ['epub', 'fb2-collision']);
    });
}

async function testPreparedBookSizeAppearsInCatalogAcrossRestart() {
    await database(async(dir, db) => {
        const bytes = Buffer.from('Original restored EPUB fixture. '.repeat(4096));
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const book = {_uid: 'epub-size', file: '504942', folder: 'usr-500000-504999.zip', ext: 'epub', size: 42};
        await db.insert({table: 'book', rows: [book]});
        // RC6 cache rows did not yet store the restored size in file_hash.
        await db.insert({table: 'file_hash', rows: [{id: book._uid, hash}]});
        const bookDir = path.join(dir, 'book');
        const descriptor = path.join(bookDir, `${hash}.d.json`);
        await fs.outputJson(descriptor, {size: bytes.length, assetVersion: 'fblibrary-assets-v5'});
        const make = () => {
            const worker = Object.create(require('../server/core/WebWorker').prototype);
            worker.config = {bookDir}; worker.db = db;
            worker.readingListStore = {getMetadataOverrides: async() => ({})};
            worker.resetLibraryAssetCaches();
            return worker;
        };
        const result = async worker => worker.applyMetadataOverridesToSearchResult({
            found: [{books: await db.select({table: 'book'})}], books: await db.select({table: 'book'}),
        });
        for (const worker of [make(), make()]) {
            const response = await result(worker);
            for (const row of [response.books[0], response.found[0].books[0]]) {
                assert.strictEqual(row.size, bytes.length);
                assert.strictEqual(row.inpxSize, 42);
            }
        }
        assert.strictEqual((await db.select({table: 'book'}))[0].size, 42, 'The INPX-derived record must stay intact');
        await fs.writeJson(descriptor, {size: 1, assetVersion: 'fblibrary-assets-v4'});
        assert.strictEqual((await result(make())).books[0].size, 42, 'Obsolete book caches must not supply sizes');
        await fs.writeFile(descriptor, 'broken json');
        assert.strictEqual((await result(make())).books[0].size, 42);
        await fs.remove(descriptor);
        await db.insert({table: 'file_hash', replace: true, rows: [{id: book._uid, hash, size: bytes.length, assetVersion: 'fblibrary-assets-v5'}]});
        assert.strictEqual((await result(make())).books[0].size, bytes.length, 'The measured size survives removal of the file cache');
    });
}

module.exports = [testCatalogLanguageListsAndCollidingBookNumbers, testPreparedBookSizeAppearsInCatalogAcrossRestart];
