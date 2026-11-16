const assert = require('node:assert/strict');
const {access} = require('node:fs/promises');
const {dirname,resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const {catalogGeneration} = require('../server/core/RustShelfIndex');
const {buildShelfIndex} = require('../server/core/RustShelfBuild');
const base = require('../server/config/base');

const daysWindows = [7,30,90,180,365];
const median = values => Math.round(values.toSorted((a,b) => a-b)[values.length>>1]*10)/10;

async function main(binary,directory,indexFile) {
    if (!binary || !directory || !indexFile) throw new Error('Usage: node scripts/compare-rust-catalog.js <catalog-binary> <db-dir> <index.redb>');
    const executable = resolve(binary), dbPath = resolve(directory), indexPath = resolve(indexFile);
    const config = {...base,dataDir:dirname(dbPath),queryCacheEnabled:false,loggingEnabled:false};
    process.env.INPX_RUST_CATALOG_BINARY = executable;
    await new (require('../server/core/AppLogger'))().init(config);
    const WebWorker = require('../server/core/WebWorker');
    const {db,searcher} = await WebWorker.prototype.openCatalogue.call({config},dbPath);
    const worker = Object.assign(Object.create(WebWorker.prototype), {db,dbSearcher:searcher,myState:'normal',libraryAssetGeneration:1,
        addAdminEvent:() => assert.fail('Rust shelf query fell back')});
    try {
        const generation = catalogGeneration(searcher.dbConfig);
        assert(generation,'The source must be a completed catalogue');
        try {await access(indexPath);}
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const started = performance.now();
            const result = await buildShelfIndex(executable,indexPath,db,generation);
            console.log(JSON.stringify({stage:'build',indexed:result.indexed,ms:Math.round(performance.now()-started),nativeScan:!!db.bookStoreScan}));
        }
        const requests = [['default',Date.now(),8,{},8],['historical',Date.UTC(2022,6,1),8,{},8]];
        const run = async ([,now,limit,scores,popularLimit], native) => {
            if (native) {
                process.env.INPX_RUST_CATALOG_BINARY = executable;
                process.env.INPX_RUST_CATALOG_INDEX = indexPath;
            } else {
                delete process.env.INPX_RUST_CATALOG_BINARY;
                delete process.env.INPX_RUST_CATALOG_INDEX;
            }
            const started = performance.now();
            const shelves = await worker.selectDiscoveryBookWindows('newest',limit,daysWindows,scores,popularLimit,now);
            if (native) assert(db.rustShelfIndex?.process?.process,'Persistent Rust shelf process did not run');
            return {shelves,ms:performance.now()-started};
        };
        for (const request of requests) {
            const [label] = request, times = [[],[]];
            let windows;
            for (let round=0;round<3;round++) {
                const results = [];
                for (const native of round%2 ? [0,1] : [1,0]) {
                    const result = await run(request,native);
                    results[native] = result.shelves;
                    times[native].push(result.ms);
                }
                assert.deepEqual(results[1],results[0],`Shelf membership or order differs for ${label}`);
                windows = results[0];
            }
            console.log(JSON.stringify({case:label,windows:windows.map(shelf => shelf.length),beforeMs:median(times[0]),afterMs:median(times[1]),samples:times}));
            if (label === 'default') {
                const scores = Object.fromEntries(windows.flat().slice(0,7).map((row,index) => [row._uid,{score:index+10}]));
                requests.push(['activity',request[1],24,scores,24]);
            }
        }
    } finally {
        try {await searcher.close();}
        finally {await db.unlock();}
    }
}

main(...process.argv.slice(2)).catch(error => {console.error(error);process.exitCode=1;});
