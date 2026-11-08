const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const {fixture}=require('./library-appearance-browser-test');
const {unusedPort}=require('./binary-smoke-test');
const {chromium}=require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

(async()=>{
    const directory=process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(),'inpx-overview-suggestions-'));
    await fs.ensureDir(directory);
    let child,browser,page,output='';
    try {
        const library=path.join(directory,'library'); await fixture(library);
        const configFile=path.join(library,'config.json'),config=await fs.readJson(configFile);
        config.uiDefaults={...config.uiDefaults,catalogAppearance:'shelves',langDefault:'ru'}; await fs.writeJson(configFile,config);
        const dataDir=path.join(directory,'data'); await fs.copy(path.resolve('dist/tmp/public'),path.join(dataDir,'public'));
        assert(await fs.pathExists(path.join(dataDir,'public/index.html')),'Build the production UI before browser fixtures');
        const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
        child=spawn(process.execPath,[path.resolve('server'),`--data-dir=${dataDir}`,`--config=${configFile}`,`--lib-dir=${library}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_TTS_ENABLED:'false',INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',
                INPX_ADMIN_PASSWORD:'overview-local-fixture',INPX_REQUIRE_AUTH:'false',INPX_AUTH_MODE:'local',INPX_ALLOW_ANONYMOUS_ACCESS:'true',INPX_TELEGRAM_BOT_ENABLED:'false'}});
        for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-12000);});
        let ready=false;
        for(let i=0;i<120;i++) {
            try {const response=await fetch(base+'/ready');ready=response.ok && (await response.json()).ready;}catch { /* Starting. */ }
            if(ready || child.exitCode!==null)break; await pause(500);
        }
        assert(ready,output);
        const book=await new Promise((resolve,reject)=>{
            const socket=new(require('ws'))(base.replace(/^http/,'ws')+'/ws');
            const timer=setTimeout(()=>{socket.terminate();reject(new Error('Fixture book lookup timeout'));},15000);
            socket.on('error',reject);
            socket.on('open',()=>socket.send(JSON.stringify({action:'bookSearch',query:{title:'*Косточка',lang:'ru',limit:1},requestId:'overview-fixture-book'})));
            socket.on('message',raw=>{const value=JSON.parse(raw);if(value._rok)return;clearTimeout(timer);socket.close();value.error?reject(new Error(value.error)):resolve(value.found[0]);});
        });
        assert(book?._uid);
        browser=await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
        const context=await browser.newContext({viewport:{width:1440,height:1000}});
        await context.addInitScript(()=>{
            if(!localStorage.getItem('vuex'))localStorage.setItem('vuex',JSON.stringify({settings:{catalogAppearance:'shelves',defaultsSet:false,langDefault:'en'}}));
            const attach=()=>{
                const container=document.querySelector('#app'),store=container?.__vue_app__?.config.globalProperties.$store;
                if(!store || window.__overviewDefaultsTracing)return;
                window.__overviewDefaultsTracing=true;
                const record=mutation=>{
                    const timeline=JSON.parse(sessionStorage.getItem('overview-defaults-trace') || '[]');
                    timeline.push({mutation,defaultsSet:store.state.settings.defaultsSet,language:store.state.settings.langDefault,
                        serverLanguage:store.state.config.uiDefaults?.langDefault ?? null,accessGranted:container._vnode?.component?.proxy?.accessGranted ?? null});
                    sessionStorage.setItem('overview-defaults-trace',JSON.stringify(timeline));
                };
                record('mount');store.subscribe(mutation=>{if(['setSettings','setConfig'].includes(mutation.type))record(mutation.type);});
            };
            new MutationObserver(attach).observe(document,{childList:true,subtree:true});
            document.addEventListener('DOMContentLoaded',attach);
        });
        page=await context.newPage(); const errors=[],requests=[],searches=[],serverDefaults=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.text().includes('Failed to resolve component'))errors.push(message.text());});
        await page.routeWebSocket('**/ws',socket=>{
            const server=socket.connectToServer();
            socket.onMessage(message=>{
                const request=JSON.parse(String(message));
                if(request.action==='bookSearch')searches.push(request.query);
                if(request.action==='get-book-preview') {
                    socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                    socket.send(JSON.stringify({requestId:request.requestId,bookPreview:{bookUid:request.bookUid,annotation:'Аннотация fixture',annotationStatus:'ready',annotationLimited:false}}));
                    return;
                }
                if(request.action!=='catalog-suggest'){server.send(message);return;}
                socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                requests.push({options:request.options,finish:value=>socket.send(JSON.stringify({requestId:request.requestId,...value}))});
            });
            server.onMessage(message=>{const body=JSON.parse(String(message));if(body.uiDefaults)serverDefaults.push({language:body.uiDefaults.langDefault});socket.send(message);});
        });
        const requested=async count=>{for(let i=0;i<100 && requests.length<count;i++)await pause(50);assert.equal(requests.length,count);return requests[count-1];};
        const searched=async predicate=>{for(let i=0;i<100 && !searches.some(predicate);i++)await pause(50);assert(searches.some(predicate),'The catalog search uses the overview scope');};
        const result=name=>({query:'Косточка',groups:[{kind:'title',items:[{name:name || book.title,count:1,book:{...book,title:name || book.title}}]}],corrections:[]});
        const mutateSettings=patch=>page.evaluate(patch=>document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('setSettings',patch),patch);
        const screenshot=name=>page.screenshot({path:path.join(directory,name+'.png'),animations:'disabled'});
        await page.goto(base+'/#/overview');
        await page.getByRole('navigation',{name:'Разделы библиотеки'}).waitFor();
        await page.waitForFunction(()=>!!document.querySelector('#app')?.__vue_app__?.config.globalProperties.$store.state.config.dbVersion);
        await page.locator('.overview-loading').waitFor({state:'hidden'});
        const input=page.locator('.overview-search input'),listId=await input.getAttribute('aria-controls');
        assert(listId,'Overview input owns its listbox');
        const listbox=page.locator('#'+listId);
        await input.fill('Ко'); await pause(400);
        assert.equal(requests.length,0,'Two characters do not query suggestions');
        await input.fill('Кос'); const first=await requested(1);
        await fs.writeJson(path.join(directory,'defaults-evidence.json'),{serverDefaults,timeline:await page.evaluate(()=>JSON.parse(sessionStorage.getItem('overview-defaults-trace') || '[]'))},{spaces:2});
        assert.equal(first.options.kind,'title'); assert.deepEqual(first.options.filters,{lang:'ru'},'First-visit server language matches the catalog');
        await input.press('Enter');
        await page.locator('.catalog-search-panel').waitFor();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('title'),'*Кос','Enter does not wait for a suggestion reply');
        await searched(query=>query.title==='*Кос' && query.lang==='ru');
        first.finish(result('Obsolete overview result')); await pause(150);
        assert.equal(await page.getByRole('option',{name:/Obsolete overview result/}).count(),0,'Leaving overview ignores late suggestions');

        await page.getByRole('link',{name:'Обзор',exact:true}).click();
        await input.fill('Косто'); const clickRequest=await requested(2); clickRequest.finish(result());
        await listbox.getByRole('option',{name:new RegExp('^'+book.title)}).waitFor();
        assert.deepEqual((await listbox.locator('.catalog-suggestions__heading').allTextContents()).map(text=>text.trim()),['Книги']);
        await screenshot('overview-suggestions-1440');
        const overviewUrl=page.url();
        await listbox.getByRole('option',{name:new RegExp('^'+book.title)}).click();
        const preview=page.locator('.q-dialog [data-dialog-kind="book"]');
        await preview.getByRole('heading',{name:book.title,exact:true}).waitFor();
        assert.equal(page.url(),overviewUrl,'Choosing a book opens a preview on overview');
        await page.getByRole('button',{name:'Закрыть окно',exact:true}).click(); await preview.waitFor({state:'hidden'});
        await input.fill('Косточка'); const keyboardRequest=await requested(3); keyboardRequest.finish(result());
        await listbox.getByRole('option',{name:new RegExp('^'+book.title)}).waitFor();
        await page.setViewportSize({width:320,height:900});
        await page.waitForFunction(id=>{
            const node=document.getElementById(id)?.closest('.catalog-suggestions');if(!node)return false;
            const rect=node.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth+1 && node.scrollWidth<=node.clientWidth+1;
        },listId);
        const geometry=await listbox.locator('..').evaluate(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,
            width:innerWidth,scroll:node.scrollWidth,client:node.clientWidth}));
        assert(geometry.left>=0 && geometry.right<=geometry.width+1 && geometry.scroll<=geometry.client+1,'Overview suggestions fit mobile: '+JSON.stringify(geometry));
        await screenshot('overview-suggestions-320');
        await input.press('ArrowDown'); assert(await input.getAttribute('aria-activedescendant'));
        await input.press('Enter'); await preview.getByRole('heading',{name:book.title,exact:true}).waitFor();
        assert.equal(page.url(),overviewUrl,'Arrow+Enter chooses a preview instead of submitting the form');
        await page.getByRole('button',{name:'Закрыть окно',exact:true}).click(); await preview.waitFor({state:'hidden'});
        await page.setViewportSize({width:1440,height:1000});

        await input.fill('Косточ'); const correction=await requested(4);
        correction.finish({query:'Косточ',groups:[],corrections:[{kind:'title',query:'Косточка'}]});
        await listbox.getByRole('option',{name:'Косточка',exact:true}).click();
        await page.locator('.catalog-search-panel').waitFor();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('title'),'*Косточка');
        await searched(query=>query.title==='*Косточка' && query.lang==='ru');
        await page.getByRole('link',{name:'Обзор',exact:true}).click();
        await page.getByRole('link',{name:'Открыть каталог и фильтры',exact:true}).click();
        await page.locator('.catalog-search-panel').waitFor();
        await searched(query=>!query.title && query.lang==='ru');
        await page.getByRole('link',{name:'Обзор',exact:true}).click();

        await input.fill('Коста'); const oldLanguage=await requested(5);
        assert.equal(oldLanguage.options.filters.lang,'ru');
        await mutateSettings({defaultsSet:true,langDefault:'en'}); const newLanguage=await requested(6);
        assert.equal(newLanguage.options.filters.lang,'en'); newLanguage.finish(result('English overview result'));
        await listbox.getByRole('option',{name:/^English overview result/}).waitFor();
        oldLanguage.finish(result('Obsolete Russian result')); await pause(150);
        assert.equal(await listbox.getByRole('option',{name:/Obsolete Russian result/}).count(),0,'Language changes ignore old replies');
        await listbox.getByRole('option',{name:/^English overview result/}).waitFor();

        await input.fill('Кост'); const oldContext=await requested(7);
        await page.evaluate(()=>{
            const store=document.querySelector('#app').__vue_app__.config.globalProperties.$store;
            store.commit('setConfig',{...store.state.config,currentUserId:'overview-context-fixture'});
        });
        await listbox.waitFor({state:'hidden'});
        oldContext.finish(result('Obsolete profile result')); await pause(150);
        assert.equal(await input.getAttribute('aria-expanded'),'false');
        assert.equal(await page.getByRole('option',{name:/Obsolete profile result/}).count(),0,'Profile/library revision clears pending overview suggestions');
        assert.deepEqual(errors,[]);
        await fs.writeJson(path.join(directory,'result.json'),{requests:requests.map(request=>request.options),min3:true,enterBeforeReply:true,
            clickPreview:true,keyboardPreview:true,correction:true,effectiveLanguage:true,lateLanguageIgnored:true,contextReset:true,geometry,errors},{spaces:2});
        console.log('Overview suggestions browser: MIN3/title scope, search-before-reply, preview click/keyboard, default language and stale-context guards passed. Artifacts: '+directory);
    } catch(error) {
        if(page){await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(directory,'failure.html'),await page.content()).catch(()=>{});}
        console.error(output);throw error;
    } finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
