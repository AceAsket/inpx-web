const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

async function fixture(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-tools-'));
    const db = new (require('jembadb').JembaDb)();
    await db.lock({dbPath:path.join(dir,'db'),create:true});
    try {
        await db.create({table:'book',hash:{field:'_uid',type:'string',unique:true}});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        Object.assign(worker,{db,config:{dataDir:dir,libDir:dir,tempDir:path.join(dir,'tmp'),adminPassword:'fixture-only'},libraryAssetGeneration:1,
            profileSessions:new Map(),checkMyState:() => {},resolveLibraryArchivePath:async folder => folder});
        worker.readingListStore = new (require('../server/core/ReadingListStore'))(worker.config);
        await fs.ensureDir(worker.config.tempDir);
        await task(worker,dir);
    } finally {await db.unlock(); await fs.remove(dir);}
}

async function testBackgroundTaskVisibilityAndIndexReadiness() {
    const {BackgroundTasks} = require('../server/core/BackgroundTasks'), registry = new BackgroundTasks();
    const publicId = registry.start('ratings','Index',{visibility:'public'});
    const privateId = registry.start('speech','Speech',{userId:'alice'});
    registry.start('audit','Audit');
    registry.update(publicId,{total:10,done:3});
    assert.deepStrictEqual(registry.list({id:'bob'}).map(row => row.id),[publicId]);
    assert.strictEqual(registry.list({id:'alice'}).length,2);
    assert.strictEqual(registry.list({id:'admin',isAdmin:true}).length,3);
    assert(!JSON.stringify(registry.list({id:'bob'})).includes('alice'));
    registry.finish(privateId,new Error('Unavailable'));
    assert.strictEqual(registry.list({id:'alice'}).find(row => row.id === privateId).state,'error');
    const {ResourceRuntime} = require('../server/core/ResourceRuntime');
    const runtime = new ResourceRuntime({hardMax:1,taskTimeoutMs:10000,limits:{total:1,reviews:1,background:1}});
    let free;
    const first = runtime.run(() => new Promise(resolve => {free = resolve;}),{kind:'reviews'});
    const sharedRegistry = require('../server/core/BackgroundTasks'), queuedId = sharedRegistry.start('audit','Queued audit');
    const next = runtime.withTask(queuedId, () => runtime.run(async() => 'done',{kind:'reviews'}));
    assert.match(sharedRegistry.tasks.get(queuedId).waitingReason,/ресурсов/);
    free(); await first; assert.strictEqual(await next,'done');
    assert.strictEqual(sharedRegistry.tasks.get(queuedId).waitingReason,'');
    sharedRegistry.tasks.delete(queuedId);
    await fixture(async worker => {
        let release;
        const gate = new Promise(resolve => {release = resolve;});
        worker.getReviewArchiveState = async() => ({signature:'same'});
        worker.ensureLibraryRatings = async() => {await gate; return new Map();};
        const index = new (require('../server/core/LibraryRatingIndex'))(worker);
        const status = await index.status();
        assert.strictEqual(status.state,'running','Readiness answers while a slow index is still building');
        release(); await index.load();
        assert.strictEqual((await index.status()).state,'ready');
    });
}

async function testLibraryFollowsDetectOnlyNewBooksAndSurviveBackup() {
    await fixture(async worker => {
        const store = worker.readingListStore, owner = await store.createUser({name:'Owner'}), other = await store.createUser({name:'Other'});
        worker.dbSearcher = {bookSearchIds:async query => {
            const rows = await worker.db.select({table:'book'});
            return rows.filter(row => query.author ? row.author === query.author.slice(1) : row.series === query.series.slice(1)).map(row => row.id);
        }};
        await worker.db.insert({table:'book',rows:[{id:1,_uid:'old',title:'Old',author:'Author',series:'Saga',ext:'fb2'}]});
        const follows = new (require('../server/core/LibraryFollows'))(worker);
        const initial = await follows.change(owner.id,'add',{kind:'author',value:'Author'});
        assert.strictEqual(initial.follows.length,1); assert.deepStrictEqual(initial.books,[]);
        assert.strictEqual((await follows.list(other.id,true)).follows.length,0);
        await follows.change(other.id,'add',{kind:'series',value:'Saga'});
        await worker.db.insert({table:'book',rows:[{id:2,_uid:'new',title:'New',author:'Author',series:'Saga',ext:'fb2'},
            {id:3,_uid:'unrelated',title:'Other',author:'Someone',ext:'epub'}]});
        const detected = await follows.list(owner.id,true);
        assert.deepStrictEqual((await follows.list(other.id,true)).books.map(row => row._uid),['new'],'Series follow the same membership changes');
        assert.deepStrictEqual(detected.books.map(row => row._uid),['new']);
        assert.strictEqual(detected.follows[0].unread,1);
        assert(!JSON.stringify(detected).includes('knownUids'),'Do not expose historical UID snapshots in the UI response');
        const unchanged = await follows.list(owner.id,true);
        assert.strictEqual(unchanged.follows[0].revision,detected.follows[0].revision,'An unchanged refresh does not rewrite the profile');
        const exported = await store.exportData(owner.id);
        await store.importData(other.id,exported);
        assert.strictEqual((await follows.list(other.id)).books[0]._uid,'new');
        const id = detected.follows[0].id;
        await follows.change(owner.id,'seen',{id});
        // An answer started before acknowledgement cannot restore unread notifications.
        await store.changeLibraryFollow(owner.id,'snapshot',{id,revision:detected.follows[0].revision,knownUids:['old','new'],newUids:['new']});
        assert.deepStrictEqual((await follows.list(owner.id,true)).books,[]);
        await follows.change(owner.id,'remove',{id});
        assert.strictEqual((await follows.list(owner.id)).follows.length,0);
        assert.strictEqual((await follows.list(other.id)).follows.length,1,'Removing a follow affects only its owner');
    });
}

async function testLibraryToolsRequireProfileAndAdminForAudit() {
    await fixture(async worker => {
        const passwordHash = await require('../server/core/ProfilePassword').hash('fixture');
        const owner = await worker.readingListStore.createUser({name:'Owner',login:'owner',passwordHash});
        const other = await worker.readingListStore.createUser({name:'Other',login:'other',passwordHash});
        const token = worker.createProfileSession(owner.id);
        await assert.rejects(worker.getBackgroundTasks(owner.id,''),/need_profile_login/);
        await assert.rejects(worker.libraryFollowAction(other.id,token,'list'),/need_profile_login/);
        await assert.rejects(worker.auditLibrary(owner.id,token,'start'),/администратор/);
        const taskRegistry = require('../server/core/BackgroundTasks');
        const id = taskRegistry.start('audit','PRIVATE_AUDIT');
        try {assert(!(await worker.getBackgroundTasks(owner.id,token)).tasks.some(row => row.id === id));}
        finally {taskRegistry.tasks.delete(id);}
    });
}

async function zip(file, entries) {
    const archive = new (require('yazl').ZipFile)();
    const pending = require('stream/promises').pipeline(archive.outputStream,fs.createWriteStream(file));
    for (const [name,data] of Object.entries(entries)) archive.addBuffer(Buffer.from(data),name);
    archive.end(); await pending;
}

async function testLibraryAuditFindsMissingAndBrokenBooksWithoutChangingSources() {
    await fixture(async(worker,dir) => {
        worker.config.auditMaxBookBytes = 1024 * 1024;
        const good = '<FictionBook><body><section><p>Текст книги.</p></section></body></FictionBook>';
        await fs.writeFile(path.join(dir,'good.fb2'),good);
        await fs.writeFile(path.join(dir,'bad.fb2'),'<FictionBook><body>');
        await fs.writeFile(path.join(dir,'large.fb2'),'x'.repeat(1024 * 1024 + 1));
        await zip(path.join(dir,'books.zip'),{'inside.fb2':good});
        await zip(path.join(dir,'bad.epub'),{'mimetype':'application/epub+zip'});
        await zip(path.join(dir,'good.epub'),{'META-INF/container.xml':'<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
            'book.opf':'<package><metadata/><manifest/><spine/></package>'});
        const rows = [
            {file:'good',ext:'fb2'},{file:'bad',ext:'fb2'},{file:'gone',ext:'fb2'},
            {file:'inside',ext:'fb2',folder:'books.zip'},{file:'gone',ext:'fb2',folder:'books.zip'},
            {file:'bad',ext:'epub'},{file:'good',ext:'epub'},{file:'large',ext:'fb2'},
        ].map((book,i) => ({folder:'.',...book,id:i + 1,_uid:'book-' + i,title:'Book ' + i}));
        await worker.db.insert({table:'book',rows});
        const audit = new (require('../server/core/LibraryAudit'))(worker);
        audit.start({deep:true}); await audit.pending;
        const report = audit.describe();
        assert.strictEqual(report.error,undefined);
        assert.strictEqual(report.checked,8); assert.strictEqual(report.missing,2); assert.strictEqual(report.damaged,2,JSON.stringify(report)); assert.strictEqual(report.skipped,1);
        assert(!Object.hasOwn(report,'controller'));
        assert.strictEqual(await fs.readFile(path.join(dir,'good.fb2'),'utf8'),good);
        assert.strictEqual((await fs.readdir(worker.config.tempDir)).length,0,'Temporary EPUB files are removed');
        audit.start(); await audit.pending;
        assert.strictEqual(audit.describe().damaged,0,'Quick checks do not pretend to validate book contents');
        assert.strictEqual(audit.describe().missing,2);
    });
}

async function testLibraryAuditCancellationAndSourceChangesAreNotCorruption() {
    await fixture(async worker => {
        await worker.db.insert({table:'book',rows:[{id:1,_uid:'one'},{id:2,_uid:'two'}]});
        const audit = new (require('../server/core/LibraryAudit'))(worker);
        for (const cancel of [true,false]) {
            let release, entered;
            const started = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
            let reads = 0;
            audit.check = async() => {reads++; entered(); await gate;};
            audit.start(); await started;
            assert.throws(() => audit.start(),/уже выполняется/);
            if (cancel) audit.cancel(); else worker.libraryAssetGeneration++;
            release(); await audit.pending;
            assert.strictEqual(reads,1); assert.strictEqual(audit.describe().damaged,0);
            assert.match(audit.describe().error,cancel ? /отменена/ : /обновилась/);
        }
    });
}

async function testSpeechAnchorsLocateFragmentsWithoutMixingNotes() {
    const locate = require('../shared/SpeechAnchor').locate;
    const parts = [{text:'Первая глава. Начало истории.'},{text:'Гермиона открыла книгу. Её ждали друзья.'},{text:'Третья глава. Конец истории.'}];
    assert.strictEqual(locate(parts,{textSnippet:'Гермиона открыла книгу. Ее ждали друзья.'}),1);
    assert.strictEqual(locate(parts,{textSnippet:'Начало истории. Гермиона открыла книгу.'}),0,'Anchors can cross a fragment boundary');
    assert.throws(() => locate(parts,{textSnippet:'Текста из сносок здесь нет'}),/не удалось/i);
    const {ReaderSpeech} = require('../server/core/ReaderSpeech');
    const speech = new ReaderSpeech({ttsEnabled:true,ttsUrl:'http://tts',dataDir:os.tmpdir()},{get:async() => ({data:{}})});
    const book = {fb2:[[1,'FictionBook',[],[[1,'body',[],[[1,'section',[],[[1,'p',[],[[2,'Первый абзац.']]]]],
        [1,'section',[],[[1,'p',[],[[2,'Второй абзац.']]]]]]]]]]};
    book.fb2[0][3].push([1,'body',[['name','notes']],[[1,'p',[],[[2,'Текст примечания, который не читается.']]]]]);
    const plan = await speech.plan(book,'online',{textSnippet:'Второй абзац.'});
    assert.strictEqual(plan.startChapter,1); assert.strictEqual(plan.chapters[1].anchor.textSnippet,'Второй абзац.');
    assert.strictEqual(plan.chapters[1].chapterEnd,true);
    await assert.rejects(speech.plan(book,'online',{textSnippet:'Текст примечания, который не читается.'}),/не удалось/i);
}

async function testVisibleSpeechAnchorIgnoresOffscreenTextAndFindsRepeatedParagraphs() {
    const visible = require('../shared/VisibleTextAnchor'), {key} = require('../shared/SpeechAnchor');
    const text = 'Повторяющаяся строка в книге.';
    const nodes = [-300,80,900].map(top => ({textContent:text,querySelector:() => null,closest:() => null,
        cloneNode:() => ({textContent:text,querySelectorAll:() => []}),
        getBoundingClientRect:() => ({top,bottom:top + 40,width:300,height:40,left:10,right:310})}));
    const scroller = {querySelector:() => ({querySelectorAll:() => nodes}),
        getBoundingClientRect:() => ({top:60,bottom:600,left:0,right:390})};
    const anchor = visible.capture(scroller);
    assert.strictEqual(anchor.sourceOffset,key(text).length,'The first paragraph exists in the DOM but is above the viewport');
    assert.strictEqual(visible.find(scroller,anchor),nodes[1],'Repeated text maps to its source offset instead of the first or last occurrence');
    const locate = require('../shared/SpeechAnchor').locate;
    assert.strictEqual(locate(nodes.map(node => ({text:node.textContent})),anchor),1);
}

async function testVoteSearchWaitsForReadinessWithShortSharedRequests() {
    const file = path.resolve(__dirname,'../client/components/Api/Api.vue');
    const source = require('@vue/compiler-sfc').parse(await fs.readFile(file,'utf8')).descriptor.script.content;
    const body = source.slice(source.indexOf('class Api {'),source.indexOf('export default'));
    // Keep the real API class; only browser transport and the polling clock are replaced.
    const Api = new Function('require','componentOptions','setTimeout',`${body};return Api;`)(
        require('module').createRequire(file),{},callback => queueMicrotask(callback));
    const api = Object.create(Api.prototype);
    const calls = []; let statusReads = 0;
    api.request = async query => {
        calls.push(query.action);
        if (query.action === 'get-rating-index-status') return ++statusReads === 1 ? {state:'running',done:1,total:5} : {state:'ready'};
        return {found:['ready']};
    };
    await Promise.all([api.waitForRatingIndex({ratingCount:'20..'}),api.waitForRatingIndex({ratingCount:'30..'})]);
    assert.strictEqual(statusReads,2,'Concurrent searches share readiness polling');
    assert.strictEqual(api.indexWaitMessage,'');
    assert.deepStrictEqual((await api.search('book',{ratingCount:'20..'})).found,['ready']);
    assert.deepStrictEqual(calls.slice(-2),['get-rating-index-status','search']);
    const before = calls.length;
    await assert.rejects(api.waitForRatingIndex({ratingCount:'broken'}),/голосов/);
    assert.strictEqual(calls.length,before,'Invalid ranges do not start an expensive background index');
    api.request = async() => ({state:'error',error:'Temporary index error'});
    await assert.rejects(api.waitForRatingIndex({ratingCount:'10..'}),/Temporary index error/);
    assert.strictEqual(api.ratingIndexWait,null,'A failed build can be retried');
    api.request = async() => ({state:'ready'});
    await api.waitForRatingIndex({ratingCount:'10..'});
}

module.exports = [testVisibleSpeechAnchorIgnoresOffscreenTextAndFindsRepeatedParagraphs,
    testVoteSearchWaitsForReadinessWithShortSharedRequests,testBackgroundTaskVisibilityAndIndexReadiness,testLibraryFollowsDetectOnlyNewBooksAndSurviveBackup,
    testLibraryToolsRequireProfileAndAdminForAudit,testLibraryAuditFindsMissingAndBrokenBooksWithoutChangingSources,
    testLibraryAuditCancellationAndSourceChangesAreNotCorruption,testSpeechAnchorsLocateFragmentsWithoutMixingNotes];
