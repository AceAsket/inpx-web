// Real HTTP forms and documents with JavaScript disabled. No WebSocket mocks.
const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const {pipeline}=require('stream/promises');
const yazl=require('yazl');
const {unusedPort}=require('./binary-smoke-test');
const {chromium}=require(process.env.INPX_PLAYWRIGHT_MODULE||'playwright');
const WebSocket=require('ws');
const he=require('he');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(dir){
    await fs.ensureDir(dir);const books=new yazl.ZipFile(),inpx=new yazl.ZipFile();
    const bookDone=pipeline(books.outputStream,fs.createWriteStream(path.join(dir,'books.zip'))),indexDone=pipeline(inpx.outputStream,fs.createWriteStream(path.join(dir,'ebook.inpx')));
    let rows='';
    for(let i=0;i<25;i++){
        const title='Книга для электронной книги '+String(i).padStart(2,'0');
        const xml='<?xml version="1.0" encoding="UTF-8"?><FictionBook><description><title-info><book-title>'+title+'</book-title><annotation><p>Аннотация для электронной книги.</p><p>&lt;img src=x onerror=alert(1)&gt;</p></annotation></title-info></description><body><section><title><p>Первая глава</p></title>'+Array.from({length:65},(_,n)=>'<p>Абзац '+n+'. '+'Текст для спокойного чтения на электронной книге. '.repeat(5)+'</p>').join('')+'</section></body></FictionBook>';
        books.addBuffer(Buffer.from(xml),(i+1)+'.fb2');
        rows+=['Тестовый,Автор:','sf:',title,'Цикл устройства','1',String(i+1),String(Buffer.byteLength(xml)),String(i+1),'0','fb2','2026-11-07','ru','0',''].join('\x04')+'\n';
    }
    books.end();inpx.addBuffer(Buffer.from('Ebook fixture\n'),'collection.info');inpx.addBuffer(Buffer.from('20261107'),'version.info');inpx.addBuffer(Buffer.from(rows),'books.inp');inpx.end();await Promise.all([bookDone,indexDone]);
    await fs.writeJson(path.join(dir,'config.json'),{loggingEnabled:false,logQueries:false,server:{root:'/library'},allowAnonymousAccess:false,
        adminPassword:'ebook-browser-fixture',onlineReaderEnabled:true,conversionEnabled:false,uiDefaults:{langDefault:'ru'},opds:{enabled:true,root:'/library/opds'}});
}

// The Node fixture simulates progress saved by the full reader. The device page
// still has JavaScript disabled and never opens a WebSocket.
async function checkOpds(base,context,uid,title){
    const cookie=(await context.cookies(base+'/library/ebook')).map(item=>item.name+'='+item.value).join('; ');
    const socket=new WebSocket(base.replace('http','ws')+'/library/ws',{headers:{cookie,origin:base}});
    let sequence=0,csrfToken='';
    try{
        await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
        const call=payload=>new Promise((resolve,reject)=>{
            const requestId='ebook-opds-'+(++sequence),timer=setTimeout(()=>{socket.off('message',receive);reject(new Error('OPDS fixture API timed out'));},10000);
            function receive(raw){const result=JSON.parse(raw);if(result.requestId!==requestId||result._rok)return;clearTimeout(timer);socket.off('message',receive);result.error?reject(new Error(result.error)):resolve(result);}
            socket.on('message',receive);socket.send(JSON.stringify({...payload,requestId,csrfToken}));
        });
        const config=await call({action:'get-config'});csrfToken=config.csrfToken;assert.equal(config.currentUserId,'admin');
        const feedUrl=base+config.opdsRoot+'/title?'+new URLSearchParams({title:'='+title});
        for(const [percent,mark]of [[.1,'◔'],[.4,'◑'],[.8,'◕'],[1,'⬤']]){
            await call({action:'update-reader-progress',bookUid:uid,progress:{percent}});
            const response=await fetch(feedUrl,{headers:{cookie}}),xml=await response.text();assert.equal(response.status,200,xml);
            assert.equal(response.headers.get('cache-control'),'private, no-store');assert(xml.includes(mark+' '),xml);assert(xml.includes(uid.replace(/&/g,'&amp;')));
            const bookLink=he.decode(xml.match(/href="([^\"]*\/book\?[^\"]+)"/)[1]);assert.equal(new URL(base+bookLink).searchParams.get('user'),'admin');
            const detail=await(await fetch(base+bookLink,{headers:{cookie}})).text();assert(detail.includes(mark+' '),detail);
            if(percent===.4)await pageRecent(context,base,title);
        }
        assert.equal((await fetch(feedUrl)).status,401,'Unsigned requests cannot see the private progress');
        assert.equal((await fetch(feedUrl+'&user=foreign',{headers:{cookie}})).status,401,'A scoped request cannot change the signed-in profile');
    }finally{socket.terminate();}
}
async function pageRecent(context,base,title){
    const response=await context.request.get(base+'/library/ebook/recent');assert.equal(response.status(),200);
    const text=await response.text();assert(text.includes(he.escape(title))||text.includes(title));assert(text.includes('40%'));
}

(async()=>{
    const directory=process.env.INPX_ARTIFACT_DIR||await fs.mkdtemp(path.join(os.tmpdir(),'inpx-ebook-browser-'));await fs.ensureDir(directory);
    let child,browser,page,output='';
    try{
        const lib=path.join(directory,'library'),data=path.join(directory,'data');await fixture(lib);
        await fs.copy(path.resolve('dist/tmp/public'),path.join(data,'public'));
        const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
        child=spawn(process.execPath,[path.resolve('server'),`--data-dir=${data}`,`--config=${lib}/config.json`,`--lib-dir=${lib}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_TTS_ENABLED:'false',INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',
                INPX_AUTH_MODE:'local',INPX_REQUIRE_AUTH:'false',INPX_ALLOW_ANONYMOUS_ACCESS:'false',INPX_ADMIN_PASSWORD:'ebook-browser-fixture'}});
        for(const stream of[child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-10000);});
        let ready=false;
        for(let i=0;i<120;i++){try{const response=await fetch(base+'/ready');ready=response.ok&&(await response.json()).ready;}catch{}if(ready||child.exitCode!==null)break;await pause(500);}
        assert(ready,output);
        browser=await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH||undefined});
        const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:600,height:900}});page=await context.newPage();
        const resources=[],errors=[];let sockets=0;
        page.on('request',request=>resources.push({type:request.resourceType(),url:request.url()}));page.on('websocket',()=>sockets++);page.on('pageerror',error=>errors.push(error.message));
        const response=await page.goto(base+'/library/ebook');assert.equal(response.status(),401);
        await page.getByRole('textbox',{name:'Логин',exact:true}).fill('admin');await page.getByLabel('Пароль',{exact:true}).fill('ebook-browser-fixture');
        await page.getByRole('button',{name:'Войти',exact:true}).click();
        await page.getByRole('heading',{name:'Поиск книг',exact:true}).waitFor();
        const search=page.getByRole('textbox',{name:'Название, автор или серия',exact:true});await search.fill('электронной');
        await page.getByRole('button',{name:'Параметры поиска',exact:true}).click();
        assert.equal(await search.inputValue(),'электронной');await page.getByLabel('Книг на странице',{exact:true}).selectOption('10');
        await page.getByRole('button',{name:'Применить параметры',exact:true}).click();await page.getByRole('heading',{name:'Найдено: 25',exact:true}).waitFor();
        await search.fill('электронной');
        await page.getByRole('button',{name:'Найти',exact:true}).click();await page.getByRole('heading',{name:'Найдено: 25',exact:true}).waitFor();
        assert.equal(await page.locator('.result').count(),10);await page.locator('.pagination').first().getByRole('link',{name:'Следующая',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('page'),'2');assert.equal(new URL(page.url()).searchParams.get('lang'),'ru');
        const title=await page.locator('.result h3 a').first().textContent();
        await page.locator('.result h3 a').first().click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
        const download=page.getByRole('button',{name:'Скачать книгу',exact:true});assert(await download.isVisible());
        assert.equal(await page.getByRole('heading',{name:'Аннотация',exact:true}).count(),0,'Metadata is opt-in on low-power devices');
        await page.getByRole('link',{name:'Показать аннотацию',exact:true}).click();await page.getByRole('heading',{name:'Аннотация',exact:true}).waitFor();
        await page.getByText('Аннотация для электронной книги.',{exact:false}).waitFor();assert.equal(await page.locator('img[src=x]').count(),0);
        const uid=new URL(page.url()).searchParams.get('uid');
        const cardGeometry=[];
        for(const width of[600,320]){
            await page.setViewportSize({width,height:900});
            // evaluate is used only by the test to measure layout; page scripts remain disabled.
            const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,scriptCount:document.scripts.length}));
            assert(geometry.scroll<=width+1,JSON.stringify(geometry));assert.equal(geometry.scriptCount,0);cardGeometry.push(geometry);
            await page.screenshot({path:path.join(directory,'ebook-card-'+width+'.png'),fullPage:true});
        }
        await page.getByRole('link',{name:'Читать текст',exact:true}).click();await page.locator('.reading').waitFor();
        const firstText=await page.locator('.reading').textContent();assert(firstText.includes('Первая глава'));
        assert(Buffer.byteLength(firstText)<10000,'A reader document sends one small page');
        await page.locator('.pagination').first().getByRole('link',{name:'Следующая',exact:true}).click();
        assert.notEqual(await page.locator('.reading').textContent(),firstText);assert.equal(new URL(page.url()).searchParams.get('page'),'2');
        await page.getByRole('navigation',{name:'Размер текста'}).getByRole('link',{name:'Крупнее',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('font'),'26');assert.equal(new URL(page.url()).searchParams.get('page'),'2');
        await page.screenshot({path:path.join(directory,'ebook-read-320.png'),fullPage:true});
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.getByRole('link',{name:'О книге',exact:true}).click();
        const pendingDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать книгу',exact:true}).click();
        const downloaded=await pendingDownload;const saved=await downloaded.path();assert((await fs.readFile(saved,'utf8')).includes('FictionBook'));
        await checkOpds(base,context,uid,title);
        await page.goto(base+'/library/ebook/recent');await page.getByRole('button',{name:'Выйти',exact:true}).click();
        await page.getByRole('heading',{name:'Вход в профиль',exact:true}).waitFor();
        const denied=await page.goto(base+'/library/ebook/read?'+new URLSearchParams({uid}));assert.equal(denied.status(),401);assert.equal(await page.locator('.reading').count(),0);
        assert.deepEqual(errors,[]);assert.equal(sockets,0);assert(resources.every(resource=>!['script','stylesheet','font','image'].includes(resource.type)),JSON.stringify(resources));
        await fs.writeJson(path.join(directory,'result.json'),{javaScriptEnabled:false,sockets,resourceTypes:[...new Set(resources.map(resource=>resource.type))],cardGeometry,
            login:true,search:true,pagination:true,annotation:true,readerPaging:true,fontRetainsPage:true,originalDownload:true,opdsProgress:true,logoutProtected:true,errors},{spaces:2});
        console.log('Ebook browser PASS: no JavaScript/WebSocket/assets, real forms/login/search/metadata/download/text pages, 600/320 px. Artifacts: '+directory);
    }catch(error){if(page)await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(output);throw error;}
    finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
