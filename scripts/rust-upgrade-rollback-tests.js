const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {hash} = require('node:crypto');
const {tmpdir} = require('node:os');
const {basename, dirname, join, resolve} = require('node:path');
const {connect, signIn} = require('./rust-events-tests');
const {docker, until, legacyRows, rustRows, initial, timing} = require('./rust-inpx-filter-tests');
const {version:targetVersion} = require('../package.json');
const {hotp} = require('../server/core/ProfileTotp');

const adminPassword = 'upgrade-fixture-admin';
const readerPassword = 'upgrade-fixture-reader';
const opdsPassword = 'upgrade-fixture-opds';
const login = 'release-rollback-reader';
const readerName = 'Читатель для проверки отката';
const shelfName = 'Полка до обновления';
const bookmark = 'Закладка до обновления';
const fields = ['id','_uid','folder','file','ext','author','title','series','lang','del','insno'];
const firstPosition = {percent:0.41,sectionId:'chapter-before-upgrade',textOffset:192};
const laterPosition = {percent:0.72,sectionId:'chapter-after-upgrade',textOffset:362};
const filter = {...initial,info:{collection:'RC15 release upgrade fixture',version:'before-upgrade'}};

const mount = (volume, target, readonly = false) =>
    'type=volume,source='+volume+',target='+target+(readonly?',readonly':'');
const bind = (directory, target, readonly = false) =>
    'type=bind,source='+directory+',target='+target+(readonly?',readonly':'');

function action(client, identity) {
    return async (name, payload) => {
        const result = await client.send(name,{...identity,...payload});
        assert.equal(result.error || '','',name+': '+result.error);
        return result;
    };
}

async function start(name, image, volume, source, extra = []) {
    const started = performance.now();
    await docker('run','-d','--name',name,'-p','127.0.0.1::12380',
        '--mount',mount(volume,'/data'),'--mount',bind(dirname(source),'/library',true),
        '-e','INPX_AUTH_MODE=local',
        '-e','INPX_REQUIRE_AUTH=false','-e','INPX_ALLOW_ANONYMOUS_ACCESS=true',image,
        '--data-dir=/data','--host=0.0.0.0','--port=12380','--lib-dir=/library',
        '--inpx=/library/'+basename(source),...extra);
    const origin = 'http://'+await docker('port',name,'12380/tcp');
    await until(async () => {
        try {
            const response = await fetch(origin+'/ready',{signal:AbortSignal.timeout(2500)});
            await response.body.cancel();
            return response.ok;
        } catch { return false; }
    },Boolean,name+' did not become ready',360);
    return {name,origin,seconds:Math.round((performance.now()-started)/100)/10};
}

async function clients(server, verify) {
    const admin = await connect(server.origin);
    try {
        const send = action(admin,await signIn(admin,'admin',adminPassword));
        const reader = await connect(server.origin);
        try { return await verify(send,reader); }
        finally { reader.close(); }
    } finally { admin.close(); }
}

async function catalogue(server, send, referenceDirectory) {
    const {dbConfig} = await send('get-config');
    assert.equal(dbConfig.inpxInfo.collection,filter.info.collection);
    assert.equal(dbConfig.inpxInfo.version,filter.info.version);
    const rows = referenceDirectory
        ? await legacyRows(server.name,referenceDirectory)
        : await rustRows(server.name,fields);
    assert(rows.length>0);
    assert.equal(dbConfig.stats.bookCount,rows.length);
    const records = rows.map(row=>JSON.stringify(fields.map(field=>row[field]??null))).sort();
    return {rows,records,indexHash:dbConfig.inpxHash};
}

async function setPosition(read, uid, position) {
    const old = await read('get-reader-state',{bookUid:uid});
    const {progress} = await read('update-reader-progress',{bookUid:uid,progress:{
        ...position,baseRevision:old.progress.revision,generation:old.progressGeneration,
    }});
    assert.equal(progress.percent,position.percent);
}

async function checkPosition(read, uid, position) {
    const state = await read('get-reader-state',{bookUid:uid});
    for (const [key,value] of Object.entries(position)) assert.equal(state.progress[key],value,key);
    assert(state.bookmarks.some(entry=>entry.title===bookmark));
    const {lists} = await read('get-reading-lists',{bookUid:uid});
    assert(lists.some(entry=>entry.name===shelfName && entry.containsBook));
}

function previousTotp(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret,letter=>alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte=>Number.parseInt(byte,2)));
    return hotp(key,Math.floor(Date.now()/30000)-1);
}

async function readerSession(reader, fixture, recoveryIndex) {
    const challenge = await reader.send('login-user-profile',{login,password:readerPassword});
    assert.equal(challenge.errorCode,'need_profile_otp');
    const identity = await reader.send('login-user-profile',{
        login,password:readerPassword,otp:fixture.recoveryCodes[recoveryIndex],
    });
    assert.equal(identity.userId,fixture.userId);
    assert(identity.profileAccessToken,identity.error);
    return action(reader,{userId:identity.userId,profileAccessToken:identity.profileAccessToken});
}

async function checkSettings(server, send, checkFeed = true) {
    const {adminOpds,uiDefaults} = await send('get-config');
    assert.equal(uiDefaults.limit,47);
    assert.equal(adminOpds.root,'/rollback-opds');
    if (checkFeed) {
        const authorization = 'Basic '+Buffer.from('rollback-feed:'+opdsPassword).toString('base64');
        const feed = await fetch(server.origin+adminOpds.root,{headers:{authorization}});
        assert.equal(feed.status,200);
        assert.match(await feed.text(),/<feed/);
    }
    const saved = JSON.parse(await docker('exec',server.name,'cat','/data/config.json'));
    assert.equal(saved.inpxFilterFile,'/data/filter.json');
    assert.match(saved.opds.password,/^enc:v1:/);
    const rules = await docker('exec',server.name,'cat','/data/filter.json');
    assert.equal(rules,JSON.stringify(filter));
}

function profiles(state) {
    return state.users.map(user=>({id:user.id,login:user.login,name:user.name,
        admin:!!user.isAdmin,blocked:!!user.blocked})).sort((left,right)=>left.id.localeCompare(right.id));
}

async function readProfiles(server) {
    return profiles(JSON.parse(await docker('exec',server.name,'cat','/data/reading-lists.json')));
}

async function main(rustImage, legacyImage, input, previousVolume) {
    assert(rustImage && legacyImage && input && previousVolume,
        'Usage: node scripts/rust-upgrade-rollback-tests.js <rust-image> <rc15-image> <library.inpx> <previous-test-volume|--ci-fixture>');
    const ciFixture = previousVolume === '--ci-fixture';
    const source = resolve(input);
    const checksum = hash('sha256',await fs.readFile(source));
    const scratch = await fs.mkdtemp(join(tmpdir(),'inpx-rollback-'));
    const prefix = 'inpx-rollback-'+process.pid;
    const [live,backup] = ['live','rc15-backup'].map(label=>prefix+'-'+label);
    const [legacyName,rustName,restartName,rollbackName] = ['rc15','rust','rust-restart','rolled-back'].map(label=>prefix+'-'+label);
    const helper = (mounts, command, ...args) => docker('run','--rm','--entrypoint','sh',
        ...mounts.flatMap(value=>['--mount',value]),legacyImage,'-ec',command,'fixture',...args);
    try {
        await docker('volume','create',live);
        await docker('volume','create',backup);
        if (ciFixture) await helper([mount(live,'/data')], "echo '{}' > /data/config.json");
        else {
            await docker('volume','inspect',previousVolume);
            await helper([mount(previousVolume,'/history',true),mount(live,'/data')],
                'cp -p /history/config.json /history/reading-lists.json /data; if test -f /history/secret.key; then cp -p /history/secret.key /data; fi');
        }
        const setup = `const fs=require('node:fs'); const p='/data/config.json';
            const c=JSON.parse(fs.readFileSync(p));Object.assign(c,{dataDir:'/data',inpxFilterFile:'/data/filter.json',
            allowUnsafeFilter:true,inpxCheckInterval:0,loggingEnabled:false,uiDefaults:{...c.uiDefaults,limit:47},
            server:{host:'0.0.0.0',port:'12380',root:''}});fs.writeFileSync(p,JSON.stringify(c));
            fs.writeFileSync('/data/filter.json',process.argv[1]);`;
        await docker('run','--rm','--mount',mount(live,'/data'),'node:24-bookworm-slim','node','-e',setup,JSON.stringify(filter));
        const legacy = await start(legacyName,legacyImage,live,source,
            ['--admin-password='+adminPassword,'--reset-admin-password']);
        const fixture = await clients(legacy,async (send,reader) => {
            await send('update-admin-opds',{opds:{enabled:true,root:'/rollback-opds',user:'rollback-feed',password:opdsPassword}});
            const {user} = await send('create-user-profile',{profile:{login,name:readerName,password:readerPassword}});
            const read = action(reader,await signIn(reader,login,readerPassword));
            const catalogueBefore = await catalogue(legacy,send,join(scratch,'before'));
            assert.equal(catalogueBefore.rows.length,ciFixture ? require('./rc15-ci-fixture').expected[0] : 367);
            const title = 'Мастер и Маргарита';
            const hit = await send('bookSearch',{query:{title:'='+title,del:'0',limit:1}});
            const uid = hit.found[0]._uid;
            assert(catalogueBefore.rows.some(row=>row._uid===uid));
            const {list} = await read('create-reading-list',{name:shelfName});
            await read('update-reading-list-book',{listId:list.id,bookUid:uid,enabled:true});
            await read('add-reader-bookmark',{bookUid:uid,bookmark:{title:bookmark,percent:0.23}});
            const {secret} = await read('profile-totp',{operation:'start',payload:{password:readerPassword}});
            const {otpEnabled,recoveryCodes} = await read('profile-totp',{operation:'enable',payload:{password:readerPassword,code:previousTotp(secret)}});
            assert(otpEnabled && recoveryCodes.length>=3);
            await setPosition(read,uid,firstPosition);
            await checkPosition(read,uid,firstPosition);
            // RC15 registers the new OPDS route on its next start.
            await checkSettings(legacy,send,false);
            return {uid,userId:user.id,recoveryCodes,catalogueBefore,profiles:await readProfiles(legacy)};
        });
        await docker('stop','--time','25',legacyName);
        await helper([mount(live,'/data',true),mount(backup,'/backup')],
            'test -d /data/db/book; cp -a /data/db /backup/db; cp -p /data/filter.json /backup/filter.json');
        console.log(JSON.stringify({stage:'rc15',readySeconds:legacy.seconds,sourceSha256:checksum,
            count:fixture.catalogueBefore.rows.length,profiles:fixture.profiles.length,position:firstPosition.percent}));

        await until(()=>docker('image','inspect',rustImage,'--format','{{.Id}}').catch(()=>''),Boolean,
            'Rust release image did not finish building',600);
        const rust = await start(rustName,rustImage,live,source);
        const {snapshot,version} = JSON.parse(await docker('exec',rustName,'cat','/data/.upgrade-version.json'));
        assert.equal(version,targetVersion);
        assert.equal(dirname(snapshot),'/data/.upgrade-backups');
        assert(basename(snapshot).endsWith('-'+version));
        const manifest = JSON.parse(await docker('exec',rustName,'cat',snapshot+'/manifest.json'));
        assert.equal(manifest.targetVersion,version);
        for (const entry of ['config.json','reading-lists.json','secret.key','public']) assert(manifest.files.includes(entry));
        const saved = JSON.parse(await docker('exec',rustName,'cat',snapshot+'/reading-lists.json'));
        assert.deepEqual(profiles(saved),fixture.profiles);
        assert.equal(saved.users.find(user=>user.id===fixture.userId).readerProgress[fixture.uid].percent,firstPosition.percent);
        const books = await clients(rust,async (send,reader) => {
            await checkSettings(rust,send);
            assert.deepEqual(await readProfiles(rust),fixture.profiles);
            const native = await catalogue(rust,send);
            assert.deepEqual(native.records,fixture.catalogueBefore.records);
            assert.equal(native.indexHash,fixture.catalogueBefore.indexHash);
            const read = await readerSession(reader,fixture,0);
            assert.equal((await read('get-config')).currentUserProfile.name,readerName);
            await checkPosition(read,fixture.uid,firstPosition);
            await setPosition(read,fixture.uid,laterPosition);
            return hash('sha256',native.records.join('\n'));
        });
        await docker('exec',rustName,'sh','-ec','test -f /data/db/catalogue.json; test ! -d /data/db/book');
        await docker('stop','--time','25',rustName);
        console.log(JSON.stringify({stage:'rust-upgrade',readySeconds:rust.seconds,booksSha256:books,position:firstPosition.percent}));

        const restart = await start(restartName,rustImage,live,source);
        await clients(restart,async (_,reader) => checkPosition(await readerSession(reader,fixture,1),fixture.uid,laterPosition));
        assert.equal(JSON.parse(await docker('exec',restartName,'cat','/data/.upgrade-version.json')).snapshot,snapshot);
        await docker('stop','--time','25',restartName);
        console.log(JSON.stringify({stage:'rust-restart',readySeconds:restart.seconds,position:laterPosition.percent}));

        const snapshotEntries = new Set(['config.json','secret.key','reading-lists.json','discovery-cache.json',
            'backup-vault.json','public','reader-backgrounds']);
        assert(manifest.files.every(entry=>snapshotEntries.has(entry)));
        await helper([mount(live,'/data'),mount(backup,'/backup',true)],`
            snapshot="$1"; shift
            mkdir /data/.rollback-newer
            for entry in db db.previous reader-progress.log .upgrade-version.json "$@"; do
                if test -e "/data/$entry"; then mv "/data/$entry" /data/.rollback-newer/; fi
            done
            for entry do cp -a "$snapshot/$entry" "/data/$entry"; done
            cp -a /backup/db /data/db
            cp -p /backup/filter.json /data/filter.json`,snapshot,...manifest.files);
        const rollback = await start(rollbackName,legacyImage,live,source);
        await clients(rollback,async (send,reader) => {
            await checkSettings(rollback,send);
            assert.deepEqual(await readProfiles(rollback),fixture.profiles);
            const restored = await catalogue(rollback,send,join(scratch,'restored'));
            assert.deepEqual(restored.records,fixture.catalogueBefore.records);
            assert.equal(restored.indexHash,fixture.catalogueBefore.indexHash);
            const read = await readerSession(reader,fixture,2);
            assert.equal((await read('get-config')).currentUserProfile.name,readerName);
            await checkPosition(read,fixture.uid,firstPosition);
        });
        assert.equal(hash('sha256',await fs.readFile(source)),checksum);
        console.log(JSON.stringify({stage:'rc15-rollback',readySeconds:rollback.seconds,booksSha256:books,position:firstPosition.percent}));
        await timing('First startup (RC15 index / Rust upgrade)',legacy.seconds,rust.seconds,'s');
        await timing('Existing index (restored RC15 / Rust restart)',rollback.seconds,restart.seconds,'s');
    } finally {
        for (const name of [legacyName,rustName,restartName,rollbackName]) {
            const logs = await docker('logs','--tail','50',name).catch(()=>null);
            if (logs) await fs.writeFile(join(tmpdir(),name+'.log'),logs);
            await docker('rm','-f','-v',name).catch(()=>{});
        }
        for (const volume of [live,backup]) await docker('volume','rm',volume).catch(()=>{});
        await fs.rm(scratch,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
