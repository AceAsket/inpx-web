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
function inpxLine(rating) {
    return ['Иванов,Иван,:','sf:','Та же книга','',0,'123',1000,'123',0,'fb2','2026-11-01','ru',rating,''].join('\x04')+'\x04';
}

async function writeInpx(file, entries) {
    const zip = new (require('yazl').ZipFile)();
    for (const [name, rows] of Object.entries(entries))
        zip.addBuffer(Buffer.from(rows.join('\n')+'\n'), name);
    const saved = new Promise((resolve,reject) => {
        const stream = fs.createWriteStream(file); zip.outputStream.pipe(stream);
        stream.on('close',resolve); stream.on('error',reject);
    });
    zip.end(); await saved;
}

async function inpx(file,rating) {
    const line = inpxLine(rating);
    await writeInpx(file, {'library.inp': [line]});
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
                const user = {id:'reader', readerPreferences:{},readerProgress:{[legacyUid]:{percent:.5}},readerBookmarks:{[legacyUid]:[{id:'note'}]}};
                store.loadSnapshot = async() => ({users:[user]});
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

async function testInpxLibraryMovePreservesUidsForRepeatedRecordsAcrossArchives() {
    await temporary(async dir => {
        const original = path.join(dir, 'library'), moved = path.join(dir, '_Lib.rus.ec - Официальная');
        const index = path.join(dir, 'db'), staging = path.join(dir, 'staging');
        const collection = 'collection.inpx';
        await fs.ensureDir(original);
        await writeInpx(path.join(original, collection), {
            'first.inp': [inpxLine(1), inpxLine(2)],
            'second.inp': [inpxLine(3), inpxLine(1)],
        });
        const config = {dataDir: dir, inpxFilterFile: path.join(dir, 'none'), dbVersion: 15, fullOptimization: false};
        const build = async (dbPath, libDir) => {
            const db = new JembaDb();
            await db.lock({dbPath, create: true});
            try {
                await new DbCreator({...config, indexDbPath: dbPath, libDir, inpxFile: path.join(libDir, collection)}).run(db, () => {});
                await db.open({table: 'book'});
                return await db.select({table: 'book'});
            } finally {await db.unlock();}
        };
        const before = await build(index, original);
        assert.equal(before.length, 4);
        await fs.rename(original, moved);
        await fs.copy(path.join(index, 'book'), path.join(staging, 'book'));
        const after = await build(staging, moved);
        assert.deepEqual(after.map(row => [row.id, row._uid, row.folder, row.librate]),
            before.map(row => [row.id, row._uid, row.folder, row.librate]));
        assert(after.every(row => row.sourceLibDir === moved));
    });
}

async function testIndexStatisticsStopsReportingProgressWhenUniqueIndexFails() {
    const progress = [];
    const db = {
        select: async() => [{rawResult: {filesCount: 0, filesDelCount: 0}}],
        create: async() => {throw new Error('unique index failed');},
    };
    await assert.rejects(new DbCreator({}).countStats(db, state => progress.push(state.progress), {}), /unique index failed/);
    const countAfterFailure = progress.length;
    await wait(1100);
    assert.equal(progress.length, countAfterFailure, 'A failed index build must stop sending progress updates');
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
        searcher.recStruct = ['title','author','series','genre','lang','ext','date','keywords'].map(field=>({field,type:'S'}));
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
            await db.insert({table:'book',rows:[{id:102,_uid:'at',title:'@Новая книга',author:'Author',series:'',serno:0,
                folder:'books.zip',file:'at',ext:'fb2',keywords:'Древние приключения'}]});
            await db.insert({table:'title',rows:[{id:102,value:'@новая книга',name:'@Новая книга',bookIds:[102]}]});
            assert.deepEqual(Array.from(await searcher.bookSearchIds({keywords:'@ приключений'})),[102]);
            assert.deepEqual(Array.from(await searcher.bookSearchIds({title:'~^@'})),[102]);
        } finally {await searcher.close();}
    });
}

async function testWideBookSearchReadsTableOrderAndKeepsStableDedupeOrder() {
    await database(async db => {
        await db.create({table:'book',type:'memory'});
        await db.create({table:'genre',type:'memory'});
        const ids = Array.from({length: 8200}, (_, i) => 8200 - i);
        const book = (id, overrides={}) => ({id,title:'Book',author:'Author',series:'',serno:0,
            genre:'sf',sourceId:'source',folder:'books.zip',file:String(id),ext:'fb2',...overrides});
        const rows = ids.slice().reverse().map(id => book(id));
        rows[0] = book(1,{file:'duplicate',librate:5});
        rows[8199] = book(8200,{file:'duplicate',librate:1});
        rows[8189] = book(8190,{genre:'mystery'});
        await db.insert({table:'book',rows});
        const searcher = new DbSearcher({queryCacheEnabled:false},db);
        searcher.recStruct = [{field:'genre',type:'S'}];
        searcher.selectBookIds = async() => Uint32Array.from(ids);
        const table = db.table.get('book');
        const getRow = table.rowsInterface.getRow.bind(table.rowsInterface);
        const reads = [];
        table.rowsInterface.getRow = id => {reads.push(id);return getRow(id);};
        try {
            const result = Array.from(await searcher.bookSearchIds({genre:'sf'}));
            assert.deepEqual(reads, ids.slice().reverse());
            assert.deepEqual(result, [1, ...ids.slice(1,-1).filter(id=>id!==8190)]);

            const firstPage = await searcher.bookSearch({genre:'sf', limit:20});
            assert.equal(firstPage.totalFound, result.length);
            assert.deepEqual(firstPage.found.map(row => row.id), result.slice(0, 20));
        } finally {await searcher.close();}
    });
}

async function testBookSearchEarlyPagesKeepExactCountsAndReuseCaches() {
    await database(async db => {
        for (const table of ['book', 'query_cache', 'query_time']) await db.create({table});
        const book = (id, overrides = {}) => ({id, title:`Z ${String(id).padStart(3, '0')}`,
            author:'Author', series:'', serno:0, genre:'sf', sourceId:'main', folder:'books.zip',
            file:String(id), ext:'fb2', ...overrides});
        const rows = [
            book(1, {title:'A', file:'physical-copy', librate:1}),
            book(2, {title:'B', file:'physical-copy', librate:5}),
            book(3, {title:'A', sourceId:'second', ext:'epub'}),
            book(4, {title:'B', sourceId:'second', ext:'epub', librate:6}),
            book(5, {title:'É', librate:1}),
            book(6, {title:'E\u0301'}),
            book(7, {title:'É', sourceId:'second', librate:5}),
            ...Array.from({length:321}, (_, i) => book(i + 8)),
        ];
        await db.insert({table:'book', rows});
        const config = {queryCacheEnabled:true, queryCacheMemSize:32, queryCacheDiskSize:32, cacheCleanInterval:0};
        let scans = 0;
        const createSearcher = () => {
            const searcher = new DbSearcher(config, db);
            searcher.recStruct = [{field:'genre', type:'S'}];
            const scan = searcher.scanBookSearch.bind(searcher);
            searcher.scanBookSearch = (...args) => {scans++; return scan(...args);};
            return searcher;
        };
        const query = {genre:'sf', hideCopies:true, limit:2};
        const expected = [3, 4, 7, 6, ...rows.slice(7).map(row => row.id)];
        let searcher = createSearcher();
        const checkPage = async offset => {
            const result = await searcher.bookSearch({...query, offset});
            assert.equal(result.totalFound, expected.length);
            assert.deepEqual(result.found.map(row => row.id), expected.slice(offset, offset + query.limit));
        };
        try {
            await checkPage(0);
            await checkPage(2);
            assert.equal(scans, 1);
            await searcher.close();
            searcher = createSearcher();
            await checkPage(254);
            assert.equal(scans, 1, 'The early page survives a restart through the disk cache');
            await checkPage(255);
            await checkPage(expected.length - 1);
            assert.equal(scans, 2, 'Later pages reuse the full result');
            assert.deepEqual(Array.from(await searcher.bookSearchIds(query)), expected);

            const withoutFilter = await searcher.bookSearch({hideCopies:true, limit:2});
            assert.deepEqual(withoutFilter.found.map(row => row.id), [1, 4]);
            assert.equal(withoutFilter.totalFound, expected.length);

            const base = await searcher.bookSearchIds({...query, hideCopies:false});
            assert.deepEqual(Array.from(base.slice(0, 3)), [3, 2, 4]);
            await searcher.close();
            searcher = new DbSearcher({...config, queryCacheDiskSize:0}, db);
            searcher.recStruct = [{field:'genre', type:'S'}];
            await searcher.bookSearchIds({...query, hideCopies:false});
            await checkPage(0);

            await db.insert({table:'book', rows:[
                book(400, {genre:'untitled', title:'  ', file:'common'}),
                book(401, {genre:'untitled', title:'', file:'COMMON', sourceId:'second', librate:6}),
                book(402, {genre:'untitled', title:'', sourceId:'second'}),
            ]});
            const untitled = await searcher.bookSearch({genre:'untitled', hideCopies:true, limit:2});
            assert.equal(untitled.totalFound, 2);
            assert.deepEqual(untitled.found.map(row => row.id), [401, 402]);
        } finally {await searcher.close();}
    });
}

async function testBookSearchSharesColdRankingAcrossPagesAndFullResults() {
    await database(async db => {
        await db.create({table:'book', type:'memory'});
        const rows = Array.from({length:320}, (_, i) => ({id:i + 1, title:`Book ${i}`, author:'Author',
            series:'', serno:0, genre:'sf', del:0, sourceId:i ? 'main' : '', folder:'books.zip', file:String(i), ext:'fb2'}));
        await db.insert({table:'book', rows});
        const searcher = new DbSearcher({queryCacheEnabled:false}, db);
        searcher.recStruct = [{field:'genre', type:'S'}, {field:'del', type:'N'}];
        const query = {genre:'sf', del:'0', hideCopies:true};
        const baseline = await searcher.bookSearchIds(query);
        const scan = searcher.scanBookSearch.bind(searcher);
        const started = Promise.withResolvers(), release = Promise.withResolvers();
        const limits = [];
        searcher.scanBookSearch = async (query, limit) => {
            limits.push(limit);
            if (limit === 0) {
                started.resolve();
                await release.promise;
            }
            return scan(query, limit);
        };
        const first = searcher.bookSearch({...query, limit:2});
        const opds = searcher.bookSearchIds({...query, hideCopies:'1'});
        try {
            await started.promise;
            const second = searcher.bookSearch({...query, offset:2, limit:3});
            const unrelated = searcher.bookSearch({...query, sourceId:' ', limit:1});
            assert.deepEqual((await unrelated).found.map(book => book.id), [1]);
            release.resolve();
            const [firstPage, secondPage, ids] = await Promise.all([first, second, opds]);
            assert.deepEqual(ids, baseline);
            assert.deepEqual(firstPage.found.map(book => book.id), Array.from(baseline.slice(0, 2)));
            assert.deepEqual(secondPage.found.map(book => book.id), Array.from(baseline.slice(2, 5)));
            assert.equal(firstPage.totalFound, baseline.length);
            assert.equal(secondPage.totalFound, baseline.length);
            assert.equal(limits.filter(limit => limit === 0).length, 1);
            assert.equal(limits.length, 2, 'Only the other source starts an independent scan');

            const repeat = await searcher.bookSearch({...query, limit:2});
            assert.deepEqual(repeat, firstPage);
            assert.equal(limits.length, 3, 'With query caching disabled, the completed scan is released');
        } finally {
            release.resolve();
            await Promise.allSettled([first, opds]);
            await searcher.close();
        }
    });
}

async function testBookSearchSharesFailureRetriesAndDrainsBeforeClose() {
    const db = {esc:JSON.stringify, select:async () => [{id:2}]};
    const searcher = new DbSearcher({queryCacheEnabled:false}, db);
    searcher.recStruct = [];
    let scans = 0;
    const failure = new Error('Database scan failed');
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const fullStarted = Promise.withResolvers(), releaseFull = Promise.withResolvers();
    searcher.scanBookSearch = async (query, limit) => {
        if (++scans === 1) throw failure;
        if (limit) {
            started.resolve();
            await release.promise;
        } else {
            fullStarted.resolve();
            await releaseFull.promise;
        }
        return {ids:Uint32Array.of(2, 1), totalFound:2};
    };

    try {
        const requests = await Promise.allSettled([searcher.bookSearchIds({}), searcher.bookSearch({limit:2})]);
        assert.deepEqual(requests, [
            {status:'rejected', reason:failure},
            {status:'rejected', reason:failure},
        ]);
        assert.equal(scans, 1);

        const retried = searcher.bookSearch({limit:1});
        await started.promise;
        const ids = searcher.bookSearchIds({});
        await fullStarted.promise;
        let closed = false;
        const closing = searcher.close().then(() => {closed = true;});
        await assert.rejects(searcher.bookSearchIds({}), /DbSearcher closed/);
        release.resolve();
        assert.deepEqual(await retried, {found:[{id:2}], totalFound:2});
        assert.equal(searcher.searchFlag, 1);
        assert.equal(closed, false);
        releaseFull.resolve();
        assert.deepEqual(await ids, Uint32Array.of(2, 1));
        await closing;
        assert.equal(scans, 3, 'A wider request does not change an already-running first-page scan');
        assert.equal(searcher.bookSearches.size, 0);
    } finally {
        release.resolve();
        releaseFull.resolve();
        await searcher.close();
    }
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
    testInpxLibraryMovePreservesUidsForRepeatedRecordsAcrossArchives,
    testIndexStatisticsStopsReportingProgressWhenUniqueIndexFails,
    testRc13PriorIdentitiesStreamCompactBatchesAndReleaseCursor,
    testRc13SelectiveBookSearchUsesIndexesAndPreservesRegex,
    testWideBookSearchReadsTableOrderAndKeepsStableDedupeOrder,
    testBookSearchEarlyPagesKeepExactCountsAndReuseCaches,
    testBookSearchSharesColdRankingAcrossPagesAndFullResults,
    testBookSearchSharesFailureRetriesAndDrainsBeforeClose,
    testRc13DiskQueryCacheEnforcesCountAndBytesOnEveryWriteAndRestart,
    testRc13RatingIndexUsesLeaseBoundsAndIdleCleanup,
    testRc13IsbnIndexReleasesIdleAndOversizedStateWithoutBreakingReaders];
