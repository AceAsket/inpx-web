const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {normalize,extract} = require('../shared/Isbn');

async function testIsbnNormalizationValidatesChecksumsAndEditionAliases() {
    for (const value of ['0306406152','0-306-40615-2','9780306406157','ISBN-13: 978 0 306 40615 7','urn:isbn:9780306406157'])
        assert.strictEqual(normalize(value),'9780306406157');
    assert.strictEqual(normalize('0-8044-2957-x'),'9780804429573');
    for (const value of ['', '9780306406158','0306406153','123','9780306406157 trailing','9'.repeat(101)]) assert.throws(() => normalize(value),/ISBN/);
    assert.deepStrictEqual(extract('ISBN 0-306-40615-2; 978-0-306-40615-7; ISBN 0-8044-2957-X'),['9780306406157','9780804429573']);
    const shelf = require('../server/core/SmartShelf');
    assert.strictEqual(shelf.normalize({isbn:'0306406152'}).isbn,'9780306406157');
}

async function fixture(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-isbn-'));
    const libDir = path.join(dir,'books'), dataDir = path.join(dir,'data');
    await fs.ensureDir(libDir); await fs.ensureDir(dataDir);
    const xml = value => `<FictionBook><description><title-info><author><last-name>Тестов</last-name></author><book-title>Одна книга</book-title><lang>ru</lang></title-info>` +
        `<publish-info><isbn>${value}</isbn></publish-info></description><body><section><p>Text</p></section></body></FictionBook>`;
    await fs.writeFile(path.join(libDir,'one.fb2'),xml('0-306-40615-2'));
    await fs.writeFile(path.join(libDir,'two.fb2'),xml('0-8044-2957-X'));
    await fs.writeFile(path.join(libDir,'empty.fb2'),xml(''));
    const config = {dataDir,libDir,tempDir:path.join(dir,'tmp'),inpxFilterFile:path.join(dir,'none'), dbVersion:14,dbCacheSize:5,
        fullOptimization:false,queryCacheEnabled:true,queryCacheMemSize:30,queryCacheDiskSize:0,
        librarySources:[{id:'own',name:'Own',type:'folder',libDir}]};
    const db = new (require('jembadb').JembaDb)(); await db.lock({dbPath:path.join(dataDir,'db'),create:true});
    let searcher;
    try {
        await new (require('../server/core/DbCreator'))(config).run(db,() => {}); await db.openAll();
        searcher = new (require('../server/core/DbSearcher'))(config,db); await searcher.init();
        const worker = {config,db,libraryAssetGeneration:1,resolveLibraryArchivePath:async folder => folder};
        searcher.isbnIndex = new (require('../server/core/LibraryIsbnIndex'))(worker);
        await task({worker,searcher,index:searcher.isbnIndex,libDir,xml});
    } finally {if (searcher) await searcher.close(); await db.unlock(); await fs.remove(dir);}
}

async function testIsbnSearchUsesPersistedIndexAndFiltersGroupedBooks() {
    await fixture(async({worker,searcher,index,libDir,xml}) => {
        await assert.rejects(searcher.bookSearchIds({isbn:'0306406152'}),/ещё не готов/);
        await index.start(); await index.pending;
        assert.strictEqual((await index.status()).state,'ready');
        assert.strictEqual((await index.status()).found,2);
        const query = {isbn:'978-0-306-40615-7',del:'0'};
        const found = await searcher.search('title',query);
        assert.strictEqual(found.totalFound,1);
        assert.deepStrictEqual(found.found[0].books.map(book => book.file),['one']);
        assert.strictEqual((await searcher.bookSearchIds({...query,sourceId:'missing'})).length,0);
        const author = await searcher.search('author',query);
        assert.strictEqual(author.found[0].bookCount,1);
        const expanded = await searcher.getAuthorBookList(author.found[0].id,'',query);
        assert.strictEqual(expanded.books.length,1);
        searcher.ratingIndex = {select:async() => ({ids:new Uint32Array(),deletedIds:new Set(),signature:'empty'})};
        assert.strictEqual((await searcher.bookSearchIds({...query,ratingCount:'100..'})).length,0);
        const reopened = new (require('../server/core/LibraryIsbnIndex'))(worker);
        assert.strictEqual((await reopened.select('0306406152')).ids.length,1,'Ready indexes survive restart');
        const originalRead = require('../server/core/LibraryBookData').read;
        require('../server/core/LibraryBookData').read = () => assert.fail('Search must not extract books');
        try {assert.strictEqual((await searcher.bookSearchIds(query)).length,1);} finally {require('../server/core/LibraryBookData').read = originalRead;}
        await fs.writeFile(path.join(libDir,'one.fb2'),xml('0-8044-2957-X'));
        await index.start({force:true}); await index.pending;
        assert.strictEqual((await searcher.bookSearchIds(query)).length,0,'A rebuilt ISBN index invalidates old search results');
        await worker.db.insert({table:'config',rows:[{id:'indexUpdate',value:{updatedAt:'changed'}}],replace:true});
        await assert.rejects(index.select('0306406152'),/ещё не готов/,'A changed catalog cannot reuse stale numeric IDs');
    });
}

async function testIsbnPreparationCanCancelResumeAndRejectSourceChanges() {
    await fixture(async({index,worker}) => {
        const reader = require('../server/core/LibraryBookData'), original = reader.read;
        let entered, release;
        const started = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
        reader.read = async(...args) => {entered(); await gate; return original(...args);};
        try {
            await index.start(); await started;
            await assert.rejects(index.start(),/уже выполняется/);
            index.cancel(); release(); await index.pending;
            assert.strictEqual((await index.status()).state,'paused');
            assert.match(index.job.error,/отменена/);
        } finally {reader.read = original;}
        const resumed = new (require('../server/core/LibraryIsbnIndex'))(worker);
        await resumed.start(); await resumed.pending;
        assert.strictEqual((await resumed.status()).state,'ready');
        assert.strictEqual((await resumed.status()).checked,3);
        let changed = false;
        reader.read = async(...args) => {const data = await original(...args); if (!changed) {changed = true; worker.libraryAssetGeneration++;} return data;};
        try {
            await resumed.start({force:true}); await resumed.pending;
            assert.match(resumed.job.error,/обновилась/);
            assert.strictEqual(resumed.state.complete,false);
        } finally {reader.read = original;}
    });
}

async function testIsbnReadsAllEpubIdentifiersAndProtectsPreparation() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-isbn-epub-'));
    try {
        const file = path.join(dir,'book.epub'), zip = new (require('yazl').ZipFile)();
        const pending = require('stream/promises').pipeline(zip.outputStream,fs.createWriteStream(file));
        zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),'META-INF/container.xml');
        zip.addBuffer(Buffer.from('<package><metadata><dc:identifier xmlns:dc="urn:dc">urn:isbn:0306406152</dc:identifier>' +
            '<dc:identifier xmlns:dc="urn:dc">9780804429573</dc:identifier></metadata></package>'),'book.opf');
        zip.end(); await pending;
        const data = await fs.readFile(file);
        assert.deepStrictEqual(await require('../server/core/BookMetadata').isbnFromData(data,'epub',{tempDir:dir},1024 * 1024),['9780306406157','9780804429573']);
        assert.deepStrictEqual((await fs.readdir(dir)),['book.epub'],'Temporary metadata files are removed');
        const WebWorker = require('../server/core/WebWorker');
        const worker = Object.create(WebWorker.prototype);
        worker.requireAdmin = async() => {throw new Error('admin required');};
        for (const operation of ['start','cancel']) await assert.rejects(worker.manageIsbnIndex('reader','token',operation),/admin required/);
        const Controller = require('../server/controllers/WebSocketController');
        for (const action of ['start-isbn-index','cancel-isbn-index']) assert(Controller.prototype.isCsrfProtectedAction(action));
    } finally {await fs.remove(dir);}
}

async function testIsbnCatalogFieldsMissingBooksAndSizeLimits() {
    await fixture(async({worker,index,libDir}) => {
        const books = await worker.db.select({table:'book'});
        const one = books.find(book => book.file === 'one'), two = books.find(book => book.file === 'two');
        await fs.remove(path.join(libDir,'one.fb2'));
        await fs.writeFile(path.join(libDir,'two.fb2'),'x'.repeat(1024 * 1024 + 1));
        worker.config.isbnMaxBookBytes = 1024 * 1024;
        await worker.db.insert({table:'book',rows:[{id:100,_uid:'catalog-isbn',file:'not-read',ext:'txt',isbn:'0306406152',del:1}]});
        await index.start(); await index.pending;
        const status = await index.status();
        assert.strictEqual(status.state,'ready'); assert.strictEqual(status.errors,2);
        const selected = await index.select('0306406152');
        assert.deepStrictEqual(Array.from(selected.ids),[100]); assert(selected.deletedIds.has(100));
        assert(!selected.ids.includes(one.id)); assert(!selected.ids.includes(two.id));
    });
}

module.exports = [testIsbnNormalizationValidatesChecksumsAndEditionAliases,testIsbnSearchUsesPersistedIndexAndFiltersGroupedBooks,
    testIsbnPreparationCanCancelResumeAndRejectSourceChanges,testIsbnReadsAllEpubIdentifiersAndProtectsPreparation,testIsbnCatalogFieldsMissingBooksAndSizeLimits];
