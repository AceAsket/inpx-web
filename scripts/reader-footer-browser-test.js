// Uses a real illustrated book to check the footer and text across page turns.
const assert = require('assert/strict');
const {createHash} = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {createFixture, unusedPort} = require('./binary-smoke-test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const textHash = text => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

function readRenderedPage(page) {
    return page.evaluate(async() => {
        const html = document.querySelector('.reader-page-sheet--live .reader-html');
        const images = Array.from(html.querySelectorAll('img'));
        await Promise.allSettled(images.map(img => img.decode()));
        const bounds = html.getBoundingClientRect();
        const clip = Math.min(bounds.bottom, document.querySelector('.reader-scroll').getBoundingClientRect().bottom);
        const walker = document.createTreeWalker(html, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let textBottom = bounds.top;
        while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            range.selectNodeContents(walker.currentNode);
            for (const rect of range.getClientRects()) textBottom = Math.max(textBottom, rect.bottom);
        }
        return {height: bounds.height, freeBottom: clip - textBottom, lineHeight: parseFloat(getComputedStyle(html).lineHeight),
            images: images.filter(img => img.naturalHeight === 1000).length,
            paragraphs: Array.from(html.querySelectorAll('.reader-paragraph'), p => p.textContent)};
    });
}

async function checkDesktopOpening(browser, url, progress) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
    try {
        const page = await context.newPage();
        await page.routeWebSocket('**/ws', socket => {
            const server = socket.connectToServer();
            server.onMessage(message => socket.send(message));
            socket.onMessage(message => {
                const request = JSON.parse(message);
                if (request.action !== 'get-reader-state') return server.send(message);
                socket.send(JSON.stringify({requestId: request.requestId, _rok: 1}));
                socket.send(JSON.stringify({requestId: request.requestId, preferences: {readMode: 'paged'}, progress, bookmarks: []}));
            });
        });
        await page.addInitScript(saved => {
            const sample = () => {
                const debug = document.querySelector('.reader-debug-panel')?.textContent || '';
                const live = document.querySelector('.reader-page-sheet--live');
                const total = Number(/page:\s*\d+\/(\d+)/.exec(debug)?.[1]);
                const overlay = document.querySelector('.reader-reflow-indicator--strong:not(.reader-reflow-fade-leave-active)');
                if (live && !overlay && /pagination: (building|cached)/.test(debug) && total >= 1) {
                    window.__opening = {index: Number(live.dataset.pageIndex), text: live.innerText};
                    if (!saved) window.dispatchEvent(new KeyboardEvent('keydown', {key: 'PageDown', cancelable: true}));
                    return;
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }, !!progress.textSnippet);
        await page.goto(url);
        await page.waitForFunction(() => /pagination: done/.test(document.querySelector('.reader-debug-panel')?.textContent)
            && !document.querySelector('.reader-reflow-indicator--strong')
            && document.querySelectorAll('.reader-page-sheet--live').length === 1);
        const opening = await page.evaluate(() => window.__opening);
        assert(opening, 'The book must be readable while subsequent desktop pages are still building');
        const index = Number(await page.locator('.reader-page-sheet--live').getAttribute('data-page-index'));
        if (progress.textSnippet) {
            assert(opening.text.includes(progress.textSnippet), 'Restore the saved text before revealing the book');
            assert.equal(index, opening.index);
            await page.reload();
            await page.waitForFunction(() => /pagination: cached/.test(document.querySelector('.reader-debug-panel')?.textContent)
                && !document.querySelector('.reader-reflow-indicator--strong')
                && document.querySelectorAll('.reader-page-sheet--live').length === 1 && window.__opening);
            assert.equal(await page.evaluate(() => window.__opening.index), index, 'First visible cached page matches the saved text');
            const restored = page.locator('.reader-page-sheet--live');
            assert.equal(Number(await restored.getAttribute('data-page-index')), index);
            assert((await restored.innerText()).includes(progress.textSnippet), 'Reload restores the saved text from persisted pages');
        } else {
            assert.equal(opening.index, 0);
            assert.equal(index, 1, 'Finishing pagination must preserve an early page turn');
        }
    } finally {await context.close();}
}

async function checkOpeningWithClippedViewport(browser, url) {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
    try {
        const page = await context.newPage();
        await page.routeWebSocket('**/ws', socket => {
            const server = socket.connectToServer();
            server.onMessage(message => socket.send(message));
            socket.onMessage(message => {
                const request = JSON.parse(message);
                if (request.action !== 'get-reader-state') return server.send(message);
                socket.send(JSON.stringify({requestId: request.requestId, _rok: 1}));
                socket.send(JSON.stringify({requestId: request.requestId, preferences: {readMode: 'paged'}, progress: {}, bookmarks: []}));
            });
        });
        await page.addInitScript(() => {
            // Two layout viewport heights leave the same usable area for the page.
            Object.defineProperty(window.visualViewport, 'height', {configurable: true, get: () => 440});
            const observer = new MutationObserver(() => {
                if (!document.head) return;
                observer.disconnect();
                const style = document.createElement('style');
                const height = sessionStorage.getItem('smallerLayoutViewport') ? 520 : 650;
                style.textContent = `.reader-scroll {max-height: ${height}px}`;
                document.head.appendChild(style);
            });
            observer.observe(document, {childList: true, subtree: true});
        });
        await page.goto(url);
        await page.waitForFunction(() => /pagination: done/.test(document.querySelector('.reader-debug-panel')?.textContent)
            && !document.querySelector('.reader-reflow-indicator--strong')
            && document.querySelector('.reader-page-sheet--live'), undefined, {timeout: 15000});
        const geometry = () => page.evaluate(() => ({
            scrollerHeight: document.querySelector('.reader-scroll').clientHeight,
            pageHeight: document.querySelector('.reader-page-sheet--live').clientHeight,
        }));
        const first = await geometry();
        await page.evaluate(() => sessionStorage.setItem('smallerLayoutViewport', 'true'));
        await page.reload();
        await page.waitForFunction(() => /pagination: (done|cached)/.test(document.querySelector('.reader-debug-panel')?.textContent)
            && !document.querySelector('.reader-reflow-indicator--strong')
            && document.querySelector('.reader-page-sheet--live'), undefined, {timeout: 15000});
        const reopened = await geometry();
        assert.notEqual(reopened.scrollerHeight, first.scrollerHeight);
        assert.equal(reopened.pageHeight, first.pageHeight);
        assert.match(await page.locator('.reader-debug-panel').textContent(), /pagination: cached/,
            'Reopening with the same usable page area must reuse the saved pagination');

        await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, 'height', {get: () => 380});
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(previousHeight => {
            const sheet = document.querySelector('.reader-page-sheet--live');
            return !!sheet && sheet.clientHeight < previousHeight && getComputedStyle(sheet).visibility === 'visible'
                && /pagination: done/.test(document.querySelector('.reader-debug-panel')?.textContent);
        }, reopened.pageHeight, {timeout: 15000});
        assert.equal((await geometry()).scrollerHeight, reopened.scrollerHeight,
            'Changing the visual viewport alone must reflow the page');
    } finally {await context.close();}
}

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
        const image = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAPoAQAAAACXUsEdAAAAI0lEQVR42u3EMQEAMAzAoHT+Pbcq9sHBbPWSJEmSJEmS9LED19IIz3kFiwoAAAAASUVORK5CYII=';
        const sourceParagraphs = [];
        const sections = Array.from({length: 8}, (_, chapter) => {
            const illustrated = chapter === 2 || chapter === 3;
            const paragraphs = Array.from({length: 14}, (_, row) => {
                const text = `Абзац ${chapter + 1}.${row + 1}. ${paragraph.repeat(illustrated ? 1 : 8)}Конец ${chapter + 1}.${row + 1}.`;
                sourceParagraphs.push(text);
                return `<p>${text}</p>`;
            });
            const figure = illustrated ? '<image l:href="#tall"/>' : '';
            return `<section><title><p>Глава ${chapter + 1}. Заголовок проверочной главы</p></title>${figure}${paragraphs.join('')}</section>`;
        });
        zip.addBuffer(Buffer.from(`<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Packaged smoke book</book-title></title-info></description><body>${sections.join('')}</body><binary id="tall" content-type="image/png">${image}</binary></FictionBook>`), '1.fb2');
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
            const samples = window.__readerFooterSamples = [];
            const phases = window.__readerBuildPhases = [];
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
                const debug = document.querySelector('.reader-debug-panel');
                const phase = /pagination: (\w+)/.exec(debug?.textContent || '')?.[1];
                if (phase && phase !== phases.at(-1)) phases.push(phase);
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await page.goto(`${base}/#/reader?bookUid=${encoded}&debugReader=1`);
        await page.locator('.reader-body .reader-html').getByText(/Абзац 1\.1/).first().waitFor();
        const settings = page.locator('.reader-toolbar-quick-actions button:has(.la-sliders-h)');
        const options = page.locator('.reader-toolbar-actions');
        await settings.click();
        await options.getByRole('button', {name: 'Статус', exact: true}).click();
        for (const name of ['Часы', 'Шкала прогресса', 'Осталось страниц'])
            await options.getByRole('button', {name, exact: true}).click();
        await options.getByRole('button', {name: 'Страница', exact: true}).click();
        await options.getByRole('button', {name: 'Страницы', exact: true}).click();
        await options.getByRole('button', {name: 'Без анимации', exact: true}).click();
        await settings.click();
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
        const pendingTurn = await page.waitForFunction(() => {
            if (!document.querySelector('.reader-page-stage--waiting .reader-page-sheet--placeholder')) return null;
            const sheet = document.querySelector('.reader-page-sheet--live');
            const result = {index: sheet.dataset.pageIndex, hidden: getComputedStyle(sheet).visibility === 'hidden'};
            window.dispatchEvent(new KeyboardEvent('keydown', {key: 'PageDown', cancelable: true}));
            queueMicrotask(() => {result.next = document.querySelector('.reader-page-sheet--live').dataset.pageIndex;});
            return result;
        });
        const {hidden, index, next} = await pendingTurn.jsonValue();
        assert(hidden, 'A page built for a taller viewport is hidden while the smaller layout is prepared');
        assert.equal(next, index, 'PageDown cannot skip text while the old page is clipped');
        await page.waitForFunction(total => {
            const state = window.__readFooter(); return state?.total > total && state.visiblePage;
        }, before.total);
        await pause(400);
        const samples = await page.evaluate(() => window.__readerFooterSamples.slice());
        const after = await page.evaluate(() => window.__readFooter());
        await page.locator('.reader-desktop-footer').screenshot({path: path.join(directory, 'reader-footer-after.png')});
        assert(!samples.some(state => state.visiblePage && state.busy), 'A background rebuild must not replace the visible page status: ' + JSON.stringify(samples.slice(0, 8)));
        assert(samples.filter(state => state.total === before.total).every(state => state.text === before.text && Math.abs(state.width - before.width) <= 1 && Math.abs(state.height - before.height) <= 1),
            'The previous page number and footer dimensions stay stable until the new pagination commits');
        assert(after.page >= 2 && after.total > before.total, 'Viewport repagination preserves the reading position');

        const waitForPage = index => page.waitForFunction(index =>
            document.querySelector('.reader-page-sheet--live')?.dataset.pageIndex === String(index), index);
        const readingPage = Math.floor(after.total / 2);
        for (let index = after.page; index < readingPage; index++) {
            await page.keyboard.press('PageDown');
            await waitForPage(index);
        }
        const regular = await readRenderedPage(page);
        const regularTotal = after.total;
        const assertReadingPosition = async label => {
            await page.waitForFunction(total => {
                const counter = document.querySelector('.reader-debug-panel')?.textContent.match(/page: \d+\/(\d+)/);
                return Number(counter?.[1]) === total && !document.querySelector('.reader-page-sheet--placeholder')
                    && document.querySelectorAll('.reader-page-sheet--live').length === 1;
            }, regularTotal);
            const visiblePage = Number(await page.locator('.reader-page-sheet--live').getAttribute('data-page-index')) + 1;
            assert.equal(visiblePage, readingPage, label);
            assert.equal(textHash((await readRenderedPage(page)).paragraphs.join(' ')), textHash(regular.paragraphs.join(' ')), label);
        };
        const clickCenter = async() => {
            const bounds = await page.locator('.reader-scroll').boundingBox();
            await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        };
        await clickCenter();
        await page.waitForFunction(total => document.querySelector('.reader-page--immersive') && window.__readFooter()?.total < total, after.total);
        const immersive = await readRenderedPage(page);
        assert(immersive.height > regular.height, 'Hiding the toolbar gives the page more usable height');
        assert(immersive.freeBottom >= -1, 'Text fits the taller page after hiding the toolbar');
        assert(immersive.freeBottom < 2 * immersive.lineHeight, 'The taller page uses the extra space for text');
        await clickCenter();
        await page.waitForFunction(total => !document.querySelector('.reader-page--immersive') && window.__readFooter()?.total === total, after.total);
        await assertReadingPosition('Showing the reader toolbar again restores the original text');

        const fullscreen = page.locator('.reader-toolbar-quick-actions button:has(.la-expand-arrows-alt)');
        const viewport = await context.newCDPSession(page);
        const phaseOffset = await page.evaluate(() => window.__readerBuildPhases.length);
        await fullscreen.click();
        await page.waitForFunction(() => !!document.fullscreenElement);
        // Chromium does not allow resizing the browser window while fullscreen.
        await viewport.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 960, deviceScaleFactor: 1, mobile: false});
        await page.waitForFunction(({total, phaseOffset}) => {
            const phases = window.__readerBuildPhases.slice(phaseOffset);
            return innerHeight === 960 && window.__readFooter()?.total < total
                && phases.includes('building') && phases.at(-1) === 'done';
        }, {total: after.total, phaseOffset});
        const settledPhases = await page.evaluate(() => window.__readerBuildPhases.length);
        await pause(3200);
        const fullscreenPhases = await page.evaluate(offset => window.__readerBuildPhases.slice(offset), phaseOffset);
        assert.equal(fullscreenPhases.length, settledPhases - phaseOffset,
            'Pagination stays idle after fullscreen geometry settles: ' + fullscreenPhases.join(', '));
        await page.locator('.reader-toolbar-quick-actions button:has(.la-compress-arrows-alt)').click();
        await page.waitForFunction(() => !document.fullscreenElement);
        await viewport.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 740, deviceScaleFactor: 1, mobile: false});
        await page.waitForFunction(total => window.__readFooter()?.total === total, after.total);
        await assertReadingPosition('Exiting fullscreen restores the original text');

        const current = await page.evaluate(() => window.__readFooter().page);
        for (let index = current - 1; index > 0; index--) {
            await page.keyboard.press('PageUp');
            await waitForPage(index - 1);
        }
        const displayedParagraphs = [], clippedPages = [];
        let illustrations = 0;
        for (let index = 0; index < after.total; index++) {
            await waitForPage(index);
            const state = await readRenderedPage(page);
            if (state.freeBottom < -1) clippedPages.push({page: index + 1, excess: -state.freeBottom});
            illustrations += state.images;
            displayedParagraphs.push(...state.paragraphs);
            if (index < after.total - 1) await page.keyboard.press('PageDown');
        }
        await fs.writeJson(path.join(directory, 'result.json'), {before, after, samples, fullscreenPhases, clippedPages, errors,
            regular: {height: regular.height, freeBottom: regular.freeBottom}, immersive: {height: immersive.height, freeBottom: immersive.freeBottom}}, {spaces: 2});
        assert.equal(illustrations, 2, 'The fixture must render both tall illustrations');
        assert.deepEqual(clippedPages, [], 'Every text line fits inside the visible page');
        assert.equal(textHash(displayedParagraphs.join(' ')), textHash(sourceParagraphs.join(' ')),
            'Every paragraph survives pagination in source order');

        const horizontalOffset = await page.evaluate(() => window.__readerBuildPhases.length);
        await settings.click();
        await options.getByRole('button', {name: 'Страница', exact: true}).click();
        await options.getByRole('button', {name: 'Горизонтально', exact: true}).click();
        await settings.click();
        await page.waitForFunction(offset => window.__readerBuildPhases.slice(offset).includes('done'), horizontalOffset);
        const horizontalWidths = await page.evaluate(() => {
            const width = selector => document.querySelector(selector).getBoundingClientRect().width;
            return {visible: width('.reader-page-sheet--live .reader-html'), measured: width('.reader-page-sheet--measure .reader-html')};
        });
        assert.equal(horizontalWidths.measured, horizontalWidths.visible,
            'Horizontal pagination measures text at the visible width after subtracting the side margins');
        // Detaching also clears the emulated viewport on Windows Chromium.
        await viewport.detach();
        assert.deepEqual(errors, []);
        const readerUrl = base + '/#/reader?bookUid=' + encoded + '&debugReader=1';
        await checkDesktopOpening(browser, readerUrl, {});
        await checkDesktopOpening(browser, readerUrl, {pageIndex: 4, percent: .1, textOffset: -1,
            textSnippet: 'Абзац 2.3. Читатель открывает книгу', updatedAt: new Date().toISOString()});
        await checkOpeningWithClippedViewport(browser, readerUrl);
        console.log(`Reader: stable footer (${before.total} → ${after.total} pages) and complete visible text across all ${after.total} pages.`);
    } catch (error) {
        if (page) await page.screenshot({path: path.join(directory, 'failure.png')}).catch(() => {});
        throw error;
    } finally {
        if (browser) await browser.close();
        if (child) child.kill();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
