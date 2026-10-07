// Optional full-app browser check. Requires a built client, Playwright and running Silero.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const yazl = require('yazl');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const ZipReader = require('../server/core/ZipReader');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async() => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-tts-browser-'));
    let browser, child, output = '';
    try {
        const library = path.join(directory, 'library');
        await createFixture(library);
        const zipReader = new ZipReader();
        await zipReader.open(path.join(library, 'smoke.inpx'));
        const row = (await zipReader.extractToBuf('smoke.inp')).toString().trimEnd();
        await zipReader.close();
        const uid = crypto.createHash('sha256').update(row).digest('base64');
        const zip = new yazl.ZipFile();
        const target = fs.createWriteStream(path.join(library, 'smoke.zip'));
        const complete = new Promise((resolve, reject) => { target.on('close', resolve); target.on('error', reject); });
        zip.outputStream.pipe(target);
        const text = 'Здравствуйте! Это тестовая книга для проверки озвучки. Можно слушать текст, менять скорость и продолжать с сохранённого места. ';
        zip.addBuffer(Buffer.from(`<FictionBook><description><title-info><book-title>Проверка Silero</book-title><lang>ru</lang></title-info></description>
            <body><section><title><p>Первая глава</p></title><p>${text.repeat(3)}</p></section></body></FictionBook>`), '1.fb2');
        zip.end();
        await complete;
        const dataDir = path.join(directory, 'data');
        await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        const port = await unusedPort();
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${library}/config.json`,
            `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env, INPX_TTS_ENABLED: 'true', INPX_TTS_URL: process.env.INPX_TTS_URL || 'http://127.0.0.1:18081',
                INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '', INPX_ENABLE_CONVERSION: 'false',
                INPX_ADMIN_PASSWORD: 'tts-browser-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local'},
        });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000); });
        const url = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try { const response = await fetch(`${url}/ready`); ready = response.ok && (await response.json()).ready; } catch { /* Starting. */ }
            if (ready || child.exitCode !== null) break;
            await pause(500);
        }
        assert.ok(ready, output);
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined,
            args: ['--autoplay-policy=no-user-gesture-required']});
        const page = await browser.newPage({viewport: {width: 390, height: 844}});
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy?.$refs?.api?.accessGranted, null, {timeout: 60000});
        await page.evaluate(async() => {
            const root = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
            const result = await root.$refs.api.loginUserProfile('admin', 'tts-browser-test');
            root.$store.commit('setSettings', {currentUserId: result.userId, profileAccessToken: result.profileAccessToken});
            await root.$refs.api.updateConfig();
        });
        await page.goto(`${url}/#/reader?bookUid=${encodeURIComponent(uid)}`);
        await page.getByRole('button', {name: 'Озвучка книги', exact: true}).click({timeout: 60000});
        await page.getByRole('button', {name: 'Подготовить озвучку', exact: true}).click();
        await page.waitForFunction(() => {
            const audio = document.querySelector('.reader-audio audio');
            return audio && Number.isFinite(audio.duration) && audio.duration > 10;
        }, null, {timeout: 120000});
        await page.locator('.reader-audio-options select').nth(1).selectOption('1.5');
        await page.locator('.reader-audio audio').evaluate(async audio => { audio.currentTime = 5; await audio.play(); });
        await page.getByRole('button', {name: 'Свернуть плеер', exact: true}).click();
        const playing = await page.locator('.reader-audio audio').evaluate(audio => ({paused: audio.paused, rate: audio.playbackRate, time: audio.currentTime}));
        assert.equal(playing.paused, false); assert.equal(playing.rate, 1.5); assert.ok(playing.time >= 5);
        assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'playing');
        await page.getByRole('button', {name: 'Озвучка', exact: true}).click();
        await page.getByRole('button', {name: 'Закрыть и остановить озвучку', exact: true}).click();
        assert.equal(await page.locator('.reader-audio audio').evaluate(audio => audio.paused), true);
        await page.getByRole('button', {name: 'Озвучка книги', exact: true}).click();
        await page.getByRole('button', {name: 'Подготовить озвучку', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.reader-audio audio')?.currentTime >= 5);
        await page.screenshot({path: path.join(directory, 'tts-mobile.png')});
        assert.deepEqual(errors, []);
        console.log(`TTS browser: actual synthesis, decoding, speed, Media Session, minimize and resume passed; screenshot: ${directory}/tts-mobile.png`);
    } catch (error) { console.error(output); throw error; }
    finally { if (browser) await browser.close(); if (child) child.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
