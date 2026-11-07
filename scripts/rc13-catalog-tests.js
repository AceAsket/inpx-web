const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {JembaDb} = require('jembadb');
const DbCreator = require('../server/core/DbCreator');
const DbSearcher = require('../server/core/DbSearcher');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));

async function temporary(work) {
    const base = path.resolve(__dirname,'../tmp'); await fs.ensureDir(base);
    const dir = await fs.mkdtemp(path.join(base,'rc13-catalog-'));
    try {return await work(dir);} finally {await fs.remove(dir);}
}
async function database(work) {
    return temporary(async dir => {
        const db = new JembaDb(); await db.lock({dbPath:path.join(dir,'db'),create:true});
        try {return await work(db,dir);} finally {await db.unlock();}
    });
}
async function inpx(file,rating) {
    const zip = new (require('yazl').ZipFile)();
    const line = ['Иванов,Иван,:','sf:','Та же книга','',0,'123',1000,'123',0,'fb2','2026-11-01','ru',rating,''].join('\x04')+'\x04';
    zip.addBuffer(Buffer.from(line+'\n'),'library.inp');
    const saved = new Promise((resolve,reject) => {
        const stream = fs.createWriteStream(file); zip.outputStream.pipe(stream);
        stream.on('close',resolve); stream.on('error',reject);
    });
    zip.end(); await saved;
    return line;
}

async function testRc13InpxUidSurvivesMetadataAndForcedRebuildFromLegacy14() {
    await temporary(async dir => {
        const file = path.join(dir,'library.inpx'), oldPath = path.join(dir,'old');
        const line = await inpx(file,1), legacyUid = crypto.createHash('sha256').update(line).digest('base64');
        const parsed = [];
        await new (require('../server/core/InpxParser'))().parse(file,()=>{},rows => parsed.push(...rows));
        const config = {dataDir:dir,libDir:dir,inpxFilterFile:path.join(dir,'none'),dbVersion:15,fullOptimization:false,
            librarySources:[{id:'own',name:'Own',type:'inpx',inpxFile:file,libDir:dir,enabled:true}]};
        const old = new JembaDb();
        await old.lock({dbPath:oldPath,create:true}); await old.create({table:'book'});
        await old.insert({table:'book',rows:[{...parsed[0],id:37,_uid:legacyUid,_recordHash:'legacy14',sourceId:'own',sourceName:'Own',sourceLibDir:dir}]});
        await old.create({table:'config'}); await old.insert({table:'config',rows:[{id:'dbVersion',value:14}]});
        await old.unlock();
        await inpx(file,5);
        for (const incremental of [true,false]) {
            const target = path.join(dir,incremental ? 'incremental' : 'forced');
            if (incremental) await fs.copy(path.join(oldPath,'book'),path.join(target,'book'));
            const db = new JembaDb(); await db.lock({dbPath:target,create:true});
            try {
                await new DbCreator({...config,indexDbPath:target,identityDbPath:oldPath}).run(db,()=>{});
                await db.open({table:'book'});
                const rows = await db.select({table:'book'});
                assert.equal(rows.length,1); assert.equal(rows[0]._uid,legacyUid); assert.equal(rows[0].id,37);
                assert.equal(rows[0].librate,5);
                assert.equal(await db.tableExists({table:'source'}),true);
                const Store = require('../server/core/ReadingListStore'), store = new Store(config);
                const user = {readerPreferences:{},readerProgress:{[legacyUid]:{percent:.5}},readerBookmarks:{[legacyUid]:[{id:'note'}]}};
                store.resolveUser = async() => ({user});
                store.getUser = async() => user;
                const state = await store.getReaderState('reader',rows[0]._uid);
                assert.equal(state.progress.percent,.5); assert.equal(state.bookmarks.length,1);
            } finally {await db.unlock();}
        }
        const db = new JembaDb(), target = path.join(dir,'fresh'); await db.lock({dbPath:target,create:true});
        try {
            await new DbCreator({...config,indexDbPath:target}).run(db,()=>{}); await db.open({table:'book'});
            const [row] = await db.select({table:'book'});
            assert.notEqual(row._uid,legacyUid,'New records use physical identity');
            assert.equal(row._uid,new DbCreator(config).physicalIdentity({...row,librate:1,title:'Different metadata'}));
        } finally {await db.unlock();}
        await assert.rejects(async() => {
            const broken = new JembaDb(), target = path.join(dir,'broken'); await broken.lock({dbPath:target,create:true});
            try {await new DbCreator({...config,indexDbPath:target,identityDbPath:path.join(dir,'missing-old')}).run(broken,()=>{});}
            finally {await broken.unlock();}
        },/Не удалось сохранить идентификаторы/);
    });
}

async function seedSearch(db) {
    const rows = Array.from({length:100},(_,i) => ({id:i+1,_uid:String(i),title:i ? `Ordinary ${i}` : 'Rare book',
        author:'Author',series:'',serno:0,folder:'books.zip',file:String(i),ext:i ? 'fb2':'epub',lang:i ? 'ru':'en',
        sourceId:i ? 'own':'other',genre:i ? 'sf':'poetry',date:i ? '2020-01-01':'2026-11-01',librate:i ? 1:5,del:i ? 0:1}));
    await db.create({table:'book'}); await db.insert({table:'book',rows});
    for (const field of ['title','author','series','genre','lang','ext','date','librate','del','source']) {
        const groups = new Map();
        for (const row of rows) {
            let value = field === 'source' ? row.sourceId : row[field];
            if (typeof value === 'string') value = value.toLowerCase() || '?';
            if (!groups.has(value)) groups.set(value,[]); groups.get(value).push(row.id);
        }
        await db.create({table:field,index:{field:'value',unique:true,type:['librate','del'].includes(field) ? 'number':'string'}});
        await db.insert({table:field,rows:Array.from(groups,([value,bookIds],i)=>({id:i+1,value,name:String(value),bookIds}))});
    }
    const words = new Map(), search = require('../shared/CatalogSearch');
    for (const row of rows) for (const field of ['title','author','series']) for (const word of new Set(search.words(row[field]).map(search.root))) {
        const key = `${field}:${word}`; if (!words.has(key)) words.set(key,[]); words.get(key).push(row.id);
    }
    await db.create({table:'word',index:{field:'value',unique:true,type:'string'}});
    await db.insert({table:'word',rows:Array.from(words,([value,bookIds],i)=>({id:i+1,value,bookIds}))});
    return rows;
}

async function testRc13InpxPhysicalIdentitySeparatesSourcesAndAmbiguousFiles() {
    await temporary(async dir => {
        const file = path.join(dir,'library.inpx'); await inpx(file,1);
        const source = {id:'one',name:'One',type:'inpx',inpxFile:file,libDir:dir,enabled:true};
        const config = {dataDir:dir,libDir:dir,inpxFilterFile:path.join(dir,'none'),dbVersion:15,fullOptimization:false,
            librarySources:[source,{...source,id:'two',name:'Two'}]};
        const target = path.join(dir,'separate'), db = new JembaDb(); await db.lock({dbPath:target,create:true});
        try {
            await new DbCreator({...config,indexDbPath:target}).run(db,()=>{}); await db.open({table:'book'});
            const rows = await db.select({table:'book'});
            assert.equal(rows.length,2); assert.equal(new Set(rows.map(row=>row._uid)).size,2);
        } finally {await db.unlock();}
        const oldPath = path.join(dir,'ambiguous-old'), old = new JembaDb();
        await old.lock({dbPath:oldPath,create:true}); await old.create({table:'book'});
        await old.insert({table:'book',rows:[{id:1,_uid:'legacy-one',sourceId:'one',folder:'library.zip',file:'123',ext:'fb2'},
            {id:2,_uid:'legacy-two',sourceId:'one',folder:'library.zip',file:'123',ext:'fb2'}]}); await old.unlock();
        const fresh = new JembaDb(), path2 = path.join(dir,'ambiguous-new'); await fresh.lock({dbPath:path2,create:true});
        try {
            await new DbCreator({...config,librarySources:[source],indexDbPath:path2,identityDbPath:oldPath}).run(fresh,()=>{});
            await fresh.open({table:'book'}); const [row] = await fresh.select({table:'book'});
            assert(!['legacy-one','legacy-two'].includes(row._uid),'An ambiguous file must not inherit an arbitrary book identity');
        } finally {await fresh.unlock();}
    });
}

async function testRc13PriorIdentitiesStreamCompactBatchesAndReleaseCursor() {
    await database(async db => {
        const count = 2003, creator = new DbCreator({});
        const rows = Array.from({length:count},(_,i) => ({id:i*3+1,_uid:'uid-'+i,_legacyUid:'legacy-'+i,
            _recordHash:'hash-'+i,sourceId:'own',folder:'nested/'+('folder-'.repeat(40))+i+'.zip',
            file:String(i),ext:'fb2',insno:0,annotation:'Unrelated payload '.repeat(100)}));
        await db.create({table:'book'}); await db.insert({table:'book',rows});
        await db.close({table:'book'}); await db.open({table:'book',cacheSize:5});
        const table = db.table.get('book'), original = table.rowsInterface.getRow.bind(table.rowsInterface);
        let reads = 0, consumed = 0, batches = 0;
        table.rowsInterface.getRow = id => {reads++; return original(id);};
        await creator.previousIdentities(db,async chunk => {
            assert(chunk.length <= 1000); batches++;
            assert.equal(reads,consumed+chunk.length,'Deliver each bounded batch before reading the next');
            for (const row of chunk) {
                assert.deepEqual(Object.keys(row).sort(),['hash','id','identity','legacyUid','sourceId','uid']);
                const source = rows[consumed++];
                assert.equal(row.uid,source._uid); assert.equal(row.id,source.id);
                assert.equal(row.identity,creator.physicalIdentity(source));
            }
            await wait(1);
        });
        assert.equal(consumed,count); assert.equal(batches,3); assert.equal(reads,count);
        assert.equal(table.reducer._items.size,0,'The successful cursor is released');
        await assert.rejects(creator.previousIdentities(db,() => {throw new Error('Consumer stopped');}),/Consumer stopped/);
        assert.equal(table.reducer._items.size,0,'The interrupted cursor is also released');
    });
}

async function testRc13SelectiveBookSearchUsesIndexesAndPreservesRegex() {
    await database(async db => {
        await seedSearch(db);
        const searcher = new DbSearcher({queryCacheEnabled:false},db);
        searcher.recStruct = ['title','author','series','genre','lang','ext','date'].map(field=>({field,type:'S'}));
        searcher.recStruct.push({field:'librate',type:'N'},{field:'del',type:'N'});
        const rows = db.table.get('book').rowsInterface, getRow = rows.getRow.bind(rows); let reads = 0;
        rows.getRow = id => {reads++; return getRow(id);};
        try {
            for (const query of [{title:'=Rare book'},{title:'rare'},{lang:'en'},{ext:'epub'},{sourceId:'other'},
                {genre:'poetry'},{date:'2026-01-01'},{librate:'5'},{del:'1'},{lang:'e'},{ext:'ep'},{lang:'en,fr'},{ext:'epub,pdf'},
                {lang:'=en'},{ext:'=epub'}]) {
                reads = 0; assert.deepEqual(Array.from(await searcher.bookSearchIds(query)),[1],JSON.stringify(query));
                assert.equal(reads,1,JSON.stringify(query)+' must read only indexed candidates');
            }
            await db.insert({table:'book',rows:[{id:101,_uid:'digits',title:'123',author:'Author',series:'',serno:0,folder:'books.zip',file:'digits',ext:'fb2'}]});
            await db.insert({table:'title',rows:[{id:101,value:'123',name:'123',bookIds:[101]}]});
            assert.deepEqual(Array.from(await searcher.bookSearchIds({title:'~^\\D+$'})),[1]);
            assert.equal((await searcher.bookSearchIds({title:'~\\S'})).length,101);
        } finally {await searcher.close();}
    });
}

async function testRc13DiskQueryCacheEnforcesCountAndBytesOnEveryWriteAndRestart() {
    await database(async db => {
        for (const table of ['query_cache','query_time']) await db.create({table});
        const config = {queryCacheEnabled:true,queryCacheMemSize:0,queryCacheDiskSize:3,queryCacheDiskMb:.001,cacheCleanInterval:0};
        let searcher = new DbSearcher(config,db);
        try {
            await Promise.all(Array.from({length:20},(_,i)=>searcher.putCached('query-'+i,new Uint32Array(40))));
            assert((await db.select({table:'query_cache',count:true}))[0].count <= 3);
            assert(searcher.diskCacheBytes <= config.queryCacheDiskMb * 1024 ** 2);
            const present = await db.select({table:'query_cache'});
            const newest = present[present.length-1].id;
            assert((await searcher.getCached(newest)) instanceof Uint32Array);
            await searcher.putCached('oversized',new Uint32Array(10000));
            assert.equal(await searcher.getCached('oversized'),null);
            await searcher.close(); searcher = new DbSearcher({...config,queryCacheDiskSize:1},db);
            assert((await searcher.getCached(newest)) instanceof Uint32Array);
            assert.equal((await db.select({table:'query_cache',count:true}))[0].count,1);
            await db.insert({table:'query_cache',rows:[{id:'old-unsized',value:[1,2,3]}]});
            await searcher.close(); searcher = new DbSearcher(config,db);
            assert.equal(await searcher.getCached('old-unsized'),null);
        } finally {await searcher.close();}
    });
}

async function testRc13RatingIndexUsesLeaseBoundsAndIdleCleanup() {
    require('../server/core/Logger');
    const logger = new (require('../server/core/AppLogger'))();
    if (!logger.inited) await logger.init({loggingEnabled:false,name:'rc13-catalog-tests'});
    const WebWorker = require('../server/core/WebWorker'), Index = require('../server/core/LibraryRatingIndex');
    await database(async db => {
        await seedSearch(db);
        const worker = Object.create(WebWorker.prototype), state = {signature:'one',archives:[]};
        Object.assign(worker,{config:{libDir:path.resolve('fixture'),librarySources:[]},db,libraryAssetGeneration:1,
            getReviewArchiveState:async()=>state});
        let builds = 0;
        worker.readLibraryRatings = async()=>{builds++;await wait(10);return new Map([['books.zip#0.epub',{count:50}]]);};
        const index = new Index(worker,{idleMs:15,cacheBytes:1024});
        try {
            const found = await Promise.all([index.select('50'),index.select('50'),index.select('50')]);
            assert(found.every(row=>row.ids.length===1)); assert.equal(builds,1);
            assert(state.idleTimer,'The count filter must install the review-asset lease cleanup');
            assert(index.cached); await wait(35); assert.equal(index.cached,null);
            // Oversized results remain usable by all in-flight consumers, but
            // no completed array is retained after their shared build.
            const tiny = new Index(worker,{idleMs:15,cacheBytes:1});
            const results = await Promise.all([tiny.select('50'),tiny.select('50')]);
            assert(results.every(row=>row.ids.length===1)); assert.equal(tiny.cached,null);
            await tiny.close();
        } finally {clearTimeout(state.idleTimer); await index.close();}
    });
}

async function testRc13IsbnIndexReleasesIdleAndOversizedStateWithoutBreakingReaders() {
    await temporary(async dir => {
        const number = '9780306406157';
        await fs.writeJson(path.join(dir,'isbn-index.json'),{version:1,signature:'obsolete',revision:'one',complete:true,
            entries:[[1,[number],true]]});
        const worker = {config:{dataDir:dir},db:{select:async()=>[]}};
        const Index = require('../server/core/LibraryIsbnIndex');
        const index = new Index(worker,{idleMs:15,cacheBytes:1024});
        await index.load(); assert.equal(index.lookup.get(number).size,1);
        await wait(35); assert.equal(index.state,null); assert.equal(index.lookup.size,0);
        const tiny = new Index(worker,{idleMs:15,cacheBytes:1});
        let held;
        await tiny.use(async()=>{await tiny.load();held=tiny.state;assert.equal(tiny.lookup.size,1);await wait(25);assert.equal(tiny.state,held);});
        assert.equal(tiny.state,null); assert.equal(tiny.lookup.size,0);
        tiny.signature = async() => 'obsolete';
        const selected = await tiny.select(number);
        assert.deepEqual(Array.from(selected.ids),[1]); assert(selected.deletedIds.has(1),'Eviction must not mutate a returned selection');
        assert.equal(tiny.state,null);
        await index.close(); await tiny.close();
    });
}

module.exports = [testRc13InpxUidSurvivesMetadataAndForcedRebuildFromLegacy14,
    testRc13InpxPhysicalIdentitySeparatesSourcesAndAmbiguousFiles,
    testRc13PriorIdentitiesStreamCompactBatchesAndReleaseCursor,
    testRc13SelectiveBookSearchUsesIndexesAndPreservesRegex,
    testRc13DiskQueryCacheEnforcesCountAndBytesOnEveryWriteAndRestart,
    testRc13RatingIndexUsesLeaseBoundsAndIdleCleanup,
    testRc13IsbnIndexReleasesIdleAndOversizedStateWithoutBreakingReaders];
