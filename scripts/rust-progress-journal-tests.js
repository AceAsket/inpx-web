const assert = require('node:assert/strict');
const {resolve,join} = require('node:path');
const fs = require('node:fs/promises');
const {spawnSync} = require('node:child_process');
const {tmpdir} = require('node:os');
const {performance} = require('node:perf_hooks');
const journal = require('../server/core/ReaderProgressJournal');
const backup = require('../server/core/BackupTransaction');

const checkpoint = 'a'.repeat(32);
const users = () => ({users:[{id:'alpha',readerProgressGeneration:2},{id:'beta',readerProgressGeneration:3}]});
const median = values => Math.round(values.toSorted((a,b)=>a-b)[values.length>>1]*100)/100;

async function verify(binary,directory) {
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    await new (require('../server/core/AppLogger'))().init({dataDir:directory,loggingEnabled:false});
    for (const test of require('./reader-progress-journal-tests')) {
        await test();
        console.log('ok native',test.name);
    }
    const upgrades = require('./upgrade-compatibility-tests');
    for (const name of ['testUpgradeSnapshotPreservesUserDataSecretsAndCustomReader',
        'testUpgradeRelocatesWorkingDirectoryWithoutLosingProfiles']) {
        const test = upgrades.find(candidate=>candidate.name===name);
        await test();
        console.log('ok native',test.name);
    }
    const file = join(directory,journal.fileName);
    const updates = [
        ['alpha','old',{generation:2},'one'],
        ['alpha','new',{generation:2},'two'],
        ['beta','foreign',{generation:3},'three'],
        ['alpha','old',{generation:2,textSnippet:String.fromCharCode(0xd800)},'four'],
        ['alpha','__proto__',{generation:2},'five'],
        ['alpha','old',{generation:2},'last'],
    ];
    await fs.writeFile(file,checkpoint+'\n'+updates.map(entry=>JSON.stringify(entry)).join('\n')+'\n["partial');
    const stamp = await journal.stamp(file);
    const native = users(), legacy = users();
    assert.equal((await journal.replay(file,checkpoint,native,stamp)).offset,(await fs.stat(file)).size-9);
    delete process.env.INPX_RUST_CATALOG_BINARY;
    await journal.replay(file,checkpoint,legacy,stamp);
    assert.deepEqual(native,legacy);
    assert.deepEqual(Object.keys(native.users[0].readerProgress),['old','new','__proto__']);
    assert.equal(native.users[0].updatedAt,'last');
    assert(Object.hasOwn(native.users[0].readerProgress,'__proto__'));
    await verifyWrites(binary,directory);
    await verifySnapshots(binary,directory);
    await verifyCredentialWrites(directory);
    await verifyAdminBootstrap(directory);
    await verifyBackup(binary,directory);
}

async function verifyCredentialWrites(directory) {
    const dataDir = join(directory,'profile-credentials');
    await fs.mkdir(dataDir);
    const file = join(dataDir,'reading-lists.json');
    const progress = join(dataDir,journal.fileName);
    const admin = {id:'admin',name:'Admin',login:'admin',isAdmin:true,passwordHash:'existing',opdsEnabled:false};
    const reader = {id:'reader',name:'Reader',login:'reader',passwordHash:'existing',opdsEnabled:true,
        profileTotp:{secret:'enc:v1:fixture',lastStep:123,recoveryHashes:[]},
        profileTrustedDevices:[{hash:'a'.repeat(64),expiresAt:Date.now()+10000}],opdsAppPasswordHash:'b'.repeat(64),
        readerProgress:{book:{percent:0.4}}};
    const data = {version:4,users:[admin,reader],readerProgressCheckpoint:checkpoint,unrelated:{preserve:true}};
    const original = JSON.stringify(data);
    const journalBytes = checkpoint+'\n'+JSON.stringify(['reader','another',{generation:0,percent:0.7},'now'])+'\n';
    await fs.writeFile(file,original);
    await fs.writeFile(progress,journalBytes);
    const close = journal.startRustJournal(progress);
    try {
        const clear = authorize=>journal.writeProfileCredentials(file,progress,'reader',{profileTotp:null},authorize);
        await assert.rejects(clear(()=>{throw new Error('fixture authorization denied');}),/authorization denied/);
        assert.equal(await fs.readFile(file,'utf8'),original);
        let replacement;
        await assert.rejects(clear(async()=>{
            replacement = JSON.stringify({...data,newer:true});
            await fs.writeFile(file,replacement);
        }),/Файл профилей изменился/);
        assert.equal(await fs.readFile(file,'utf8'),replacement);

        assert.equal(await clear(()=>{}),true);
        const updated = JSON.parse(await fs.readFile(file,'utf8'));
        delete reader.profileTotp;
        delete reader.profileTrustedDevices;
        delete reader.opdsAppPasswordHash;
        assert.deepEqual(updated,{...data,newer:true});
        assert.equal(await fs.readFile(progress,'utf8'),journalBytes);
        console.log('ok native credential mutation, authorization, stale snapshot and journal continuity');
    } finally {await close();}
}

async function verifyAdminBootstrap(directory) {
    const ReadingListStore = require('../server/core/ReadingListStore');
    const password = require('../server/core/ProfilePassword');
    const storeFor = config=>{
        const store = new ReadingListStore(config);
        store.applyAdminBootstrap = ()=>assert.fail('native bootstrap used the Node fallback');
        return store;
    };

    const emptyDir = join(directory,'profile-bootstrap-empty');
    const empty = storeFor({dataDir:emptyDir,adminLogin:'Office.Admin'});
    const closeEmpty = journal.startRustJournal(empty.progressFile);
    try {
        let generated;
        empty.reportGeneratedAdminPassword = value=>{generated=value;};
        const snapshot = await empty.initialize();
        assert.match(generated,/^[A-Za-z0-9_-]{16}$/);
        assert.deepEqual(snapshot.users.map(user=>user.id),['admin','default']);
        assert.equal(snapshot.users[0].login,'office.admin');
        assert(await password.verify(snapshot.users[0].passwordHash,'office.admin',generated));
        const raw = await fs.readFile(empty.file,'utf8');
        assert.match(JSON.parse(raw).readerProgressCheckpoint,/^[a-f0-9]{32}$/);
        assert(!raw.includes(generated));

        const unchanged = storeFor({dataDir:emptyDir,adminLogin:'other-admin',adminPassword:'other-password'});
        unchanged.reportGeneratedAdminPassword = ()=>assert.fail('healthy store generated a new password');
        const stamp = await journal.stamp(empty.file);
        assert.deepEqual(await unchanged.initialize(),snapshot);
        assert.equal(await journal.stamp(empty.file),stamp);
    } finally {await closeEmpty();}

    const dataDir = join(directory,'profile-bootstrap-existing');
    await fs.mkdir(dataDir);
    const old = storeFor({dataDir,adminLogin:'old-admin',adminPassword:'fixture-old'});
    const reader = {id:'reader-id',name:'Reader',login:'reader',passwordHash:'existing'};
    const lists = [{id:'implicit',name:'Implicit owner'},{id:'unknown',name:'Unknown owner',userId:'admin'}];
    const journalBytes = checkpoint+'\n'+JSON.stringify([reader.id,'book',{generation:0,percent:0.7},'now'])+'\n';
    const raw = {version:4,users:[reader],lists,readerProgressCheckpoint:checkpoint,unrelated:{preserve:true}};
    await fs.writeFile(old.file,JSON.stringify(raw));
    await fs.writeFile(old.progressFile,journalBytes);
    const close = journal.startRustJournal(old.progressFile);
    try {
        const added = await old.initialize();
        assert.deepEqual(added.users.map(user=>user.id),['admin',reader.id]);
        assert.deepEqual(added.lists.map(list=>list.userId),[reader.id,reader.id]);
        assert.equal(added.users[1].readerProgress.book.percent,0.7);
        let stored = JSON.parse(await fs.readFile(old.file,'utf8'));
        assert.deepEqual(stored.lists,lists.map(list=>({...list,userId:reader.id})));
        assert.deepEqual(stored.users[1],reader);
        assert(await password.verify(stored.users[0].passwordHash,'old-admin','fixture-old'));

        stored.users[0] = {...stored.users[0],id:'existing-admin',otpRequired:true,
            profileTotp:{secret:'enc:v1:fixture',lastStep:123,recoveryHashes:[]},
            profileTrustedDevices:[{hash:'a'.repeat(64),expiresAt:Date.now()+10000}],opdsAppPasswordHash:'b'.repeat(64)};
        stored.profileAuthPolicy = {otpRequired:true,trustedBrowsersEnabled:false,trustedBrowserDays:10};
        const beforeReset = JSON.stringify(stored);
        await fs.writeFile(old.file,beforeReset);
        const config = {dataDir,adminLogin:'reader',adminPassword:'fixture-new',resetAdminPassword:true};
        await assert.rejects(storeFor(config).initialize(),/already used by another profile/);
        assert.equal(await fs.readFile(old.file,'utf8'),beforeReset);

        config.adminLogin = 'new-admin';
        const reset = await storeFor(config).initialize();
        const admin = reset.users[0];
        assert.equal(admin.id,'existing-admin');
        assert.equal(admin.login,'new-admin');
        assert.equal(admin.opdsEnabled,false);
        assert.equal(config.resetAdminPassword,false);
        assert(await password.verify(admin.passwordHash,admin.login,'fixture-new'));
        assert.equal(await password.verify(admin.passwordHash,admin.login,'fixture-old'),false);
        const updated = JSON.parse(await fs.readFile(old.file,'utf8'));
        for (const field of ['profileTotp','profileTrustedDevices','otpRequired','opdsAppPasswordHash'])
            assert(!Object.hasOwn(updated.users[0],field));
        assert.deepEqual(updated.profileAuthPolicy,{...stored.profileAuthPolicy,otpRequired:false});
        assert.deepEqual(updated.users[1],reader);
        assert.deepEqual(updated.unrelated,raw.unrelated);
        assert.equal(updated.readerProgressCheckpoint,checkpoint);
        assert.equal(await fs.readFile(old.progressFile,'utf8'),journalBytes);
    } finally {await close();}

    const brokenDir = join(directory,'profile-bootstrap-broken');
    await fs.mkdir(brokenDir);
    const broken = new ReadingListStore({dataDir:brokenDir,adminPassword:'fixture-recovery'});
    const closeBroken = journal.startRustJournal(broken.progressFile);
    try {
        await fs.writeFile(broken.file,'{"broken":');
        assert.deepEqual((await broken.initialize()).users.map(user=>user.id),['admin','default']);
        const backup = (await fs.readdir(brokenDir)).find(name=>name.includes('.broken-')&&!name.endsWith('.error.txt'));
        assert.equal(await fs.readFile(join(brokenDir,backup),'utf8'),'{"broken":');
    } finally {await closeBroken();}
    console.log('ok native administrator bootstrap, password reset, legacy list owners and journal continuity');
}

async function verifyWrites(binary,directory) {
    const file=join(directory,'durable.log');
    const probe=spawnSync(binary,['progress-journal',file],{input:'{"id":1,"op":"probe"}\n',encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);
    assert.equal(JSON.parse(probe.stdout).result.state,'ready');
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    const close=journal.startRustJournal(file);
    try {
        const line=Buffer.from(JSON.stringify(['alpha','book',{generation:2,sectionId:'Глава 📖'},'now'])+'\n');
        const first=await journal.append(file,checkpoint,{stamp:null,offset:0},line);
        assert.equal(first.stamp,await journal.stamp(file));
        await fs.appendFile(file,'["partial');
        await assert.rejects(journal.append(file,checkpoint,first,line),/changed/);
        const recovered=await journal.replay(file,checkpoint,users(),await journal.stamp(file));
        const second=await journal.append(file,checkpoint,recovered,line);
        assert.equal(second.stamp,await journal.stamp(file));
        assert.deepEqual(await fs.readFile(file),Buffer.concat([Buffer.from(checkpoint+'\n'),line,line]));

        const replacement=join(directory,'replacement.log');
        await fs.copyFile(file,replacement);
        await fs.rename(replacement,file);
        await assert.rejects(journal.append(file,checkpoint,second,line),/changed/);
        assert.equal((await fs.stat(file)).size,second.offset);
    } finally {await close();}
}

async function verifySnapshots(binary,directory) {
    const file=join(directory,'reading-lists.json'), progressFile=join(directory,'profile-progress.log');
    const probe=spawnSync(binary,['progress-journal',progressFile],{input:'{"id":1,"op":"probe"}\n',encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);
    assert.equal(JSON.parse(probe.stdout).result.snapshots,true);
    const close=journal.startRustJournal(progressFile);
    try {
        const large=JSON.stringify({users:[{id:'alpha',notes:'Пример 📖'.repeat(36_000)}]},null,2);
        assert(Buffer.byteLength(large)>256*1024);
        await journal.writeSnapshot(file,progressFile,large);
        assert.equal(await fs.readFile(file,'utf8'),large);
        await journal.writeSnapshot(file,progressFile,'{"users":[]}');
        assert.equal(await fs.readFile(file,'utf8'),'{"users":[]}');
    } finally {await close();}

    const {RustLookupIndex}=require('../server/core/RustLookupIndex');
    const driver=new RustLookupIndex(directory,null,{file:progressFile,binary,generation:'test',command:'progress-journal'});
    try {
        await driver.run(async process=>{
            const send=(action,payload={})=>process.query({op:'snapshot',action,...payload});
            const before=await journal.stamp(file);
            const prepared=Buffer.from('{"users":[{"id":"alpha"}]}');
            const staged=await send('begin',{expected:before,size:prepared.length});
            assert.equal(staged.state,'staged');
            await fs.writeFile(join(directory,staged.name),prepared,{flag:'r+'});
            const substitute=join(directory,'new-profile-state.json');
            await fs.writeFile(substitute,'{"users":[{"id":"externally-restored"}]}');
            await fs.rename(substitute,file);
            assert.equal((await send('finish')).state,'changed');
            assert.equal(await fs.readFile(file,'utf8'),'{"users":[{"id":"externally-restored"}]}');
            const current=await journal.stamp(file);
            assert.equal((await send('begin',{expected:current,size:prepared.length})).state,'staged');
            await assert.rejects(send('finish'),/incomplete/);
            assert.equal(await journal.stamp(file),current);
            assert(!(await fs.readdir(directory)).some(name=>name.startsWith('.reading-lists.')));
        },()=>{throw new Error(driver.lastError || 'Profile snapshot test could not start');});
    } finally {await driver.close();}
}

async function verifyBackup(binary, directory) {
    const dataDir = join(directory, 'native-restore');
    const configFile = join(directory, 'custom-config.json');
    const config = {dataDir, configFile};
    const files = backup.targets(config);
    const folder = join(dataDir, '.restore-transaction');
    const manifest = join(folder, 'manifest.json');
    const close = journal.startRustJournal(join(dataDir, journal.fileName));
    try {
        await fs.mkdir(folder, {recursive: true});
        await fs.writeFile(join(folder, 'config.json'), 'original');
        await fs.writeFile(configFile, 'interrupted');
        await fs.writeFile(files['secret.key'], 'interrupted');
        const original = {state:'prepared', files:['config.json','secret.key'], existed:{'config.json':true,'secret.key':false}};
        await fs.writeFile(manifest, JSON.stringify({...original, files:['config.json','config.json']}));
        await assert.rejects(backup.recover(config), /Invalid backup recovery journal/);
        assert.equal(await fs.readFile(configFile, 'utf8'), 'interrupted');
        await fs.writeFile(manifest, JSON.stringify(original));
        await backup.recover(config);
        assert.equal(await fs.readFile(configFile, 'utf8'), 'original');
        await assert.rejects(fs.stat(files['secret.key']), {code:'ENOENT'});
        await assert.rejects(fs.stat(folder), {code:'ENOENT'});

        const probe = spawnSync(binary, ['progress-journal', join(dataDir, journal.fileName)], {
            input: '{"id":1,"op":"probe"}\n', encoding: 'utf8',
        });
        assert.equal(probe.status, 0, probe.stderr);
        assert.equal(JSON.parse(probe.stdout).result.backups, true);
        const bytes = Buffer.from([0,255,0,102,17,42]);
        await backup.commit(config, {'config.json':'restored','secret.key':bytes});
        assert.equal(await fs.readFile(configFile, 'utf8'), 'restored');
        assert.deepEqual(await fs.readFile(files['secret.key']), bytes);
        await assert.rejects(fs.stat(folder), {code:'ENOENT'});
    } finally {await close();}
}

async function benchmark(binary,directory) {
    const file = join(directory,journal.fileName);
    const lines = [];
    let bytes = checkpoint.length+1;
    for (let index=0;;index++) {
        const line = JSON.stringify(['alpha','book-'+index%128,{generation:2,revision:index,percent:.3,pageIndex:index,
            updatedAt:'2026-11-16T00:00:00.000Z',sectionId:'Глава '+index%32},'2026-11-16T00:00:00.000Z'])+'\n';
        const size=Buffer.byteLength(line);
        if (bytes+size>journal.maxBytes) break;
        bytes+=size;
        lines.push(line);
    }
    await fs.writeFile(file,checkpoint+'\n'+lines.join(''));
    const stamp = await journal.stamp(file);
    const run = async rust=>{
        if (rust) process.env.INPX_RUST_CATALOG_BINARY=binary;
        else delete process.env.INPX_RUST_CATALOG_BINARY;
        const data=users(), started=performance.now();
        await journal.replay(file,checkpoint,data,stamp);
        return [performance.now()-started,data];
    };
    const cold = [await run(false),await run(true)];
    assert.deepEqual(cold[1][1],cold[0][1]);
    const samples=[[],[]];
    for (let round=0;round<21;round++) for (const index of round%2 ? [1,0] : [0,1]) {
        const [ms,data] = await run(!!index);
        assert.deepEqual(data,cold[index][1]);
        samples[index].push(ms);
    }
    console.log(JSON.stringify({stage:'journal-replay',bytes,records:lines.length,books:128,
        beforeMs:median(samples[0]),afterMs:median(samples[1]),firstBeforeMs:median([cold[0][0]]),firstAfterMs:median([cold[1][0]])}));
    await benchmarkWrites(binary,directory);
    await benchmarkProfileUpdates(binary,directory);
    await benchmarkSnapshots(binary,directory);
    await benchmarkBackups(binary,directory);
}

async function benchmarkWrites(binary,directory) {
    const files=['before','after'].map(name=>join(directory,name+'.log'));
    const states=files.map(()=>({stamp:null,offset:0}));
    const samples=[[],[]];
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    const close=journal.startRustJournal(files[1]);
    try {
        for(let round=0;round<121;round++) {
            const line=Buffer.from(JSON.stringify(['alpha','book',{generation:2,pageIndex:round,
                percent:round/120,sectionId:'Глава 📖',textSnippet:'Тестовая позиция чтения '.repeat(8)},'2026-11-16T00:00:00Z'])+'\n');
            for(const index of round%2 ? [1,0] : [0,1]) {
                if (index) process.env.INPX_RUST_CATALOG_BINARY=binary;
                else delete process.env.INPX_RUST_CATALOG_BINARY;
                const start=performance.now();
                states[index]=await journal.append(files[index],checkpoint,states[index],line);
                if (round) samples[index].push(performance.now()-start);
            }
        }
        assert.deepEqual(await fs.readFile(files[1]),await fs.readFile(files[0]));
        console.log(JSON.stringify({stage:'durable-journal-append',records:121,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
    } finally {await close();}
}

async function benchmarkProfileUpdates(binary,directory) {
    await new (require('../server/core/AppLogger'))().init({dataDir:directory,loggingEnabled:false});
    const ReadingListStore=require('../server/core/ReadingListStore');
    const stores=['profile-before','profile-after'].map(name=>new ReadingListStore({
        dataDir:join(directory,name),adminPassword:'progress-benchmark',
    }));
    const samples=[[],[]];
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    const close=journal.startRustJournal(stores[1].progressFile);
    try {
        for (const store of stores) await store.loadSnapshot();
        for (let round=0;round<121;round++) {
            const patch={sectionId:'Глава 📖',pageIndex:round,percent:round/120,baseRevision:round,
                updatedAt:'2026-11-16T00:00:00.000Z'};
            const results=[];
            for (const index of round%2 ? [1,0] : [0,1]) {
                if (index) process.env.INPX_RUST_CATALOG_BINARY=binary;
                else delete process.env.INPX_RUST_CATALOG_BINARY;
                const start=performance.now();
                results[index]=await stores[index].updateReaderProgress('admin','book',patch);
                if (round) samples[index].push(performance.now()-start);
            }
            assert.deepEqual(results[1],results[0]);
            assert.equal(results[1].revision,round+1);
        }
        console.log(JSON.stringify({stage:'profile-progress-update',records:121,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
    } finally {await close();}
}

async function benchmarkSnapshots(binary,directory) {
    const folders=await Promise.all(['snapshot-before','snapshot-after'].map(async name=>{
        const folder=join(directory,name);
        await fs.mkdir(folder);
        return folder;
    }));
    const files=folders.map(folder=>[join(folder,'reading-lists.json'),join(folder,journal.fileName)]);
    process.env.INPX_RUST_CATALOG_BINARY=binary;
    const close=journal.startRustJournal(files[1][1]);
    try {
        for (const repeats of [1_000,90_000]) {
            const samples=[[],[]];
            for(let round=0;round<22;round++) {
                const text=JSON.stringify({users:[{id:'profile',generation:round,notes:'Глава 📖 '.repeat(repeats)}]},null,2);
                for (const index of round%2 ? [1,0] : [0,1]) {
                    if(index) process.env.INPX_RUST_CATALOG_BINARY=binary;
                    else delete process.env.INPX_RUST_CATALOG_BINARY;
                    const start=performance.now();
                    await journal.writeSnapshot(...files[index],text);
                    if(round) samples[index].push(performance.now()-start);
                }
            }
            const data=await fs.readFile(files[1][0]);
            assert.deepEqual(data,await fs.readFile(files[0][0]));
            console.log(JSON.stringify({stage:'profile-snapshot-write',bytes:data.length,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
        }
    } finally {await close();}
}

async function benchmarkBackups(binary, directory) {
    const configs = await Promise.all(['restore-before','restore-after'].map(async name => {
        const dataDir = join(directory, name);
        await fs.mkdir(dataDir);
        return {dataDir, configFile:join(dataDir,'config.json')};
    }));
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    const close = journal.startRustJournal(join(configs[1].dataDir, journal.fileName));
    try {
        for (const size of [16*1024, 2*1024*1024]) {
            const samples = [[], []];
            for (let round = 0; round < 15; round++) {
                const content = {
                    'config.json': JSON.stringify({loggingEnabled:!!(round%2)}),
                    'secret.key': Buffer.from('fixture-secret'),
                    'reading-lists.json': JSON.stringify({users:[{id:'reader', notes:'x'.repeat(size)}]}),
                };
                for (const index of round%2 ? [1,0] : [0,1]) {
                    if (index) process.env.INPX_RUST_CATALOG_BINARY = binary;
                    else delete process.env.INPX_RUST_CATALOG_BINARY;
                    const start = performance.now();
                    await backup.commit(configs[index], content);
                    if (round) samples[index].push(performance.now()-start);
                }
            }
            const files = configs.map(backup.targets);
            for (const name of ['config.json','secret.key','reading-lists.json'])
                assert.deepEqual(await fs.readFile(files[0][name]), await fs.readFile(files[1][name]));
            console.log(JSON.stringify({stage:'backup-restore',profileNotesBytes:size,
                beforeMs:median(samples[0]),afterMs:median(samples[1])}));
        }
    } finally {await close();}
}

async function main(binary,mode) {
    if (!binary) throw new Error('Usage: node scripts/rust-progress-journal-tests.js <catalog-binary> [benchmark]');
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-progress-'));
    try {await (mode==='benchmark' ? benchmark : verify)(resolve(binary),directory);}
    finally {await fs.rm(directory,{recursive:true,force:true});}
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
