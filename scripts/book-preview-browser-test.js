const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const {archive}=require('./library-appearance-browser-test');
const {unusedPort}=require('./binary-smoke-test');
const {chromium}=require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fixture(directory) {
    await fs.ensureDir(directory);
    const epub=path.join(directory,'source.epub');await require('./epub-fb2-tests').fixture(epub);
    const epubData=await fs.readFile(epub),titles=['Книга превью','Книга без аннотации','Книга EPUB'];
    const rows=titles.map((title,index)=>['Первый,Автор:Второй,Автор:','prose:',title,'Цикл & мир','1',String(index+1),'100',String(index+1),'0',
        index===2 ? 'epub':'fb2','2026-11-07','ru','0',''].join('\x04'));
    await archive(path.join(directory,'sample.inpx'),[['collection.info','Проверка превью'],['version.info','20261107'],['sample.inp',rows.join('\n')+'\n']]);
    const xml=annotation=>`<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>prose</genre><book-title>Книга превью</book-title>${annotation}<lang>ru</lang></title-info></description><body><section><p>Полный текст не должен загружаться для превью.</p></section></body></FictionBook>`;
    await archive(path.join(directory,'sample.zip'),[['1.fb2',xml('<annotation><p>Первая строка аннотации.</p><p>Вторая строка и детали.</p></annotation>')],
        ['2.fb2',xml('')],['3.epub',epubData]]);
    await fs.writeJson(path.join(directory,'config.json'),{loggingEnabled:false,allowAnonymousAccess:true,onlineReaderEnabled:true,discovery:{enabled:true}});
}

(async()=>{
    const directory=process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(),'inpx-book-preview-browser-'));
    await fs.ensureDir(directory);let browser,child,page,output='';
    try {
        const library=path.join(directory,'library');await fixture(library);
        const dataDir=path.join(directory,'data');await fs.copy(path.resolve('dist/tmp/public'),path.join(dataDir,'public'));
        const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
        child=spawn(process.execPath,[path.resolve('server'),`--data-dir=${dataDir}`,`--config=${library}/config.json`,`--lib-dir=${library}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_TTS_ENABLED:'false',INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',
                INPX_ADMIN_PASSWORD:'book-preview-local-fixture',INPX_REQUIRE_AUTH:'false',INPX_AUTH_MODE:'local',INPX_ALLOW_ANONYMOUS_ACCESS:'true',INPX_TELEGRAM_BOT_ENABLED:'false'}});
        for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-12000);});
        let ready=false;
        for(let i=0;i<120;i++){try{const r=await fetch(base+'/ready');ready=r.ok&&(await r.json()).ready;}catch{}if(ready||child.exitCode!==null)break;await pause(500);}
        assert(ready,output);
        browser=await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
        const context=await browser.newContext({viewport:{width:1440,height:1000}});
        await context.addInitScript(()=>{if(!localStorage.getItem('vuex'))localStorage.setItem('vuex',JSON.stringify({settings:{catalogAppearance:'shelves',defaultsSet:true,langDefault:'ru'}}));});
        page=await context.newPage();const errors=[],actions=[],held=[];let mode='actual';
        await page.routeWebSocket('**/ws',socket=>{
            const server=socket.connectToServer();
            socket.onMessage(message=>{
                let request;try{request=JSON.parse(String(message));}catch{server.send(message);return;}
                actions.push(request.action);
                if(request.action!=='get-book-preview' || mode==='actual'){server.send(message);return;}
                socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                const reply=(annotation,status='ready')=>socket.send(JSON.stringify({requestId:request.requestId,bookPreview:{bookUid:request.bookUid,
                    annotation,annotationStatus:status,annotationLimited:status==='limited'}}));
                if(mode==='hold')held.push({uid:request.bookUid,reply});
                else if(mode==='unavailable')reply('','unavailable');
                else if(mode==='empty')reply('','empty');
                else if(mode==='unsupported')reply('','unsupported');
                else if(mode==='limited')reply('Это длинная аннотация для проверки единой прокрутки.\n'.repeat(100),'limited');
            });server.onMessage(message=>socket.send(message));
        });
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(base+'/#/books?title=*Книга&lang=ru&sourceId=main');
        const modal=page.locator('.q-dialog [data-dialog-kind="book"]'),annotation=modal.locator('.book-actions-annotation');
        const open=async title=>{
            await page.getByRole('button',{name:'Открыть карточку: '+title,exact:true}).click();
            await modal.getByRole('heading',{name:title,exact:true}).waitFor();
            await page.waitForFunction(()=>{
                const node=document.querySelector('.q-dialog [data-dialog-kind="book"]');
                if(!node || node.getBoundingClientRect().width<node.clientWidth-1)return false;
                for(let item=node;item;item=item.parentElement)
                    if(+getComputedStyle(item).opacity<.99 || item.getAnimations().some(animation=>['running','pending'].includes(animation.playState)))return false;
                return true;
            });
        };
        const close=async()=>{await modal.getByRole('button',{name:'Закрыть окно',exact:true}).click();await modal.waitFor({state:'hidden'});};
        const scoped=()=>{const p=new URLSearchParams(page.url().split('?')[1]);assert.equal(p.get('lang'),'ru');assert.equal(p.get('sourceId'),'main');return p;};
        await open('Книга превью');
        await annotation.getByText(/Первая строка аннотации/).waitFor();assert((await annotation.innerText()).includes('Вторая строка и детали.'));
        assert.equal(await modal.locator('.book-actions-author').textContent(),'Первый Автор,Второй Автор');
        assert.equal(await modal.locator('.book-actions-author a').count(),2);
        const firstAuthor=modal.getByRole('link',{name:'Первый Автор',exact:true});
        assert((await firstAuthor.getAttribute('href')).includes('author-details'));
        await page.screenshot({path:path.join(directory,'preview-annotation-1440.png')});
        await firstAuthor.focus();await page.keyboard.press('Enter');
        await page.getByRole('heading',{name:'Первый Автор',exact:true}).waitFor();assert.equal(scoped().get('name'),'Первый Автор');
        await modal.waitFor({state:'hidden'});assert.equal(await modal.isVisible(),false,'Author keyboard navigation closes the preview');
        await page.goBack();await open('Книга превью');await annotation.getByText(/Первая строка аннотации/).waitFor();
        await modal.locator('.book-actions-series').click();await page.getByRole('heading',{name:'Цикл & мир',exact:true}).waitFor();
        assert.equal(scoped().get('name'),'Цикл & мир');await modal.waitFor({state:'hidden'});assert.equal(await modal.isVisible(),false);
        await page.goBack();await open('Книга EPUB');await annotation.getByText('Аннотация книги.',{exact:true}).waitFor();await close();
        await open('Книга без аннотации');await annotation.getByText('В книге нет аннотации.',{exact:true}).waitFor();await close();
        mode='hold';await open('Книга превью');
        for(let i=0;i<50&&!held.length;i++)await pause(50);assert.equal(held.length,1);
        await annotation.getByText('Загружаем аннотацию',{exact:true}).waitFor();await modal.getByRole('button',{name:'Читать',exact:true}).waitFor();
        await close();await open('Книга без аннотации');for(let i=0;i<50&&held.length<2;i++)await pause(50);assert.equal(held.length,2);
        held[0].reply('Устаревшая аннотация');
        const unsafe='<img src=x onerror="window.__previewXSS=true"><script>window.__previewXSS=true</script>\nБезопасный текст';
        held[1].reply(unsafe);await annotation.getByText(unsafe,{exact:true}).waitFor();
        assert.equal(await annotation.locator('img,script').count(),0);assert.equal(await page.evaluate(()=>!!window.__previewXSS),false);
        assert.equal(await page.getByText('Устаревшая аннотация',{exact:true}).count(),0);await close();
        mode='unavailable';await open('Книга превью');await annotation.getByText(/Не удалось загрузить аннотацию/).waitFor();
        mode='empty';await annotation.getByRole('button',{name:'Повторить',exact:true}).click();await annotation.getByText('В книге нет аннотации.',{exact:true}).waitFor();await close();
        mode='unsupported';await open('Книга превью');await annotation.getByText(/Для этого формата или источника/).waitFor();await close();
        mode='limited';await page.setViewportSize({width:320,height:900});await open('Книга превью');
        await annotation.getByText(/Показан фрагмент аннотации/).waitFor();
        const geometry=await modal.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:node.clientWidth,scroll:node.scrollWidth,viewport:innerWidth,
            scrollers:[...node.querySelectorAll('*')].filter(child=>child.clientHeight>0&&child.scrollHeight>child.clientHeight+1&&/auto|scroll/.test(getComputedStyle(child).overflowY))
                .map(child=>({class:child.className,height:child.clientHeight,scroll:child.scrollHeight}))};});
        assert(geometry.left>=0&&geometry.right<=320&&geometry.right-geometry.left>=geometry.width-1&&geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
        assert.equal(geometry.scrollers.length,1,'The preview has one modal scroller, no nested annotation scroller');assert(geometry.scrollers[0].class.includes('dialog-body'));
        await modal.locator('.dialog-body').evaluate(node=>{node.scrollTop=0;});await page.screenshot({path:path.join(directory,'preview-annotation-320.png')});
        await annotation.locator('.book-actions-annotation-status').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'preview-limited-320.png')});
        assert(!actions.some(action=>['get-book-info','get-book-gallery','get-book-link'].includes(action)),'Preview never loads full card/reader/gallery data');
        assert.deepEqual(errors,[]);
        await fs.writeJson(path.join(directory,'result.json'),{realFb2Annotation:true,realEpubAnnotation:true,empty:true,authorKeyboardNavigation:true,seriesScope:true,
            delayedAnnotationKeepsReadAvailable:true,lateReplyIgnored:true,plaintextEscapesMarkup:true,retry:true,unsupported:true,limited:true,geometry,
            forbiddenActions:actions.filter(action=>['get-book-info','get-book-gallery','get-book-link'].includes(action)),errors},{spaces:2});
        console.log(`Book preview browser PASS: real FB2/EPUB annotation, author/series scope and keyboard, loading/error/retry/empty/limited, safe plaintext, stale reply and one-scroller 320px. Artifacts: ${directory}`);
    }catch(error){if(page){await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(directory,'failure.html'),await page.content()).catch(()=>{});}console.error(`Artifacts: ${directory}\n${output}`);throw error;}
    finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
