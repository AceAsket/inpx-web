const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {JembaDb} = require('jembadb');
const ReadingListStore = require('../server/core/ReadingListStore');
const {FolderIndexer, fingerprint} = require('../server/core/FolderIndexer');
const DbCreator = require('../server/core/DbCreator');
const DbSearcher = require('../server/core/DbSearcher');

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
async function testFolderIncrementalSearchAndSmartShelves() {
    await temporary(async dir => {
        const library = path.join(dir, 'library');
        await fs.ensureDir(library);
        await fs.writeFile(path.join(library, 'a.fb2'), fb2('Начало пути'));
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
        worker.config = config; worker.setMyState = state => { worker.myState = state; }; worker.logServerStats = () => {};
        worker.inpxHashCreator = new (require('../server/core/InpxHashCreator'))(config);
        try {
            await worker.loadOrCreateDb();
            assert.strictEqual(worker.myState, 'normal');
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 1);
            await fs.writeFile(path.join(config.libDir, 'two.fb2'), fb2('Вторая книга'));
            await worker.recreateDb();
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2);
            assert.strictEqual((await worker.dbConfig()).indexUpdate.recordsChanged, 1);
            await fs.writeFile(path.join(config.libDir, 'broken.fb2'), 'broken XML');
            await worker.recreateDb();
            assert.strictEqual(worker.myState, 'normal');
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2, 'A failed refresh keeps the old working catalog');
            await fs.remove(path.join(config.libDir, 'broken.fb2'));
            await worker.dbSearcher.close(); worker.dbSearcher = null; await worker.closeDb();
            await fs.move(path.join(config.dataDir, 'db'), path.join(config.dataDir, 'db.previous'));
            await worker.loadOrCreateDb();
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2, 'Startup recovers an interrupted index swap');
            await worker.dbSearcher.close(); worker.dbSearcher = null; await worker.closeDb();
            await fs.writeFile(path.join(config.dataDir, 'db', 'title', 'state'), '0');
            await worker.loadOrCreateDb();
            assert.strictEqual((await worker.db.select({table: 'book'})).length, 2, 'A damaged auxiliary table triggers a full rebuild');
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
module.exports = [testReadingAndAudioRevisionConflicts, testFolderIncrementalSearchAndSmartShelves, testBatchDownloadScopeAndArchive, testFolderBootAndFailedRefreshKeepsIndex, testFolderEpubAndConcurrentChanges];
if (require.main === module) {
    require('../server/core/Logger');
    (async() => {
        await new (require('../server/core/AppLogger'))().init({loggingEnabled: false, name: 'library-improvements-tests'});
        for (const test of module.exports) { await test(); console.log(`ok ${test.name}`); }
    })()
        .catch(error => { console.error(error); process.exitCode = 1; });
}
