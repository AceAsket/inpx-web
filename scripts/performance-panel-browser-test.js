// Real compiled UI; only benchmark metrics/actions are isolated fixtures.
// No benchmark worker load or external service request is started.
const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const {createFixture,unusedPort}=require('./binary-smoke-test');
const {chromium}=require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const preferenceKey=require('../client/components/Search/SettingsDialog/performancePreferences').KEY;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MiB=1024**2;

(async()=>{
    const directory=process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(),'inpx-performance-browser-'));
    await fs.ensureDir(directory);let browser,child,page,output='';
    try {
        const library=path.join(directory,'library');await createFixture(library);
        await fs.writeJson(path.join(library,'config.json'),{loggingEnabled:false,allowAnonymousAccess:true,adminPassword:'performance-browser-fixture'});
        const dataDir=path.join(directory,'data');await fs.copy(path.resolve('dist/tmp/public'),path.join(dataDir,'public'));
        const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
        child=spawn(process.execPath,[path.resolve('server'),`--data-dir=${dataDir}`,`--config=${library}/config.json`,`--lib-dir=${library}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_TTS_ENABLED:'false',INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',
                INPX_ADMIN_PASSWORD:'performance-browser-fixture',INPX_REQUIRE_AUTH:'false',INPX_AUTH_MODE:'local',INPX_TELEGRAM_BOT_ENABLED:'false'}});
        for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-10000);});
        let ready=false;
        for(let i=0;i<120;i++) {try {const response=await fetch(base+'/ready');ready=response.ok&&(await response.json()).ready;}catch{}if(ready||child.exitCode!==null)break;await pause(500);}
        assert(ready,output);
        browser=await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
        const context=await browser.newContext({viewport:{width:1280,height:1000}});
        await context.addInitScript(key=>{
            if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,entries:[{scope:'["","another-profile"]',
                draft:{selected:'performance',sourceId:'two',customLimits:{total:9,images:3,reviews:9,conversions:3}}}]}));
        },preferenceKey);
        page=await context.newPage();
        const errors=[],requests=[];let reads=0,sourceIds=['one','two'],legacy=false,jobState='idle';
        const report=()=>({schema:legacy ? 1:2,legacy,mode:'custom',measuredAt:'2026-11-07T10:00:00.000Z',source:{id:'one',name:'Первое хранилище'},
            machine:{memoryScope:'cgroup'},confidence:'partial',criteria:{probeP95Ms:100,timerLagP95Ms:100,memoryRatio:.85,minProbeSamples:5},
            recommendation:{profile:'balanced',measured:false},rows:[{profile:'custom',completed:true,limits:{total:8,images:4,reviews:8,conversions:3},
                firstPassMs:2180,repeatPassMs:2090,elapsedMs:2080,rounds:3,probeSamples:8,probeSuccessfulSamples:8,probeTimeouts:0,probeFailures:0,
                probeP95Ms:168,timerLagP95Ms:10,memoryRatio:.5,peakMemory:698*MiB,memoryDelta:6*MiB,cpuPercent:140,cpuTimeMs:3061,
                tasksPerPass:32,tasksPerStage:8}]});
        await page.routeWebSocket('**/ws',socket=>{
            const server=socket.connectToServer();
            socket.onMessage(message=>{
                let request;try {request=JSON.parse(String(message));}catch {server.send(message);return;}
                let value;
                if(request.action==='get-admin-performance') {
                    reads++;
                    value={machine:{cpu:4,memoryLimit:2048*MiB,memoryUsed:700*MiB,memoryScope:'cgroup',cpuUsageUs:reads*100000},
                        processMemory:{rss:100*MiB},runtime:{active:0,queued:0},databaseCache:{available:true},report:report(),
                        job:jobState==='idle' ? null:{state:jobState,stage:'Готово',progress:0,message:jobState==='failed' ? 'Предыдущая попытка не завершилась':''},
                        recommendation:{profile:'balanced',measured:false,reason:'Рекомендация не меняет параметры теста.'},
                        sources:sourceIds.map(id=>({id,name:id==='one' ? 'Первое хранилище':'Второе хранилище'})),
                        settings:{selected:'balanced',limits:{total:4,images:2,reviews:4,conversions:2,background:1},hardMax:12,
                            benchmarkEnabled:true,benchmarkTimeoutMs:60000,launchEnv:{},profiles:[
                                {id:'economy',name:'Бережный',limits:{total:2,images:1,reviews:2,conversions:1}},
                                {id:'balanced',name:'Сбалансированный',limits:{total:4,images:2,reviews:4,conversions:2}},
                                {id:'performance',name:'Производительный',limits:{total:6,images:3,reviews:6,conversions:3}}]}};
                } else if(request.action==='start-admin-benchmark') {requests.push(request.options);value={job:{state:'completed'}};}
                else if(request.action==='cancel-admin-benchmark')value={job:{state:'cancelled'}};
                else {server.send(message);return;}
                socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));socket.send(JSON.stringify({requestId:request.requestId,...value}));
            });server.onMessage(message=>socket.send(message));
        });
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(base+'/#/books?title=Packaged');
        const login=async()=>{
            await page.locator('.profile-login-action,.profile-status-chip').first().click();
            await page.getByRole('textbox',{name:'Логин',exact:true}).fill('admin');await page.getByRole('textbox',{name:'Пароль',exact:true}).fill('performance-browser-fixture');
            await page.getByRole('button',{name:'OK',exact:true}).click();await page.locator('.profile-controls .profile-logout').waitFor();
        };
        await login();
        const panel=page.locator('.performance-panel');
        const open=async()=>{
            await page.getByRole('toolbar',{name:'Действия библиотеки'}).getByRole('button',{name:'Настройки',exact:true}).click();
            if(!await panel.count())await page.getByRole('button',{name:/Администрирование/}).click();
            await panel.getByTestId('performance-active').waitFor();
        };
        const close=()=>page.getByRole('button',{name:'OK',exact:true}).click();
        await open();
        assert.equal(await panel.getByRole('button',{name:/^Сбалансированный/}).getAttribute('aria-pressed'),'true','Another profile draft must not become the admin test selection');
        await panel.getByRole('button',{name:/^Бережный/}).click();await panel.getByTestId('performance-start').click();
        assert.deepEqual(requests.at(-1),{sourceId:'one',mode:'profile',profileId:'economy'});
        await panel.getByTestId('performance-active').getByText('Сбалансированный',{exact:true}).waitFor();
        await panel.getByRole('button',{name:/^Сравнить три режима/}).first().click();await panel.getByTestId('performance-start').click();
        assert.deepEqual(requests.at(-1),{sourceId:'one',mode:'compare'});
        await panel.getByRole('button',{name:/^Свои значения/}).click();
        for(const [label,value] of [['Всего одновременно','8'],['Изображения','3'],['Архивы','5'],['Конвертация','2']])await panel.getByRole('spinbutton',{name:label,exact:true}).fill(value);
        await panel.locator('.performance-source').click();await page.getByRole('option',{name:'Второе хранилище',exact:true}).click();
        await panel.getByTestId('performance-save-status').filter({hasText:'Сохранено в этом браузере для текущего профиля.'}).waitFor();
        await close();await open();
        assert.equal(await panel.getByRole('spinbutton',{name:'Всего одновременно',exact:true}).inputValue(),'8');
        await panel.locator('.performance-source').getByText('Второе хранилище',{exact:true}).waitFor();
        await close();await page.reload();await page.locator('.profile-controls .profile-logout').waitFor();await open();
        assert.equal(await panel.getByRole('button',{name:/^Свои значения/}).getAttribute('aria-pressed'),'true');
        for(const [label,value] of [['Всего одновременно','8'],['Изображения','3'],['Архивы','5'],['Конвертация','2']])assert.equal(await panel.getByRole('spinbutton',{name:label,exact:true}).inputValue(),value);
        await panel.getByTestId('performance-start').click();assert.deepEqual(requests.at(-1),{sourceId:'two',mode:'custom',limits:{total:8,images:3,reviews:5,conversions:2}});
        await panel.getByTestId('performance-result').getByText('Свои значения: отклик выше порога проверки',{exact:true}).waitFor();
        await panel.locator('.performance-result-card').getByText(/Внутренний отклик p95: 168 мс; критерий — меньше 100 мс/).waitFor();
        await panel.locator('.performance-result-card').getByText('Проверенные лимиты: изображения 4 · архивы 8 · конвертация 3',{exact:true}).waitFor();
        assert.equal(await panel.locator('.performance-result-card').getAttribute('data-status'),'attention');
        await panel.getByTestId('performance-result').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'performance-result-1280.png')});
        await page.setViewportSize({width:320,height:900});await panel.getByTestId('performance-result').scrollIntoViewIfNeeded();
        const geometry=await panel.evaluate(node=>{const bounds=node.getBoundingClientRect();return {width:node.clientWidth,scroll:node.scrollWidth,view:innerWidth,
            cards:[...node.querySelectorAll('.performance-result-card')].map(card=>{const r=card.getBoundingClientRect();return {left:r.left,right:r.right};}),
            overflow:[...node.querySelectorAll('*')].filter(child=>{const r=child.getBoundingClientRect();return r.width && (r.right>bounds.right+1 || r.left<bounds.left-1);})
                .slice(0,12).map(child=>({tag:child.tagName,class:child.className,text:(child.textContent||'').slice(0,70)}))};});
        assert(geometry.scroll<=geometry.width+1 && geometry.cards.every(card=>card.left>=0 && card.right<=geometry.view),JSON.stringify(geometry));
        await page.screenshot({path:path.join(directory,'performance-result-320.png')});
        await panel.locator('.performance-result-card').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'performance-metrics-320.png')});
        await panel.getByRole('spinbutton',{name:'Изображения',exact:true}).fill('1.5');await close();await open();
        assert.equal(await panel.getByRole('spinbutton',{name:'Изображения',exact:true}).inputValue(),'1.5');assert(await panel.getByTestId('performance-start').isDisabled());
        await panel.getByRole('spinbutton',{name:'Изображения',exact:true}).fill('3');
        sourceIds=['one'];legacy=true;jobState='failed';
        await panel.getByRole('button',{name:'Обновить показатели производительности',exact:true}).click();
        await panel.getByText(/Сохранённое хранилище недоступно/).waitFor();
        await panel.getByTestId('performance-result').getByText(/отчёт прежнего формата/).waitFor();
        await panel.getByTestId('performance-result').getByText(/Сохранённый результат относится к предыдущей завершённой проверке/).waitFor();
        await panel.getByTestId('performance-result').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'performance-legacy-320.png')});
        const stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),preferenceKey);
        assert.equal(stored.entries.length,2);assert(stored.entries.some(entry=>entry.scope==='["","another-profile"]' && entry.draft.customLimits.total===9));
        for(const entry of stored.entries)assert.deepEqual(Object.keys(entry.draft).sort(),['customLimits','selected','sourceId']);
        for(const secret of ['profileAccessToken','telegram','performance-browser-fixture','config'])assert(!JSON.stringify(stored).includes(secret));
        assert.deepEqual(errors,[]);
        await fs.writeJson(path.join(directory,'result.json'),{requests,reopenAndReload:true,profileIsolation:true,invalidDraftRetained:true,activeProfile:'balanced',
            visibleCriteria:'168ms vs <100ms',legacyVisible:true,sourceFallback:true,geometry,errors},{spaces:2});
        console.log(`Performance browser PASS: profile/custom/compare payloads, scoped draft reopen/reload, invalid limits, active profile, current/legacy result and 320px layout. Artifacts: ${directory}`);
    } catch(error) {if(page)await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(`Artifacts: ${directory}\n${output}`);throw error;}
    finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
