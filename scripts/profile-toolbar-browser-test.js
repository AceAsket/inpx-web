// Optional browser check: profile sessions, catalog shortcuts and administrator tasks.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-toolbar-'));
    await fs.ensureDir(directory);
    let browser, child, output = '';
    try {
        const library = path.join(directory, 'library'); await createFixture(library);
        await fs.writeJson(path.join(library, 'config.json'), {
            loggingEnabled: false, opds: {enabled: true}, adminPassword: 'profile-toolbar-test', allowAnonymousAccess: true,
        });
        const dataDir = path.join(directory, 'data');
        await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${library}/config.json`,
            `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env, INPX_TTS_ENABLED: 'false', INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
                INPX_ADMIN_PASSWORD: 'profile-toolbar-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local'}});
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output = (output + data).slice(-8000);});
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const response = await fetch(base + '/ready'); ready = response.ok && (await response.json()).ready;} catch { /* Starting. */ }
            if (ready || child.exitCode !== null) break;
            await pause(500);
        }
        assert(ready, output);
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
        let benchmarkOptions = null, benchmarkState = 'idle', performanceReads = 0;
        const integrationUpdates = [], integrationReplies = [], telegramProbeModes = [];
        let lastSavedIntegrations = {};
        await page.routeWebSocket('**/ws', socket => {
            const server = socket.connectToServer(), integrationRequests = new Set();
            socket.onMessage(message => {
                let request;
                try {request = JSON.parse(String(message));} catch {server.send(message); return;}
                if (request.action === 'update-admin-integrations') {
                    integrationRequests.add(request.requestId); integrationUpdates.push(request.integrations);
                }
                let response;
                if (request.action === 'get-admin-performance') {
                    performanceReads++;
                    response = {machine: {cpu: 2, memoryLimit: 512 * 1048576, memoryUsed: 128 * 1048576, memoryScope: 'cgroup', cpuUsageUs: performanceReads * 200000},
                        processMemory: {rss: 96 * 1048576}, runtime: {active: benchmarkState === 'running' ? 1 : 0, queued: 0}, databaseCache: {available: true},
                        recommendation: {profile: 'balanced', measured: false, reason: 'Метрики браузерной проверки'},
                        sources: [{id: 'browser-fixture', name: 'Тестовое хранилище'}], report: null,
                        job: {state: benchmarkState, stage: benchmarkState === 'running' ? 'Проверка своих значений' : 'Готово', progress: benchmarkState === 'running' ? .4 : 0,
                            sample: {memoryUsed: 130 * 1048576, peakMemory: 132 * 1048576, cpuPercent: 25}},
                        settings: {selected: 'balanced', limits: {total: 4, background: 1, images: 2, reviews: 1, conversions: 1}, hardMax: 12,
                            benchmarkEnabled: true, benchmarkTimeoutMs: 60000, launchEnv: {INPX_RESOURCE_PROFILE: 'balanced'},
                            profiles: [{id: 'balanced', name: 'Сбалансированный', limits: {total: 4, images: 2, reviews: 1, conversions: 1}}]}};
                } else if (request.action === 'start-admin-benchmark') {
                    // Exercise the real form/transport without starting worker load.
                    benchmarkOptions = request.options; benchmarkState = 'running'; response = {state: 'running'};
                } else if (request.action === 'cancel-admin-benchmark') {
                    benchmarkState = 'cancelled'; response = {state: 'cancelled'};
                } else if (request.action === 'test-admin-integration' && request.kind === 'telegram') {
                    // The real save/config path runs first. No request reaches Telegram or a proxy.
                    telegramProbeModes.push(lastSavedIntegrations.telegramProxyMode);
                    response = {success:true,checked:'token',username:'fixture_bot',message:'Токен Telegram проверен: fixture_bot'};
                } else {server.send(message); return;}
                socket.send(JSON.stringify({requestId: request.requestId, _rok: 1}));
                socket.send(JSON.stringify({requestId: request.requestId, ...response}));
            });
            server.onMessage(message => {
                const body = JSON.parse(String(message));
                if (integrationRequests.has(body.requestId) && !body._rok) {
                    integrationRequests.delete(body.requestId);
                    lastSavedIntegrations = body.integrations || {};
                    integrationReplies.push(lastSavedIntegrations);
                }
                socket.send(message);
            });
        });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(base + '/#/books?title=Packaged&lang=en');
        const login = async() => {
            await page.locator('.profile-login-action,.profile-status-chip').first().click();
            await page.getByRole('dialog').evaluate(async node => {
                await Promise.allSettled(node.getAnimations({subtree:true}).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
            });
            await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
            await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('profile-toolbar-test');
            await page.getByRole('button', {name: 'OK', exact: true}).click();
            await page.locator('.profile-controls .profile-logout').waitFor({state: 'visible'});
        };
        await login();
        const toolbar = page.getByRole('toolbar', {name: 'Действия библиотеки'});
        for (const width of [1280, 760, 514, 390, 320]) {
            await page.setViewportSize({width, height: 900}); await pause(350);
            await toolbar.getByRole('button', {name: 'Сохранить поиск как полку', exact: true}).waitFor({state: 'visible'});
            assert.equal(await page.getByRole('button', {name: 'Задачи и состояние библиотеки', exact: true}).count(), 0);
            const geometry = await toolbar.evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth,
                buttons: Array.from(node.querySelectorAll('.button[role="button"]')).map(button => {
                    const r = button.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height};
                }), pageWidth: document.documentElement.scrollWidth, viewport: window.innerWidth}));
            assert.equal(geometry.buttons.length, 5);
            const axis = width > 900 ? 'x' : 'y';
            assert(Math.max(...geometry.buttons.map(button => button[axis])) - Math.min(...geometry.buttons.map(button => button[axis])) < 2, JSON.stringify({width, geometry}));
            assert(geometry.scroll <= geometry.width + 1, 'Actions must fit without scrolling at width ' + width);
            assert(geometry.pageWidth <= geometry.viewport + 1, 'No document overflow at width ' + width);
            await page.screenshot({path: path.join(directory, `toolbar-${width}.png`)});
        }
        await page.setViewportSize({width: 1280, height: 900}); await pause(350);
        await toolbar.getByRole('button', {name: 'Сохранить поиск как полку', exact: true}).click();
        await page.getByRole('button', {name: 'Отмена', exact: true}).click();
        await toolbar.getByRole('button', {name: 'Избранные авторы и серии', exact: true}).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('button', {name: 'Закрыть избранное', exact: true}).click();
        await toolbar.getByRole('button', {name: 'Настройки', exact: true}).click();
        await page.getByRole('checkbox', {name: 'Ночная тема', exact: true}).click();
        await page.getByRole('button', {name: /Администрирование/}).click();
        await page.getByRole('button', {name: 'Задачи и состояние библиотеки', exact: true}).click();
        await page.getByText('Проверка библиотеки', {exact: true}).waitFor();
        await pause(350);
        await page.screenshot({path: path.join(directory, 'admin-tasks.png')});
        await page.getByRole('button', {name: 'Закрыть задачи', exact: true}).click();
        const performancePanel = page.locator('.performance-panel');
        await performancePanel.getByRole('button', {name: /^Свои значения/}).click();
        await performancePanel.getByRole('spinbutton', {name: 'Всего одновременно', exact: true}).fill('2');
        await performancePanel.getByRole('spinbutton', {name: 'Изображения', exact: true}).fill('3');
        const runBenchmark = performancePanel.getByTestId('performance-start');
        await performancePanel.getByText('Лимит отдельного вида задач превышает общий.', {exact: true}).waitFor();
        assert(await runBenchmark.isDisabled()); assert.equal(benchmarkOptions, null);
        await performancePanel.getByRole('spinbutton', {name: 'Всего одновременно', exact: true}).fill('3');
        await performancePanel.getByRole('spinbutton', {name: 'Изображения', exact: true}).fill('2');
        await performancePanel.getByRole('spinbutton', {name: 'Архивы', exact: true}).fill('1');
        await performancePanel.getByRole('spinbutton', {name: 'Конвертация', exact: true}).fill('1');
        await runBenchmark.click();
        await performancePanel.getByRole('button', {name: 'Остановить', exact: true}).waitFor();
        assert.deepEqual(benchmarkOptions, {sourceId: 'browser-fixture', mode: 'custom', limits: {total: 3, images: 2, reviews: 1, conversions: 1}});
        await performancePanel.getByText(/Проверка своих значений.*40%/).waitFor();
        assert(!(await performancePanel.innerText()).replace(/\s+/g, ' ').includes('CPU сейчас, ядер: —'), 'CPU is computed from successive counter samples');
        const profileLabels = await performancePanel.locator('.performance-profile').evaluateAll(nodes => nodes.map(node => {
            const frame = node.getBoundingClientRect(), label = node.querySelector('strong').getBoundingClientRect();
            const padding = parseFloat(getComputedStyle(node).paddingRight) || 0;
            return {name: node.querySelector('strong').textContent, labelRight: label.right, contentRight: frame.right - padding};
        }));
        assert(profileLabels.every(label => label.labelRight <= label.contentRight + 1), 'Profile titles must stay inside their card: ' + JSON.stringify(profileLabels));
        assert(await performancePanel.getByRole('button', {name: /^Свои значения/}).isDisabled(), 'A running benchmark locks the selected profile');
        await performancePanel.screenshot({path: path.join(directory, 'performance-custom-run.png')});
        await performancePanel.getByRole('button', {name: 'Остановить', exact: true}).click();
        await runBenchmark.waitFor(); assert.equal(benchmarkState, 'cancelled');
        await page.getByRole('button', {name: /^Отправка книг/}).click();
        await page.getByRole('combobox', {name: 'IP-семейство Telegram', exact: true}).click();
        await page.getByRole('option', {name: 'Только IPv6', exact: true}).click();
        const deliverySettings = page.getByRole('button', {name: /^Отправка книг/}).locator('..');
        const telegramSettings = deliverySettings.locator('.admin-mail-section').first();
        await telegramSettings.getByText(/HTTPS_PROXY, ALL_PROXY и NO_PROXY/).waitFor();
        const route = telegramSettings.getByRole('combobox', {name:'Маршрут Telegram',exact:true});
        await route.click(); await page.getByRole('option', {name:'Свой прокси',exact:true}).click();
        await telegramSettings.getByRole('combobox', {name:'Протокол прокси',exact:true}).click();
        await page.getByRole('option', {name:'SOCKS5 (DNS через прокси)',exact:true}).click();
        await telegramSettings.getByRole('textbox', {name:'Адрес прокси',exact:true}).fill('proxy.example.invalid');
        await telegramSettings.getByRole('spinbutton', {name:'Порт прокси',exact:true}).fill('1080');
        await telegramSettings.getByRole('textbox', {name:'Пользователь прокси',exact:true}).fill('fixture-user');
        const proxyPassword = telegramSettings.getByLabel('Пароль прокси', {exact:true});
        await proxyPassword.fill('client-proxy-browser-fixture');
        const testTelegram = telegramSettings.getByRole('button', {name:'Проверить',exact:true});
        await testTelegram.click();
        await page.locator('.app-notification--success').getByText('Подключение к Telegram проверено', {exact:true}).waitFor();
        assert((await page.locator('.app-notification--success').innerText()).includes('@fixture_bot'));
        assert.equal(integrationUpdates.at(-1).telegramProxyMode,'custom');
        assert.equal(integrationUpdates.at(-1).telegramProxyProtocol,'socks5h');
        assert.equal(integrationUpdates.at(-1).telegramProxyHost,'proxy.example.invalid');
        assert.equal(integrationUpdates.at(-1).telegramProxyPort,1080);
        assert.equal(integrationUpdates.at(-1).telegramIpFamily,'6');
        assert.equal(await proxyPassword.inputValue(),'__KEEP__');
        assert(integrationReplies.every(reply => !JSON.stringify(reply).includes('client-proxy-browser-fixture')), 'Admin replies never reveal the saved proxy password');
        assert(await page.evaluate(() => !JSON.stringify(localStorage).includes('client-proxy-browser-fixture')), 'Proxy password is not persisted in browser storage');
        await telegramSettings.getByText(/IPv4\/IPv6 применяется к соединению сервера с прокси/).waitFor();
        await page.waitForFunction(() => !document.querySelector('.q-notification'), undefined, {timeout:15000});
        await proxyPassword.scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(directory,'telegram-proxy-custom-1280.png')});
        await page.setViewportSize({width:320,height:900});
        await proxyPassword.scrollIntoViewIfNeeded();
        const proxyGeometry = await telegramSettings.evaluate(node => ({width:innerWidth, client:node.clientWidth, scroll:node.scrollWidth,
            fields:[...node.querySelectorAll('.q-field')].map(field => ({left:field.getBoundingClientRect().left,right:field.getBoundingClientRect().right}))}));
        assert(proxyGeometry.scroll <= proxyGeometry.client + 1 && proxyGeometry.fields.every(field => field.left >= 0 && field.right <= proxyGeometry.width),
            'Proxy fields fit inside the dialog at320px: ' + JSON.stringify(proxyGeometry));
        await page.screenshot({path:path.join(directory,'telegram-proxy-custom-320.png')});
        await page.setViewportSize({width:1280,height:900});
        await telegramSettings.getByRole('textbox', {name:'Адрес прокси',exact:true}).fill('https://invalid.example/path');
        await telegramSettings.getByRole('spinbutton', {name:'Порт прокси',exact:true}).fill('99999');
        for (const name of ['Прямое соединение','Прокси окружения сервера']) {
            await route.scrollIntoViewIfNeeded();await pause(200);
            await route.click(); await page.getByRole('option', {name,exact:true}).click();
            await testTelegram.click();
            for(let i=0;i<30 && telegramProbeModes.length < (name === 'Прямое соединение' ? 2 : 3);i++) await pause(100);
            assert(!Object.keys(integrationUpdates.at(-1)).some(key => key.startsWith('telegramProxy') && key !== 'telegramProxyMode'),
                'Hidden custom fields cannot block switching to a direct/environment route');
        }
        assert.deepEqual(telegramProbeModes,['custom','direct','system'], 'Every connection test follows the mode saved through the real admin API');
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.locator('.q-dialog').waitFor({state: 'hidden'});
        await page.reload();
        await page.locator('.profile-controls .profile-logout').waitFor();
        await toolbar.getByRole('button', {name: 'Настройки', exact: true}).click();
        await page.getByRole('button', {name: /^Отправка книг/}).click();
        await deliverySettings.getByText('Только IPv6', {exact: true}).waitFor();
        await telegramSettings.getByText('Прокси окружения сервера', {exact:true}).waitFor();
        assert.equal(await telegramSettings.getByLabel('Пароль прокси', {exact:true}).count(),0);
        await page.screenshot({path:path.join(directory, 'telegram-connection.png')});
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.screenshot({path: path.join(directory, 'toolbar-dark-1280.png')});
        await page.setViewportSize({width: 390, height: 900}); await pause(350);
        await page.screenshot({path: path.join(directory, 'toolbar-dark-390.png')});
        await page.setViewportSize({width: 1280, height: 900}); await pause(350);
        const oldToken = await page.evaluate(() => JSON.parse(localStorage.getItem('inpx-web-profile-session')).profileAccessToken);
        assert(oldToken);
        await page.locator('.user-profiles-btn').click();
        const dialogLogout = page.locator('.profile-session-actions .profile-logout');
        await dialogLogout.waitFor({state: 'visible'});
        await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), dialogLogout.click()]);
        await page.locator('.profile-controls').waitFor();
        assert.equal(await page.locator('.profile-controls .profile-logout').count(), 0);
        for (const name of ['Избранные авторы и серии', 'Сохранить поиск как полку'])
            assert.equal(await toolbar.getByRole('button', {name, exact: true}).count(), 0, 'Private actions disappear after logout');
        await toolbar.getByRole('button', {name: 'Настройки', exact: true}).click();
        assert.equal(await page.getByRole('button', {name: /Администрирование/}).count(), 0, 'Guests cannot see administration');
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('inpx-web-profile-session') || '{}').profileAccessToken || ''), '');
        const response = await page.evaluate(token => new Promise((resolve, reject) => {
            const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
            const timer = setTimeout(() => {socket.close(); reject(new Error('Logout authorization check timed out'));}, 5000);
            socket.onopen = () => socket.send(JSON.stringify({action: 'get-admin-dashboard', userId: 'admin', profileAccessToken: token, requestId: 'after-logout'}));
            socket.onmessage = event => {const body = JSON.parse(event.data); if (!body._rok) {clearTimeout(timer); socket.close(); resolve(body);}};
        }), oldToken);
        assert.equal(response.error, 'need_profile_login');
        await page.reload(); await page.locator('.profile-controls').waitFor();
        assert.equal(await page.locator('.profile-controls .profile-logout').count(), 0, 'Reload cannot restore an admin session');
        await login();
        await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), page.locator('.profile-controls .profile-logout').click()]);
        await page.locator('.profile-controls').waitFor();
        assert.equal(await page.locator('.profile-controls .profile-logout').count(), 0);
        assert.deepEqual(errors, []);
        console.log(`Profile UI: logout, token revocation, guest restrictions, responsive toolbar, custom performance form/validation/transport/cancel with synthetic metrics, shelf/favorites actions and tasks passed; screenshots: ${directory}`);
    } catch (error) {
        const page = browser?.contexts().flatMap(context => context.pages())[0];
        if (page) {
            await page.screenshot({path:path.join(directory, 'failure.png')}).catch(() => {});
            await fs.writeFile(path.join(directory, 'failure.html'), await page.content()).catch(() => {});
        }
        console.error(`Artifacts: ${directory}\n${output}`); throw error;
    }
    finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
