// The Telegram API responses are intercepted. No token is sent to Telegram.
const assert = require('assert/strict'), fs = require('fs-extra'), os = require('os'), path = require('path');
const {spawn} = require('child_process');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {fixture} = require('./library-appearance-browser-test');
const {unusedPort} = require('./binary-smoke-test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(),'inpx-telegram-ui-'));
    await fs.ensureDir(directory);let child, browser, output = '';
    try {
        const library = path.join(directory,'library'), data = path.join(directory,'data');await fixture(library);
        await fs.copy(path.resolve('dist/tmp/public'),path.join(data,'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath,[path.resolve('server'),`--data-dir=${data}`,`--config=${library}/config.json`,`--lib-dir=${library}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',INPX_ADMIN_PASSWORD:'appearance-local-test',
                INPX_REQUIRE_AUTH:'false',INPX_AUTH_MODE:'local',INPX_ALLOW_ANONYMOUS_ACCESS:'true',INPX_TTS_ENABLED:'false',INPX_TELEGRAM_BOT_ENABLED:'false',TELEGRAM_BOT_TOKEN:''}});
        for (const stream of [child.stdout,child.stderr]) stream.on('data',part => {output = (output + part).slice(-6000);});
        let ready = false;
        for (let i=0;i<120;i++) {try {const r=await fetch(base+'/ready');ready=r.ok&&(await r.json()).ready;}catch {}if(ready||child.exitCode!==null)break;await pause(500);}
        assert(ready,output);
        browser = await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
        const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors = [], actions = [];
        page.setDefaultTimeout(15000);page.on('pageerror',error => errors.push(error.message));
        let state = 'error';
        const status = () => ({enabled:true,state,username:'fixture_bot',error:state === 'error' ? 'Telegram API недоступен; проверьте сеть и прокси' : '',lastPollAt:state === 'running' ? new Date().toISOString() : ''});
        const integrations = () => ({telegramShareEnabled:true,telegramBotEnabled:true,telegramBotToken:'__KEEP__',telegramBotTokenSet:true,
            telegramProxyMode:'direct',telegramIpFamily:'auto',telegramBotStatus:status()});
        await page.routeWebSocket('**/ws',socket => {
            const server = socket.connectToServer();
            socket.onMessage(message => {
                try {
                    const request=JSON.parse(String(message));actions.push(request.action);
                    const reply=result => {socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));socket.send(JSON.stringify({requestId:request.requestId,...result}));};
                    if(request.action==='admin-telegram-bot-status'){reply({telegramBotStatus:status()});return;}
                    if(request.action==='update-admin-integrations'){reply({integrations:{...request.integrations,...integrations()}});return;}
                    if(request.action==='test-admin-integration'){assert.equal(request.kind,'telegram');reply({success:true,username:'fixture_bot',checked:'token',telegramBotStatus:status()});return;}
                } catch(error) {if(error.name==='AssertionError')throw error;}
                server.send(message);
            });
            server.onMessage(message => {
                try {const response=JSON.parse(String(message));if(response.adminIntegrations){response.adminIntegrations={...response.adminIntegrations,...integrations()};socket.send(JSON.stringify(response));return;}}catch {}
                socket.send(message);
            });
        });
        const screenshot = name => page.screenshot({path:path.join(directory,name+'.png'),animations:'disabled'});
        await page.goto(base+'/#/books');
        await page.locator('.profile-login-action,.profile-status-chip').first().click();
        await page.getByRole('textbox',{name:'Логин',exact:true}).fill('admin');
        await page.getByRole('textbox',{name:'Пароль',exact:true}).fill('appearance-local-test');
        await page.getByRole('button',{name:'OK',exact:true}).click();await page.locator('.profile-controls .profile-logout').waitFor();
        await page.getByRole('button',{name:'Настройки',exact:true}).click();
        await page.getByRole('button',{name:/^Новый дизайн/}).click();
        await page.getByRole('navigation',{name:'Разделы библиотеки'}).waitFor();
        const open = async() => {
            await page.getByRole('button',{name:'Настройки библиотеки',exact:true}).click();
            if(!await page.locator('.telegram-status').isVisible())await page.getByRole('button',{name:/^Отправка книг/}).click();
            await page.locator('.telegram-status').waitFor();
        };
        const probe = () => page.locator('.admin-mail-section').first().getByRole('button',{name:'Проверить',exact:true});
        const colors = () => page.locator('.app-notification').evaluate(node => ({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
        await page.getByRole('button',{name:'Включить тёмную тему',exact:true}).click();
        await open();await probe().click();
        await page.locator('.app-notification--warning').waitFor();
        assert.equal(await page.locator('.app-notification--warning').getByRole('button',{name:'Закрыть уведомление',exact:true}).count(),1);
        assert((await page.locator('.telegram-status__heading').innerText()).includes('Интерактивный бот не подключён'));
        assert((await page.locator('.app-notification--warning').innerText()).includes('не подключён'));
        assert.equal(await page.locator('.app-notification--success').count(),0,'A valid token cannot claim the polling bot is healthy');
        assert((await page.locator('.telegram-status [role="alert"]').innerText()).includes('API недоступен'));
        await page.locator('.telegram-status').scrollIntoViewIfNeeded();await screenshot('telegram-probe-warning-dark-1440');
        state='running';await probe().click();
        await page.locator('.app-notification--success').waitFor();await page.locator('.app-notification--warning').waitFor({state:'hidden'});
        assert.equal(await page.locator('.telegram-status [role="alert"]').count(),0,'The immediate status refresh removes the recovered error');
        assert((await page.locator('.telegram-status').innerText()).includes('Бот принимает сообщения'));
        const dark = await colors();await screenshot('telegram-probe-success-dark-1440');
        await page.getByRole('button',{name:'OK',exact:true}).click();
        const closeNotice=page.locator('.app-notification').getByRole('button',{name:'Закрыть уведомление',exact:true});
        if(await closeNotice.isVisible())await closeNotice.click();
        await page.getByRole('button',{name:'Включить светлую тему',exact:true}).click();
        await page.setViewportSize({width:320,height:844});await open();await probe().click();
        await page.locator('.app-notification--success').waitFor();
        const light=await colors();assert.notEqual(light.background,dark.background,'Notification follows the selected light/dark theme');
        const bounds=await page.locator('.app-notification').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=321,'Notification fits a narrow phone');
        assert.equal(await page.locator('.app-notification.bg-positive,.app-notification.text-white').count(),0,'No legacy solid green notification style');
        await screenshot('telegram-probe-success-light-320');assert.deepEqual(errors,[]);
        assert.equal(actions.filter(action=>action==='test-admin-integration').length,3);
        assert(actions.filter(action=>action==='admin-telegram-bot-status').length>=6,'Each saved/probed configuration refreshes the interactive status');
        await fs.writeJson(path.join(directory,'result.json'),{dark,light,errors,actions},{spaces:2});
        console.log('Telegram status and themed notifications: warning/recovery, immediate refresh, dark/light and 320px passed');
    } catch(error) {
        if(browser){const page=browser.contexts().flatMap(c=>c.pages())[0];await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});if(page)await fs.writeFile(path.join(directory,'failure.html'),await page.content()).catch(()=>{});}
        console.error(output);throw error;
    } finally {if(browser)await browser.close();child?.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
