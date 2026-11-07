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
    const xml=annotation=>`<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>prose</genre><book-title>Книга превью</book-title>${annotation}<keywords>север, сказка</keywords><date value="2001-01-01">2001</date><lang>ru</lang></title-info><document-info><date value="2026-11-07">2026</date></document-info><publish-info><year>2003</year></publish-info></description><body><section><p>Полный текст не должен загружаться для превью.</p></section></body></FictionBook>`;
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
        page=await context.newPage();const errors=[],actions=[],held=[],configRequests=new Set();let mode='actual',deliveryChannels='both';
        await page.routeWebSocket('**/ws',socket=>{
            const server=socket.connectToServer();
            socket.onMessage(message=>{
                let request;try{request=JSON.parse(String(message));}catch{server.send(message);return;}
                actions.push(request.action);
                if(request.action==='get-config')configRequests.add(request.requestId);
                if(request.action!=='get-book-preview' || mode==='actual'){server.send(message);return;}
                socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                const reply=(annotation,status='ready')=>socket.send(JSON.stringify({requestId:request.requestId,bookPreview:{bookUid:request.bookUid,
                    annotation,annotationStatus:status,annotationLimited:status==='limited'}}));
                if(mode==='hold')held.push({uid:request.bookUid,reply});
                else if(mode==='unavailable')reply('','unavailable');
                else if(mode==='empty')reply('','empty');
                else if(mode==='unsupported')reply('','unsupported');
                else if(mode==='limited')reply('Это длинная аннотация для проверки единой прокрутки.\n'.repeat(100),'limited');
            });server.onMessage(message=>{
                // Expose delivery commands in this isolated UI fixture. The test
                // only opens their menu; no Telegram or email request is sent.
                let response;try{response=JSON.parse(String(message));}catch{socket.send(message);return;}
                if(configRequests.has(response.requestId)&&!response._rok){configRequests.delete(response.requestId);response.telegramShareEnabled=['both','telegram'].includes(deliveryChannels);response.emailShareEnabled=['both','email'].includes(deliveryChannels);socket.send(JSON.stringify(response));}
                else socket.send(message);
            });
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
        assert.equal(await modal.locator('.book-actions-secondary, .book-actions-card-link').count(),0,'No extra actions below the annotation');
        for(const [name,icon] of [['Отправить книгу','send'],['Полки и статус','shelf'],['Поделиться книгой','share']]) {
            const svg=modal.getByRole('button',{name,exact:true}).locator('svg[data-book-action-icon="'+icon+'"]');
            assert.equal(await svg.count(),1);const box=await svg.boundingBox();assert.equal(box.width,24);assert.equal(box.height,24);
        }
        await modal.getByRole('button',{name:'Отправить книгу',exact:true}).click();
        const sendMenu=page.getByRole('menu',{name:'Отправить книгу',exact:true});await sendMenu.waitFor();
        for(const name of ['Отправить в Telegram','Отправить по Email'])await sendMenu.getByRole('menuitem',{name,exact:true}).waitFor();
        assert.equal(await sendMenu.getByRole('menuitem').count(),2,'Delivery offers only Telegram and email');
        await page.setViewportSize({width:320,height:900});
        await page.waitForFunction(()=>{const menu=document.querySelector('[role="menu"][aria-label="Отправить книгу"]');if(!menu)return false;
            const box=menu.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth+1&&getComputedStyle(menu.closest('.q-menu')).opacity==='1';});
        const sendBox=await sendMenu.boundingBox();assert(sendBox.x>=0&&sendBox.x+sendBox.width<=321,'The delivery menu fits a narrow phone');
        await page.screenshot({path:path.join(directory,'preview-send-menu-320.png')});
        await page.keyboard.press('Escape');await sendMenu.waitFor({state:'hidden'});
        const row=modal.locator('.book-actions-primary'),buttonRows=await row.locator('.q-btn').evaluateAll(nodes=>nodes.map(node=>Math.round(node.getBoundingClientRect().top)));
        assert.equal(new Set(buttonRows).size,1,'All action icons stay in one row at 320px');
        const formatBox=await row.locator('.book-actions-formats').boundingBox();assert(formatBox.y+formatBox.height<=buttonRows[0]+1,'The format selector has its own row on a narrow phone');
        await modal.getByRole('button',{name:'Поделиться книгой',exact:true}).click();
        const shareMenu=page.getByRole('menu',{name:'Поделиться книгой',exact:true});await shareMenu.waitFor();
        for(const name of ['Копировать ссылку','Открыть страницу книги'])await shareMenu.getByRole('menuitem',{name,exact:true}).waitFor();
        for(const name of ['Отправить в Telegram','Отправить по Email'])assert.equal(await shareMenu.getByRole('menuitem',{name,exact:true}).count(),0,'Delivery has its own button');
        const menuBox=await shareMenu.boundingBox();assert(menuBox.x>=0&&menuBox.x+menuBox.width<=321,'The share menu fits a narrow phone');
        await page.screenshot({path:path.join(directory,'preview-share-menu-320.png')});
        await page.keyboard.press('Escape');await shareMenu.waitFor({state:'hidden'});assert(await modal.isVisible());
        await modal.getByRole('button',{name:'Полки и статус',exact:true}).click();
        const libraryMenu=page.getByRole('menu',{name:'Полки и статус',exact:true});await libraryMenu.getByRole('menuitem',{name:'Добавить на полку',exact:true}).waitFor();
        await page.keyboard.press('Escape');await libraryMenu.waitFor({state:'hidden'});
        await page.setViewportSize({width:1440,height:1000});
        const details=modal.locator('.book-actions-details');await modal.getByText('2003',{exact:true}).waitFor();await details.getByText('север, сказка',{exact:true}).waitFor();
        assert.equal(await details.getByText('Жанр',{exact:true}).count(),1);await details.getByText('Проза',{exact:true}).waitFor();assert(!(await details.allTextContents()).join(' ').includes('2026'));
        await page.setViewportSize({width:320,height:900});await page.screenshot({path:path.join(directory,'preview-metadata-320.png')});
        assert(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await page.setViewportSize({width:1440,height:1000});
        assert.equal(await modal.locator('.book-actions-author').textContent(),'Первый Автор, Второй Автор');
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
        assert(!actions.some(action=>/send.*(telegram|email)/i.test(action)),'Opening a menu never sends a book');
        await close();mode='actual';await page.setViewportSize({width:420,height:1000});await open('Книга превью');
        await modal.getByRole('combobox',{name:'Формат скачивания',exact:true}).click();
        await page.getByRole('option',{name:'MOBI',exact:true}).click();
        const full=page.locator('.q-dialog [data-dialog-kind="book-info"]');
        for(const method of ['back','cross','escape']) {
            await modal.getByRole('button',{name:'Полное описание',exact:true}).click();
            await full.getByRole('button',{name:'Назад к книге',exact:true}).waitFor();
            await full.getByText('Первая строка аннотации.',{exact:true}).waitFor();
            await modal.waitFor({state:'hidden'});
            if(method==='back') {await page.screenshot({path:path.join(directory,'full-description-back-420.png')});await full.getByRole('button',{name:'Назад к книге',exact:true}).click();}
            else if(method==='cross')await full.getByRole('button',{name:'Закрыть окно',exact:true}).click();
            else await page.keyboard.press('Escape');
            await modal.getByRole('button',{name:'Полное описание',exact:true}).waitFor();await full.waitFor({state:'hidden'});
            await annotation.getByText(/Первая строка аннотации/).waitFor();
            assert.equal(await modal.getByRole('link',{name:'Скачать MOBI',exact:true}).count(),1,'Returning keeps the chosen download format');
        }
        await modal.getByRole('button',{name:'Полное описание',exact:true}).click();
        await full.getByRole('button',{name:'Назад к книге',exact:true}).waitFor();
        await full.locator('.info-series-link').click();
        await page.getByRole('heading',{name:'Цикл & мир',exact:true}).waitFor();await full.waitFor({state:'hidden'});
        assert.equal(await modal.isVisible(),false,'Navigating from details must not reopen the old preview');
        for(const channel of ['telegram','email','none']) {
            deliveryChannels=channel;await page.goto(base+'/#/books?title=*Книга&lang=ru&sourceId=main');
            // Hash navigation keeps the running app and its server config.
            // Reload to receive this channel combination through get-config.
            await page.reload();await open('Книга превью');
            const send=modal.getByRole('button',{name:'Отправить книгу',exact:true});
            if(channel==='none')assert.equal(await send.count(),0,'No empty delivery menu when both channels are disabled');
            else {
                await send.click();await sendMenu.waitFor();
                await sendMenu.getByRole('menuitem',{name:channel==='telegram'?'Отправить в Telegram':'Отправить по Email',exact:true}).waitFor();
                assert.equal(await sendMenu.getByRole('menuitem').count(),1,'Only the enabled delivery channel is offered');
                await page.keyboard.press('Escape');await sendMenu.waitFor({state:'hidden'});
            }
            await close();
        }
        assert(!actions.some(action=>/send.*(telegram|email)/i.test(action)),'Testing delivery menus never sends a book');
        assert.deepEqual(errors,[]);
        await fs.writeJson(path.join(directory,'result.json'),{realFb2Annotation:true,realEpubAnnotation:true,empty:true,authorKeyboardNavigation:true,seriesScope:true,
            delayedAnnotationKeepsReadAvailable:true,lateReplyIgnored:true,plaintextEscapesMarkup:true,retry:true,unsupported:true,limited:true,geometry,
            actionMenus:true,separateDelivery:true,androidIcons:true,deliveryChannels:['both','telegram','email','none'],mobiAvailableByDefault:true,detailsReturn:['back','cross','escape'],downloadSelectionRetained:true,detailsNavigationClosesPreview:true,errors},{spaces:2});
        console.log(`Book preview browser PASS: annotation, author/series, safe plaintext, stale replies, 320px, action menus, default MOBI, return from full description and format selection. Artifacts: ${directory}`);
    }catch(error){if(page){await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(directory,'failure.html'),await page.content()).catch(()=>{});}console.error(`Artifacts: ${directory}\n${output}`);throw error;}
    finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
