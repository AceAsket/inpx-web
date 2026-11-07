const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Store = require('../server/core/ReadingListStore');
const {ReaderAssets, register, maximumImageBytes} = require('../server/core/ReaderAssets');

const background = bytes => 'data:image/png;base64,' + Buffer.alloc(bytes, 7).toString('base64');
async function fixture(work) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-rc13-profile-'));
    try {
        const config = {dataDir:directory, adminPassword:'fixture-password',rootPathStatic:'/prefix',allowAnonymousAccess:true};
        const store = new Store(config);
        await work(store, config);
    } finally {await fs.remove(directory);}
}

async function testRc13InlineBackgroundMigrationAndPortableExport() {
    await fixture(async(store, config) => {
        const data = store.makeDefaultData(), image = background(1024 * 1024);
        data.users[0].readerPreferences.backgroundImage = image;
        data.users[0].readerPreferences.einkProfile.backgroundImage = image;
        await fs.outputJson(store.file, data);
        const user = await store.getUser('default');
        assert.match(user.readerPreferences.backgroundImage, /^\/prefix\/reader-background\/default\/[a-f0-9]{64}\.png$/);
        assert.equal((await fs.readdir(store.assets.directory)).length, 1, 'Same profile image is deduplicated');
        assert((await fs.stat(store.file)).size < 20000, 'Ordinary state no longer contains image bytes');
        const portable = await store.exportData('default');
        assert.equal(portable.user.readerPreferences.backgroundImage, image);
        const snapshot = await store.exportSnapshot();
        assert.equal(snapshot.users.find(row=>row.id==='default').readerPreferences.einkProfile.backgroundImage, image);
        // Restore a portable backup in a new data directory without copying asset files.
        const restoredDir = path.join(config.dataDir, 'restored'); await fs.ensureDir(restoredDir);
        const restored = new Store({...config,dataDir:restoredDir});
        await fs.outputJson(restored.file, snapshot);
        assert.equal((await restored.exportData('default')).user.readerPreferences.backgroundImage, image);
        assert((await fs.stat(restored.file)).size < 20000);
    });
}

async function testRc13ProgressDoesNotReadBackgroundsAndCopiesAreIsolated() {
    await fixture(async(store, config) => {
        const first = await store.getUsers();
        assert(first.users.some(user => user.isAdmin && user.login && user.passwordHash), 'A fresh store must bootstrap admin before returning a cached snapshot');
        const updated = await store.updateReaderPreferences('default', {backgroundImage:background(maximumImageBytes)});
        assert.match(updated.backgroundImage, /reader-background/);
        const read = fs.readFile;
        const imageReads = [];
        fs.readFile = function(file, ...args) {
            if (String(file).includes('reader-backgrounds')) imageReads.push(file);
            return read.call(this,file,...args);
        };
        try {
            for (let i=0;i<3;i++) await store.updateReaderProgress('default','book',{percent:i/10});
            const user = await store.getUser('default');
            user.readerProgress.book.percent = 1;
            assert.equal((await store.getReaderState('default','book')).progress.percent,.2);
            const reopened = new Store(config);
            assert.equal((await reopened.getReaderState('default','book')).progress.percent,.2);
        } finally {fs.readFile = read;}
        assert.equal(imageReads.length,0, 'Reading/saving position must not load image bytes');
        assert((await fs.stat(store.file)).size < 20000);
    });
}

async function testRc13BackgroundLimitAndLegacySvgCompatibility() {
    await fixture(async store => {
        await store.getUsers();
        await assert.rejects(store.updateReaderPreferences('default',{backgroundImage:background(maximumImageBytes+1)}), /размер|МиБ/);
        assert.equal((await store.getUser('default')).readerPreferences.backgroundImage,'');
        const legacy = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
        await store.updateReaderPreferences('default',{backgroundImage:legacy});
        assert.equal((await store.getUser('default')).readerPreferences.backgroundImage,legacy,'Legacy SVG stays inline and is never served as active same-origin content');
    });
}

async function testRc13BackgroundHttpProfileIsolation() {
    await fixture(async(store, config) => {
        await store.getUsers();
        const alice = await store.createUser({name:'Alice'}), bob = await store.createUser({name:'Bob'});
        const image = background(100);
        const preferences = await store.updateReaderPreferences(alice.id,{backgroundImage:image});
        const app = express();
        const worker = {readingListStore:store,getProfileSessionUser:token=>token==='alice-token'?alice.id:token==='bob-token'?bob.id:''};
        register(app,config,worker,{getSession:req=>req.headers.cookie==='session=alice'?{profileAccessToken:'alice-token'}:null});
        const server = http.createServer(app);
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const url = `http://127.0.0.1:${server.address().port}${preferences.backgroundImage}`;
        try {
            assert.equal((await fetch(url)).status,401);
            assert.equal((await fetch(url+'?access=expired-token')).status,401);
            assert.equal((await fetch(url+'?access=bob-token')).status,403);
            assert.equal((await fetch(url,{headers:{cookie:'session=alice'}})).status,200);
            const response = await fetch(url+'?access=alice-token');
            assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
            assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(image.split(',')[1],'base64'));
        } finally {await new Promise(resolve=>server.close(resolve));}
    });
}

async function testRc13ProtectedDefaultBackgroundNeedsAuthentication() {
    await fixture(async(store, config) => {
        const data = store.makeDefaultData();
        data.users[0].passwordHash = 'protected-legacy-profile';
        data.users[0].readerPreferences.backgroundImage = background(100);
        await store.save(data);
        const user = await store.getUser('default');
        let handler, status = 200, served = false;
        register({get(_route, callback) {handler = callback;}}, config,
            {readingListStore:store, getProfileSessionUser:()=>''}, {getSession:()=>null});
        await handler({query:{}, params:{userId:'default', name:path.basename(user.readerPreferences.backgroundImage)}},
            {sendStatus(value) {status=value;}, set() {return this;}, type() {return this;}, sendFile() {served=true;}},
            error => {throw error;});
        assert.equal(status,401); assert.equal(served,false);
    });
}

async function testRc13BackgroundCleanupExpiresWithoutReferenceChangesAndRetries() {
    await fixture(async(store, config) => {
        const assets = new ReaderAssets(config);
        const file = path.join(assets.directory, 'a'.repeat(64)+'-'+'b'.repeat(64)+'.png');
        await fs.outputFile(file,'orphan');
        await assets.prune({users:[]}); assert(await fs.pathExists(file));
        const now = Date.now;
        Date.now = () => now()+2*86400000;
        const remove = fs.remove;
        try {
            fs.remove = async candidate => {if(candidate===file) throw Object.assign(new Error('fixture busy'),{code:'EBUSY'}); return remove(candidate);};
            await assert.rejects(assets.prune({users:[]}),/fixture busy/);
            fs.remove = remove;
            await assets.prune({users:[]}); assert.equal(await fs.pathExists(file),false,'Retry cleanup even with unchanged preferences');
        } finally {Date.now=now; fs.remove=remove;}
        const lstat=fs.lstat, readdir=fs.readdir;
        let scanned=false;
        fs.lstat = async candidate => candidate===assets.directory ? {isDirectory:()=>true,isSymbolicLink:()=>true} : lstat(candidate);
        fs.readdir = async candidate => {if(candidate===assets.directory) scanned=true; return readdir(candidate);};
        try {
            assets.lastReferences=undefined;
            await assert.rejects(assets.prune({users:[]}),/Небезопасный каталог/);
            assert.equal(scanned,false,'Never enumerate a symlink target during cleanup');
        } finally {fs.lstat=lstat;fs.readdir=readdir;}
    });
}

async function testRc13RootMigrationAndUpgradeSnapshotKeepBackgrounds() {
    await fixture(async(store, config) => {
        await store.getUsers();
        const image=background(1024);
        await store.updateReaderPreferences('default',{backgroundImage:image});
        const moved=new Store({...config,rootPathStatic:'/moved'});
        const user=await moved.getUser('default');
        assert.match(user.readerPreferences.backgroundImage,/^\/moved\/reader-background\/default\//);
        assert.equal((await moved.exportData('default')).user.readerPreferences.backgroundImage,image);
        assert.equal((await fs.readdir(moved.assets.directory)).length,1,'Moving the URL root must reuse image bytes');
        const snapshot=await require('../server/core/UpgradeSnapshot').prepare({...config,version:'rc13-background-test'});
        const names=await fs.readdir(path.join(snapshot,'reader-backgrounds'));
        assert.equal(names.length,1);
        assert.deepEqual(await fs.readFile(path.join(snapshot,'reader-backgrounds',names[0])),Buffer.from(image.split(',')[1],'base64'));
    });
}

async function testRc13FullBackupRestoresAllProfileImagesOnAnotherServer() {
    await fixture(async(store, config) => {
        require('../server/core/Logger');
        const logger=new (require('../server/core/AppLogger'))();
        if(!logger.inited) await logger.init({loggingEnabled:false,name:'rc13-portable-backup'});
        const WebWorker=require('../server/core/WebWorker');
        await store.getUsers();
        const alice=await store.createUser({name:'Alice backup'});
        const regular=background(128), eink=background(256), personal=background(512);
        await store.updateReaderPreferences('default',{backgroundImage:regular,einkProfile:{backgroundImage:eink}});
        await store.updateReaderPreferences(alice.id,{backgroundImage:personal});
        const makeWorker=(workerConfig,readingListStore)=>{
            const worker=Object.create(WebWorker.prototype);
            Object.assign(worker,{config:{name:'inpx-web',version:'rc13-test',...workerConfig},readingListStore,
                checkMyState:()=>{},requireAdmin:async()=>true,profileSessions:new Map(),addAdminEvent:()=>{}});
            return worker;
        };
        const source=makeWorker(config,store);
        const backup=await source.writeAdminBackupSnapshot();
        const file=path.join(config.dataDir,'backups',backup.fileName);
        const reader=new (require('node-stream-zip').async)({file});
        let snapshot;
        try {snapshot=JSON.parse((await reader.entryData('reading-lists.json')).toString());} finally {await reader.close();}
        assert.equal(snapshot.users.find(user=>user.id===alice.id).readerPreferences.backgroundImage,personal);
        assert.equal(snapshot.users.find(user=>user.id==='default').readerPreferences.einkProfile.backgroundImage,eink);
        assert.match((await store.getUser(alice.id)).readerPreferences.backgroundImage,/^\/prefix\/reader-background\//,'Export must not mutate live cached state');
        const restoredConfig={...config,dataDir:path.join(config.dataDir,'restored-full'),rootPathStatic:'/another',tempDir:path.join(config.dataDir,'restore-tmp')};
        restoredConfig.configFile=path.join(restoredConfig.dataDir,'config.json');
        await fs.ensureDir(restoredConfig.dataDir);
        const restoredStore=new Store(restoredConfig), restored=makeWorker(restoredConfig,restoredStore);
        const result=await restored.importAdminBackupSnapshot('admin','fixture-token',{contentBase64:(await fs.readFile(file)).toString('base64')});
        assert(result.success);
        assert.match((await restoredStore.getUser(alice.id)).readerPreferences.backgroundImage,/^\/another\/reader-background\//);
        assert.equal((await restoredStore.exportData(alice.id)).user.readerPreferences.backgroundImage,personal);
        const defaults=(await restoredStore.exportData('default')).user.readerPreferences;
        assert.equal(defaults.backgroundImage,regular);assert.equal(defaults.einkProfile.backgroundImage,eink);
        const bob=await restoredStore.createUser({name:'Bob imported'});
        await restoredStore.importData(bob.id,await store.exportData(alice.id));
        assert.equal((await restoredStore.exportData(bob.id)).user.readerPreferences.backgroundImage,personal,'Profile import must rebind bytes to the destination user');
    });
}

module.exports = [testRc13InlineBackgroundMigrationAndPortableExport,
    testRc13ProgressDoesNotReadBackgroundsAndCopiesAreIsolated,
    testRc13BackgroundLimitAndLegacySvgCompatibility,testRc13BackgroundHttpProfileIsolation,
    testRc13ProtectedDefaultBackgroundNeedsAuthentication,testRc13BackgroundCleanupExpiresWithoutReferenceChangesAndRetries,
    testRc13RootMigrationAndUpgradeSnapshotKeepBackgrounds,testRc13FullBackupRestoresAllProfileImagesOnAnotherServer];
if (require.main === module) (async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
