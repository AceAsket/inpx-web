const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {dirname,join,resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const base = require('../server/config/base');
const {buildIndexInWorker} = require('../server/core/IndexBuilder');

const median = samples => samples.toSorted((a,b)=>a-b)[samples.length>>1];
const ms = value => Math.round(value*10)/10;
const config = {...base,inpxFilterFile:'',loggingEnabled:false,queryCacheMemSize:0,cacheCleanInterval:0};

async function build(directory,index,previous,legacy,options={}) {
    const dataDir = dirname(directory);
    const started = performance.now(), phases = {};
    let last = started, phase, records, native;
    await buildIndexInWorker({...config,...options,dataDir,rustCompatibilityTables:legacy,
        librarySources:[{id:'benchmark',name:'Benchmark',enabled:true,type:'inpx',inpxFile:index,libDir:dirname(index)}]},
    directory,previous,status=>{
        if (status.rustUpdateWarning) console.error(status.rustUpdateWarning);
        records = status.recsLoaded ?? records;
        native ||= status.nativeCatalogue;
        if (status.job && status.job!==phase) {
            const now = performance.now();
            if (phase) phases[phase] = (phases[phase] || 0)+now-last;
            last = now;
            phase = status.job;
        }
    });
    const wallMs = ms(performance.now()-started);
    const entries = await fs.readdir(directory);
    if (!legacy) {
        assert(native,'Native catalogue build fell back');
        assert(!entries.some(name=>['book','author','word','config','file_hash','query_cache','query_time'].includes(name)));
    }
    console.log(JSON.stringify({stage:previous ? 'update' : 'build',catalogue:legacy ? 'compatible' : 'native',wallMs,records,
        indexFiles:entries,phases:Object.fromEntries(Object.entries(phases).map(([name,time])=>[name,ms(time)]))}));
}

async function measure(working) {
    await new (require('../server/core/AppLogger'))().init({...config,dataDir:working});
    const WebWorker = require('../server/core/WebWorker');
    const Discovery = require('../server/core/CatalogDiscovery');
    const snapshots = ['before-update','after-update'].map(name=>join(working,name));
    const open = (directory,nativeCache) => WebWorker.prototype.openCatalogue.call({config:{...config,dataDir:working,
        rustServiceCacheEnabled:nativeCache,queryCacheEnabled:false}},directory);
    const times = [[],[]];
    for (let round=0;round<3;round++) for (const index of round%2 ? [1,0] : [0,1]) {
        const started = performance.now();
        const {db,searcher} = await open(snapshots[index],!!index);
        times[index].push(performance.now()-started);
        await searcher.close();
        await db.unlock();
    }
    console.log(JSON.stringify({stage:'open',beforeMs:ms(median(times[0])),afterMs:ms(median(times[1]))}));
    const pairs = [];
    try {
        for (const [index,directory] of snapshots.entries()) {
            const app = await open(directory,!!index);
            app.discovery = new Discovery({db:app.db,dbSearcher:app.searcher,libraryAssetGeneration:1});
            pairs.push(app);
        }
        const cases = [
            ['names',app=>app.searcher.search('author',{author:'Стругацкий',del:'0',limit:15})],
            ['name-prefix',app=>app.discovery.browse({kind:'series',prefix:'войн'})],
            ['filtered-books',app=>app.searcher.bookSearch({author:'Толстой',title:'война',lang:'ru',del:'0',limit:20})],
            ['regex-books',app=>app.searcher.bookSearch({title:'~^пикник на обочине',del:'0',limit:20})],
            ['opds-author',app=>app.searcher.getAuthorBookList(null,'Толстой Лев Николаевич')],
            ['suggestions',app=>app.discovery.suggest({kind:'title',query:'мастер'})],
        ];
        for (const [name,run] of cases) {
            const samples=[[],[]];
            for (let round=0;round<3;round++) {
                const values=[];
                for (const index of round%2 ? [1,0] : [0,1]) {
                    pairs[index].discovery.close();
                    const started = performance.now();
                    values[index]=await run(pairs[index]);
                    samples[index].push(performance.now()-started);
                }
                assert.deepEqual(values[1],values[0],name);
            }
            console.log(JSON.stringify({stage:'search',name,beforeMs:ms(median(samples[0])),afterMs:ms(median(samples[1]))}));
        }
        await measureCaches(pairs);
    } finally {
        for (const {db,searcher,discovery} of pairs) {
            discovery.close();
            try {await searcher.close();} finally {await db.unlock();}
        }
    }
}

async function measureCaches(pairs) {
    const {fileHashesByIds,fileHashesByHash,saveFileHash} = require('../server/core/CatalogueServiceCache');
    const [legacy] = pairs;
    for (const {searcher} of pairs) {
        searcher.queryCacheEnabled=true;
        searcher.queryCacheDiskSize=32;
        searcher.queryCacheDiskBytes=64*1024*1024;
    }
    const ids=await legacy.db.catalogueBookIds();
    assert(ids.length>=819000);
    const result=Uint32Array.from(ids);
    const fileRows=ids.slice(0,6000).map((id,index)=>({id:`bench-${id}`,hash:`hash-${index}`,size:index+1,assetVersion:'fixture'}));
    await legacy.db.insert({table:'file_hash',replace:true,rows:fileRows});
    for (const row of fileRows) await saveFileHash(pairs[1].db,row);
    const cases=[
        ['write-ids',async ({searcher},key)=>{await searcher.putCached(key,result);}],
        ['read-ids',async ({searcher},key)=>assert.deepEqual(await searcher.getCached(key),result)],
        ['file-uids',async ({db})=>assert.deepEqual(await fileHashesByIds(db,fileRows.slice(5100,5200).map(row=>row.id)),fileRows.slice(5100,5200))],
        ['file-by-hash',async ({db})=>assert.deepEqual(await fileHashesByHash(db,fileRows.at(-1).hash),[fileRows.at(-1)])],
    ];
    for (const [name,run] of cases) {
        const samples=[[],[]];
        for (let round=0;round<7;round++) for (const index of round%2 ? [1,0] : [0,1]) {
            const started=performance.now();
            await run(pairs[index],`bench-ids-${round}`);
            samples[index].push(performance.now()-started);
        }
        console.log(JSON.stringify({stage:'cache',name,beforeMs:ms(median(samples[0])),afterMs:ms(median(samples[1]))}));
    }
}

async function main([mode,binary,reader,working,initial,updated]) {
    process.env.INPX_RUST_CATALOG_BINARY=resolve(binary);
    process.env.INPX_RUST_READER_BINARY=resolve(reader);
    working=resolve(working);
    if (mode==='build') {
        const previous=join(working,'before-build');
        await fs.mkdir(working,{recursive:true});
        await build(previous,resolve(initial),null,true);
        await build(join(working,'after-build'),resolve(initial),null,false);
        await build(join(working,'before-update'),resolve(updated),previous,true);
        await build(join(working,'after-update'),resolve(updated),previous,false);
    } else if (mode==='measure') {
        await measure(working);
    } else if (mode==='verify') {
        await verify(working);
    } else if (mode==='opds') {
        await measureOpds(working);
    } else if (mode==='filtered-build') {
        await fs.mkdir(working,{recursive:true});
        const inpxFilterFile=join(working,'benchmark-filter.json');
        await fs.writeFile(inpxFilterFile,JSON.stringify({filter:'row => row.ext === "fb2"'}),{flag:'wx'});
        const options={inpxFilterFile,allowUnsafeFilter:true};
        await build(join(working,'before-filtered-build'),resolve(initial),null,true,options);
        await build(join(working,'after-filtered-build'),resolve(initial),null,false,options);
        await verify(working,['filtered-build']);
    } else if (mode==='filtered-tuned') {
        const options={inpxFilterFile:join(working,'benchmark-filter.json'),allowUnsafeFilter:true};
        await build(join(working,'after-filtered-tuned'),resolve(initial),null,false,options);
        await verify(working,['filtered-build'],'filtered-tuned');
    } else if (mode==='full-build') {
        const options={fullOptimization:true};
        for (const [side,legacy] of [['before',true],['after',false]])
            await build(join(working,`${side}-full-build`),resolve(initial),null,legacy,options);
        await verify(working,['full-build']);
        await measureFullBuild(working);
    } else if (mode==='low-before' || mode==='low-after') {
        const before=mode==='low-before';
        await build(join(working,before ? 'before-low-build' : 'after-low-build'),resolve(initial),null,before,{lowMemoryMode:true});
    } else if (mode==='verify-low') {
        await verify(working,['low-build']);
    } else throw new Error('Usage: compare-rust-native-catalogue.js build|measure|verify|opds|filtered-build|filtered-tuned|full-build|low-before|low-after|verify-low <catalog-binary> <reader-binary> <work-dir> [original.inpx updated.inpx]');
}

async function measureFullBuild(working) {
    const WebWorker=require('../server/core/WebWorker'), samples=[[],[]];
    for (let round=0;round<3;round++) {
        const responses=[];
        for (const index of round%2 ? [1,0] : [0,1]) {
            const folder=join(working,index ? 'after-full-build' : 'before-full-build');
            const {db,searcher}=await WebWorker.prototype.openCatalogue.call({config:{...config,dataDir:working,queryCacheEnabled:false}},folder);
            try {
                if (index) assert((await fs.readdir(folder)).some(name=>name.startsWith('book-order-')));
                const start=performance.now();
                responses[index]=await searcher.bookSearch({limit:20});
                samples[index].push(performance.now()-start);
            } finally {try {await searcher.close();} finally {await db.unlock();}}
        }
        assert.deepEqual(responses[0],responses[1]);
    }
    console.log(JSON.stringify({stage:'full-build-first-page',beforeMs:ms(median(samples[0])),afterMs:ms(median(samples[1]))}));
}

async function measureOpds(working) {
    await new (require('../server/core/AppLogger'))().init({...config,dataDir:working});
    const WebWorker = require('../server/core/WebWorker');
    const settings={...config,dataDir:working,queryCacheEnabled:false};
    const {db,searcher}=await WebWorker.prototype.openCatalogue.call({config:settings},join(working,'after-update'));
    try {
        for (const [table,query] of [
            ['author',{depth:1}],
            ['series',{depth:2}],
            ['title',{depth:2,lang:'ru',del:'0'}],
        ]) {
            const samples=[[],[]];
            let count, groups;
            for (let round=0;round<5;round++) {
                const results=[];
                for (const index of round%2 ? [1,0] : [0,1]) {
                    settings.rustOpdsGrouping=!!index;
                    const started=performance.now();
                    results[index]=await searcher.opdsQuery(table,query);
                    samples[index].push(performance.now()-started);
                }
                assert.deepEqual(results[0],results[1],table);
                count=results[1].totalFound;
                groups=results[1].found.length;
                assert(count>0 && groups>0);
            }
            console.log(JSON.stringify({stage:'opds-groups',table,count,groups,
                beforeMs:ms(median(samples[0])),afterMs:ms(median(samples[1]))}));
        }
        for (const [name,run] of [
            ['author-books',()=>searcher.getAuthorBookList(null,'Толстой Лев Николаевич')],
            ['title-books',()=>searcher.search('title',{title:'война',limit:30})],
        ]) {
            const samples=[[],[]];
            for (let round=0;round<5;round++) {
                const results=[];
                for (const index of round%2 ? [1,0] : [0,1]) {
                    settings.rustBookGroups=!!index;
                    const started=performance.now();
                    results[index]=await run();
                    samples[index].push(performance.now()-started);
                }
                assert.deepEqual(results[0],results[1],name);
            }
            console.log(JSON.stringify({stage:'grouped-books',name,beforeMs:ms(median(samples[0])),afterMs:ms(median(samples[1]))}));
        }
    } finally {try {await searcher.close();} finally {await db.unlock();}}
}

async function verify(working,stages=['build','update'],candidateName) {
    await new (require('../server/core/AppLogger'))().init({...config,dataDir:working});
    const WebWorker = require('../server/core/WebWorker');
    for (const stage of stages) {
        const result = [];
        for (const side of ['before','after']) {
            const directory = join(working,`${side}-${side==='after' && candidateName ? candidateName : stage}`);
            const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config:{...config,dataDir:working,queryCacheEnabled:false}},directory);
            try {
                const hash = require('node:crypto').createHash('sha256');
                const ids = await db.catalogueBookIds();
                for (let offset=0;offset<ids.length;offset+=2048) {
                    const rows = await db.booksByIds(ids.slice(offset,offset+2048),['id','_uid','_recordHash']);
                    assert.equal(rows.length,Math.min(2048,ids.length-offset));
                    hash.update(JSON.stringify(rows.map(row=>[row.id,row._uid,row._recordHash])));
                }
                const {updatedAt,...changes} = searcher.dbConfig.indexUpdate;
                result.push({count:ids.length,hash:hash.digest('hex'),stats:searcher.dbConfig.stats,...changes});
            } finally {try {await searcher.close();} finally {await db.unlock();}}
        }
        assert.deepEqual(result[1],result[0],stage);
        console.log(JSON.stringify({stage:'parity',pair:stage,...result[1]}));
    }
}

main(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
