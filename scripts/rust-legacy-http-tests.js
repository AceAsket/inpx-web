const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {once} = require('node:events');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {gzipSync} = require('node:zlib');
const {pipeline} = require('node:stream/promises');
const {createWriteStream} = require('node:fs');
const {ZipFile} = require('yazl');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {docker, until, timing} = require('./rust-inpx-filter-tests');
const {connect, signIn} = require('./rust-events-tests');
const {coverUrl} = require('../client/components/Library/libraryModel');

const root = '/library';
const password = 'legacy-http-fixture';
const read = name => fs.readFile(join(__dirname,'../client/assets',name));
const fixtureName = 'Чтение.FB2';
const raw = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?>\r\n<FictionBook><body><section><p>'),
    Buffer.from([0xd2,0xe5,0xea,0xf1,0xf2]),Buffer.from('</p></section></body></FictionBook>\r\n')]);

async function zip(path, contents) {
    const archive = new ZipFile();
    for (const [name, data] of Object.entries(contents)) archive.addBuffer(Buffer.from(data),name);
    const output = pipeline(archive.outputStream,createWriteStream(path));
    archive.end();
    await output;
}

async function zipBytes(name, data) {
    const archive = new ZipFile();
    const bytes = [];
    archive.outputStream.on('data',part=>bytes.push(part));
    const done = once(archive.outputStream,'end');
    archive.addBuffer(data,name);
    archive.end();
    await done;
    return Buffer.concat(bytes);
}

async function webp(browser, png) {
    const page = await browser.newPage();
    try {
        const encoded = await page.evaluate(async bytes => {
            const image = new Image();
            image.src = 'data:image/png;base64,'+bytes;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 8;
            canvas.getContext('2d').drawImage(image,0,0,8,8);
            return canvas.toDataURL('image/webp');
        },png.toString('base64'));
        assert(encoded.startsWith('data:image/webp;base64,'));
        return Buffer.from(encoded.split(',')[1],'base64');
    } finally { await page.close(); }
}

async function fixture(directory, browser) {
    const sources = ['main','other'];
    for (const id of sources) {
        await fs.mkdir(join(directory,id,'covers'),{recursive:true});
        const row = ['Тестов,Автор:','sf:',`Маршруты ${id}`,'',0,'none',0,9000,0,'fb2','2026-01-01','ru',0,''];
        await zip(join(directory,id,'library.inpx'),{'catalog.inp':row.join('\x04')+'\n'});
    }
    await fs.mkdir(join(directory,'covers'));
    const [main,other,book] = await Promise.all(['pwa-icon-192.png','reader-icon-192.png','pwa-icon-512.png'].map(read));
    const fb2 = Buffer.from('<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><coverpage>'+
        '<image l:href="#cover"/></coverpage><book-title>Тест</book-title></title-info></description>'+
        '<binary id="cover" content-type="image/png">'+book.toString('base64')+'</binary></FictionBook>');
    await fs.writeFile(join(directory,'main',fixtureName),raw);
    await fs.writeFile(join(directory,'main','source.txt'),raw);
    await fs.writeFile(join(directory,'narrow.png'),main);
    await fs.writeFile(join(directory,'for-jxl.png'),other);
    await Promise.all([
        zip(join(directory,'main/catalog.zip'),{'none.fb2':fb2}),
        zip(join(directory,'other/catalog.zip'),{'none.fb2':raw}),
        zip(join(directory,'other/covers/CATALOG.ZIP'),{'none':main}),
        zip(join(directory,'main/covers/wide-1000-1099.zip'),{'1001':book}),
        zip(join(directory,'other/covers/local-1000-1001.zip'),{'1001':other}),
        zip(join(directory,'covers/shared-3000-3010.zip'),{'3001':other}),
        zip(join(directory,'main/covers/webp-1100-1101.zip'),{'1101':await webp(browser,main)}),
        zip(join(directory,'main/ranged-2000-2099.zip'),{
            'subdir/2001.fb2':fb2,
            '2002.fb2.gz':gzipSync(fb2),
            '2003.fb2.zip':await zipBytes('nested/2003.fb2',fb2),
        }),
    ]);
    const config = {
        dataDir:'/data',inpxCheckInterval:0,loggingEnabled:false,
        server:{host:'0.0.0.0',port:'12380',root},
        librarySources:sources.map(id=>({id,name:id,type:'inpx',libDir:'/data/library/'+id,inpx:'/data/library/'+id+'/library.inpx'})),
    };
    await fs.writeFile(join(directory,'config.json'),JSON.stringify(config));
    await fs.writeFile(join(directory,'config-root.json'),JSON.stringify({...config,server:{...config.server,root:''}}));
    return {main,other,book};
}

async function start(name, image, directory, {protectedAccess = false, rootless = false} = {}) {
    const configFile = rootless ? 'config-root.json' : 'config.json';
    const prepare = `cp /fixture/${configFile} /data/config.json
        mkdir /data/library /data/encode
        cp -R /fixture/main /fixture/other /fixture/covers /data/library/
        cp /fixture/narrow.png /data/encode/1001
        ln -s /data/outside.fb2 /data/library/main/escape.fb2
        cp /fixture/main/*.FB2 /data/outside.fb2
        cd /data/encode
        7z a /data/library/main/covers/narrow-1001-1001.7z 1001 >/dev/null
        cjxl /fixture/for-jxl.png /data/encode/cover.jxl -d 0 -e 1 >/dev/null 2>&1
        mv cover.jxl 1102
        7z a /data/library/main/covers/jxl-1102-1102.zip 1102 >/dev/null
        cp 1102 none
        7z a /data/library/main/covers/catalog.7z none >/dev/null
        exec inpx-web "$@"`;
    await docker('run','-d','--name',name,'--tmpfs','/data','-p','127.0.0.1::12380',
        '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false',
        '-e','INPX_ALLOW_ANONYMOUS_ACCESS='+!protectedAccess,
        '--mount','type=bind,source='+directory+',target=/fixture,readonly',
        image,'sh','-ec',prepare,'fixture','--data-dir=/data','--host=0.0.0.0',
        '--port=12380','--admin-password='+password);
    const base = 'http://'+await docker('port',name,'12380/tcp');
    await until(async()=>{
        try { return (await fetch(base+'/ready',{signal:AbortSignal.timeout(1000)})).ok; }
        catch { return false; }
    },Boolean,name+' did not become ready',45);
    return base;
}

async function browserReset(browser, base) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await context.route(url=>['/library/fixture-reset','/library/fixture-return'].includes(url.pathname),
            route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Recovery fixture</title>'}));
        let external = false;
        await context.route('https://outside.invalid/**',route=>{external=true;return route.abort();});
        await page.goto(base+root+'/fixture-reset');
        await page.evaluate(async prefix=>{
            for (const scope of [prefix+'/',prefix+'/foreign/'])
                await navigator.serviceWorker.register(prefix+'/sw.js',{scope});
        },root);
        await page.waitForFunction(async()=>{
            const registrations = await navigator.serviceWorker.getRegistrations();
            return registrations.length===2 && registrations.every(entry=>entry.active?.state==='activated');
        });
        await page.evaluate(async()=>{
            await caches.open('inpx-web-recovery-fixture');
            await caches.open('independent-fixture');
            sessionStorage.setItem('inpx-web-build-reload:stale','5');
            sessionStorage.setItem('other-session','keep');
            for (const key of ['inpx.reader.preferences','inpx.reader.progress','inpx.reader.bookmarks'])
                localStorage.setItem(key,key+'-saved');
        });
        const reset = target=>base+root+'/app-reset?'+new URLSearchParams({return:target});
        const target = root+'/fixture-return?filter=fb2&appBuild=old#/reader?clearAppCache=1&book=34';
        await page.goto(reset(target));
        await page.waitForURL(url=>url.pathname===root+'/fixture-return');
        const returned = new URL(page.url());
        assert.equal(returned.searchParams.get('filter'),'fb2');
        assert.match(returned.searchParams.get('appCacheReset'),/^\d+$/);
        assert(!returned.searchParams.has('appBuild'));
        assert.equal(returned.hash,'#/reader?book=34');
        const state = await page.evaluate(async()=>({
            caches:await caches.keys(),
            workers:(await navigator.serviceWorker.getRegistrations()).map(entry=>entry.scope),
            recovery:sessionStorage.getItem('inpx-web-build-reload:stale'),
            other:sessionStorage.getItem('other-session'),
            user:['preferences','progress','bookmarks'].map(key=>localStorage.getItem('inpx.reader.'+key)),
        }));
        assert(!state.caches.includes('inpx-web-recovery-fixture'));
        assert(state.caches.includes('independent-fixture'));
        assert.deepEqual(state.workers,[base+root+'/foreign/']);
        assert.equal(state.recovery,null);
        assert.equal(state.other,'keep');
        assert.deepEqual(state.user,['preferences','progress','bookmarks'].map(key=>'inpx.reader.'+key+'-saved'));
        for (const invalid of ['https://outside.invalid','/outside',root+'/app-reset']) {
            await page.goto(reset(invalid));
            await page.waitForURL(url=>url.pathname===root+'/');
        }
        assert(!external);
    } finally { await context.close(); }
}

async function bytes(response) {
    return Buffer.from(await response.arrayBuffer());
}

async function measureRoutes(base) {
    const medians = new Map();
    for (const [label,path] of [['/app-reset','/app-reset'],
        ['/reader-lab-source','/reader-lab-source/'+encodeURIComponent(fixtureName)],
        ['/cover by libid','/cover/main/1001']]) {
        const samples = [];
        for (let i=0;i<12;i++) {
            const started = performance.now();
            const response = await fetch(base+root+path,{signal:AbortSignal.timeout(5000)});
            assert.equal(response.status,200);
            const body = await response.arrayBuffer();
            const elapsed = performance.now()-started;
            assert(body.byteLength>0);
            if (i) samples.push(elapsed);
        }
        medians.set(label,Number(samples.sort((a,b)=>a-b)[5].toFixed(2)));
    }
    return medians;
}

async function httpChecks(base, assets, browser) {
    const path = root+'/reader-lab-source/'+encodeURIComponent(fixtureName);
    const reset = await fetch(base+root+'/app-reset');
    assert.equal(reset.status,200);
    assert.equal(reset.headers.get('cache-control'),'no-store, no-cache, must-revalidate');
    assert.equal(reset.headers.get('pragma'),'no-cache');
    assert.equal(reset.headers.get('expires'),'0');
    const html = await reset.text();
    assert.match(html,/const BASE_PATH = "\/library\/"/);
    assert.equal((await fetch(base+'/app-reset')).status,404);
    const file = await fetch(base+path);
    assert.equal(file.status,200);
    assert.match(file.headers.get('content-type'),/^application\/xml; charset=utf-8$/i);
    assert.equal(file.headers.get('cache-control'),'no-store');
    assert.deepEqual(await bytes(file),raw);
    const head = await fetch(base+path,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(Number(head.headers.get('content-length')),raw.length);
    assert.equal((await bytes(head)).length,0);
    const range = await fetch(base+path,{headers:{range:'bytes=7-38'}});
    assert.equal(range.status,206);
    assert.deepEqual(await bytes(range),raw.subarray(7,39));
    for (const name of ['missing.fb2','source.txt','escape.fb2','%2e%2e%2foutside.fb2'])
        assert.equal((await fetch(base+root+'/reader-lab-source/'+name)).status,404,name);

    const results = {};
    const client = await connect(base,root);
    try {
        for (const source of ['other','main']) {
            const search = await client.send('bookSearch',{query:{title:'=Маршруты '+source,limit:2}});
            assert.equal(search.found.length,1,source);
            const url = coverUrl(search.found[0],root);
            assert(url.startsWith(root+'/cover/by-uid?'),url);
            const response = await fetch(base+url);
            assert.equal(response.status,200,source+' catalogue cover');
            assert.equal(response.headers.get('content-type'),'image/png',source);
            const data = await bytes(response);
            assert(!data.equals(assets.book),'Embedded cover must not shadow the source cover: '+source);
            if (source === 'other') assert.deepEqual(data,assets.main);
            results['catalogue-'+source] = data;
            if (source === 'main') {
                const covers = await Promise.all(Array.from({length:12}, () => fetch(base+url)));
                for (const cover of covers) {
                    assert.equal(cover.status,200,'Concurrent catalogue cover');
                    assert.deepEqual(await bytes(cover),data);
                }
            }
        }
    } finally { client.close(); }
    for (const [path, expected] of Object.entries({
        '1001':assets.main,'main/1001':assets.main,'other/1001':assets.other,
        '3001':assets.other,'main/2001':assets.book,'main/2002':assets.book,'main/2003':assets.book,
        '1101':null,'1102':null,
    })) {
        const response = await fetch(base+root+'/cover/'+path);
        assert.equal(response.status,200,path);
        assert.equal(response.headers.get('content-type'),'image/png',path);
        assert.equal(response.headers.get('cache-control'),'private, no-cache',path);
        const content = await bytes(response);
        if (expected) assert.deepEqual(content,expected,path);
        else assert(content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),path);
        results[path] = content;
    }
    for (const path of ['unknown/1001','other/2001','9999','bad-id'])
        assert.equal((await fetch(base+root+'/cover/'+path)).status,404,path);
    const coverHead = await fetch(base+root+'/cover/main/1001',{method:'HEAD'});
    assert.equal(coverHead.status,200);
    assert.equal(Number(coverHead.headers.get('content-length')),assets.main.length);
    await browserReset(browser,base);
    return {results,html:html.replace(/\r\n/g,'\n')};
}

async function protectedFiles(base, assets) {
    const cover = base+root+'/cover/main/1001';
    const lab = base+root+'/reader-lab-source/'+encodeURIComponent(fixtureName);
    for (const url of [cover,lab]) assert.equal((await fetch(url)).status,401,url);
    const client = await connect(base,root);
    try {
        await signIn(client,'admin',password);
        const headers = {cookie:client.cookie};
        assert.deepEqual(await bytes(await fetch(lab,{headers})),raw);
        assert.deepEqual(await bytes(await fetch(cover,{headers})),assets.main);
        assert.equal((await fetch(base+root+'/app-reset')).status,200);
    } finally { client.close(); }
}

async function rootPaths(base, assets) {
    const reset = await fetch(base+'/app-reset');
    assert.equal(reset.status,200);
    assert.match(await reset.text(),/const BASE_PATH = "\/"/);
    assert.deepEqual(await bytes(await fetch(base+'/reader-lab-source/'+encodeURIComponent(fixtureName))),raw);
    assert.deepEqual(await bytes(await fetch(base+'/cover/1001')),assets.main);
}

async function main(rust, rc15) {
    assert(rust && rc15,'Usage: node scripts/rust-legacy-http-tests.js <rust-image> <rc15-image>');
    const browser = await chromium.launch({headless:true});
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-legacy-http-'));
    const names = ['rc15','rust','rc15-protected','rust-protected','rc15-root','rust-root']
        .map(type=>'inpx-legacy-'+process.pid+'-'+type);
    try {
        const assets = await fixture(directory,browser);
        const legacyBase = await start(names[0],rc15,directory);
        const legacy = await httpChecks(legacyBase,assets,browser);
        const before = await measureRoutes(legacyBase);
        await protectedFiles(await start(names[2],rc15,directory,{protectedAccess:true}),assets);
        await rootPaths(await start(names[4],rc15,directory,{rootless:true}),assets);
        console.log('ok RC15 recovery, original FB2, legacy covers and profile access');
        await until(()=>docker('image','inspect',rust,'--format','{{.Id}}').catch(()=>''),Boolean,
            'Rust image did not finish building',600);
        const rustBase = await start(names[1],rust,directory);
        const native = await httpChecks(rustBase,assets,browser);
        const after = await measureRoutes(rustBase);
        await protectedFiles(await start(names[3],rust,directory,{protectedAccess:true}),assets);
        await rootPaths(await start(names[5],rust,directory,{rootless:true}),assets);
        assert.deepEqual(native,legacy);
        for (const [label,median] of before)
            await timing(label+' (11 warm GETs, median)',median,after.get(label),'ms');
        console.log('ok Rust matches RC15 for recovery, FB2, ZIP/7z cover archives, embedded and WebP/JXL covers');
    } catch (error) {
        for (const name of names) {
            const logs = await docker('logs','--tail','20',name).catch(()=>null);
            if (logs) console.error(name,logs);
        }
        throw error;
    } finally {
        await browser.close();
        for (const name of names) await docker('rm','-f','-v',name).catch(()=>{});
        await fs.rm(directory,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
