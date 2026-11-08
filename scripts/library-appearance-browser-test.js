// Optional end-to-end check against an isolated, real library. No user server is modified.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const yazl = require('yazl');
const {unusedPort} = require('./binary-smoke-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function archive(file, entries) {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(file);
    const completed = require('stream/promises').pipeline(zip.outputStream, output);
    for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name);
    zip.end(); await completed;
}

async function fixture(directory) {
    await fs.ensureDir(directory);
    const seedBooks = [
        ['Джордж Оруэлл', '«1984» и эссе разных лет'], ['Лев Толстой', 'Косточка'], ['Иван Тургенев', 'Ася'],
        ['Александр Пушкин', 'Капитанская дочка'], ['Михаил Булгаков', 'Белая гвардия'], ['Антон Чехов', 'Рассказы'],
        ['Николай Гоголь', 'Мёртвые души'], ['Фёдор Достоевский', 'Белые ночи'], ['Михаил Лермонтов', 'Герой нашего времени'],
        ['Александр Грин', 'Алые паруса'], ['Иван Гончаров', 'Обломов'], ['Лев Толстой', 'После бала'],
    ];
    const books = Array.from({length: 3}, (_, edition) => seedBooks.map(([author, title]) => [author, edition ? `${title} · Издание ${edition + 1}` : title])).flat();
    const date = new Date().toISOString().slice(0, 10);
    const rows = books.map(([author, title], index) => [author + ':', 'prose:', title, index % 4 === 0 ? 'Избранные произведения' : '', String(index % 4 + 1), String(index + 1), '100', String(index + 1), '0', 'fb2', date, 'ru', '4', ''].join('\x04'));
    const epubFile = path.join(directory, 'source.epub');
    await require('./epub-fb2-tests').fixture(epubFile);
    const epub = await fs.readFile(epubFile);
    rows.push(['Тестовый Автор:', 'prose:', 'Я. Книга EPUB', '', '', '37', String(epub.length), '37', '0', 'epub', date, 'ru', '4', ''].join('\x04'));
    await archive(path.join(directory, 'sample.inpx'), [['collection.info', 'Библиотека для проверки интерфейса\n'], ['version.info', '20261104'], ['sample.inp', rows.join('\n') + '\n']]);
    await archive(path.join(directory, 'sample.zip'), books.map(([author, title], index) => [`${index + 1}.fb2`, `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>prose</genre><author><first-name>${author}</first-name></author><book-title>${title}</book-title><annotation><p>Книга для проверки интерфейса INPX Reader.</p></annotation><lang>ru</lang></title-info></description><body><section id="chapter"><title><p>Глава первая</p></title>${Array.from({length: 120}, (_, i) => `<p>Абзац ${i + 1}. За окном начиналось утро. Это текст тестовой библиотеки для проверки чтения, сохранения позиции и возвращения к книге.</p>`).join('')}</section></body></FictionBook>`]).concat([['37.epub', epub]]));
    await fs.writeJson(path.join(directory, 'config.json'), {loggingEnabled: false, adminPassword: 'appearance-local-test',
        allowAnonymousAccess: true, onlineReaderEnabled: true, discovery: {enabled: true}});
}

if (require.main === module) (async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-appearance-'));
    await fs.ensureDir(directory);
    let browser, child, output = '';
    const artifacts = [];
    try {
        const library = path.join(directory, 'library'); await fixture(library);
        const dataDir = path.join(directory, 'data'); await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${library}/config.json`, `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'],
            {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, INPX_TTS_ENABLED: 'false',
                INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '', INPX_ADMIN_PASSWORD: 'appearance-local-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS: 'true'}});
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output = (output + data).slice(-10000);});
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const response = await fetch(base + '/ready'); ready = response.ok && (await response.json()).ready;} catch { /* Starting. */ }
            if (ready || child.exitCode !== null) break;
            await pause(500);
        }
        assert(ready, output);
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], actions = [];
        let readingFailure = '', recommendationMode = 'full', recommendationBook = null, heldRecommendation = null;
        await page.routeWebSocket('**/ws', socket => {
            const server = socket.connectToServer(), bookRequests = new Set(), authorRequests = new Set();
            socket.onMessage(message => {
                try {
                    const request = JSON.parse(String(message));
                    if (request.action === 'get-discovery-shelves' && request.recommendationsOnly && recommendationBook) {
                        socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                        const reply = () => socket.send(JSON.stringify({requestId:request.requestId,shelves:recommendationMode === 'empty' ? []
                            : [{id:'similar-books',items:[recommendationBook]}]}));
                        if (recommendationMode === 'hold') heldRecommendation = reply;
                        else reply();
                        return;
                    }
                    if (readingFailure && ['get-mobile-home', 'get-user-reading-library'].includes(request.action)) {
                        socket.send(JSON.stringify({requestId: request.requestId, _rok: 1}));
                        socket.send(JSON.stringify({requestId: request.requestId, error: readingFailure}));
                        return;
                    }
                    if (request.action === 'bookSearch') bookRequests.add(request.requestId);
                    if (request.action === 'get-author-info') authorRequests.add(request.requestId);
                } catch { /* Forward protocol keepalive frames unchanged. */ }
                server.send(message);
            });
            server.onMessage(message => {
                try {
                    const response = JSON.parse(String(message));
                    if (bookRequests.has(response.requestId) && !response._rok) {
                        bookRequests.delete(response.requestId);
                        if (!response.error) {response.totalFound = 661301; socket.send(JSON.stringify(response)); return;}
                    }
                    if (authorRequests.has(response.requestId) && !response._rok) {
                        authorRequests.delete(response.requestId);
                        // Hold the real response briefly to verify the loading UI.
                        setTimeout(() => socket.send(message), 800); return;
                    }
                } catch { /* Forward non-JSON frames unchanged. */ }
                socket.send(message);
            });
        });
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {if (message.text().includes('Failed to resolve component')) errors.push(message.text());});
        page.on('websocket', socket => socket.on('framesent', frame => {try {actions.push(JSON.parse(frame.payload).action);} catch { /* Binary. */ }}));
        const screenshot = async name => {const file = path.join(directory, name + '.png'); await page.screenshot({path: file, animations: 'disabled'}); artifacts.push(file);};
        const api = async source => page.evaluate(async source => {
            const settings = JSON.parse(localStorage.getItem('vuex') || '{}').settings || {};
            const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
            await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
            let sequence = 0, csrfToken = '';
            const request = data => new Promise((resolve, reject) => {
                const requestId = `fixture-${++sequence}`;
                const timer = setTimeout(() => {socket.removeEventListener('message', receive); reject(new Error('Fixture API timeout'));}, 10000);
                function receive(event) {
                    const response = JSON.parse(event.data);
                    if (response.requestId !== requestId || response._rok) return;
                    clearTimeout(timer); socket.removeEventListener('message', receive);
                    if (response.error) reject(new Error(response.error)); else resolve(response);
                }
                socket.addEventListener('message', receive);
                socket.send(JSON.stringify({...data, requestId, csrfToken, userId: settings.currentUserId,
                    profileAccessToken: settings.profileAccessToken, accessToken: settings.accessToken}));
            });
            try {
                csrfToken = (await request({action: 'get-config'})).csrfToken;
                return await new Function('root', `return (async()=>{${source}})()`)({api: {
                    search: (from, query) => request({action: 'search', from, query}),
                    updateReaderProgress: (bookUid, progress) => request({action: 'update-reader-progress', bookUid, progress}),
                }});
            } finally {socket.close();}
        }, source);
        await page.goto(base + '/#/?lang=ru');
        await page.locator('.search-list-toggle').waitFor();
        assert.equal(await page.locator('.library-shell--active').count(), 0, 'Classic is the default');
        await page.getByRole('note', {name: 'Новое оформление библиотеки'}).waitFor();
        await page.getByRole('button', {name: 'Скрыть подсказку об оформлении', exact: true}).click();
        await page.reload(); await page.locator('.search-list-toggle').waitFor();
        assert.equal(await page.locator('.appearance-hint').count(), 0, 'Hint dismissal persists in this browser');
        assert.equal(await page.locator('.author-group').count(), 0, 'Default catalog displays books, not authors');
        await page.locator('.profile-login-action,.profile-status-chip').first().click();
        await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
        await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('appearance-local-test');
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.locator('.profile-controls .profile-logout').waitFor();
        const uids = await api(`const response = await root.api.search('title', {lang:'ru',limit:40}); const books = response.found.flatMap(item=>item.books||[]); return books.map(book=>book._uid);`);
        assert(uids.length >= 8, 'Fixture must contain real indexed books');
        recommendationBook = await api(`const response = await root.api.search('title', {lang:'ru',limit:40}); return response.found.flatMap(item=>item.books||[])[8];`);
        await api(`const uids=${JSON.stringify(uids)}; for(let i=0;i<4;i++) await root.api.updateReaderProgress(uids[i], {percent:[.34,.14,.01,1][i],sectionId:'chapter'}); return true;`);

        await page.getByRole('button', {name: 'Настройки', exact: true}).click();
        for (const name of ['Автоматически загружать отзывы и оценки', 'Автоматически загружать сведения об авторе']) {
            const option = page.getByRole('checkbox', {name, exact:true});
            assert.equal(await option.getAttribute('aria-checked'), 'false'); await option.click();
        }
        await page.waitForFunction(() => {const s = JSON.parse(localStorage.getItem('vuex') || '{}').settings; return s?.autoLoadBookReviews && s?.autoLoadAuthorInfo;});
        await page.reload(); await page.locator('.search-list-toggle').waitFor();
        await page.getByRole('button', {name: 'Настройки', exact: true}).click();
        for (const name of ['Автоматически загружать отзывы и оценки', 'Автоматически загружать сведения об авторе']) {
            const option = page.getByRole('checkbox', {name, exact:true});
            assert.equal(await option.getAttribute('aria-checked'), 'true', 'Opt-in persists'); await option.click();
        }
        await page.getByRole('button', {name: /^Новый дизайн/}).click();
        await page.getByRole('navigation', {name: 'Разделы библиотеки'}).waitFor();
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await page.locator('.current-book').waitFor();
        await page.locator('.book-shelf').first().waitFor();
        await page.waitForFunction(() => !document.querySelector('.overview-loading'));
        const recommendations = page.locator('#recommended-books-heading');
        await recommendations.waitFor();await screenshot('overview-recommendations-light-1440');
        recommendationMode = 'empty';await page.getByRole('button', {name:'Обновить',exact:true}).click();
        await recommendations.waitFor({state:'hidden'});
        assert(await page.getByRole('heading',{name:/Новинки/}).count(), 'Empty recommendations leave global shelves visible');
        recommendationMode = 'hold';await page.getByRole('button', {name:'Обновить',exact:true}).click();
        for(let i=0;i<100&&!heldRecommendation;i++)await pause(30);assert(heldRecommendation);
        assert.equal(await recommendations.count(),0);assert(await page.locator('.current-book').isVisible());
        assert(await page.getByRole('heading',{name:/Новинки/}).count(), 'Pending recommendations do not block global shelves');
        recommendationMode = 'full';heldRecommendation();heldRecommendation = null;await recommendations.waitFor();
        assert(await page.locator('.book-shelf').count() >= 2, 'Home must render server discovery shelves in addition to recent books');
        assert(await page.getByRole('heading', {name: /Новинки/}).count() >= 1, 'Server shelf titles must reach the UI');
        assert.equal(await page.locator('.current-book progress').getAttribute('value'), '0.01', 'Most recently opened unfinished book is current');
        const currentTitle = await page.locator('.current-book__title').innerText();
        assert.equal(await page.locator('#recent-books-heading').locator('..').locator('..').getByRole('button', {name: `Открыть карточку: ${currentTitle}`, exact: true}).count(), 0, 'Current book is not repeated in recents');
        for (const cover of [page.locator('.current-book__cover'), page.locator('.book-tile__open').first()]) {
            const previousUrl = page.url();
            await cover.click();
            await page.locator('.library-book-actions').waitFor();
            assert.equal(page.url(), previousUrl, 'Cover previews the book without replacing the current page');
            const preview = page.locator('.library-dialog-card[data-dialog-kind="book"]');
            await preview.getByRole('button', {name: 'Поделиться книгой', exact: true}).click();
            assert((await page.getByRole('menuitem', {name: 'Открыть страницу книги', exact: true}).getAttribute('href')).includes('#/book?bookUid='));
            await page.keyboard.press('Escape');
            await screenshot('book-preview-light-1440');
            await preview.getByRole('button', {name: 'Закрыть окно', exact: true}).click();
            await preview.waitFor({state: 'hidden'});
            await page.locator('.current-book').waitFor();
        }
        assert.equal(actions.filter(action => ['get-author-info', 'get-book-reviews'].includes(action)).length, 0,
            'Cards do not load optional details by default');
        await page.locator('.current-book__cover').click();
        await page.getByRole('button', {name: 'Поделиться книгой', exact: true}).click();
        await page.getByRole('menuitem', {name: 'Открыть страницу книги', exact: true}).click();
        await page.locator('.catalog-book-details').waitFor();
        await page.getByRole('tab', {name:'Отзывы и оценки', exact:true}).click();
        await page.getByText('Отзывов пока нет.', {exact:true}).waitFor();
        assert.equal(actions.filter(action => action === 'get-book-reviews').length, 1);
        await page.getByRole('tab', {name:'Об авторе', exact:true}).click();
        await page.locator('.author-tab-wrap .loading-state').waitFor();
        assert.equal(await page.locator('.author-tab-wrap .icon-rotate').count(), 0, 'The author uses the shared loading state');
        assert.equal(await page.locator('.info-tabs.bg-grey-4').count(), 0, 'Tabs use theme variables instead of the old grey strip');
        await screenshot('author-loading-light-1440');
        await page.getByText('Информация об авторе не найдена.', {exact:true}).waitFor();
        await screenshot('author-empty-light-1440');
        assert.equal(actions.filter(action => action === 'get-author-info').length, 1);
        await page.getByRole('tab', {name:'Отзывы и оценки', exact:true}).click();
        assert.equal(actions.filter(action => action === 'get-book-reviews').length, 1, 'Changing tabs reuses current details');
        await page.goBack(); await page.locator('.current-book').waitFor();

        await page.getByRole('link', {name: 'Открыть мой профиль', exact: true}).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('heading', {name: 'Профиль', exact: true}).waitFor();
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        for (const [width, height] of [[3415, 1440], [2560, 1440], [1440, 1000], [900, 1000], [390, 844], [320, 780]]) {
            await page.setViewportSize({width, height}); await pause(200);
            const geometry = await page.evaluate(() => {
                const main = document.querySelector('.library-shell__main'), page = document.querySelector('.library-page');
                return {viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, mainWidth: main.clientWidth, pageWidth: page.scrollWidth,
                    bodyWidth: document.querySelector('.library-page__body').clientWidth, shelfColumns: getComputedStyle(document.querySelector('.overview-shelves')).gridTemplateColumns.split(' ').length};
            });
            assert(geometry.documentWidth <= width + 1 && geometry.pageWidth <= geometry.mainWidth + 1, JSON.stringify(geometry));
            if (width >= 1800) assert(geometry.bodyWidth >= geometry.mainWidth - 80, 'Overview must use the available width');
            if (width >= 900) {
                assert(await page.locator('.library-shell__nav-bottom strong').evaluate(node => node.scrollWidth <= node.clientWidth), 'Profile name is not clipped');
                assert(await page.locator('.library-shell__nav-bottom small').evaluate(node => node.getBoundingClientRect().height <= 16 && node.scrollWidth <= node.clientWidth), 'Profile subtitle fits on one line');
            }
            assert.equal(geometry.shelfColumns, 1, 'Every discovery shelf gets a full row');
            const recent = page.locator('.book-shelf').filter({has: page.locator('#recent-books-heading')});
            const heading = await recent.locator('h2').boundingBox(), all = await recent.getByRole('link', {name: 'Все', exact: true}).boundingBox();
            assert(all.x - heading.x - heading.width < 24, 'All stays next to its shelf title');
            if (await recent.locator('.book-shelf__strip').evaluate(node => node.scrollWidth <= node.clientWidth + 2))
                assert.equal(await recent.locator('.book-shelf__actions').count(), 0, 'Short shelves have no detached arrows');
            await screenshot(`shelves-light-${width}`);
        }
        await page.setViewportSize({width: 390, height: 844});
        await page.getByRole('button', {name: 'Включить тёмную тему', exact: true}).click();
        await pause(400);
        assert.equal(await page.locator('.library-brand').innerText(), 'INPX Web');
        assert.equal(await page.locator('.library-brand__mark').evaluate(node => node.complete && node.naturalWidth > 0), true, 'Android application icon loads');
        await screenshot('shelves-dark-390');
        await page.locator('.current-book__caption button').click();
        await page.locator('.library-book-actions').waitFor();
        const dialog = page.locator('.library-dialog-card[data-dialog-kind="book"]');
        assert((await dialog.boundingBox()).height < 700, 'The action card must fit the phone without reserved poster space');
        await screenshot('book-preview-dark-390');
        assert.equal(await dialog.locator('.book-actions-secondary, .book-actions-card-link').count(), 0);
        await dialog.getByRole('button', {name: 'Полки и статус', exact: true}).click();
        await page.getByRole('menuitem', {name: 'Прочитано', exact: true}).waitFor();
        assert.equal(await page.getByRole('menuitem', {name: 'Снять отметку', exact: true}).count(), 0);
        await page.keyboard.press('Escape');
        await page.getByRole('button', {name: 'Полное описание', exact: true}).click();
        await page.getByText('Книга для проверки интерфейса INPX Reader.', {exact: true}).waitFor();
        await page.getByRole('button', {name: 'Назад к книге', exact: true}).click();
        await dialog.waitFor();
        await dialog.getByRole('button', {name: 'Закрыть окно', exact: true}).click();
        assert.equal(await page.locator('body').getAttribute('data-catalog-appearance'), 'shelves');
        await page.getByRole('link', {name: 'Мои книги', exact: true}).click();
        await page.locator('.books-grid .book-tile').first().waitFor();
        await page.locator('.books-grid .book-tile__open').first().click();
        await page.locator('.library-book-actions').waitFor();
        assert(page.url().includes('#/my-books'), 'The book preview keeps the selected shelf open');
        await page.locator('.library-dialog-card[data-dialog-kind="book"]').getByRole('button', {name: 'Закрыть окно', exact: true}).click();
        await page.locator('.books-grid .book-tile').first().waitFor();
        await page.getByRole('link', {name: 'Профиль', exact: true}).click();
        await page.locator('.profile-card').waitFor();
        await screenshot('profile-dark-390');
        for (const [label, kind] of [['Профили и личные настройки', 'profiles'], ['Полки и списки чтения', 'reading-lists']]) {
            await page.getByRole('button', {name: new RegExp('^' + label)}).click();
            const panel = page.locator(`.library-dialog-card[data-dialog-kind="${kind}"]`);
            await panel.waitFor(); await pause(350);
            if (kind === 'profiles') {
                assert.equal(await panel.locator('.profile-card--current').getByRole('button', {name: 'Выбрать', exact: true}).count(), 0, 'Current profile cannot be selected again');
                assert.equal(await panel.locator('.opds-link').count(), 0, 'Admin profile is not offered as a public OPDS profile');
                await panel.getByRole('button', {name: 'Новый профиль', exact: true}).click();
                await panel.getByRole('textbox', {name: 'Имя профиля', exact: true}).fill('Отменённый профиль');
                assert.equal(await panel.locator('.profiles-box').count(), 0, 'Creation has its own screen, not a form above the profile list');
                assert.equal(await panel.getByRole('textbox', {name: 'Email для отправки', exact: true}).isVisible(), false, 'Optional creation fields start collapsed');
                await screenshot('profile-create-dark-390');
                await panel.locator('.profile-create-extra summary').click();
                await panel.getByRole('textbox', {name: 'Email для отправки', exact: true}).waitFor();
                await screenshot('profile-create-expanded-dark-390');
                await panel.getByRole('button', {name: 'Отмена', exact: true}).click();
                await panel.getByRole('button', {name: 'Новый профиль', exact: true}).click();
                assert.equal(await panel.getByRole('textbox', {name: 'Имя профиля', exact: true}).inputValue(), '', 'Cancel clears the unsaved profile');
                await panel.getByRole('textbox', {name: 'Имя профиля', exact: true}).fill('Браузерный профиль');
                await panel.getByRole('textbox', {name: 'Логин', exact: true}).fill('browser-profile');
                await panel.getByRole('textbox', {name: 'Пароль', exact: true}).fill('browser-profile-password');
                await panel.getByRole('button', {name: 'Создать', exact: true}).click();
                const createdProfile = panel.locator('.profile-card').filter({hasText: 'Браузерный профиль'});
                await createdProfile.waitFor();
                await createdProfile.getByRole('button', {name: 'Выбрать', exact: true}).click();
                await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('browser-profile');
                await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('browser-profile-password');
                await page.getByRole('button', {name: 'OK', exact: true}).click();
                await panel.locator('.profile-card--current').filter({hasText: 'Браузерный профиль'}).waitFor();
                assert.equal(await panel.getByRole('button', {name: 'Новый профиль', exact: true}).count(), 0, 'Ordinary profiles cannot manage other profiles');
                await panel.getByRole('button', {name: 'Войти в другой профиль', exact: true}).click();
                await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
                await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('appearance-local-test');
                await page.getByRole('button', {name: 'OK', exact: true}).click();
                await panel.getByRole('button', {name: 'Новый профиль', exact: true}).waitFor();
                assert.equal(await panel.locator('.dialog-box').evaluate(node => getComputedStyle(node).overflowY), 'visible', 'Only the dialog body scrolls');
                await panel.locator('.profile-card--current').getByRole('button', {name: 'Настройки', exact: true}).click();
                await panel.getByRole('button', {name: 'Сохранить изменения', exact: true}).click();
                await panel.getByRole('button', {name: 'Сохранить изменения', exact: true}).waitFor({state: 'visible'});
                await panel.locator('.profile-card--current').getByRole('button', {name: 'Чтение', exact: true}).click();
                await page.setViewportSize({width: 1440, height: 1000});
                await screenshot('profiles-dark-1440');
                await page.setViewportSize({width: 390, height: 844});
            }
            const bounds = await panel.evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height}));
            assert(bounds.scroll <= bounds.width + 1 && bounds.height <= 844 - 24, kind + ' must fit a phone');
            await screenshot(`${kind}-dark-390`);
            await panel.getByRole('button', {name: 'Закрыть окно', exact: true}).click();
            await panel.waitFor({state: 'hidden'});
        }
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await page.locator('.current-book').waitFor();
        await page.waitForFunction(() => !document.querySelector('.overview-loading'));
        const discoveryBefore = actions.filter(action => action === 'get-discovery-shelves').length;
        await page.getByRole('link', {name: 'Профиль', exact: true}).click();
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await page.locator('.current-book').waitFor();
        assert.equal(actions.filter(action => action === 'get-discovery-shelves').length, discoveryBefore, 'Navigation reuses cached shelves');

        await page.getByRole('button', {name: 'Читать', exact: true}).click();
        await page.waitForURL(/#\/reader\?bookUid=/);
        assert.equal(await page.locator('body').getAttribute('data-catalog-appearance'), null, 'Reading appearance is independent');
        await page.goBack();
        await page.locator('.current-book').waitFor();
        await api(`await root.api.updateReaderProgress(${JSON.stringify(uids[2])}, {percent:.52,sectionId:'chapter'}); return true;`);
        await page.getByRole('button', {name: 'Обновить', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.current-book progress')?.value === .52);

        readingFailure = 'temporary_offline';
        await page.getByRole('button', {name: 'Обновить', exact: true}).click();
        const notice = page.locator('.library-notice-card');
        await notice.getByRole('heading', {name: 'Не удалось обновить историю', exact: true}).waitFor();
        assert(!(await notice.innerText()).includes('temporary_offline'));
        assert.equal(await page.locator('.current-book').count(), 1, 'Retryable failures retain history');
        await notice.scrollIntoViewIfNeeded();
        await screenshot('history-error-dark-390');
        readingFailure = '';
        await notice.getByRole('button', {name: 'Повторить', exact: true}).click();
        await notice.waitFor({state: 'hidden'});
        readingFailure = 'need_profile_login';
        await page.getByRole('button', {name: 'Обновить', exact: true}).click();
        await notice.getByRole('button', {name: 'Войти в профиль', exact: true}).waitFor();
        assert(!(await notice.innerText()).includes('need_profile_login'));
        assert.equal(await notice.getByRole('button', {name: 'Повторить', exact: true}).count(), 0);
        assert.equal(await page.locator('.current-book').count(), 0, 'Expired credentials cannot leave private history visible');
        assert(await page.locator('.overview-shelves .book-shelf').count() > 0, 'Discovery remains available');
        await notice.scrollIntoViewIfNeeded();
        await screenshot('history-login-dark-390');
        await page.getByRole('link', {name: 'Мои книги', exact: true}).click();
        await notice.getByRole('button', {name: 'Войти в профиль', exact: true}).waitFor();
        assert.equal(await page.locator('.books-grid .book-tile').count(), 0, 'My books respects expired history access');
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await notice.getByRole('button', {name: 'Войти в профиль', exact: true}).waitFor();
        await notice.getByRole('button', {name: 'Войти в профиль', exact: true}).click();
        await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
        await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('appearance-local-test');
        readingFailure = '';
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.locator('.current-book').waitFor();
        await notice.waitFor({state: 'hidden'});

        await page.getByRole('link', {name: 'Каталог', exact: true}).click();
        await page.locator('.library-result-card').first().waitFor();
        const catalogBeforePreview = page.url();
        await page.locator('.library-result-card__cover').first().click();
        await page.locator('.library-book-actions').waitFor();
        assert.equal(page.url(), catalogBeforePreview, 'Catalog cover previews preserve the active search URL');
        await page.locator('.library-dialog-card[data-dialog-kind="book"]').getByRole('button', {name: 'Закрыть окно', exact: true}).click();
        await page.locator('.library-result-card').first().waitFor();
        assert.equal(await page.locator('.search-scroll > .separator:visible').count(), 0, 'Pagination has no extra separator');
        assert(await page.locator('.catalog-search-panel__section').evaluate(node => node.classList.contains('q-field--outlined')), 'Catalog section has a visible outline');
        await page.locator('.catalog-search-panel__section').click();
        await page.getByRole('option', {name: 'Все книги', exact: true}).click();
        await page.waitForFunction(() => document.title.startsWith('Все книги:'));
        assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), 'favicon.ico?v=catalog-icon-5');
        await page.goBack(); await page.locator('.current-book').waitFor();
        assert.equal(await page.title(), 'Обзор · INPX Web');
        await page.goForward(); await page.locator('.library-result-card').first().waitFor();
        await page.waitForFunction(() => document.title.startsWith('Все книги:'));
        for (const width of [3415, 1440, 900, 760, 640, 600, 514, 390, 320]) {
            await page.setViewportSize({width, height: 600}); await pause(150);
            const bounds = await page.evaluate(() => {
                const bar = document.querySelector('.result-bar'), rect = bar.getBoundingClientRect();
                const controls = Array.from(bar.querySelectorAll('.library-pagination, .text-bold')).map(node => node.getBoundingClientRect());
                const bulk = document.querySelector('.bulk-read-toolbar').getBoundingClientRect();
                const mode = document.querySelector('.catalog-text-field__mode');
                const text = mode.querySelector('.q-field__native').getBoundingClientRect(), arrow = mode.querySelector('.q-select__dropdown-icon').getBoundingClientRect();
                return {bottom: rect.bottom, controlsBottom: Math.max(...controls.map(node => node.bottom)), bulkTop: bulk.top,
                    modeCenter: text.y + text.height / 2, arrowCenter: arrow.y + arrow.height / 2, width: innerWidth, scroll: document.documentElement.scrollWidth};
            });
            assert(bounds.controlsBottom <= bounds.bottom + 1 && bounds.bulkTop >= bounds.bottom - 1, 'Catalog bars overlap: ' + JSON.stringify(bounds));
            assert(Math.abs(bounds.modeCenter - bounds.arrowCenter) < 2, 'Matching mode and arrow must align: ' + JSON.stringify(bounds));
            assert(bounds.scroll <= width + 1, 'Catalog must fit the viewport');
            await screenshot(`pagination-${width}`);
        }
        await page.setViewportSize({width: 390, height: 844});
        const paginator = page.getByRole('navigation', {name: 'Страницы каталога', exact: true}).first();
        await paginator.getByRole('button', {name: 'Следующая страница', exact: true}).click();
        await page.waitForURL(/page=2/);
        await paginator.getByRole('textbox', {name: 'Номер страницы', exact: true}).fill('1');
        await paginator.getByRole('button', {name: 'Перейти на страницу', exact: true}).click();
        await page.waitForURL(url => !url.hash.includes('page=2'));
        await page.getByRole('combobox', {name: 'Название книги', exact: true}).fill('Ася');
        await page.waitForURL(/title=/);
        await page.locator('.catalog-text-field__mode').first().click();
        await page.getByRole('option', {name: 'Точно', exact: true}).click();
        await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('title') === '=Ася');
        await page.locator('.catalog-text-field__mode').first().click();
        await page.getByRole('option', {name: 'Содержит', exact: true}).click();
        await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('title') === '*Ася');
        await page.getByRole('button', {name: /Автор и серия/}).click();
        await page.getByRole('combobox', {name: 'Автор', exact: true}).fill('Иван');
        await page.waitForURL(/author=/);
        await page.getByRole('button', {name: /^Фильтры/}).click();
        await page.getByRole('textbox', {name: 'Число голосов', exact: true}).fill('10..100');
        await page.getByRole('button', {name: 'Отмена', exact: true}).click();
        assert(!page.url().includes('ratingCount'), 'Cancel preserves the active query');
        await page.getByRole('button', {name: /^Фильтры/}).click();
        assert.equal(await page.getByRole('textbox', {name: 'Число голосов', exact: true}).inputValue(), '', 'Canceled filter draft is discarded');
        await page.getByRole('textbox', {name: 'Число голосов', exact: true}).fill('0..100');
        await page.getByRole('button', {name: 'Применить', exact: true}).click();
        await page.waitForURL(/ratingCount=/);
        await page.locator('.catalog-search-panel__chips .q-chip').filter({hasText: 'Число голосов'}).locator('.q-chip__icon--remove').click();
        await page.waitForURL(url => !url.hash.includes('ratingCount'));
        await page.locator('.library-result-card').first().waitFor();
        assert((await page.locator('.library-result-card').first().boundingBox()).height < 320, 'Mobile result is a compact book row');
        await screenshot('catalog-dark-390');
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await page.getByRole('link', {name: 'Каталог', exact: true}).click();
        assert.equal(await page.getByRole('combobox', {name: 'Название книги', exact: true}).inputValue(), 'Ася', 'Catalog navigation preserves the query');
        assert.equal(await page.getByRole('combobox', {name: 'Автор', exact: true}).inputValue(), 'Иван');
        await page.goto(base + '/#/books?ext=epub');
        const epubCard = page.locator('.library-result-card').filter({hasText: 'Я. Книга EPUB'});
        await epubCard.waitFor();
        await epubCard.getByRole('button', {name: 'Открыть карточку: Я. Книга EPUB', exact: true}).click();
        await page.locator('.library-book-actions').waitFor();
        const formats = page.locator('.book-actions-formats');
        await formats.click(); await page.getByRole('option', {name: 'FB2', exact: true}).click();
        const fb2Href = await page.locator('.book-actions-download').getAttribute('href');
        const download = await page.request.get(new URL(fb2Href, base).href);
        assert.equal(download.status(), 200);
        assert((await download.text()).includes('Текст второй главы'), 'FB2 download contains the original EPUB text');
        assert((download.headers()['content-disposition'] || '').includes('.fb2'), 'Converted download has the FB2 extension');
        await page.locator('.library-book-actions').getByRole('button', {name: 'Читать', exact: true}).click();
        await page.waitForURL(/#\/reader\?bookUid=/);
        const readerUrl = page.url();
        await page.locator('.reader-body').getByText(/Текст второй главы/).first().waitFor();
        await page.waitForFunction(() => !document.querySelector('.reader-loading,.reader-reflow-indicator,.reader-error'));
        await page.reload();
        await page.locator('.reader-body').getByText(/Текст второй главы/).first().waitFor();
        await page.waitForFunction(() => !document.querySelector('.reader-loading,.reader-reflow-indicator,.reader-error'));
        await page.waitForFunction(() => {const cover = document.querySelector('.reader-cover'); return cover?.complete && cover.naturalWidth > 0;});
        assert.equal(page.url(), readerUrl, 'Converted EPUB retains its original UID when reopening');
        await screenshot('epub-reader-dark-390');
        await page.goBack(); await epubCard.waitFor();
        for (const [section, ready] of [['author', '.author-group'], ['series', '.series-group'], ['title', '.library-result-card'], ['extended', '.library-result-card'], ['for-you', '.discovery-shelf'], ['newest', '.discovery-shelf'], ['popular', '.discovery-shelf'], ['bestsellers', '.library-result-card']]) {
            await page.setViewportSize({width: 1440, height: 1000});
            await page.goto(base + '/#/' + section + '?lang=ru');
            await page.locator(ready).first().waitFor();
            if (section === 'author' || section === 'series') {
                const expand = page.getByRole('button', {name: new RegExp(section === 'author' ? '^Развернуть автора:' : '^Развернуть серию:')}).first();
                if (await expand.count()) await expand.click();
                await page.locator('.library-result-card').first().waitFor();
            }
            await screenshot(`section-${section}-1440`);
            await page.setViewportSize({width: 390, height: 844});
            await pause(150);
            assert.equal(await page.locator('.page-scroller-control:visible').count(), 0, 'Legacy paginator must not leak into shelves pages');
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), section + ' overflows the phone');
            await screenshot(`section-${section}-390`);
        }
        await page.getByRole('button', {name: 'Настройки библиотеки', exact: true}).click();
        await page.locator('.library-dialog-card[data-dialog-kind="settings"]').waitFor();
        const settingsBounds = await page.locator('.library-dialog-card[data-dialog-kind="settings"]').evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height}));
        assert(settingsBounds.scroll <= settingsBounds.width + 1 && settingsBounds.height <= 844 - 24, 'Settings must fit a phone');
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.getByRole('link', {name: 'Профиль', exact: true}).click();
        await page.getByRole('button', {name: /^Классический/}).click();
        await page.locator('.search-list-toggle').waitFor();
        assert.equal(await page.locator('.library-shell--active').count(), 0);
        assert.equal(await page.locator('.appearance-hint').count(), 0, 'Users who tried the new design do not see the hint again');
        await page.reload(); await page.locator('.search-list-toggle').waitFor();
        assert.equal(await page.locator('.library-shell--active').count(), 0, 'Classic selection persists');
        await screenshot('classic-dark-390');

        await page.getByRole('button', {name: 'Настройки', exact: true}).click();
        await page.getByRole('button', {name: /^Новый дизайн/}).click();
        await page.getByRole('link', {name: 'Профиль', exact: true}).click();
        await page.locator('.profile-card').waitFor();
        await page.locator('.profile-bottom .profile-logout').click();
        await page.waitForLoadState('domcontentloaded');
        await page.getByRole('link', {name: 'Обзор', exact: true}).waitFor();
        await page.getByRole('link', {name: 'Обзор', exact: true}).click();
        await page.locator('.overview-welcome').waitFor();
        assert.equal(await page.locator('.current-book').count(), 0, 'Logout clears private reading history');
        assert.equal(await recommendations.count(), 0, 'Logout clears private recommendations');
        await page.reload(); await page.locator('.overview-welcome').waitFor();
        assert.equal(await page.locator('.library-shell--active').count(), 1, 'Shelves selection persists');
        const fresh = await browser.newPage({viewport: {width: 390, height: 844}});
        await fresh.goto(base + '/#/');
        await fresh.getByRole('button', {name: 'Переключить дизайн', exact: true}).click();
        await fresh.getByRole('navigation', {name: 'Разделы библиотеки'}).waitFor();
        await fresh.reload(); await fresh.locator('.library-shell--active').waitFor();
        assert.equal(await fresh.locator('.appearance-hint').count(), 0);
        await fresh.close();
        assert.deepEqual(errors, []);
        await fs.writeJson(path.join(directory, 'result.json'), {base, artifacts, errors, actions}, {spaces: 2});
        console.log(`Library appearance: classic/shelves, persistence, mobile/tablet/desktop, light/dark, reading progress, catalog query, cached shelves and logout passed. Artifacts: ${directory}`);
    } catch (error) {
        if (browser) {const pages = browser.contexts().flatMap(context => context.pages()); if (pages[0]) {await pages[0].screenshot({path: path.join(directory, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(directory, 'failure.html'), await pages[0].content());}}
        console.error(output); throw error;
    } finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {fixture, archive};
