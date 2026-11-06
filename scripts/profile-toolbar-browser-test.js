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
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-toolbar-'));
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
        await page.getByRole('button', {name: /^Отправка книг/}).click();
        await page.getByRole('combobox', {name: 'Подключение Telegram', exact: true}).click();
        await page.getByRole('option', {name: 'Только IPv6', exact: true}).click();
        const deliverySettings = page.getByRole('button', {name: /^Отправка книг/}).locator('..');
        await deliverySettings.getByRole('button', {name: 'Сохранить', exact: true}).click();
        await page.getByText('Настройки отправки сохранены', {exact: true}).waitFor();
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.locator('.q-dialog').waitFor({state: 'hidden'});
        await page.reload();
        await page.locator('.profile-controls .profile-logout').waitFor();
        await toolbar.getByRole('button', {name: 'Настройки', exact: true}).click();
        await page.getByRole('button', {name: /^Отправка книг/}).click();
        await deliverySettings.getByText('Только IPv6', {exact: true}).waitFor();
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
        console.log(`Profile UI: logout, token revocation, guest restrictions, five catalog icons at 320/390/514/760/1280px, shelf/favorites actions and tasks in administration passed; screenshots: ${directory}`);
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
