const assert = require('node:assert/strict');
const {sessionCookieHeader} = require('./test-session-cookie');
const {spawn,spawnSync,execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {createServer} = require('node:http');
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
        if (/^(PATH|INPX_(REQUIRE_AUTH|ALLOW_ANONYMOUS_ACCESS|AUTH_MODE|AUTH_EXEMPT_HEALTH|TRUST_PROXY|TRUSTED_PROXY_CIDRS|PROXY_AUTH_HEADER|PROXY_BIND_PROFILE|LOGIN_RATE_LIMIT_ENABLED|RESOURCE_.*|CONVERSION_CONCURRENCY|RESET_ADMIN_PASSWORD|LIBRARY_SOURCES|OPDS_COMPATIBILITY|OPDS_FEEDS_FILE|KOSYNC_ENABLED|LOG_LEVEL|LOW_MEMORY_MODE|WS_MESSAGE_LIMIT_MB|IMPORT_LIMIT_MB|BACKUP_(UPLOAD|EXPANDED)_LIMIT_MB|ENABLE_CONVERSION|CONVERSION_FORMATS|ADMIN_.*|METRICS_.*|ABS_.*|RUST_.*|TELEGRAM_.*)|TELEGRAM_.*|LIBRARY_SOURCES|LIBDIR|INPX)$/i.test(name))
            delete env[name];
    return {...env,PATH:'',INPX_BOOK_FILENAME_TEMPLATE:'[${TITLE}] Тест.${EXT}'};
}

async function start(binary,args,environmentOverrides,readinessHeaders,host='127.0.0.1') {
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
    const url = `http://${host}:${port}`;
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
        if (value._progress) {
            request.onProgress?.(value.progress);
            return;
        }
        pending.delete(value.requestId);
        clearTimeout(request.timeout);
        if (!request.ack) request.reject(new Error('Missing _rok for '+value.requestId));
        else request.resolve(value);
    });
    return {
        request(message, onProgress) {
            const requestId = 'ws-fixture-'+(++sequence);
            return new Promise((resolve,reject)=>{
                const timeout = setTimeout(()=>{
                    pending.delete(requestId);
                    reject(new Error('WebSocket timeout for '+message.action));
                },12000);
                pending.set(requestId,{resolve,reject,timeout,ack:false,onProgress});
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
    assert.match(header,/^inpx_web_session_\d+=[a-f\d]{48}\.[a-f\d]{64}; HttpOnly; SameSite=Lax; Path=\/reader;/);
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
        const exact = await ws.request({action:'bookSearch',query:{title:'=PACKAGED SMOKE BOOK',del:'0',limit:1}});
        assert.equal(exact.totalFound,1,exact.error);
        assert.equal(exact.found[0]._uid,uid);
        const absent = await ws.request({action:'bookSearch',query:{title:'=Packaged smoke'}});
        assert.equal(absent.totalFound,0,absent.error);
        assert.deepEqual(absent.found,[]);
        const authors = await ws.request({action:'search',from:'author',query:{author:'Tester'}});
        const authorBooks = await ws.request({action:'get-author-book-list',authorId:authors.found[0].id,query:{del:'0'}});
        assert.equal(authorBooks.author,'Tester Smoke');
        assert.equal(authorBooks.books[0]._uid,uid);
        const index = await ws.request({action:'catalog-browse',options:{
            kind:'author',prefix:'TESTER ',filters:{lang:'en',ext:'fb2|epub',sourceId:'main'},
        }});
        assert.equal(index.prefix,'tester ',index.error);
        assert.deepEqual(index.items,[{name:'Tester Smoke',count:1}]);
        const otherSource = await ws.request({action:'catalog-browse',options:{
            kind:'author',prefix:'tester',filters:{sourceId:'missing'},
        }});
        assert.deepEqual([otherSource.total,otherSource.items],[0,[]]);
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
        const add = {action:'add-reader-bookmark',bookUid:uid,bookmark:{
            title:'  Заметка  к книге  ',excerpt:'  Цитата\nиз книги ',note:' Моя  заметка ',
            sectionId:' section-fixture ',percent:0.35,
        }};
        assert.equal((await ws.request(add)).error,'bad_csrf_token');
        const saved = await ws.request({...add,csrfToken:config.csrfToken});
        assert.equal(saved.bookmarks?.length,1,saved.error);
        const [bookmark] = saved.bookmarks;
        assert.deepEqual([bookmark.title,bookmark.excerpt,bookmark.note,bookmark.sectionId,bookmark.percent],
            ['Заметка к книге','Цитата из книги','Моя заметка','section-fixture',0.35]);
        const withBookmark = await ws.request({action:'get-reader-state',bookUid:uid});
        assert.deepEqual(withBookmark.bookmarks,[bookmark]);
        assert.equal(withBookmark.progress.revision,1);
        const kept = await ws.request({action:'add-reader-bookmark',bookUid:uid,csrfToken:config.csrfToken,
            bookmark:{title:'Оставленная закладка',percent:-1}});
        assert.equal(kept.bookmarks?.length,2,kept.error);
        const survivor = kept.bookmarks.find(row=>row.title==='Оставленная закладка');
        assert.equal(survivor?.percent,0);
        const deleted = await ws.request({action:'delete-reader-bookmark',bookUid:uid,bookmarkId:bookmark.id,
            csrfToken:config.csrfToken});
        assert.deepEqual(deleted.bookmarks,[survivor],deleted.error);
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
        for (const sort of ['progressDesc','updatedDesc']) {
            const page = offset => change('get-user-reading-library',{options:{state:'all',sort,limit:1,offset}});
            const first = await page(0), second = await page(1), end = await page(2);
            assert.equal(second.count,2);
            assert.deepEqual(new Set([first.items[0].bookUid,second.items[0].bookUid]),new Set([readingUid,shelfUid]));
            assert.equal(end.count,2);
            assert.deepEqual(end.items,[]);
        }
        const historySearch = await change('get-user-reading-library',{options:{state:'reading',query:'PACKAGED smoke'}});
        assert.equal(historySearch.items[0].bookUid,readingUid);
        assert.equal(historySearch.items[0].percent,0.35);
        const setHistoryHidden = (book, hidden) => change('update-reader-progress',{bookUid:book.bookUid,
            progress:{hidden,baseRevision:book.revision,generation:historySearch.progressGeneration}});
        const paused = await setHistoryHidden(history.items[0],true);
        assert.equal(paused.progress.hidden,true,paused.error);
        const visible = await change('get-user-reading-library',{options:{state:'all',excludeHidden:true,limit:1}});
        assert.equal(visible.count,1);
        assert.deepEqual(visible.items.map(book=>book.bookUid),[readingUid]);
        const all = await change('get-user-reading-library',{options:{state:'all'}});
        assert.equal(all.count,2);
        const hidden = await change('get-user-reading-library',{options:{state:'hidden'}});
        assert.deepEqual(hidden.items.map(book=>book.bookUid),[shelfUid]);
        const resumed = await setHistoryHidden(hidden.items[0],false);
        assert.equal(resumed.progress.hidden,false,resumed.error);
        assert.equal(resumed.progress.percent,1);
        assert.deepEqual((await change('get-reading-list',{listId:smart.list.id})).books.map(book=>book._uid),[readingUid]);
        const pin = (shelfIds) => change('set-overview-pinned-shelves',{shelfIds});
        assert.match((await pin([listId,listId])).error,/не повторяться/);
        assert.match((await pin(['unknown-shelf'])).error,/в вашем профиле/);
        assert.equal((await guest.request({action:'set-overview-pinned-shelves',shelfIds:[]})).error,'bad_csrf_token');
        const pinnedLists = await pin([smart.list.id,listId]);
        assert.deepEqual(pinnedLists.shelfIds,[smart.list.id,listId],pinnedLists.error);
        assert.equal(pinnedLists.maxShelves,8);
        const preview = await change('get-overview-pinned-shelves');
        assert.deepEqual(preview.shelves?.map(row=>[row.id,row.smart,row.books.map(book=>book._uid)]),
            [[smart.list.id,true,[readingUid]],[listId,false,[shelfUid]]],preview.error);
        assert.deepEqual(preview.shelves[1].books[0]._readerProgress,{percent:1,started:true});
        const discovery = await change('get-discovery-shelves');
        assert(discovery.shelves?.some(shelf=>shelf.id==='popular' && shelf.items.some(book=>book._uid===shelfUid)),discovery.error);
        const pinned = await change('get-reading-lists',{bookUid:shelfUid,options:{visibility:'opds'}});
        assert.equal(pinned.lists.length,1);
        assert.equal(pinned.lists[0].containsBook,true);
        assert.equal(pinned.lists[0].readBook,true);

        const {csrfToken:adminCsrf} = await admin.request({action:'get-config'});
        const logged = await admin.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken:adminCsrf});
        assert(logged.profileAccessToken,logged.error);
        assert.equal((await admin.request({action:'get-reading-list',userId:'admin',listId,options:{allowForeign:true}})).error,'Список не найден');
        assert.deepEqual((await admin.request({action:'get-overview-pinned-shelves',userId:'admin'})).shelfIds,[]);
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
    for (const env of [{INPX_CONVERSION_FORMATS:'epub,pdf'}, {INPX_ENABLE_CONVERSION:'false'}]) {
        const reading = await start(binary,args,env);
        try {
            const feed = await (await fetch(reading.url+'/catalogue/v2/search?query=EPUB')).json();
            const links = feed.publications[0].links;
            assert(!links.some(link=>link.type==='application/fb2+xml'));
            const uid = new URL(links.find(link=>link.rel==='self').href,reading.url).searchParams.get('uid');
            const cookie = await browserCookie(reading.url);
            const ws = await wsClient(reading.url,cookie);
            try {
                const config = await ws.request({action:'get-config'});
                assert(!config.conversionFormats.includes('fb2'));
                assert.equal(require('../shared/BookFormats').canRead('epub',config),true);
                const {bookInfo} = await ws.request({action:'get-book-info',bookUid:uid,readerOnly:true});
                assert.equal(bookInfo.book._uid,uid);
                assert.match(JSON.stringify(bookInfo.fb2),/Текст второй главы/);
            } finally { ws.close(); }
            const query = new URLSearchParams({uid});
            const page = await fetch(reading.url+'/reader/ebook/read?'+query,{headers:{cookie}});
            assert.equal(page.status,200);
            assert.match(await page.text(),/Текст второй главы/);
            query.set('format','fb2');
            assert.equal((await fetch(reading.url+'/reader/book/by-uid?'+query)).status,404);
        } finally { await reading.stop(); }
    }
    await fs.writeFile(config,JSON.stringify({...settings,conversionEnabled:false,onlineReaderEnabled:false}));
    const disabled = await start(binary,args);
    try {
        const feed = await (await fetch(disabled.url+'/catalogue/v2/search?query=EPUB')).json();
        assert(!feed.publications[0].links.some(link=>link.type==='application/fb2+xml'));
        const uid = new URL(feed.publications[0].links.find(link=>link.rel==='self').href,disabled.url).searchParams.get('uid');
        assert.equal((await fetch(disabled.url+'/reader/book/by-uid?'+new URLSearchParams({uid,format:'fb2'}))).status,404);
        const ws = await wsClient(disabled.url,await browserCookie(disabled.url));
        try {
            const config = await ws.request({action:'get-config'});
            assert.equal(config.onlineReaderEnabled,false);
            assert.equal(config.epubReaderEnabled,false);
            assert((await ws.request({action:'get-book-info',bookUid:uid,readerOnly:true})).error);
        }
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
        const guest = await wsClient(server.url,await browserCookie(server.url));
        const admin = await wsClient(server.url,await browserCookie(server.url));
        try {
            const titles = query=>guest.request({action:'search',from:'title',query});
            const portion = {title:'Маршрут',del:'0',offset:40,limit:40};
            const filtered = await titles({...portion,ext:'fb2|epub'});
            const unfiltered = await titles(portion);
            assert.equal(filtered.totalFound,105,filtered.error);
            assert.equal(filtered.found.length,40);
            assert.deepEqual(filtered.found,unfiltered.found);
            const deleted = await titles({title:'=МАРШРУТ 106',ext:'fb2|epub'});
            assert.equal(deleted.totalFound,1,deleted.error);
            const {bookCount,bookDelCount,books} = deleted.found[0];
            assert.deepEqual([bookCount,bookDelCount,books.map(book=>book.del)],[0,1,[1]]);
            const absentFormat = await titles({title:'*шрут',ext:'epub|mobi',del:'0'});
            assert.deepEqual([absentFormat.totalFound,absentFormat.found],[0,[]],absentFormat.error);
            const absentTitle = await titles({title:'=unknown title',ext:'fb2|epub'});
            assert.deepEqual([absentTitle.totalFound,absentTitle.found],[0,[]],absentTitle.error);

            const options = {kind:'series',name:'Маршрут',page:2,limit:2,
                filters:{sourceId:'catalogue',lang:'ru',ext:'fb2',genre:'sf_space'}};
            const entity = {action:'catalog-entity',options};
            const page = await guest.request(entity);
            assert.equal(page.total,105,page.error);
            assert.deepEqual([page.page,page.pageCount,page.read],[2,53,null]);
            assert.deepEqual(page.books.map(book=>book.title),['Маршрут 003','Маршрут 004']);
            assert.equal(page.next.title,'Маршрут 001');
            const author = await guest.request({action:'catalog-entity',options:{
                kind:'author',name:'Tester Smoke',filters:{sourceId:'catalogue'},
            }});
            assert.deepEqual(author.series,['Маршрут','Other'],author.error);
            const suggest = options=>guest.request({action:'catalog-suggest',options});
            assert.deepEqual((await suggest({query:'Ма'})).groups,[]);
            const suggestions = await suggest({query:'Маршрут 00',kind:'title',filters:{lang:'ru',ext:'fb2'}});
            assert.deepEqual(suggestions.groups?.map(group=>group.kind),['title'],suggestions.error);
            assert.equal(suggestions.groups[0].items.length,6);
            assert.equal(suggestions.groups[0].items[0].book.title,'Маршрут 001');
            assert.deepEqual((await suggest({query:'Маршрут',kind:'title',filters:{lang:'en'}})).groups[0].items,[]);
            assert.equal((await suggest({query:'Smok',kind:'author'})).groups[0].items[0].name,'Tester Smoke');
            assert.equal((await suggest({query:'Маршурт',kind:'title'})).corrections[0].query,'маршрут');

            const {csrfToken} = await admin.request({action:'get-config'});
            const {profileAccessToken} = await admin.request({
                action:'login-user-profile',csrfToken,login:'admin',password:'fixture-admin',
            });
            assert(profileAccessToken);
            const profile = {userId:'admin',profileAccessToken};
            const bookUid = page.next._uid;
            const state = await admin.request({action:'get-reader-state',...profile,bookUid});
            const progress = await admin.request({action:'update-reader-progress',...profile,csrfToken,bookUid,
                progress:{percent:1,generation:state.progressGeneration,baseRevision:0}});
            assert.equal(progress.progress?.percent,1,progress.error);
            const personalized = await admin.request({...entity,...profile,options:{...options,page:1}});
            assert.equal(personalized.read,1,personalized.error);
            assert.equal(personalized.next.title,'Маршрут 002');
            assert.equal(personalized.books[0]._readerProgress.percent,1);
            const publicPage = await guest.request({...entity,options:{...options,page:1}});
            assert.equal(publicPage.read,null);
            assert.equal(publicPage.books[0]._readerProgress,undefined);
            assert.equal(publicPage.next.title,'Маршрут 001');

            const mark = {action:'mark-series-until',...profile,options:{
                name:'Маршрут',bookUid:personalized.books[1]._uid,
            }};
            assert.equal((await admin.request(mark)).error,'bad_csrf_token');
            const guestConfig = await guest.request({action:'get-config'});
            assert.equal((await guest.request({...mark,profileAccessToken:'',csrfToken:guestConfig.csrfToken})).error,
                'need_profile_login');
            const invalid = await admin.request({...mark,csrfToken,options:{...mark.options,bookUid:'outside-series'}});
            assert.match(invalid.error,/номер в серии/);
            const marked = await admin.request({...mark,csrfToken});
            assert.deepEqual(marked.bookUids,personalized.books.map(book=>book._uid),marked.error);
            const afterMark = await admin.request({...entity,...profile,options:{...options,page:1}});
            assert.equal(afterMark.read,2);
            assert.equal(afterMark.next.title,'Маршрут 003');
            const markAll = {action:'mark-series-read',...profile,csrfToken,series:'Маршрут'};
            assert.equal((await admin.request(markAll)).success,true);
            const allRead = await admin.request({...entity,...profile});
            assert.equal(allRead.read,105);
            assert.equal(allRead.next,null);
            assert.equal((await admin.request({...markAll,read:false})).success,true);
        } finally { guest.close(); admin.close(); }
    } finally { await server.stop(); }
    console.log('ok standalone OPDS and author/series pages, scope, pagination, progress and guest isolation');
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
        for (const path of ['/reader/cover/123', byUid.replace('/book/', '/cover/')]) {
            for (const headers of [{'sec-fetch-dest':'image'},{referer:restricted.url+'/',accept:'image/webp,image/*'}]) {
                const image = await fetch(restricted.url+path,{headers});
                assert.equal(image.status,401);
                assert.equal(image.headers.get('www-authenticate'),null);
                assert.equal(image.headers.get('cache-control'),'no-store');
            }
            await check(restricted,path,401);
        }
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
    await fs.writeFile(join(data,'reading-lists.json'),JSON.stringify({version:5,
        users:[{id:'default',name:'Профиль проверки',login:'fixture-reader'}],lists:[],
        profileAuthPolicy:{otpRequired:false,trustedBrowsersEnabled:true,trustedBrowserDays:30},
        readerProgressCheckpoint:'1234567890abcdef1234567890abcdef'}));
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
            assert.deepEqual(reading.bookmarks.map(row=>row.title),['Оставленная закладка']);
            const shelf = await ws.request({action:'get-reading-list',userId:'default',listId});
            assert.equal(shelf.list?.name,'Личная полка',shelf.error);
            assert.equal(shelf.books[0]._readingListRead,true);
            assert.deepEqual((await ws.request({action:'get-overview-pinned-shelves',userId:'default'})).shelfIds,[listId]);
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
                assert.deepEqual(current.bookmarks.map(row=>row.title),['Оставленная закладка']);
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
    const legacyCidrs = '192.0.2.10/32, 127.0.0.1';
    await fs.writeFile(config,JSON.stringify({...settings,authMode:'local',trustProxy:true,trustedProxyCidrs:legacyCidrs}));
    const legacy = await start(binary,args);
    try {
        const headers = {Host:'books.example.invalid','X-Forwarded-Proto':'https','X-Forwarded-Scheme':'https'};
        const page = await check(legacy,'/reader/',200,{headers});
        const cookie = page.headers.get('set-cookie');
        assert.match(cookie,/; Secure$/);
        await page.body.cancel();
        const ws = await wsClient(legacy.url,cookie.split(';')[0],{...headers,origin});
        try { assert.ok((await ws.request({action:'get-config'})).csrfToken); }
        finally { ws.close(); }
        await assert.rejects(wsClient(legacy.url,null,{...headers,origin:'https://other.example.invalid'}),/403/);
    } finally { await legacy.stop(); }

    await fs.writeFile(config,JSON.stringify({...settings,allowAnonymousAccess:false,trustedProxyCidrs:legacyCidrs}));
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
        requireAuth:true,authMode:'local',allowAnonymousAccess:true,accessPassword:password,accessTimeout:5,
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
            const cookie = sessionCookieHeader(view);
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
            const dashboard = await ws.request({action:'get-admin-dashboard-metrics',csrfToken,
                userId:login.userId,profileAccessToken:login.profileAccessToken});
            const account = dashboard.activity?.profiles.find(row=>row.profile===label);
            assert.equal(account?.login,'admin',dashboard.error);
            assert(account.name);
            assert.deepEqual([account.logins,account.downloads],[1,2]);
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
        inpxCheckInterval:0, librarySources:[{id:'main',inpx:archive,libDir:library},
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
            const originalBook = await find(ws,'Packaged smoke book');
            stable = originalBook._uid;
            const coverUrl = '/reader/cover/by-uid?'+new URLSearchParams({uid:stable});
            async function readCover() {
                const response = await fetch(url + coverUrl);
                assert.equal(response.status,200);
                return bytes(response);
            }
            const embedded = await readCover();
            assert.equal(embedded.readUInt32BE(0),0x89504e47);
            const link = () => ws.request({...command,action:'get-book-link',bookUid:stable});
            const first = await link();
            assert.ok(first.link,first.error);
            const descriptor = join(data,'public-files','source-verified-v1','book',first.link.split('/').pop()+'.d.json');
            await fs.writeFile(descriptor,JSON.stringify({...await readJson(descriptor),cacheHitMarker:true}));
            assert.equal((await link()).link,first.link);
            assert.equal((await readJson(descriptor)).cacheHitMarker,true,'A repeat request republished the book');
            assert(await find(ws,'Original folder record'));
            const follow = (operation,payload)=>ws.request({...command,action:'change-library-follow',operation,payload});
            const news = options=>ws.request({...command,action:'get-library-follows',options});
            assert.equal((await ws.request({action:'change-library-follow'})).error,'bad_csrf_token');
            const added = await follow('add',{kind:'author',value:originalBook.author});
            assert.equal(added.unseenCount,0,added.error);
            assert.deepEqual(added.follows.map(row=>row.revision),[1]);
            assert.equal((await follow('add',{kind:'author',value:originalBook.author.toUpperCase()})).follows.length,1);
            assert.deepEqual((await follow('add',{kind:'series',value:'Подписная серия'})).follows.map(row=>row.unread),[0,0]);
            assert.deepEqual((await news({autoRefresh:true,limit:0})).follows.map(row=>row.revision),[1,1]);
            const before = await index(url);
            // The same UID retains its embedded cover across publication.
            await fs.unlink(original);
            await fs.writeFile(replacement,book('Replacement folder record'));
            const row = ['Tester,Smoke:', 'sf:', 'Updated smoke book', '', '0', '1', '100', '1', '0', 'fb2', '2026-09-14', 'en', '0', ''];
            const date = new Date().toISOString().slice(0,10);
            const fresh = [...row];
            Object.assign(fresh,{0:'Other,Author:Tester,Smoke:',2:'New book by followed coauthor',3:'Подписная серия',
                4:'1',5:'2',7:'2',10:date,12:'5'});
            await fs.writeFile(archive,await zip([['collection.info','Smoke library\n'],['version.info','20260915'],['smoke.inp',
                [row,fresh].map(book=>book.join('\x04')).join('\n')+'\n']]));
            assert.equal((await ws.request(command)).started,true);
            const after = await updated(url,status=>status.inpxHash!==before.inpxHash);
            assert.equal(after.ready,true);
            assert.equal(after.stats.bookCount,3);
            assert.equal(after.indexUpdate.incremental,true);
            assert.equal(after.indexUpdate.recordsChanged,3);
            assert.equal(after.indexUpdate.recordsRemoved,1);
            assert.equal((await find(ws,'Updated smoke book'))._uid,stable);
            assert.deepEqual(await readCover(),embedded);
            // A changed sidecar must be observed even when the INPX row stays the same.
            const external = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
            await fs.mkdir(join(library,'covers'),{recursive:true});
            await fs.writeFile(join(library,'covers','smoke.zip'),await zip([['1',external]]));
            await fs.mkdir(join(library,'images'),{recursive:true});
            await fs.writeFile(join(library,'images','smoke.zip'),await zip([['1/figure',embedded]]));
            const stripped = '<FictionBook><description><title-info><book-title>Updated smoke book</book-title></title-info></description><body><section><image href="#figure"/></section></body></FictionBook>';
            // Both asset directories also contain smoke.zip, ahead of the book
            // directory in alphabetical order.
            await fs.mkdir(join(library,'volumes'),{recursive:true});
            await fs.rename(join(library,'smoke.zip'),join(library,'volumes','smoke.zip'));
            await fs.writeFile(join(library,'volumes','smoke.zip'),await zip([['1.fb2',stripped]]));
            const current = await index(url);
            assert.equal((await ws.request(command)).started,true);
            await updated(url,status=>status.indexUpdate.updatedAt!==current.indexUpdate.updatedAt);
            assert.deepEqual(await readCover(),external);
            const restored = await link();
            assert.notEqual(restored.link,first.link);
            const gallery = await ws.request({...command,action:'get-book-gallery',bookUid:stable});
            assert.deepEqual(gallery.images.map(image=>image.id),['figure']);
            const raw = await (await fetch(url+restored.link+'/raw')).text();
            assert(raw.includes(embedded.toString('base64')) && raw.includes(external.toString('base64')));
            await fs.writeFile(join(library,'images','smoke.zip'),await zip([['1/figure',external]]));
            assert.notEqual((await link()).link,restored.link);
            assert.equal(await find(ws,'Packaged smoke book'),undefined);
            assert.equal(await find(ws,'Original folder record'),undefined);
            assert(await find(ws,'Replacement folder record'));
            const freshBook = await find(ws,fresh[2]);
            assert(freshBook);
            const shelves = await ws.request({...command,action:'get-discovery-shelves',newestLimit:1,popularLimit:1});
            assert.equal(shelves.shelves?.find(row=>row.id==='newest-7d')?.items[0]._uid,freshBook._uid,shelves.error);
            assert.equal(shelves.shelves?.find(row=>row.id==='popular')?.items[0]._uid,freshBook._uid,shelves.error);
            const counts = await news({autoRefresh:true,limit:0});
            assert.deepEqual(counts.follows?.map(row=>row.unread),[1,1],counts.error);
            assert.equal(counts.unseenCount,1);
            assert.equal(counts.truncated,true);
            assert.deepEqual(counts.books,[]);
            assert.deepEqual((await news({limit:1})).books.map(book=>book._uid),[freshBook._uid]);
            assert.deepEqual((await news({offset:1})).books,[]);
            assert.equal((await follow('seen-books',{bookUids:[freshBook._uid]})).unseenCount,0);
            assert.equal((await news({refresh:true})).unseenCount,0);
            assert.equal((await follow('remove',{id:counts.follows[1].id})).follows.length,1);
            const guest = await wsClient(url,await browserCookie(url));
            try { assert.equal((await guest.request({action:'get-library-follows',userId:'default'})).error,'need_profile_login'); }
            finally { guest.close(); }
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
        const after = await updated(timed.url,status=>status.stats.bookCount===4);
        assert.notEqual(after.inpxHash,hash);
        hash = after.inpxHash;
        const ws = await wsClient(timed.url,await browserCookie(timed.url));
        try {
            const {csrfToken} = await ws.request({action:'get-config'});
            const {profileAccessToken} = await ws.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken});
            const news = await ws.request({action:'get-library-follows',userId:'admin',profileAccessToken,options:{autoRefresh:true}});
            assert.equal(news.follows?.length,1,news.error);
            assert.equal(news.follows[0].revision,3);
            assert.equal(news.unseenCount,0);
        } finally { ws.close(); }
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
            assert.equal((await index(legacy.url)).stats.bookCount,4);
            assert.equal((await fetch(legacy.url+'/catalogue/v2/book?uid='+encodeURIComponent(stable))).status,200);
        } finally { await legacy.stop(); }
    }
    console.log('ok standalone admin, periodic and forced catalogue updates preserve book identity and recover from a broken filter');
}

async function verifyTwoLibraries(binary, root) {
    const libraries = require('./rust-two-libraries-tests');
    const state = await libraries.fixture(root);
    const web = join(root, 'web.json');
    await bundle(web);
    const args = ['--standalone', '--host=127.0.0.1', '--data-dir=' + join(root, 'data'),
        '--config=' + join(root, 'config.json'), '--web-bundle=' + web, '--admin-password=' + libraries.password];
    const cache = join(root, 'data', 'db', 'browser-catalogue-v1.cache');
    for (const phase of ['index', 'restart', 'upgrade', 'repair']) {
        if (phase === 'upgrade') await fs.unlink(cache);
        if (phase === 'repair') await fs.writeFile(cache, 'partial cache');
        const prior = phase === 'restart' ? await fs.stat(cache) : null;
        const server = await start(binary, args);
        try {
            const saved = await fs.stat(cache);
            assert(saved.size > 32, 'Default pages and directories are ready before the first request');
            if (prior) assert.equal(saved.mtimeMs, prior.mtimeMs, 'Restart reuses the prepared catalogue');
            await libraries.verify(server.url, state, phase === 'index');
        }
        finally { await server.stop(); }
    }
    console.log('ok two INPX libraries retain separate books, covers, illustrations and progress after reindex and restart');
}

async function verifyLibraryMedia(binary, root) {
    const data = join(root,'data'), library = join(root,'library'), config = join(root,'config.json'), web = join(root,'web.json');
    await createFixture(library);
    await bundle(web);
    const inpx = join(library,'smoke.inpx');
    const row = ['Tester,Smoke:','sf:','Packaged smoke book','Fixture series','1','1','100','1','0','fb2','2026-11-16','en','4',''];
    const epub = await zip([
        ['META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'],
        ['content.opf','<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>urn:isbn:9783161484100</dc:identifier></metadata></package>'],
    ]);
    const epubRow = [...row];
    Object.assign(epubRow,{2:'ISBN in EPUB',4:'2',5:'3',6:String(epub.length),7:'552',9:'epub'});
    const padding = Array.from({length:550},(_,index)=>{
        const fields = [...row];
        Object.assign(fields,{2:'Slow ISBN sample '+index,3:'',4:'0',5:index<72 ? String(1000+index) : '2',7:String(index+2)});
        return fields.join('\x04');
    });
    const index = await zip([
        ['collection.info','Media fixture\n'],['smoke.inp',[row.join('\x04'),...padding,epubRow.join('\x04')].join('\n')+'\n'],
    ]);
    await fs.writeFile(inpx,index);
    const fb2 = (name,isbn,extra='')=>`<FictionBook><description><title-info><book-title>${name}</book-title><lang>en</lang><annotation><p>${extra}</p></annotation></title-info><publish-info><isbn>${isbn}</isbn></publish-info></description><body><section><p>Sample text.</p></section></body></FictionBook>`;
    const independent = Array.from({length:72}, (_,i)=>[(1000+i)+'.fb2', fb2('Sample '+i,'')]);
    await fs.writeFile(join(library,'smoke.zip'),await zip([
        ['1.fb2',fb2('Packaged smoke book','0-306-40615-2')],
        ...independent,
        ['2.fb2',fb2('Slow ISBN sample','','a'.repeat(512*1024))],
        ['3.epub',epub],
    ]));
    const biographies = join(library,'etc','authors');
    await fs.mkdir(join(biographies,'pictures'),{recursive:true});
    const key = createHash('md5').update('tester smoke').digest('hex');
    await fs.writeFile(join(biographies,'1.zip'),await zip([[key+'.html','<h2 onclick="evil()">Биография</h2><p>Об авторе &amp; книгах.</p>']]));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=','base64');
    await fs.writeFile(join(biographies,'pictures','1.zip'),await zip([[key+'/cover.png',png]]));
    const reviewsDir = join(library,'reviews');
    await fs.mkdir(reviewsDir,{recursive:true});
    const reviews = Array.from({length:11},(_,i)=>({name:i?'Тест':'',time:'17 ноября',text:'Отзыв<br>№ '+i}));
    const windows = require('iconv-lite');
    await fs.writeFile(join(reviewsDir,'001.zip'),await zip([['smoke.7Z#1.fb2',windows.encode(JSON.stringify([...reviews,reviews[0]]),'win1251')]]));
    const ratings = count=>zip([['books.json',JSON.stringify({
        book:{folder:'smoke.7z',file:'1.fb2',sum:count*4.5,count},invalid:{folder:'smoke.zip',file:'2.fb2',sum:90,count:1},
    })]]);
    await fs.writeFile(join(reviewsDir,'additional.zip'),await ratings(4));
    const settings = {server:{host:'127.0.0.1',root:'/reader'},allowRemoteLib:true,inpxCheckInterval:0,librarySources:[{id:'main',inpx}]};
    await fs.writeFile(config,JSON.stringify(settings));
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=fixture-admin'];
    const connect = async server=>{
        const socket = await wsClient(server.url,await browserCookie(server.url));
        const {csrfToken} = await socket.request({action:'get-config'});
        const {profileAccessToken} = await socket.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken});
        assert(profileAccessToken);
        return {socket,send:(action,fields={})=>socket.request({action,csrfToken,userId:'admin',profileAccessToken,...fields})};
    };
    async function waitFor(read, state) {
        for (let i=0;i<240;i++) {
            const status=await read();
            if(status.state===state) return status;
            assert(!status.error || status.state==='running' || status.state==='paused',status.error);
            await sleep(50);
        }
        assert.fail('Background task did not reach '+state);
    }
    let uid, smartId;
    let server = await start(binary,args);
    try {
        const {socket,send} = await connect(server);
        const publicWs = await wsClient(server.url,await browserCookie(server.url));
        try {
            const query = {title:'=Packaged smoke book',del:'0'};
            const {found} = await publicWs.request({action:'bookSearch',query});
            uid = found[0]._uid;
            const {found:authors} = await send('search',{from:'author',query:{author:'=Tester Smoke'}});
            const bio = await publicWs.request({action:'get-author-info',authorId:authors[0].id});
            assert.equal(bio.authorInfo?.key,key,bio.error);
            assert.equal(bio.authorInfo?.text,'Биография Об авторе & книгах.');
            assert.equal(bio.authorInfo?.html,'<h2>Биография</h2><p>Об авторе &amp; книгах.</p>');
            assert.equal(bio.authorInfo?.photo,'data:image/png;base64,'+png.toString('base64'));
            const author = await send('get-library-metadata',{kind:'author',author:'  TESTER  Smoke  '});
            assert.equal(author.authorInfo.html,bio.authorInfo.html);
            assert.equal((await send('get-author-info',{author:'Другой автор'})).authorInfo,null);
            const {reviews:items,libraryRating,error} = await send('get-book-reviews',{bookUid:uid});
            assert.equal(items?.length,11,error);
            assert.deepEqual(items[0],{name:'Аноним',time:'17 ноября',text:'Отзыв\n№ 0'});
            assert.deepEqual(libraryRating,{value:4.5,count:4});
            assert.deepEqual((await send('get-library-metadata',{kind:'rating',bookUid:uid})).rating,libraryRating);
            const page = await send('get-library-metadata',{kind:'reviews',bookUid:uid});
            assert.equal(page.items.length,10);
            assert.equal(page.next,10);
            const last = await send('get-library-metadata',{kind:'reviews',bookUid:uid,cursor:page.next});
            assert.deepEqual(last.items,[items[10]]);
            assert.equal(last.next,null);
            assert.match((await send('get-library-metadata',{kind:'reviews',bookUid:uid,cursor:-1})).error,/Некорректная позиция/);
            await waitFor(()=>send('get-rating-index-status'),'ready');
            const rated = await send('get-library-metadata',{kind:'ratings'});
            assert.deepEqual(rated.items,[[uid,4]],rated.error);
            assert.equal(rated.next,null);
            let foundRated = await send('bookSearch',{query:{...query,ratingCount:'2..4'}});
            assert.deepEqual(foundRated.found?.map(book=>book._uid),[uid],foundRated.error);
            await fs.writeFile(join(reviewsDir,'additional.zip'),await ratings(8));
            assert.match((await send('get-library-metadata',{kind:'ratings',revision:rated.revision})).error,/обновился/);
            foundRated = await send('bookSearch',{query:{...query,ratingCount:'2..4'}});
            assert.deepEqual(foundRated.found,[]);
            assert.deepEqual((await send('bookSearch',{query:{...query,ratingCount:'8..'}})).found.map(book=>book._uid),[uid]);

            const exported = await send('get-inpx-file');
            assert.deepEqual(Buffer.from(exported.data,'base64'),index);
            assert.equal((await send('get-inpx-file',{inpxFileHash:createHash('sha256').update(index).digest('hex')})).data,false);
            const logger = new (require('../server/core/AppLogger'))();
            if (!logger.inited) await logger.init({loggingEnabled:false});
            const RemoteLib = require('../server/core/RemoteLib');
            const copied = join(root,'remote.inpx');
            const remote = new RemoteLib({remoteLib:{url:server.url.replace(/^http/,'ws')+'/reader/ws'},inpxFile:copied,maxPayloadSize:4});
            try {
                assert.equal(await remote.metadata.supported(),true);
                assert.equal(await remote.metadata.supported('ratings'),true);
                assert.deepEqual(await remote.metadata.rating(uid),{value:4.5,count:8});
                assert.deepEqual(await remote.metadata.reviews(uid),items);
                await remote.downloadInpxFile();
                assert.deepEqual(await fs.readFile(copied),index);
            } finally {remote.wsc.close();}

            const dbPatch = {bookUid:uid,metadata:{title:'  Новое    название  ',serno:'2.4'}};
            assert.equal((await publicWs.request({action:'update-book-metadata',...dbPatch})).error,'bad_csrf_token');
            const {csrfToken} = await publicWs.request({action:'get-config'});
            assert.equal((await publicWs.request({action:'update-book-metadata',csrfToken,...dbPatch})).error,'need_profile_login');
            const patched = await send('update-book-metadata',dbPatch);
            assert.equal(patched.override?.title,'Новое название',patched.error);
            assert.equal(patched.override?.serno,2);
            assert.equal((await publicWs.request({action:'bookSearch',query})).found[0].title,'Новое название');
            const info = await publicWs.request({action:'get-book-info',bookUid:uid,card:true});
            assert.equal(info.bookInfo?.book.title,'Новое название',info.error);

            const byIsbn = isbn=>send('bookSearch',{query:{isbn,del:'0',lang:'en'}});
            assert.match((await byIsbn('9780306406157')).error,/не готов/);
            assert.equal((await publicWs.request({action:'start-isbn-index',csrfToken})).error,'need_profile_login');
            const started = await send('start-isbn-index');
            assert.equal(started.state,'running',started.error);
            const status = async()=>(await send('get-background-tasks')).isbnIndex;
            const ordinary = await send('bookSearch',{query});
            assert.equal(ordinary.found[0]._uid,uid);
            await send('cancel-isbn-index');
            const paused = await waitFor(status,'paused');
            assert(paused.checked < started.total);
            assert.equal((await send('start-isbn-index')).state,'running');
            const ready = await waitFor(status,'ready');
            assert.equal(ready.checked,552);
            assert.equal(ready.found,2);
            assert.equal(ready.errors,0);
            assert.deepEqual((await byIsbn('0-306-40615-2')).found.map(book=>book._uid),[uid]);
            assert.equal((await byIsbn('9783161484100')).found?.[0]?.title,'ISBN in EPUB');
            assert.match((await byIsbn('0-306-40615-9')).error,/корректный ISBN/);
            const smart = await send('create-reading-list',{name:'ISBN shelf',filters:{isbn:'9780306406157',ratingCount:'8'}});
            smartId = smart.list.id;
            const shelf = await send('get-reading-list',{listId:smartId});
            assert.deepEqual(shelf.books.map(book=>book._uid),[uid],shelf.error);
        } finally {socket.close();publicWs.close();}
    } finally {await server.stop();}
    await fs.writeFile(config,JSON.stringify({...settings,allowRemoteLib:false}));
    server = await start(binary,args);
    try {
        const {socket,send} = await connect(server);
        try {
            assert.equal((await send('get-inpx-file')).error,'Remote lib access disabled');
            assert.equal((await send('get-background-tasks')).isbnIndex.state,'ready');
            const sevenZip = require('../server/core/ExternalTools').sevenZipCommandCandidates()
                .find(tool=>spawnSync(tool,['i'],{windowsHide:true,stdio:'ignore'}).status===0);
            if (sevenZip) {
                const input = join(root,'solid-isbn');
                await fs.mkdir(input);
                await fs.writeFile(join(input,'1.fb2'),fb2('Packaged smoke book','0-306-40615-2'));
                await fs.writeFile(join(input,'2.fb2'),fb2('Slow ISBN sample',''));
                await fs.writeFile(join(input,'3.epub'),epub);
                for (const [name, contents] of independent) await fs.writeFile(join(input,name),contents);
                await fs.writeFile(join(input,'1071.fb2'),fb2('Sample 71','9780131103627'));
                const archive = join(library,'smoke.7z');
                await fs.rename(join(library,'smoke.zip'),join(input,'original.zip'));
                for (const solid of ['on','4k','off']) {
                    if (solid !== 'on') await fs.unlink(archive);
                    execFileSync(sevenZip,['a','-t7z','-ms='+solid,'-mmt=1',archive,'*.fb2','3.epub'],{cwd:input,windowsHide:true,stdio:'ignore'});
                    await send('start-isbn-index',{options:{force:true}});
                    const rebuilt = await waitFor(async()=>(await send('get-background-tasks')).isbnIndex,'ready');
                    assert.deepEqual([rebuilt.checked,rebuilt.found,rebuilt.errors],[552,3,0]);
                    assert.equal((await send('bookSearch',{query:{isbn:'9780131103627'}})).found?.[0]?.title,'Slow ISBN sample 71');
                    assert.equal((await send('bookSearch',{query:{isbn:'9783161484100'}})).found?.[0]?.title,'ISBN in EPUB');
                }
            }
            const found = await send('bookSearch',{query:{isbn:'9780306406157'}});
            assert.equal(found.found?.[0]._uid,uid,found.error);
            assert.equal(found.found[0].title,'Новое название');
            const shelf = await send('get-reading-list',{listId:smartId});
            assert.deepEqual(shelf.books?.map(book=>book._uid),[uid],shelf.error);
        } finally {socket.close();}
    } finally {await server.stop();}
    console.log('ok Rust author archives, reviews and rating exchange, INPX hash and access, metadata overrides, ISBN cancel/resume and restart');
}

async function verifySeriesZip(binary, root) {
    const series = 'Тестовая серия';
    await fs.mkdir(root);
    const entries = [], rows = [];
    for (let i=1; i<=201; i++) {
        const text = 'Book '+i;
        entries.push([i+'.txt',text]);
        rows.push(['Tester:', 'sf:', text, series, i, i, text.length, i, 0, 'txt', '2026-01-01', 'ru', 0, ''].join('\x04'));
    }
    await fs.writeFile(join(root,'books.zip'),await zip(entries));
    const inpx = join(root,'books.inpx');
    await fs.writeFile(inpx,await zip([['collection.info','Series'],['version.info','20260101'],['books.inp',rows.join('\n')+'\n']]));
    const config = join(root,'config.json'), web = join(root,'web.json');
    await fs.writeFile(config,JSON.stringify({server:{host:'127.0.0.1',root:'/reader'},librarySources:[{id:'main',inpx}]}));
    await bundle(web);
    const password = 'series-zip-fixture';
    const server = await start(binary,['--standalone','--data-dir='+join(root,'data'),'--config='+config,'--web-bundle='+web,'--admin-password='+password]);
    try {
        const cookie = await browserCookie(server.url);
        const ws = await wsClient(server.url,cookie);
        try {
            const {csrfToken} = await ws.request({action:'get-config'});
            const {userId,profileAccessToken} = await ws.request({action:'login-user-profile',login:'admin',password,csrfToken});
            const auth = {userId,profileAccessToken,csrfToken};
            const prepare = {action:'prepare-batch-download',selection:{series},wantProgress:true,...auth};
            assert((await ws.request({action:'set-admin-resource-profile',profile:'balanced',...auth})).success);
            assert.match((await ws.request(prepare)).error,/200 книг/);
            assert((await ws.request({action:'set-admin-resource-profile',profile:'unlimited',...auth})).success);
            const progress = [];
            const result = await ws.request(prepare, update=>progress.push(update));
            assert.equal(result.count,201,result.error);
            assert.deepEqual(progress[0],{done:0,total:201});
            assert.deepEqual(progress.at(-1),{done:201,total:201});
            assert(progress.every((step,i)=>step.total===201 && (!i || step.done>progress[i-1].done)));
            const response = await fetch(server.url+result.url,{headers:{cookie}});
            assert.equal(response.status,200);
            const file = join(root,'received.zip');
            await fs.writeFile(file,await bytes(response));
            const archive = new (require('node-stream-zip').async)({file});
            try {
                const names = Object.keys(await archive.entries());
                assert.equal(names.length,201);
                assert.equal((await archive.entryData(names[0])).toString(),'Book 1');
                assert.equal((await archive.entryData(names.at(-1))).toString(),'Book 201');
            } finally {await archive.close();}
        } finally {ws.close();}
    } finally {await server.stop();}
    console.log('ok whole-series ZIP with per-request progress and live resource profile limits');
}

async function verifyMobileEvents(binary, root) {
    const library=join(root,'library'), data=join(root,'data'), web=join(root,'web.json'), config=join(root,'config.json');
    const events = require('./rust-events-tests');
    await events.fixture(library,1000);
    await bundle(web);
    await fs.writeFile(config,JSON.stringify({server:{host:'127.0.0.1',root:'/reader'},inpxCheckInterval:0,
        librarySources:[{id:'main',inpx:join(library,'events.inpx')}]}));
    const server=await start(binary,['--standalone','--data-dir='+data,'--config='+config,
        '--web-bundle='+web,'--admin-password='+events.password]);
    try {await events.verify(server.url,'/reader');}
    finally {await server.stop();}
}

async function verifyProfileCommands(binary, root) {
    const library = join(root,'library'), data = join(root,'data'), config = join(root,'config.json'), web = join(root,'web.json');
    await createFixture(library);
    await bundle(web);
    const otherConfig = join(root,'other-config.json');
    const settings = JSON.stringify({server:{host:'127.0.0.1',root:'/reader'},inpxCheckInterval:0,
        librarySources:[{id:'main',inpx:join(library,'smoke.inpx')}]});
    await fs.writeFile(config,settings);
    await fs.writeFile(otherConfig,settings);
    const adminPassword = 'profile-commands-fixture-admin';
    const args = (dir, file) => ['--standalone','--data-dir='+dir,'--config='+file,'--web-bundle='+web,'--admin-password='+adminPassword];
    const server = await start(binary,args(data,config),{INPX_ALLOW_ANONYMOUS_ACCESS:'false',INPX_TRUST_PROXY:'true',INPX_TRUSTED_PROXY_CIDRS:'127.0.0.1/32'});
    try {
        const other = await start(binary, args(join(root,'other-data'),otherConfig),
            {INPX_ALLOW_ANONYMOUS_ACCESS:'false'});
        try {await verifyCoverSessions(server.url, other.url, adminPassword);}
        finally {await other.stop();}
        await require('./rust-profile-tests')(server.url,{root:'/reader',adminPassword,trust:true});
        const profiles = await readJson(join(data,'reading-lists.json'));
        assert(profiles.lists.every(list=>list.name!=='Profile deletion fixture'));
        const admin = profiles.users.find(user=>user.isAdmin);
        assert(admin.profileTotp.secret.startsWith('enc:v1:'));
        assert.equal(admin.profileTotp.recoveryHashes.length,3);
    } finally { await server.stop(); }
}

async function verifyCoverSessions(first, second, password) {
    // A browser shares its cookie jar across ports on one host and path.
    const jar = new Map();
    const headers = () => ({cookie:[...jar].map(([k,v]) => k+'='+v).join('; ')});
    const covers = [];
    for (const url of [first,second]) {
        const page = await fetch(url+'/reader/',{headers:headers()});
        const pair = sessionCookieHeader(page).split(';')[0];
        await page.body.cancel();
        const [name, value] = pair.split('=');
        jar.set(name,value);
        const ws = await wsClient(url,headers().cookie);
        try {
            const config = await ws.request({action:'get-config'});
            assert.equal(config.profileAuthorized,false);
            const login = await ws.request({action:'login-user-profile', login:'admin',password,csrfToken:config.csrfToken});
            assert.equal(login.userId,'admin',login.error);
            const books = await ws.request({action:'bookSearch',userId:login.userId,profileAccessToken:login.profileAccessToken,query:{limit:1}});
            assert.ok(books.found?.length,books.error);
            covers.push(url+'/reader/cover/by-uid?uid='+encodeURIComponent(books.found[0]._uid));
        } finally {ws.close();}
        for (const cover of covers) {
            const response = await fetch(cover,{headers:headers()});
            assert.equal(response.status,200,'Both instances must keep their signed-in browser session');
            assert.equal(response.headers.get('content-type'),'image/png');
            await response.body.cancel();
        }
    }
    for (const cover of covers) {
        const guest = await fetch(cover);
        assert.equal(guest.status,401,'Guest access to a cached private cover must still require login');
        await guest.body.cancel();
    }
}

async function verifyCacheSettings(binary, root) {
    const test = require('./rust-cache-settings-tests');
    const library = join(root,'library'), data = join(root,'data'), web = join(root,'web.json');
    await createFixture(library);
    await bundle(web);
    const server = await start(binary,['--standalone','--host=127.0.0.1','--data-dir='+data,
        '--lib-dir='+library,'--web-bundle='+web,'--admin-password='+test.password], test.env);
    try { await test.verify(server.url, data); }
    finally { await server.stop(); }
    console.log('ok cache environment defaults, file rotation and live Prometheus limits');
}

async function verifyStandaloneIpv6(binary, root) {
    const {connect} = require('./rust-events-tests');
    const library = join(root, 'library'), web = join(root, 'web.json'), config = join(root, 'settings.json');
    await createFixture(library);
    await bundle(web);
    const args = ['--standalone', '--data-dir='+join(root, 'data'), '--config='+config,
        '--lib-dir='+library, '--web-bundle='+web, '--admin-password=ipv6-fixture'];
    const proxy = {INPX_TRUST_PROXY:'true', INPX_TRUSTED_PROXY_CIDRS:'::/0'};
    const ipv4 = await start(binary,args,proxy);
    try {
        const url = new URL('/ready',ipv4.url);
        url.hostname = '[::1]';
        await assert.rejects(fetch(url,{signal:AbortSignal.timeout(2000)}), error => error.cause?.code === 'ECONNREFUSED');
    } finally {await ipv4.stop();}
    await assert.rejects(start(binary,[...args,'--host=::/0']), /Для --host .* используйте ::/);
    for (const [host, flags] of [['0.0.0.0', ['--host=::']], ['::', []]]) {
        await fs.writeFile(config,JSON.stringify({server:{host}}));
        const server = await start(binary,[...args,...flags],undefined,undefined,'[::1]');
        try {
            const browser = await connect(server.url);
            browser.close();
        } finally {await server.stop();}
    }
    console.log('ok standalone direct IPv6 over HTTP and WebSocket, independent of proxy CIDRs');
}

async function verifyTelegramApi(binary, root) {
    const {connect,signIn} = require('./rust-events-tests');
    const library = join(root,'library'), data = join(root,'data'), web = join(root,'web.json');
    const password = 'telegram-api-fixture', token = '123456:telegram-api-fixture';
    const title = 'Large Telegram fixture';
    const content = Buffer.alloc(51 * 1024 * 1024, 'a');
    const row = ['Test,Author:','sf:',title,'','','1',content.length,'1','0','txt','2026-11-23','en','0',''].join('\x04');
    await fs.mkdir(library,{recursive:true});
    await fs.writeFile(join(library,'telegram.inpx'),await zip([['telegram.inp',row+'\n']]));
    await fs.writeFile(join(library,'telegram.zip'),await zip([['1.txt',content]]));
    await bundle(web);

    const calls = [];
    const relay = createServer(async (req,res) => {
        let length = 0;
        for await (const chunk of req) length += chunk.length;
        calls.push({url:req.url,type:req.headers['content-type'],length});
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,result:{username:'fixture_bot'}}));
    });
    relay.listen(0,'127.0.0.1');
    await once(relay,'listening');
    const url = `http://127.0.0.1:${relay.address().port}/relay/`;
    const args = ['--standalone','--host=127.0.0.1','--data-dir='+data,'--lib-dir='+library,
        '--web-bundle='+web,'--admin-password='+password];
    const env = {TELEGRAM_BOT_TOKEN:token, TELEGRAM_PROXY_MODE:'direct'};
    let server, client;
    try {
        server = await start(binary,args,env);
        client = await connect(server.url);
        let identity = await signIn(client,'admin',password);
        const send = (action, fields={}) => client.send(action,{...identity,...fields});
        const save = integrations => send('update-admin-integrations',{integrations});
        assert.equal((await send('get-config')).adminIntegrations.telegramApiMode,'cloud');
        assert.equal((await send('update-user-profile',{targetUserId:identity.userId,profile:{telegramChatId:'123'}})).error,undefined);
        const bookUid = (await send('bookSearch',{query:{title:'='+title}})).found[0]._uid;
        const upload = () => send('send-book-telegram',{bookUid,format:'original'});
        assert.match((await upload()).error,/50 МБ/);
        assert.match((await save({telegramApiMode:'local'})).error,/Укажите адрес/);
        assert.match((await save({telegramApiMode:'local',telegramApiUrl:'http://user@localhost:8081'})).error,/Некорректный адрес/);
        assert.match((await save({telegramApiMode:'local',telegramApiUrl:'https://api.telegram.org'})).error,/--local/);
        assert.equal((await save({telegramApiMode:'local',telegramApiUrl:url})).integrations.telegramApiMode,'local');
        assert.equal((await send('get-config')).telegramUploadTimeoutSeconds,1830);
        assert.equal((await send('test-admin-integration',{kind:'telegram'})).username,'fixture_bot');
        assert.equal((await upload()).success,true);
        assert.equal(calls[0].url,`/relay/bot${token}/getMe`);
        assert.equal(calls[1].url,`/relay/bot${token}/sendDocument`);
        assert.match(calls[1].type,/^multipart\/form-data/);
        assert(calls[1].length > content.length);

        client.close();
        await server.stop();
        server = await start(binary,args,env);
        client = await connect(server.url);
        identity = await signIn(client,'admin',password);
        assert.equal((await send('get-config')).adminIntegrations.telegramApiUrl,url);
        assert.equal((await save({telegramApiMode:'cloud'})).integrations.telegramApiMode,'cloud');
        assert.equal((await send('get-config')).telegramUploadTimeoutSeconds,300);
        assert.match((await upload()).error,/50 МБ/);
        assert.equal(calls.length,2);

        client.close();
        await server.stop();
        server = await start(binary,args,{...env,INPX_TELEGRAM_API_MODE:'local',INPX_TELEGRAM_API_URL:url});
        client = await connect(server.url);
        identity = await signIn(client,'admin',password);
        const config = (await send('get-config')).adminIntegrations;
        assert.equal(config.telegramApiModeLocked,true);
        assert.equal(config.telegramApiUrlLocked,true);
        assert.match((await save({telegramApiMode:'cloud'})).error,/INPX_TELEGRAM_API_MODE/);
        assert.equal((await upload()).success,true);
        assert.equal(calls.length,3);
    } finally {
        client?.close();
        await server?.stop();
        await new Promise(resolve=>relay.close(resolve));
    }
    console.log('ok Telegram local Bot API, multipart upload above 50 MiB, cloud limit, persistence and environment');
}

async function verifyRuntimeSettings(binary, root) {
    const {connect, signIn, waitFor} = require('./rust-events-tests');
    const library = join(root, 'library'), data = join(root, 'data'), web = join(root, 'web.json');
    const password = 'runtime-settings-fixture';
    await createFixture(library);
    await bundle(web);
    const args = ['--standalone', '--host=127.0.0.1', '--data-dir='+data, '--lib-dir='+library,
        '--web-bundle='+web, '--admin-password='+password];
    const server = await start(binary, args, {INPX_JXL_DECODER:'native'});
    try {
        const admin = await connect(server.url), guest = await connect(server.url);
        try {
            const identity = await signIn(admin, 'admin', password);
            const update = access => admin.send('update-admin-access', {...identity, access});
            const search = () => guest.send('search', {from:'title', query:{title:'', del:'0'}});
            assert.equal(guest.config.adminAccess, undefined);
            assert.equal(guest.config.adminRuntime, undefined);
            assert((await search()).totalFound > 0);
            assert.match((await guest.send('update-admin-access', {access:{allowAnonymousAccess:false}})).error, /need_profile_login|администратора/);
            assert.match((await update({trustedProxyCidrs:['192.0.2.1/64']})).error, /IPv4\/IPv6/);
            const importCidrs = trustedProxyCidrs => admin.send('import-admin-settings',{...identity,data:{trustedProxyCidrs}});
            assert.match((await importCidrs('192.0.2.1/64')).error,/IPv4\/IPv6/);
            assert.equal((await importCidrs('127.0.0.1, 192.0.2.10/32')).success,true);
            assert.deepEqual((await admin.send('get-config',identity)).adminAccess.trustedProxyCidrs,
                ['127.0.0.1/32','192.0.2.10/32']);
            assert.equal((await update({allowAnonymousAccess:false})).access.allowAnonymousAccess, false);
            await waitFor(()=>guest.events, events=>events.some(event=>event.kind==='access-policy'), 'Open WebSocket did not receive the policy change');
            assert.equal((await search()).error, 'need_profile_login');
            assert.equal((await guest.send('get-config')).profileLoginRequired, true);
            assert.equal((await update({allowAnonymousAccess:true})).access.allowAnonymousAccess, true);
            assert((await search()).totalFound > 0);
            const invalid = await admin.send('update-admin-runtime', {...identity, settings:{jxlDecoder:'djxl'}});
            assert.match(invalid.error, /INPX_JXL_DECODER/);
            const changed = await admin.send('update-admin-runtime', {...identity, settings:{
                inpxCheckInterval:0, isbnMaxBookBytes:4194304, coverMemoryMb:0, conversionEnabled:false,
                resourceImages:2, ttsModel:'fixture-model', ttsApiKey:'fixture-speech-key',
            }});
            assert.equal(changed.error, undefined);
            assert.equal(changed.runtime.limits.images, 2);
            assert.equal(changed.runtime.settings.ttsApiKey, '__KEEP__');
            assert.deepEqual((await guest.send('get-config')).conversionFormats, []);
            const disk = await readJson(join(data, 'config.json'));
            assert.equal(disk.isbnMaxBookBytes, 4194304);
            assert.equal(disk.ttsModel, 'fixture-model');
            assert.notEqual(disk.ttsApiKey, 'fixture-speech-key');

            const save = settings => admin.send('update-admin-runtime', {...identity, settings});
            const opds = settings => admin.send('update-admin-opds', {...identity, opds:settings});
            assert((await opds({feedsFile:'missing.json'})).error);
            await fs.writeFile(join(data, 'collections.json'), JSON.stringify({version:1, shelves:[]}));
            const feeds = await opds({compatibility:'tolino', feedsFile:'collections.json'});
            assert.equal(feeds.opds.feedsFile, 'collections.json');
            assert.equal(feeds.opds.compatibility, 'tolino');
            assert.match((await save({fb2cngArgs:['--output-file']})).error, /переопределять/);
            assert.deepEqual((await save({fb2cngArgs:['--no-cover']})).runtime.settings.fb2cngArgs, ['--no-cover']);
            assert.equal((await fetch(server.url+'/kosync/healthcheck')).status, 200);
            assert.equal((await save({kosyncEnabled:false})).runtime.settings.kosyncEnabled, false);
            assert.equal((await fetch(server.url+'/kosync/healthcheck')).status, 404);
            assert.equal((await save({kosyncEnabled:true})).runtime.settings.kosyncEnabled, true);
            assert.equal((await fetch(server.url+'/kosync/healthcheck')).status, 200);

            assert((await update({authMode:'proxy', requireAuth:true})).error);
            assert((await save({metricsPath:'/ready'})).error);
            const services = await save({metricsEnabled:true, metricsPath:'/observe', metricsToken:'first-metrics',
                absEnabled:true, absPublicUrl:'https://library.example.test', absToken:'first-abs', absMaxResults:3});
            assert.equal(services.runtime.settings.metricsToken, '__KEEP__');
            assert.equal(services.runtime.settings.absToken, '__KEEP__');
            assert.match((await opds({root:'/observe'})).error, /маршрутом метрик/);
            const status = async (route, token) => {
                const response = await fetch(server.url+route, {headers:{Authorization:'Bearer '+token}});
                await response.body.cancel();
                return response.status;
            };
            assert.equal(await status('/observe', 'first-metrics'), 200);
            assert.equal(await status('/api/audiobookshelf', 'first-abs'), 200);
            assert.equal((await save({metricsToken:'next-metrics', absToken:'next-abs'})).error, undefined);
            assert.equal(await status('/observe', 'first-metrics'), 401);
            assert.equal(await status('/observe', 'next-metrics'), 200);
            assert.equal(await status('/api/audiobookshelf', 'first-abs'), 401);
            assert.equal(await status('/api/audiobookshelf', 'next-abs'), 200);
            const exported = (await admin.send('export-admin-settings', identity)).settings;
            assert.equal(exported.metricsToken, undefined);
            assert.equal(exported.absToken, undefined);
            assert.equal((await guest.send('get-config')).adminLaunch, undefined);

            const webSettings = await save({extendedSearch:false, bookReadLink:'https://reader.example.test/?book=${DOWNLOAD_LINK}', uiDefaults:{limit:40}});
            assert.equal(webSettings.error, undefined);
            assert.equal((await guest.send('get-config')).extendedSearch, false);
            assert.equal((await guest.send('get-config')).uiDefaults.limit, 40);
            assert.match((await save({bookReadLink:'javascript:void(0)'})).error, /bookReadLink/);
            assert.match((await save({uiDefaults:{limit:0}})).error, /uiDefaults/);

            const logFile = join(data, 'log', 'inpx-web.log');
            const logging = await save({logLevel:'info', logToFile:true});
            assert.equal(logging.runtime.logging.effectiveLevel, 'info');
            assert.equal(logging.runtime.logging.fileActive, true);
            assert.match(await fs.readFile(logFile, 'utf8'), /INFO \[inpx::settings\].*logToFile/);
            await fs.truncate(logFile, 8 * 1024 * 1024);
            const debugging = await admin.send('update-admin-runtime', {...identity, settings:{}, debugLogging:true});
            assert.equal(debugging.runtime.logging.effectiveLevel, 'debug');
            assert(debugging.runtime.logging.debugRemainingMs > 0);
            assert.equal((await fs.stat(logFile+'.1')).size, 8 * 1024 * 1024);
            const stopDebug = await admin.send('update-admin-runtime', {...identity, settings:{logLevel:'warn'}, debugLogging:false});
            assert.equal(stopDebug.runtime.logging.effectiveLevel, 'warn');
            assert.equal(stopDebug.runtime.logging.debugRemainingMs, 0);
            assert.equal((await readJson(join(data,'config.json'))).logLevel, 'warn');
            const rejectedWs = new WebSocket(server.url.replace(/^http/,'ws')+'/ws', {
                headers:{origin:server.url.replace('127.0.0.1','localhost')},
            });
            assert.match((await once(rejectedWs,'error'))[0].message, /403/);
            assert.match(await fs.readFile(logFile, 'utf8'), /WARN \[inpx::proxy\] foreign-origin/);

            const larger = {padding:'x'.repeat(1024*1024)};
            const limits = await save({wsMessageLimitMb:2,importLimitMb:4,backupUploadLimitMb:8,backupExpandedLimitMb:16});
            assert.equal(limits.runtime.settings.backupUploadLimitMb, 8);
            assert.match((await guest.send('test',larger)).error,/размер/);
            const reconnected = await connect(server.url);
            try {
                assert.equal((await reconnected.send('test',larger)).error,undefined);
                assert.equal((await save({wsMessageLimitMb:1})).error,undefined);
                assert.match((await reconnected.send('test',larger)).error,/размер/);
            } finally {reconnected.close();}

            const filter = join(data,'test-filter.json');
            await fs.writeFile(filter, '{');
            assert.match((await save({inpxFilterFile:filter})).error, /Фильтр INPX/);
            await fs.writeFile(filter, JSON.stringify({includeAuthors:['Несуществующий автор для теста']}));
            const pending = await save({inpxFilterFile:filter, lowMemoryMode:true});
            assert.equal(pending.runtime.indexOptions.pending, true);
            assert.equal(pending.runtime.indexOptions.lowMemory, false);
            assert((await search()).totalFound > 0);
            assert.equal((await admin.send('admin-reindex', identity)).started, true);
            await waitFor(() => admin.send('get-config', identity),
                config => config.adminRuntime?.indexOptions?.filter === filter
                    && config.adminRuntime.indexOptions.lowMemory && !config.adminRuntime.indexOptions.pending,
                'The new index options did not become active');
            assert.equal((await search()).totalFound, 0);
        } finally { guest.close(); admin.close(); }
    } finally { await server.stop(); }
    const lockedLog = await start(binary, [...args,'--log-level=error'], {INPX_LOG_LEVEL:'warn',INPX_WS_MESSAGE_LIMIT_MB:'3'});
    try {
        const admin = await connect(lockedLog.url);
        try {
            const identity = await signIn(admin, 'admin', password);
            const config = await admin.send('get-config', identity);
            assert.equal(config.adminRuntime.logging.effectiveLevel,'error');
            assert.equal(config.adminRuntime.locked.logLevel,'--log-level');
            assert.equal(config.adminRuntime.settings.wsMessageLimitMb,3);
            assert.match((await admin.send('update-admin-runtime',{...identity,settings:{},debugLogging:true})).error,/--log-level/);
        } finally {admin.close();}
    } finally { await lockedLog.stop(); }
    const configFile = join(data,'config.json');
    const persisted = await readJson(configFile);
    await fs.writeFile(configFile, JSON.stringify({...persisted, logLevel:'legacy-level', logDir:configFile}));
    const consoleOnly = await start(binary,args);
    try {
        const admin = await connect(consoleOnly.url);
        try {
            const identity = await signIn(admin,'admin',password);
            const {adminRuntime} = await admin.send('get-config',identity);
            assert.equal(adminRuntime.settings.logToFile,true);
            assert.equal(adminRuntime.logging.fileActive,false);
            assert.equal(adminRuntime.logging.effectiveLevel,'info');
        } finally {admin.close();}
    } finally {await consoleOnly.stop();}
    console.log('ok live guest access on the same WebSocket, environment overrides and runtime settings persistence');
}

async function verifyResourceProfiles(binary, root) {
    const probe = require('./rust-resource-profile-tests');
    const library = join(root,'library'), web = join(root,'web.json');
    await probe.library(library);
    await bundle(web);
    const {connect,signIn} = require('./rust-events-tests');
    const data = join(root,'converted');
    await fs.mkdir(data,{recursive:true});
    const configFile = join(data,'config.json');
    const args = ['--standalone','--host=127.0.0.1','--data-dir='+data,'--config='+configFile,'--lib-dir='+library,
        '--web-bundle='+web,'--admin-password='+probe.password];
    for (const [saved, overrides, expected] of [
        [2, {}, null],
        [1, {}, 1],
        [2, {INPX_CONVERSION_CONCURRENCY:'2'}, 2],
        [2, {INPX_RESOURCE_CONVERSIONS:'3',INPX_CONVERSION_CONCURRENCY:'2'}, 3],
    ]) {
        await fs.writeFile(configFile,JSON.stringify({conversionConcurrency:saved}));
        const server = await start(binary,args,overrides);
        try {
            const client = await connect(server.url);
            try {
                const identity = await signIn(client,'admin',probe.password);
                const {settings} = await client.send('get-admin-performance',identity);
                assert.equal(settings.selected,'unlimited');
                assert.equal(settings.limits.conversions,expected);
                assert.equal(settings.fileConversionLimit,saved === 1 ? 1 : null);
                if (overrides.INPX_CONVERSION_CONCURRENCY && !overrides.INPX_RESOURCE_CONVERSIONS)
                    assert.equal(settings.launchEnv.INPX_CONVERSION_CONCURRENCY, '2');
            } finally {client.close();}
        } finally {await server.stop();}
    }
    const threadStatus = async (client,identity)=>(await client.send('get-background-tasks',identity)).isbnIndex;
    for (const restart of [false,true]) {
        const server = await start(binary,args,{INPX_RESOURCE_BACKGROUND:'2'});
        try {
            const client = await connect(server.url);
            try {
                assert((await client.send('set-admin-isbn-threads',{workers:8})).error);
                const identity = await signIn(client,'admin',probe.password);
                const set = workers=>client.send('set-admin-isbn-threads',{...identity,workers});
                assert.equal((await threadStatus(client,identity)).workers,restart ? 16 : null);
                for (const workers of [4,8,32,1,null,16]) {
                    assert.equal((await set(workers)).success,true);
                    const status = await threadStatus(client,identity);
                    assert.equal(status.workers,workers);
                    assert(status.workerLimit >= 1 && status.workerLimit <= Math.min(workers ?? 8,2));
                }
                assert((await set(33)).error);
                assert.equal((await threadStatus(client,identity)).workers,16);
                assert.equal((await readJson(configFile)).isbnThreads,16);
            } finally {client.close();}
        } finally {await server.stop();}
    }
    console.log('ok migrated and explicit concurrency limits for the unlimited profile');
    if (process.platform === 'win32') return;
    for (const [profile, total, expected] of [
        ['economy',6,1],['economy',null,1],['performance',6,3],['performance',1,1],[null,null,null],['unlimited',null,null],[null,2,2],
    ]) {
        const dir = join(root,profile+'-'+total);
        await probe.fixture(dir);
        const config = join(dir,'config.json');
        if (!profile && !total) {
            const saved = JSON.parse(await fs.readFile(config,'utf8'));
            await fs.writeFile(config,JSON.stringify({...saved,conversionConcurrency:1}));
        }
        const launch = () => start(binary,['--standalone','--host=127.0.0.1','--data-dir='+dir,
            '--config='+config,'--lib-dir='+library,'--web-bundle='+web,'--admin-password='+probe.password],
        {INPX_JXL_DECODER:'djxl', ...(profile ? {INPX_RESOURCE_PROFILE:profile} : {}),
            ...(total ? {INPX_RESOURCE_TOTAL:String(total),INPX_RESOURCE_MAX_PROCESSES:'6'} : {})});
        const server = await launch();
        const hotSwitch = profile === 'economy' && total === null;
        try {
            await probe.verify(server.url, dir, {libraryDir:library, profile:profile || 'unlimited', expected,
                conversions:!profile && !total ? 1 : undefined, switchToUnlimited:hotSwitch});
        }
        finally { await server.stop(); }
        if (hotSwitch) {
            const restarted = await launch();
            try {
                const {connect,signIn} = require('./rust-events-tests');
                const client = await connect(restarted.url);
                try {
                    const auth = await signIn(client,'admin',probe.password);
                    assert.equal((await client.send('get-admin-performance',auth)).settings.selected,'unlimited');
                    assert((await client.send('set-admin-resource-profile',{...auth,profile:null})).success);
                    assert.equal((await client.send('get-admin-performance',auth)).settings.selected,'economy');
                } finally { client.close(); }
            } finally { await restarted.stop(); }
        }
    }
}

async function verifyReaderTransfer(binary, root) {
    const library = join(root,'library'), data = join(root,'data');
    await fs.mkdir(library,{recursive:true});
    const inpx = join(library,'editions.inpx'), web = join(root,'web.json'), config = join(root,'config.json');
    const rows = [
        ['Новое издание','fb2'],
        ['Электронное издание','epub'],
        ['Длинная аннотация','fb2'],
        ['Нет аннотации','fb2'],
        ['Другой формат','pdf'],
    ];
    const xml = annotation=>`<FictionBook><description><title-info><genre>sf</genre><book-title>Новое издание</book-title>${annotation}<keywords>север, зима</keywords></title-info><publish-info><year>2003</year></publish-info></description><body><section><p>Полный текст.</p></section></body></FictionBook>`;
    const epub = await zip([
        ['META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'],
        ['content.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:description>&lt;p&gt;Аннотация EPUB&lt;/p&gt;</dc:description><dc:date>2018-11-01</dc:date><dc:subject>Ветер</dc:subject></metadata></package>'],
    ]);
    await fs.writeFile(inpx,await zip([
        ['collection.info','Reader transfer'],
        ['editions.inp',rows.map(([title,ext],i)=>['Тестов,Иван:','sf:',title,'',0,i+1,100,i+1,0,ext,'2026-11-17','ru',0,''].join('\x04')).join('\n')+'\n'],
    ]));
    await fs.writeFile(join(library,'editions.zip'),await zip([
        ['1.fb2',xml('<annotation><p>Первая &amp; вторая.</p><p><![CDATA[<em>Текст</em>]]></p></annotation>')],
        ['2.epub',epub],
        ['3.fb2',require('node:zlib').gzipSync(xml('<annotation><p>'+'я'.repeat(8000)+'</p></annotation>'))],
        ['4.fb2',xml('')],['5.pdf','fixture'],
    ]));
    await bundle(web);
    await fs.writeFile(config,JSON.stringify({server:{host:'127.0.0.1',root:'/reader'},inpxCheckInterval:0,librarySources:[{id:'main',inpx}]}));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=','base64');
    const image = 'data:image/png;base64,'+png.toString('base64');
    const old = 'removed-edition.fb2', oldTime = '2026-04-01T00:00:00.000Z';
    const rc15 = process.env.INPX_RC15_SOURCE;
    const legacy = rc15 ? resolve(rc15,'server/core/ReadingListStore') : '../server/core/ReadingListStore';
    const LegacyStore = require(legacy);
    const legacyStore = new LegacyStore({dataDir:data,rootPathStatic:'/reader',adminPassword:'reader-transfer-admin'});
    await legacyStore.importData('default',{
        version:4, user:{
            readerPreferences:{fontSize:21,pageVerticalPadding:27,textShadow:true,backgroundImage:image},
            readerProgress:{[old]:{percent:0.47,sectionId:'old-section',pageIndex:9,textOffset:87,updatedAt:oldTime,textSnippet:'Текст из RC15'}},
            readerBookmarks:{[old]:[{id:'legacy-note',sectionId:'old-section',note:'Заметка из RC15',percent:0.47,createdAt:oldTime}]},
            overviewShelfNames:['Полка RC15'],
            audioProgress:{'audio:fixture':{chapter:7,time:42,rate:1.25}},
        },
        lists:[{name:'Полка RC15',visibility:'private',books:[old]}],
    });
    const legacyProgress = await legacyStore.updateReaderProgress('default',old,{baseRevision:1,generation:0,percent:0.49});
    assert.equal(legacyProgress.revision,2);
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--web-bundle='+web,'--admin-password=reader-transfer-admin'];
    let server = await start(binary,args);
    const open = async () => {
        const cookie = await browserCookie(server.url), socket = await wsClient(server.url,cookie);
        const {csrfToken} = await socket.request({action:'get-config'});
        return {cookie,socket,csrfToken,send:(action,fields={})=>socket.request({action,csrfToken,userId:'default',...fields})};
    };
    let uid, imageLink, exported;
    try {
        const {socket,send,cookie} = await open();
        try {
            const requireBook = async title=>(await send('bookSearch',{query:{title:'='+title}})).found[0]._uid;
            uid = await requireBook('Новое издание');
            const epubUid = await requireBook('Электронное издание');
            const preview = (await send('get-book-preview',{bookUid:uid})).bookPreview;
            assert.equal(preview.annotation,'Первая & вторая.\n\n<em>Текст</em>');
            assert.equal(preview.annotationStatus,'ready');
            assert.equal(preview.publishedYear,'2003');
            assert.equal(preview.keywords,'север, зима');
            assert.deepEqual(preview.genres,['sf']);
            const e = (await send('get-book-preview',{bookUid:epubUid})).bookPreview;
            assert.equal(e.annotation,'Аннотация EPUB');
            assert.equal(e.publishedYear,'2018');
            assert.equal(e.keywords,'Ветер');
            const long = (await send('get-book-preview',{bookUid:await requireBook('Длинная аннотация')})).bookPreview;
            assert.equal(long.annotationStatus,'limited');
            assert.equal(long.annotation.length,6000);
            for (const [title,status] of [['Нет аннотации','empty'],['Другой формат','unsupported']])
                assert.equal((await send('get-book-preview',{bookUid:await requireBook(title)})).bookPreview.annotationStatus,status);
            assert.equal((await send('get-book-preview',{bookUid:'missing'})).bookPreview.annotationStatus,'unavailable');
            assert.match((await send('get-book-preview',{bookUid:'a'.repeat(1025)})).error,/Invalid book UID/);

            const previous = await send('get-reader-state',{bookUid:old});
            assert.equal(previous.progress.percent,0.49);
            assert.equal(previous.progress.revision,2);
            assert.equal(previous.preferences.fontSize,21);
            assert.equal(previous.preferences.pageVerticalPadding,27);
            assert.equal(previous.preferences.pagePaddingBottom,22);
            assert.equal(previous.preferences.textShadow,false);
            assert.equal(previous.bookmarks[0].note,'Заметка из RC15');
            const search = await send('search-reader-replacement',{author:'Тестов Иван'});
            assert(search.found.some(book=>book._uid===uid),search.error);
            assert(search.found.every(book=>book.ext==='fb2'));
            const relink = {bookUid:old,replacementBookUid:uid,baseRevision:previous.progress.revision};
            assert.match((await send('relink-reader-book',{...relink,replacementBookUid:epubUid})).error,/FB2/);
            assert.match((await send('relink-reader-book',{...relink,baseRevision:99})).error,/Прогресс изменился/);
            assert.equal((await send('relink-reader-book',{...relink,csrfToken:''})).error,'bad_csrf_token');
            const moved = await send('relink-reader-book',relink);
            assert.equal(moved.bookUid,uid,moved.error);
            assert.equal(moved.progress.percent,0.49);
            assert.equal(moved.progress.sectionId,'');
            assert.equal(moved.progress.textOffset,-1);
            assert.equal((await send('get-reader-state',{bookUid:old})).progress.relinkedTo,uid);
            assert.equal((await send('get-reader-state',{bookUid:uid})).bookmarks[0].sectionId,'');
            assert.equal((await send('update-reader-progress',{bookUid:old,progress:{percent:0.9,baseRevision:0}})).progress.conflict,true);
            assert.match((await send('relink-reader-book',{...relink,bookUid:uid})).error,/Исходная книга доступна/);

            const largeImage = Buffer.concat([png,Buffer.alloc(1024*1024)]);
            const preferences = (await send('update-reader-preferences',{preferences:{
                theme:' Sepia ',fontSize:100,pagePaddingTop:5,backgroundImage:'data:image/png;base64,'+largeImage.toString('base64'),
                regularProfile:{pageOuterGap:32},einkProfile:{fontSize:24,backgroundImage:image},
            }})).preferences;
            assert.equal(preferences?.theme,'sepia');
            assert.equal(preferences.fontSize,30);
            assert.equal(preferences.pagePaddingBottom,22);
            assert.equal(preferences.regularProfile.pageOuterGap,32);
            assert.equal(preferences.regularProfile.pageOuterGapBottom,28);
            assert.equal(preferences.einkProfile.fontSize,24);
            imageLink = preferences.backgroundImage;
            assert.match(imageLink,/^\/reader\/reader-background\/default\/[a-f0-9]{64}\.png$/);
            const picture = await fetch(server.url+imageLink,{headers:{cookie}});
            assert.equal(picture.status,200);
            assert.equal(picture.headers.get('cache-control'),'private, no-store');
            assert.equal(picture.headers.get('content-type'),'image/png');
            assert.deepEqual(await bytes(picture),largeImage);
            assert.equal((await fetch(server.url+imageLink.replace('/default/','/admin/'),{headers:{cookie}})).status,403);

            const added = await send('import-reading-lists',{data:{version:2,lists:[
                {name:'Полка RC15',visibility:'opds',books:[{bookUid:old,read:true},uid]},
                {name:'ISBN',filters:{isbn:'9780306406157'},opds:{grouping:'authors'}},
            ]}});
            assert.equal(added.importedLists,1,added.error);
            assert.equal(added.importedBooks,1);
            const result = await send('export-reading-lists');
            delete result.requestId;
            exported = result;
            assert.equal(result.version,4,result.error);
            assert.deepEqual(result.user.overviewShelfNames,['Полка RC15']);
            assert.equal(result.user.audioProgress['audio:fixture'].time,42);
            assert.equal(result.user.readerPreferences.einkProfile.backgroundImage,image);
            assert.equal(result.user.readerPreferences.backgroundImage,'data:image/png;base64,'+largeImage.toString('base64'));
            assert(!Object.hasOwn(result.user,'passwordHash'));
            const shelf = result.lists.find(row=>row.name==='Полка RC15');
            assert.equal(shelf.visibility,'private');
            assert.equal(shelf.books.find(row=>row.bookUid===old).read,true);
            assert.equal(result.lists.find(row=>row.name==='ISBN').filters.isbn,'9780306406157');

            const login = await send('login-user-profile',{login:'admin',password:'reader-transfer-admin'});
            assert(login.profileAccessToken,login.error);
            const admin = (action,fields={})=>send(action,{userId:'admin',profileAccessToken:login.profileAccessToken,...fields});
            const denied = await send('export-reading-lists',{userId:'default',profileAccessToken:login.profileAccessToken});
            assert.equal(denied.error,'need_profile_login');
            const restored = await admin('import-reading-lists',{data:exported});
            assert.equal(restored.importedLists,2,restored.error);
            assert.equal(restored.importedProgress,2);
            assert.equal(restored.importedBookmarks,2);
            const repeated = await admin('import-reading-lists',{data:exported});
            assert.equal(repeated.importedLists,0,repeated.error);
            assert.equal(repeated.importedBooks,0);
            assert.equal(repeated.importedBookmarks,0);
            const roundTrip = await admin('export-reading-lists');
            assert.equal(roundTrip.user.opdsEnabled,false);
            assert.equal(roundTrip.user.readerPreferences.backgroundImage,result.user.readerPreferences.backgroundImage);
            assert.deepEqual(roundTrip.user.overviewShelfNames,result.user.overviewShelfNames);
            assert.equal(roundTrip.user.readerProgress[uid].revision,2);
            assert.equal((await fetch(server.url+imageLink,{headers:{cookie,'x-inpx-profile-token':login.profileAccessToken}})).status,403);
            const failed = await admin('import-reading-lists',{data:{lists:[{name:'Новая'},{name:''}]}});
            assert.match(failed.error,/Название списка/);
            assert.equal((await admin('export-reading-lists')).lists.length,2);
            const updated = await admin('update-reader-progress',{bookUid:uid,progress:{baseRevision:2,generation:0,percent:0.52}});
            assert.equal(updated.progress.revision,3);
            assert.equal((await admin('delete-reader-progress',{bookUid:uid})).success,true);
            const deleted = await admin('get-reader-state',{bookUid:uid});
            assert.equal(deleted.progress.percent,0);
            assert.equal(deleted.bookmarks.length,1);
            const forget = (revision, generation = 0) => admin('forget-hidden-book',{bookUid:uid,revision,generation});
            assert.equal((await forget(3)).conflict,true);
            const fresh = await admin('update-reader-progress',{bookUid:uid,progress:{percent:.33}});
            assert.equal((await forget(fresh.progress.revision)).conflict,true);
            const hidden = await admin('update-reader-progress',{bookUid:uid,progress:{hidden:true,baseRevision:fresh.progress.revision}});
            assert.equal((await forget(fresh.progress.revision)).conflict,true);
            assert.equal((await forget(hidden.progress.revision,1)).conflict,true);
            assert.equal((await admin('get-reader-state',{bookUid:uid})).bookmarks.length,1);
            await admin('add-reader-bookmark',{bookUid:old,bookmark:{title:'Другая книга',sectionId:'other'}});
            assert.equal((await forget(hidden.progress.revision)).success,true);
            const forgotten = await admin('get-reader-state',{bookUid:uid});
            assert.equal(forgotten.progress.percent,0);
            assert.deepEqual(forgotten.bookmarks,[]);
            assert.equal((await forget(hidden.progress.revision)).success,true);
            assert((await admin('get-reader-state',{bookUid:old})).bookmarks.some(mark=>mark.title==='Другая книга'));
            const clear = await admin('clear-reader-progress');
            assert.equal(clear.count,1,clear.error);
            assert.equal(clear.generation,1);
            const reset = await admin('update-reader-progress',{bookUid:old,progress:{baseRevision:0,generation:0,percent:0.75,updatedAt:oldTime}});
            assert.equal(reset.progress.reset,true);
            assert.equal(reset.progress.generation,1);
        } finally { socket.close(); }
    } finally { await server.stop(); }
    server = await start(binary,args);
    try {
        const {socket,send,cookie} = await open();
        try {
            const state = await send('get-reader-state',{bookUid:uid});
            assert.equal(state.progress.percent,0.49);
            assert.equal(state.progress.revision,1);
            assert.equal(state.preferences.backgroundImage,imageLink);
            assert.equal((await fetch(server.url+imageLink,{headers:{cookie}})).status,200);
            const legacyExport = await legacyStore.exportData('default');
            assert.deepEqual(legacyExport.user.overviewShelfNames,exported.user.overviewShelfNames);
            assert.equal(legacyExport.user.readerPreferences.backgroundImage,exported.user.readerPreferences.backgroundImage);
            assert.equal(legacyExport.user.readerProgress[uid].percent,0.49);
        } finally { socket.close(); }
    } finally { await server.stop(); }
    console.log('ok Rust bounded FB2/EPUB previews, reader settings and backgrounds, relink, generation reset and reading-list round trip'+(rc15?' with Node RC15':''));
}

async function verifyOverview(binary, root) {
    const data = join(root,'data'), library = join(root,'library'), web = join(root,'web.json');
    const config = join(root,'config.json');
    const archive = join(library,'smoke.inpx');
    await createFixture(library);
    const date = new Date().toISOString().slice(0,10);
    const rows = [
        ['Tester,Smoke:', 'sf:', 'Read first', 'Overview series', '1'],
        ['Tester,Smoke:', 'sf:', 'Unread second', 'Overview series', '2'],
        ['Unrelated,Author:', 'prose:', 'Book to hide', '', '0'],
    ].map((row,i)=>[...row,String(i+1),'100',String(i+1),'0','fb2',date,'en','4',''].join('\x04'));
    await fs.writeFile(archive,await zip([['collection.info','Overview\n'],['smoke.inp',rows.join('\n')+'\n']]));
    await bundle(web);
    await fs.writeFile(config,JSON.stringify({server:{host:'127.0.0.1',root:'/reader'}}));
    let hits = 0, unavailable = false, unblock, requested;
    const feed = createServer(async(req,res)=>{
        hits++;
        if (req.url === '/redirect') {
            res.writeHead(302,{Location:'http://localhost:'+feed.address().port+'/feed'}).end();
            return;
        }
        if (req.url === '/slow') {
            requested?.();
            await new Promise(resolve=>{unblock = resolve;});
        }
        if (unavailable) {
            res.writeHead(503).end();
            return;
        }
        const layouts = {
            '/next':'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{initialState:{
                rtkqApi:{queries:{catalog:{data:{items:[
                    {title:'Фантастика',url:'/genre/sf'},
                    {title:'Unread second',url:'/book/second',authors:[{name:'Tester Smoke'}],rating:{rated_avg:4.8}},
                ]}}}},
            }}}})+'</script>',
            '/litres':'<a href="/book/second"><img src="/cover.png"></a><a href="/book/second">Unread second</a><a href="/author/tester">Tester Smoke</a>',
            '/mif':'<div class="lego-book"><a href="/catalog/product/second"><img src="/cover.png"></a><div class="lego-book__cover-loading-title"><p>Unread second</p><p>Tester Smoke</p></div></div>',
            '/alpina':'<div data-book-name="Unread second"><a href="/catalog/book-second/"><img src="/cover.png"></a><div class="book-item-authors"><span itemprop="name">Tester Smoke</span></div></div>',
        };
        if (layouts[req.url]) {
            res.end(layouts[req.url]);
            return;
        }
        res.end('<script type="application/ld+json">'+JSON.stringify([
            {'@type':'Book',name:'Unread second',url:'/book/second',author:{name:'Tester Smoke'}},
            {'@type':'Product',name:'Missing book',url:'/book/missing'},
        ])+'</script>');
    });
    feed.listen(0,'127.0.0.1');
    await once(feed,'listening');
    const source = 'http://127.0.0.1:'+feed.address().port;
    const args = ['--standalone','--data-dir='+data,'--config='+config,'--lib-dir='+library,'--inpx='+archive,'--web-bundle='+web,'--admin-password=fixture-admin'];
    let ws;
    const session = async(server)=>{
        ws = await wsClient(server.url,await browserCookie(server.url));
        const {csrfToken} = await ws.request({action:'get-config'});
        const {profileAccessToken} = await ws.request({action:'login-user-profile',login:'admin',password:'fixture-admin',csrfToken});
        assert(profileAccessToken);
        return (action,options={})=>ws.request({action,...options,userId:'admin',profileAccessToken,csrfToken});
    };
    let server;
    try {
        server = await start(binary,args);
        let send = await session(server);
        const {found} = await send('bookSearch',{query:{del:'0'}});
        const uid = title=>found.find(row=>row.title===title)._uid;
        const first = uid('Read first'), second = uid('Unread second'), hidden = uid('Book to hide');
        await send('update-reader-progress',{bookUid:first,progress:{percent:0.6}});
        assert.equal((await ws.request({action:'update-discovery-preferences'})).error,'bad_csrf_token');
        const prefs = await send('update-discovery-preferences',{preferences:{
            taste:{authors:[' Tester   Smoke '],explorationRatio:.25},
            feedbackSet:[{bookUid:hidden,kind:'not_interested',shelfId:'Similar Books'}],
        }});
        assert.deepEqual(prefs.preferences?.hiddenBooks,[hidden],prefs.error);
        assert.deepEqual(prefs.preferences.taste.authors,['Tester Smoke']);
        assert.equal(prefs.preferences.metrics.shelves['similar-books'].feedback,1);
        const event = {bookUid:second,type:'impression',shelfId:'similar-books'};
        assert.equal((await send('record-discovery-events',{events:[event,event]})).recorded,1);
        const featured = await send('get-discovery-shelves',{recommendationsOnly:true});
        assert.deepEqual(featured.shelves?.map(shelf=>[shelf.id,shelf.items.map(book=>book._uid)]),
            [['similar-books',[second]]],featured.error);
        assert.deepEqual((await send('get-discovery-shelves',{recommendationsOnly:true})).shelves,featured.shelves);
        for (let i=0;i<2;i++) assert.equal((await send('record-discovery-events',{events:[event]})).recorded,1);
        assert.deepEqual((await send('get-discovery-shelves',{recommendationsOnly:true})).shelves,[]);
        const overview = await send('get-discovery-shelves',{includeExternal:false,personalSimilarEnabled:false});
        assert.equal(overview.shelves?.find(shelf=>shelf.id==='continue-reading')?.items[0]._uid,first,overview.error);
        assert.equal(overview.shelves?.find(shelf=>shelf.id==='unfinished-series')?.items[0]._uid,second,overview.error);
        assert.equal(overview.shelves?.find(shelf=>shelf.id==='hidden-books')?.items[0]._uid,hidden,overview.error);
        const shared = await send('update-shared-discovery-config',{discovery:{
            externalSource:'web-page',externalName:'Test publisher',externalUrl:source+'/feed',
        }});
        assert.equal(shared.discovery?.externalSource,'web-page',shared.error);
        assert.equal((await send('get-config')).discovery.externalUrl,source+'/feed');
        const external = await send('get-discovery-shelves',{externalOnly:true});
        const shelf = external.shelves?.[0];
        assert.deepEqual(shelf?.items.map(book=>[book.title,book.discoveryMatchType]),
            [['Unread second','exact'],['Missing book','missing-local']],shelf?.emptyMessage || external.error);
        assert.equal(hits,1);
        const redirect = await send('get-discovery-shelves',{externalOnly:true,externalBrowseUrl:'/redirect'});
        assert.equal(redirect.shelves?.[0]?.id,'external-error',redirect.error);
        assert.equal(hits,2,'A different origin is never fetched');
        const received = new Promise(resolve=>{requested=resolve;});
        const slow = send('get-discovery-shelves',{externalOnly:true,externalBrowseUrl:'/slow'});
        await Promise.race([received,sleep(3000).then(()=>{throw new Error('External feed request did not start');})]);
        try {
            const fast = await Promise.race([send('bookSearch',{query:{title:'=Unread second'}}),sleep(2000).then(()=>({error:'blocked'}))]);
            assert.equal(fast.found?.[0]._uid,second,fast.error);
        } finally {unblock();}
        assert.equal((await slow).shelves?.[0]?.id,'external-source');
        ws.close();
        await server.stop();
        server = await start(binary,args);
        send = await session(server);
        const saved = await send('update-discovery-preferences',{preferences:{}});
        assert.equal(saved.preferences.events[second].impressionCount,3);
        assert.deepEqual(saved.preferences.hiddenBooks,[hidden]);
        unavailable = true;
        assert.equal((await send('get-discovery-shelves',{externalOnly:true})).shelves?.[0]?.discoveryStale,false);
        assert.equal(hits,3,'Restart reuses persisted feed');
        const stale = await send('get-discovery-shelves',{externalOnly:true,forceRefresh:true});
        assert.equal(stale.shelves?.[0]?.discoveryStale,true,stale.error);
        assert.equal(stale.shelves[0].items[0]._uid,second);
        unavailable = false;
        for (const path of ['/next','/litres','/mif','/alpina']) {
            const page = await send('get-discovery-shelves',{externalOnly:true,externalBrowseUrl:path});
            const shelf = page.shelves?.[0];
            assert.equal(shelf?.items[0]?._uid,second,shelf?.emptyMessage || page.error || path);
            if (path === '/next') assert.deepEqual(shelf.genreOptions,[{label:'Фантастика',value:source+'/genre/sf'}]);
        }
        console.log('ok Rust Overview recommendations, feedback, event history, isolated and persisted external discovery');
    } finally {
        ws?.close();
        unblock?.();
        if (server) await server.stop();
        await new Promise(resolve=>feed.close(resolve));
    }
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
    const markerFile = join(data,'.upgrade-version.json');
    await fs.writeFile(markerFile,JSON.stringify({version:require('../package.json').version,runtime:'nodejs',snapshot:null}));
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

    const previous = join(data,'db.previous'), pending = join(data,'.db-migration-ready');
    // Block the first publication after a complete index has been staged.
    await fs.writeFile(previous,'publication obstacle');
    await assert.rejects(launch(),error=>/Индекс \[checkpoint/.test(error.stderr));
    const staged = await readJson(join(pending,'catalogue.json'));
    await fs.unlink(previous);

    // The file is moved with the staged directory, so the failure occurs when
    // opening the new db at its final path. The old directory remains available.
    await fs.rename(db,previous);
    const lock = join(pending,'__lock');
    await fs.writeFile(lock,'test lock');
    await assert.rejects(launch(),error=>/Database locked: .*db/.test(error.stderr)
        && /Индекс \[resume/.test(error.stderr) && !/Индекс \[load inpx/.test(error.stderr));
    assert.equal((await readJson(header)).rustBookStoreGeneration,staged.rustBookStoreGeneration);
    assert((await fs.stat(join(previous,'book'))).isDirectory());
    await assert.rejects(launch(),error=>/Database locked: .*db/.test(error.stderr)
        && /Индекс \[resume/.test(error.stderr) && !/Индекс \[load inpx/.test(error.stderr));
    await fs.unlink(join(db,'__lock'));
    const first = await start(binary,args);
    let generation, migrationMarker;
    try {
        const metadata = await readJson(header);
        generation = metadata.rustBookStoreGeneration;
        assert.equal(generation,staged.rustBookStoreGeneration);
        await assert.rejects(fs.stat(pending),{code:'ENOENT'});
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
        migrationMarker = await readJson(markerFile);
        assert.equal(migrationMarker.runtime,'rust');
        const backup = await readJson(join(migrationMarker.snapshot,'reading-lists.json'));
        assert.equal(backup.users.find(row=>row.id==='default').readerProgress[uid].percent,0.42);
    } finally { await first.stop(); }

    const restarted = await start(binary,args);
    try {
        assert.equal((await readJson(header)).rustBookStoreGeneration,generation);
        assert.deepEqual(await readJson(markerFile),migrationMarker);
    }
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
    console.log('ok standalone JembaDB upgrade reuses a complete index after a lock and preserves IDs, shelves, bookmarks and progress');
}

(async()=>{
    const binary = resolve(process.argv[2]);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-standalone-'));
    try {
        await verifyStandaloneIpv6(binary,join(root,'ipv6'));
        await verify(binary,root);
        await verifyCatalogue(binary,join(root,'opds'));
        await verifyEpubReader(binary,join(root,'epub-reader'));
        await verifyLibraryPassword(binary,join(root,'library-password'));
        await verifyServiceRoutes(binary,join(root,'services'));
        await verifyIndexRefresh(binary,join(root,'reindex'));
        await verifyTwoLibraries(binary,join(root,'two-libraries'));
        await verifyOverview(binary,join(root,'overview'));
        await verifyLibraryMedia(binary,join(root,'library-media'));
        await verifyReaderTransfer(binary,join(root,'reader-transfer'));
        await verifyProfileCommands(binary,join(root,'profile-commands'));
        await verifySeriesZip(binary,join(root,'series-zip'));
        await verifyCacheSettings(binary,join(root,'cache-settings'));
        await verifyTelegramApi(binary,join(root,'telegram-api'));
        await verifyRuntimeSettings(binary,join(root,'runtime-settings'));
        await verifyResourceProfiles(binary,join(root,'resource-profiles'));
        await verifyMobileEvents(binary,join(root,'mobile-events'));
        await verifyJembaUpgrade(binary,join(root,'jemba-upgrade'));
    }
    finally { await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
