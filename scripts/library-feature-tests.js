const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-features-'));
    try {await task(dir);} finally {await fs.remove(dir);}
}

async function testRatingCountRangesUseAnIndexAndInvalidateSearchCaches() {
    const {parse} = require('../shared/RatingCount');
    for (const [value, expected] of [['20',{min:20,max:20}], ['20..',{min:20,max:Infinity}], ['..40',{min:0,max:40}], ['10..40',{min:10,max:40}]])
        assert.deepStrictEqual(parse(value), expected);
    for (const bad of ['-1','2..1','1..2..3','1.5','Infinity','9007199254740993']) assert.throws(() => parse(bad));
    await temporary(async dir => {
        const {JembaDb} = require('jembadb');
        const library = path.join(dir, 'library'); await fs.ensureDir(library);
        for (let i = 0; i < 5; i++) await fs.writeFile(path.join(library, `${i}.fb2`),
            `<FictionBook><description><title-info><genre>sf</genre><author><last-name>Тестов</last-name></author>` +
            `<book-title>Книга ${i}</book-title><lang>ru</lang></title-info></description><body><section><p>Текст.</p></section></body></FictionBook>`);
        const config = {dataDir:path.join(dir,'data'), libDir:library, inpxFilterFile:path.join(dir,'no-filter'),
            dbVersion:14, dbCacheSize:5, fullOptimization:false, queryCacheEnabled:true, queryCacheMemSize:30, queryCacheDiskSize:0,
            librarySources:[{id:'own',name:'Own',type:'folder',libDir:library}]};
        await fs.ensureDir(config.dataDir);
        const db = new JembaDb(); await db.lock({dbPath:path.join(config.dataDir,'db'),create:true});
        let searcher;
        try {
            await new (require('../server/core/DbCreator'))(config).run(db, () => {}); await db.openAll();
            searcher = new (require('../server/core/DbSearcher'))(config, db); await searcher.init();
            const books = await db.select({table:'book'}), ratings = new Map();
            const {entryKey} = require('../server/core/LibraryReviews');
            for (const [i, book] of books.entries()) if (i < 4) ratings.set(entryKey(book.folder, `${book.file}.${book.ext}`), {count:(i + 1) * 10});
            let revision = 1, scans = 0;
            const select = db.select.bind(db);
            db.select = options => {if (String(options.map).includes('sourceLibDir')) scans++; return select(options);};
            const worker = {config, db, libraryAssetGeneration:1,
                getReviewArchiveState:async() => ({signature:String(revision)}), ensureLibraryRatings:async() => ratings};
            searcher.ratingIndex = new (require('../server/core/LibraryRatingIndex'))(worker);
            const results = await Promise.all(['20..30','20..30','20..30'].map(ratingCount => searcher.bookSearchIds({ratingCount})));
            assert(results.every(ids => ids.length === 2)); assert.strictEqual(scans, 1, 'Concurrent requests share a single index build');
            assert.strictEqual((await searcher.search('title', {ratingCount:'20..30'})).totalFound, 2);
            const author = await searcher.search('author', {ratingCount:'20..30'});
            assert.strictEqual(author.found[0].bookCount,2, 'Displayed counts agree with filtered books');
            const expanded = await searcher.getAuthorBookList(author.found[0].id, '', {ratingCount:'20..30'});
            assert.strictEqual(expanded.books.length, 2, 'Expanded authors must not leak books outside the vote filter');
            assert.strictEqual((await searcher.bookSearchIds({ratingCount:'0'})).length, 0, 'Missing counts are not zero votes');
            assert.strictEqual(scans, 1, 'Different ranges reuse the same index');
            assert.strictEqual((await searcher.bookSearchIds({ratingCount:'20..30',sourceId:'missing'})).length, 0);
            revision++;
            for (const value of ratings.values()) value.count = 1;
            assert.strictEqual((await searcher.bookSearchIds({ratingCount:'20..30'})).length, 0, 'Changed metadata invalidates cached searches');
            assert.strictEqual(scans, 2);
            await assert.rejects(searcher.bookSearchIds({ratingCount:'invalid'}), /Число голосов/);
        } finally {if (searcher) await searcher.close(); await db.unlock();}
    });
}

async function testRatingIndexSeparatesSourcesAndRejectsObsoleteBuilds() {
    const Index = require('../server/core/LibraryRatingIndex');
    const a = path.resolve('source-a'), b = path.resolve('source-b');
    let entered, release;
    const started = new Promise(resolve => {entered = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    const worker = {config:{libDir:a,librarySources:[{id:'a',libDir:a},{id:'b',libDir:b}]},libraryAssetGeneration:1,
        db:{esc:JSON.stringify, select:async query => query.rawResult ? [{rawResult:[1,2]}]
            : [{id:1,folder:'books.zip',file:'one',ext:'fb2',sourceLibDir:a},{id:2,folder:'books.7z',file:'one',ext:'fb2',sourceLibDir:b}]},
        getReviewArchiveState:async dir => ({signature:dir}),
        ensureLibraryRatings:async state => {entered(); await gate; return new Map([['books.zip#one.fb2',{count:state.signature === a ? 10 : 100}]]);}};
    const index = new Index(worker), pending = index.select('50..');
    await started; worker.libraryAssetGeneration++;
    const rejection = assert.rejects(pending, /Библиотека обновилась/), newest = index.select('50..');
    release(); await rejection;
    const current = await newest;
    assert.deepStrictEqual(Array.from(current.ids), [2]);
    assert.notStrictEqual((await new Index(worker).select('50..')).signature,current.signature, 'A restarted provider cannot continue an old snapshot');
}

async function testRatingIndexReadsEachBookOnceAcrossMultipleBatches() {
    await temporary(async dir => {
        const db = new (require('jembadb').JembaDb)();
        await db.lock({dbPath:dir,create:true});
        try {
            await db.create({table:'book'});
            const books = Array.from({length:10003}, (_, i) => ({id:i * 2 + 1,folder:'books.zip',file:String(i),ext:'fb2'}));
            await db.insert({table:'book',rows:books});
            const rows = db.table.get('book').rowsInterface, getRow = rows.getRow.bind(rows);
            let reads = 0, largestBatch = 0;
            rows.getRow = async id => {reads++; return getRow(id);};
            const select = db.select.bind(db);
            db.select = async query => {
                const before = reads, result = await select(query);
                largestBatch = Math.max(largestBatch, reads - before);
                return result;
            };
            const worker = {db,config:{libDir:dir},libraryAssetGeneration:1,
                getReviewArchiveState:async() => ({signature:'same'}),
                ensureLibraryRatings:async() => new Map([['books.zip#0.fb2',{count:10}],['books.zip#10002.fb2',{count:30}]])};
            const index = new (require('../server/core/LibraryRatingIndex'))(worker);
            assert.deepStrictEqual(Array.from((await index.select('10..')).ids), [1,20005]);
            assert.strictEqual(reads, books.length, 'Offset pagination must never reload the entire library for every batch');
            assert(largestBatch <= 5000, 'Limit selected IDs before JembaDb loads and clones rows');
            assert.deepStrictEqual(Array.from((await index.select('20..')).ids), [20005]);
            assert.strictEqual(reads, books.length, 'Subsequent ranges reuse the index without reading books again');
        } finally {await db.unlock();}
    });
}

async function testOpdsShelfSettingsPersistAndAreProtectedByOwnership() {
    await temporary(async dir => {
        const Store = require('../server/core/ReadingListStore'), config = {dataDir:dir,adminPassword:'fixture-password'};
        const store = new Store(config), owner = await store.createUser({name:'Owner'}), other = await store.createUser({name:'Other'});
        const list = await store.createList(owner.id,'Новая фантастика','opds',{genre:'sf',date:'month',ratingCount:'20..'});
        await store.setListVisibility(owner.id,list.id,'opds',{pinned:true,grouping:'authors'});
        const reopened = new Store(config), loaded = await reopened.getList(owner.id,list.id);
        assert.deepStrictEqual(loaded.opds,{pinned:true,grouping:'authors'});
        await assert.rejects(store.setListVisibility(other.id,list.id,'opds',{pinned:true}), /Список не найден/);
        const backup = await store.exportData(owner.id); assert.deepStrictEqual(backup.lists[0].opds, loaded.opds);
        await store.importData(other.id,backup);
        const restored = (await store.getLists(other.id))[0]; assert.deepStrictEqual(restored.opds,loaded.opds);
        const query = require('../server/core/SmartShelf').query(restored.filters);
        assert.match(query.date,/^\d{4}-\d{2}-\d{2}$/); assert.strictEqual(restored.filters.date,'month');
    });
}

function xml(text) {const parser = new (require('../server/core/xml/XmlParser'))(); parser.fromString(text); return parser;}

async function testOpdsShelfPagesPreserveGroupsProfilesAndEveryBook() {
    const Page = require('../server/core/opds/ReadingListPage');
    const page = Object.create(Page.prototype);
    const books = Array.from({length:123}, (_, i) => ({_uid:String(i),title:`Книга ${i}`,author:'Автор & Один,Автор Два',series:'Цикл',ext:'fb2'}));
    const list = {name:'Большая полка',opds:{grouping:'authors'}};
    Object.assign(page,{config:{},opdsRoot:'/opds',id:'shelf',title:'Полка',rootTag:'feed',webWorker:{getReadingList:async() => ({list,books})}});
    const request = query => ({query:{id:'shelf',user:'reader',...query},originalUrl:'/opds/reading-lists/list?id=shelf&user=reader'});
    let result = xml(await page.body(request({})));
    const groups = result.$$array('feed/entry'); assert.strictEqual(groups.length,2);
    const group = 'Автор & Один', found = [];
    for (let number = 1; number <= 3; number++) {
        result = xml(await page.body(request({group,page:number})));
        const entries = result.$$array('feed/entry');
        found.push(...entries.filter(entry => /^\d+$/.test(entry.text('/id'))).map(entry => entry.text('/id')));
        for (const entry of entries) {
            const link = entry.attrs('/link');
            const url = new URL(require('he').decode(link.href),'http://fixture');
            assert.strictEqual(url.searchParams.get('user'),'reader');
            if (['next','previous'].includes(entry.text('/id'))) assert.strictEqual(url.searchParams.get('group'),group);
        }
    }
    assert.strictEqual(found.length,123); assert.strictEqual(new Set(found).size,123);
    list.opds.grouping = 'books'; result = xml(await page.body(request({})));
    assert.strictEqual(result.$$array('feed/entry').filter(entry => /^\d+$/.test(entry.text('/id'))).length,50);
}

async function testOpdsExtrasEscapeMetadataAndKeepPersonalFormatLinks() {
    const Page = require('../server/core/opds/BookExtrasPage');
    const book = {_uid:'book',title:'Книга & <x>',author:'Автор & Один',ext:'fb2'};
    const worker = {getBookRecordByUid:async uid => uid === 'book' ? book : null,
        getBookReviews:async() => Array.from({length:25}, () => ({name:'Reader',time:'Today',text:'<script>alert(1)</script> & текст'})),
        getAuthorInfo:async() => ({authorInfo:{html:'<p>Биография</p><img src=x onerror=bad()><a href="javascript:bad()">bad</a>'}})};
    const request = {query:{uid:'book',user:'reader'},opdsUser:{defaultOpdsFormat:'epub'},originalUrl:'/opds/book/reviews?uid=book&user=reader'};
    for (const kind of ['reviews','authors']) {
        const page = Object.create(Page.prototype);
        Object.assign(page,{kind,config:{bookPathStatic:'/book',conversionFormats:['epub'],conversionEnabled:true},
            opdsRoot:'/opds',id:kind,title:kind,rootTag:'feed',webWorker:worker});
        const text = await page.body(request), result = xml(text);
        assert(!text.includes('<script>')); assert(!text.includes('javascript:')); assert(!text.includes('onerror='));
        const entries = result.$$array('feed/entry');
        if (kind === 'reviews') assert.strictEqual(entries.length,22, '20 reviews, next page and book link');
        const acquisition = entries[0].$$array('/link').map(link => link.attrs()).find(link => link.rel === 'http://opds-spec.org/acquisition');
        assert.strictEqual(acquisition.type,'application/epub+zip'); assert(acquisition.href.includes('format=epub'));
        const back = entries.at(-1).attrs('/link'); assert(back.href.includes('user=reader'));
        await assert.rejects(page.body({...request,query:{uid:'missing'}}), /Книга не найдена/);
    }
}

async function testTolinoCompatibilityPreservesAuthAndDoesNotChangeStandardFeeds() {
    const {decorate,mount} = require('../server/core/opds/Compatibility');
    const original = {entry:[{link:[{'*ATTRS':{href:'/opds/title?user=one',rel:'subsection'}},
        {'*ATTRS':{href:'/book/file',rel:'http://opds-spec.org/acquisition',type:'application/epub+zip'}}]}]};
    assert.strictEqual(decorate(original,{}),original);
    const altered = decorate(original,{opds:{compatibility:'tolino'}});
    assert.strictEqual(original.entry[0].link.length,2); assert.strictEqual(altered.entry[0].link.length,3);
    assert.strictEqual(altered.entry[0].link[2]['*ATTRS'].href,'/opds/title?user=one');
    assert(!altered.entry[0].link[2]['*ATTRS'].rel);
    assert.strictEqual(decorate(altered,{opds:{compatibility:'tolino'}}).entry[0].link.length,3);
    const app = require('express')(), config = {opds:{compatibility:'standard'}};
    app.use('/opds',(req,res,next) => req.headers.authorization === 'fixture' ? next() : res.sendStatus(401));
    mount(app,['/opds','/opds/*'],(req,res) => res.json({user:req.query.user}),config);
    const server = await new Promise(resolve => {const instance = app.listen(0,'127.0.0.1',() => resolve(instance));});
    const url = `http://127.0.0.1:${server.address().port}/opds?user=reader`;
    try {
        assert.strictEqual((await fetch(url,{method:'POST'})).status,401);
        assert.strictEqual((await fetch(url,{method:'POST',headers:{authorization:'fixture'}})).status,405);
        config.opds.compatibility = 'tolino';
        const response = await fetch(url,{method:'POST',headers:{authorization:'fixture'}});
        assert.strictEqual(response.status,200); assert.strictEqual((await response.json()).user,'reader');
        assert.strictEqual((await fetch(url)).status,401);
    } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}

async function bundle(files) {
    const zip = new (require('yazl').ZipFile)(), chunks = [];
    const complete = new Promise((resolve,reject) => {zip.outputStream.on('data',chunk => chunks.push(chunk));
        zip.outputStream.on('end',() => resolve({data:Buffer.concat(chunks).toString('base64')})); zip.outputStream.on('error',reject);});
    for (const [name,text] of Object.entries(files)) zip.addBuffer(Buffer.from(text),name);
    zip.end(); return complete;
}

async function testWebAppUpdatesPreserveCustomFilesAndCleanOnlyManagedAssets() {
    await temporary(async dir => {
        const install = require('../server/createWebApp'), config = {publicDir:path.join(dir,'public'),tempDir:path.join(dir,'tmp'),version:'test',rootPathStatic:''};
        await fs.outputFile(path.join(config.publicDir,'reader','custom.html'),'User reader');
        await fs.outputFile(path.join(config.publicDir,'manual.txt'),'User file');
        const first = await bundle({'index.html':'First','bundle.old.js':'Old JS'});
        await install(config,{bundle:first});
        await fs.outputFile(path.join(config.publicDir,'bundle.old.js.replaced'),'old replacement');
        const second = await bundle({'index.html':'Second','bundle.new.js':'New JS'});
        await install({...config,version:'next'},{bundle:second});
        assert.strictEqual(await fs.readFile(path.join(config.publicDir,'index.html'),'utf8'),'Second');
        assert.strictEqual(await fs.readFile(path.join(config.publicDir,'reader','custom.html'),'utf8'),'User reader');
        assert.strictEqual(await fs.readFile(path.join(config.publicDir,'manual.txt'),'utf8'),'User file');
        assert.strictEqual(await fs.pathExists(path.join(config.publicDir,'bundle.old.js')),false);
        assert.strictEqual(await fs.pathExists(path.join(config.publicDir,'bundle.old.js.replaced')),false);
        const before = (await fs.stat(path.join(config.publicDir,'index.html'))).mtimeMs;
        await install({...config,version:'next'},{bundle:second});
        assert.strictEqual((await fs.stat(path.join(config.publicDir,'index.html'))).mtimeMs,before);
        await assert.rejects(install({...config,version:'bad'},{bundle:{data:Buffer.from('bad ZIP').toString('base64')}}));
        assert.strictEqual(await fs.readFile(path.join(config.publicDir,'index.html'),'utf8'),'Second');
        assert.deepStrictEqual(await fs.readdir(config.tempDir),[]);
        for (const bad of ['../file','/absolute','a/../../x','C:/file','a\\b','.inpx-web-managed.json'])
            assert.strictEqual(require('../server/core/WebAppFiles').safeName(bad),false);
        const outside = path.join(dir,'outside'); await fs.ensureDir(outside);
        await fs.symlink(outside,path.join(config.publicDir,'linked'),process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(install({...config,version:'link'},{bundle:await bundle({'linked/evil.txt':'Bad'})}), /Символическая ссылка/);
        assert.strictEqual(await fs.pathExists(path.join(outside,'evil.txt')),false);
    });
}

async function testRemoteMetadataNegotiatesVersionsAndValidatesPaginatedSnapshots() {
    const Remote = require('../server/core/RemoteMetadata');
    const calls = [], legacy = new Remote({wsRequest:async req => {calls.push(req.action); return {};}});
    assert.deepStrictEqual(await legacy.reviews('book'),[]); assert.strictEqual(await legacy.author('Author'),null);
    assert.strictEqual((await legacy.ratingIndex()).signature,'legacy'); assert.deepStrictEqual(calls,['get-config']);
    await assert.rejects(new Remote({wsRequest:async() => ({libraryProtocol:{version:99}})}).supported(), /Несовместимая версия/);
    let revision = 'one', wrong = false, indexRequests = 0;
    const remote = new Remote({wsRequest:async req => {
        if (req.action === 'get-config') return {libraryProtocol:{version:1,features:['ratings','metadata']}};
        if (req.kind === 'ratings') {indexRequests++; return {revision:wrong && req.cursor ? 'other' : revision,
            items:req.cursor ? [['two',20]] : [['one',10]], next:req.cursor ? null : 1};}
        if (req.kind === 'reviews') return {items:[{name:'Reader',text:'Text'}],next:wrong ? 0 : null};
        if (req.kind === 'author') return {authorInfo:{html:'<p>Bio</p><img onerror=bad()>'}};
        return {rating:{count:10,value:4.5}};
    }});
    const snapshots = await Promise.all([remote.ratingIndex(),remote.ratingIndex()]);
    assert.strictEqual(indexRequests,2); assert.strictEqual(snapshots[0],snapshots[1]);
    assert.deepStrictEqual([...snapshots[0].counts],[['one',10],['two',20]]);
    assert.strictEqual((await remote.reviews('book')).length,1);
    assert.strictEqual((await remote.rating('book')).value,4.5);
    assert(!(await remote.author('Author')).html.includes('onerror'));
    remote.ratings = null; wrong = true;
    await assert.rejects(remote.ratingIndex(), /Индекс удалённой библиотеки/);
    assert.strictEqual(remote.ratings,null, 'An incomplete snapshot is never published');
    await assert.rejects(remote.reviews('book'), /пагинация/);
    wrong = false; revision = 'two'; assert.strictEqual((await remote.ratingIndex()).signature,'two');
}

async function testLibraryExchangeDoesNotExposePathsAndRejectsMixedRevisions() {
    const {respond} = require('../server/core/LibraryExchange');
    const worker = {checkMyState:() => {}, dbSearcher:{ratingIndex:{load:async() => ({signature:'revision',entries:[[20,1]]})}},
        db:{esc:JSON.stringify, select:async() => [{id:1,uid:'book'}]},
        getBookRecordByUid:async uid => uid === 'book' ? {_uid:uid,sourceLibDir:'PRIVATE_PATH'} : null,
        getBookReviews:async() => [{name:'Reader',text:'Review',path:'PRIVATE_PATH'}], getBookLibraryRating:async() => ({count:20,value:4}),
        getAuthorInfo:async() => ({authorInfo:{html:'<p>Bio</p>',path:'PRIVATE_PATH'}})};
    const index = await respond(worker,{kind:'ratings'}); assert.deepStrictEqual(index.items,[['book',20]]);
    await assert.rejects(respond(worker,{kind:'ratings',revision:'old'}), /Индекс оценок обновился/);
    const reviews = await respond(worker,{kind:'reviews',bookUid:'book'}); assert(!JSON.stringify(reviews).includes('PRIVATE_PATH'));
    assert(!JSON.stringify(await respond(worker,{kind:'author',author:'Author'})).includes('PRIVATE_PATH'));
    await assert.rejects(respond(worker,{kind:'reviews',bookUid:'missing'}), /Книга не найдена/);
    await assert.rejects(respond(worker,{kind:'ratings',cursor:-1}), /позиция/);
    worker.checkMyState = () => {throw new Error('Not ready');};
    await assert.rejects(respond(worker,{kind:'ratings'}), /Not ready/);
}

async function testPinnedOpdsShelvesAndTheirCachesStayInsideTheProfile() {
    await temporary(async dir => {
        const store = new (require('../server/core/ReadingListStore'))({dataDir:dir,adminPassword:'fixture-password'});
        const a = await store.createUser({name:'Alice'}), b = await store.createUser({name:'Bob'});
        const first = await store.createList(a.id,'Alice shelf','opds'), second = await store.createList(b.id,'Bob shelf','opds');
        const hidden = await store.createList(a.id,'Private shelf','private');
        for (const [user,list] of [[a,first],[b,second],[a,hidden]]) await store.setListVisibility(user.id,list.id,list.visibility,{pinned:true});
        const root = Object.create(require('../server/core/opds/RootPage').prototype);
        const worker = {readingListStore:store,getOpdsUserReadingLibrary:async() => ({counters:{}}),getOpdsUsers:async() => []};
        Object.assign(root,{config:{},opdsRoot:'/opds',rootTag:'feed',id:'root',title:'Library',webWorker:worker});
        for (const field of ['authorPage','seriesPage','titlePage','genrePage','readingListsPage','readingProfilesPage'])
            root[field] = {myEntry:() => ({id:field,title:field})};
        root.readingProgressPage = {myEntry:(req,state) => ({id:state,title:state})};
        for (const user of [a,b]) {
            const text = await root.body({query:{user:user.id},originalUrl:'/opds'});
            assert(text.includes(user === a ? 'Alice shelf' : 'Bob shelf'));
            assert(!text.includes(user === a ? 'Bob shelf' : 'Alice shelf')); assert(!text.includes('Private shelf'));
        }
        assert(!(await root.body({query:{},originalUrl:'/opds'})).includes('shelf'));
        let calls = 0;
        worker.getReadingList = async(user,id) => {calls++; return {list:await store.getList(user,id,{visibility:'opds'}),books:[]};};
        const {load,page} = require('../server/core/opds/ShelfPageData');
        const cached = await load(worker,a.id,first.id); assert.strictEqual(await load(worker,a.id,first.id),cached); assert.strictEqual(calls,1);
        await assert.rejects(load(worker,b.id,first.id), /Список не найден/);
        await store.renameList(a.id,first.id,'Changed'); assert.notStrictEqual(await load(worker,a.id,first.id),cached); assert.strictEqual(calls,2);
        await store.deleteList(a.id,first.id); await assert.rejects(load(worker,a.id,first.id), /Список не найден/);
        assert.strictEqual(page([{author:''}],{grouping:'authors'},{}).entries[0].group,'Без автора');
    });
}

async function testVoteFilteredClientListsAvoidPersistentStaleMetadata() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const Type = loadClient(path.resolve(__dirname,'../client/components/Search/BaseList.js')).default;
    const list = new Type(), books = [{_uid:'rated'}], series = ['Saga'];
    list.abCacheEnabled = true; list.getQuery = () => ({ratingCount:'20..'});
    list.api = {getAuthorBookList:async() => ({books}),getSeriesBookList:async() => ({books}),getAuthorSeriesList:async() => ({series})};
    list.$root = {stdDialog:{alert:message => {throw new Error(message);}}};
    assert.deepStrictEqual(await list.loadAuthorBooks(1),books);
    assert.deepStrictEqual(await list.loadSeriesBooks('Saga'),books);
    assert.deepStrictEqual(await list.loadAuthorSeries(1),series);
    const {bookUrl} = require('../server/core/RemoteLib');
    for (const link of ['/library/book/abcdef','book/abcdef','https://example.test/library/book/abcdef'])
        assert.deepStrictEqual(bookUrl('https://example.test','/library',link),{url:'https://example.test/library/book/abcdef',hash:'abcdef'});
    for (const link of ['https://evil.test/book/abcdef','//evil.test/book/abcdef','/book/../../etc/passwd','https://user:pass@example.test/book/abcdef'])
        assert.throws(() => bookUrl('https://example.test','/library',link), /Некорректная ссылка/);
}

module.exports = [testRatingCountRangesUseAnIndexAndInvalidateSearchCaches, testRatingIndexSeparatesSourcesAndRejectsObsoleteBuilds,
    testRatingIndexReadsEachBookOnceAcrossMultipleBatches,
    testOpdsShelfSettingsPersistAndAreProtectedByOwnership, testOpdsShelfPagesPreserveGroupsProfilesAndEveryBook,
    testOpdsExtrasEscapeMetadataAndKeepPersonalFormatLinks, testTolinoCompatibilityPreservesAuthAndDoesNotChangeStandardFeeds,
    testWebAppUpdatesPreserveCustomFilesAndCleanOnlyManagedAssets, testRemoteMetadataNegotiatesVersionsAndValidatesPaginatedSnapshots,
    testLibraryExchangeDoesNotExposePathsAndRejectsMixedRevisions, testPinnedOpdsShelvesAndTheirCachesStayInsideTheProfile,
    testVoteFilteredClientListsAvoidPersistentStaleMetadata];
