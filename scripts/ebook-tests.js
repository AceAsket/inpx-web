const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const express=require('express');
const {EbookController,parameters}=require('../server/controllers/EbookController');
const Security=require('../server/core/Security');
const {EbookReader,readText,pages,limits}=require('../server/core/EbookReader');

async function fixture(options,work) {
    const config={name:'INPX test',rootPathStatic:'/library',allowAnonymousAccess:true,accessPassword:'',onlineReaderEnabled:true,
        conversionEnabled:false,uiDefaults:{langDefault:'ru'},librarySources:[{id:'one',name:'Коллекция',enabled:true}],...options};
    const security=new Security(config);security.secret='ebook-test-secret';
    const sessions=new Map(),calls=[];
    const book={_uid:'known',title:'Книга <script>alert(1)</script>',author:'Первый Автор,Второй Автор',series:'Тестовый цикл',size:100,ext:'fb2',lang:'ru'};
    const user={id:'reader',name:'Читатель',login:'reader',readerProgress:{known:{percent:.5}}};
    const worker={config,db:{},libraryAssetGeneration:1,checkMyState(){},checkLibraryAssetState(generation,db){if(db!==this.db||generation!==this.libraryAssetGeneration)throw new Error('Library changed');},
        getProfileSessionUser:token=>sessions.get(token)||'',closeProfileSession:token=>sessions.delete(token),readingListStore:{load:async()=>({users:[user]})},
        loginUserProfile:async(login,password)=>{if(login!=='reader'||password!==' pass ')throw new Error('Неверный логин или пароль');sessions.set('profile-token','reader');return {userId:'reader',profileAccessToken:'profile-token'};},
        bookSearch:async query=>{calls.push(query);return {totalFound:23,found:[book]};},getBookRecordByUid:async uid=>uid==='known'?book:null,
        getBookPreview:async uid=>{calls.push('preview');return {bookPreview:{bookUid:uid,annotation:'Описание <img src=x onerror=alert(1)>',annotationStatus:'ready',annotationLimited:false}};},
        buildUserReadingSummary:async()=>{calls.push('history');return {items:[{...book,bookUid:'known',percent:.5}]};}};
    const access={freeAccess:!config.accessPassword,newToken:()=>{access.expected=require('../server/core/utils').getBufHash(config.accessPassword+'salt','sha256','hex');return 'salt';},hasAccess:async token=>!!access.expected&&token===access.expected};
    const app=express();app.use(security.middleware());const controller=new EbookController(config,worker,security,access).register(app);
    const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
    let cookie='';
    const request=async(url='/library/ebook',body=null)=>{
        const response=await fetch(`http://127.0.0.1:${server.address().port}`+url,{method:body?'POST':'GET',redirect:'manual',
            headers:{accept:'text/html',...(cookie?{cookie}:{}),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined});
        if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
        return {response,text:await response.text()};
    };
    try{await work({controller,worker,security,access,sessions,calls,book,user,request,csrf:text=>text.match(/name="csrf" value="([^"]+)"/)[1]});}
    finally{await new Promise(resolve=>server.close(resolve));}
}

async function testEbookHtmlWorksWithoutSpaAndSearchIsBoundedExplicitAndEscaped(){
    await fixture({},async({request,calls})=>{
        let result=await request();assert.equal(result.response.status,200);assert.equal(calls.length,0,'The start page must not scan a large library');
        assert(!/<script|\.js["?]|woff|websocket|animation:/i.test(result.text));assert.match(result.response.headers.get('content-security-policy'),/script-src 'none'/);
        assert.equal(result.response.headers.get('cache-control'),'private, no-store');assert(!result.text.includes('<img'));
        result=await request('/library/ebook?q=typed&field=author&options=1');assert.equal(calls.length,0);assert.match(result.text,/Параметры поиска/);assert.match(result.text,/value="typed"/);assert.match(result.text,/name="lang"/);
        result=await request('/library/ebook?q=%3Cscript%3E&field=title&lang=ru&sourceId=one&page=2&size=10');
        assert.equal(result.response.status,200);assert.equal(calls[0].title,'<script>');assert.equal(calls[0].offset,10);assert.equal(calls[0].limit,10);assert.equal(calls[0].sourceId,'one');
        assert(!result.text.includes('<script>'));assert.match(result.text,/&lt;script&gt;/);assert.match(result.text,/Страница 2 из 3/);assert.match(result.text,/sourceId=one/);
        await request('/library/ebook?q=~a%2B%2B&field=author');assert.equal(calls[1].author,'*~a++','The simple UI never enables arbitrary regular expressions');
    });
}
async function testEbookInputAndPaginationRejectAmbiguousAndOversizedRequests(){
    for(const query of [{q:['one','two']},{page:'0'},{page:'-1'},{size:'999'},{field:'sql'},{mode:'regexp'},{q:'x'.repeat(161)},{lang:'<img>'}])assert.throws(()=>parameters(query,{}));
    await fixture({},async({request,calls})=>{
        for(const query of ['?page=0','?q=a&q=b','?field=unknown','?q='+ 'a'.repeat(161)])assert.equal((await request('/library/ebook'+query)).response.status,400);
        assert.equal(calls.length,0);assert.equal((await request('/library/ebook/missing')).response.status,404);
    });
}
async function testEbookBookCardDefersMetadataAndReusesDownloadAndReadPaths(){
    await fixture({},async({request,calls})=>{
        let result=await request('/library/ebook/book?uid=known&lang=ru&sourceId=one');
        assert.equal(result.response.status,200);assert(!calls.includes('preview'));assert.match(result.text,/action="\/library\/book\/by-uid"/);
        assert.match(result.text,/Читать текст/);assert.match(result.text,/Показать аннотацию/);assert.match(result.text,/field=author/);assert.match(result.text,/sourceId=one/);
        result=await request('/library/ebook/book?uid=known&annotation=1');assert(calls.includes('preview'));assert.match(result.text,/&lt;img src=x onerror=alert\(1\)&gt;/);assert(!result.text.includes('<img src=x'));
        assert.equal((await request('/library/ebook/book?uid=missing')).response.status,404);
    });
}
async function testEbookProfileLoginCsrfPasswordAndRevokedSessionStayProtected(){
    await fixture({allowAnonymousAccess:false},async({request,csrf,calls,sessions})=>{
        const first=await request('/library/ebook/book?uid=known');assert.equal(first.response.status,401);const token=csrf(first.text);assert.equal(calls.length,0);
        assert.equal((await request('/library/ebook/login',{login:'reader',password:' pass '})).response.status,403);
        const wrong=await request('/library/ebook/login',{csrf:token,login:'reader',password:'bad'});assert.equal(wrong.response.status,401);assert.match(wrong.text,/Неверный логин/);
        const signed=await request('/library/ebook/login',{csrf:token,login:'reader',password:' pass ',next:'/library/ebook/book?uid=known'});
        assert.equal(signed.response.status,303);assert.equal(signed.response.headers.get('location'),'/library/ebook/book?uid=known');assert(!signed.text.includes('profile-token'));
        assert.equal((await request('/library/ebook/recent')).response.status,200);assert(calls.includes('history'));
        sessions.clear();assert.equal((await request('/library/ebook/recent?user=reader')).response.status,401);
    });
}
async function testEbookLibraryPasswordLogoutAndSafeReturnPaths(){
    await fixture({accessPassword:'library password'},async({request,csrf,access,sessions,controller})=>{
        const first=await request();assert.equal(first.response.status,401);assert.match(first.text,/Пароль библиотеки/);const token=csrf(first.text);
        assert.equal((await request('/library/ebook/access',{csrf:token,password:'wrong'})).response.status,401);
        const signed=await request('/library/ebook/access',{csrf:token,password:'library password',next:'https://evil.invalid/'});
        assert.equal(signed.response.status,303);assert.equal(signed.response.headers.get('location'),'/library/ebook');assert.equal((await request()).response.status,200);
        for(const target of ['//evil.invalid','/library/ebook-other','/library/ebook\\evil','/other','/library/ebook\r\nLocation:evil'])assert.equal(controller.destination(target),'/library/ebook');
        access.expected='expired';sessions.set('profile-token','reader');
        const result=await request('/library/ebook/logout',{csrf:token});assert.equal(result.response.status,303,'Logout remains possible after library access expires');
        assert.equal((await request('/library/ebook/recent')).response.status,401);
    });
}
async function testEbookLatePrivateResponseIsRejectedAfterProfileLogout(){
    await fixture({},async({request,csrf,worker})=>{
        let result=await request('/library/ebook/login');const token=csrf(result.text);
        await request('/library/ebook/login',{csrf:token,login:'reader',password:' pass '});
        let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
        worker.buildUserReadingSummary=()=>new Promise(resolve=>{release=resolve;entered();});
        const pending=request('/library/ebook/recent');await ready;
        await request('/library/ebook/logout',{csrf:token});release({items:[{bookUid:'known',title:'PRIVATE HISTORY',percent:.5}]});
        result=await pending;assert.equal(result.response.status,401);assert(!result.text.includes('PRIVATE HISTORY'));assert(!result.text.includes('Читатель'));
    });
}
async function testEbookPlainReaderStreamsBodyAndKeepsUnicodePages(){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-ebook-text-'));
    try{
        const file=path.join(dir,'book.fb2'),body='<FictionBook><description><title-info><annotation><p>Not body</p></annotation></title-info></description><body><section><title><p>Глава</p></title><p>Текст &amp; книга 🤔</p><p>Вторая строка.</p></section></body><binary>'+'A'.repeat(500000)+'</binary></FictionBook>';
        await fs.writeFile(file,body);const text=await readText(file,new AbortController().signal);
        assert.match(text,/Глава/);assert.match(text,/Текст & книга 🤔/);assert(!text.includes('Not body'));assert(!text.includes('AAAA'));
        const original='Первая строка 🤔\n\nВторая строка. '.repeat(20),split=pages(original,19);assert.equal(split.join(''),original);assert(split.every(page=>!/[\ud800-\udbff]$/.test(page)));assert.throws(()=>pages('abc',1));
        const encoded=require('iconv-lite').encode('<?xml version="1.0" encoding="windows-1251"?><FictionBook><body><p>Русский текст</p></body></FictionBook>','windows-1251');
        await fs.writeFile(file,encoded);assert.match(await readText(file,new AbortController().signal),/Русский текст/);
        await fs.writeFile(file,'<?xml version="1.0" encoding="windows-1251"?><FictionBook><!--'+'ASCII '.repeat(500)+'--><body><p>На самом деле UTF-8</p></body></FictionBook>');
        assert.match(await readText(file,new AbortController().signal),/На самом деле UTF-8/);
        await fs.writeFile(file,require('zlib').gzipSync(Buffer.from(body)));assert.match(await readText(file,new AbortController().signal),/Текст & книга/);
        await fs.writeFile(file,'<FictionBook><body><p>'+'A'.repeat(limits.characters+1)+'</p></body></FictionBook>');
        await assert.rejects(readText(file,new AbortController().signal),{status:413});
    }finally{await fs.remove(dir);}
}
async function testEbookReaderCacheGenerationAndTemporaryFilesAreBounded(){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-ebook-reader-'));let reader;
    try{
        const book={_uid:'known',ext:'fb2',folder:'folder',file:'1',_recordHash:'v1'},files=[];let calls=0;
        const worker={config:{onlineReaderEnabled:true},db:{},libraryAssetGeneration:1,checkLibraryAssetState(generation,db){if(generation!==this.libraryAssetGeneration||db!==this.db)throw Object.assign(new Error('Changed'),{code:'INPX_LIBRARY_CHANGED'});},
            getBookRecordByUid:async()=>book,extractBook:async(folder,file,source,options)=>{assert.equal(options.maxOutputBytes,limits.fileBytes);const result=path.join(dir,String(++calls));files.push(result);await fs.writeFile(result,'<FictionBook><body><p>Reader text.</p></body></FictionBook>');return result;}};
        reader=new EbookReader(worker);const [one,two]=await Promise.all([reader.read('known'),reader.read('known')]);assert.deepEqual(one.pages,two.pages);assert.equal(calls,1);
        await reader.read('known');assert.equal(calls,1);assert(reader.cache.bytes<=limits.cacheBytes);assert(files.every(file=>!fs.existsSync(file)));
        worker.libraryAssetGeneration++;await reader.read('known');assert.equal(calls,2);
        worker.config.onlineReaderEnabled=false;await assert.rejects(reader.read('known'),{status:415});
        worker.config.onlineReaderEnabled=true;worker.libraryAssetGeneration++;
        let entered;const ready=new Promise(resolve=>{entered=resolve;});
        worker.extractBook=async(folder,file,source,options)=>new Promise((resolve,reject)=>{
            options.signal.addEventListener('abort',()=>reject(new Error('Extraction aborted')),{once:true});entered();
        });
        const interrupted=assert.rejects(reader.read('known'),{status:503});await ready;await reader.close();await interrupted;
        assert.equal(reader.pending.size,0);assert.equal(reader.cache.size,0);assert.equal(reader.cache.bytes,0);
    }finally{await reader?.close();await fs.remove(dir);}
}

module.exports=[testEbookHtmlWorksWithoutSpaAndSearchIsBoundedExplicitAndEscaped,testEbookInputAndPaginationRejectAmbiguousAndOversizedRequests,
    testEbookBookCardDefersMetadataAndReusesDownloadAndReadPaths,testEbookProfileLoginCsrfPasswordAndRevokedSessionStayProtected,
    testEbookLibraryPasswordLogoutAndSafeReturnPaths,testEbookLatePrivateResponseIsRejectedAfterProfileLogout,
    testEbookPlainReaderStreamsBodyAndKeepsUnicodePages,testEbookReaderCacheGenerationAndTemporaryFilesAreBounded];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})().catch(error=>{console.error(error);process.exitCode=1;});
