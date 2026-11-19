const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {performance} = require('node:perf_hooks');
const {openWebAccessStore} = require('../server/core/WebAccessStore');

const hash = value => createHash('sha256').update(value).digest('hex');
const fixturePassword = 'library-access-fixture';
const fingerprint = hash(fixturePassword);

async function seed(directory,rows) {
    const {store} = await openWebAccessStore(directory,fingerprint,5,false);
    try {await store.apply(rows,[]);}
    finally {await store.close();}
}

async function verify(directory,binary) {
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    const WebAccess = require('../server/core/WebAccess');
    const now = Date.now();
    const expired = hash('expired'), retained = hash('retained'), revoked = hash('revoked');
    const path = join(directory,'web-access');
    await seed(path,[[expired,{time:now-360000,used:3}],[retained,{time:now,used:3}],[revoked,{time:now,used:1}]]);

    const config = {dataDir:directory,accessPassword:fixturePassword,accessTimeout:5,dbCacheSize:5};
    const run = async (override,work) => {
        const access = new WebAccess({...config,...override});
        try {await access.init();return await work(access);}
        finally {await access.closeDb();}
    };

    const created = await run({},async access=>{
        await assert.rejects(openWebAccessStore(path,fingerprint,5,binary),{code:'INPX_CATALOGUE_LOCKED'});
        assert(await access.hasAccess(retained));
        assert.equal(await access.hasAccess(retained.slice(0,63)+'я'),false);
        assert.equal(await access.hasAccess(retained+'0'),false);
        assert.equal(await access.hasAccess(expired),false);
        await access.deleteAccess(revoked);
        assert.equal(await access.hasAccess(revoked),false);
        const salt = access.newToken('fixture-client');
        const token = hash(fixturePassword+salt);
        assert.deepEqual(await Promise.all([access.hasAccess(token),access.hasAccess(token)]),[true,true]);
        await access.cleanAccess();
        return token;
    });
    await fs.access(join(path,'sessions.redb'));
    await assert.rejects(fs.access(join(path,'access')),{code:'ENOENT'});
    assert((await fs.readdir(directory)).some(name=>name.startsWith('web-access.legacy-')));

    await run({},async access=>{
        assert.equal(access.sessions.size,2);
        assert.equal(await access.hasAccess(expired),false);
        assert(await access.hasAccess(retained));
        assert(await access.hasAccess(created));
        assert.equal(await access.hasAccess(revoked),false);
    });
    await run({accessPassword:'different-fixture-password'},async access=>{
        assert.equal(await access.hasAccess(retained),false);
        assert.equal(await access.hasAccess(created),false);
    });
    await run({},async access=>{assert.equal(await access.hasAccess(retained),false);});
    await assert.rejects(openWebAccessStore(path,fingerprint,5,false),/Rust/);

    const access = new WebAccess(config);
    try {
        const events = [];
        let finish;
        const deferred = new Promise(resolve=>{finish=resolve;});
        access.store = {apply:async (updates,removals)=>{
            events.push(updates.length ? 'saved' : 'revoked');
            if (updates.length) await deferred;
            assert(updates.length || removals.length);
        },close:async()=>{}};
        const token = hash(fixturePassword+access.newToken('fixture-client'));
        const pending = access.hasAccess(token);
        const removal = access.deleteAccess(token);
        assert.equal(await access.hasAccess(token),false);
        finish();
        assert.equal(await pending,false);
        await removal;
        assert.deepEqual(events,['saved','revoked']);
    } finally {await access.closeDb();}
    await verifyWriteFailures(WebAccess,config);
    await verifyExpiry(WebAccess,config);
    await verifyPackedStorage(directory,binary,WebAccess,config);
    await verifyPasswordLogin(directory,WebAccess,config);
    console.log('ok WebAccess migrates sessions, persists revocation and invalidates sessions after password rotation');
}

async function verifyPasswordLogin(directory,WebAccess,config) {
    const Security = require('../server/core/Security');
    const password = ' пароль 🙂 ';
    const settings = {...config,dataDir:join(directory,'password'),accessPassword:password,
        loginRateLimitEnabled:true,loginRateLimitWindowMs:60000,loginRateLimitMaxAttempts:2};
    const security = new Security(settings);
    const request = address=>({headers:{},socket:{remoteAddress:address}});
    const req = request('192.0.2.17');
    const access = new WebAccess(settings,security.nativeAuth);
    let firstToken;
    try {
        await access.init();
        assert.equal(await access.loginPassword(password.trim(),req,security),null);
        security.recordSocketAccess(req,false);
        await assert.rejects(access.loginPassword(password,req,security),{code:'INPX_LOGIN_RATE_LIMIT'});
        const legacy = hash(password+access.newToken(security.clientIp(req)));
        assert(await access.hasAccess(legacy));
        security.recordSocketAccess(req,true);
        firstToken = await access.loginPassword(password,req,security);
        assert.match(firstToken,/^[a-f0-9]{64}$/);
        assert(await access.hasAccess(firstToken));
        assert.equal(access.pendingChallenges.size,0);

        const persist = access.store.apply;
        access.store.apply = async()=>{throw new Error('password grant write failed');};
        try {
            await assert.rejects(access.loginPassword(password,req,security),/password grant write failed/);
        } finally {access.store.apply = persist;}
        assert.equal((await access.store.init(hash(password))).sessions.length,2);
        assert.equal(access.sessions.size,2);

        const full = request('192.0.2.18');
        for (let i=0;i<16;i++) access.newToken(security.clientIp(full));
        await assert.rejects(access.loginPassword(password,full,security),{code:'INPX_LOGIN_RATE_LIMIT',retryAfter:300});
        assert.equal(access.pendingChallenges.size,16);
        if (security.nativeAuth?.api.library_password_login)
            assert.equal(access.pendingChallenges.native,security.nativeAuth);
    } finally {await access.closeDb();}

    const freshSecurity = new Security(settings);
    const reopened = new WebAccess(settings,freshSecurity.nativeAuth);
    try {
        await reopened.init();
        assert(await reopened.hasAccess(firstToken));
        await reopened.deleteAccess(firstToken);
        assert.equal(await reopened.hasAccess(firstToken),false);
    } finally {await reopened.closeDb();}
    console.log('ok WebAccess password login, shared HTTP/WebSocket rate limits, challenge capacity and persisted token');
}

async function verifyPackedStorage(directory,binary,WebAccess,config) {
    const scratch = join(directory,'packed');
    const path = join(scratch,'web-access');
    const token = hash('atomic-token');
    const touch = {time:Date.now(),used:1};
    const {store} = await openWebAccessStore(path,fingerprint,5,binary);
    try {
        // A bad row after the old 2048-row boundary must roll back the whole batch.
        const count = 2048;
        const bytes = Buffer.alloc(8+(count+1)*88);
        bytes.writeUInt32LE(count+1);
        for (let index=0;index<count;index++) {
            const offset = 8+index*88;
            bytes.write(hash(`atomic-fixture-${index}`),offset,64,'ascii');
            bytes.writeDoubleLE(touch.time,offset+72);
            bytes.writeDoubleLE(touch.used,offset+80);
        }
        await assert.rejects(store.applyPacked(bytes),/invalid session key/);
        const {sessions} = await store.init(fingerprint);
        assert.deepEqual(sessions,[]);
        await store.apply([[token,touch]],[]);
    } finally {await store.close();}

    const access = new WebAccess({...config,dataDir:scratch});
    try {
        await access.init();
        if (!access.pendingChallenges.native?.api.access_complete_batch) return;
        assert.equal(typeof access.sessions.writePacked,'function');
        assert(await access.hasAccess(token));
        const persist = access.store.applyPacked.bind(access.store);
        let failure = true;
        let commits = 0;
        access.store.applyPacked = async bytes=>{
            if (failure) {
                failure = false;
                throw new Error('packed fixture write failure');
            }
            await persist(bytes);
            commits++;
        };
        await assert.rejects(access.cleanAccess(),/packed fixture write failure/);
        await access.cleanAccess();
        const updated = await access.store.init(fingerprint);
        assert.equal(updated.sessions[0][1].used,2);
        failure = true;
        await assert.rejects(access.deleteAccess(token),/packed fixture write failure/);
        await access.cleanAccess();
        await access.cleanAccess();
        assert.equal(commits,2);
        assert.deepEqual((await access.store.init(fingerprint)).sessions,[]);
        assert.equal(await access.hasAccess(token),false);
    } finally {await access.closeDb();}
    console.log('ok WebAccess binary restore, transaction rollback, retry and packed revocation confirmation');
}

async function verifyExpiry(WebAccess,config) {
    const now = Date.now();
    const lifetime = config.accessTimeout*60_000;
    const touched = hash('renewed-fixture'), backwards = hash('clock-fixture');
    const access = new WebAccess(config);
    const removed = [];
    access.store = {apply:async(_updates,removals)=>removed.push(...removals),close:async()=>{}};
    access.sessions.restore([[touched,{time:now,used:1}],[backwards,{time:now,used:1}]]);
    try {
        assert.equal(access.sessions.use(touched,now+1000),true);
        assert.equal(access.sessions.use(backwards,now-1000),true);
        await access.cleanAccess(now-1000+lifetime);
        assert.deepEqual(removed,[backwards]);
        await access.cleanAccess(now+lifetime);
        assert.equal(access.sessions.size,1);
        assert.equal(access.sessions.use(touched,now+1000+lifetime),false);
        await access.cleanAccess(now+1000+lifetime);
        assert.deepEqual(removed,[backwards,touched]);
        assert.equal(access.sessions.size,0);
    } finally {await access.closeDb();}
}

async function verifyWriteFailures(WebAccess,config) {
    const access = new WebAccess(config);
    const disk = new Map();
    let failNext = true;
    let hold;
    access.store = {apply:async(updates,removals)=>{
        const wait = hold;
        if (wait) {
            hold = null;
            wait.entered.resolve();
            await wait.resume.promise;
        }
        if (failNext) {
            failNext = false;
            throw new Error('fixture write failure');
        }
        for (const [token,row] of updates) disk.set(token,row);
        for (const token of removals) disk.delete(token);
    },close:async()=>{}};

    const token = hash(fixturePassword+access.newToken('retry-fixture'));
    try {
        await assert.rejects(access.hasAccess(token),/fixture write failure/);
        assert.equal(disk.has(token),false);
        assert(await access.hasAccess(token));
        const usesAfterGrant = disk.get(token).used;
        assert(await access.hasAccess(token));
        const gate = hold = {entered:Promise.withResolvers(),resume:Promise.withResolvers()};
        failNext = true;
        const flush = access.cleanAccess();
        const rejected = assert.rejects(flush,/fixture write failure/);
        await gate.entered.promise;
        try {
            assert(await access.hasAccess(token));
            assert.equal(disk.get(token).used,usesAfterGrant);
        } finally {gate.resume.resolve();}
        await rejected;
        await access.cleanAccess();
        assert.equal(disk.get(token).used,usesAfterGrant+2);

        failNext = true;
        await assert.rejects(access.deleteAccess(token),/fixture write failure/);
        assert.equal(await access.hasAccess(token),false);
        assert(disk.has(token));
        await access.cleanAccess();
        assert.equal(disk.has(token),false);
    } finally {await access.closeDb();}
    console.log('ok WebAccess retries grant, refresh and revocation writes without granting revoked tokens');
}

const measure = async work=>{
    const start = performance.now();
    await work();
    return performance.now()-start;
};
const median = values=>Math.round(values.toSorted((a,b)=>a-b)[values.length>>1]*10)/10;

async function benchmarkCache(directory,binary,wasm) {
    if (!wasm) throw new Error('Set INPX_RUST_AUTH_WASM to benchmark the Rust access cache');
    const WebAccess = require('../server/core/WebAccess');
    const now = Date.now();
    const count = 10000;
    const touches = 64;
    const rows = Array.from({length:count},(_,index)=>[hash('cache-sample-'+index),{time:now,used:1}]);
    const keys = rows.slice(0,touches).map(([key])=>key);
    const clock = Date.now;
    Date.now = () => now;
    const contexts = [];
    const durableContexts = [];
    try {
        for (const rust of [false,true]) {
            if (rust) process.env.INPX_RUST_AUTH_WASM = wasm;
            else delete process.env.INPX_RUST_AUTH_WASM;
            const config = {dataDir:join(directory,rust?'rust':'js'),accessPassword:fixturePassword,accessTimeout:5,dbCacheSize:5};
            const cached = new WebAccess(config);
            contexts.push(cached);
            cached.store = {apply:async()=>{},close:async()=>{}};
            cached.sessions.restore(rows);

            process.env.INPX_RUST_CATALOG_BINARY = binary;
            const initial = await openWebAccessStore(join(config.dataDir,'web-access'),fingerprint,5,binary);
            try {await initial.store.apply(rows,[]);}
            finally {await initial.store.close();}
            const persistent = new WebAccess(config);
            durableContexts.push(persistent);
            await persistent.init();
        }

        async function compare(stage,fixtures,rounds,warmup,prepare,operation) {
            const times = [[],[]];
            for (let round=0;round<rounds+warmup;round++) for (const i of round%2 ? [1,0] : [0,1]) {
                await prepare(fixtures[i],round);
                const start = performance.now();
                await operation(fixtures[i],round);
                if (round>=warmup) times[i].push((performance.now()-start)*1000);
            }
            const stats = values=>{
                values.sort((a,b)=>a-b);
                return {medianUs:values[Math.floor(values.length*0.5)],p95Us:values[Math.ceil(values.length*0.95)-1]};
            };
            console.log(JSON.stringify({stage,sessions:count,before:stats(times[0]),after:stats(times[1])}));
        }

        const idle = async()=>{};
        const touch = async access=>{
            for (const key of keys) assert(await access.hasAccess(key));
        };
        await compare('hot-token',contexts,4000,1000,idle,async(access,round)=>{
            assert(await access.hasAccess(rows[(round*193)%count][0]));
        });
        for (const access of contexts) await access.cleanAccess(now);
        await compare('clean-pass',contexts,1000,200,idle,access=>access.cleanAccess(now));
        await compare('refresh-64-memory',contexts,101,15,touch,access=>access.cleanAccess(now));
        const expired = keys.map(key=>[key,{time:now-300000,used:1}]);
        await compare('expire-64-memory',contexts,101,15,access=>access.sessions.restore(expired),access=>access.cleanAccess(now));
        await compare('refresh-64-redb',durableContexts,31,7,touch,access=>access.cleanAccess(now));
    } finally {
        Date.now = clock;
        process.env.INPX_RUST_AUTH_WASM = wasm;
        await Promise.all([...contexts,...durableContexts].map(access=>access.closeDb()));
    }
}

async function benchmark(directory,binary,count=4096) {
    const paths = [join(directory,'before'),join(directory,'after')];
    const binaries = [false,binary];
    const rows = Array.from({length:count},(_,index)=>[hash('benchmark-session-'+index),{time:Date.now(),used:1}]);
    for (const path of paths) await seed(path,rows);
    const migrationMs = await measure(async()=>{
        const {store,sessions} = await openWebAccessStore(paths[1],fingerprint,5,binary);
        try {assert.equal(sessions.length,count);}
        finally {await store.close();}
    });
    console.log(JSON.stringify({stage:'migration',sessions:count,ms:Math.round(migrationMs*10)/10}));

    const open = [[],[]], refresh = [[],[]], save = [[],[]], revoke = [[],[]];
    for (let round=0;round<5;round++) for (const index of round%2 ? [1,0] : [0,1]) {
        let start = performance.now();
        const {store,sessions} = await openWebAccessStore(paths[index],fingerprint,5,binaries[index]);
        open[index].push(performance.now()-start);
        try {
            assert.equal(sessions.length,count);
            const dirty = rows.map(([key,value])=>[key,{...value,used:round+2}]);
            refresh[index].push(await measure(async()=>{
                if (index) await store.apply(dirty,[]);
                else for (const row of dirty) await store.apply([row],[]);
            }));
            for (let offset=0;offset<7;offset++) {
                const key = hash('bench-new-'+round+'-'+offset);
                start = performance.now();
                await store.apply([[key,{time:Date.now(),used:1}]],[]);
                save[index].push(performance.now()-start);
                revoke[index].push(await measure(()=>store.apply([],[key])));
            }
        } finally {await store.close();}
    }
    for (const [stage,values] of Object.entries({open,refresh,save,revoke}))
        console.log(JSON.stringify({stage,sessions:count,beforeMs:median(values[0]),afterMs:median(values[1])}));
}

async function main(binary,mode) {
    if (!binary) throw new Error('Usage: node scripts/rust-web-access-tests.js <catalog-binary> [benchmark|cache-benchmark]');
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-web-access-'));
    try {
        await new (require('../server/core/AppLogger'))().init({dataDir:directory,loggingEnabled:false});
        binary = resolve(binary);
        if (mode==='cache-benchmark') await benchmarkCache(directory,binary,process.env.INPX_RUST_AUTH_WASM);
        else await (mode==='benchmark' ? benchmark : verify)(directory,binary);
    }
    finally {await fs.rm(directory,{recursive:true,force:true});}
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
