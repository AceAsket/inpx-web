const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {pipeline} = require('stream/promises');
const execFile = require('util').promisify(require('child_process').execFile);
const ZipReader = require('../server/core/ZipReader');
const DbSearcher = require('../server/core/DbSearcher');
const {ResourceRuntime} = require('../server/core/ResourceRuntime');
const {ImageRuntime} = require('../server/core/ImageRuntime');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-server-audit-'));
    try {await task(dir);} finally {await fs.remove(dir);}
}

async function archive(file, entries, sevenZip = false) {
    if (sevenZip) {
        const input = await fs.mkdtemp(path.join(path.dirname(file), 'input-'));
        try {
            for (const [name, data] of Object.entries(entries)) await fs.outputFile(path.join(input, name), data);
            for (const command of new ZipReader().sevenZipCommands) {
                try {
                    await execFile(command, ['a', '-t7z', '-y', '-bd', file, '.'], {cwd:input, windowsHide:true});
                    return;
                } catch (error) {if (error.code !== 'ENOENT') throw error;}
            }
            throw new Error('7-Zip is required for server audit regression tests');
        } finally {await fs.remove(input);}
    } else {
        const zip = new (require('yazl').ZipFile)();
        const complete = pipeline(zip.outputStream, fs.createWriteStream(file));
        for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
        zip.end(); await complete;
    }
}

async function testGroupedVoteAndIsbnFiltersScanSelectionOnce() {
    const searcher = Object.create(DbSearcher.prototype);
    const selectedIds = Uint32Array.from({length:200000}, (_, i) => i + 1);
    let scanned;
    // Count actual selection traversal instead of using a machine-dependent time limit.
    selectedIds[Symbol.iterator] = function*() {
        for (let i = 0; i < this.length; i++) {
            assert(++scanned <= this.length, 'Expanding more groups must not rescan the full selection');
            yield this[i];
        }
    };
    const selection = {ids:selectedIds,deletedIds:new Set(),signature:'fixture'};
    searcher.ratingIndex = searcher.isbnIndex = {select:async() => selection};
    const books = [
        {id:1,title:'Same book',author:'Author',sourceId:'own'},
        {id:2,title:'Same book',author:'Author',sourceId:'own'},
        {id:3,title:'Other source',author:'Author',sourceId:'other'},
        {id:200001,title:'Outside selection',author:'Author',sourceId:'own'},
    ];
    const rows = Array.from({length:200}, (_, id) => ({id,books}));
    for (const filter of [{ratingCount:'1..'}, {isbn:'0306406152'}]) {
        for (const narrowing of [{}, {sourceId:'own',hideCopies:true}]) {
            const query = await searcher.prepareRatingQuery({...filter,...narrowing});
            scanned = 0;
            const result = searcher.filterRestoredRows(rows,query);
            assert.strictEqual(scanned,selectedIds.length);
            assert.strictEqual(result.length,rows.length);
            for (const row of result) assert.deepStrictEqual(row.books.map(book => book.id), narrowing.hideCopies ? [1] : [1,2,3]);
            assert.strictEqual(books.length,4,'Filtering must not overwrite the shared group cache');
        }
    }
}

async function testForegroundImagesBypassWaitingBackgroundDecoders() {
    for (const background of [1,2]) await checkForegroundImageAdmission(background);
}

async function checkForegroundImageAdmission(background) {
    const resources = new ResourceRuntime({hardMax:4,taskTimeoutMs:10000,limits:{total:4,images:2,background}});
    const images = new ImageRuntime(2,resources);
    let release, foregroundStarted = false, secondStarted = false;
    const gate = new Promise(resolve => {release = resolve;});
    const first = resources.withBackground(() => images.run(() => resources.run(() => gate,{kind:'images'})));
    const second = resources.withBackground(() => images.run(() => resources.run(() => {secondStarted = true;},{kind:'images'})));
    const foreground = images.run(() => resources.run(() => {foregroundStarted = true;},{kind:'images'}));
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert(foregroundStarted,'A waiting background decoder must leave an image slot for the foreground request');
        assert(!secondStarted,'Background image work must respect the shared background limit');
        assert.strictEqual(resources.active,1);
    } finally {release(); await Promise.allSettled([first,second,foreground]);}
    assert(secondStarted,'Queued background images must resume');
    assert.strictEqual(images.active,0); assert.strictEqual(images.queue.length,0);
    assert.strictEqual(resources.active,0); assert.strictEqual(resources.queue.length,0);
}

async function testSingleImageSlotPrioritizesReadersWithoutStarvingBackground() {
    const resources = new ResourceRuntime({hardMax:2,taskTimeoutMs:10000,limits:{total:2,images:1,background:1}});
    const images = new ImageRuntime(1,resources), order = [];
    let release;
    const first = resources.withBackground(() => images.run(() => new Promise(resolve => {release = resolve;})));
    const background = resources.withBackground(() => images.run(() => {order.push('background');}));
    const foreground = Array.from({length:10}, (_, i) => images.run(() => {order.push(i);}));
    release(); await Promise.all([first,background,...foreground]);
    assert.deepStrictEqual(order,[0,1,2,3,4,5,6,7,'background',8,9]);
    assert.strictEqual(images.active,0);
}

async function testAuthorFollowsUseIndividualAuthorsAndPreserveNewBookSnapshots() {
    await temporary(async dir => {
        const config = {dataDir:dir,libDir:dir,inpxFile:path.join(dir,'fixture.inpx'),inpxFilterFile:path.join(dir,'none'),
            dbVersion:14,dbCacheSize:5,adminPassword:'fixture-only',queryCacheEnabled:true,queryCacheMemSize:10,queryCacheDiskSize:0};
        const records = [
            ['Author:Coauthor:','Joint','Saga','joint',0], ['Author:','Solo','Saga','solo',0],
            ['Author:Coauthor:','Deleted','Saga','deleted',1], ['Author Two:','Other','Saga Two','other',0],
            ['Someone:','Same series','Saga','series-only',0],
        ];
        await archive(config.inpxFile,{'collection.info':'Follow regression',
            'structure.info':'AUTHOR;TITLE;SERIES;FILE;DEL;EXT;GENRE;LANG',
            'books.inp':records.map(row => [...row,'fb2','sf','ru'].join('\x04')).join('\n')});
        const db = new (require('jembadb').JembaDb)();
        await db.lock({dbPath:path.join(dir,'db'),create:true});
        let searcher;
        try {
            await new (require('../server/core/DbCreator'))(config).run(db,() => {}); await db.openAll();
            searcher = new DbSearcher(config,db); await searcher.init();
            const store = new (require('../server/core/ReadingListStore'))(config);
            const owner = await store.createUser({name:'Owner'}), other = await store.createUser({name:'Other'});
            const worker = {config,db,dbSearcher:searcher,readingListStore:store,libraryAssetGeneration:1};
            const follows = new (require('../server/core/LibraryFollows'))(worker);
            const authors = await follows.matches('author','Author');
            assert.deepStrictEqual(authors.map(book => book.title).sort(),['Joint','Solo']);
            assert.deepStrictEqual((await follows.matches('series','Saga')).map(book => book.title).sort(),['Joint','Same series','Solo']);
            const initial = await follows.change(owner.id,'add',{kind:'author',value:'Author'});
            assert.deepStrictEqual((await follows.list(owner.id,true)).books,[],'Existing coauthored books belong to the initial snapshot');
            await follows.change(owner.id,'remove',{id:initial.follows[0].id});
            // A persisted snapshot from before Joint was added to the collection.
            await store.changeLibraryFollow(owner.id,'add',{kind:'author',value:'Author',knownUids:[authors.find(book => book.title === 'Solo')._uid]});
            const refreshed = await follows.list(owner.id,true);
            assert.deepStrictEqual(refreshed.books.map(book => book.title),['Joint']);
            assert.strictEqual(refreshed.follows[0].unread,1);
            assert.deepStrictEqual((await follows.list(other.id,true)).books,[]);
            await follows.change(owner.id,'seen',{id:refreshed.follows[0].id});
            assert.deepStrictEqual((await follows.list(owner.id,true)).books,[]);
        } finally {if (searcher) await searcher.close(); await db.unlock();}
    });
}

const container = '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>';
const packageXml = '<package><metadata/><manifest/><spine/></package>';

async function runAudit(dir, cases) {
    const tempDir = path.join(dir,'tmp'); await fs.ensureDir(tempDir);
    for (const [file, entries, sevenZip] of cases) await archive(path.join(dir,file+'.epub'),entries,sevenZip);
    const before = await Promise.all(cases.map(([file]) => fs.readFile(path.join(dir,file+'.epub'))));
    const db = new (require('jembadb').JembaDb)();
    await db.lock({dbPath:path.join(dir,'db'),create:true});
    try {
        await db.create({table:'book'});
        await db.insert({table:'book',rows:cases.map(([file],i) => ({id:i+1,_uid:file,title:file,folder:'.',file,ext:'epub'}))});
        const worker = {db,config:{libDir:dir,tempDir,auditMaxBookBytes:8*1024*1024},libraryAssetGeneration:1,resolveLibraryArchivePath:async folder => folder};
        const audit = new (require('../server/core/LibraryAudit'))(worker);
        audit.start({deep:true}); await audit.pending;
        const result = audit.describe();
        assert.strictEqual(result.error,undefined); assert.strictEqual(result.checked,cases.length);
        for (const [i,[file]] of cases.entries()) assert((await fs.readFile(path.join(dir,file+'.epub'))).equals(before[i]),'Audit must preserve the source');
        assert.deepStrictEqual(await fs.readdir(tempDir),[]);
        return result;
    } finally {await db.unlock();}
}

async function testDeepAuditAcceptsZipAndRepackedEpubButRejectsBrokenPackages() {
    await temporary(async dir => {
        const valid = {'META-INF/container.xml':container,'OPS/book.opf':packageXml};
        const result = await runAudit(dir,[['zip',valid,false],['repacked',valid,true],
            ['missing-package',{'META-INF/container.xml':container},true],
            ['invalid-package',{'META-INF/container.xml':container,'OPS/book.opf':'<package><metadata>'},true]]);
        assert.strictEqual(result.damaged,2); assert.strictEqual(result.missing,0); assert.strictEqual(result.skipped,0);
        assert.deepStrictEqual(result.issues.map(issue => issue.bookUid),['missing-package','invalid-package']);
    });
}

async function testRepackedEpubAuditChecksMetadataSizesBeforeExtraction() {
    await temporary(async dir => {
        const oversizedContainer = container + ' '.repeat(1024*1024);
        const oversizedPackage = packageXml + ' '.repeat(4*1024*1024);
        const original = ZipReader.prototype.extractToBuf;
        let oversizedExtractions = 0;
        ZipReader.prototype.extractToBuf = async function(name) {
            const entry = Object.values(this.entries).find(item => item.name === name);
            if (entry && Number(entry.size) > (name === 'META-INF/container.xml' ? 1024*1024 : 4*1024*1024)) oversizedExtractions++;
            return original.call(this,name);
        };
        try {
            const result = await runAudit(dir,[
                ['large-container-zip',{'META-INF/container.xml':oversizedContainer},false],
                ['large-container-7z',{'META-INF/container.xml':oversizedContainer},true],
                ['large-package-zip',{'META-INF/container.xml':container,'OPS/book.opf':oversizedPackage},false],
                ['large-package-7z',{'META-INF/container.xml':container,'OPS/book.opf':oversizedPackage},true],
            ]);
            assert.strictEqual(result.skipped,4); assert.strictEqual(result.damaged,0);
            assert.strictEqual(oversizedExtractions,0,'Declared metadata limits must be checked before allocating extracted data');
        } finally {ZipReader.prototype.extractToBuf = original;}
    });
}

module.exports = [testGroupedVoteAndIsbnFiltersScanSelectionOnce,testForegroundImagesBypassWaitingBackgroundDecoders,
    testSingleImageSlotPrioritizesReadersWithoutStarvingBackground,testAuthorFollowsUseIndividualAuthorsAndPreserveNewBookSnapshots,
    testDeepAuditAcceptsZipAndRepackedEpubButRejectsBrokenPackages,testRepackedEpubAuditChecksMetadataSizesBeforeExtraction];
