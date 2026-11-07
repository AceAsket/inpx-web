const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {distance, relevance, scope} = require('../shared/CatalogDiscovery');

async function fixture(work) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-discovery-'));
    const db = new (require('jembadb').JembaDb)();
    let searcher;
    try {
        const library = path.join(dir, 'books'); await fs.ensureDir(library);
        const entries = [
            ['Косточка', 'Толстой', 'Рассказы', 'ru'], ['Ася', 'Тургенев', 'Рассказы', 'ru'],
            ['Детство', 'Толстой', 'Трилогия', 'ru'], ['Childhood', 'Tolstoy', 'Trilogy', 'en'],
        ];
        for (let i = 0; i < entries.length; i++) {
            const [title, author, series, lang] = entries[i];
            await fs.writeFile(path.join(library, `${i}.fb2`), `<FictionBook><description><title-info><author><last-name>${author}</last-name></author><book-title>${title}</book-title><sequence name="${series}" number="${i + 1}"/><lang>${lang}</lang></title-info></description><body><section><p>Text</p></section></body></FictionBook>`);
        }
        const config = {dataDir: path.join(dir, 'data'), libDir: library, inpxFilterFile: path.join(dir, 'no-filter'),
            dbVersion: 14, queryCacheEnabled: true, queryCacheMemSize: 30, queryCacheDiskSize: 0,
            librarySources: [{id: 'own', name: 'Own', type: 'folder', libDir: library}]};
        await fs.ensureDir(config.dataDir); await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        await new (require('../server/core/DbCreator'))(config).run(db, () => {}); await db.openAll();
        searcher = new (require('../server/core/DbSearcher'))(config, db); await searcher.init();
        const worker = {db, dbSearcher: searcher, libraryAssetGeneration: 1, applyMetadataOverridesToSearchResult: async() => {}};
        const service = new (require('../server/core/CatalogDiscovery'))(worker);
        await service.warm(true);
        await work(service, worker);
        await service.close();
    } finally {if (searcher) await searcher.close(); await db.unlock().catch(() => {}); await fs.remove(dir);}
}

async function testCatalogDiscoveryIndexedSuggestionsAndScopedAlphabet() {
    assert.strictEqual(distance('толстой', 'толстйо', 1), 1);
    assert.strictEqual(distance('толстой', 'тургенев', 1), 2);
    assert(relevance('Ася', 'ася') > relevance('Ася и другие рассказы', 'ася'));
    assert.throws(() => scope({lang: '~.*'}));
    await fixture(async(service, worker) => {
        const author = await service.suggest({query: 'тол'});
        assert.strictEqual(author.groups.find(group => group.kind === 'author').items[0].name, 'Толстой');
        const title = await service.suggest({query: 'Кост'});
        assert.strictEqual(title.groups.find(group => group.kind === 'title').items[0].book.title, 'Косточка');
        const ru = await service.browse({kind: 'author', filters: {lang: 'ru'}});
        assert.deepStrictEqual(ru.items.map(item => item.name), ['Толстой', 'Тургенев']);
        assert.strictEqual(ru.items[0].count, 2);
        assert.deepStrictEqual((await service.browse({kind: 'author', prefix: 'Тур'})).items.map(item => item.name), ['Тургенев']);
        assert.deepStrictEqual((await service.suggest({query: 'тол', filters: {sourceId: 'missing'}})).groups.flatMap(group => group.items), []);
        const typo = await service.suggest({query: 'толстйо', kind: 'author'});
        assert(typo.corrections.some(item => item.kind === 'author' && item.query === 'толстой'));
        const previous = await service.suggest({query: 'тол'});
        const selectIds = worker.dbSearcher.selectBookIds.bind(worker.dbSearcher);
        worker.dbSearcher.selectBookIds = async() => {throw new Error('Typeahead must not expand authors into all book IDs');};
        assert((await service.suggest({query: 'толс'})).groups.find(group => group.kind === 'author').items.length);
        worker.dbSearcher.selectBookIds = selectIds;
        const entity = await service.entity({kind: 'series', name: 'Рассказы'}, {readerProgress: {[title.groups.find(group => group.kind === 'title').items[0].book._uid]: {percent: 1}}});
        assert.strictEqual(entity.total, 2); assert.strictEqual(entity.read, 1); assert(entity.next);
        assert.strictEqual((await service.entity({kind: 'series', name: 'Рассказы'})).read, null, 'Public entity caches contain no profile progress');
        worker.libraryAssetGeneration++;
        await service.warm(true);
        assert.notStrictEqual(await service.suggest({query: 'тол'}), previous, 'Index replacement invalidates cached responses');
        await assert.rejects(service.browse({kind: 'title'}));
        await assert.rejects(service.suggest({query: 'a'.repeat(121)}));
        const authorRows = [{id: 100, name: 'Большой', value: 'большой', bookIds: [1], bookCount: 1, bookDelCount: 0},
            ...Array.from({length: 205}, (_, index) => ({id: 101 + index, name: `Большой Автор ${index}`, value: `большой автор ${index}`,
                bookIds: [1], bookCount: 1, bookDelCount: 0}))];
        await worker.db.insert({table: 'author', rows: authorRows});
        const split = await service.browse({kind: 'author', prefix: 'большой'});
        assert(split.groups.some(group => group.name === 'Большой'), 'An exact name remains selectable beside a larger prefix');
        assert(split.groups.some(group => group.prefix === 'большой а'), 'Refinement skips invisible whitespace-only steps');
        assert.strictEqual((await service.browse({kind: 'author', prefix: 'большой '})).total, 205, 'Trailing whitespace is part of the prefix');
    });
}

async function testCatalogDiscoveryPersistentIndexAndCoalescedCache() {
    await fixture(async(service, worker) => {
        const Lookup = require('../server/core/CatalogLookupIndex');
        const reopened = new Lookup(worker);
        assert.strictEqual(await reopened.ensure(), true);
        assert.strictEqual(reopened.building, undefined, 'A complete index is reused without rebuilding');
        assert((await reopened.ids('author', 'тол')).length);
        await reopened.close();
        await service.close();
        await worker.db.open({table: 'catalog_lookup'});
        await worker.db.insert({table: 'catalog_lookup', replace: true, rows: [{id: 0, value: '', complete: false}]});
        const interrupted = new Lookup(worker);
        await interrupted.ensure(); await interrupted.building;
        assert.strictEqual(interrupted.ready, true, 'An interrupted build is rebuilt before use');
        assert((await interrupted.ids('title', 'кост')).length);
        await interrupted.close();
        let calls = 0, release;
        const gate = new Promise(resolve => {release = resolve;});
        const one = service.cached('coalesced', async() => {calls++; await gate; return {ok: true};});
        const two = service.cached('coalesced', () => {throw new Error('Concurrent queries should share work');});
        release(); assert.deepStrictEqual(await one, await two); assert.strictEqual(calls, 1);
        let finish;
        const pending = service.cached('obsolete', () => new Promise(resolve => {finish = resolve;}));
        worker.libraryAssetGeneration++;
        const rejection = assert.rejects(pending, /Библиотека обновилась/); finish({old: true}); await rejection;
        assert(!service.cache.has('obsolete'), 'A response from an old catalog cannot enter the new cache');
    });
}

async function testCatalogLookupReadsEachNameOnceAndReleasesIdleTables() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-lookup-resources-'));
    const db = new (require('jembadb').JembaDb)();
    let lookup;
    try {
        await db.lock({dbPath: directory, create: true});
        const total = 5003;
        let reads = 0;
        for (const kind of ['author', 'series', 'title']) {
            await db.create({table: kind});
            await db.insert({table: kind, rows: Array.from({length: total}, (_, i) => ({
                id: i * 2 + 7, name: `Приключения героя ${i}`, bookIds: i ? [i] : Array.from({length: 100000}, (_, j) => j),
            }))});
            const table = db.table.get(kind), getRow = table.rowsInterface.getRow.bind(table.rowsInterface);
            table.rowsInterface.getRow = async id => {reads++; return getRow(id);};
        }
        const worker = {db, libraryAssetGeneration: 1, dbSearcher: {dbConfig: {inpxHash: 'resource-test'}}};
        lookup = new (require('../server/core/CatalogLookupIndex'))(worker, {idleMs: 30});
        await lookup.ensure(); await lookup.building;
        assert.deepStrictEqual(lookup.progress, {done:total * 3, total:total * 3}, 'Cold builds report progress across all three kinds');
        assert.strictEqual(reads, total * 3, 'Batch limits must apply before reading/cloning source rows');
        assert.strictEqual((await lookup.ids('title', 'приключ')).length, total, 'Posting lists preserve every match, including sparse IDs');
        assert.deepStrictEqual(await lookup.ids('author', 'героя 5002'), [5002 * 2 + 7], 'Word intersections survive batch boundaries');
        const indexRows = (await db.select({table: 'catalog_lookup', count: true}))[0].count;
        assert(indexRows < total * 3 + 100, 'Repeated words share bounded posting chunks instead of a row per occurrence');
        for (let i = 0; i < 100 && db.table.has('catalog_lookup'); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert(!db.table.has('catalog_lookup'), 'An idle lookup releases its row and tree caches');
        assert.strictEqual((await lookup.ids('title', 'приключ')).length, total, 'A closed index reopens without rebuilding');
        for (const kind of ['author', 'series', 'title']) assert.strictEqual(db.table.get(kind).reducer._items.size, 0, 'Completed cursors are released');
        await lookup.close();
        assert(!db.table.has('catalog_lookup'));

        // Existing RC10 indexes are upgraded lazily; opening the server does not
        // require a library reindex or keep the obsolete posting rows resident.
        await db.open({table: 'catalog_lookup'});
        await db.insert({table: 'catalog_lookup', replace: true, rows: [{id: 0, value: '', complete: true, version: 1, signature: 'resource-test'}]});
        await db.close({table: 'catalog_lookup'});
        lookup = new (require('../server/core/CatalogLookupIndex'))(worker);
        await lookup.ensure(); await lookup.building;
        assert.strictEqual((await lookup.ids('title', 'героя')).length, total);
        const marker = (await db.select({table: 'catalog_lookup', where: '@@id(0)'}))[0];
        assert.strictEqual(marker.version, 2);

        // Idle closing must not interrupt a database read already in flight.
        lookup.idleMs = 10;
        const select = db.select.bind(db);
        let finishRead, startedRead;
        const started = new Promise(resolve => {startedRead = resolve;});
        const gate = new Promise(resolve => {finishRead = resolve;});
        db.select = async options => {
            if (options.table === 'catalog_lookup' && options.rawResult) {startedRead(); await gate;}
            return select(options);
        };
        const pending = lookup.ids('title', 'приключ');
        const rejected = assert.rejects(pending, /отменена/);
        await started;
        await new Promise(resolve => setTimeout(resolve, 40));
        assert(db.table.has('catalog_lookup'), 'An active reader holds the table open');
        let closed = false;
        const closing = lookup.close().then(() => {closed = true;});
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(closed, false, 'Shutdown waits for active readers');
        finishRead(); await rejected; await closing;
        db.select = select;
        assert(!db.table.has('catalog_lookup'));

        // Cancelling a rebuild also releases database cursors and partial tables.
        await db.open({table: 'catalog_lookup'});
        await db.insert({table: 'catalog_lookup', replace: true, rows: [{id: 0, value: '', complete: false}]});
        lookup = new (require('../server/core/CatalogLookupIndex'))(worker);
        const insert = db.insert.bind(db);
        db.insert = async options => {
            const result = await insert(options);
            if (options.table === 'catalog_lookup' && options.rows[0]?.id > 0) lookup.controller.abort();
            return result;
        };
        await lookup.ensure();
        await assert.rejects(lookup.building, /отменена/);
        assert(!db.table.has('catalog_lookup'), 'A partial build releases its table immediately');
        for (const kind of ['author', 'series', 'title']) assert.strictEqual(db.table.get(kind).reducer._items.size, 0);
        db.insert = insert;
    } finally {await lookup?.close(); await db.unlock(); await fs.remove(directory);}
}
module.exports = {testCatalogDiscoveryIndexedSuggestionsAndScopedAlphabet, testCatalogDiscoveryPersistentIndexAndCoalescedCache,
    testCatalogLookupReadsEachNameOnceAndReleasesIdleTables};
if (require.main === module) (async() => {for (const test of Object.values(module.exports)) {await test(); console.log(test.name + ': OK');}})()
    .catch(error => {console.error(error); process.exitCode = 1;});
