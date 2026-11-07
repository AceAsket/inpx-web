// Isolated browser regression: real profile cookies, background assets and IndexedDB.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {unusedPort} = require('./binary-smoke-test');
const {fixture} = require('./library-appearance-browser-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const password = 'rc13-profile-browser';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-rc13-profile-'));
    await fs.ensureDir(directory);
    let browser, child, page, output = '';
    try {
        const library = path.join(directory, 'library'); await fixture(library);
        const config = path.join(library, 'config.json');
        await fs.writeJson(config, {...await fs.readJson(config), adminPassword: password});
        const dataDir = path.join(directory, 'data'); await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${config}`, `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'],
            {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, INPX_TTS_ENABLED: 'false', INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
                INPX_ADMIN_PASSWORD: password, INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS: 'true', INPX_TELEGRAM_BOT_ENABLED: 'false'}});
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output = (output + data).slice(-16000);});
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const response = await fetch(base + '/ready'); ready = response.ok && (await response.json()).ready;} catch { /* Starting. */ }
            if (ready || child.exitCode !== null) break; await pause(500);
        }
        assert(ready, output);
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const context = await browser.newContext({viewport: {width: 1280, height: 900}});
        page = await context.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const api = async payload => page.evaluate(async payload => {
            const settings = JSON.parse(localStorage.getItem('vuex') || '{}').settings || {};
            const session = JSON.parse(localStorage.getItem('inpx-web-profile-session') || '{}');
            const auth = {...settings, ...session};
            const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
            await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
            let sequence = 0, csrfToken = '';
            const request = data => new Promise((resolve, reject) => {
                const requestId = `rc13-browser-${++sequence}`;
                const timeout = setTimeout(() => {socket.removeEventListener('message', receive); reject(new Error('API timeout'));}, 15000);
                function receive(event) {
                    const response = JSON.parse(event.data);
                    if (response.requestId !== requestId || response._rok) return;
                    clearTimeout(timeout); socket.removeEventListener('message', receive);
                    response.error ? reject(new Error(response.error)) : resolve(response);
                }
                socket.addEventListener('message', receive);
                socket.send(JSON.stringify({...data, requestId, csrfToken, userId: auth.currentUserId, profileAccessToken: auth.profileAccessToken, accessToken: auth.accessToken}));
            });
            try {csrfToken = (await request({action: 'get-config'})).csrfToken; return await request(payload);} finally {socket.close();}
        }, payload);
        const login = async(login, secret) => {
            await page.locator('.profile-login-action,.profile-status-chip').first().click();
            await page.getByRole('textbox', {name: 'Логин', exact: true}).fill(login);
            await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill(secret);
            await page.getByRole('button', {name: 'OK', exact: true}).click();
            await page.locator('.profile-controls .profile-logout').waitFor();
        };
        const logout = async() => {
            await page.goto(base + '/#/books');
            await page.locator('.profile-controls .profile-logout').waitFor();
            await Promise.all([page.waitForNavigation({waitUntil: 'domcontentloaded'}), page.locator('.profile-controls .profile-logout').click()]);
            await page.locator('.profile-controls').waitFor();
        };
        const openReader = async uid => {
            await page.goto(base + '/#/reader?bookUid=' + encodeURIComponent(uid));
            await page.locator('.reader-body').waitFor();
            await page.waitForFunction(() => !document.querySelector('.reader-loading') && document.querySelector('.reader-html')?.textContent.trim());
        };
        await page.goto(base + '/#/books'); await page.locator('.profile-controls').waitFor();
        await page.evaluate(async() => {await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));});
        await page.locator('.profile-controls').waitFor();
        await login('admin', password);
        await api({action: 'create-user-profile', profile: {name: 'Bob', login: 'bob', password: 'bob-browser-password'}});
        const catalog = await api({action: 'bookSearch', query: {lang: 'ru', limit: 1}}), uid = catalog.found[0]._uid;
        assert(uid);
        await openReader(uid);
        await page.locator('input.reader-background-input').setInputFiles({name: 'rc13.png', mimeType: 'image/png', buffer: png});
        let backgroundUrl = '';
        for (let i = 0; i < 60; i++) {
            const result = await api({action: 'get-reader-state', bookUid: uid});
            backgroundUrl = result.preferences?.backgroundImage || '';
            if (backgroundUrl.startsWith('/reader-background/')) break; await pause(250);
        }
        assert.match(backgroundUrl, /^\/reader-background\/admin\/[a-f0-9]{64}\.png$/);
        await page.waitForFunction(() => !JSON.parse(localStorage.getItem('vuex') || '{}').config);
        const cookieRequest = await page.evaluate(async url => {
            const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store'});
            return {status: response.status, bytes: (await response.arrayBuffer()).byteLength, cacheControl: response.headers.get('cache-control')};
        }, backgroundUrl);
        assert.equal(cookieRequest.status, 200, 'Background route accepts the real login cookie without access query');
        assert.equal(cookieRequest.bytes, png.length); assert.match(cookieRequest.cacheControl, /private.*no-store/);
        const anonymous = await browser.newContext();
        assert.equal((await anonymous.request.get(base + backgroundUrl)).status(), 401, 'Another browser cannot read a profile image');
        await anonymous.close();
        await page.waitForFunction(() => !String(localStorage.getItem('inpx.reader.preferences.v1')).includes('data:image/'));
        const oldProgress = {percent: .73, pageIndex: 73, sectionId: 'chapter', textSnippet: 'Admin progress', revision: 0, generation: 0};
        await page.evaluate(({uid, progress}) => {
            localStorage.setItem('inpx.reader.progress.v1', JSON.stringify({progress: {[uid]: progress}, byUser: {admin: {[uid]: progress}}}));
        }, {uid, progress: oldProgress});
        await logout(); await login('bob', 'bob-browser-password'); await openReader(uid);
        const bobState = await api({action: 'get-reader-state', bookUid: uid});
        assert((Number(bobState.progress?.percent) || 0) < .1, 'First open must not upload another profile\'s legacy global progress');
        assert(!bobState.preferences?.backgroundImage, 'Another profile does not inherit the background');
        await logout(); await login('admin', password); await openReader(uid);
        const backgroundRecord = async() => page.evaluate(() => new Promise((resolve, reject) => {
            const opening = indexedDB.open('inpxReaderPreferences');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result, request = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get('profile:admin');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {const record = request.result; db.close(); resolve({url: record?.preferences?.backgroundImage,
                    source: record?.background?.source || '', image: record?.background?.data || ''});};
            };
        }));
        let beforeOffline;
        for (let i = 0; i < 40; i++) {
            beforeOffline = await backgroundRecord();
            if (beforeOffline.source === backgroundUrl && beforeOffline.image.startsWith('data:image/png')) break;
            await pause(250);
        }
        await fs.writeJson(path.join(directory, 'before-offline.json'), {...beforeOffline, image: beforeOffline.image.length});
        assert.equal(beforeOffline.source, backgroundUrl, 'Wait until the canonical background has its offline bitmap');
        assert(beforeOffline.image.startsWith('data:image/png'));
        await page.route('**/reader-background/**', route => route.abort());
        await page.reload();
        await page.locator('.reader-body').waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.reader-page')).getPropertyValue('--reader-background-image').includes('data:image/png'));
        const indexed = await page.evaluate(() => new Promise((resolve, reject) => {
            const opening = indexedDB.open('inpxReaderPreferences');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result, request = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get('profile:admin');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {const record = request.result; db.close(); resolve({url: record?.preferences?.backgroundImage, image: record?.background?.data || ''});};
            };
        }));
        assert.equal(indexed.url, backgroundUrl); assert(indexed.image.startsWith('data:image/png;base64,'));
        const cachedUrls = await page.evaluate(async() => {
            const urls = [];
            for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
            return urls;
        });
        assert(!cachedUrls.some(url => url.includes('/reader-background/') || url.includes('/admin-backups/') || url.includes('/reader-audio/')));
        await page.screenshot({path: path.join(directory, 'offline-background.png')});
        assert.deepEqual(errors, []);
        await fs.writeJson(path.join(directory, 'result.json'), {cookieRequest, backgroundUrl, bobProgress: bobState.progress, offlineBackgroundBytes: indexed.image.length,
            cachedEntries: cachedUrls.length, errors}, {spaces: 2});
        console.log(`RC13 browser: cookie-protected background, profile isolation, offline image restoration from IndexedDB, compact localStorage and private SW exclusions passed. Artifacts: ${directory}`);
    } catch (error) {
        if (page) {await page.screenshot({path: path.join(directory, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(directory, 'failure.html'), await page.content()).catch(() => {});}
        console.error(`Artifacts: ${directory}\n${output}`); throw error;
    } finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
