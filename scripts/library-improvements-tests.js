const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {JembaDb} = require('jembadb');
const ReadingListStore = require('../server/core/ReadingListStore');
const {FolderIndexer, fingerprint} = require('../server/core/FolderIndexer');
const DbCreator = require('../server/core/DbCreator');
const DbSearcher = require('../server/core/DbSearcher');
const ImportWriteBudget = require('../server/core/ImportWriteBudget');

async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-library-improvements-'));
    try { await fn(dir); } finally { await fs.remove(dir); }
}
function fb2(title, number = 1) {
    return `<?xml version="1.0" encoding="UTF-8"?><FictionBook><description><title-info><genre>sf</genre><author><last-name>Петров</last-name><first-name>Иван</first-name></author><book-title>${title}</book-title><lang>ru</lang><sequence name="Пробная серия" number="${number}"/></title-info></description><body><section><p>Текст книги.</p></section></body></FictionBook>`;
}
async function testReadingAndAudioRevisionConflicts() {
    await temporary(async dir => {
        const store = new ReadingListStore({dataDir: dir});
        const {currentUser} = await store.getUsers();
        const uid = currentUser.id;
        const first = await store.updateReaderProgress(uid, 'book', {percent: 0.3, baseRevision: 0, updatedAt: '2099-01-01T00:00:00.000Z'});
        const [a, b] = await Promise.all([
            store.updateReaderProgress(uid, 'book', {percent: 0.5, baseRevision: first.revision, updatedAt: '2026-01-01T00:00:00.000Z'}),
            store.updateReaderProgress(uid, 'book', {percent: 0.8, baseRevision: first.revision, force: true}),
        ]);
        assert.strictEqual([a, b].filter(row => row.conflict).length, 1);
        assert.strictEqual((await store.getReaderState(uid, 'book')).progress.percent, 0.5);
        const position = await store.audioPosition(uid, 'book', 'voice-1', {chapter: 2, time: 43.5, rate: 1.25, baseRevision: 0});
        assert.strictEqual(position.revision, 1);
        assert.strictEqual((await store.audioPosition(uid, 'book', 'voice-1', {time: 5, baseRevision: 0})).conflict, true);
        const reopened = new ReadingListStore({dataDir: dir});
        assert.strictEqual((await reopened.audioPosition(uid, 'book', 'voice-1')).time, 43.5);
        assert.strictEqual((await reopened.audioPosition(uid, 'book', 'voice-2')).revision, 0);
        await store.setBooksRead(uid, ['book'], true);
        assert.strictEqual((await store.updateReaderProgress(uid, 'book', {percent: 0.6, baseRevision: a.revision})).conflict, true);
        const exported = await store.exportData(uid);
        const oldAudioRevision = (await store.audioPosition(uid, 'book', 'voice-1')).revision;
        await store.importData(uid, exported);
        assert.strictEqual((await store.audioPosition(uid, 'book', 'voice-1', {time: 10, baseRevision: oldAudioRevision})).conflict, true);
    });
}
async function testReaderBookReplacement() {
    await temporary(async dir => {
        const store = new ReadingListStore({dataDir: dir});
        const {currentUser} = await store.getUsers();
        const uid = currentUser.id;
        const other = await store.createUser({name: 'Другой читатель'});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.checkMyState = () => {};
        worker.readingListStore = store;
        worker.getBookRecordByUid = async bookUid => bookUid === 'new' || bookUid === 'occupied'
            ? {_uid: bookUid, title: 'Книга', ext: 'fb2'} : bookUid === 'epub' ? {ext: 'epub'} : null;
        const source = await store.updateReaderProgress(uid, 'missing', {percent: 0.52, sectionId: 'old-section',
            pageIndex: 52, textOffset: 8000, textSnippet: 'Место чтения', baseRevision: 0});
        await store.addReaderBookmark(uid, 'missing', {title: 'Закладка', note: 'Сохранить заметку', percent: 0.4, sectionId: 'old-section'});
        await store.audioPosition(uid, 'missing', 'voice', {chapter: 2, time: 43, baseRevision: 0});
        await store.updateReaderProgress(other.id, 'missing', {percent: 0.2, baseRevision: 0});
        await store.updateReaderProgress(uid, 'occupied', {percent: 0.1, baseRevision: 0});
        await assert.rejects(() => worker.relinkReaderBook(uid, 'missing', 'epub', source.revision), /FB2/);
        await assert.rejects(() => worker.relinkReaderBook(uid, 'new', 'occupied', 0), /доступна/);
        await assert.rejects(() => worker.relinkReaderBook(uid, 'missing', 'new', source.revision + 1), /изменился/);
        await assert.rejects(() => worker.relinkReaderBook(uid, 'missing', 'occupied', source.revision), /уже есть/);
        const [first, second] = await Promise.allSettled([
            worker.relinkReaderBook(uid, 'missing', 'new', source.revision),
            worker.relinkReaderBook(uid, 'missing', 'new', source.revision),
        ]);
        assert.strictEqual(first.status, 'fulfilled');
        assert.strictEqual(second.status, 'rejected');
        const reopened = new ReadingListStore({dataDir: dir});
        const state = await reopened.getReaderState(uid, 'new');
        assert.strictEqual(state.progress.percent, 0.52);
        assert.strictEqual(state.progress.textSnippet, 'Место чтения');
        assert.strictEqual(state.progress.sectionId, '');
        assert.strictEqual(state.progress.pageIndex, 0);
        assert.strictEqual(state.progress.textOffset, -1);
        assert.strictEqual(state.bookmarks[0].note, 'Сохранить заметку');
        assert.strictEqual(state.bookmarks[0].percent, 0.4);
        assert.strictEqual(state.bookmarks[0].sectionId, '');
        assert.strictEqual((await reopened.getReaderState(uid, 'missing')).progress.relinkedTo, 'new');
        const stale = await reopened.updateReaderProgress(uid, 'missing', {percent: 0.8, hidden: false, force: true});
        assert.strictEqual(stale.conflict, true);
        assert.strictEqual((await reopened.getReaderState(other.id, 'missing')).progress.percent, 0.2);
        assert.strictEqual((await reopened.audioPosition(uid, 'missing', 'voice')).time, 43);
        assert.strictEqual((await reopened.audioPosition(uid, 'new', 'voice')).revision, 0);
        const {user} = await reopened.resolveUser(uid);
        const library = await worker.getUserReadingLibrary(user, {state: 'all'});
        assert.strictEqual(library.counters.all, 2);
        assert.deepStrictEqual(library.items.map(book => book.bookUid).sort(), ['new', 'occupied']);
        assert.strictEqual(library.items.find(book => book.bookUid === 'new').revision, 1);
        await store.updateReaderProgress(uid, 'another-missing', {baseRevision: 0});
        worker.getBookRecordByUid = async bookUid => bookUid === 'notes-only' ? {ext: 'fb2'} : null;
        await store.addReaderBookmark(uid, 'notes-only', {note: 'Не перезаписывать'});
        await assert.rejects(() => worker.relinkReaderBook(uid, 'another-missing', 'notes-only', 1), /закладки/);
    });
}

async function testFolderIncrementalSearchAndSmartShelves() {
    await temporary(async dir => {
        const library = path.join(dir, 'library');
        await fs.ensureDir(library);
        await fs.writeFile(path.join(library, 'a.fb2'), fb2('Начало пути').replace('<genre>sf</genre>', '<genre>sf</genre><genre>sf</genre>'));
        await fs.writeFile(path.join(library, 'b.fb2'), fb2('Приключения волшебника', 2));
        const config = {dataDir: path.join(dir, 'first'), inpxFilterFile: path.join(dir, 'no-filter.json'),
            libDir: library, dbVersion: 1, dbCacheSize: 10, fullOptimization: false,
            librarySources: [{id: 'own', name: 'Свои книги', type: 'folder', libDir: library, enabled: true}]};
        await fs.ensureDir(config.dataDir);
        const db = new JembaDb();
        await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        let uid, bookId;
        try {
            await new DbCreator(config).run(db, () => {});
            await db.openAll();
            const rows = await db.select({table: 'book'});
            const [genre] = await db.select({table:'genre'});
            assert.deepStrictEqual(genre.bookIds, rows.map(book => book.id), 'Repeated fields add one posting per book');
            uid = rows.find(book => book.title.includes('волшебника'))._uid;
            bookId = rows.find(book => book._uid === uid).id;
            const searcher = new DbSearcher(config, db);
            await searcher.init();
            try {
                assert.strictEqual((await searcher.bookSearch({title: 'волшебник', del: '0'})).totalFound, 1);
                assert.strictEqual((await searcher.search('title', {title: 'вoлшебник', del: '0'})).totalFound, 1);
                assert.strictEqual((await searcher.search('author', {author: 'Иван', del: '0'})).totalFound, 1, 'Author word matching must survive the coauthor filter');
                const date = rows[0].date;
                assert.strictEqual((await searcher.bookSearch({genre: 'adv,sf', date: `${date},${date}`, librate: '0,5'})).totalFound, 2);
                assert.strictEqual((await searcher.bookSearch({genre: 'adv'})).totalFound, 0);
                const worker = Object.create(require('../server/core/WebWorker').prototype);
                worker.checkMyState = () => {};
                worker.config = config; worker.db = db; worker.dbSearcher = searcher;
                worker.readingListStore = new ReadingListStore(config);
                const {currentUser} = await worker.readingListStore.getUsers();
                const shelf = await worker.createReadingList(currentUser.id, 'Волшебники', 'opds', {title: 'волшебник', unreadOnly: true});
                const populated = await worker.getReadingList(currentUser.id, shelf.list.id);
                assert.strictEqual(populated.books.length, 1);
                assert.strictEqual(populated.list.bookCount, 1);
                assert.strictEqual(populated.books[0]._readerProgress, null);
                await worker.readingListStore.updateReaderProgress(currentUser.id, uid, {percent: 0.2, baseRevision: 0});
                const continued = await worker.getReadingList(currentUser.id, shelf.list.id);
                assert.deepStrictEqual(continued.books[0]._readerProgress, {percent: 0.2, started: true});
                const other = await worker.readingListStore.createUser({name: 'Другой читатель'});
                const shared = await worker.getReadingList(other.id, shelf.list.id, {allowForeign: true});
                assert.strictEqual(shared.books[0]._readerProgress, null, 'Reading position belongs to the viewer, not the shelf owner');
                const marked = await worker.setReadingListBookRead(currentUser.id, shelf.list.id, uid, true);
                assert.strictEqual(marked.list.bookCount, 0, 'Marking read immediately refreshes an unread smart shelf');
                assert.strictEqual((await worker.getReadingList(currentUser.id, shelf.list.id)).books.length, 0);
                const exported = await worker.readingListStore.exportData(currentUser.id);
                assert.strictEqual(exported.lists[0].filters.unreadOnly, true);
                await assert.rejects(() => worker.readingListStore.addBooks(currentUser.id, shelf.list.id, [uid]), /фильтрами/);
            } finally { await searcher.close(); }
        } finally { await db.unlock(); }
        const before = await fingerprint(config.librarySources[0]);
        await fs.remove(path.join(library, 'a.fb2'));
        await fs.writeFile(path.join(library, 'b.fb2'), fb2('Возвращение волшебника', 2));
        await fs.writeFile(path.join(library, 'c.fb2'), fb2('Последняя дорога', 3));
        assert.notStrictEqual(await fingerprint(config.librarySources[0]), before);
        const nextConfig = {...config, dataDir: path.join(dir, 'second')};
        await fs.copy(path.join(config.dataDir, 'db', 'book'), path.join(nextConfig.dataDir, 'db', 'book'));
        const next = new JembaDb();
        await next.lock({dbPath: path.join(nextConfig.dataDir, 'db')});
        try {
            await new DbCreator(nextConfig).run(next, () => {});
            await next.openAll();
            const rows = await next.select({table: 'book'});
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows.find(book => book._uid === uid).id, bookId);
            assert.strictEqual(rows.find(book => book._uid === uid).title, 'Возвращение волшебника');
            const changes = (await next.select({table: 'config', where: "@@id('indexUpdate')"}))[0].value;
            assert.strictEqual(changes.incremental, true);
            assert.strictEqual(changes.recordsChanged, 2);
            assert.strictEqual(changes.recordsRemoved, 1);
            const indexer = new FolderIndexer(nextConfig.librarySources[0], nextConfig);
            const records = [];
            await indexer.parse('', async() => {}, async chunk => records.push(...chunk));
            assert.strictEqual(records.find(book => book._uid === uid).title, 'Возвращение волшебника');
        } finally { await next.unlock(); }
    });
}
async function testBatchDownloadScopeAndArchive() {
    await temporary(async dir => {
        const batch = require('../server/core/BatchDownload');
        const book = path.join(dir, 'book.fb2'); await fs.writeFile(book, fb2('ZIP'));
        const worker = {config: {tempDir: dir, bookPathStatic: '/book'}, checkMyState() {},
            readingListStore: {getList: async() => ({books: [{bookUid: 'one'}]})},
            getReadingList: async(user, id) => { assert.strictEqual(user, 'owner'); assert.strictEqual(id, 'own-list'); return {books: [{_uid: 'one'}]}; },
            getPreparedBookFile: async uid => { assert.strictEqual(uid, 'one'); return {rawFile: book, book: {title: '../ZIP', author: 'Автор', series: '../../Серия', ext: 'fb2'}}; }};
        const result = await batch.create(worker, 'owner', {listId: 'own-list'});
        assert.strictEqual(result.count, 1);
        const token = result.url.split('/').pop();
        const archive = new (require('../server/core/ZipReader'))();
        await archive.open(path.join(dir, `batch-${token}.zip`));
        try {
            const names = Object.values(archive.entries).map(entry => entry.name);
            assert.strictEqual(names.length, 1);
            assert.ok(!names[0].split('/').includes('..'));
            assert.ok((await archive.extractToBuf(names[0])).toString().includes('<book-title>ZIP</book-title>'));
        } finally { await archive.close(); }
        await assert.rejects(() => batch.create(worker, 'owner', {bookUids: Array(201).fill('one')}), /200/);
        const app = require('express')();
        app.use((req, res, next) => { if (req.query.identity) req.profileAccessIdentity = {user: {id: req.query.identity}}; next(); });
        batch.register(app, worker.config);
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${server.address().port}`;
            assert.strictEqual((await fetch(url + result.url)).status, 200);
            assert.strictEqual((await fetch(url + result.url + '?identity=other')).status, 403);
            assert.strictEqual((await fetch(url + '/book/batch/unknown')).status, 404);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
}
async function testFolderBootAndFailedRefreshKeepsIndex() {
    await temporary(async dir => {
        const config = {...require('../server/config/base'), dataDir: path.join(dir, 'data'), libDir: path.join(dir, 'library'),
            tempDir: path.join(dir, 'tmp'), publicFilesDir: path.join(dir, 'public'), bookDir: path.join(dir, 'cache'),
            coverDir: path.join(dir, 'covers'), inpxFilterFile: path.join(dir, 'no-filter'), queryCacheEnabled: false,
            librarySources: [{id: 'own', name: 'Свои', type: 'folder', libDir: path.join(dir, 'library')}]};
        await Promise.all([config.dataDir, config.libDir, config.tempDir, config.bookDir, config.coverDir].map(folder => fs.ensureDir(folder)));
        await fs.writeFile(path.join(config.libDir, 'one.fb2'), fb2('Первая книга'));
        await require('../server/core/LibrarySources').resolveLibrarySources(config);
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        let state = {};
        worker.config = config;
        worker.wState = {set:patch => {state = {...state, ...patch};}, get:() => state};
        worker.logServerStats = () => {};
        worker.inpxHashCreator = new (require('../server/core/InpxHashCreator'))(config);
        try {
            const boot = new AbortController();
            const setState = worker.wState.set;
            worker.wState.set = patch => {
                setState(patch);
                if (patch.job === 'load inpx') boot.abort();
            };
            await worker.loadOrCreateDb(false, 0, boot.signal);
            assert.strictEqual(boot.signal.aborted, true);
            assert.strictEqual(worker.db, undefined);
            assert.deepStrictEqual(await fs.readdir(config.dataDir), [], 'Aborting startup cleans the unpublished index');
            worker.wState.set = setState;

            await worker.loadOrCreateDb();
            assert.strictEqual(worker.myState, 'normal');
            const [first] = await worker.db.select({table:'book'});
            const original = worker.db;

            await fs.writeFile(path.join(config.libDir, 'one.fb2'), fb2('Первое новое название'));
            await fs.writeFile(path.join(config.libDir, 'two.fb2'), fb2('Вторая книга'));
            const refresh = worker.recreateDb();
            assert.strictEqual(worker.recreateDb(), refresh, 'Concurrent rebuild requests join one job');
            assert.strictEqual(worker.db, original);
            assert.deepStrictEqual(await worker.getIndexStatus().then(({ready, updating}) => ({ready, updating})), {ready:true, updating:true});
            assert.strictEqual((await worker.db.select({table:'book'})).length, 1);
            await refresh;
            const books = await worker.db.select({table:'book'});
            assert.strictEqual(books.length, 2);
            const updated = books.find(book => book.file === first.file);
            assert.strictEqual(updated._uid, first._uid);
            assert.strictEqual(updated.id, first.id);
            assert.strictEqual(updated.title, 'Первое новое название');
            assert.strictEqual((await worker.dbConfig()).indexUpdate.recordsChanged, 2);

            const activeDb = worker.db, generation = worker.libraryAssetGeneration;
            await fs.writeFile(path.join(config.libDir, 'broken.fb2'), 'broken XML');
            await worker.recreateDb();
            assert.strictEqual(worker.myState, 'normal');
            assert.strictEqual(worker.db, activeDb);
            assert.strictEqual(worker.libraryAssetGeneration, generation);
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2, 'A failed refresh keeps the old working catalog');
            assert.strictEqual((await worker.getIndexStatus()).updating, false);
            assert.deepStrictEqual((await fs.readdir(config.dataDir)).filter(name => name.startsWith('db.')), []);
            await fs.remove(path.join(config.libDir, 'broken.fb2'));

            const dbPath = path.join(config.dataDir, 'db');
            const open = worker.openCatalogue.bind(worker);
            let failPublication = true;
            worker.openCatalogue = async file => {
                if (file === dbPath && failPublication) {
                    failPublication = false;
                    throw new Error('test: failed to reopen staged index');
                }
                return open(file);
            };
            await fs.writeFile(path.join(config.libDir, 'three.fb2'), fb2('Третья книга'));
            await worker.recreateDb();
            assert.strictEqual(failPublication, false);
            assert.strictEqual((await worker.getIndexStatus()).ready, true);
            assert.strictEqual((await worker.db.select({table:'book'})).length, 2, 'Reopen failure rolls back the directory swap');
            delete worker.openCatalogue;

            await worker.dbSearcher.close(); worker.dbSearcher = null; await worker.closeDb();
            await fs.move(dbPath, path.join(config.dataDir, 'db.previous'));
            await worker.loadOrCreateDb();
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2, 'Startup recovers the previous index and serves it immediately');
            await worker.indexStartupCheck;
            assert.strictEqual((await worker.db.select({table:'book'})).length, 3, 'Startup schedules a rebuild when the source changed');
            await worker.dbSearcher.close(); worker.dbSearcher = null; await worker.closeDb();
            await fs.writeFile(path.join(config.dataDir, 'db', 'title', 'state'), '0');
            await worker.loadOrCreateDb();
            const restored = await worker.db.select({table:'book'});
            assert.strictEqual(restored.length, 3, 'A damaged auxiliary table triggers a full rebuild');
            assert.strictEqual(restored.find(book => book.file === first.file)._uid, first._uid, 'Recovery retains previous book identity');
            assert.strictEqual((await worker.dbConfig()).indexUpdate.incremental, false);
        } finally {
            if (worker.dbSearcher) await worker.dbSearcher.close();
            await worker.closeDb();
        }
    });
}
async function testFolderEpubAndConcurrentChanges() {
    await temporary(async dir => {
        const library = path.join(dir, 'library', 'nested');
        await fs.ensureDir(library);
        const file = path.join(library, 'sample.epub');
        const zip = new (require('yazl').ZipFile)();
        const complete = require('stream/promises').pipeline(zip.outputStream, fs.createWriteStream(file));
        zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
        zip.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Истории путешественника</dc:title><dc:creator>Анна Петрова</dc:creator><dc:language>ru</dc:language></metadata></package>'), 'book.opf');
        zip.end(); await complete;
        const source = {id: 'own', name: 'Свои', type: 'folder', libDir: path.join(dir, 'library')};
        const config = {dataDir: path.join(dir, 'data'), librarySources: [source], inpxFilterFile: path.join(dir, 'no-filter'),
            dbVersion: 14, dbCacheSize: 10, fullOptimization: false};
        const records = [];
        await new FolderIndexer(source, config).parse('', async() => {}, async chunk => records.push(...chunk));
        assert.strictEqual(records[0].title, 'Истории путешественника');
        assert.strictEqual(records[0].author, 'Анна Петрова');
        assert.strictEqual(records[0].lang, 'ru');
        assert.strictEqual(records[0].folder, 'nested');
        const db = new JembaDb();
        await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        try {
            let changed = false;
            await assert.rejects(() => new DbCreator(config).run(db, state => {
                if (state.job === 'sort' && !changed) {
                    changed = true;
                    require('fs').writeFileSync(path.join(library, 'late.fb2'), fb2('Добавлено во время индексации'));
                }
            }), /изменились во время индексации/);
        } finally { await db.unlock(); }
    });
}
// Сервер ищет название по словам, а списки повторно фильтруют книги каждой строки. Если правила
// расходятся, строка без книг исчезает и первая страница («Волчья стая» раньше «Стая») пустеет.
async function testTitleWordMatchesSurviveListFilters() {
    await temporary(async dir => {
        const library = path.join(dir, 'library');
        await fs.ensureDir(library);
        await fs.writeFile(path.join(library, 'a.fb2'), fb2('Волчья стая'));
        await fs.writeFile(path.join(library, 'b.fb2'), fb2('Стая', 2));
        await fs.writeFile(path.join(library, 'c.fb2'), fb2('Солярис', 3));
        const config = {dataDir: path.join(dir, 'data'), inpxFilterFile: path.join(dir, 'no-filter.json'),
            libDir: library, dbVersion: 1, dbCacheSize: 10, fullOptimization: false,
            librarySources: [{id: 'own', name: 'Свои книги', type: 'folder', libDir: library, enabled: true}]};
        await fs.ensureDir(config.dataDir);
        const db = new JembaDb();
        await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        try {
            await new DbCreator(config).run(db, () => {});
            await db.openAll();
            const searcher = new DbSearcher(config, db);
            await searcher.init();
            try {
                const opds = Object.create(require('../server/core/opds/BasePage').prototype);
                for (const offset of [0, 1]) {
                    const query = {title: 'стая', del: '0', limit: 1, offset};
                    const result = await searcher.search('title', query);
                    assert.strictEqual(result.totalFound, 2);
                    assert.strictEqual(opds.filterBooks(result.found[0].books, query).length, 1,
                        `OPDS must keep the books of title "${result.found[0].title}"`);
                    const web = require('./catalog-list-filter-tests').createWebList();
                    web.search = query;
                    assert.strictEqual(web.filterBooks(result.found[0].books).length, 1,
                        `Web must keep the books of title "${result.found[0].title}"`);
                }
            } finally { await searcher.close(); }
        } finally { await db.unlock(); }
    });
}

async function testImportWriteBudget() {
    const deltas = new Map();
    const table = {tableRowsFile:{deltas}, fileError:''};
    const budget = new ImportWriteBudget({table:new Map([['book',table]])}, 'book', true);
    budget.limit = 64;
    const delta = {blockRows:[[1,'книга']], blockIndex:[[1,1]], blockList:[]};
    deltas.set(1,delta);
    assert.strictEqual(budget.pendingBytes(),42);
    await budget.wait();

    delta.blockRows.push([1,'Ю'.repeat(16)]);
    assert.strictEqual(budget.pendingBytes(),74, 'An existing delta can grow during defragmentation');
    let resumed = false;
    const waiting = budget.wait().then(() => {resumed = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(resumed,false);
    deltas.delete(1);
    await waiting;
    assert.strictEqual(budget.pendingBytes(),0);

    deltas.set(2,{blockRows:[], blockIndex:[[1,0],[2,0]], blockList:[[1,1],[2,1]]});
    const failed = budget.wait();
    table.fileError = 'test: save failed';
    await assert.rejects(failed, /test: save failed/);
}

async function testOverviewPinnedShelvesAreOrderedBoundedAndPrivate() {
    await temporary(async dir => {
        const store = new ReadingListStore({dataDir:dir, adminPassword:'local-overview-fixture-password'});
        const owner = await store.createUser({name:'Читатель', login:'reader', passwordHash:'fixture-password-hash'});
        const other = await store.createUser({name:'Второй читатель'});
        const smart = await store.createList(owner.id, 'Умная', 'private', {genre:'sf', unreadOnly:true});
        const ordinary = await store.createList(owner.id, 'Обычная', 'opds');
        await store.setListVisibility(owner.id, ordinary.id, 'opds', {pinned:true, grouping:'authors'});
        const empty = await store.createList(owner.id, 'Пустая');
        const foreign = await store.createList(other.id, 'Чужая', 'opds');
        for (const uid of ['missing','deleted',...Array.from({length:12},(_,i)=>String(i))])
            await store.setBookMembership(owner.id, ordinary.id, uid, true);
        await store.updateReaderProgress(owner.id, '0', {percent:1});

        const worker = Object.assign(Object.create(require('../server/core/WebWorker').prototype), {
            readingListStore:store, myState:'normal', libraryAssetGeneration:1,
        });
        const token = worker.createProfileSession(owner.id);
        await assert.rejects(worker.getOverviewPinnedShelves(owner.id,''), /need_profile_login/);
        await assert.rejects(worker.getOverviewPinnedShelves('missing-profile',token), /need_profile_login/);
        await assert.rejects(worker.setOverviewPinnedShelves(owner.id,token,[foreign.id]), /в вашем профиле/);
        await assert.rejects(worker.setOverviewPinnedShelves(owner.id,token,[ordinary.id,ordinary.id]), /не повторяться/);
        await assert.rejects(worker.setOverviewPinnedShelves(owner.id,token,Array(9).fill(ordinary.id)), /до 8/);

        const order = [smart.id, empty.id, ordinary.id];
        assert.deepStrictEqual(await worker.setOverviewPinnedShelves(owner.id, token, order), {shelfIds:order,maxShelves:8});
        const rows = Array.from({length:12},(_,i)=>({_uid:String(i),title:'Книга '+i,del:0}));
        let ordinaryReads = 0, smartReads = 0;
        worker.db = {esc:JSON.stringify, select:async options => {
            assert.strictEqual(options.table,'book');
            assert.match(options.where,/missing/);
            ordinaryReads++;
            return [{_uid:'deleted',del:1}, ...rows.slice().reverse()];
        }};
        worker.dbSearcher = {bookSearch:async query => {
            assert.strictEqual(query.genre,'sf');
            assert.strictEqual(query.del,'0');
            assert.strictEqual(query.limit,256);
            smartReads++;
            return {found:rows};
        }};
        const result = await worker.getOverviewPinnedShelves(owner.id, token);
        assert.strictEqual(ordinaryReads,1);
        assert.strictEqual(smartReads,1);
        assert.deepStrictEqual(result.shelfIds,order);
        assert.deepStrictEqual(result.shelves.map(item=>[item.title,item.smart,item.books.map(book=>book._uid)]), [
            ['Умная',true,['1','2','3','4','5','6','7','8']],
            ['Пустая',false,[]],
            ['Обычная',false,['0','1','2','3','4','5','6','7']],
        ]);
        assert.strictEqual(result.shelves[2].books[0]._readerProgress.percent,1);

        const snapshot = await store.exportData(owner.id);
        assert.deepStrictEqual(snapshot.user.overviewShelfNames,['Умная','Пустая','Обычная']);
        await store.importData(other.id,snapshot);
        const restored = await store.getOverviewShelfState(other.id,true);
        assert.deepStrictEqual(restored.pinned.map(item=>item.name),snapshot.user.overviewShelfNames);
        assert(restored.shelfIds.every(id=>!order.includes(id)));
        assert.deepStrictEqual((await store.getList(owner.id,ordinary.id)).opds,{pinned:true,grouping:'authors'});

        worker.dbSearcher.bookSearch = async() => {worker.libraryAssetGeneration++; return {found:rows};};
        await assert.rejects(worker.getOverviewPinnedShelves(owner.id,token), {code:'INPX_LIBRARY_CHANGED'});
        worker.dbSearcher.bookSearch = async() => {
            await store.deleteList(owner.id, empty.id);
            return {found:rows};
        };
        await assert.rejects(worker.getOverviewPinnedShelves(owner.id,token), {code:'INPX_LIBRARY_CHANGED'});
        assert.deepStrictEqual((await store.getOverviewShelfState(owner.id)).shelfIds,[smart.id,ordinary.id]);
        worker.dbSearcher.bookSearch = async() => {
            worker.closeProfileSession(token);
            return {found:rows};
        };
        await assert.rejects(worker.getOverviewPinnedShelves(owner.id,token), /need_profile_login/);
        const controller = require('../server/controllers/WebSocketController').prototype;
        assert.strictEqual(controller.isCsrfProtectedAction('set-overview-pinned-shelves'),true);
    });
}

module.exports = [testReadingAndAudioRevisionConflicts, testTitleWordMatchesSurviveListFilters, testReaderBookReplacement, testFolderIncrementalSearchAndSmartShelves, testBatchDownloadScopeAndArchive, testFolderBootAndFailedRefreshKeepsIndex, testFolderEpubAndConcurrentChanges, testImportWriteBudget, testOverviewPinnedShelvesAreOrderedBoundedAndPrivate];
if (require.main === module) {
    require('../server/core/Logger');
    (async() => {
        await new (require('../server/core/AppLogger'))().init({loggingEnabled: false, name: 'library-improvements-tests'});
        for (const test of module.exports) { await test(); console.log(`ok ${test.name}`); }
    })()
        .catch(error => { console.error(error); process.exitCode = 1; });
}
