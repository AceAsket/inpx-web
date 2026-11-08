// Optional full-UI check with a deterministic speech engine. No remote TTS service or audio device required.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async() => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-browser-speech-'));
    let browser, child, output = '';
    try {
        const library = path.join(directory, 'library'); await createFixture(library);
        await fs.writeJson(path.join(library, 'config.json'), {loggingEnabled: false, opds: {enabled: true, auth: false}, adminPassword: 'browser-speech-test'});
        const zip = new (require('yazl').ZipFile)();
        const archive = fs.createWriteStream(path.join(library, 'smoke.zip'));
        const archived = require('stream/promises').pipeline(zip.outputStream, archive);
        zip.addBuffer(Buffer.from('<FictionBook><description><title-info><book-title>Книга KOSync</book-title></title-info></description>' +
            '<body><section><p>Текст книги для синхронизации KOReader.</p><p>Второй абзац книги для синхронизации.</p></section></body></FictionBook>'), '1.fb2');
        zip.end(); await archived;
        const dataDir = path.join(directory, 'data');
        await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        const port = await unusedPort();
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${library}/config.json`,
            `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env, INPX_TTS_ENABLED: 'false', INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
                INPX_ENABLE_CONVERSION: 'false', INPX_ADMIN_PASSWORD: 'browser-speech-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local'}});
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000); });
        const url = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const response = await fetch(`${url}/ready`); ready = response.ok && (await response.json()).ready;} catch { /* Starting. */ }
            if (ready || child.exitCode !== null) break;
            await pause(500);
        }
        assert(ready, output);
        await require('./kosync-integration-test')(url, directory);
        await require('./opds2-integration-test')(url);
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const page = await browser.newPage({viewport: {width: 1100, height: 820}}), errors = [], serverSpeech = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {if (/\/speech\//.test(request.url())) serverSpeech.push(request.url());});
        await page.addInitScript(() => {
            window.__spoken = []; window.__voices = [];
            const events = new EventTarget();
            const synth = {getVoices: () => window.__voices,
                speak(utterance) {window.__spoken.push(utterance.text); window.__utterance = utterance;},
                cancel() {const u = window.__utterance; window.__utterance = null; if (u) setTimeout(() => u.onerror?.({error: 'interrupted'}), 0);},
                addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args)};
            Object.defineProperty(window, 'speechSynthesis', {value: synth});
            Object.defineProperty(window, 'SpeechSynthesisUtterance', {value: class {constructor(text) {this.text = text;}}});
            window.__loadVoices = () => {window.__voices = [{voiceURI: 'test-local', name: 'Тестовый голос', lang: 'ru-RU', localService: true}]; events.dispatchEvent(new Event('voiceschanged'));};
        });
        await page.goto(url + '/#/reader-lab');
        const xml = '<FictionBook><description><title-info><book-title>Локальная озвучка</book-title><lang>ru</lang>' +
            '<annotation><p>Не читать аннотацию.</p></annotation></title-info></description><body><section>' +
            '<p>Первая фраза книги.</p><p>Вторая фраза книги.</p></section></body><body name="notes"><section id="n1"><p>Не читать примечания.</p></section></body></FictionBook>';
        await page.locator('input[type=file]').first().setInputFiles({name: 'local.fb2', mimeType: 'application/xml', buffer: Buffer.from(xml)});
        await page.waitForFunction(() => document.querySelector('.reader-html')?.textContent.includes('Первая фраза книги.'));
        await page.getByRole('button', {name: 'Озвучка книги', exact: true}).click({timeout: 60000});
        await page.evaluate(() => window.__loadVoices());
        const panel = page.getByRole('complementary', {name: 'Озвучка голосами устройства'});
        await panel.getByRole('combobox', {name: 'Голос устройства', exact: true}).selectOption('test-local');
        await panel.getByRole('combobox', {name: 'Скорость', exact: true}).selectOption('1.5');
        await panel.getByRole('button', {name: 'Проба', exact: true}).click();
        assert.match(await page.evaluate(() => window.__spoken[0]), /выбранный голос/);
        await page.evaluate(() => window.__utterance.onend());
        await panel.getByRole('button', {name: 'Слушать', exact: true}).click();
        assert.equal(await page.evaluate(() => window.__utterance.rate), 1.5);
        assert.equal(await page.evaluate(() => window.__utterance.voice.voiceURI), 'test-local');
        for (let i = 0; i < 6 && await page.evaluate(() => window.__utterance?.text) !== 'Вторая фраза книги.'; i++) {
            await panel.getByRole('button', {name: 'Следующая фраза', exact: true}).click();
        }
        await pause(30);
        assert.equal(await page.evaluate(() => window.__utterance.text), 'Вторая фраза книги.');
        await panel.getByRole('button', {name: 'Пауза', exact: true}).click();
        await panel.getByRole('button', {name: 'Закрыть озвучку устройства'}).click();
        await page.getByRole('button', {name: 'Озвучка книги', exact: true}).click();
        await panel.getByRole('button', {name: 'Продолжить', exact: true}).click();
        assert.equal(await page.evaluate(() => window.__utterance.text), 'Вторая фраза книги.');
        assert(!(await page.evaluate(() => window.__spoken.join(' '))).includes('Не читать'));
        await page.setViewportSize({width: 390, height: 844}); await pause(300);
        const bounds = await panel.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 391);
        await page.screenshot({path: path.join(directory, 'browser-speech-mobile.png')});
        await panel.getByRole('button', {name: 'Закрыть озвучку устройства'}).click();
        assert.equal(await page.evaluate(() => window.__utterance), null);
        await page.getByRole('button', {name: 'Другой FB2'}).click();
        await page.locator('input[type=file]').last().setInputFiles({name: 'other.fb2', mimeType: 'application/xml', buffer: Buffer.from(xml.replace('Первая фраза', 'Другая книга'))});
        assert.equal(await panel.count(), 0, 'A new file closes the old player');
        assert.deepEqual(serverSpeech, []); assert.deepEqual(errors, []);
        console.log(`Browser speech UI: local FB2 without Silero, late voices, preview, rate, phrases, position, mobile layout and cleanup passed; screenshot: ${directory}/browser-speech-mobile.png`);
    } catch (error) {console.error(output); throw error;}
    finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
