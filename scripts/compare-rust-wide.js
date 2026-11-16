const assert = require('node:assert/strict');
const {dirname,resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const {isDeepStrictEqual} = require('node:util');
const RustWideOrder = require('../server/core/RustWideOrder');
const base = require('../server/config/base');

const median = values => Math.round(values.toSorted((a,b)=>a-b)[values.length>>1]*10)/10;

async function main(binary,directory,mode) {
    if (!binary || !directory) throw new Error('Usage: node scripts/compare-rust-wide.js <catalog-binary> <db-dir> [names|wide]');
    const dir=resolve(directory);
    process.env.INPX_RUST_CATALOG_BINARY=resolve(binary);
    const config={...base,dataDir:dirname(dir),queryCacheEnabled:false,loggingEnabled:false};
    await new (require('../server/core/AppLogger'))().init(config);
    const WebWorker=require('../server/core/WebWorker');
    const {db,searcher}=await WebWorker.prototype.openCatalogue.call({config},dir);
    const discovery = new (require('../server/core/CatalogDiscovery'))({db,dbSearcher:searcher,libraryAssetGeneration:1});
    let native = false, nativeIndex=0,nativeScan=0,legacyTables=0,legacyBooks=0;
    const select=db.select.bind(db);
    db.select=query=>{
        if (['author','series','title','word'].includes(query.table)) legacyTables++;
        if (query.table==='book') legacyBooks++;
        return select(query);
    };
    const runSearch=searcher.rustLookup.run.bind(searcher.rustLookup);
    searcher.rustLookup.run=(work,fallback)=>runSearch(process=>work({query:request=>process.query(request),labelOrder:async table=>{
        if(!native)return null;
        const order=await process.labelOrder(table);
        if(order)nativeIndex++;
        return order;
    }}),fallback);
    const nativeStore=db.bookStore;
    assert(nativeStore && db.bookStoreWide,'Rust wide search capability missing');
    const wideStore=db.rustWideStore;
    const runStore=wideStore.run.bind(wideStore);
    wideStore.run=(work,fallback)=>runStore(process=>work({query:async request=>{
        const value=await process.query(request);
        if (request.op==='wideSearch') nativeScan++;
        return value;
    }}),fallback);
    try {
        if(mode!=='wide') {
            const started=performance.now();
            await runSearch(async process=>{
                for(const name of ['author','series','title','word']) assert(await process.labelOrder(name),`Missing Rust index ${name}`);
            },()=>assert.fail('Rust name indexes failed'));
            console.log(JSON.stringify({stage:'name-index-load',ms:Math.round(performance.now()-started)}));
            await compare('name-index',[['author-exact',()=>searcher.selectBookIds({author:'=Толстой Лев Николаевич'})],
                ['series-exact',()=>searcher.selectBookIds({series:'=Война и мир'})],
                ['title-prefix',()=>searcher.selectBookIds({title:'про'})],
                ['title-two-words',()=>searcher.selectBookIds({title:'война мир'})],
                ['author-page',()=>searcher.search('author',{author:'Стругацкий',limit:15})],
                ['title-suggestions',()=>discovery.suggest({kind:'title',query:'мастер'})]]);
        }
        if(mode!=='names') {
            db.rustWideOrder=new RustWideOrder(dir,nativeStore);
            const started=performance.now(), key=await db.rustWideOrder.available();
            if(!key) {
                const rows=await db.rustWideOrder.prepare();
                console.log(JSON.stringify({stage:'book-order-build',ms:Math.round(performance.now()-started),rows}));
            }
            await db.openLegacyBooks();
            await compare('wide-search',[['catalogue-first-page',()=>searcher.bookSearch({limit:20})],
                ['wide-filtered',()=>searcher.bookSearch({date:'2022-01-01,2025-12-31',del:'0',ext:'fb2|epub',offset:50,limit:20})],
                ['wide-copies',()=>searcher.bookSearch({del:'0',hideCopies:true,offset:400,limit:20})],
                ['all-ids',()=>searcher.bookSearchIds({del:'0'})]]);
        }

        async function compare(kind,cases) {
            for(const [label,work] of cases) {
                const times=[[],[]];
                let records;
                for(let round=0;round<3;round++) {
                    const results=[];
                    for(const active of round%2 ? [1,0] : [0,1]) {
                        native=kind==='wide-search' || !!active;
                        db.bookStoreWide=kind==='wide-search' && !!active;
                        const before=[nativeIndex,nativeScan,legacyTables,legacyBooks], started=performance.now();
                        discovery.close();
                        const value=await work();
                        times[active].push(performance.now()-started);
                        results[active]=value;
                        if(active && kind==='name-index') {
                            assert(nativeIndex>before[0],`No Rust key lookup for ${label}`);
                            assert.equal(legacyTables,before[2],`Jemba name table was queried for ${label}`);
                        } else if(active) {
                            assert(nativeScan>before[1],`No Rust wide search for ${label} (${wideStore.lastError || 'unsupported query'})`);
                            assert.equal(legacyBooks,before[3],`Jemba books were scanned for ${label}`);
                        }
                    }
                    const size=value=>value.totalFound ?? value.length ?? value.groups?.reduce((total,group)=>total+group.items.length,0);
                    records=size(results[0]);
                    assert(isDeepStrictEqual(results[0],results[1]),`Results differ for ${label} (${records}/${size(results[1])})`);
                    assert(records>0,`Empty benchmark case ${label}`);
                }
                console.log(JSON.stringify({kind,case:label,records,beforeMs:median(times[0]),afterMs:median(times[1]),samples:times}));
            }
        }
    } finally {
        discovery.close();
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
