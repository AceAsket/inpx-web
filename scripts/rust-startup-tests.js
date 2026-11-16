const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {resolveLibrarySources} = require('../server/core/LibrarySources');

async function verify(binary, directory) {
    const variables = ['INPX_RUST_CATALOG_BINARY','INPX_LIBRARY_SOURCES','LIBRARY_SOURCES'];
    const original = Object.fromEntries(variables.map(key=>[key,process.env[key]]));
    const cwd = process.cwd();
    const environment = (qualified, legacy) => {
        for (const [key,value] of [['INPX_LIBRARY_SOURCES',qualified],['LIBRARY_SOURCES',legacy]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    const resolveWith = async(native,config,argv) => {
        if (native) process.env.INPX_RUST_CATALOG_BINARY = binary;
        else delete process.env.INPX_RUST_CATALOG_BINARY;
        const current = structuredClone(config);
        const sources = await resolveLibrarySources(current,argv);
        return {sources,config:current};
    };
    const parity = async(config,argv) => {
        const expected = await resolveWith(false,config,argv);
        assert.deepEqual(await resolveWith(true,config,argv),expected);
        return expected.sources;
    };
    try {
        process.chdir(directory);
        directory = process.cwd();
        const lib = join(directory,'INPX тома');
        const folder = join(directory,'Мои книги');
        await fs.mkdir(join(lib,'ignored.inpx'),{recursive:true});
        await fs.mkdir(join(lib,'nested'));
        await fs.mkdir(folder);
        const inpx = join(lib,'Том.INPX');
        await fs.writeFile(join(lib,'.inpx'),'not an INPX file');
        await fs.writeFile(inpx,'fixture');

        environment();
        const direct = JSON.parse(execFileSync(binary,['library-sources'],{
            input:JSON.stringify({libDir:'INPX тома'}),encoding:'utf8',
        }));
        assert.equal(direct.sources[0].inpx,inpx);
        assert.deepEqual((await parity({execDir:lib})).map(source=>source.id),['main']);

        const fileHash = createHash('sha1').update('Том').digest('hex').slice(0,8);
        const folderHash = createHash('sha1').update('Заметки').digest('hex').slice(0,8);
        const configured = {execDir:folder,librarySources:[
            {enabled:false,libDir:'unavailable'},
            {inpxFile:'INPX тома/nested/../Том.INPX'},
            {libraryDir:' Мои книги ',type:'folder',id:'Заметки'},
            {name:' Collection- [2] ',libDir:'INPX тома'},
        ]};
        const sources = await parity(configured);
        assert.deepEqual(sources.map(source=>source.id),['source-2-'+fileHash,'source-3-'+folderHash,'collection--2']);
        assert.equal(sources[1].libDir,folder);
        assert.equal(sources[1].inpx,'');
        assert.equal(sources[2].inpxFile,inpx);

        const cli = {'library-sources':'a|Alpha|INPX тома/Том.INPX|INPX тома; Bravo||INPX тома; INPX тома/Том.INPX'};
        assert.deepEqual((await parity(configured,cli)).map(source=>source.id),['a','bravo','source-3']);
        environment('[]');
        assert.deepEqual((await parity(configured,cli)).map(source=>source.id),['a','bravo','source-3']);
        environment('',JSON.stringify({id:'old-env',type:'folder',libDir:'Мои книги'}));
        assert.deepEqual((await parity(configured,cli)).map(source=>source.id),['old-env']);
        environment('Current env||INPX тома',JSON.stringify({id:'old-env',type:'folder',libDir:folder}));
        assert.deepEqual((await parity(configured,cli)).map(source=>source.id),['current-env']);

        environment('[invalid');
        const remote = await parity({remoteLib:{url:'wss://example.invalid'},inpxFile:'data/remote.inpx',dataDir:'data'});
        assert.deepEqual(remote,[{id:'remote',name:'Remote library',remote:true,enabled:true,
            inpx:'data/remote.inpx',inpxFile:'data/remote.inpx',libDir:'data'}]);
        await assert.rejects(resolveWith(true,{execDir:lib}),/inpx-catalog/);
        await assert.rejects(resolveWith(true,{remoteLib:true,inpxFile:inpx,libDir:lib},{'library-sources':'[invalid'}),/inpx-catalog/);
        environment();

        const other = join(lib,'another.inpx');
        await fs.writeFile(other,'another fixture');
        await assert.rejects(resolveWith(true,{execDir:lib}),error=>error.message.includes('Found more than one .inpx files')
            && error.message.includes(inpx) && error.message.includes(other));
        await assert.rejects(resolveWith(true,{execDir:folder}),/No .inpx files found here/);
        await assert.rejects(resolveWith(true,{librarySources:[{enabled:false}]}),/No enabled INPX library sources configured/);
        await assert.rejects(resolveWith(true,{librarySources:[{libDir:'missing'}]}),/Library source #1: directory/);
        assert.equal((await parity({execDir:lib},{inpx:'INPX тома/Том.INPX'}))[0].inpx,inpx);
        console.log('ok Rust library startup: source precedence, discovery, stable IDs, folder mode and remote config');
    } finally {
        process.chdir(cwd);
        for (const [key,value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

async function verifyConfiguration(directory, run) {
    const dataDir = join(directory,'user-data');
    const defaultDataDir = join(directory,'unused-default');
    const file = join(directory,'external-config.json');
    const keyFile = join(dataDir,'secret.key');
    const restore = join(dataDir,'.restore-transaction');
    const journal = join(dataDir,'reader-progress.log');
    const profiles = join(dataDir,'reading-lists.json');
    const options = {file,defaultDataDir,execDir:directory,name:'inpx-web',version:'upgrade-fixture'};
    const load = ()=>run('load-config',[],options);
    const save = config=>run('save-config',[],{file,dataDir,config});
    const readJson = async path=>JSON.parse(await fs.readFile(path,'utf8'));
    const missing = path=>assert.rejects(fs.stat(path),{code:'ENOENT'});
    await fs.mkdir(dataDir);
    const SecretStore = require('../server/core/SecretStore');
    const native = process.env.INPX_RUST_CATALOG_BINARY;
    const credentials = {smtpPass:'старый пароль',telegramBotToken:'legacy-fixture',
        telegramProxyPassword:'proxy-fixture',metricsToken:'metrics-fixture',opds:{user:'alice',password:'каталог 🗝'}};
    const legacy = new SecretStore({dataDir});
    delete process.env.INPX_RUST_CATALOG_BINARY;
    let encrypted;
    try { encrypted = await legacy.protectConfig(credentials); }
    finally { process.env.INPX_RUST_CATALOG_BINARY = native; }
    const key = await fs.readFile(keyFile);
    const original = {...encrypted,dataDir,libDir:'configured',ttsEnabled:true,adminPassword:'launch-only',
        latestReleaseLink:'https://github.com/bookpauk/inpx-web/releases/latest'};
    const originalBytes = '\uFEFF'+JSON.stringify(original);
    await fs.mkdir(restore);
    await fs.writeFile(join(restore,'config.json'),originalBytes);
    await fs.writeFile(join(restore,'secret.key'),key);
    await fs.writeFile(join(restore,'manifest.json'),JSON.stringify({state:'prepared',files:['config.json','secret.key'],
        existed:{'config.json':true,'secret.key':true}}));
    await fs.writeFile(keyFile,'interrupted replacement');
    await fs.writeFile(file,JSON.stringify({dataDir,smtpPass:'uncommitted-config'}));

    const loaded = await load();
    assert.equal(loaded.state,'ready');
    assert.equal(loaded.needsSave,true);
    for (const [name,value] of Object.entries(credentials)) assert.deepEqual(loaded.config[name],value);
    assert.equal(loaded.config.dataDir,dataDir);
    assert.equal(loaded.config.libDir,'configured');
    assert.equal(loaded.config.latestReleaseLink,'https://github.com/AceAsket/inpx-web/releases/latest');
    assert.equal(loaded.config.checkReleaseLink,'https://api.github.com/repos/AceAsket/inpx-web/releases/latest');
    assert(!Object.hasOwn(loaded.config,'ttsEnabled'));
    assert(!Object.hasOwn(loaded.config,'adminPassword'));
    await missing(restore);
    await missing(defaultDataDir);
    const marker = await readJson(join(dataDir,'.upgrade-version.json'));
    assert.equal(await fs.readFile(join(marker.snapshot,'config.json'),'utf8'),originalBytes);
    assert.deepEqual(await fs.readFile(join(marker.snapshot,'secret.key')),key);

    assert.deepEqual(await save({...loaded.config,smtpPass:'new value',ttsEnabled:true,adminPassword:'launch-only'}),{saved:true});
    const saved = await fs.readFile(file,'utf8');
    assert(!saved.includes('new value'));
    const disk = JSON.parse(saved);
    assert(!Object.hasOwn(disk,'ttsEnabled'));
    assert(!Object.hasOwn(disk,'adminPassword'));
    for (const field of ['smtpPass','telegramBotToken','telegramProxyPassword','metricsToken'])
        assert.match(disk[field],/^enc:v1:/);
    assert.match(disk.opds.password,/^enc:v1:/);
    assert.deepEqual(await fs.readFile(keyFile),key);
    if (process.platform!=='win32') assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    const reopened = await load();
    assert.deepEqual(reopened,{state:'ready',config:{...loaded.config,smtpPass:'new value'},needsSave:false});
    delete process.env.INPX_RUST_CATALOG_BINARY;
    try { assert.equal((await legacy.unprotectConfig(disk)).config.smtpPass,'new value'); }
    finally { process.env.INPX_RUST_CATALOG_BINARY = native; }
    await fs.writeFile(keyFile,'wrong key length');
    await assert.rejects(save({...loaded.config,smtpPass:'a rejected fixture'}),error=>
        /Invalid secret key length/.test(error.message) && !error.stack.includes('a rejected fixture'));
    assert.equal(await fs.readFile(file,'utf8'),saved);
    await fs.writeFile(keyFile,key);

    const checkpoint = 'c'.repeat(32);
    await fs.writeFile(profiles,JSON.stringify({readerProgressCheckpoint:checkpoint,users:[{id:'reader'}]}));
    const update = JSON.stringify(['reader','book',{generation:0,percent:0.5},'now'])+'\n';
    const committed = JSON.stringify({state:'committed',files:['reading-lists.json'],existed:{'reading-lists.json':true}});
    for (const active of [false,true]) {
        await fs.mkdir(restore);
        await fs.writeFile(join(restore,'manifest.json'),committed);
        const bytes = (active ? checkpoint : 'd'.repeat(32))+'\n'+update;
        await fs.writeFile(journal,bytes);
        assert.deepEqual(await load(),reopened);
        await missing(restore);
        if (active) assert.equal(await fs.readFile(journal,'utf8'),bytes);
        else await missing(journal);
    }
    assert.deepEqual(await readJson(join(dataDir,'.upgrade-version.json')),marker);
    console.log('ok Rust config startup: interrupted restore, secrets, encrypted save, rollback and journal cleanup');
}

async function main() {
    const binary = resolve(process.argv[2]);
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-library-sources-'));
    try {
        await verify(binary,directory);
        const run = require('../server/core/RustStartup').run;
        const before = process.env.INPX_RUST_CATALOG_BINARY;
        process.env.INPX_RUST_CATALOG_BINARY = binary;
        try {
            await verifyConfiguration(directory,run);
            const zip = new (require('yazl').ZipFile)();
            const chunks = [];
            zip.outputStream.on('data',chunk=>chunks.push(chunk));
            const end = require('node:events').once(zip.outputStream,'end');
            zip.addBuffer(Buffer.from('startup'),'index.html');
            zip.end();
            await end;
            assert.deepEqual(await run('install-web-app',[],{
                publicDir:join(directory,'public'),tempDir:join(directory,'tmp'),version:'native',
                prefix:'',appDirectory:'app',bundle:Buffer.concat(chunks).toString('base64'),
            }),{installed:true});
            const test = require('./library-feature-tests').find(item=>item.name==='testWebAppUpdatesPreserveCustomFilesAndCleanOnlyManagedAssets');
            await test();
            console.log('ok Rust assets startup: managed updates, prefix, custom files and symlink preflight');
        } finally {
            if (before === undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
            else process.env.INPX_RUST_CATALOG_BINARY = before;
        }
    }
    finally { await fs.rm(directory,{recursive:true,force:true}); }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
