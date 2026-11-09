// Uses a real paginated book and a viewport resize, rather than mocking loading flags.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-reader-footer-'));
    await fs.ensureDir(directory);
    let browser, child, page, output = '';
    try {
        const library = path.join(directory, 'library'), data = path.join(directory, 'data');
        await createFixture(library);
        const zip = new ZipFile();
        const archive = pipeline(zip.outputStream, fs.createWriteStream(path.join(library, 'smoke.zip')));
        const paragraph = 'Читатель открывает книгу и возвращается к сохранённой странице. Нижняя панель показывает номер страницы, главу и прогресс. ';
        const sections = Array.from({length: 8}, (_, chapter) =>
            `<section><title><p>Глава ${chapter + 1}. Заголовок проверочной главы</p></title>` +
            Array.from({length: 14}, (_, row) => `<p>Абзац ${chapter + 1}.${row + 1}. ${paragraph.repeat(8)}</p>`).join('') + '</section>');
        zip.addBuffer(Buffer.from(`<FictionBook><description><title-info><book-title>Packaged smoke book</book-title></title-info></description><body>${sections.join('')}</body></FictionBook>`), '1.fb2');
        zip.end(); await archive;
        await fs.copy(path.resolve(process.env.INPX_READER_PUBLIC_DIR || 'dist/tmp/public'), path.join(data, 'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${data}`, `--config=${library}/config.json`, `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
                INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS: 'true',
                INPX_TTS_ENABLED: 'false', INPX_TELEGRAM_BOT_ENABLED: 'false'},
        });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', part => {output = (output + part).slice(-6000);});
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const r = await fetch(base + '/ready'); ready = r.ok && (await r.json()).ready;} catch { /* Server is starting. */ }
            if (ready || child.exitCode !== null) break;
            await pause(500);
        }
        assert(ready, output);
        const catalog = await (await fetch(base + '/ebook?q=Packaged')).text();
        const encoded = catalog.match(/[?&](?:amp;)?uid=([^"&]+)/)?.[1];
        assert(encoded, 'Fixture book found in the catalog');
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
        page = await context.newPage();
        page.setDefaultTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            const preferences = {
                readerPreferencesVersion: 3, theme: 'light', readMode: 'paged', pageAnimation: 'none', showStatusBar: true,
                statusBarClock: true, statusBarProgressBar: true, statusBarRemaining: true,
            };
            localStorage.setItem('inpx.reader.preferences.v1', JSON.stringify({preferences, byUser: {admin: preferences}}));
            const samples = window.__readerFooterSamples = [];
            window.__readFooter = () => {
                const bar = document.querySelector('.reader-desktop-footer .reader-status-bar');
                if (!bar) return null;
                const rect = bar.getBoundingClientRect();
                const text = bar.querySelector('.reader-status-main').textContent.trim();
                const counter = /\|\s*(\d+)\/(\d+)/.exec(text);
                return {text, page: Number(counter?.[1]), total: Number(counter?.[2]), width: rect.width, height: rect.height,
                    busy: !!bar.querySelector('.reader-status-bar-spinner'), visiblePage: !!document.querySelector('.reader-page-sheet--live')};
            };
            const sample = () => {
                const state = window.__readFooter();
                if (state && samples.length < 200 && JSON.stringify(state) !== JSON.stringify(samples.at(-1))) samples.push(state);
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await page.goto(`${base}/#/reader?bookUid=${encoded}`);
        await page.waitForFunction(() => {
            const state = window.__readFooter();
            return state?.visiblePage && state.total > 2 && !document.querySelector('.reader-reflow-indicator,.reader-loading');
        });
        await page.waitForFunction(() => window.__readerFooterSamples.some(state => state.busy && !state.visiblePage));
        await page.keyboard.press('PageDown');
        await page.waitForFunction(() => {const state = window.__readFooter(); return state?.page === 2 && !state.text.startsWith('Прочитано 0%');});
        const before = await page.evaluate(() => {window.__readerFooterSamples.length = 0; return window.__readFooter();});
        await page.locator('.reader-desktop-footer').screenshot({path: path.join(directory, 'reader-footer-before.png')});
        await page.setViewportSize({width: 1440, height: 740});
        await page.waitForFunction(total => {
            const state = window.__readFooter(); return state?.total > total && state.visiblePage;
        }, before.total);
        await pause(400);
        const samples = await page.evaluate(() => window.__readerFooterSamples.slice());
        const after = await page.evaluate(() => window.__readFooter());
        await fs.writeJson(path.join(directory, 'result.json'), {before, after, samples, errors}, {spaces: 2});
        await page.locator('.reader-desktop-footer').screenshot({path: path.join(directory, 'reader-footer-after.png')});
        assert(!samples.some(state => state.visiblePage && state.busy), 'A background rebuild must not replace the visible page status: ' + JSON.stringify(samples.slice(0, 8)));
        assert(samples.filter(state => state.total === before.total).every(state => state.text === before.text && Math.abs(state.width - before.width) <= 1 && Math.abs(state.height - before.height) <= 1),
            'The previous page and footer dimensions stay stable until the new pagination commits');
        assert(Math.abs(after.width - before.width) <= 1 && Math.abs(after.height - before.height) <= 1,
            'Committing the new page count does not jump the footer');
        assert(after.page >= 2 && after.total > before.total, 'Viewport repagination preserves the reading position');
        assert.deepEqual(errors, []);
        console.log(`Reader footer: initial preparation visible; status stable during real repagination (${before.total} → ${after.total} pages).`);
    } catch (error) {
        if (page) await page.screenshot({path: path.join(directory, 'failure.png')}).catch(() => {});
        throw error;
    } finally {
        if (browser) await browser.close();
        if (child) child.kill();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
