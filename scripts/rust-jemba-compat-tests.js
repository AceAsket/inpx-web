const assert = require('node:assert/strict');
const {hash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createWriteStream} = require('node:fs');
const {pipeline} = require('node:stream/promises');
const JembaDb = require('jembadb/src/JembaDb');
const RustTableBuilder = require('../server/core/RustTableBuilder');
const readBookIdentities = require('../server/core/RustIdentityReader');
const DbCreator = require('../server/core/DbCreator');
const {buildIndexInWorker} = require('../server/core/IndexBuilder');

async function checkBooks(binary, directory, db) {
    const rawLast = {_uid:'three', title:'Последняя запись', sourceId:'fixture', folder:'a\\Б.zip', file:'123', ext:'FB2', insno:-3};
    const rows = [
        {id:1, _uid:'one', title:'Ф'.repeat(350000)},
        {id:2, _uid:'two', title:'Я'.repeat(350000)},
        {...rawLast, _recordHash:hash('sha256', JSON.stringify(rawLast), 'hex'), id:3},
    ];
    const writer = await RustTableBuilder.open(binary, path.join(directory, 'book'), 'build-book');
    try {
        await writer.append([
            ...rows.slice(0, 2).map(row => JSON.stringify([row.id, row._uid, row]) + '\n'),
            JSON.stringify([3,'three',rawLast,true]) + '\n',
        ]);
        await writer.finish(rows.length);
    } finally {await writer.close();}

    await db.open({table:'book'});
    assert.deepEqual(await db.select({table:'book'}), rows);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'three')"}), [rows[2]]);
    await db.delete({table:'book', where:'@@id(1)'});
    const changed = {...rows[2], title:'Обновлено'};
    const added = {id:4, _uid:'four', title:'Добавлено', sourceId:'fixture', libid:'444', sourcelib:'lib', ext:'Ğ'};
    await db.insert({table:'book', rows:[changed, added], replace:true});
    await db.close({table:'book'});
    await db.open({table:'book'});
    assert.deepEqual(await db.select({table:'book', sort:'(a,b)=>a.id-b.id'}), [rows[1], changed, added]);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'one')"}), []);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'four')"}), [added]);
    const creator = new DbCreator({});
    const expected = (await db.select({table:'book'})).map(row => [row.id,row._uid,row._recordHash ?? null,creator.physicalIdentity(row)]);
    const identities = [];
    await readBookIdentities(binary, path.join(directory,'book'), expected.length, row => creator.physicalIdentity(row), batch => {
        for (const row of batch) identities.push([row.id,row.uid,row.hash,row.identity]);
    });
    assert.deepEqual(identities, expected);
}

async function checkIndex(binary, directory, db) {
    const keys = ['ё', 'е', 'и\u0306', 'й', 'co-operate', 'cooperate', 'Ё', 'Й', 'a', 'a\u200d'];
    for (let i=0; i < 60; i++) keys.push(`книга ${String(i).padStart(2, '0')}`);
    keys.sort((a,b) => a.localeCompare(b));
    const rows = keys.map((value,i) => ({id:i * 3, value, bookIds:[i]}));
    await RustTableBuilder.buildIndex(binary, path.join(directory,'native'), rows, () => {});
    await db.create({table:'reference', index:{field:'value', type:'string', unique:true, depth:1000000}});
    await db.insert({table:'reference',rows});
    await db.close({table:'reference'});
    await db.open({table:'reference'});
    await db.open({table:'native'});
    assert.deepEqual(await db.select({table:'native'}), await db.select({table:'reference'}));
    const index = name => db.table.get(name).reducer._index.get('value');
    assert.deepEqual(index('native').sorted, index('reference').sorted);
    assert.deepEqual([...index('native').hash], [...index('reference').hash]);
    const where = "return Array.from(@dirtyIndexLR('value','книга 0','книга 4'))";
    assert.deepEqual(await db.select({table:'native',rawResult:true,where}), await db.select({table:'reference',rawResult:true,where}));
}

async function checkIncomplete(binary, directory) {
    const target = path.join(directory,'partial');
    const writer = await RustTableBuilder.open(binary,target,'build-book');
    try {
        await writer.append(['[1,"a",{"id":1,"_uid":"a"}]\n']);
        await assert.rejects(writer.finish(2), /count differs/);
        await assert.rejects(fs.stat(target), {code:'ENOENT'});
    } finally {await writer.close();}
}

async function checkCatalogueUpdate(binary, directory) {
    const index = path.join(directory,'library.inpx');
    const filter = path.join(directory,'filter.json');
    const config = {...require('../server/config/base'),dataDir:directory,inpxFilterFile:filter,
        librarySources:[{id:'fixture',name:'Fixture',type:'inpx',inpxFile:index,libDir:directory}]};
    const template = (file,title,series = '',del = 0) =>
        ['Иванов, Иван:Егоров:', 'prose:sf:',title,series,1,file,1234,file,del,'fb2','2026-10-01','ru',2,''].join('\x04');
    const fixed = template('keep','Песни и ёлки','Первый'), remove = template('remove','Читать','',1);
    const original = template('edit','Чужая книга'), changed = template('edit','Ёлка №１２ in cон'), added = template('new','Йота');
    const write = async rows => {
        const zip = new (require('yazl').ZipFile)();
        zip.addBuffer(Buffer.from(rows.join('\n')+'\n'),'one.inp');
        const output = pipeline(zip.outputStream,createWriteStream(index));
        zip.end();
        await output;
    };
    const snapshot = async dbPath => {
        const db = new JembaDb();
        try {
            await db.lock({dbPath,softLock:true});
            await db.openAll();
            const tables = {};
            for (const table of ['book','author','series','title','word','genre','lang','del','date','librate','ext','source'])
                tables[table] = await db.select({table});
            const [stats] = await db.select({table:'config',where:"@@id('stats')"});
            const [update] = await db.select({table:'config',where:"@@id('indexUpdate')"});
            const {updatedAt,...changes} = update.value;
            return {tables,stats:stats.value,changes};
        } finally {await db.unlock();}
    };
    const originalDirectory = path.join(directory,'catalogue-before');
    const previousBinary = process.env.INPX_RUST_CATALOG_BINARY;
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    try {
        await write([original,fixed,remove]);
        await buildIndexInWorker({...config,rustBookStoreEnabled:false},originalDirectory,null,()=>{});
        await fs.writeFile(filter,JSON.stringify({excludeAuthors:['запрет']}));
        let previous = originalDirectory;
        for (const [step, rows] of [[1,[changed,added,fixed]],[2,[fixed,added,template('edit','Ещё одно изменение')]]]) {
            await write(rows);
            const reference = path.join(directory,`catalogue-reference-${step}`);
            const candidate = path.join(directory,`catalogue-native-${step}`);
            await buildIndexInWorker({...config,rustCatalogUpdateEnabled:false},reference,previous,()=>{});
            let native = false, warning, mode;
            await buildIndexInWorker({...config,rustCompatibilityTables:true},candidate,previous,state => {
                native ||= !!state.nativeUpdate;
                warning ||= state.rustUpdateWarning;
                mode ||= state.bookStoreMode;
            });
            assert(native,warning || 'Native catalogue update did not run');
            assert.equal(mode,step === 1 ? 'base' : 'patch');
            const actual = await snapshot(candidate);
            assert.deepEqual(actual,await snapshot(reference));
            const reader = new (require('../server/core/DatabaseThread'))(config);
            try {
                const {generation} = JSON.parse(await fs.readFile(path.join(candidate,'books-store.json'),'utf8'));
                await reader.lock({dbPath:candidate,softLock:true});
                await reader.configureBookStore(candidate,generation);
                assert(reader.bookStore);
                if (reader.bookStoreWide) {
                    assert((await fs.stat(path.join(candidate,'books-sequence.bin'))).isFile());
                    assert.deepEqual(await reader.bookStore.run(process=>process.query({op:'bookOrder'}),()=>null),actual.tables.book.map(row=>row.id));
                }
                assert.deepEqual(await reader.booksByIds(actual.tables.book.map(row => row.id)),actual.tables.book);
                if (step === 2 && reader.bookStoreScan) {
                    const {selectShelfBooks} = require('../server/core/RustShelfIndex');
                    await reader.open({table:'config'});
                    const metadata = Object.fromEntries((await reader.select({table:'config'})).map(row => [row.id,row.value]));
                    const request = {nowMs:Date.UTC(2026,9,3),daysWindows:[7,30],newestLimit:2,popularLimit:2,scores:{}};
                    const options = {directory:candidate,executable:binary,indexPath:''};
                    assert.equal(await selectShelfBooks(reader,metadata,request,options),null);
                    await reader.rustShelfIndex.building;
                    assert(!reader.rustShelfIndex.buildError,reader.rustShelfIndex.buildError);
                    const windows = await selectShelfBooks(reader,metadata,request,options);
                    assert(windows[0].length);
                    const child = reader.rustShelfIndex.process.process;
                    assert(child);
                    assert.deepEqual(await selectShelfBooks(reader,metadata,request,options),windows);
                    assert.equal(reader.rustShelfIndex.process.process,child);
                }
                assert.equal(reader.legacyBookOpen,undefined);
            } finally {await reader.unlock();}
            previous = candidate;
        }
        const controller = new AbortController();
        const abandoned = path.join(directory,'catalogue-aborted');
        await assert.rejects(buildIndexInWorker({...config,rustCompatibilityTables:true},abandoned,previous,state => {
            if (state.job === 'previous identities') controller.abort(new Error('Stop the native update'));
        },controller.signal),/Stop the native update/);
        assert(!(await fs.readdir(abandoned)).some(name => name.startsWith('.rust-catalog-')));
        console.log('ok Rust catalogue updates preserve Jemba order, identities and all posting tables across generations');

        const nativeConfig = {...config,queryCacheEnabled:true,queryCacheMemSize:0,queryCacheDiskSize:2,
            queryCacheDiskMb:2,cacheCleanInterval:0};
        const initial = path.join(directory,'without-jemba-initial');
        const updated = path.join(directory,'without-jemba-updated');
        const open = dbPath => require('../server/core/WebWorker').prototype.openCatalogue.call({config:nativeConfig},dbPath);
        const run = async (dbPath,work) => {
            const Module = require('node:module');
            const load = Module._load;
            Module._load = function(specifier,...args) {
                assert(!/^jembadb(?:\/|$)/.test(specifier),'Native catalogue loaded '+specifier);
                return load.call(this,specifier,...args);
            };
            try {
                const {db,searcher} = await open(dbPath);
                try {
                    assert(db.nativeCatalogue);
                    assert.equal(db.worker,null);
                    return await work(db,searcher);
                } finally {try {await searcher.close();} finally {await db.unlock();}}
            } finally {Module._load=load;}
        };
        await new (require('../server/core/AppLogger'))().init({...nativeConfig,loggingEnabled:false});
        await write([original,fixed,remove]);
        await buildIndexInWorker({...nativeConfig,lowMemoryMode:true},initial,null,()=>{});
        const uid = await run(initial,async (db,searcher)=>{
            const {found} = await searcher.bookSearch({title:'~^чужая',limit:5});
            assert.equal(found.length,1);
            return [found[0].id,found[0]._uid];
        });
        await write([changed,added,fixed]);
        await buildIndexInWorker(nativeConfig,updated,initial,()=>{});
        const files = await fs.readdir(updated);
        assert(files.includes('catalogue.json') && files.includes('facets'));
        assert(!files.some(name=>['book','author','config','file_hash','query_cache','query_time'].includes(name)));
        await run(updated,async (db,searcher)=>{
            const [row] = await db.booksByUids([uid[1]]);
            assert.equal(row.id,uid[0]);
            assert.notEqual(row.title,'Чужая книга');
            assert.equal(searcher.dbConfig.indexUpdate.recordsRemoved,1);
            assert((await searcher.search('author',{author:'Иванов',del:'0',limit:10})).found.some(row=>row.author.includes('Иванов')));
            const shelves = await require('../server/core/WebWorker').prototype.selectDiscoveryBookWindows
                .call({db,dbSearcher:searcher,libraryAssetGeneration:1,checkLibraryAssetState(){}},'popular',2);
            assert.equal(shelves[0].length,2);
            const titleIds = await searcher.selectTableIds('title',{});
            const groups = await searcher.groupOpdsNames('title',titleIds,1);
            searcher.config.rustOpdsGrouping=false;
            try {assert.deepEqual(groups,await searcher.groupOpdsNames('title',titleIds,1));}
            finally {delete searcher.config.rustOpdsGrouping;}
            assert(groups.length>0);
            const {fileHashesByIds,fileHashesByHash,saveFileHash} = require('../server/core/CatalogueServiceCache');
            await saveFileHash(db,{id:uid[1],hash:'old',size:10});
            await saveFileHash(db,{id:uid[1],hash:'new',size:20});
            assert.deepEqual(await fileHashesByHash(db,'old'),[]);
            assert.deepEqual(await fileHashesByHash(db,'new'),await fileHashesByIds(db,uid[1]));
            await searcher.putCached('ids-a',{ids:Uint32Array.of(2,3)});
            await searcher.putCached('ids-b',Uint32Array.of(4));
            assert.deepEqual(await searcher.getCached('ids-a'),{ids:Uint32Array.of(2,3)});
            await searcher.putCached('ids-c',Uint32Array.of(5));
            assert.equal(await searcher.getCached('ids-b'),null);
        });
        await run(updated,async (db,searcher)=>{
            assert.deepEqual(await searcher.getCached('ids-a'),{ids:Uint32Array.of(2,3)});
            assert.deepEqual(await searcher.getCached('ids-c'),Uint32Array.of(5));
        });
        console.log('ok native catalogue builds and updates without Jemba tables, preserving identities and disk caches');
    } finally {
        if (previousBinary === undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY = previousBinary;
    }
}

async function checkFolderCatalogue(binary,directory) {
    const dataDir=path.join(directory,'folder-data'), libDir=path.join(directory,'folder-books');
    await fs.mkdir(dataDir);
    await fs.mkdir(libDir);
    const config={...require('../server/config/base'),dataDir,libDir,dbCacheSize:5,queryCacheEnabled:false,lowMemoryMode:true,
        inpxFilterFile:path.join(dataDir,'filter.json'),allowUnsafeFilter:true,
        librarySources:[{id:'folder',name:'Folder',type:'folder',libDir}]};
    await fs.writeFile(config.inpxFilterFile,JSON.stringify({filter:'row => row.title !== "Exclude"'}));
    const book=title=>`<FictionBook><description><title-info><author><last-name>Reader</last-name></author><book-title>${title}</book-title></title-info></description><body><section><p>Text</p></section></body></FictionBook>`;
    const previous=path.join(dataDir,'before'), target=path.join(dataDir,'after');
    const first=path.join(libDir,'a.fb2'), second=path.join(libDir,'b.fb2');
    await fs.writeFile(first,book('One'));
    await fs.writeFile(second,book('Two'));
    await fs.writeFile(path.join(libDir,'hidden.fb2'),book('Exclude'));
    const original=process.env.INPX_RUST_CATALOG_BINARY;
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    try {
        const WebWorker=require('../server/core/WebWorker');
        const read=async (folder,work)=>{
            const {db,searcher}=await WebWorker.prototype.openCatalogue.call({config},folder);
            try {return await work(db,searcher);}
            finally {try {await searcher.close();} finally {await db.unlock();}}
        };
        await buildIndexInWorker({...config,fullOptimization:true},previous,null,()=>{});
        assert((await fs.readdir(previous)).some(name=>name.startsWith('book-order-')));
        const earlier=await read(previous,async (db,searcher)=>{
            assert(db.nativeCatalogue);
            const {found}=await searcher.bookSearch({title:'=One',limit:10});
            assert.equal(found.length,1);
            assert.equal(searcher.dbConfig.stats.bookCountAll,2);
            assert.equal(searcher.dbConfig.stats.filesCount,2);
            assert.equal(searcher.dbConfig.stats.filesDelCount,0);
            return found[0];
        });
        await fs.writeFile(first,book('One updated'));
        await fs.unlink(second);
        await fs.writeFile(path.join(libDir,'new.fb2'),book('Added'));
        await buildIndexInWorker(config,target,previous,()=>{});
        await read(target,async (db,searcher)=>{
            assert(db.nativeCatalogue);
            assert.equal(db.worker,null);
            const [updated]=await db.booksByUids([earlier._uid]);
            assert.equal(updated.id,earlier.id);
            assert.equal(updated.title,'One updated');
            assert.equal(searcher.dbConfig.indexUpdate.recordsChanged,2);
            assert.equal(searcher.dbConfig.indexUpdate.recordsRemoved,1);
            assert.equal(searcher.dbConfig.stats.filesCount,2);
            assert.equal(searcher.dbConfig.stats.filesDelCount,0);
            assert.equal((await searcher.bookSearch({title:'=Exclude',limit:10})).found.length,0);
            assert.equal(await fs.access(path.join(target,'books-patch.redb')),undefined);
        });
        console.log('ok low-memory Folder catalogue builds and updates a Rust snapshot with a custom filter');
    } finally {
        if (original===undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY=original;
    }
}

async function checkFolderInventory(binary,directory) {
    const {inventory,fingerprint}=require('../server/core/FolderIndexer');
    const root=path.join(directory,'inventory');
    const nested=path.join(root,'Подпапка');
    const outside=path.join(directory,'outside');
    await fs.mkdir(nested,{recursive:true});
    await fs.mkdir(outside);
    for (const file of ['Я.fb2','е\u0308.epub','ё.epub','note.txt','Подпапка/Alpha.FB2','Подпапка/Ёж.EpUb']) {
        const target=path.join(root,file);
        await fs.writeFile(target,file);
        await fs.utimes(target,1700000000.123456,1700000000.654321);
    }
    await fs.writeFile(path.join(outside,'excluded.fb2'),'Outside');
    await fs.symlink(outside,path.join(root,'junction'),process.platform==='win32'?'junction':'dir');
    if (process.platform!=='win32') await fs.symlink(path.join(outside,'excluded.fb2'),path.join(root,'link.fb2'));
    const original=process.env.INPX_RUST_CATALOG_BINARY;
    delete process.env.INPX_RUST_CATALOG_BINARY;
    try {
        const expected=await inventory(root);
        const expectedHash=await fingerprint({libDir:root});
        assert.equal(expected.length,5);
        process.env.INPX_RUST_CATALOG_BINARY=binary;
        assert.deepEqual(await inventory(root),expected);
        assert.equal(await fingerprint({libDir:root}),expectedHash);
        await assert.rejects(inventory(path.join(root,'absent')));
        const signal=AbortSignal.abort(new Error('Inventory cancelled'));
        await assert.rejects(inventory(root,signal),/Inventory cancelled/);
        console.log('ok native folder inventory preserves names, timestamps, fingerprint and symlink handling');
    } finally {
        if (original===undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY=original;
    }
}

async function checkFolderRecordCache(binary,directory) {
    const {FolderIndexer}=require('../server/core/FolderIndexer');
    const libDir=path.join(directory,'record-books');
    await fs.mkdir(path.join(libDir,'Серия'),{recursive:true});
    const folder={id:'cached',name:'Folder',type:'folder',libDir};
    const legacyDir=path.join(directory,'old-record-cache'), nativeDir=path.join(directory,'new-record-cache');
    const cacheFile=dataDir=>path.join(dataDir,'folder-index','cached.json');
    const book=(title,encoding='UTF-8')=>`<?xml version="1.0" encoding="${encoding}"?><FictionBook><description><title-info><book-title>${title}</book-title><genre>sf</genre><author><nickname>Reader &amp; Writer</nickname></author><sequence name="Same &amp; Series" number="0x10"/></title-info></description><body><p>Text</p></body></FictionBook>`;
    const first=path.join(libDir,'Серия','one.FB2'), fallback=path.join(libDir,'two.fb2');
    await fs.writeFile(first,book('  First &amp; original  '));
    await fs.writeFile(fallback,Buffer.from(book('Café','ISO-8859-1'),'latin1'));
    await fs.utimes(first,1700000000.123456,1700000000.654321);
    const read=async (dataDir, check=()=>{})=>{
        const rows=[];
        await new FolderIndexer(folder,{dataDir}).parse('',()=>{},chunk=>{
            rows.push(...chunk);
            check();
        });
        return rows;
    };
    const original=process.env.INPX_RUST_CATALOG_BINARY;
    delete process.env.INPX_RUST_CATALOG_BINARY;
    try {
        const legacy=await read(legacyDir);
        process.env.INPX_RUST_CATALOG_BINARY=binary;
        assert.equal(require('../server/core/RustBookArchive').executable(),binary);
        assert.deepEqual(await read(nativeDir),legacy,'Cold Rust assembly and legacy decoding must preserve the rows');
        assert.equal(legacy.find(row=>row.file==='one').serno,16);
        assert.equal(legacy.find(row=>row.file==='two').title,'Café');

        const cache=cacheFile(legacyDir);
        const earlier=await fs.readFile(cache);
        const stamp=await fs.stat(cache);
        assert.deepEqual(await read(legacyDir),legacy,'Rust reads the existing JSON cache');
        assert.deepEqual(await fs.readFile(cache),earlier);
        assert.equal((await fs.stat(cache)).ino,stamp.ino);
        assert.equal((await fs.stat(cache)).mtimeMs,stamp.mtimeMs);

        await fs.writeFile(first,book('Updated title'));
        await fs.unlink(fallback);
        await assert.rejects(read(legacyDir,()=>{throw new Error('cancelled import');}),/cancelled import/);
        assert.deepEqual(await fs.readFile(cache),earlier,'An unfinished import leaves the cache intact');
        const [updated]=await read(legacyDir);
        assert.equal(updated.title,'Updated title');
        assert.equal(updated._uid,legacy.find(row=>row.file==='one')._uid);
        assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(cache,'utf8'))),['Серия/one.FB2']);
        delete process.env.INPX_RUST_CATALOG_BINARY;
        assert.deepEqual(await read(legacyDir),[updated],'Legacy reader can reuse a cache published by Rust');
        console.log('ok Rust folder records preserve legacy rows, encoding fallback, cache reuse, and publication on success');
    } finally {
        if (original===undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY=original;
    }
}

async function checkDirectFolderCatalogue(binary,directory) {
    const dataDir=path.join(directory,'mixed-data'), libDir=path.join(directory,'mixed-loose');
    const inpx=path.join(directory,'mixed-library.inpx');
    await fs.mkdir(libDir);
    const zip=new (require('yazl').ZipFile)();
    const archive=pipeline(zip.outputStream,createWriteStream(inpx));
    zip.addBuffer(Buffer.from(['Archive Author:','prose:','Archive book','','0','10','500','10','0','fb2','2026-10-01','en','0',''].join('\x04')+'\n'),'archive.inp');
    zip.end();
    await archive;
    const book=(title,number)=>`<FictionBook><description><title-info><author><nickname>Folder Author</nickname></author><book-title>${title}</book-title><sequence name="Series" number="${number}"/></title-info></description><body><p>Text</p></body></FictionBook>`;
    const edit=path.join(libDir,'а.FB2'), removed=path.join(libDir,'z.fb2');
    await fs.writeFile(edit,book('Folder book','1e-7'));
    await fs.writeFile(removed,book('Remove this','0x10'));
    const config={...require('../server/config/base'),dataDir,libDir,lowMemoryMode:true,queryCacheEnabled:false,
        inpxFilterFile:path.join(dataDir,'no-filter'),librarySources:[
            {id:'loose',type:'folder',name:'Folder',libDir},
            {id:'archive',type:'inpx',name:'Archive',libDir:directory,inpx},
        ]};
    const reference=path.join(dataDir,'reference'), first=path.join(dataDir,'first'), update=path.join(dataDir,'update');
    const earlier=process.env.INPX_RUST_CATALOG_BINARY;
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    const snapshot=async directory=>{
        const {db,searcher}=await require('../server/core/WebWorker').prototype.openCatalogue.call({config},directory);
        try {
            const rows=await db.booksByIds(await db.catalogueBookIds());
            const {stats,inpxInfo,indexUpdate,inpxHash}=searcher.dbConfig;
            return {rows,stats,inpxInfo,inpxHash,indexUpdate};
        } finally {try {await searcher.close();} finally {await db.unlock();}}
    };
    const buildDirect=async (destination,previous)=>{
        const state={};
        await buildIndexInWorker(config,destination,previous,frame=>Object.assign(state,frame));
        assert.equal(state.rustUpdateWarning,undefined);
        assert.equal(state.rustFolderCacheWarning,undefined);
        assert.equal(state.nativeUpdate,Boolean(previous),'Both source types must use the direct compiler');
        assert.equal(state.nativePackedLookup,true);
        await assert.rejects(fs.stat(path.join(destination,'.folder-input')),{code:'ENOENT'});
        await assert.rejects(fs.stat(path.join(destination,'.folder-cache')),{code:'ENOENT'});
    };
    try {
        await new DbCreator({...config,indexDbPath:reference}).buildStandaloneCatalogue(()=>{});
        await buildDirect(first,null);
        const existing=await snapshot(reference), candidate=await snapshot(first);
        assert.deepEqual(candidate.rows,existing.rows);
        assert.deepEqual(candidate.stats,existing.stats);
        assert.deepEqual(candidate.inpxInfo,existing.inpxInfo);
        assert.equal(candidate.inpxHash,existing.inpxHash);
        assert.equal(candidate.rows.find(row=>row.title==='Folder book').serno,1e-7);

        await fs.writeFile(edit,book('Folder book updated','2.5'));
        await fs.unlink(removed);
        const epub=new (require('yazl').ZipFile)();
        const epubOutput=pipeline(epub.outputStream,createWriteStream(path.join(libDir,'new.epub')));
        epub.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),'META-INF/container.xml');
        epub.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>New EPUB</dc:title><dc:creator>Folder Author</dc:creator></metadata></package>'),'book.opf');
        epub.end();
        await epubOutput;
        await buildDirect(update,reference);
        const next=await snapshot(update);
        assert.equal(next.indexUpdate.recordsChanged,2);
        assert.equal(next.indexUpdate.recordsRemoved,1);
        const changed=next.rows.find(row=>row.title==='Folder book updated'), original=existing.rows.find(row=>row.title==='Folder book');
        assert.equal(changed._uid,original._uid);
        assert.equal(changed.id,original.id);
        assert.equal(changed.serno,2.5);
        assert.deepEqual(next.rows.find(row=>row.sourceId==='archive'),existing.rows.find(row=>row.sourceId==='archive'));
        assert.equal(next.rows.find(row=>row.ext==='epub').title,'New EPUB');
        assert.equal(changed._legacyUid,undefined);

        await fs.writeFile(path.join(libDir,'legacy.fb2'),Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>'+book('Café','0'),'latin1'));
        const fallback=path.join(dataDir,'fallback');
        const phases=[];
        await buildIndexInWorker(config,fallback,update,state=>phases.push(state));
        assert.match(phases.find(state=>state.rustUpdateWarning)?.rustUpdateWarning,/compatibility decoder: legacy\.fb2/);
        assert.equal((await snapshot(fallback)).rows.find(row=>row.file==='legacy').title,'Café');
        console.log('ok direct mixed-source Rust catalogue matches folder and INPX records and updates prior snapshots');
    } finally {
        if (earlier===undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY=earlier;
    }
}

async function main() {
    if (!process.argv[2]) throw new Error('Usage: node scripts/rust-jemba-compat-tests.js <catalog-binary>');
    const binary = path.resolve(process.argv[2] || '');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-rust-jemba-'));
    const db = new JembaDb();
    try {
        await db.lock({dbPath:directory,create:true,softLock:true});
        await checkBooks(binary, directory, db);
        await checkIndex(binary, directory, db);
        await checkIncomplete(binary, directory);
        await checkCatalogueUpdate(binary,directory);
        await checkFolderInventory(binary,directory);
        await checkFolderRecordCache(binary,directory);
        await checkDirectFolderCatalogue(binary,directory);
        await checkFolderCatalogue(binary,directory);
        console.log('ok Rust table snapshots can be queried and updated by JembaDB 5.1.7');
    } finally {
        await db.unlock();
        await fs.rm(directory, {recursive:true,force:true});
    }
}

main().catch(error => {console.error(error);process.exitCode = 1;});
