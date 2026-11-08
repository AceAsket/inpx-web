// Fresh process per synthetic profile fixture. Forced GC distinguishes live data
// from garbage; sampled peak is a lower bound, not a heap-profiler maximum.
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {performance} = require('perf_hooks');
const exec = require('util').promisify(require('child_process').execFile);
const MiB = 1024 ** 2;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([k,v]) => [k+'MiB', +(v/MiB).toFixed(2)]));

async function child(profiles, imageBytes) {
    const Store = require('../server/core/ReadingListStore');
    const password = require('../server/core/ProfilePassword');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-state-resources-'));
    let timer;
    try {
        const store = new Store({dataDir:directory,adminPassword:'fixture-password'});
        let data = store.makeDefaultData();
        let backgroundImage = imageBytes ? 'data:image/png;base64,' + Buffer.alloc(imageBytes).toString('base64') : '';
        data.users = [{...store.makeAdminUser(),passwordHash:password.legacy('admin','fixture-password')},
            ...Array.from({length:profiles},(_,i)=>({...store.makeDefaultUser(),id:`user-${i}`,name:`User ${i}`,login:`user${i}`,
                readerPreferences:{...store.normalizeReaderPreferences(),backgroundImage}}))];
        await store.save(data); data = null; backgroundImage = null;
        global.gc(); await pause(30); global.gc();
        const baseline = memory();
        await store.getUser('admin'); await store.getUser('admin');
        global.gc(); const warmCache = memory();
        let peak = {...warmCache};
        const sample = () => {const m=memory();for(const k of Object.keys(m))peak[k]=Math.max(peak[k],m[k]);};
        for (const name of ['load','save','writeData','writeDataNow']) {
            const original = store[name].bind(store);
            store[name] = async (...args) => {sample();try{return await original(...args);}finally{sample();}};
        }
        timer = setInterval(sample,5);
        const result = {profiles,imageBytes,fileBytes:(await fs.stat(store.file)).size,baseline,warmCache};
        for (const [name,count,work] of [
            ['warmGetUser',10,()=>store.getUser('admin')],
            ['progressUpdate',3,i=>store.updateReaderProgress('admin','fixture-book',{percent:.1+i/100})]
        ]) {
            const started=performance.now(),cpu=process.cpuUsage();
            for(let i=0;i<count;i++)await work(i);
            const elapsed=performance.now()-started,used=process.cpuUsage(cpu);
            result[name]={operations:count,averageWallMs:+(elapsed/count).toFixed(2),averageCpuMs:+((used.user+used.system)/1000/count).toFixed(2)};
        }
        sample();clearInterval(timer);await pause(100);global.gc();await pause(30);global.gc();
        result.sampledPeak=peak;result.afterGc=memory();result.cacheStillRetained=!!store.loaded;
        console.log(JSON.stringify(result));
    } finally {clearInterval(timer);await fs.remove(directory);}
}

(async()=>{
    if(process.argv[2]==='child')return child(Number(process.argv[3]),Number(process.argv[4]));
    const results=[];
    for(const [profiles,bytes] of [[1,0],[1,4*MiB],[10,4*MiB]]) {
        const {stdout}=await exec(process.execPath,['--expose-gc',__filename,'child',String(profiles),String(bytes)],{windowsHide:true,timeout:120000});
        results.push(JSON.parse(stdout));
    }
    console.log(JSON.stringify({node:process.version,forcedGc:true,freshProcessPerCase:true,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
