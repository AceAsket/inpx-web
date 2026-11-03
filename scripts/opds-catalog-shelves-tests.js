const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const he = require('he');
const shelves = require('../server/core/opds/CatalogShelves');

const definition = (extra = {}) => ({id:'new-books', name:'Новинки & книги', grouping:'books', filters:{genre:'sf', lang:'ru'}, ...extra});
const document = (...items) => ({version:1, shelves:items});

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-opds-shelves-'));
    try {await task(dir);} finally {await fs.remove(dir);}
}

async function fixture(task) {
    await temporary(async dir => {
        const libDir = path.join(dir, 'books'), dataDir = path.join(dir, 'data');
        await fs.ensureDir(libDir); await fs.ensureDir(dataDir);
        for (let i = 0; i < 63; i++) {
            await fs.writeFile(path.join(libDir, `${i}.fb2`), '<FictionBook><description><title-info>' +
                `<genre>${i < 61 ? 'sf' : 'detective'}</genre><author><last-name>Автор</last-name><first-name>Один</first-name></author>` +
                (i < 2 ? '<author><last-name>Соавтор</last-name></author>' : '') +
                `<book-title>Книга ${String(i).padStart(3, '0')}</book-title><lang>ru</lang><sequence name="Серия" number="${63 - i}"/>` +
                '</title-info></description><body><section><p>Текст</p></section></body></FictionBook>');
        }
        const config = {dataDir, libDir, tempDir:path.join(dir, 'tmp'), inpxFilterFile:path.join(dir, 'none'), dbVersion:14,
            dbCacheSize:5, fullOptimization:false, queryCacheEnabled:true, queryCacheMemSize:5, queryCacheDiskSize:0,
            opdsFeedsFile:path.join(dir, 'feeds.json'), librarySources:[{id:'own', name:'Own', type:'folder', libDir}]};
        await fs.writeJson(config.opdsFeedsFile, document(definition()));
        const db = new (require('jembadb').JembaDb)(); await db.lock({dbPath:path.join(dataDir, 'db'), create:true});
        let searcher;
        try {
            await new (require('../server/core/DbCreator'))(config).run(db, () => {}); await db.openAll();
            searcher = new (require('../server/core/DbSearcher'))(config, db); await searcher.init();
            const Worker = require('../server/core/WebWorker'), worker = Object.create(Worker.prototype);
            Object.assign(worker, {config, db, dbSearcher:searcher, libraryAssetGeneration:1, profileSessions:new Map(), checkMyState:() => {},
                applyMetadataOverridesToSearchResult:async() => {}});
            const rows = await db.select({table:'book'});
            await db.insert({table:'book', rows:[{...rows[0], id:100000, _uid:'deleted', file:'deleted', del:1}]});
            await task({config, worker, searcher, rows});
        } finally {if (searcher) await searcher.close(); await db.unlock();}
    });
}

function makePage(worker) {
    const page = Object.create(require('../server/core/opds/CatalogShelfPage').prototype);
    return Object.assign(page, {config:worker.config, webWorker:worker, opdsRoot:'/prefix/opds', rootTag:'feed', id:'catalog-shelf', title:'Подборка'});
}

function xml(text) {const parser = new (require('../server/core/xml/XmlParser'))(); parser.fromString(text); return parser;}

async function testCatalogShelfDefinitionsRejectPrivateAndUnknownSettings() {
    const valid = shelves.normalize(document(definition(), definition({id:'off', active:false, filters:null})));
    assert.strictEqual(valid.size, 1); assert.strictEqual(valid.get('new-books').filters.del, '0');
    for (const extra of [{id:'../private'}, {name:''}, {grouping:'profile'}, {filters:{user:'admin'}}, {filters:{genre:'sf', unreadOnly:true}},
        {filters:{genre:'sf', del:'1'}}, {filters:{genre:5}}, {filters:{genre:'sf', hideCopies:'true'}}, {filters:{isbn:'bad'}}, {filters:{ratingCount:'bad'}}])
        assert.throws(() => shelves.normalize(document(definition(extra))));
    assert.throws(() => shelves.normalize(document(definition(), definition())));
    assert.throws(() => shelves.normalize({version:2, shelves:[]}));
    assert.throws(() => shelves.normalize(document(...Array.from({length:65}, (_, i) => definition({id:`s${i}`})))));
    assert.strictEqual(shelves.normalize(document(definition({filters:{genre:'sf', hideCopies:true}}))).get('new-books').filters.hideCopies, true);
}

async function testCatalogShelfFileReloadAndFailuresAreBounded() {
    await temporary(async dir => {
        assert.strictEqual((await shelves.load({})).size, 0);
        const config = {dataDir:dir, opdsFeedsFile:'feeds.json'}, file = path.join(dir, 'feeds.json');
        await fs.writeJson(file, document(definition()));
        const stat = await fs.stat(file);
        assert.strictEqual((await shelves.load(config)).get('new-books').name, 'Новинки & книги');
        await fs.writeJson(file, document(definition({name:'Другая подборка'})));
        await fs.utimes(file, stat.atime, stat.mtime);
        assert.strictEqual((await shelves.load(config)).get('new-books').name, 'Другая подборка', 'Hot reload reads content even with unchanged timestamps');
        for (const contents of ['{', JSON.stringify({version:1, shelves:{}}), ' '.repeat(256 * 1024 + 1)]) {
            await fs.writeFile(file, contents);
            await assert.rejects(shelves.load(config), error => error.status === 503 && !error.message.includes(dir));
        }
        await fs.remove(file);
        await assert.rejects(shelves.load(config), error => error.code === 'OPDS_SHELVES_UNAVAILABLE');
        await fs.writeJson(file, document(definition()));
        assert.strictEqual((await shelves.load(config)).size, 1, 'Fixing a file restores access without restart');
    });
}

async function testCatalogShelfRootRemainsAvailableWithBrokenConfig() {
    await temporary(async dir => {
        const config = {opdsFeedsFile:path.join(dir, 'feeds.json')};
        const root = Object.create(require('../server/core/opds/RootPage').prototype);
        Object.assign(root, {config, webWorker:{getOpdsUsers:async() => []}, opdsRoot:'/opds', rootTag:'feed', id:'root', title:'Library'});
        for (const field of ['authorPage', 'seriesPage', 'titlePage', 'genrePage']) root[field] = {myEntry:() => ({id:field, title:field})};
        const request = {query:{}, originalUrl:'/opds'};
        let result = xml(await root.body(request));
        assert.strictEqual(result.$$array('feed/entry').length, 5);
        assert((await root.body(request)).includes('Общие подборки временно недоступны'));
        await fs.writeJson(config.opdsFeedsFile, document(definition()));
        result = xml(await root.body(request));
        const shelf = result.$$array('feed/entry').find(entry => entry.text('/id') === 'catalog-shelf:new-books');
        assert(shelf); assert.strictEqual(he.decode(shelf.text('/title')), definition().name);
        config.opdsFeedsFile = '';
        assert.strictEqual(xml(await root.body(request)).$$array('feed/entry').length, 4);
    });
}

async function testCatalogShelvesReadOnlyOnePageAndKeepAllOriginalFilters() {
    await fixture(async({worker, searcher}) => {
        const shelf = shelves.normalize(document(definition())).get('new-books');
        const select = worker.db.select.bind(worker.db), reads = [];
        worker.db.select = async query => {
            const rows = await select(query);
            if (query.table === 'book' && !query.rawResult && !query.map) reads.push(rows.length);
            return rows;
        };
        worker.readingListStore = new Proxy({}, {get:() => assert.fail('Global shelves must never read personal lists or progress')});
        let searches = 0;
        const search = searcher.bookSearchIds.bind(searcher);
        searcher.bookSearchIds = async query => {searches++; assert.strictEqual(query.del, '0'); return search(query);};
        const [first, same] = await Promise.all([shelves.page(worker, shelf, {}), shelves.page(worker, shelf, {})]);
        assert.strictEqual(searches, 1, 'Concurrent requests share selection');
        assert.strictEqual(first.total, 61); assert.strictEqual(first.entries.length, 50); assert.strictEqual(same.entries.length, 50);
        const second = await shelves.page(worker, shelf, {page:'2', genre:'detective', del:'1', user:'admin'});
        assert.strictEqual(second.entries.length, 11); assert.strictEqual(searches, 1);
        const ids = [...first.entries, ...second.entries].map(book => book._uid);
        assert.strictEqual(new Set(ids).size, 61); assert(!ids.includes('deleted'));
        assert(reads.every(count => count <= 50));
        assert(first.entries.every(book => book.genre === 'sf' && book.lang === 'ru'));
        const invalidPage = await shelves.page(worker, shelf, {page:'-10'});
        assert.strictEqual(invalidPage.number, 1);
        assert.strictEqual((await shelves.page(worker, shelf, {page:'999999999'})).entries.length, 0);
        const grouped = {...shelf, grouping:'authors'};
        const groups = await shelves.page(worker, grouped, {});
        assert.deepStrictEqual(groups.entries.map(group => group.count).sort((a, b) => a - b), [2, 61]);
        const coauthor = groups.entries.find(group => group.count === 2);
        const ownBooks = await shelves.page(worker, grouped, {group:coauthor.groupId});
        assert.strictEqual(ownBooks.total, 2); assert(ownBooks.entries.every(book => book.author.includes('Соавтор')));
        await assert.rejects(shelves.page(worker, grouped, {group:'../../admin'}), error => error.status === 404);
        const series = await shelves.page(worker, {...shelf, grouping:'series'}, {});
        assert.strictEqual(series.entries[0].count, 61);
        const seriesBooks = await shelves.page(worker, {...shelf, grouping:'series'}, {group:series.entries[0].groupId});
        assert(seriesBooks.entries.every((book, index) => !index || seriesBooks.entries[index - 1].serno <= book.serno), 'Series pages follow book numbers across authors');
    });
}

async function testCatalogShelvesInvalidateOnDefinitionIndexAndDateChanges() {
    await fixture(async({worker, searcher}) => {
        const shelf = shelves.normalize(document(definition())).get('new-books');
        let searches = 0;
        const search = searcher.bookSearchIds.bind(searcher);
        searcher.bookSearchIds = async query => {searches++; return search(query);};
        await shelves.page(worker, shelf, {}); await shelves.page(worker, shelf, {});
        assert.strictEqual(searches, 1);
        worker.libraryAssetGeneration++;
        await shelves.page(worker, shelf, {}); assert.strictEqual(searches, 2);
        let revision = 'first';
        const ids = await search({genre:'sf', del:'0'});
        searcher.isbnIndex = {select:async() => ({ids:revision === 'first' ? ids : new Uint32Array(), deletedIds:new Set(), signature:revision})};
        const isbnShelf = {...shelf, filters:{...shelf.filters, isbn:'9780306406157'}};
        assert.strictEqual((await shelves.page(worker, isbnShelf, {})).total, 61);
        revision = 'next';
        assert.strictEqual((await shelves.page(worker, isbnShelf, {})).total, 0, 'Index revision cannot reuse cached membership');
        const originalQuery = require('../server/core/SmartShelf').query;
        let date = '2026-01-01';
        require('../server/core/SmartShelf').query = filters => ({...filters, date});
        try {
            await shelves.page(worker, shelf, {}); const before = searches;
            date = '2027-01-01'; await shelves.page(worker, shelf, {});
            assert.strictEqual(searches, before + 1, 'Relative periods are resolved for every request');
        } finally {require('../server/core/SmartShelf').query = originalQuery;}
        const metadata = worker.applyMetadataOverridesToSearchResult;
        worker.applyMetadataOverridesToSearchResult = async() => {worker.libraryAssetGeneration++;};
        try {await assert.rejects(shelves.page(worker, shelf, {}), error => error.status === 503);} finally {worker.applyMetadataOverridesToSearchResult = metadata;}
    });
}

async function testCatalogShelfHttpAuthPaginationAndHotReload() {
    await fixture(async({worker, config}) => {
        const express = require('express'), Security = require('../server/core/Security'), ProfileAccess = require('../server/core/ProfileAccess');
        Object.assign(config, {allowAnonymousAccess:false, opds:{enabled:true, user:'catalog', password:'catalog-fixture'}});
        worker.readingListStore = new (require('../server/core/ReadingListStore'))({...config, adminPassword:'fixture-admin'});
        const security = new Security(config); await security.init();
        const app = express(), page = makePage(worker);
        app.use(security.middleware());
        app.use('/prefix/opds', new ProfileAccess(config, worker, security).httpGuard(true),
            require('../server/core/opds/Auth')(config, (...args) => worker.verifyOpdsPassword(...args), security),
            require('../server/core/opds').scopeGuard(() => worker));
        app.get('/prefix/opds/catalog-shelves', async(req, res) => {
            try {res.type('application/atom+xml').send(await page.body(req));} catch (error) {res.status(error.status || 500).send(error.message);}
        });
        const server = await new Promise(resolve => {const value = app.listen(0, '127.0.0.1', () => resolve(value));});
        const base = `http://127.0.0.1:${server.address().port}`;
        const auth = {Authorization:'Basic ' + Buffer.from('catalog:catalog-fixture').toString('base64')};
        const request = (query, headers = auth) => fetch(`${base}/prefix/opds/catalog-shelves?${new URLSearchParams({id:'new-books', ...query})}`, {headers});
        try {
            assert.strictEqual((await request({}, {})).status, 401);
            assert.strictEqual((await request({id:'../profiles'})).status, 404);
            assert.strictEqual((await request({user:'missing'})).status, 404);
            const user = await worker.readingListStore.createUser({name:'Reader', opdsEnabled:true});
            let response = await request({user:user.id}); assert.strictEqual(response.status, 200);
            const feed = xml(await response.text());
            const links = feed.$$array('feed/link').map(link => link.attrs());
            const next = new URL(he.decode(links.find(link => link.rel === 'next').href), base);
            assert.strictEqual(next.searchParams.get('user'), user.id); assert.strictEqual(next.searchParams.get('page'), '2');
            response = await fetch(next, {headers:auth}); assert.strictEqual(response.status, 200);
            assert.strictEqual(xml(await response.text()).$$array('feed/entry').filter(entry => !['previous', 'next', 'groups'].includes(entry.text('/id'))).length, 11);
            const body = await (await request({})).text(); assert(!body.includes('Не прочитано'), 'Shared catalog does not publish personal reading state');
            await fs.writeJson(config.opdsFeedsFile, document(definition({grouping:'authors'})));
            const groups = xml(await (await request({user:user.id})).text()).$$array('feed/entry');
            const all = groups.find(entry => he.decode(entry.text('/title')).endsWith('(61)'));
            const groupUrl = new URL(he.decode(all.attrs('/link').href), base);
            const groupFeed = xml(await (await fetch(groupUrl, {headers:auth})).text());
            const groupNext = groupFeed.$$array('feed/link').map(link => link.attrs()).find(link => link.rel === 'next');
            const follow = new URL(he.decode(groupNext.href), base);
            assert.strictEqual(follow.searchParams.get('group'), groupUrl.searchParams.get('group'));
            assert.strictEqual(follow.searchParams.get('user'), user.id);
            assert.strictEqual(xml(await (await fetch(follow, {headers:auth})).text()).$$array('feed/entry').filter(entry => !['previous', 'next', 'groups'].includes(entry.text('/id'))).length, 11);
            await fs.writeJson(config.opdsFeedsFile, document());
            assert.strictEqual((await request({})).status, 404, 'Removed definitions cannot use old selections');
        } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    });
}

async function testCatalogShelfWorkIsBoundedAndDiscardsOldDatabaseResults() {
    const pending = [];
    const searcher = {prepareRatingQuery:async query => query, queryKey:query => JSON.stringify(query),
        bookSearchIds:() => new Promise((resolve, reject) => pending.push({resolve, reject}))};
    const worker = {checkMyState:() => {}, dbSearcher:searcher, db:{}, libraryAssetGeneration:1};
    const shelf = shelves.normalize(document(definition())).get('new-books');
    const first = shelves.page(worker, shelf, {});
    const second = shelves.page(worker, {...shelf, filters:{...shelf.filters, lang:'en'}}, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pending.length, 2);
    const shared = shelves.page(worker, shelf, {});
    await assert.rejects(shelves.page(worker, {...shelf, filters:{...shelf.filters, lang:'de'}}, {}), error => error.status === 503);
    assert.strictEqual(pending.length, 2, 'Excess requests do not start more scans');
    pending[0].resolve(new Uint32Array()); await first; await shared;
    const rejected = assert.rejects(second, /offline/);
    pending[1].reject(new Error('offline')); await rejected;
    const retry = shelves.page(worker, {...shelf, filters:{...shelf.filters, lang:'en'}}, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pending.length, 3, 'A failed scan may be retried');
    worker.db = {};
    const stale = assert.rejects(retry, error => error.status === 503);
    pending[2].resolve(new Uint32Array()); await stale;
}

module.exports = [testCatalogShelfDefinitionsRejectPrivateAndUnknownSettings, testCatalogShelfFileReloadAndFailuresAreBounded,
    testCatalogShelfRootRemainsAvailableWithBrokenConfig, testCatalogShelvesReadOnlyOnePageAndKeepAllOriginalFilters,
    testCatalogShelvesInvalidateOnDefinitionIndexAndDateChanges, testCatalogShelfHttpAuthPaginationAndHotReload,
    testCatalogShelfWorkIsBoundedAndDiscardsOldDatabaseResults];
