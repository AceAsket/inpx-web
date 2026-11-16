const assert = require('node:assert/strict');
const {spawn,spawnSync,execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {once} = require('node:events');
const {tmpdir} = require('node:os');
const {dirname,join,resolve} = require('node:path');
const {setTimeout:sleep} = require('node:timers/promises');
const {ZipFile} = require('yazl');
const WebSocket = require('ws');
const {createFixture,unusedPort} = require('./binary-smoke-test');
const app = require('../build/appdir');

const VERSION = require('../package.json').version;
const readJson = async file=>JSON.parse(await fs.readFile(file,'utf8'));
const bytes = async response=>Buffer.from(await response.arrayBuffer());

async function zip(entries) {
    const archive = new ZipFile();
    const chunks = [];
    archive.outputStream.on('data',part=>chunks.push(part));
    const end = once(archive.outputStream,'end');
    for (const [name, data] of entries) archive.addBuffer(Buffer.from(data),name);
    archive.end();
    await end;
    return Buffer.concat(chunks);
}

async function bundle(file) {
    const archive = await zip([
        ['index.html','<script src="/'+app+'/chunk.js"></script>'],
        [app+'/chunk.js','standalone assets'],
    ]);
    await fs.writeFile(file,JSON.stringify({data:archive.toString('base64')}));
}

function environment() {
    const env = {...process.env};
    for (const name of Object.keys(env))
        if (/^(PATH|INPX_(REQUIRE_AUTH|ALLOW_ANONYMOUS_ACCESS|AUTH_MODE|AUTH_EXEMPT_HEALTH|TRUST_PROXY|TRUSTED_PROXY_CIDRS|PROXY_AUTH_HEADER|PROXY_BIND_PROFILE|LOGIN_RATE_LIMIT_ENABLED|RESET_ADMIN_PASSWORD|LIBRARY_SOURCES|OPDS_COMPATIBILITY|OPDS_FEEDS_FILE|KOSYNC_ENABLED|ENABLE_CONVERSION|CONVERSION_FORMATS|ADMIN_.*|METRICS_.*|ABS_.*|RUST_.*)|LIBRARY_SOURCES|LIBDIR|INPX)$/i.test(name))
            delete env[name];
    return {...env,PATH:'',INPX_BOOK_FILENAME_TEMPLATE:'[${TITLE}] Тест.${EXT}'};
}

async function start(binary,args,environmentOverrides,readinessHeaders) {
    const port = await unusedPort();
    const env = {...environment(),...environmentOverrides};
    const child = spawn(binary,[...args,'--port='+port],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = '';
    for (const stream of [child.stdout,child.stderr]) stream.on('data',part=>{output=(output+part).slice(-6000);});
    const settled = new Promise(resolve=>{
        child.once('exit',resolve);
        child.once('error',error=>{output+=error.message;resolve();});
    });
    const stop = async()=>{
        if (child.exitCode===null && child.signalCode===null) child.kill();
        await settled;
    };
    const url = 'http://127.0.0.1:'+port;
    try {
        const until = Date.now()+35000;
        while (Date.now()<until && child.exitCode===null) {
            const response = await fetch(url+'/ready',{headers:readinessHeaders,signal:AbortSignal.timeout(1000)}).catch(()=>null);
            if (response?.ok) {
                const ready = await response.json();
                assert.equal(ready.ready,true);
                assert.equal(ready.version,VERSION);
                return {url,ready,stop};
            }
            await sleep(200);
        }
        assert.fail(output);
    } catch (error) {
        await stop();
        throw error;
    }
}

async function wsClient(url, cookie, headers) {
    const socket = new WebSocket(url.replace(/^http/,'ws')+'/reader/ws',{
        headers:{origin:url,...headers,...(cookie ? {cookie} : {})},
    });
    await once(socket,'open');
    const pending = new Map();
    let sequence = 0;
    socket.on('message',raw=>{
        const value = JSON.parse(raw);
        const request = pending.get(value.requestId);
        if (!request) return;
        if (value._rok) {
            request.ack = true;
            return;
        }
        pending.delete(value.requestId);
        clearTimeout(request.timeout);
        if (!request.ack) request.reject(new Error('Missing _rok for '+value.requestId));
        else request.resolve(value);
    });
    return {
        request(message) {
            const requestId = 'ws-fixture-'+(++sequence);
            return new Promise((resolve,reject)=>{
                const timeout = setTimeout(()=>{
                    pending.delete(requestId);
                    reject(new Error('WebSocket timeout for '+message.action));
                },12000);
                pending.set(requestId,{resolve,reject,timeout,ack:false});
                socket.send(JSON.stringify({...message,requestId}));
            });
        },
        socket,
        close:()=>socket.terminate(),
    };
}

async function browserCookie(url) {
    const page = await fetch(url+'/reader/');
    assert.equal(page.status,200);
    const header = page.headers.get('set-cookie');
    assert.equal(page.headers.get('cache-control'),'private, no-store');
    assert.match(header,/^inpx_web_session=[a-f\d]{48}\.[a-f\d]{64}; HttpOnly; SameSite=Lax; Path=\/reader;/);
    return header.split(';')[0];
}

async function verifySocket(url, uid) {
    const cookie = await browserCookie(url);
    const ws = await wsClient(url,cookie);
    try {
        const config = await ws.request({action:'get-config'});
        assert.equal(config.version,VERSION);
        assert.equal(config.rootPathStatic,'/reader');
        assert.equal(config.dbConfig.stats.bookCount,2);
        assert.equal(config.uiDefaults.limit,20);
        assert.equal(config.onlineReaderEnabled,true);
        assert.match(config.csrfToken,/^[a-f\d]{64}$/);
        assert(!JSON.stringify(config).includes('passwordHash'));
        const [ready,titles,books] = await Promise.all([
            ws.request({action:'get-worker-state',workerId:'server_state'}),
            ws.request({action:'search',from:'title',query:{title:'Packaged',del:'0',limit:20}}),
            ws.request({action:'bookSearch',query:{title:'smoke book',del:'0',ext:'fb2|epub',sourceId:'main'}}),
        ]);
        assert.equal(ready.state,'normal');
        assert.equal(titles.totalFound,1,titles.error);
        assert.equal(titles.found[0].title,'Packaged smoke book');
        assert.equal(titles.found[0].books[0]._uid,uid);
        assert.equal(books.totalFound,1,books.error);
        assert.equal(books.found[0]._uid,uid);
        const authors = await ws.request({action:'search',from:'author',query:{author:'Tester'}});
        const authorBooks = await ws.request({action:'get-author-book-list',authorId:authors.found[0].id,query:{del:'0'}});
        assert.equal(authorBooks.author,'Tester Smoke');
        assert.equal(authorBooks.books[0]._uid,uid);
        const genres = await ws.request({action:'get-genre-tree'});
        assert(genres.langList.includes('en'));
        assert(genres.extList.includes('fb2'));
        const attachment = await ws.request({action:'get-book-link',bookUid:uid});
        assert.match(attachment.link,/^\/reader\/book\/[a-f\d]{64}$/);
        assert.equal(attachment.libFile,'1.fb2');
        assert.match(attachment.downFileName,/Тест\.fb2$/);
        const download = await fetch(url+attachment.link);
        assert.equal(download.status,200);
        assert.match(await download.text(),/Packaged smoke book/);
        const Fb2Parser = require('../server/core/fb2/Fb2Parser');
        const original = await ws.request({action:'get-book-info',bookUid:uid,readerOnly:true});
        assert(original.bookInfo,original.error);
        const document = new Fb2Parser(original.bookInfo.fb2);
        assert.equal(document.bookInfo().titleInfo.bookTitle,'Packaged smoke book');
        assert.equal(document.$$array('/binary').length,2);
        assert.match(document.$$('/body/').toString(),/Smoke text/);
        assert.equal(original.bookInfo.annotationMeta.stats.images,2);
        const parsedCover = await fetch(url+original.bookInfo.cover);
        assert.equal(parsedCover.status,200);
        assert.equal(parsedCover.headers.get('content-type'),'image/png');
        assert.equal(parsedCover.headers.get('x-content-type-options'),'nosniff');
        const cover = await bytes(parsedCover);
        assert(cover.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
        const coverHead = await fetch(url+original.bookInfo.cover,{method:'HEAD'});
        assert.equal(coverHead.headers.get('content-length'),String(cover.length));
        const card = await ws.request({action:'get-book-info',bookUid:uid,card:true,lazyExtras:true});
        const cardDocument = new Fb2Parser(card.bookInfo.fb2);
        assert.equal(cardDocument.$$array('/body').length,0);
        assert.equal(cardDocument.$$array('/binary').length,0);
        assert.equal(card.bookInfo.galleryCount,1);
        const gallery = await ws.request({action:'get-book-gallery',bookUid:uid});
        assert.deepEqual(gallery.images.map(image=>[image.id,image.contentType]),[['illustration','image/png']]);
        const state = await ws.request({action:'get-reader-state',bookUid:uid});
        assert.equal(state.progress.percent,0);
        assert.deepEqual(state.bookmarks,[]);
        const request = {action:'update-reader-progress',bookUid:uid,
            progress:{percent:0.35,sectionId:'section-fixture',pageIndex:12,textOffset:30,textSnippet:'Smoke text',
                generation:state.progressGeneration,baseRevision:0}};
        assert.equal((await ws.request(request)).error,'bad_csrf_token');
        const updated = await ws.request({...request,csrfToken:config.csrfToken});
        assert.equal(updated.progress?.revision,1,updated.error);
        assert.equal(updated.progress.percent,0.35);
        const conflict = await ws.request({...request,csrfToken:config.csrfToken,progress:{...request.progress,percent:0.8}});
        assert.equal(conflict.progress?.conflict,true,conflict.error);
        assert.equal(conflict.progress.percent,0.35);
        const wrongGeneration = await ws.request({...request,csrfToken:config.csrfToken,progress:{...request.progress,generation:10,baseRevision:1}});
        assert.equal(wrongGeneration.progress?.generationMismatch,true,wrongGeneration.error);
        const recovered = await ws.request({action:'get-reader-state',bookUid:uid});
        assert.equal(recovered.progress.sectionId,'section-fixture');
        assert.match((await ws.request({action:'unknown-standalone-action'})).error,/Unknown action/);
    } finally { ws.close(); }

    const bad = new WebSocket(url.replace(/^http/,'ws')+'/reader/ws',{
        headers:{origin:'https://other.invalid','x-forwarded-host':'other.invalid','x-forwarded-proto':'https',cookie},
    });
    const [failure] = await once(bad,'error');
    assert.match(failure.message,/403/);
    const binary = await wsClient(url,cookie);
    try {
        binary.socket.send(Buffer.from([1,2,3]));
        const [code] = await once(binary.socket,'close');
        assert.equal(code,1003);
    } finally { binary.close(); }
    console.log('ok standalone WebSocket reader document, cover, gallery and revision-checked progress');
}

async function verifyShelves(url, readingUid, shelfUid) {
    const guest = await wsClient(url,await browserCookie(url));
    const admin = await wsClient(url,await browserCookie(url));
    try {
        const {csrfToken} = await guest.request({action:'get-config'});
        const change = (action, fields = {}) => guest.request({action,userId:'default',csrfToken,...fields});
        assert.equal((await guest.request({action:'create-reading-list',name:'Blocked'})).error,'bad_csrf_token');
        const created = await change('create-reading-list',{name:'  Для   проверки  '});
        assert.equal(created.list?.name,'Для проверки',created.error);
        const listId = created.list.id;
        assert.match((await change('create-reading-list',{name:'для проверки'})).error,/уже существует/);
        assert.equal((await change('update-reading-list-book',{listId,bookUid:'absent',enabled:true})).error,'404 Файл не найден');

        const renamed = await change('rename-reading-list',{listId,name:'Личная полка'});
        assert.equal(renamed.list.name,'Личная полка');
        const visibility = await change('set-reading-list-visibility',{listId,visibility:'opds',opds:{pinned:true,grouping:'series'}});
        assert.deepEqual(visibility.list.opds,{pinned:true,grouping:'series'});
        const smart = await change('create-reading-list',{name:'Ещё не прочитано',filters:{lang:'en',unreadOnly:true}});
        assert.equal(smart.list?.filters.unreadOnly,true,smart.error);
        const before = await change('get-reading-list',{listId:smart.list.id});
        assert.equal(before.books.length,2,before.error);
        assert.match((await change('update-reading-list-book',{listId:smart.list.id,bookUid:shelfUid,enabled:true})).error,/определяется фильтрами/);

        const added = await change('update-reading-list-book',{listId,bookUid:shelfUid,enabled:true});
        assert.equal(added.list.bookCount,1);
        const marked = await change('set-reading-list-book-read',{listId,bookUid:shelfUid,read:true});
        assert.equal(marked.list.readCount,1);
        const state = await change('get-reader-state',{bookUid:shelfUid});
        assert.equal(state.progress.percent,1);
        const result = await change('get-reading-list',{listId});
        assert.equal(result.books[0]._uid,shelfUid);
        assert.equal(result.books[0]._readingListRead,true);
        assert.deepEqual(result.books[0]._readerProgress,{percent:1,started:true});
        const history = await change('get-user-reading-library',{options:{state:'all',sort:'progressDesc',limit:1}});
        assert.deepEqual(history.counters,{all:2,reading:1,read:1,hidden:0},history.error);
        assert.equal(history.count,2);
        assert.deepEqual(history.items.map(book=>[book.bookUid,book.state]),[[shelfUid,'read']]);
        const historySearch = await change('get-user-reading-library',{options:{state:'reading',query:'PACKAGED smoke'}});
        assert.equal(historySearch.items[0].bookUid,readingUid);
        assert.equal(historySearch.items[0].percent,0.35);
        assert.deepEqual((await change('get-reading-list',{listId:smart.list.id})).books.map(book=>book._uid),[readingUid]);
        const pinned = await change('get-reading-lists',{bookUid:shelfUid,options:{visibility:'opds'}});
        assert.equal(pinned.lists.length,1);
        assert.equal(pinned.lists[0].containsBook,true);
        assert.equal(pinned.lists[0].readBook,true);

        const {csrfToken:adminCsrf} = await admin.request({action:'get-config'});
        const logged = await admin.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken:adminCsrf});
        assert(logged.profileAccessToken,logged.error);
        assert.equal((await admin.request({action:'get-reading-list',userId:'admin',listId,options:{allowForeign:true}})).error,'Список не найден');
        const deleted = await change('delete-reading-list',{listId:smart.list.id});
        assert.equal(deleted.success,true);
        assert.equal((await change('get-reading-list',{listId:smart.list.id})).error,'Список не найден');
        const restored = await change('get-reader-state',{bookUid:readingUid});
        assert.equal(restored.progress.percent,0.35);
        assert.equal(restored.progress.revision,1);
        console.log('ok standalone shelf CRUD, smart unread filter, read marks, CSRF and profile isolation');
        return listId;
    } finally { guest.close(); admin.close(); }
}

async function verifyEpubReader(binary, root) {
    await fs.mkdir(root);
    const archive = join(root,'epub.inpx');
    const epub = join(root,'book.epub');
    await require('./epub-fb2-tests').fixture(epub);
    const original = await fs.readFile(epub);
    const row = ['Тестовый,Автор:', 'prose:', 'Книга EPUB', '', '0', '1', String(original.length), '1',
        '0','epub','2026-11-16','ru','0',''];
    await fs.writeFile(archive,await zip([['collection.info','EPUB fixture\n'],['epub.inp',row.join('\x04')+'\n']]));
    await fs.writeFile(join(root,'epub.zip'),await zip([['1.epub',original]]));
    const config = join(root,'config.json'), web = join(root,'web.json');
    await bundle(web);
    const settings = {server:{host:'127.0.0.1',root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        librarySources:[{id:'epub',inpx:archive}], conversionFormats:['fb2']};
    await fs.writeFile(config,JSON.stringify(settings));
    const args = ['--standalone','--data-dir='+join(root,'data'),'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const server = await start(binary,args);
    try {
        const feeds = await (await fetch(server.url+'/catalogue/v2/search?query=EPUB')).json();
        const links = feeds.publications[0].links;
        const detail = links.find(link=>link.rel==='self');
        const uid = new URL(detail.href,server.url).searchParams.get('uid');
        const ws = await wsClient(server.url,await browserCookie(server.url));
        try {
            const config = await ws.request({action:'get-config'});
            assert.deepEqual(config.conversionFormats,['fb2']);
            const response = await ws.request({action:'get-book-info',bookUid:uid,readerOnly:true});
            const info = response.bookInfo;
            assert(info,response.error);
            assert.equal(info.book.ext,'epub');
            assert.deepEqual(info.contents.slice(0,2).map(item=>item.title),['Вторая глава','Первая глава']);
            const doc = new (require('../server/core/fb2/Fb2Parser'))(info.fb2);
            const text = doc.$$('/body/').toString();
            assert.match(text,/Текст второй главы/);
            assert(!text.includes('dangerous()'));
            assert.equal(doc.$$array('/binary').length,1);
            assert.equal((await fetch(server.url+info.cover)).headers.get('content-type'),'image/png');
        } finally { ws.close(); }
        const converted = await fetch(server.url+links.find(link=>link.type==='application/fb2+xml').href);
        assert.equal(converted.status,200);
        assert.match(converted.headers.get('content-type'),/application\/x-fictionbook\+xml/);
        assert.match(await converted.text(),/Текст второй главы/);
        const unchanged = await fetch(server.url+links.find(link=>link.type==='application/epub+zip').href);
        assert.equal(unchanged.status,200);
        assert((await bytes(unchanged)).equals(original));
    } finally { await server.stop(); }
    await fs.writeFile(config,JSON.stringify({...settings,conversionEnabled:false,onlineReaderEnabled:false}));
    const disabled = await start(binary,args);
    try {
        const feed = await (await fetch(disabled.url+'/catalogue/v2/search?query=EPUB')).json();
        assert(!feed.publications[0].links.some(link=>link.type==='application/fb2+xml'));
        const uid = new URL(feed.publications[0].links.find(link=>link.rel==='self').href,disabled.url).searchParams.get('uid');
        assert.equal((await fetch(disabled.url+'/reader/book/by-uid?'+new URLSearchParams({uid,format:'fb2'}))).status,404);
        const ws = await wsClient(disabled.url,await browserCookie(disabled.url));
        try { assert.equal((await ws.request({action:'get-config'})).onlineReaderEnabled,false); }
        finally { ws.close(); }
    } finally { await disabled.stop(); }
    const override = await start(binary,args,{INPX_ENABLE_CONVERSION:'true'});
    try {
        const feed = await (await fetch(override.url+'/catalogue/v2/search?query=EPUB')).json();
        assert(feed.publications[0].links.some(link=>link.type==='application/fb2+xml'));
    } finally { await override.stop(); }
    console.log('ok standalone EPUB reader conversion, acquisition and original download');
}

async function verifyDownloads(url, card, root, archive, loose, folderUid, looseBytes) {
    const zipReader = require('node-stream-zip').async;
    const zip = new zipReader({file:archive});
    let stored;
    try { stored = await zip.entryData('1.fb2'); }
    finally { await zip.close(); }
    const original = Buffer.from(stored.toString('utf8').replace('encoding="UTF-8"','encoding="utf-8"'));
    const raw = card.links.find(link=>link.type==='application/fb2+xml' && link.rel==='http://opds-spec.org/acquisition');
    assert(raw,'OPDS card advertises an original FB2 download');
    const redirect = await fetch(url+raw.href+'&filename=ascii',{redirect:'manual'});
    assert.equal(redirect.status,302);
    const target = redirect.headers.get('location');
    assert.match(target,/^\/reader\/book\/[a-f0-9]{64}\/raw\/[^?]+\.fb2\?uid=/);
    const head = await fetch(url+target,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(head.headers.get('content-length'),String(original.length));
    assert.equal(head.headers.get('content-disposition'),'attachment; filename="Packaged smoke book Test.fb2"');
    assert.match(head.headers.get('content-type'),/^application\/x-fictionbook\+xml/);
    const etag = head.headers.get('etag');
    assert(etag);
    const partial = await fetch(url+target,{headers:{range:'bytes=7-21'}});
    assert.equal(partial.status,206);
    assert.equal(partial.headers.get('content-range'),'bytes 7-21/'+original.length);
    assert.deepEqual(await bytes(partial),original.subarray(7,22));
    const unsatisfiable = await fetch(url+target,{headers:{range:'bytes=999999-'}});
    assert.equal(unsatisfiable.status,416);
    assert.equal(unsatisfiable.headers.get('content-range'),'bytes */'+original.length);
    assert.equal((await fetch(url+target,{cache:'force-cache',headers:{'if-none-match':etag}})).status,304);
    const rawWhole = await fetch(url+target);
    assert.deepEqual(await bytes(rawWhole),original);

    const uid = new URL(target,url).searchParams.get('uid');
    const untyped = await fetch(url+'/reader/book/by-uid?'+new URLSearchParams({uid}),{redirect:'manual'});
    const content = untyped.headers.get('location');
    const gzip = await fetch(url+content,{headers:{'accept-encoding':'gzip'}});
    assert.equal(gzip.headers.get('content-encoding'),'gzip');
    assert.match(gzip.headers.get('content-disposition'),/filename\*=UTF-8''/);
    assert.deepEqual(await bytes(gzip),original);
    const rawNegotiated = await fetch(url+content,{headers:{'accept-encoding':'gzip;q=0, *;q=1'}});
    assert.equal(rawNegotiated.headers.get('content-encoding'),null);
    assert.deepEqual(await bytes(rawNegotiated),original);
    const bundled = await fetch(url+'/reader/book/by-uid?'+new URLSearchParams({uid,zip:'1'}));
    assert.equal(bundled.headers.get('content-type'),'application/zip');
    assert(new URL(bundled.url).pathname.endsWith('.zip'));
    const extracted = join(root,'download.zip');
    await fs.writeFile(extracted,await bytes(bundled));
    const downloadZip = new zipReader({file:extracted});
    try {
        const members = Object.values(await downloadZip.entries());
        assert.deepEqual(members.map(member=>member.name),['Packaged smoke book Тест.fb2']);
        assert.deepEqual(await downloadZip.entryData(members[0].name),original);
    } finally { await downloadZip.close(); }

    const sevenZip = require('../server/core/ExternalTools').sevenZipCommandCandidates()
        .find(tool=>spawnSync(tool,['i'],{windowsHide:true,stdio:'ignore'}).status===0);
    if (sevenZip) {
        const input = join(root,'sevenzip-input');
        const substitute = join(dirname(archive),'smoke.7z');
        const retained = archive+'.original';
        await fs.mkdir(input);
        await fs.writeFile(join(input,'1.fb2'),stored);
        execFileSync(sevenZip,['a','-t7z','-mx=1','-mmt=1',substitute,'1.fb2'],{cwd:input,windowsHide:true,stdio:'ignore'});
        await fs.rename(archive,retained);
        try {
            const materialized = await fetch(url+raw.href);
            assert.equal(materialized.status,200);
            assert.deepEqual(await bytes(materialized),original);
        } finally {
            await fs.rename(retained,archive);
            await fs.unlink(substitute);
        }
        console.log('ok standalone ZIP-to-7z archive lookup without an external runtime decoder');
    }

    const escaped = join(root,'outside-files');
    const nested = join(loose,'nested');
    const normal = join(loose,'original');
    await fs.mkdir(escaped);
    await fs.writeFile(join(escaped,'second.fb2'),'<FictionBook>outside fixture</FictionBook>');
    await fs.rename(nested,normal);
    await fs.symlink(escaped,nested,process.platform==='win32'?'junction':'dir');
    const looseRoute = url+'/reader/book/by-uid?'+new URLSearchParams({uid:folderUid,format:'raw'});
    try {
        assert.equal((await fetch(looseRoute)).status,404);
    } finally {
        await fs.unlink(nested);
        await fs.rename(normal,nested);
    }
    const folderBook = await fetch(looseRoute);
    assert.equal(folderBook.status,200);
    assert.deepEqual(await bytes(folderBook),looseBytes);
    const wrongBook = new URL(target,url);
    wrongBook.searchParams.set('uid',folderUid);
    assert.equal((await fetch(wrongBook)).status,404);
    console.log('ok standalone original downloads, ZIP, gzip, ranges, conditional requests and source containment');
}

async function assertCatalogue(url, root) {
    const jsonRoot = root+'/v2';
    async function load(href, type) {
        const response = await fetch(url+href);
        assert.equal(response.status,200,href);
        assert(response.headers.get('content-type').startsWith(type),href);
        return response;
    }
    const read = async href=>(await load(href,'application/opds+json')).json();
    const parseXml = body=>{
        const nodes = [];
        const parser = require('sax').parser(true);
        parser.onerror = error=>{throw error;};
        parser.onopentag = tag=>nodes.push(tag);
        parser.write(body).close();
        return nodes;
    };
    const home = await read(jsonRoot+'/');
    assert.equal(home.metadata.title,'Standalone OPDS fixture');
    assert.deepEqual(home.navigation.map(link=>link.href),['author','series','title','genre'].map(name=>jsonRoot+'/'+name));
    const search = home.links.find(link=>link.rel==='search');
    assert.equal(search.href,jsonRoot+'/search{?query}');
    assert.equal(search.templated,true);

    const first = await read(search.href.replace('{?query}','?query=Маршрут'));
    assert.equal(first.publications.length,100);
    const next = first.links.find(link=>link.rel==='next');
    assert(next);
    assert.equal(new URL(next.href,url).searchParams.get('page'),'2');
    const second = await read(next.href);
    assert.equal(second.publications.length,5);
    assert.equal(new Set([...first.publications,...second.publications].map(book=>book.metadata.identifier)).size,105);
    assert.equal((await read(jsonRoot+'/search?query=no-such-book')).metadata.numberOfItems,0);
    const filtered = await read(jsonRoot+'/search?query=Маршрут&genre=custom_test');
    assert.equal(filtered.publications,undefined);

    const atom = parseXml(await (await load(root,'application/atom+xml')).text());
    assert.equal(atom.find(tag=>tag.name==='feed').attributes.xmlns,'http://www.w3.org/2005/Atom');
    assert(atom.some(tag=>tag.name==='link'&&tag.attributes.href===root+'/author'));
    const open = parseXml(await (await load(root+'/opensearch','application/opensearchdescription+xml')).text());
    assert.deepEqual(open.filter(tag=>tag.name==='Url').map(tag=>tag.attributes.template),
        ['title','author','series'].map(kind=>root+'/search?type='+kind+'&term={searchTerms}'));
    const atomSearch = root+'/search?type=title&term='+encodeURIComponent('Маршрут');
    const normal = await (await load(atomSearch,'application/atom+xml')).text();
    const posted = await fetch(url+atomSearch,{method:'POST'});
    assert.equal(posted.status,200);
    assert.equal(await posted.text(),normal);
    const atomBooks = parseXml(normal);
    assert.equal(atomBooks.filter(tag=>tag.name==='entry').length,100);
    assert(atomBooks.some(tag=>tag.name==='link'&&tag.attributes.rel==='http://opds-spec.org/acquisition'));
    assert(atomBooks.some(tag=>tag.name==='link'&&tag.attributes.rel===undefined),'Tolino navigation link');
    assert.equal((await fetch(url+jsonRoot,{method:'POST'})).status,405);
    assert.equal((await fetch(url+jsonRoot+'/unknown')).status,404);
    assert.equal((await fetch(url+jsonRoot+'?user=unknown')).status,404);

    const authorNames = await read(jsonRoot+'/author');
    const author = authorNames.navigation.find(link=>link.title==='Tester Smoke');
    assert(author,'exact author navigation');
    const byAuthor = await read(author.href);
    const authorSeries = byAuthor.navigation.find(link=>link.title==='Серия: Маршрут');
    assert(authorSeries);
    const bySeries = await read(authorSeries.href);
    assert.equal(bySeries.metadata.numberOfItems,105);
    assert.equal(bySeries.metadata.currentPage,1);
    assert.match(bySeries.publications[0].metadata.title,/^1\. /);
    const volumes = await read(bySeries.links.find(link=>link.rel==='next').href);
    assert.equal(volumes.metadata.currentPage,2);
    assert.match(volumes.publications.at(-1).metadata.title,/^105\. /);
    assert.equal(new URL(volumes.links.find(link=>link.rel==='previous').href,url).searchParams.get('v2page'),'1');
    const byTitle = await read(jsonRoot+'/title?title='+encodeURIComponent('=Маршрут 001'));
    assert.equal(byTitle.publications[0].metadata.identifier,bySeries.publications[0].metadata.identifier);
    const titleIndex = await read(jsonRoot+'/title');
    const titleGroup = titleIndex.navigation.find(link=>link.title==='М~');
    assert(titleGroup,'large title indexes expose prefix groups');
    const genres = await read(jsonRoot+'/genre?from=title');
    const fantasy = genres.navigation.find(link=>link.title==='Фантастика');
    assert(fantasy);
    const genre = (await read(fantasy.href)).navigation.find(link=>link.title==='Космическая фантастика');
    assert.equal(new URL(genre.href,url).searchParams.get('genre'),'sf_space');
    const matching = await read(genre.href);
    assert(matching.navigation.some(link=>link.href===titleGroup.href+'&genre=sf_space'));
    assert(!matching.navigation.some(link=>link.title==='Elsewhere'));

    const firstBook = bySeries.publications[0];
    const href = firstBook.links.find(link=>link.rel==='self').href;
    const card = await load(href,'application/opds-publication+json');
    const tag = card.headers.get('etag');
    assert.equal((await card.json()).metadata.identifier,firstBook.metadata.identifier);
    const head = await fetch(url+href,{method:'HEAD'});
    assert.equal(head.headers.get('etag'),tag);
    assert.equal(await head.text(),'');
    assert.equal((await fetch(url+href,{cache:'force-cache',headers:{'if-none-match':tag}})).status,304);
    const file = await load(firstBook.links.find(link=>link.type==='application/fb2+xml').href,
        'application/x-fictionbook+xml');
    assert.match(await file.text(),/OPDS fixture/);
}

async function verifyCatalogue(binary, root) {
    await fs.mkdir(root);
    const inpx = join(root,'paging.inpx');
    const settings = join(root,'config.json');
    const web = join(root,'web.json');
    const rows = Array.from({length:107},(_,index)=>{
        const id = String(index+1);
        const other = index===106;
        const title = other ? 'Elsewhere' : 'Маршрут '+id.padStart(3,'0');
        return ['Tester,Smoke:',other ? 'custom_test:' : 'sf_space:',title,other ? 'Other' : 'Маршрут',
            id,id,'67',id,index===105 ? '1' : '0','fb2','2026-11-16','ru','0',''].join('\x04');
    });
    await fs.writeFile(inpx,await zip([
        ['collection.info','Standalone OPDS fixture\n'],
        ['paging.inp',rows.join('\n')+'\n'],
    ]));
    await fs.writeFile(join(root,'paging.zip'),await zip([
        ['1.fb2','<FictionBook><body><section><p>OPDS fixture</p></section></body></FictionBook>'],
    ]));
    await bundle(web);
    const opds = {enabled:true,root:'/catalogue',compatibility:'tolino'};
    const config = {server:{host:'127.0.0.1',root:'/reader'},opds,librarySources:[{id:'catalogue',inpx}]};
    await fs.writeFile(settings,JSON.stringify(config));
    const data = join(root,'data');
    const args = ['--standalone','--data-dir='+data,'--config='+settings,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const server = await start(binary,args);
    try {
        await assertCatalogue(server.url,opds.root);
    } finally { await server.stop(); }
    console.log('ok standalone OPDS 1 and 2, OpenSearch, navigation, search, pagination and acquisition');
    await verifySharedOpdsShelves(binary,args,data,opds.root);

    const release = process.env.INPX_STANDALONE_COMPAT_PACKAGE;
    if (release) {
        const existing = join(root,'existing-data');
        const existingConfig = join(root,'existing-config.json');
        await fs.writeFile(existingConfig,JSON.stringify({...config,dataDir:existing}));
        const state = join(existing,'db','catalogue.json');
        const existingArgs = args.filter(value=>!value.startsWith('--data-dir=') && !value.startsWith('--config='));
        existingArgs.push('--data-dir='+existing,'--config='+existingConfig);
        const compatibility = await start(resolve(release),existingArgs.filter(value=>value!=='--standalone' && !value.startsWith('--web-bundle=')));
        try {
            assert.equal((await fetch(compatibility.url+opds.root+'/v2/')).status,200);
        } finally { await compatibility.stop(); }
        const generation = (await readJson(state)).rustBookStoreGeneration;
        assert(generation,'the existing release wrote a native book store');
        const migrated = await start(binary,existingArgs);
        try {
            await assertCatalogue(migrated.url,opds.root);
            assert.equal((await readJson(state)).rustBookStoreGeneration,generation);
        } finally { await migrated.stop(); }
        console.log('ok standalone OPDS reuses a catalogue indexed by the existing package');
    }

    await fs.writeFile(settings,JSON.stringify({...config,opds:{...opds,compatibility:'standard'}}));
    const fromEnvironment = await start(binary,args,{INPX_OPDS_COMPATIBILITY:'tolino'});
    try {
        assert.equal((await fetch(fromEnvironment.url+opds.root,{method:'POST'})).status,200);
    } finally { await fromEnvironment.stop(); }
    const invalidCompatibility = spawnSync(binary,args,{
        env:{...environment(),INPX_OPDS_COMPATIBILITY:'invalid'},encoding:'utf8',timeout:12000,windowsHide:true,
    });
    assert.notEqual(invalidCompatibility.status,0);
    assert.match(invalidCompatibility.stderr,/INPX_OPDS_COMPATIBILITY/);

    await fs.writeFile(settings,JSON.stringify({...config,opds:{...opds,enabled:false}}));
    const disabled = await start(binary,args);
    try {
        assert.equal((await fetch(disabled.url+opds.root)).status,404);
        assert.equal((await fetch(disabled.url+opds.root+'/v2')).status,404);
    } finally { await disabled.stop(); }
}

async function verifySharedOpdsShelves(binary, args, data, root) {
    const env = {INPX_OPDS_FEEDS_FILE:'opds-feeds.json'};
    const path = join(data,'opds-feeds.json'), jsonRoot = root+'/v2';
    const shelf = {id:'routes',name:'Routes',filters:{genre:'sf_space'}};
    const configured = {version:1,shelves:[shelf,{...shelf,id:'grouped',name:'Grouped routes',grouping:'series'},
        {...shelf,id:'authors',name:'By author',grouping:'authors'},{...shelf,id:'disabled',active:false}]};
    await fs.writeFile(path,'\ufeff'+JSON.stringify(configured));
    const server = await start(binary,args,env);
    let bookmark;
    try {
        const get = async href => {
            const reply = await fetch(server.url+href);
            assert.equal(reply.status,200,href);
            return reply.json();
        };
        const rootFeed = await get(jsonRoot);
        assert.deepEqual(rootFeed.navigation.filter(link=>link.href.includes('/catalog-shelves')).map(link=>link.title),['Routes','Grouped routes','By author']);
        const plain = await get(jsonRoot+'/catalog-shelves?id=routes&genre=custom_test&unreadOnly=true');
        assert.equal(plain.publications.length,50);
        const next = plain.links.find(link=>link.rel==='next');
        assert.equal(new URL(next.href,server.url).searchParams.get('page'),'2');
        const page2 = await get(next.href);
        const page3 = await get(page2.links.find(link=>link.rel==='next').href);
        assert.equal(page3.publications.length,5);
        assert.equal(new Set([plain,page2,page3].flatMap(feed=>feed.publications.map(book=>book.metadata.identifier))).size,105);
        const atom = await (await fetch(server.url+root+'/catalog-shelves?id=routes')).text();
        assert.match(atom,/rel="next"/);
        assert.equal((atom.match(/<entry>/g) || []).length,51);
        assert.equal((await fetch(server.url+jsonRoot+'/catalog-shelves?id=disabled')).status,404);

        const groups = await get(jsonRoot+'/catalog-shelves?id=grouped');
        assert.equal(groups.navigation[0].title,'Маршрут (105)');
        bookmark = groups.navigation[0].href;
        assert.match(new URL(bookmark,server.url).searchParams.get('group'),/^\d+$/);
        const ordered = await get(bookmark);
        assert.deepEqual(ordered.publications.slice(0,2).map(book=>book.metadata.belongsTo.series[0].position),[1,2]);
        assert.equal((await fetch(server.url+jsonRoot+'/catalog-shelves?id=grouped&group=999999')).status,404);
        const authors = await get(jsonRoot+'/catalog-shelves?id=authors');
        assert.equal(authors.navigation.length,1);
        assert.match(authors.navigation[0].title,/Tester Smoke \(105\)/);

        await fs.writeFile(path,JSON.stringify({version:1,shelves:[{...shelf,filters:{unreadOnly:true,lang:'ru'}}]}));
        assert((await get(jsonRoot)).navigation.some(link=>link.title==='Общие подборки временно недоступны'));
        assert.equal((await fetch(server.url+jsonRoot+'/catalog-shelves?id=routes')).status,503);
        assert.equal((await fetch(server.url+jsonRoot+'/title')).status,200);
        await fs.writeFile(path,JSON.stringify({version:1,shelves:[{...shelf,name:'Reloaded',filters:{genre:'custom_test'}}]}));
        const reloaded = await get(jsonRoot+'/catalog-shelves?id=routes');
        assert.equal(reloaded.metadata.title,'Reloaded');
        assert.equal(reloaded.publications.length,1);
        assert.match(reloaded.publications[0].metadata.title,/Elsewhere/);
        assert.equal((await fetch(server.url+bookmark)).status,404);
    } finally { await server.stop(); }

    const protectedServer = await start(binary,args,{...env,INPX_ALLOW_ANONYMOUS_ACCESS:'false'});
    try {
        assert.equal((await fetch(protectedServer.url+jsonRoot+'/catalog-shelves?id=routes')).status,401);
    } finally { await protectedServer.stop(); }

    const release = process.env.INPX_STANDALONE_COMPAT_PACKAGE;
    if (release) {
        await fs.writeFile(path,JSON.stringify(configured));
        const compatibility = await start(resolve(release),args.filter(arg=>arg!=='--standalone' && !arg.startsWith('--web-bundle=')),env);
        try {
            const reply = await fetch(compatibility.url+bookmark);
            assert.equal(reply.status,200);
            assert.equal((await reply.json()).publications.length,50);
        } finally { await compatibility.stop(); }
    }
    console.log('ok standalone shared OPDS shelves preserve group links, pagination and live configuration changes');
}

async function verifyAccess(binary, args, data, settings, config, detail) {
    const registry = join(data,'reading-lists.json');
    const profiles = await readJson(registry);
    const digest = value=>createHash('sha256').update(value).digest('hex');
    const password = 'пароль:fixture';
    const appPassword = 'inpx_'+Buffer.alloc(24,12).toString('base64url');
    const totp = require('../server/core/ProfileTotp');
    const secretStore = new (require('../server/core/SecretStore'))({dataDir:data});
    const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const enrollment = await totp.enable(secretStore,'otp-fixture',totpSecret,-1);
    const scoped = {id:'personal-fixture',login:'alice',name:'Protected fixture',opdsEnabled:true,opdsAuthEnabled:true,
        passwordHash:digest('alice::'+password)};
    const otp = {id:'otp-fixture',login:'boxuser',name:'OPDS app password fixture',opdsEnabled:true,opdsAuthEnabled:true,
        passwordHash:digest('boxuser::'+password),profileTotp:enrollment.state,
        opdsAppPasswordHash:digest(appPassword)};
    const uid = new URL(detail,'http://example.invalid').searchParams.get('uid');
    scoped.readerProgress = {[uid]:{percent:0.21,updatedAt:'2026-11-16T10:00:00.000Z',textSnippet:'private snippet'}};
    profiles.lists.push({id:'published-fixture',userId:scoped.id,name:'Published fixture',visibility:'opds',
        books:[{bookUid:uid,read:true}],opds:{grouping:'authors',pinned:true}},
        {id:'private-fixture',userId:scoped.id,name:'Private fixture',visibility:'private',books:[uid]});
    profiles.users.push(scoped,otp,
        {id:'blocked-fixture',login:'blocked',name:'Blocked fixture',opdsEnabled:true,blocked:true},
        {id:'public-fixture',login:'publicreader',name:'Public fixture',opdsEnabled:true});
    const updateProfiles = async document=>{
        const staging = registry+'.fixture';
        await fs.writeFile(staging,JSON.stringify(document));
        await fs.rename(staging,registry);
    };
    await updateProfiles(profiles);

    const basic = (user, secret)=>({authorization:'Basic '+Buffer.from(user+':'+secret).toString('base64')});
    const alice = basic('ALICE',password);
    const passwordOnly = basic(otp.login,password);
    const app = basic(otp.login,appPassword);
    const root = settings.opds.root;
    const jsonRoot = root+'/v2';
    const feed = jsonRoot+'?user='+scoped.login;
    const otpFeed = jsonRoot+'?user='+otp.login;
    const byUid = '/reader/book/by-uid?'+new URLSearchParams({uid:new URL(detail,'http://example.invalid').searchParams.get('uid'),format:'raw'});
    const check = async (server, path, status, options={})=>{
        const response = await fetch(server.url+path,options);
        assert.equal(response.status,status,path);
        if (status===401) {
            assert.equal(response.headers.get('www-authenticate'),'Basic realm="inpx-web OPDS", charset="UTF-8"');
            assert.equal(response.headers.get('cache-control'),'no-store');
        }
        return response;
    };
    const privateFeed = async (server, path, id, headers)=>{
        const response = await check(server,path,200,{headers});
        assert.equal(response.headers.get('cache-control'),'private, no-store');
        assert.match(response.headers.get('vary'),/Authorization.*Cookie/i);
        const payload = await response.json();
        for (const link of [...payload.links,...payload.navigation]) {
            assert.equal(new URL(link.href.replace('{&query}',''),server.url).searchParams.get('user'),id);
        }
        return payload;
    };

    const regular = await start(binary,args);
    try {
        await check(regular,jsonRoot,200);
        await check(regular,jsonRoot+'?user=missing',404);
        await check(regular,jsonRoot+'?user=blocked-fixture',404);
        await check(regular,feed,401);
        const privatePage = await privateFeed(regular,feed,scoped.id,alice);
        assert.match(privatePage.links.find(link=>link.rel==='search').href,/\{&query\}$/);
        const listPath = jsonRoot+'/reading-lists/list?id=published-fixture';
        const identity = await (await check(regular,jsonRoot+'/reading-profiles',200)).json();
        assert(identity.navigation.some(link=>link.title==='Protected fixture' && new URL(link.href,regular.url).searchParams.get('user')===scoped.login));
        assert(privatePage.navigation.some(link=>link.title==='Published fixture' && link.href.includes('/reading-lists/list')));
        assert(!privatePage.navigation.some(link=>link.title==='Private fixture'));
        await check(regular,listPath,404);
        await check(regular,listPath+'&user=alice',401);
        await check(regular,listPath+'&user=publicreader',404);
        await check(regular,jsonRoot+'/reading-lists/list?id=private-fixture&user=alice',404,{headers:alice});
        const lists = await (await check(regular,jsonRoot+'/reading-lists?user=alice',200,{headers:alice})).json();
        assert.deepEqual(lists.navigation.map(link=>link.title),['Published fixture']);
        const groups = await privateFeed(regular,listPath+'&user=alice',scoped.id,alice);
        const group = groups.navigation[0].href;
        const owned = await (await check(regular,group,200,{headers:alice})).json();
        assert(owned.publications[0].metadata.title.startsWith('✓ Packaged smoke book'));
        assert.match(owned.publications[0].metadata.description,/Прочитано/);
        const shelfAtom = await (await check(regular,group.replace('/v2/','/'),200,{headers:alice})).text();
        assert.match(shelfAtom,/Прочитано/);
        const xmlLinks = [];
        const parser = require('sax').parser(true);
        parser.onopentag = tag=>{ if (tag.name==='link') xmlLinks.push(new URL(tag.attributes.href,regular.url)); };
        parser.write(shelfAtom).close();
        assert(xmlLinks.some(link=>link.pathname===root+'/book' && link.searchParams.get('uid')===uid
            && link.searchParams.get('user')===scoped.id));
        const progress = await (await check(regular,jsonRoot+'/reading-progress?state=reading&user=alice',200,{headers:alice})).json();
        assert.equal(progress.publications[0].metadata.description,'21%');
        assert(!JSON.stringify(progress).includes('private snippet'));
        const changedVisibility = await readJson(registry);
        const published = changedVisibility.lists.find(item=>item.id==='published-fixture');
        published.visibility = 'private';
        await updateProfiles(changedVisibility);
        await check(regular,group,404,{headers:alice});
        published.visibility = 'opds';
        await updateProfiles(changedVisibility);
        assert.match((await readJson(registry)).users.find(user=>user.id===scoped.id).passwordHash,/^scrypt:v1:/);
        await check(regular,feed,200,{method:'HEAD',headers:alice});
        const changing = await readJson(registry);
        const collision = {id:scoped.login,name:'ID collision fixture',login:'',opdsEnabled:false};
        changing.users.push(collision);
        await updateProfiles(changing);
        await check(regular,feed,404,{headers:alice});
        changing.users.pop();
        await updateProfiles(changing);
        const atom = await (await check(regular,root+'/opensearch?user='+scoped.login,200,{headers:alice})).text();
        assert(atom.includes('&amp;user='+scoped.id));
        await privateFeed(regular,jsonRoot+'?user=publicreader','public-fixture');
        await check(regular,otpFeed,401,{headers:passwordOnly});
        await privateFeed(regular,otpFeed,otp.id,app);
        await check(regular,byUid,200);
    } finally { await regular.stop(); }

    const writeSettings = patch=>fs.writeFile(config,JSON.stringify({...settings,dataDir:data,...patch}));
    await writeSettings({allowAnonymousAccess:false});
    const restricted = await start(binary,args);
    try {
        await check(restricted,'/health',200);
        await check(restricted,jsonRoot,401);
        await check(restricted,byUid,401);
        const cookie = await browserCookie(restricted.url);
        const browser = await wsClient(restricted.url,cookie);
        try {
            const before = await browser.request({action:'get-config'});
            assert.equal(before.profileLoginRequired,true);
            assert.equal(before.profileAuthorized,false);
            assert.equal(before.dbConfig,undefined);
            assert.equal((await browser.request({action:'search',from:'title',query:{title:'Packaged'}})).error,'need_profile_login');
            const login = {action:'login-user-profile',login:'alice',password};
            assert.equal((await browser.request(login)).error,'bad_csrf_token');
            const result = await browser.request({...login,csrfToken:before.csrfToken});
            assert.equal(result.userId,scoped.id);
            assert.match(result.profileAccessToken,/^[a-f\d]{48}$/);
            const after = await browser.request({action:'get-config'});
            assert.equal(after.profileAuthorized,true);
            assert.equal(after.currentUserProfile.id,scoped.id);
            assert.match((await browser.request({action:'admin-reindex',csrfToken:after.csrfToken,userId:scoped.id})).error,/Только администратор/);
            assert.equal((await browser.request({action:'search',userId:otp.id,from:'title',query:{}})).error,'need_profile_login');
            await check(restricted,byUid,200,{headers:{cookie}});
            const forged = cookie.slice(0,-1)+(cookie.endsWith('0')?'1':'0');
            await check(restricted,byUid,401,{headers:{cookie:forged}});
            const next = await wsClient(restricted.url,await browserCookie(restricted.url));
            try {
                const fresh = await next.request({action:'get-config'});
                const resume = {action:'resume-user-profile',profileAccessToken:result.profileAccessToken,csrfToken:fresh.csrfToken};
                assert.equal((await next.request({...resume,userId:otp.id})).error,'need_profile_login');
                assert.equal((await next.request({...resume,userId:scoped.id})).userId,scoped.id);
            } finally { next.close(); }
            const changed = await readJson(registry);
            const owner = changed.users.find(user=>user.id===scoped.id);
            const savedHash = owner.passwordHash;
            owner.passwordHash = digest('alice::temporary-password');
            await updateProfiles(changed);
            await check(restricted,byUid,401,{headers:{cookie}});
            assert.equal((await browser.request({action:'get-config'})).profileAuthorized,false);
            owner.passwordHash = savedHash;
            await updateProfiles(changed);
            await check(restricted,byUid,401,{headers:{cookie}});
            assert.equal((await browser.request({action:'logout-user-profile',csrfToken:after.csrfToken})).success,true);
            await check(restricted,byUid,401,{headers:{cookie}});
        } finally { browser.close(); }
        const oneTime = await wsClient(restricted.url,await browserCookie(restricted.url));
        try {
            const {csrfToken} = await oneTime.request({action:'get-config'});
            const credentials = {action:'login-user-profile',login:otp.login,password,csrfToken};
            assert.equal((await oneTime.request({...credentials,password:appPassword})).errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
            assert.equal((await oneTime.request(credentials)).errorCode,'need_profile_otp');
            const code = totp.hotp(Buffer.from('12345678901234567890'),Math.floor(Date.now()/30000));
            assert.equal((await oneTime.request({...credentials,otp:code})).userId,otp.id);
            assert.equal((await oneTime.request({...credentials,otp:code})).errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
        } finally { oneTime.close(); }
        await privateFeed(restricted,jsonRoot,scoped.id,alice);
        const redirected = await check(restricted,byUid,302,{headers:alice,redirect:'manual'});
        assert.equal(redirected.headers.get('cache-control'),'private, no-store');
        const saved = redirected.headers.get('location');
        const download = await check(restricted,saved,200,{headers:alice});
        assert.equal(download.headers.get('cache-control'),'private, no-store');
        assert.match(await download.text(),/FictionBook/);
        await check(restricted,saved,401,{headers:{'if-none-match':download.headers.get('etag')}});
        const current = await readJson(registry);
        current.profileAuthPolicy.otpRequired = true;
        await updateProfiles(current);
        await check(restricted,jsonRoot,401,{headers:alice});
        await check(restricted,saved,401,{headers:passwordOnly});
        await privateFeed(restricted,jsonRoot,otp.id,app);
        await check(restricted,saved,200,{headers:app});
        current.users.find(user=>user.id===otp.id).opdsAppPasswordHash = '';
        await updateProfiles(current);
        await check(restricted,saved,401,{headers:app});
        current.users.find(user=>user.id===otp.id).opdsAppPasswordHash = otp.opdsAppPasswordHash;
        current.profileAuthPolicy.otpRequired = false;
        await updateProfiles(current);
    } finally { await restricted.stop(); }

    await writeSettings({opds:{...settings.opds,user:'shared-reader',password:'shared:fixture'},loginRateLimitMaxAttempts:3});
    const shared = await start(binary,args);
    try {
        const sharedHeaders = basic('shared-reader','shared:fixture');
        const unpadded = basic('shared-reader','shared:fixture');
        unpadded.authorization = unpadded.authorization.replace(/=+$/,'');
        assert.match((await readJson(config)).opds.password,/^enc:v1:/);
        const wrong = basic('shared-reader','wrong');
        for (let i=0;i<4;i++) await check(shared,jsonRoot,401);
        await check(shared,jsonRoot,401,{headers:wrong});
        await check(shared,jsonRoot,200,{headers:sharedHeaders});
        await check(shared,root,200,{headers:unpadded});
        await privateFeed(shared,feed,scoped.id,sharedHeaders);
        await check(shared,otpFeed,401,{headers:sharedHeaders});
        await privateFeed(shared,otpFeed,otp.id,app);
        await privateFeed(shared,jsonRoot,otp.id,app);
        await check(shared,jsonRoot,401,{headers:wrong});
        const limited = await check(shared,jsonRoot,429,{headers:{...sharedHeaders,'x-forwarded-for':'192.0.2.34'}});
        assert(Number(limited.headers.get('retry-after'))>0);
        await check(shared,jsonRoot,401);
        await check(shared,byUid,200);
    } finally { await shared.stop(); }
    console.log('ok standalone OPDS Basic authentication, shared and profile passwords, TOTP app passwords, protected downloads and rate limits');
}

async function verify(binary, root) {
    const collection = join(root,'fixture'), data = join(root,'data'), loose = join(root,'loose');
    const archive = join(collection,'smoke.inpx'), config = join(root,'settings.json'), web = join(root,'web.json');
    const db = join(data,'db');
    await createFixture(collection);
    const archived = join(collection,'archives','SMOKE.ZIP');
    await fs.mkdir(dirname(archived));
    await fs.rename(join(collection,'smoke.zip'),archived);
    await fs.mkdir(join(loose,'nested'),{recursive:true});
    const looseBytes = Buffer.from('<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Folder sample</book-title><lang>en</lang></title-info></description><body><section><p>'+('Example text. '.repeat(12500))+'</p></section></body></FictionBook>');
    await fs.writeFile(join(loose,'nested','second.fb2'),looseBytes);
    await bundle(web);
    const settings = {server:{host:'127.0.0.1',port:'0',root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        librarySources:[{id:'main',name:'Fixture INPX',inpx:archive},{id:'folder',name:'Folder',type:'folder',libDir:loose}]};
    await fs.writeFile(config,JSON.stringify(settings));
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const doc = 'a'.repeat(32);
    const key = createHash('md5').update('legacy-kosync-fixture').digest('hex');
    const headers = {'x-auth-user':'admin','x-auth-key':key,'Content-Type':'application/vnd.koreader.v1+json'};
    const kosync = '/reader/kosync';
    const position = kosync+'/syncs/progress/'+doc;
    const legacyProgress = {document:doc,progress:'17'+String.fromCharCode(0xd83d),percentage:0.3,device:'KOReader'};
    await fs.mkdir(data,{recursive:true});
    await fs.writeFile(join(data,'kosync.json'),JSON.stringify({version:1,accounts:{
        admin:{verifier:createHash('sha256').update(key).digest('hex'),documents:{
            [doc]:{...legacyProgress,timestamp:123456789,device_id:'before-upgrade'},
        }},
    },books:{}}));
    const first = await start(binary,args);
    let generation, detail, listId;
    try {
        assert.equal(first.ready.recsLoaded,2);
        const health = await fetch(first.url+'/health');
        assert.equal((await health.json()).status,'ok');
        const status = await (await fetch(first.url+'/api/index-status')).json();
        assert.deepEqual(status.sources.map(source=>source.id),['main','folder']);
        assert.equal(status.stats.bookCount,2);
        assert.deepEqual(await (await fetch(first.url+kosync+'/healthcheck')).json(),{state:'OK'});
        assert.equal((await fetch(first.url+kosync+'/users/create',{method:'POST'})).status,403);
        assert.equal((await fetch(first.url+position)).status,401);
        const oldProgress = await fetch(first.url+position,{headers});
        assert.equal(oldProgress.headers.get('cache-control'),'no-store');
        assert.deepEqual(await oldProgress.json(),{...legacyProgress,timestamp:123456789,device_id:'before-upgrade'});
        const update = await fetch(first.url+kosync+'/syncs/progress',{
            method:'PUT',headers,body:JSON.stringify({...legacyProgress,progress:'18',percentage:0.7}),
        });
        assert.equal(update.status,200);
        assert.equal((await update.json()).document,doc);
        assert.equal((await fetch(first.url+kosync+'/syncs/progress/invalid',{headers})).status,400);
        assert.match(await (await fetch(first.url+'/reader/')).text(),new RegExp('/reader/'+app+'/chunk.js'));
        assert.equal(await (await fetch(first.url+'/reader/'+app+'/chunk.js')).text(),'standalone assets');
        const metadata = await readJson(join(db,'catalogue.json'));
        generation = metadata.rustBookStoreGeneration;
        const catalog = join(dirname(binary),'inpx-catalog'+(process.platform==='win32'?'.exe':''));
        const {result} = JSON.parse(execFileSync(catalog,['store',db],{
            input:JSON.stringify({id:1,op:'scan',generation,limit:5})+'\n',encoding:'utf8',
            env:environment(),windowsHide:true,
        }));
        assert.deepEqual(result.rows.map(book=>book.title),['Packaged smoke book','Folder sample']);
        detail = '/catalogue/v2/book?uid='+encodeURIComponent(result.rows[0]._uid);
        const card = await fetch(first.url+detail);
        assert.equal(card.status,200);
        assert.match(card.headers.get('content-type'),/^application\/opds-publication\+json/);
        const publication = await card.json();
        assert.equal(publication.metadata.title,'Packaged smoke book');
        await verifySocket(first.url,result.rows[0]._uid);
        listId = await verifyShelves(first.url,result.rows[0]._uid,result.rows[1]._uid);
        await verifyDownloads(first.url,publication,root,archived,loose,result.rows[1]._uid,looseBytes);
        const duplicate = spawnSync(binary,args,{env:environment(),encoding:'utf8',timeout:12000,windowsHide:true});
        assert.notEqual(duplicate.status,0);
        assert.match(duplicate.stderr,/Database locked/);
    } finally { await first.stop(); }

    const original = await fs.readFile(join(data,'reading-lists.json'),'utf8');
    assert.equal(JSON.parse(original).users[0].id,'admin');
    await fs.rename(db,join(data,'db.previous'));
    const second = await start(binary,args);
    try {
        assert.equal((await readJson(join(db,'catalogue.json'))).rustBookStoreGeneration,generation);
        assert.equal(await fs.readFile(join(data,'reading-lists.json'),'utf8'),original);
        assert.equal((await fetch(second.url+detail)).status,200);
        const savedProgress = await (await fetch(second.url+position,{headers})).json();
        assert.equal(savedProgress.percentage,0.7);
        assert.equal(savedProgress.device_id,'');
        const uid = new URL(detail,second.url).searchParams.get('uid');
        const ws = await wsClient(second.url,await browserCookie(second.url));
        try {
            const reading = await ws.request({action:'get-reader-state',bookUid:uid});
            assert.equal(reading.progress.percent,0.35,reading.error);
            assert.equal(reading.progress.revision,1);
            const shelf = await ws.request({action:'get-reading-list',userId:'default',listId});
            assert.equal(shelf.list?.name,'Личная полка',shelf.error);
            assert.equal(shelf.books[0]._readingListRead,true);
        } finally { ws.close(); }
    } finally { await second.stop(); }
    const disabled = await start(binary,args,{INPX_KOSYNC_ENABLED:'false'});
    try {
        assert.equal((await fetch(disabled.url+kosync+'/healthcheck')).status,404);
        assert.equal((await fetch(disabled.url+position,{headers})).status,404);
    } finally { await disabled.stop(); }
    console.log('ok standalone KOSync prefixed API, existing account, restart and disabled routes');

    const release = process.env.INPX_STANDALONE_COMPAT_PACKAGE;
    if (release) {
        const compatibility = await start(resolve(release),args.filter(arg=>arg!=='--standalone' && !arg.startsWith('--web-bundle=')));
        const uid = new URL(detail,compatibility.url).searchParams.get('uid');
        try {
            const status = await (await fetch(compatibility.url+'/api/index-status')).json();
            assert.equal(status.stats.bookCount,2);
            assert.equal((await readJson(join(db,'catalogue.json'))).rustBookStoreGeneration,generation);
            assert.equal((await fetch(compatibility.url+detail)).status,200);
            const rollbackPosition = await fetch(compatibility.url+position,{headers});
            assert.equal(rollbackPosition.status,200);
            assert.equal((await rollbackPosition.json()).percentage,0.7);
            const rollbackUpdate = await fetch(compatibility.url+kosync+'/syncs/progress',{
                method:'PUT',headers,body:JSON.stringify({...legacyProgress,progress:'19',percentage:0.8}),
            });
            assert.equal(rollbackUpdate.status,200);
            const cookie = (await fetch(compatibility.url+'/reader/')).headers.get('set-cookie').split(';')[0];
            const ws = await wsClient(compatibility.url,cookie);
            try {
                const current = await ws.request({action:'get-reader-state',userId:'default',bookUid:uid});
                assert.equal(current.progress.percent,0.35,current.error);
                assert.equal(current.progress.revision,1);
                const shelf = await ws.request({action:'get-reading-list',userId:'default',listId});
                assert.equal(shelf.list?.name,'Личная полка',shelf.error);
                assert.deepEqual(shelf.books.map(book=>[book.title,book._readerProgress.percent,book._readingListRead]),[['Folder sample',1,true]]);
                const {csrfToken} = await ws.request({action:'get-config',userId:'default'});
                const written = await ws.request({action:'update-reader-progress',userId:'default',bookUid:uid,csrfToken,
                    progress:{percent:0.55,generation:current.progressGeneration,baseRevision:1,sectionId:'legacy-package'}});
                assert.equal(written.progress?.revision,2,written.error);
            } finally { ws.close(); }
        } finally { await compatibility.stop(); }
        console.log('ok release package reopens the catalogue published by standalone Rust');
        const reopened = await start(binary,args);
        try {
            const imported = await (await fetch(reopened.url+position,{headers})).json();
            assert.equal(imported.percentage,0.8);
            const ws = await wsClient(reopened.url,await browserCookie(reopened.url));
            try {
                const progress = await ws.request({action:'get-reader-state',bookUid:uid});
                assert.equal(progress.progress.percent,0.55,progress.error);
                assert.equal(progress.progress.sectionId,'legacy-package');
                assert.equal(progress.progress.revision,2);
            } finally { ws.close(); }
        } finally { await reopened.stop(); }
        console.log('ok reader and KOSync progress moves between standalone Rust and the existing release');
    }

    await verifyAccess(binary,args,data,settings,config,detail);
    await verifyProxy(binary,args,data,settings,config,detail);
    console.log('ok standalone Rust startup, INPX and folder catalogue, assets, OPDS publication, lock and restart');
}

async function verifyProxy(binary, args, data, settings, config, detail) {
    const registry = join(data,'reading-lists.json');
    const profiles = await readJson(registry);
    const aliceId = 'personal-fixture', denied = 'Профиль закреплён за пользователем proxy';
    const alice = {'X-Verified-User':' ALICE ','X-Forwarded-Proto':'https','X-Forwarded-Host':'books.example.invalid'};
    const origin = 'https://books.example.invalid';
    const uid = new URL(detail,'http://example.invalid').searchParams.get('uid');
    const env = {INPX_AUTH_MODE:'proxy',INPX_REQUIRE_AUTH:'true',INPX_TRUST_PROXY:'true',
        INPX_PROXY_AUTH_HEADER:'X-Verified-User',INPX_TRUSTED_PROXY_CIDRS:'127.0.0.1/32'};
    const check = async (server,path,status,options={})=>{
        const response = await fetch(server.url+path,options);
        assert.equal(response.status,status,path);
        return response;
    };
    await fs.writeFile(config,JSON.stringify({...settings,allowAnonymousAccess:false}));
    const untrusted = await start(binary,args,{...env,INPX_TRUSTED_PROXY_CIDRS:'192.0.2.0/24'});
    try {
        const spoofed = {...alice,'X-Forwarded-For':'192.0.2.1'};
        const reply = await check(untrusted,'/reader/',403,{headers:spoofed});
        assert.doesNotMatch(reply.headers.get('strict-transport-security')||'',/max-age/);
        await assert.rejects(wsClient(untrusted.url,null,{...spoofed,origin}),/403/);
    } finally { await untrusted.stop(); }

    await fs.writeFile(config,JSON.stringify({...settings,allowAnonymousAccess:false,authMode:'proxy',
        requireAuth:'true',trustProxy:true,proxyAuthHeader:'X-Verified-User',trustedProxyCidrs:['127.0.0.1/32'],
        authExemptHealth:false,loginRateLimitMaxAttempts:1}));
    const gated = await start(binary,args,{INPX_AUTH_MODE:'',INPX_PROXY_AUTH_HEADER:''},alice);
    try {
        await check(gated,'/ready',401);
        await check(gated,'/ready',200,{headers:alice});
        await check(gated,'/reader/',401,{headers:{'Remote-User':'alice'}});
        const shell = await check(gated,'/reader/',200,{headers:alice});
        assert.match(shell.headers.get('set-cookie'),/; Secure$/);
        const cookie = shell.headers.get('set-cookie').split(';')[0];
        const ws = await wsClient(gated.url,cookie,{...alice,origin,
            'X-Forwarded-For':'203.0.113.99, 198.51.100.22, 127.0.0.1'});
        try {
            const config = await ws.request({action:'get-config'});
            assert.equal(config.profileLoginRequired,true);
            assert.equal(config.profileAuthorized,false);
            assert.equal(config.profileBoundId,'');
            const attempt = {action:'login-user-profile',login:'admin',csrfToken:config.csrfToken,password:'wrong-password'};
            assert.equal((await ws.request(attempt)).errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
            const sameClient = await wsClient(gated.url,cookie,{...alice,origin,
                'X-Forwarded-For':'192.0.2.11, 198.51.100.22, 127.0.0.1'});
            try { assert.equal((await sameClient.request(attempt)).errorCode,'INPX_LOGIN_RATE_LIMIT'); }
            finally { sameClient.close(); }
            const nextClient = await wsClient(gated.url,cookie,{...alice,origin,
                'X-Forwarded-For':'198.51.100.23, 127.0.0.1'});
            try { assert.equal((await nextClient.request({...attempt,password:'fixture-admin'})).userId,'admin'); }
            finally { nextClient.close(); }
        } finally { ws.close(); }
    } finally { await gated.stop(); }

    const bound = await start(binary,args,{...env,INPX_REQUIRE_AUTH:'false',INPX_PROXY_BIND_PROFILE:'true',
        INPX_AUTH_EXEMPT_HEALTH:'true'});
    try {
        await check(bound,'/ready/',200);
        for (const path of ['/reader/','/reader/'+app+'/chunk.js','/catalogue/v2','/reader/kosync/healthcheck','/reader/book/by-uid?uid='+uid])
            await check(bound,path,401);
        await assert.rejects(wsClient(bound.url,null),/403/);
        await assert.rejects(wsClient(bound.url,null,{...alice,origin:'https://other.example.invalid'}),/403/);
        const page = await check(bound,'/reader/',200,{headers:alice});
        assert.equal(page.headers.get('cache-control'),'private, no-store');
        assert.match(page.headers.get('strict-transport-security'),/^max-age=/);
        const cookie = page.headers.get('set-cookie').split(';')[0];
        const ws = await wsClient(bound.url,cookie,{...alice,origin});
        try {
            const config = await ws.request({action:'get-config',userId:'admin'});
            assert.equal(config.profileBoundId,aliceId);
            assert.equal(config.profileAuthorized,true);
            assert.deepEqual(config.userProfiles.map(profile=>[profile.id,profile.requiresLogin]),[[aliceId,false]]);
            const resumed = await ws.request({action:'resume-user-profile',userId:'alice',csrfToken:config.csrfToken});
            assert.equal(resumed.userId,aliceId);
            assert.match(resumed.profileAccessToken,/^[a-f0-9]{48}$/);
            const reading = await ws.request({action:'get-reader-state',userId:'alice',bookUid:uid});
            assert.equal(reading.progress.percent,0.21);
            assert.equal((await ws.request({action:'get-reader-state',userId:'admin',bookUid:uid})).error,denied);
            assert.equal((await ws.request({action:'login-user-profile',csrfToken:config.csrfToken,login:'admin',password:'fixture-admin'})).error,denied);
            const fallback = await wsClient(bound.url,cookie,{...alice,'X-Verified-User':'unknown',origin});
            try {
                const tried = await fallback.request({action:'get-reader-state',userId:aliceId,
                    bookUid:uid,profileAccessToken:resumed.profileAccessToken});
                assert.equal(tried.error,'need_profile_login');
            } finally { fallback.close(); }

            const feed = await (await check(bound,'/catalogue/v2',200,{headers:alice})).json();
            assert(feed.navigation.some(link=>link.title==='Published fixture'));
            assert(feed.navigation.every(link=>new URL(link.href,bound.url).searchParams.get('user')===aliceId));
            await check(bound,'/catalogue/v2?user=admin',403,{headers:alice});
            await check(bound,'/catalogue/v2',403,{headers:{...alice,'X-Verified-User':'blocked'}});
            const reference = new URL(detail,bound.url);
            const book = await (await check(bound,reference.pathname+reference.search,200,{headers:alice})).json();
            const href = book.links.find(link=>link.type==='application/fb2+xml').href;
            const file = await check(bound,href,200,{headers:alice});
            assert.match(await file.text(),/FictionBook/);
            await check(bound,href,401);
            const crossed = new URL(href,bound.url);
            crossed.searchParams.set('user','admin');
            await check(bound,crossed.pathname+crossed.search,403,{headers:alice});
            await check(bound,'/reader/kosync/healthcheck',200,{headers:alice});

            const replaceProfiles = async()=>{
                await fs.writeFile(registry+'.proxy-test',JSON.stringify(profiles));
                await fs.rename(registry+'.proxy-test',registry);
            };
            const owner = profiles.users.find(profile=>profile.id===aliceId);
            owner.blocked = true;
            await replaceProfiles();
            assert.equal((await ws.request({action:'get-config'})).error,'Профиль недоступен');
            await check(bound,'/catalogue/v2',403,{headers:alice});
            delete owner.blocked;
            profiles.profileAuthPolicy.otpRequired = true;
            await replaceProfiles();
            const globalOtp = await ws.request({action:'get-config',profileAccessToken:resumed.profileAccessToken});
            assert.equal(globalOtp.profileAuthorized,false);
            assert.equal(globalOtp.profileBoundId,'');
            await check(bound,'/catalogue/v2',401,{headers:alice});
        } finally { ws.close(); }
    } finally { await bound.stop(); }
    console.log('ok standalone trusted proxy, HTTPS origin and cookie, SSO profile scope, OPDS, downloads, block and mandatory OTP');
}

async function verifyLibraryPassword(binary, root) {
    const data = join(root,'data'), collection = join(root,'fixture');
    const config = join(root,'config.json'), web = join(root,'web.json');
    const password = ' пароль каталога 🙂 ';
    const hash = value=>createHash('sha256').update(value).digest('hex');
    const imported = hash('existing active session'), expired = hash('existing expired session');
    const settings = {server:{host:'127.0.0.1',root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        librarySources:[{id:'fixture',inpx:join(collection,'smoke.inpx')}],
        requireAuth:true,authMode:'local',allowAnonymousAccess:false,accessPassword:password,accessTimeout:5,
        loginRateLimitMaxAttempts:2};
    await createFixture(collection);
    await bundle(web);
    await fs.writeFile(config,JSON.stringify(settings));
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const directory = join(data,'web-access');
    await fs.mkdir(directory,{recursive:true});
    const {openWebAccessStore} = require('../server/core/WebAccessStore');
    const {store} = await openWebAccessStore(directory,hash(password),5,false);
    try {
        const now = Date.now();
        await store.apply([[imported,{time:now,used:2}],[expired,{time:now-360000,used:1}]],[]);
    } finally { await store.close(); }

    let issued;
    const first = await start(binary,args);
    try {
        if (process.platform !== 'win32')
            assert.equal((await fs.stat(join(directory,'sessions.redb'))).mode & 0o077,0);
        const ws = await wsClient(first.url,await browserCookie(first.url));
        try {
            const initial = await ws.request({action:'get-config'});
            assert.equal(initial.error,'need_access_token');
            assert.equal(initial.dbConfig,undefined);
            assert.match(initial.salt,/^[a-f0-9]{64}$/);
            assert.equal((await ws.request({action:'test',accessToken:expired})).error,'need_access_token');
            assert.equal((await ws.request({action:'test',accessToken:imported})).message,'inpx-web project is awesome');
            const probe = await ws.request({});
            assert.equal(probe.error,'need_access_token');
            assert.notEqual(probe.salt,initial.salt);
            issued = hash(password+probe.salt);
            const config = await ws.request({action:'get-config',accessToken:issued});
            assert.equal(config.freeAccess,false);
            assert.equal(config.profileLoginRequired,true);
            assert.equal(config.profileAuthorized,false);
            assert.match(config.csrfToken,/^[a-f0-9]{64}$/);
            const login = await ws.request({action:'login-user-profile',csrfToken:config.csrfToken,accessToken:issued,
                login:'admin',password:'fixture-admin'});
            assert.equal(login.userId,'admin',login.error);
            const found = await ws.request({action:'bookSearch',query:{title:'=Packaged smoke book'},accessToken:issued,
                profileAccessToken:login.profileAccessToken});
            assert.equal(found.found.length,1,found.error);
            assert.equal((await ws.request({action:'logout',accessToken:issued,csrfToken:'invalid'})).error,'bad_csrf_token');
        } finally { ws.close(); }
    } finally { await first.stop(); }

    const next = await start(binary,args);
    try {
        const ws = await wsClient(next.url,await browserCookie(next.url));
        try {
            for (const token of [imported,issued])
                assert.equal((await ws.request({action:'test',accessToken:token})).message,'inpx-web project is awesome');
            for (let i=0;i<2;i++)
                assert.equal((await ws.request({action:'test',accessToken:hash('wrong-'+i)})).error,'need_access_token');
            const limited = await ws.request({action:'test',accessToken:hash('wrong-limit')});
            assert.equal(limited.errorCode,'INPX_LOGIN_RATE_LIMIT');
            assert(limited.retryAfterMs>0);
            const config = await ws.request({action:'get-config',accessToken:issued});
            assert.equal(config.freeAccess,false);
            assert.equal((await ws.request({action:'logout',accessToken:issued,csrfToken:config.csrfToken})).success,true);
            assert.equal((await ws.request({action:'test',accessToken:issued})).error,'need_access_token');
        } finally { ws.close(); }
    } finally { await next.stop(); }

    const catalog = join(dirname(binary),'inpx-catalog'+(process.platform==='win32'?'.exe':''));
    const compatibility = await openWebAccessStore(directory,hash(password),5,catalog);
    try {
        const sessions = new Map(compatibility.sessions);
        assert(sessions.has(imported),'The previous runtime can reopen the imported session');
        assert(!sessions.has(issued),'The previous runtime sees the standalone revocation');
    } finally { await compatibility.store.close(); }
    if (process.env.INPX_STANDALONE_COMPAT_PACKAGE) {
        const legacy = await start(resolve(process.env.INPX_STANDALONE_COMPAT_PACKAGE),
            args.filter(arg=>arg!=='--standalone' && !arg.startsWith('--web-bundle=')));
        try {
            const view = await fetch(legacy.url+'/reader/');
            assert.equal(view.status,200);
            const cookie = view.headers.getSetCookie().find(value=>value.startsWith('inpx_web_session='));
            assert(cookie);
            const ws = await wsClient(legacy.url,cookie.split(';')[0]);
            try {
                assert.equal((await ws.request({action:'test',accessToken:imported})).message,'inpx-web project is awesome');
                assert.equal((await ws.request({action:'test',accessToken:issued})).error,'need_access_token');
            } finally { ws.close(); }
        } finally { await legacy.stop(); }
        console.log('ok previous Windows package accepts the retained library session and rejects the revoked session');
    }

    await fs.writeFile(config,JSON.stringify({...settings,accessPassword:'rotated password'}));
    const rotated = await start(binary,args);
    try {
        const ws = await wsClient(rotated.url,await browserCookie(rotated.url));
        try {
            for (const token of [imported,issued])
                assert.equal((await ws.request({action:'test',accessToken:token})).error,'need_access_token');
        } finally { ws.close(); }
    } finally { await rotated.stop(); }
    console.log('ok standalone library password, challenge envelope, JembaDB sessions, restart, logout and rotation');
}

async function verifyServiceRoutes(binary, root) {
    const data = join(root,'data'), library = join(root,'library'), config = join(root,'config.json'), web = join(root,'web.json');
    const abs = '/reader/api/audiobookshelf', metrics = '/observe', proxy = {'Remote-User':'verified-fixture'};
    const absToken = 'test-abs-service-token', metricsToken = 'test-metrics-service-token';
    const absHeaders = {Authorization:absToken};
    const metricsHeaders = {Authorization:'Bearer '+metricsToken};
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=','base64');
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    await createFixture(library);
    const book = '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description>'+
        '<title-info><book-title>Packaged smoke book</book-title><annotation><p>Sample description.</p></annotation><lang>en</lang>'+
        '<keywords>one; two</keywords><coverpage><image l:href="#cover"/></coverpage></title-info>'+
        '<publish-info><publisher>Sample Press</publisher><year>2020</year><isbn>9780140328721</isbn></publish-info></description>'+
        '<body><section><p>Text</p></section></body><binary id="cover" content-type="image/png">'+png.toString('base64')+'</binary></FictionBook>';
    await fs.writeFile(join(library,'smoke.zip'),await zip([['1.fb2',book]]));
    await bundle(web);
    await fs.writeFile(config,JSON.stringify({server:{host:'127.0.0.1',root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        librarySources:[{id:'fixture',inpx:join(library,'smoke.inpx')}],authMode:'proxy',requireAuth:true,allowAnonymousAccess:false,
        trustProxy:true,trustedProxyCidrs:['127.0.0.1/32'],metricsEnabled:true,metricsPath:metrics,metricsToken,
        bookCacheSize:123456,coverCacheSize:654321}));
    const env = {INPX_ABS_ENABLED:'true',INPX_ABS_TOKEN:absToken,INPX_ABS_MAX_RESULTS:'5',
        INPX_ABS_PUBLIC_URL:'https://catalogue.example.invalid/reader/'};
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const check = async (server,path,status,options={})=>{
        const response = await fetch(server.url+path,options);
        assert.equal(response.status,status,path);
        return response;
    };
    const server = await start(binary,args,env);
    let cover;
    try {
        await check(server,metrics,401);
        await check(server,metrics,401,{headers:proxy});
        await check(server,metrics,401,{headers:{...proxy,'X-Inpx-Request-Access':'0:http:metrics'}});
        await check(server,metrics,401,{headers:absHeaders});
        await check(server,metrics+'?token='+metricsToken,401,{headers:{Authorization:'Bearer wrong'}});
        assert.equal((await check(server,metrics+'?token[]='+metricsToken,200)).headers.get('cache-control'),'no-store');
        await check(server,'/reader/',401,{headers:metricsHeaders});
        await check(server,'/catalogue/v2',401,{headers:absHeaders});
        await check(server,abs+'/search?query=Packaged',401,{headers:metricsHeaders});
        await check(server,abs+'/unrelated',401,{headers:absHeaders});
        await check(server,abs+'/search?query=Packaged',401,{method:'POST',headers:absHeaders});
        const info = await (await check(server,abs,200,{headers:absHeaders})).json();
        assert.equal(info.limits.maxResults,5);
        assert.equal(info.search,abs+'/search');
        assert(!JSON.stringify(info).includes(absToken));
        await check(server,abs+'/search?author=Tester',400,{headers:absHeaders});
        await check(server,abs+'/search?query='+('x'.repeat(201)),400,{headers:absHeaders});
        const search = await (await check(server,abs+'/search?query=Packaged&author=S.%20Tester',200,
            {headers:{Authorization:'Bearer '+absToken}})).json();
        assert.equal(search.matches.length,1);
        const match = search.matches[0];
        assert.equal(match.title,'Packaged smoke book');
        assert.equal(match.description,'Sample description.');
        assert.equal(match.publisher,'Sample Press');
        assert.equal(match.isbn,'9780140328721');
        assert.equal(match.publishedYear,'2020');
        assert.deepEqual(match.tags,['one','two']);
        const signed = new URL(match.cover);
        assert.equal(signed.origin,'https://catalogue.example.invalid');
        assert.equal(signed.pathname,abs+'/cover');
        const uid = signed.searchParams.get('uid');
        const expires = signed.searchParams.get('expires');
        assert.equal(signed.searchParams.get('signature'),
            require('node:crypto').createHmac('sha256',absToken).update(`abs-cover:${uid}:${expires}`).digest('hex'));
        cover = signed.pathname+signed.search;
        assert.deepEqual(await bytes(await check(server,cover,200)),png);
        await check(server,cover.replace('signature=','signature=0'),401,{headers:proxy});
        const expired = new URL(cover,server.url);
        expired.searchParams.set('expires','1000');
        expired.searchParams.set('signature',
            require('node:crypto').createHmac('sha256',absToken).update(`abs-cover:${uid}:1000`).digest('hex'));
        await check(server,expired.pathname+expired.search,401,{headers:proxy});
        const localCover = await check(server,cover,200,{method:'HEAD'});
        assert.equal(localCover.headers.get('content-length'),String(png.length));
        assert.equal((await bytes(localCover)).length,0);
        await fs.mkdir(join(library,'covers'));
        await fs.writeFile(join(library,'covers','smoke.zip'),await zip([['1',gif]]));
        const sidecar = await check(server,cover,200);
        assert.equal(sidecar.headers.get('content-type'),'image/gif');
        assert.deepEqual(await bytes(sidecar),gif);

        const page = await check(server,'/reader/',200,{headers:proxy});
        const cookie = page.headers.get('set-cookie').split(';')[0];
        const ws = await wsClient(server.url,cookie,proxy);
        try {
            const {csrfToken} = await ws.request({action:'get-config'});
            const login = await ws.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken});
            assert.equal(login.userId,'admin',login.error);
            const {link} = await ws.request({action:'get-book-link',bookUid:uid});
            const get = {...proxy,cookie};
            await bytes(await check(server,link+'/raw',206,{headers:{...get,Range:'bytes=0-4'}}));
            await check(server,link+'/raw',200,{method:'HEAD',headers:get});
            await bytes(await check(server,link+'/raw',200,{headers:get}));
            await bytes(await check(server,link+'/raw',206,{headers:{...get,Range:'bytes=0-'}}));
            const scrape = await check(server,metrics,200,{headers:metricsHeaders});
            assert.equal(scrape.headers.get('content-type'),'text/plain; version=0.0.4; charset=utf-8');
            const text = await scrape.text();
            assert.match(text,/^inpx_web_index_ready 1$/m);
            assert.match(text,/^inpx_web_memory_rss_bytes [1-9][0-9]+$/m);
            assert.match(text,/^inpx_web_process_cpu_seconds_total [0-9.]+$/m);
            assert.match(text,/^inpx_web_book_cache_limit_bytes 123456$/m);
            assert.match(text,/^inpx_web_book_cache_size_bytes [1-9][0-9]*$/m);
            assert.match(text,/^inpx_web_cover_cache_files 2$/m);
            assert.match(text,/^inpx_web_users_online 1$/m);
            const label = text.match(/^inpx_web_profile_logins_total\{profile="([a-f0-9]{12})"\} 1$/m)?.[1];
            assert(label);
            assert(text.includes(`inpx_web_book_downloads_total{profile="${label}"} 2\n`),text);
            assert(!text.includes(uid) && !text.includes('profile="admin"') && !text.includes(metricsToken));
        } finally { ws.close(); }
    } finally { await server.stop(); }

    const overlap = await start(binary,args,{...env,INPX_METRICS_PATH:abs+'/cover',INPX_METRICS_EXEMPT_AUTH:'true'});
    try {
        await check(overlap,abs+'/cover?token='+metricsToken,401);
        await check(overlap,cover,200);
    } finally { await overlap.stop(); }
    const exempt = await start(binary,args,{...env,INPX_METRICS_EXEMPT_AUTH:'true',INPX_ABS_ENABLED:'false'});
    try {
        await check(exempt,metrics,401);
        await check(exempt,metrics,200,{headers:metricsHeaders});
        const disabled = await check(exempt,abs,404,{headers:proxy});
        assert.equal((await disabled.json()).configuration.enabled,false);
    } finally { await exempt.stop(); }
    console.log('ok standalone scoped service tokens, Prometheus samples and activity, Audiobookshelf metadata, embedded and signed sidecar covers');
}

async function verifyIndexRefresh(binary, root) {
    const data = join(root,'data'), library = join(root,'library');
    const loose = join(root,'loose'), config = join(root,'config.json'), web = join(root,'web.json');
    const archive = join(library,'smoke.inpx');
    const filter = join(root,'filter.json');
    const original = join(loose,'original.fb2'), replacement = join(loose,'replacement.fb2');
    const book = title=>`<FictionBook><description><title-info><book-title>${title}</book-title><lang>en</lang></title-info></description><body><section><p>Sample.</p></section></body></FictionBook>`;
    const settings = {server:{host:'127.0.0.1',port:0,root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        inpxCheckInterval:0, librarySources:[{id:'main',inpx:archive},
            {id:'loose',type:'folder',libDir:loose}]};
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    await createFixture(library);
    await fs.mkdir(loose,{recursive:true});
    await fs.writeFile(original,book('Original folder record'));
    await fs.writeFile(config,JSON.stringify(settings));
    await bundle(web);

    const index = async url => (await fetch(url+'/api/index-status')).json();
    async function updated(url, accept) {
        const deadline = Date.now()+18000;
        let status;
        do {
            status = await index(url);
            if (!status.updating && accept(status)) return status;
            await sleep(70);
        } while (Date.now()<deadline);
        assert.fail('Expected catalogue update, last status '+JSON.stringify(status));
    }
    async function find(socket, title) {
        const result = await socket.request({action:'bookSearch',query:{title,limit:20}});
        assert.equal(result.error,undefined);
        return result.found.find(book=>book.title===title);
    }

    let stable, hash;
    const server = await start(binary,args);
    try {
        const url = server.url;
        const ws = await wsClient(url,await browserCookie(url));
        try {
            assert.equal((await ws.request({action:'admin-reindex'})).error,'bad_csrf_token');
            const {csrfToken} = await ws.request({action:'get-config'});
            assert.equal((await ws.request({action:'admin-reindex',csrfToken,userId:'admin'})).error,'need_profile_login');
            const {profileAccessToken} = await ws.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken});
            assert(profileAccessToken);
            const command = {action:'admin-reindex',csrfToken,profileAccessToken,userId:'admin'};
            stable = (await find(ws,'Packaged smoke book'))._uid;
            assert(await find(ws,'Original folder record'));
            const before = await index(url);
            await fs.unlink(original);
            await fs.writeFile(replacement,book('Replacement folder record'));
            const row = ['Tester,Smoke:', 'sf:', 'Updated smoke book', '', '0', '1', '100', '1', '0', 'fb2', '2026-09-14', 'en', '0', ''];
            await fs.writeFile(archive,await zip([['collection.info','Smoke library\n'],['version.info','20260915'],['smoke.inp',row.join('\x04')+'\n']]));
            assert.equal((await ws.request(command)).started,true);
            const after = await updated(url,status=>status.inpxHash!==before.inpxHash);
            assert.equal(after.ready,true);
            assert.equal(after.stats.bookCount,2);
            assert.equal(after.indexUpdate.incremental,true);
            assert.equal(after.indexUpdate.recordsChanged,2);
            assert.equal(after.indexUpdate.recordsRemoved,1);
            assert.equal((await find(ws,'Updated smoke book'))._uid,stable);
            assert.equal(await find(ws,'Packaged smoke book'),undefined);
            assert.equal(await find(ws,'Original folder record'),undefined);
            assert(await find(ws,'Replacement folder record'));
            assert.equal((await fetch(url+'/catalogue/v2/book?uid='+encodeURIComponent(stable))).status,200);
            hash = after.inpxHash;

            await fs.writeFile(filter,'{invalid');
            assert.equal((await ws.request(command)).started,true);
            const failure = await updated(url,status=>status.error);
            assert.equal(failure.inpxHash,hash);
            assert.equal(failure.ready,true);
            assert(await find(ws,'Replacement folder record'));
            await fs.unlink(filter);
        } finally { ws.close(); }
    } finally { await server.stop(); }

    await fs.writeFile(config,JSON.stringify({...settings,inpxCheckInterval:0.01}));
    const timed = await start(binary,args);
    try {
        assert.equal((await index(timed.url)).inpxHash,hash);
        await fs.writeFile(original,book('New folder record from polling'));
        const after = await updated(timed.url,status=>status.stats.bookCount===3);
        assert.notEqual(after.inpxHash,hash);
        hash = after.inpxHash;
    } finally { await timed.stop(); }

    const metadata = ()=>readJson(join(data,'db','catalogue.json'));
    const before = (await metadata()).rustBookStoreGeneration;
    const recreated = await start(binary,[...args,'--recreate']);
    try {
        assert.equal((await index(recreated.url)).inpxHash,hash);
        assert.notEqual((await metadata()).rustBookStoreGeneration,before);
        assert.equal((await fetch(recreated.url+'/catalogue/v2/book?uid='+encodeURIComponent(stable))).status,200);
    } finally { await recreated.stop(); }

    const release = process.env.INPX_STANDALONE_COMPAT_PACKAGE;
    if (release) {
        const legacy = await start(resolve(release),args.filter(arg=>arg!=='--standalone' && !arg.startsWith('--web-bundle=')));
        try {
            assert.equal((await index(legacy.url)).stats.bookCount,3);
            assert.equal((await fetch(legacy.url+'/catalogue/v2/book?uid='+encodeURIComponent(stable))).status,200);
        } finally { await legacy.stop(); }
    }
    console.log('ok standalone admin, periodic and forced catalogue updates preserve book identity and recover from a broken filter');
}

async function verifyJembaUpgrade(binary, root) {
    const library = join(root,'library'), data = join(root,'data'), db = join(data,'db');
    const config = join(root,'settings.json'), filter = join(root,'filter.json'), web = join(root,'web.json');
    const archive = join(library,'smoke.inpx'), header = join(db,'catalogue.json');
    const settings = {dataDir:data, server:{host:'127.0.0.1',port:0,root:'/reader'},opds:{enabled:true,root:'/catalogue'},
        lowMemoryMode:true, inpxCheckInterval:0, librarySources:[{id:'main',name:'Legacy fixture',inpx:archive}]};
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web];
    await createFixture(library);
    await bundle(web);
    await fs.writeFile(config,JSON.stringify(settings));

    const {buildIndexInWorker} = require('../server/core/IndexBuilder');
    await buildIndexInWorker({...require('../server/config/base'), dataDir:data, inpxFilterFile:filter,
        librarySources:[{...settings.librarySources[0],type:'inpx',inpxFile:archive,libDir:library}],
        rustBookStoreEnabled:false,rustCatalogUpdateEnabled:false},db,'',()=>{});
    await assert.rejects(fs.stat(header),{code:'ENOENT'});

    const JembaDb = require('jembadb/src/JembaDb');
    const legacy = new JembaDb();
    const uid = 'legacy-book-id-kept-by-rust';
    await legacy.lock({dbPath:db,softLock:true});
    try {
        await legacy.open({table:'book'});
        const [book] = await legacy.select({table:'book'});
        assert.equal(book.title,'Packaged smoke book');
        await legacy.delete({table:'book',where:`@@id(${book.id})`});
        await legacy.insert({table:'book',rows:[{...book,id:29,_uid:uid}]});
    } finally { await legacy.unlock(); }

    const ReadingListStore = require('../server/core/ReadingListStore');
    const contents = new ReadingListStore({dataDir:data,adminPassword:'fixture-legacy-admin'});
    const shelf = await contents.createList('default','Legacy migration shelf');
    await contents.addBooks('default',shelf.id,[uid]);
    await contents.updateReaderProgress('default',uid,{percent:0.42,sectionId:'legacy-section',textOffset:123});
    await contents.addReaderBookmark('default',uid,{title:'Legacy bookmark',sectionId:'legacy-section',percent:0.42,textOffset:123});

    const exec = require('node:util').promisify(require('node:child_process').execFile);
    const launch = () => exec(binary,args,{env:environment(),encoding:'utf8',timeout:14000,windowsHide:true});
    await legacy.lock({dbPath:db,softLock:true});
    try {
        await assert.rejects(launch(),error=>/Database locked/.test(error.stderr));
        await assert.rejects(fs.stat(header),{code:'ENOENT'});
    } finally { await legacy.unlock(); }

    await fs.writeFile(filter,'{broken');
    await assert.rejects(launch(),error=>/key must be a string/.test(error.stderr));
    await fs.unlink(filter);
    await assert.rejects(fs.stat(header),{code:'ENOENT'});
    await legacy.lock({dbPath:db,softLock:true});
    try {
        await legacy.open({table:'book'});
        assert.equal((await legacy.select({table:'book'}))[0]._uid,uid);
    } finally { await legacy.unlock(); }

    // Simulate restarting after the previous directory was moved aside.
    await fs.rename(db,join(data,'db.previous'));
    const first = await start(binary,args);
    let generation;
    try {
        const metadata = await readJson(header);
        generation = metadata.rustBookStoreGeneration;
        assert.equal(metadata.indexUpdate.incremental,true);
        assert.equal(metadata.stats.bookCount,1);
        const ws = await wsClient(first.url,await browserCookie(first.url));
        try {
            const book = (await ws.request({action:'bookSearch',query:{title:'Packaged smoke book'}})).found[0];
            assert.equal(book._uid,uid);
            const state = await ws.request({action:'get-reader-state',userId:'default',bookUid:uid});
            assert.equal(state.progress?.percent,0.42,state.error);
            assert.equal(state.progress.textOffset,123);
            assert.equal(state.bookmarks[0].sectionId,'legacy-section');
            const saved = await ws.request({action:'get-reading-list',userId:'default',listId:shelf.id});
            assert.equal(saved.list?.name,'Legacy migration shelf',saved.error);
            assert.deepEqual(saved.books.map(book=>[book._uid,book._readerProgress.percent]),[[uid,0.42]]);
        } finally { ws.close(); }
        const publication = await (await fetch(first.url+'/catalogue/v2/book?uid='+encodeURIComponent(uid))).json();
        assert.equal(publication.metadata.title,'Packaged smoke book');
        const catalog = join(dirname(binary),'inpx-catalog'+(process.platform==='win32'?'.exe':''));
        const {result} = JSON.parse(execFileSync(catalog,['store',db],{
            input:JSON.stringify({id:1,op:'scan',generation,limit:5})+'\n',encoding:'utf8',env:environment(),windowsHide:true,
        }));
        assert.equal(result.rows[0].id,29);
        const profiles = await readJson(join(data,'reading-lists.json'));
        assert.equal(profiles.lists.find(row=>row.id===shelf.id).books[0].bookUid,uid);
        const {snapshot} = await readJson(join(data,'.upgrade-version.json'));
        const backup = await readJson(join(snapshot,'reading-lists.json'));
        assert.equal(backup.users.find(row=>row.id==='default').readerProgress[uid].percent,0.42);
    } finally { await first.stop(); }

    const restarted = await start(binary,args);
    try { assert.equal((await readJson(header)).rustBookStoreGeneration,generation); }
    finally { await restarted.stop(); }

    const release = process.env.INPX_STANDALONE_COMPAT_PACKAGE;
    if (release) {
        const compatibility = await start(resolve(release),args.filter(arg=>arg!=='--standalone' && !arg.startsWith('--web-bundle=')));
        try {
            const cookie = (await fetch(compatibility.url+'/reader/')).headers.get('set-cookie').split(';')[0];
            const ws = await wsClient(compatibility.url,cookie);
            try {
                const saved = await ws.request({action:'get-reading-list',userId:'default',listId:shelf.id});
                assert.equal(saved.list?.name,'Legacy migration shelf',saved.error);
                assert.equal(saved.books[0]._uid,uid);
                assert.equal(saved.books[0]._readerProgress.percent,0.42);
            } finally { ws.close(); }
            assert.equal((await readJson(header)).rustBookStoreGeneration,generation);
        } finally { await compatibility.stop(); }
    }
    console.log('ok standalone JembaDB upgrade preserves numeric IDs, shelf references, bookmarks and reader position');
}

(async()=>{
    const binary = resolve(process.argv[2]);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-standalone-'));
    try {
        await verify(binary,root);
        await verifyCatalogue(binary,join(root,'opds'));
        await verifyEpubReader(binary,join(root,'epub-reader'));
        await verifyLibraryPassword(binary,join(root,'library-password'));
        await verifyServiceRoutes(binary,join(root,'services'));
        await verifyIndexRefresh(binary,join(root,'reindex'));
        await verifyJembaUpgrade(binary,join(root,'jemba-upgrade'));
    }
    finally { await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
