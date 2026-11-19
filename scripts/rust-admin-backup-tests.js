const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');
const {setTimeout:sleep} = require('node:timers/promises');
const {connect, signIn, waitFor} = require('./rust-events-tests');
const {createFixture} = require('./binary-smoke-test');
const {hotp} = require('../server/core/ProfileTotp');

const root = '/reader';
const sourcePassword = 'backup-source-admin';
const targetPassword = 'backup-target-admin';
const readerPassword = 'backup-test-reader';
const archivePassword = 'Пароль архива 2026 🔐';
const opdsPassword = 'backup-opds-secret';
const bookTitle = 'Packaged smoke book';
const shelfName = 'Полка из резервной копии';
const note = 'Закладка из резервной копии';
const background = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const olderCopy = 'inpx-web-auto-backup-2020-01-01T00-00-00-000Z-12345678.zip.enc';

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function action(client, identity) {
    return async (name, fields = {}) => {
        const result = await client.send(name,{...identity,...fields});
        assert.equal(result.error || '', '', name+': '+result.error);
        return result;
    };
}

function code(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret, letter => alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte,2)));
    return hotp(key,Math.floor(Date.now()/30000)-1);
}

async function fixture(directory) {
    const library = path.join(directory,'library');
    const source = path.join(directory,'source');
    const backups = path.join(source,'backups');
    await createFixture(library);
    await fs.mkdir(backups,{recursive:true});
    await fs.writeFile(path.join(backups,olderCopy),'disposable retention fixture');
    await fs.writeFile(path.join(source,'config.json'),JSON.stringify({
        dataDir:'/source-data', tempDir:'/source-data/tmp', logDir:'/source-data/log',
        server:{host:'0.0.0.0',port:12380,root},
        librarySources:[{id:'main',name:'Каталог из архива',type:'inpx',libDir:'/library',inpx:'/library/smoke.inpx'}],
        uiDefaults:{limit:47},
    }));
}

async function readyBook(send) {
    const books = await waitFor(() => send('bookSearch',{query:{title:'='+bookTitle}}),
        result => result.totalFound>0, 'Fixture catalogue did not open');
    return books.found[0]._uid;
}

async function crossCheck(directory, bytes, uid, info) {
    const legacyRoot = path.resolve(process.env.INPX_RC15_SOURCE || 'tmp/reader-rc15-source');
    const archive = require(path.join(legacyRoot,'server/core/BackupArchive'));
    const folder = path.join(directory,'legacy-interop');
    await fs.mkdir(folder,{recursive:true});
    const files = await archive.read({contentBase64:bytes.toString('base64'),password:archivePassword},{},folder);
    const profiles = files['reading-lists.json'];
    assert.equal(profiles.users.find(user=>user.id===info.readerId).readerProgress[uid].percent,0.74);
    assert.equal(profiles.users.find(user=>user.id===info.readerId).readerPreferences.backgroundImage,background);
    assert(profiles.users.every(user=>user.profileTrustedDevices===undefined));
    assert.equal(files['config.json'].dataDir,'/source-data');
    assert.match(files['config.json'].opds.password,/^enc:v1:/);
    assert.match(files['backup-vault.json'].key,/^enc:v1:/);

    const logger = new (require(path.join(legacyRoot,'server/core/AppLogger')))();
    if (!logger.inited) await logger.init({loggingEnabled:false,name:'rust-admin-backup-tests'});
    const Worker = require(path.join(legacyRoot,'server/core/WebWorker'));
    const worker = Object.create(Worker.prototype);
    worker.config = {dataDir:folder,configFile:path.join(folder,'config.json'),name:'inpx-web',version:'1.8.3-rc.15'};
    worker.readingListStore = {file:path.join(folder,'reading-lists.json'),exportSnapshot:async()=>profiles};
    await fs.writeFile(worker.config.configFile,JSON.stringify(files['config.json']));
    await fs.writeFile(worker.readingListStore.file,JSON.stringify(profiles));
    await fs.writeFile(path.join(folder,'secret.key'),files['secret.key']);
    await fs.writeFile(path.join(folder,'discovery-cache.json'),JSON.stringify({fixture:randomBytes(1200000).toString('base64')}));
    const copy = await worker.writeAdminBackupSnapshot();
    const legacyBytes = await fs.readFile(path.join(folder,'backups',copy.fileName));
    assert(legacyBytes.length>1024*1024);
    await fs.writeFile(path.join(directory,'rc15.zip'),legacyBytes);
}

async function create(base, directory) {
    const admin = await connect(base,root);
    const reader = await connect(base,root);
    try {
        const adminIdentity = await signIn(admin,'admin',sourcePassword);
        const send = action(admin,adminIdentity);
        const vault = (operation, options) => send('admin-backup-vault',{operation,options});
        const uid = await readyBook(send);
        const profile = await send('create-user-profile',{profile:{login:'archive-reader',name:'Читатель из архива',password:readerPassword}});
        const readerIdentity = await signIn(reader,'archive-reader',readerPassword);
        const read = action(reader,readerIdentity);
        const shelf = (await read('create-reading-list',{name:shelfName})).list;
        await read('update-reading-list-book',{listId:shelf.id,bookUid:uid,enabled:true});
        await read('add-reader-bookmark',{bookUid:uid,bookmark:{title:note,percent:0.31}});
        await read('update-reader-preferences',{preferences:{backgroundImage:background}});
        const start = await read('profile-totp',{operation:'start',payload:{password:readerPassword}});
        const enabled = await read('profile-totp',{operation:'enable',payload:{password:readerPassword,code:code(start.secret)}});
        assert.equal(enabled.otpEnabled,true);
        const old = await read('get-reader-state',{bookUid:uid});
        const updated = await read('update-reader-progress',{bookUid:uid,progress:{
            percent:0.74,sectionId:'archived-section',baseRevision:old.progress.revision,generation:old.progressGeneration,
        }});
        assert.equal(updated.progress.percent,0.74);
        await send('update-admin-opds',{opds:{enabled:true,root:'/archive-opds',user:'backup-opds',password:opdsPassword}});

        assert.match((await reader.send('admin-backup-vault',{...readerIdentity,operation:'status'})).error,/администратора/);
        assert.equal((await admin.send('create-admin-backup',{...adminIdentity,csrfToken:'bad'})).error,'bad_csrf_token');
        assert.match((await admin.send('admin-backup-vault',{...adminIdentity,operation:'update',options:{enabled:true}})).error,/задайте пароль/);
        const plain = await send('create-admin-backup');
        assert.equal(plain.encrypted,false);
        assert.match(plain.link,/^\/reader\/admin-backups\/.*\.zip$/);
        assert.equal((await fetch(base+plain.link)).status,401);
        assert.equal((await fetch(base+plain.link,{headers:{cookie:reader.cookie}})).status,403);
        const head = await fetch(base+plain.link,{method:'HEAD',headers:{cookie:admin.cookie}});
        assert.equal(head.status,200);
        assert.match(head.headers.get('cache-control'),/no-store/);
        assert.match(head.headers.get('content-disposition'),/attachment/);
        const range = await fetch(base+plain.link,{headers:{cookie:admin.cookie,range:'bytes=0-3'}});
        assert.equal(range.status,206);
        assert.equal(Buffer.from(await range.arrayBuffer()).toString('hex'),'504b0304');
        const plainPreview = await vault('preview',{name:plain.fileName});
        assert.equal(plainPreview.encrypted,false);
        assert.equal(plainPreview.progress,1);
        assert.equal(plainPreview.bookmarks,1);
        assert.equal(plainPreview.sources[0].name,'Каталог из архива');

        const policy = await vault('update',{password:archivePassword,enabled:true,hour:0,keep:1});
        assert(policy.passwordSet && policy.enabled);
        assert.equal(policy.keep,1);
        assert.equal(policy.key,undefined);
        assert.equal(policy.salt,undefined);
        assert.match((await admin.send('admin-backup-vault',{...adminIdentity,operation:'delete',options:{name:'../secret.key'}})).error,/имя/);
        const encrypted = await send('create-admin-backup');
        assert(encrypted.encrypted);
        const download = await fetch(base+encrypted.link,{headers:{cookie:admin.cookie}});
        assert.equal(download.status,200);
        const bytes = Buffer.from(await download.arrayBuffer());
        assert.equal(bytes.subarray(0,8).toString(),'INPXWEB1');
        assert.match((await admin.send('admin-backup-vault',{...adminIdentity,operation:'preview',
            options:{name:encrypted.fileName,password:'wrong archive password'}})).error,/Неверный пароль|повреждён/);
        const preview = await vault('preview',{name:encrypted.fileName,password:archivePassword});
        assert.equal(preview.fingerprint,digest(bytes));
        assert.equal(preview.lists>=1,true);
        assert(preview.files.some(file=>file.name==='backup-vault.json'));
        assert(preview.files.some(file=>file.name==='secret.key'));
        assert.match((await admin.send('admin-backup-vault',{...adminIdentity,operation:'restore',
            options:{name:encrypted.fileName,password:archivePassword,fingerprint:'0'.repeat(64)}})).error,/изменился/);
        const removed = await vault('delete',{name:plain.fileName});
        assert(!removed.backups.some(row=>row.name===plain.fileName));
        assert.equal((await fetch(base+plain.link,{headers:{cookie:admin.cookie}})).status,404);
        await fs.writeFile(path.join(directory,'portable.zip.enc'),bytes);
        const fixture = {uid,readerId:profile.user.id,recoveryCodes:enabled.recoveryCodes,encrypted};
        await fs.writeFile(path.join(directory,'expect.json'),JSON.stringify(fixture));
        await crossCheck(directory,bytes,uid,fixture);
        console.log('ok admin-only create, HTTP download, ZIP and encrypted preview, deletion, policy and RC15 reader/writer');
    } finally { admin.close(); reader.close(); }
}

async function restore(base,directory) {
    const admin = await connect(base);
    try {
        const identity = await signIn(admin,'admin',targetPassword);
        const send = action(admin,identity);
        const uid = await readyBook(send);
        assert.equal((await send('get-config')).uiDefaults.limit,20);
        const before = await send('get-reader-state',{bookUid:uid});
        assert.equal(before.progress.percent,0);
        const legacy = (await fs.readFile(path.join(directory,'rc15.zip'))).toString('base64');
        const legacyPreview = await send('preview-admin-backup',{data:{data:'data:application/zip;base64,'+legacy}});
        assert.equal(legacyPreview.version,'1.8.3-rc.15');
        assert(legacyPreview.files.some(row=>row.name==='discovery-cache.json'));
        const data = {contentBase64:(await fs.readFile(path.join(directory,'portable.zip.enc'))).toString('base64'),password:archivePassword};
        const preview = await send('preview-admin-backup',{data});
        assert(preview.encrypted && preview.restartRecommended);
        assert.equal(preview.progress,1);
        assert.equal(preview.bookmarks,1);
        assert.equal((await send('get-config')).uiDefaults.limit,20);
        const bad = await admin.send('import-admin-backup',{...identity,data:{...data,fingerprint:'wrong'}});
        assert.match(bad.error,/изменился/);
        const progress = await send('get-reader-state',{bookUid:uid});
        const old = await send('update-reader-progress',{bookUid:uid,progress:{
            percent:0.18,baseRevision:progress.progress.revision,generation:progress.progressGeneration,
        }});
        assert.equal(old.progress.percent,0.18);
        const restored = await send('import-admin-backup',{data:{...data,fingerprint:preview.fingerprint}});
        assert(restored.success && restored.restartRecommended);
        assert.deepEqual(restored.restored.sort(),['backup-vault.json','config.json','reading-lists.json','secret.key']);
        assert.equal((await admin.send('resume-user-profile',identity)).error,'need_profile_login');
        console.log('ok RC15 upload preview over 1 MiB, fingerprint, restore into clean volume and session invalidation');
    } finally { admin.close(); }
}

async function restored(base,directory) {
    const fixture = JSON.parse(await fs.readFile(path.join(directory,'expect.json'),'utf8'));
    const admin = await connect(base,root);
    const reader = await connect(base,root);
    try {
        const invalid = await admin.send('login-user-profile',{login:'admin',password:targetPassword});
        assert.equal(invalid.errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
        const send = action(admin,await signIn(admin,'admin',sourcePassword));
        const config = await send('get-config');
        assert.equal(config.uiDefaults.limit,47);
        assert.equal(config.adminLibrarySources[0].name,'Каталог из архива');
        assert.equal(config.adminOpds.root,'/archive-opds');
        const authorization = 'Basic '+Buffer.from('backup-opds:'+opdsPassword).toString('base64');
        const feed = await fetch(base+config.adminOpds.root,{headers:{authorization}});
        assert.equal(feed.status,200);
        assert.match(await feed.text(),/<feed/);
        const policy = await send('admin-backup-vault',{operation:'status'});
        assert(policy.enabled && policy.passwordSet);
        assert.equal(policy.keep,1);
        assert(!policy.backups.some(row=>row.name===fixture.encrypted.fileName));
        const old = await send('get-reader-state',{bookUid:fixture.uid});
        assert.equal(old.progress.percent,0);
        const challenge = await reader.send('login-user-profile',{login:'archive-reader',password:readerPassword});
        assert.equal(challenge.errorCode,'need_profile_otp');
        const identity = await reader.send('login-user-profile',{
            login:'archive-reader',password:readerPassword,otp:fixture.recoveryCodes[0],
        });
        assert.equal(identity.userId,fixture.readerId);
        assert(identity.profileAccessToken,identity.error);
        const read = action(reader,{userId:identity.userId,profileAccessToken:identity.profileAccessToken});
        const state = await read('get-reader-state',{bookUid:fixture.uid});
        assert.equal(state.progress.percent,0.74);
        assert.equal(state.progress.sectionId,'archived-section');
        assert(state.progressGeneration>0);
        assert.equal(state.bookmarks[0].title,note);
        const lists = await read('get-reading-lists',{bookUid:fixture.uid});
        assert(lists.lists.some(row=>row.name===shelfName && row.containsBook));
        const preferences = (await read('get-config')).currentUserProfile.readerPreferences;
        const image = await fetch(base+preferences.backgroundImage,{headers:{cookie:reader.cookie}});
        assert.equal(image.status,200);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(background.split(',')[1],'base64'));
        const next = await read('update-reader-progress',{bookUid:fixture.uid,progress:{
            percent:0.81,baseRevision:state.progress.revision,generation:state.progressGeneration,
        }});
        assert.equal(next.progress.percent,0.81);
        console.log('ok restored settings, protected OPDS, original credentials and 2FA, book list, position, bookmark and background after restart');
    } finally { admin.close(); reader.close(); }
}

async function scheduled(base,directory) {
    const fixture = JSON.parse(await fs.readFile(path.join(directory,'expect.json'),'utf8'));
    const admin = await connect(base,root);
    try {
        const send = action(admin,await signIn(admin,'admin',sourcePassword));
        const vault = (operation, options) => send('admin-backup-vault',{operation,options});
        const deadline = Date.now()+85000;
        let status;
        do {
            status = await vault('status');
            if (status.lastScheduledAt && !status.backups.some(row=>row.name===olderCopy)) break;
            await sleep(850);
        } while (Date.now()<deadline);
        assert(status.lastScheduledAt,status.lastError);
        const copies = status.backups.filter(row=>row.scheduled);
        assert.equal(copies.length,1);
        assert.notEqual(copies[0].name,olderCopy);
        assert(copies[0].encrypted);
        assert(status.backups.some(row=>row.name===fixture.encrypted.fileName));
        const preview = await vault('preview',{name:fixture.encrypted.fileName,password:archivePassword});
        const result = await vault('restore',{name:fixture.encrypted.fileName,password:archivePassword,fingerprint:preview.fingerprint});
        assert(result.success);
        const again = action(admin,await signIn(admin,'admin',sourcePassword));
        const cleared = await again('admin-backup-vault',{operation:'update',options:{clearPassword:true}});
        assert(!cleared.enabled && !cleared.passwordSet);
        assert.equal((await again('create-admin-backup')).encrypted,false);
        console.log('ok automatic scheduled copy, retention preserves manual copies, stored restore and clear password');
    } finally { admin.close(); }
}

const [mode, first, second] = process.argv.slice(2);
const operations = {fixture,create,restore,restored,scheduled};
if (require.main===module) operations[mode](first,second).catch(error=>{console.error(error);process.exitCode=1;});
