// Optional browser check: profile sessions, catalog shortcuts and administrator tasks.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const {spawn} = require('child_process');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function currentTotp(secret, stepOffset = 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...secret].map(letter => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    return require('../server/core/ProfileTotp').hotp(key, Math.floor(Date.now() / 30000) + stepOffset);
}

async function startHttpsProxy(port) {
    const tls = path.join(__dirname, 'fixtures', 'tls');
    const forward = req => http.request({hostname:'127.0.0.1', port, method:req.method, path:req.url,
        headers:{...req.headers, 'x-forwarded-proto':'https', 'x-forwarded-host':req.headers.host}});
    const proxy = https.createServer({key:await fs.readFile(path.join(tls, 'localhost-key.pem')),
        cert:await fs.readFile(path.join(tls, 'localhost-cert.pem'))}, (req, res) => {
        const upstream = forward(req);
        upstream.on('response', reply => {res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);});
        upstream.on('error', () => {res.writeHead(502); res.end();});
        req.pipe(upstream);
    });
    proxy.on('upgrade', (req, socket, head) => {
        const upstream = forward(req);
        upstream.on('upgrade', (reply, peer, buffer) => {
            const headers = Object.entries(reply.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
            if (buffer.length) socket.write(buffer);
            if (head.length) peer.write(head);
            socket.pipe(peer).pipe(socket);
            socket.on('close', () => peer.destroy());
            peer.on('error', () => socket.destroy());
        });
        upstream.on('response', reply => socket.end(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`));
        upstream.on('error', () => socket.destroy());
        upstream.end();
    });
    await new Promise((resolve, reject) => {proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);});
    return proxy;
}

function profileRequest(page, payload, session) {
    return page.evaluate(async({payload, session}) => {
        const stored = JSON.parse(localStorage.getItem('inpx-web-profile-session') || '{}');
        const {userId = stored.currentUserId, profileAccessToken = stored.profileAccessToken} = session || {};
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
        const request = (data, requestId) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {socket.removeEventListener('message', receive); reject(new Error('Profile fixture API timeout'));}, 10000);
            function receive(event) {
                const response = JSON.parse(event.data);
                if (response.requestId !== requestId || response._rok) return;
                clearTimeout(timer);
                socket.removeEventListener('message', receive);
                resolve(response);
            }
            socket.addEventListener('message', receive);
            socket.send(JSON.stringify({userId, profileAccessToken, ...data, requestId}));
        });
        try {
            await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
            const {csrfToken} = await request({action:'get-config'}, 'fixture-config');
            return await request({...payload, csrfToken}, 'fixture-profile');
        } finally {socket.close();}
    }, {payload, session});
}

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-toolbar-'));
    await fs.ensureDir(directory);
    let browser, child, proxy, output = '';
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
                INPX_ADMIN_PASSWORD: 'profile-toolbar-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_METRICS_ENABLED: 'false',
                INPX_TRUST_PROXY:'true', INPX_TRUSTED_PROXY_CIDRS:'127.0.0.1/32'}});
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
        const checkAutofillColors = async selector => {
            const session = await page.context().newCDPSession(page);
            try {
                await session.send('DOM.enable');
                await session.send('CSS.enable');
                const {root} = await session.send('DOM.getDocument');
                const {nodeId} = await session.send('DOM.querySelector', {nodeId: root.nodeId, selector});
                assert(nodeId, `Missing autofill field ${selector}`);
                const field = page.locator(selector);
                const normal = await field.evaluate(input => ({
                    background: getComputedStyle(input.closest('.q-field__control')).backgroundColor,
                    text: getComputedStyle(input).color,
                }));
                await session.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: ['autofill']});
                const colors = await field.evaluate(input => {
                    const style = getComputedStyle(input);
                    return {shadow: style.boxShadow, text: style.webkitTextFillColor, caret: style.caretColor,
                        label: getComputedStyle(input.previousElementSibling).zIndex};
                });
                await session.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: []});
                assert(colors.shadow.includes(normal.background) && colors.shadow.includes('inset'),
                    `Autofill background must match the field surface of ${selector}`);
                assert.equal(colors.text, normal.text);
                assert.equal(colors.caret, normal.text);
                assert.equal(colors.label, '1');
            } finally {await session.detach();}
        };
        const openProfile = async(target) => {
            if (!target.url().endsWith('/#/profile'))
                await target.getByRole('link', {name: 'Профиль', exact: true}).click();
            await target.getByRole('region', {name: 'Текущий профиль'}).waitFor();
        };
        const profileLogin = target => target.getByRole('region', {name: 'Текущий профиль'}).getByRole('button', {name: 'Войти', exact: true});
        const profileLogout = target => target.locator('.profile-bottom .profile-logout');
        const openProfiles = async(target) => {
            await openProfile(target);
            await target.getByRole('button', {name: /^Профили и личные настройки/}).click();
        };
        const openSettings = () => page.locator('.library-shell__header').getByRole('button', {name: 'Настройки библиотеки', exact: true}).click();
        const login = async({autofill = false} = {}) => {
            await openProfile(page);
            await profileLogin(page).click();
            const dialog = page.getByRole('dialog');
            const username = dialog.getByRole('textbox', {name: 'Логин', exact: true});
            const password = dialog.getByRole('textbox', {name: 'Пароль', exact: true});
            const submit = dialog.getByRole('button', {name: 'OK', exact: true});
            await dialog.locator('input:focus').waitFor();
            for (const name of ['username', 'password']) await checkAutofillColors(`.credentials-form input[name="${name}"]`);
            if (autofill) {
                assert.deepEqual(await dialog.locator('input').evaluateAll(inputs => inputs.map(input => [input.name, input.autocomplete, Boolean(input.form)])), [
                    ['username', 'section-profile username', true],
                    ['password', 'section-profile current-password', true],
                ]);
                await username.fill('admin');
                assert.equal(await dialog.getByText('Пароль не должен быть пустым').isVisible(), false);
                await submit.click();
                await dialog.getByText('Пароль не должен быть пустым', {exact: true}).waitFor();
                await password.focus();
                await password.evaluate(input => {input.value = 'profile-toolbar-test';});
                await password.press('Enter');
            } else {
                await username.fill('admin');
                await password.focus();
                await password.evaluate(input => {input.value = 'profile-toolbar-test';});
                await submit.click();
            }
            await profileLogout(page).waitFor({state: 'visible'});
        };
        await login({autofill: true});
        await page.getByRole('link', {name: 'Каталог', exact: true}).click();
        const searchPanel = page.getByRole('region', {name: 'Поиск книг'});
        const saveSearch = searchPanel.getByRole('button', {name: 'Сохранить поиск', exact: true});
        for (const width of [1280, 760, 514, 390, 320]) {
            await page.setViewportSize({width, height: 900});
            await saveSearch.waitFor();
            assert(await searchPanel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Search actions must fit at width ' + width);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No document overflow at width ' + width);
            await page.screenshot({path: path.join(directory, 'catalog-' + width + '.png')});
        }
        await page.setViewportSize({width: 1280, height: 900});
        await saveSearch.click();
        await page.getByRole('button', {name: 'Отмена', exact: true}).click();
        await openProfile(page);
        await page.getByRole('button', {name: /^Избранные авторы и серии/}).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('button', {name: 'Закрыть избранное', exact: true}).click();
        await openSettings();
        await page.getByRole('checkbox', {name: 'Ночная тема', exact: true}).click();
        await page.getByRole('button', {name: /Администрирование/}).click();
        const activity = page.getByRole('region', {name: 'Активность пользователей', exact: true});
        await activity.getByText('С последнего запуска сервера', {exact: true}).waitFor();
        const downloads = activity.locator('.admin-stat').filter({hasText: 'Скачано книг'}).locator('.admin-stat-value');
        assert.equal(await downloads.innerText(), '0');
        await activity.getByText('По профилям', {exact: true}).click();
        const profile = activity.getByRole('row', {name: /^[a-f0-9]{12} 1 0$/});
        await profile.waitFor();
        const catalog = await fetch(base + '/ebook?q=Packaged');
        const encodedUid = (await catalog.text()).match(/[?&](?:amp;)?uid=([^"&]+)/)?.[1];
        assert(encodedUid, 'The fixture catalog has a downloadable book');
        const downloadUrl = base + '/book/by-uid?' + new URLSearchParams({uid: decodeURIComponent(encodedUid), format: 'raw'});
        const profileDownload = await page.request.get(downloadUrl);
        const guestDownload = await fetch(downloadUrl);
        assert.match(await profileDownload.text(), /<FictionBook/);
        assert.match(await guestDownload.text(), /<FictionBook/);
        await activity.getByRole('row', {name: /^[a-f0-9]{12} 1 1$/}).waitFor();
        await activity.getByRole('row', {name: 'Гости 0 1', exact: true}).waitFor();
        assert.equal(await downloads.innerText(), '2', 'The panel refreshes live with metrics export and file logging disabled');
        await activity.getByText('По профилям', {exact: true}).click();
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
        await profileLogout(page).waitFor();
        await openSettings();
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
        await openProfiles(page);
        const dialogLogout = page.locator('.profile-session-actions .profile-logout');
        await dialogLogout.waitFor({state: 'visible'});
        await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), dialogLogout.click()]);
        await openProfile(page);
        assert.equal(await profileLogout(page).count(), 0);
        assert.equal(await page.getByRole('button', {name: /^Избранные авторы и серии/}).count(), 0);
        await page.getByRole('link', {name: 'Каталог', exact: true}).click();
        await searchPanel.waitFor();
        assert.equal(await saveSearch.count(), 0, 'Guests cannot save a search as a private shelf');
        await openProfile(page);
        await openSettings();
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
        await page.reload(); await openProfile(page);
        assert.equal(await profileLogout(page).count(), 0, 'Reload cannot restore an admin session');
        await login();

        const reader = {name:'Профиль для восстановления', login:'otp-recovery-reader', password:'recovery-reader-fixture', opdsEnabled:true};
        const created = await profileRequest(page, {action:'create-user-profile', profile:reader});
        assert(created.user?.id, created.error);
        const readerPage = await browser.newPage({serviceWorkers:'block'});
        await readerPage.goto(base + '/#/books?title=Packaged&lang=en');
        await openProfile(readerPage);
        const readerRequest = (payload, session) => profileRequest(readerPage, payload, session);
        const loginReader = otp => readerRequest({action:'login-user-profile', login:reader.login, password:reader.password, otp});
        const readerTotp = (operation, session, code) => readerRequest({action:'profile-totp', operation, payload:{password:reader.password, code}}, session);
        const enrollReader = async session => {
            assert(session.profileAccessToken, session.error);
            const setup = await readerTotp('start', session);
            assert.match(setup.secret || '', /^[A-Z2-7]{32}$/);
            const enabled = await readerTotp('enable', session, currentTotp(setup.secret));
            assert.equal(enabled.otpEnabled, true, enabled.error);
            assert.equal((await loginReader()).errorCode, 'need_profile_otp');
            return enabled.recoveryCodes;
        };
        const resetButton = page.getByRole('button', {name:`Сбросить OTP: ${reader.name}`, exact:true});
        const resetDialog = page.getByRole('dialog').filter({hasText:'Сброс двухфакторной авторизации'});
        const resetReader = async otp => {
            await openProfiles(page);
            await resetButton.click();
            await resetDialog.waitFor();
            assert.equal(await page.locator('body.body--dark').count(), 1);
            await checkAutofillColors('.profile-otp-reset input[type="password"]');
            await resetDialog.getByLabel('Пароль администратора', {exact:true}).fill('profile-toolbar-test');
            const resetOtp = resetDialog.getByLabel('Код из приложения или резервный код', {exact:true});
            const submitReset = resetDialog.getByRole('button', {name:'Сбросить OTP', exact:true});
            if (otp) {
                await submitReset.click();
                await resetDialog.getByRole('alert').filter({hasText:'Введите пароль и код администратора.'}).waitFor();
                await resetOtp.fill(otp);
            } else assert.equal(await resetOtp.count(), 0, 'Administrator without OTP should only confirm the password');
            await submitReset.click();
            await resetDialog.waitFor({state:'hidden'});
            await resetButton.waitFor({state:'hidden'});
            await page.getByRole('button', {name:'Закрыть окно', exact:true}).click();
        };
        const assertReaderSession = async(session, active) => {
            assert(session.profileAccessToken, session.error);
            const result = await readerRequest({action:'get-user-reading-library'}, session);
            if (active) assert(Array.isArray(result.items), result.error);
            else assert.equal(result.errorCode, 'need_profile_login', 'OTP reset must revoke the reader session');
        };

        let readerSession = await loginReader();
        await enrollReader(readerSession);
        await assertReaderSession(readerSession, true);
        await resetReader();
        await assertReaderSession(readerSession, false);
        readerSession = await loginReader();
        await assertReaderSession(readerSession, true);
        const readerRecovery = await enrollReader(readerSession);
        const anotherReaderSession = await loginReader(readerRecovery[0]);
        await assertReaderSession(anotherReaderSession, true);

        const testBook = (await profileRequest(page, {action:'bookSearch', query:{title:'=Packaged smoke book', ext:'fb2', limit:1}})).found?.[0];
        assert(testBook?._uid);
        const bookUid = testBook._uid;
        const list = (await profileRequest(page, {action:'create-reading-list', name:'Проверочный список'})).list;
        assert(list?.id);
        assert.equal((await profileRequest(page, {action:'update-reading-list-book', listId:list.id, bookUid, enabled:true})).error, undefined);
        assert.equal((await profileRequest(page, {action:'update-reader-progress', bookUid, progress:{percent:.29}})).error, undefined);
        await openProfiles(page);
        const current = page.locator('.profile-card--current');
        const noOverflow = async locator => assert(await locator.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.setViewportSize({width:320,height:900});
        await current.getByRole('button', {name:'Развернуть',exact:true}).click();
        const readingRow = current.locator('.profile-reading-row');
        await readingRow.getByRole('button', {name:'Читать',exact:true}).waitFor();
        await noOverflow(readingRow);
        await readingRow.screenshot({path:path.join(directory,'profile-reading-320.png')});
        await current.getByRole('button', {name:'Списки',exact:true}).click();
        await current.getByText('Проверочный список', {exact:true}).waitFor();
        await current.getByRole('button', {name:'Развернуть',exact:true}).click();
        const listActions = current.locator('.profile-reading-actions button');
        const buttonTops = await listActions.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
        assert.equal(buttonTops.length, 3);
        assert(Math.max(...buttonTops) - Math.min(...buttonTops) <= 1, 'Mobile list actions stay in one row');
        const listRow = current.locator('.profile-list-preview-item');
        await listRow.getByRole('checkbox', {name:'Прочитано',exact:true}).waitFor();
        await listRow.getByRole('checkbox', {name:'Прочитано',exact:true}).click();
        await listRow.locator('[role="checkbox"][aria-checked="true"]').waitFor();
        await noOverflow(listRow);
        await current.locator('.reading-progress-box').screenshot({path:path.join(directory,'profile-lists-320.png')});
        await page.setViewportSize({width:1280,height:900});
        await current.locator('.reading-progress-box').screenshot({path:path.join(directory,'profile-lists-1280.png')});
        await page.setViewportSize({width:320,height:900});
        await current.getByRole('button', {name: 'Настройки', exact: true}).click();
        assert.equal(await current.locator('.profile-settings-section').count(), 7);
        await noOverflow(current.locator('.profile-settings'));
        const kosync = current.getByRole('region', {name:'Синхронизация с KOReader',exact:true});
        await kosync.getByRole('button', {name:'Подключить KOReader',exact:true}).click();
        const useWebPassword = kosync.getByRole('checkbox', {name:'Использовать пароль INPX Web',exact:true});
        const saveKoSync = kosync.getByRole('button', {name:'Сохранить пароль',exact:true});
        assert.equal(await useWebPassword.getAttribute('aria-checked'), 'true');
        await kosync.screenshot({path:path.join(directory,'profile-kosync-web-320.png')});
        await kosync.getByLabel('Пароль INPX Web', {exact:true}).fill('profile-toolbar-test');
        await saveKoSync.click();
        await kosync.getByText('Пароль KOReader сохранён.', {exact:true}).waitFor();
        await kosync.getByRole('button', {name:'Изменить пароль',exact:true}).click();
        assert.equal(await useWebPassword.getAttribute('aria-checked'), 'true');
        await useWebPassword.click();
        const customPassword = kosync.getByLabel('Новый пароль KOReader', {exact:true});
        await customPassword.fill('short');
        assert(await saveKoSync.isDisabled());
        await customPassword.fill('KoSix!');
        await saveKoSync.click();
        await kosync.getByText('Пароль KOReader сохранён.', {exact:true}).waitFor();
        assert.equal(await customPassword.count(), 0);
        await kosync.screenshot({path:path.join(directory,'profile-kosync-320.png')});
        await page.setViewportSize({width:1280,height:900});
        await current.getByRole('heading', {name:'Профиль',exact:true}).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(directory,'profile-settings-1280.png')});
        const otpSection = page.locator('.profiles-dialog').getByRole('region', {name: 'Двухфакторная авторизация', exact: true});
        await otpSection.getByRole('button', {name: 'Двухфакторная авторизация', exact: true}).click();
        await otpSection.getByRole('button', {name: 'Настроить OTP', exact: true}).click();
        const otpPassword = otpSection.getByLabel('Текущий пароль профиля');
        await otpPassword.focus();
        await otpPassword.evaluate(input => {input.value = 'profile-toolbar-test'; input.blur();});
        await otpSection.getByRole('button', {name: 'Получить QR-код', exact: true}).click();
        await otpSection.getByRole('img', {name: 'QR-код настройки аутентификатора', exact: true}).waitFor();
        const setupSecret = await otpSection.locator('form code').innerText();
        assert.equal(await page.locator('body.body--dark').count(), 1);
        await checkAutofillColors('.profile-totp__form input[type="password"]');
        await otpPassword.fill('profile-toolbar-test');
        await otpSection.getByLabel('Код из приложения', {exact: true}).fill(currentTotp(setupSecret));
        await otpSection.getByRole('button', {name: 'Включить OTP', exact: true}).click();
        const codes = otpSection.locator('li code');
        await codes.first().waitFor();
        const recovery = await codes.first().innerText();
        const adminResetRecovery = await codes.nth(1).innerText();
        const adminRequireRecovery = await codes.nth(2).innerText();
        const adminRemoveRequirementRecovery = await codes.nth(3).innerText();
        const trustPolicyRecovery = await codes.nth(4).innerText();
        const forceOtpRecovery = await codes.nth(5).innerText();
        const allowOptionalOtpRecovery = await codes.nth(6).innerText();
        assert(await page.evaluate(values => !Object.values(localStorage).some(value => values.some(secret => value.includes(secret))), [setupSecret, recovery]));
        await otpSection.getByRole('button', {name: 'Коды сохранены', exact: true}).click();
        await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), page.locator('.profile-session-actions .profile-logout').click()]);
        await openProfile(page);
        await profileLogin(page).click();
        const otpLogin = page.getByRole('dialog');
        await otpLogin.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
        await otpLogin.getByLabel('Пароль', {exact: true}).fill('profile-toolbar-test');
        await otpLogin.getByRole('button', {name: 'OK', exact: true}).click();
        const otpCode = otpLogin.getByLabel('Код из приложения или резервный код', {exact: true});
        await otpCode.waitFor();
        assert.equal(await profileLogout(page).count(), 0);
        await otpCode.fill(recovery);
        await otpLogin.getByRole('button', {name: 'OK', exact: true}).click();
        await profileLogout(page).waitFor();
        await resetReader(adminResetRecovery);
        await assertReaderSession(readerSession, false);
        await assertReaderSession(anotherReaderSession, false);
        const unprotectedSession = await loginReader();
        await assertReaderSession(unprotectedSession, true);

        const updatePolicy = async(label, code, expected) => {
            await openProfiles(page);
            await page.getByRole('button', {name:`${label}: ${reader.name}`, exact:true}).click();
            const dialog = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:label, exact:true})});
            const passwordField = dialog.getByLabel('Пароль администратора', {exact:true});
            await passwordField.focus();
            await passwordField.evaluate(input => {input.value = 'profile-toolbar-test'; input.blur();});
            await dialog.getByLabel('Код из приложения или резервный код', {exact:true}).fill(code);
            await dialog.getByRole('button', {name:label, exact:true}).click();
            await dialog.waitFor({state:'hidden'});
            await page.getByRole('button', {name:`${expected}: ${reader.name}`, exact:true}).waitFor();
            await page.getByRole('button', {name:'Закрыть окно', exact:true}).click();
        };
        await updatePolicy('Требовать OTP', adminRequireRecovery, 'Отменить требование OTP');
        await assertReaderSession(unprotectedSession, false);
        assert.equal((await loginReader()).errorCode, 'need_profile_otp_setup');

        const updateAuthPolicy = async(code, change, expected) => {
            await openProfiles(page);
            await page.getByRole('button', {name:'Настроить безопасность входа',exact:true}).click();
            const dialog = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:'Безопасность входа',exact:true})});
            await change(dialog);
            await dialog.getByLabel('Пароль администратора', {exact:true}).fill('profile-toolbar-test');
            await dialog.getByLabel('Код из приложения или резервный код', {exact:true}).fill(code);
            await dialog.getByRole('button', {name:'Сохранить',exact:true}).click();
            await dialog.waitFor({state:'hidden'});
            await page.locator('.profile-auth-policy').getByText(expected, {exact:true}).waitFor();
            await page.getByRole('button', {name:'Закрыть окно',exact:true}).click();
        };
        await updateAuthPolicy(trustPolicyRecovery, async dialog => {
            const switchTrust = dialog.getByRole('switch', {name:'Разрешить доверенные браузеры по HTTPS', exact:true});
            assert.equal(await switchTrust.getAttribute('aria-checked'), 'true');
            const days = dialog.getByLabel('Срок доверия в днях', {exact:true});
            assert.equal(await days.inputValue(), '30');
            await days.fill('180');
        }, 'Доверие к браузерам действует 180 дн.');

        proxy = await startHttpsProxy(port);
        const secureBase = `https://127.0.0.1:${proxy.address().port}`;
        const secureContext = await browser.newContext({ignoreHTTPSErrors:true, serviceWorkers:'block', viewport:{width:1280,height:900}});
        const securePage = await secureContext.newPage();
        const submitSecureCredentials = async() => {
            const dialog = securePage.getByRole('dialog');
            await dialog.getByLabel('Логин', {exact:true}).fill(reader.login);
            await dialog.getByLabel('Пароль', {exact:true}).fill(reader.password);
            await dialog.getByRole('button', {name:'OK',exact:true}).click();
        };
        const secureLogin = async() => {
            await openProfile(securePage);
            await profileLogin(securePage).click();
            await submitSecureCredentials();
        };
        const signOutSecure = async(required = false) => {
            await Promise.all([securePage.waitForNavigation({waitUntil:'domcontentloaded'}),
                profileLogout(securePage).click()]);
            if (required) await securePage.getByRole('dialog').getByLabel('Пароль', {exact:true}).waitFor();
            else await profileLogin(securePage).waitFor();
        };
        await securePage.goto(secureBase + '/#/books?title=Packaged&lang=en');
        await secureLogin();
        const setupDialog = securePage.getByRole('dialog').filter({hasText:'Настройка двухфакторного входа'});
        await setupDialog.getByRole('img', {name:'QR-код настройки аутентификатора'}).waitFor();
        const requiredSecret = await setupDialog.locator('code').innerText();
        assert.match(requiredSecret, /^[A-Z2-7]{32}$/);
        assert.equal(await profileLogout(securePage).count(), 0);
        await setupDialog.getByLabel('Код из приложения', {exact:true}).fill('incorrect');
        await setupDialog.getByRole('button', {name:'Включить OTP',exact:true}).click();
        await setupDialog.getByText('Не удалось подтвердить код. Проверьте код из приложения.').waitFor();
        await setupDialog.getByLabel('Код из приложения', {exact:true}).fill(currentTotp(requiredSecret, -1));
        await setupDialog.getByRole('button', {name:'Включить OTP',exact:true}).click();
        const recoveryDialog = securePage.getByRole('dialog').filter({hasText:'Сохраните резервные коды'});
        await recoveryDialog.locator('li code').first().waitFor();
        const revokeTrustCode = await recoveryDialog.locator('li code').first().innerText();
        await recoveryDialog.getByRole('button', {name:'Коды сохранены'}).click();
        await profileLogout(securePage).waitFor();
        await openProfiles(securePage);
        await securePage.locator('.profile-card--current').getByRole('button', {name:'Настройки',exact:true}).click();
        const secureOtp = securePage.locator('.profiles-dialog').getByRole('region', {name: 'Двухфакторная авторизация', exact: true});
        await secureOtp.getByRole('button', {name:'Двухфакторная авторизация',exact:true}).click();
        await secureOtp.getByText('Для этого профиля администратор требует двухфакторный вход.').waitFor();
        assert.equal(await secureOtp.getByRole('button', {name:'Отключить OTP',exact:true}).count(), 0);
        await securePage.getByRole('button', {name:'Закрыть окно',exact:true}).click();
        await updatePolicy('Отменить требование OTP', adminRemoveRequirementRecovery, 'Требовать OTP');
        await signOutSecure();
        await secureLogin();
        const secureOtpDialog = securePage.getByRole('dialog').filter({hasText:'Двухфакторный вход'});
        const remember = secureOtpDialog.getByRole('checkbox', {name:'Запомнить это устройство (180 дн.)',exact:true});
        await remember.waitFor();
        assert.equal(await remember.getAttribute('aria-checked'), 'false');
        await remember.click();
        await secureOtpDialog.getByLabel('Код из приложения или резервный код', {exact:true}).fill(currentTotp(requiredSecret));
        await secureOtpDialog.getByRole('button', {name:'OK',exact:true}).click();
        await profileLogout(securePage).waitFor();
        const trustCookie = (await secureContext.cookies(secureBase)).find(cookie => cookie.name === 'inpx_web_trusted_device');
        assert(trustCookie?.httpOnly && trustCookie.secure && trustCookie.sameSite === 'Strict');
        const trustRemaining = trustCookie.expires - Math.floor(Date.now() / 1000);
        assert(Math.abs(trustRemaining - 180 * 86400) < 60, 'Browser trust must use the administrator’s configured duration');
        await signOutSecure();
        await secureLogin();
        await profileLogout(securePage).waitFor();
        assert.equal(await remember.count(), 0);

        await openProfiles(securePage);
        await securePage.locator('.profile-card--current').getByRole('button', {name:'Настройки',exact:true}).click();
        await secureOtp.getByRole('button', {name:'Двухфакторная авторизация',exact:true}).click();
        await secureOtp.getByRole('button', {name:'Отозвать доверие к устройствам (1)',exact:true}).click();
        await secureOtp.getByLabel('Текущий пароль профиля').fill(reader.password);
        await secureOtp.getByLabel('Код из приложения или резервный код', {exact:true}).fill(revokeTrustCode);
        await secureOtp.getByRole('button', {name:'Отозвать доверие ко всем устройствам',exact:true}).click();
        await secureOtp.getByRole('button', {name:'Отключить OTP',exact:true}).waitFor();
        await securePage.getByRole('button', {name:'Закрыть окно',exact:true}).click();
        await signOutSecure();
        await secureLogin();
        await remember.waitFor();
        await updateAuthPolicy(forceOtpRecovery, async dialog => {
            await dialog.getByLabel('Требовать пароль и OTP для всех', {exact:true}).click();
            const switchTrust = dialog.getByRole('switch', {name:'Разрешить доверенные браузеры по HTTPS', exact:true});
            assert.equal(await switchTrust.getAttribute('aria-checked'), 'true');
            assert.equal(await switchTrust.isEnabled(), true);
        }, 'OTP обязателен для всех профилей.');
        const guest = await browser.newContext();
        const guestPage = await guest.newPage();
        await guestPage.goto(base + '/#/books');
        await guestPage.getByRole('dialog').getByLabel('Пароль', {exact:true}).waitFor();
        assert.equal((await profileRequest(guestPage, {action:'get-books'})).errorCode, 'need_profile_login');
        await guest.close();
        await securePage.reload();
        await submitSecureCredentials();
        await remember.click();
        await secureOtpDialog.getByLabel('Код из приложения или резервный код', {exact:true}).fill(currentTotp(requiredSecret, 1));
        await secureOtpDialog.getByRole('button', {name:'OK',exact:true}).click();
        await profileLogout(securePage).waitFor();
        await signOutSecure(true);
        await submitSecureCredentials();
        await profileLogout(securePage).waitFor();
        assert.equal(await remember.count(), 0);
        await updateAuthPolicy(allowOptionalOtpRecovery, async dialog => {
            await dialog.getByLabel('Требовать пароль и OTP для всех', {exact:true}).click();
        }, 'Доверие к браузерам действует 180 дн.');
        const liveReaderSession = await securePage.evaluate(() => {
            const stored = JSON.parse(localStorage.getItem('inpx-web-profile-session'));
            return {userId:stored.currentUserId, profileAccessToken:stored.profileAccessToken};
        });
        await openProfiles(page);
        const readerCard = page.locator('.profile-card').filter({has:page.getByText(reader.name, {exact:true})});
        const blockReader = readerCard.getByRole('button', {name:`Заблокировать профиль: ${reader.name}`,exact:true});
        const unblockReader = readerCard.getByRole('button', {name:`Разблокировать профиль: ${reader.name}`,exact:true});
        const confirmBlock = (text) => page.getByRole('dialog').filter({hasText:text}).getByRole('button', {name:'OK',exact:true});
        await blockReader.click();
        await confirmBlock('Его сеансы завершатся').click();
        await readerCard.getByText('Заблокирован', {exact:true}).waitFor();
        assert.equal(await readerCard.getByRole('button', {name:'Выбрать',exact:true}).count(), 0);
        await assertReaderSession(liveReaderSession, false);
        assert.equal((await loginReader()).errorCode, 'INPX_INVALID_PROFILE_CREDENTIALS');
        await unblockReader.click();
        await confirmBlock('Пользователь сможет войти снова').click();
        await blockReader.waitFor();
        assert.equal((await loginReader()).errorCode, 'need_profile_otp');
        await assertReaderSession(liveReaderSession, false);
        await page.getByRole('button', {name:'Закрыть окно',exact:true}).click();
        await secureContext.close();
        await readerPage.close();
        await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), profileLogout(page).click()]);
        await openProfile(page);
        assert.equal(await profileLogout(page).count(), 0);
        await page.goto(base + '/#/reader');
        await page.locator('.reader-home-theme').getByRole('button', {name:'Сепия', exact:true}).click();
        await page.locator('.reader-home-actions .reader-home-action-btn--primary').click();
        await page.locator('.std-dialog-card--reader .credentials-form input[name="password"]').waitFor();
        await checkAutofillColors('.std-dialog-card--reader .credentials-form input[name="password"]');
        assert.deepEqual(errors, []);
        console.log('Profile UI: OTP, HTTPS browser trust, block and unblock, session revocation, responsive catalog and profile actions, activity, performance, shelves and favorites passed.');
        console.log(`Screenshots: ${directory}`);
    } catch (error) {
        const page = browser?.contexts().flatMap(context => context.pages())[0];
        if (page) {
            await page.screenshot({path:path.join(directory, 'failure.png')}).catch(() => {});
            await fs.writeFile(path.join(directory, 'failure.html'), await page.content()).catch(() => {});
        }
        console.error(`Artifacts: ${directory}\n${output}`); throw error;
    }
    finally {if (browser) await browser.close(); if (proxy) proxy.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
