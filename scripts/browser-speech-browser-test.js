// Optional full-UI check with a deterministic speech engine. No remote TTS service or audio device required.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function playThrough(page, phrase) {
    const reached = await page.evaluate(async expected => {
        for (let i = 0; i < 80; i++) {
            const utterance = window.__utterance;
            if (!utterance) return false;
            if (utterance.text === expected) return true;
            utterance.onend();
            await new Promise(requestAnimationFrame);
        }
        return false;
    }, phrase);
    assert(reached, `The speech engine reached «${phrase}»`);
}

function phraseInScrollViewport(phrase) {
    const scroller = document.querySelector('.reader-scroll');
    if (!scroller) return false;
    const target = [...scroller.querySelectorAll('.reader-html p')].find(item => item.textContent.trim() === phrase);
    if (!target) return false;
    const bounds = scroller.getBoundingClientRect(), rect = target.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom;
}

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
                speak(utterance) {
                    window.__spoken.push(utterance.text); window.__utterance = utterance;
                    queueMicrotask(() => {if (window.__utterance === utterance) utterance.onstart?.();});
                },
                cancel() {const u = window.__utterance; window.__utterance = null; if (u) setTimeout(() => u.onerror?.({error: 'interrupted'}), 0);},
                addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args)};
            Object.defineProperty(window, 'speechSynthesis', {value: synth});
            Object.defineProperty(window, 'SpeechSynthesisUtterance', {value: class {constructor(text) {this.text = text;}}});
            window.__loadVoices = () => {window.__voices = [{voiceURI: 'test-local', name: 'Тестовый голос', lang: 'ru-RU', localService: true}]; events.dispatchEvent(new Event('voiceschanged'));};
        });
        await page.goto(url + '/#/reader-lab');
        const firstAnchor = 'Начало проверочного фрагмента вдали от верхнего края.';
        const lastAnchor = 'Последний проверочный фрагмент внизу книги.';
        const paragraphs = offset => Array.from({length: 30}, (_, index) =>
            `<p>Абзац ${index + offset} содержит обычный текст для проверки видимой области читалки.</p>`).join('');
        const xml = '<FictionBook><description><title-info><book-title>Локальная озвучка</book-title><lang>ru</lang>' +
            '<annotation><p>Не читать аннотацию.</p></annotation></title-info></description><body><section>' +
            `<p>Первая фраза книги.</p><p>Вторая фраза книги.</p>${paragraphs(1)}<p>${firstAnchor}</p>` +
            `${paragraphs(31)}<p>${lastAnchor}</p></section></body><body name="notes"><section id="n1"><p>Не читать примечания.</p></section></body></FictionBook>`;
        const localBook = {name: 'local.fb2', mimeType: 'application/xml', buffer: Buffer.from(xml)};
        await page.locator('input[type=file]').first().setInputFiles(localBook);
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

        const follow = panel.getByRole('checkbox', {name: 'Следить за озвучкой', exact: true});
        const scroller = page.locator('.reader-scroll');
        const scrollPosition = () => scroller.evaluate(element => element.scrollTop);
        assert.equal(await follow.getAttribute('aria-checked'), 'false');
        assert.equal(await page.evaluate(phraseInScrollViewport, firstAnchor), false);
        const initialScroll = await scrollPosition();
        await playThrough(page, firstAnchor);
        assert.equal(await scrollPosition(), initialScroll, 'Playback leaves scrolling unchanged by default');
        await follow.click();
        await page.waitForFunction(phraseInScrollViewport, firstAnchor);
        const firstScroll = await scrollPosition();
        assert(firstScroll > initialScroll, 'Enabling follow moves to the phrase already playing');
        await playThrough(page, lastAnchor);
        await page.waitForFunction(phraseInScrollViewport, lastAnchor);
        assert(await scrollPosition() > firstScroll, 'Playback continues scrolling to subsequent phrases');
        await panel.getByRole('button', {name: 'Пауза', exact: true}).click();
        await scroller.evaluate(element => {element.scrollTop = 0;});
        await panel.getByRole('button', {name: 'Предыдущая фраза', exact: true}).click();
        await panel.getByRole('button', {name: 'Следующая фраза', exact: true}).click();
        assert.equal(await scrollPosition(), 0, 'Changing the phrase while paused leaves scrolling unchanged');
        await panel.getByRole('button', {name: 'Закрыть озвучку устройства'}).click();

        // Reload the app so the local book starts with paginated layout.
        await page.goto(url + '/?view=paged#/reader-lab?debugReader=1&debugReadMode=paged');
        await page.locator('input[type=file]').first().setInputFiles(localBook);
        const livePage = page.locator('.reader-page-sheet--live');
        await page.waitForFunction(() => document.querySelector('.reader-scroll--paged .reader-page-sheet--live')
            && !document.querySelector('.reader-reflow-indicator,.reader-loading'));
        const originalPage = await livePage.first().getAttribute('data-page-index');
        assert(originalPage !== null, 'Paginated reader has a visible page');
        assert.equal(await livePage.getByText(lastAnchor, {exact: true}).count(), 0, 'Last phrase starts on another page');
        await page.getByRole('button', {name: 'Озвучка книги', exact: true}).click();
        assert.equal(await follow.getAttribute('aria-checked'), 'true', 'Following preference survives a reload');
        await panel.getByRole('button', {name: 'Проба', exact: true}).click();
        assert.equal(await livePage.first().getAttribute('data-page-index'), originalPage, 'Voice preview leaves the page unchanged');
        await page.evaluate(() => window.__utterance.onend());
        await panel.getByRole('button', {name: /^(Слушать|Продолжить)$/}).click();
        await playThrough(page, lastAnchor);
        const spokenPage = livePage.filter({hasText: lastAnchor});
        await spokenPage.getByText(lastAnchor, {exact: true}).waitFor();
        assert.notEqual(await spokenPage.getAttribute('data-page-index'), originalPage, 'Following can turn pages');

        await page.setViewportSize({width: 390, height: 844}); await pause(300);
        const bounds = await panel.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 391);
        await page.screenshot({path: path.join(directory, 'browser-speech-mobile.png')});
        await panel.getByRole('button', {name: 'Закрыть озвучку устройства'}).click();
        assert.equal(await page.evaluate(() => window.__utterance), null);
        await page.getByRole('button', {name: 'Другой FB2'}).click();
        await page.locator('input[type=file]').last().setInputFiles({name: 'other.fb2', mimeType: 'application/xml', buffer: Buffer.from(xml.replace('Первая фраза', 'Другая книга'))});
        assert.equal(await panel.count(), 0, 'A new file closes the old player');
        assert.deepEqual(serverSpeech, []); assert.deepEqual(errors, []);
        console.log(`Browser speech UI: local FB2, voices, playback position, optional scrolling and paging, mobile layout and cleanup passed; screenshot: ${directory}/browser-speech-mobile.png`);
    } catch (error) {console.error(output); throw error;}
    finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
