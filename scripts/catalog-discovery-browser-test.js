const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {unusedPort} = require('./binary-smoke-test');
const {archive} = require('./library-appearance-browser-test');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(directory) {
    await fs.ensureDir(directory);
    const entries = [
        ['Толстой Лев', 'Косточка', 'Рассказы', 1, 'ru'], ['Толстой Лев', 'После бала', 'Рассказы', 2, 'ru'],
        ['Тургенев Иван', 'Ася', '', 0, 'ru'],
        ['Толстой Лев', 'Childhood', 'Рассказы', 3, 'en'],
        ['Туман Автор', 'Туман над рекой', 'Туман серия', 1, 'ru'],
        ...Array.from({length: 240}, (_, i) => [`Корнеев Автор${String(i).padStart(4, '0')}`, `Книга указателя ${i}`, `Коллекция ${i}`, 1, 'ru']),
    ];
    const rows = [], files = [], date = new Date().toISOString().slice(0, 10);
    for (const [index, [author, title, series, number, lang]] of entries.entries()) {
        // Distinct tiny PNG payloads exercise the real preview cap without a large fixture.
        const images = index === 0 ? Array.from({length:20}, (_, id) => ({id:'illustration-' + id, data:Buffer.concat([
            Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64'), Buffer.from([id]),
        ]).toString('base64')})) : [];
        const book = `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><author><first-name>${author}</first-name></author><book-title>${title}</book-title><annotation><p>Аннотация для браузерной проверки.</p></annotation><lang>${lang}</lang><sequence name="${series}" number="${number}"/></title-info></description><body><section><title><p>Глава первая</p></title><p>Текст книги для проверки.</p>${images.map(image => `<image l:href="#${image.id}"/>`).join('')}</section></body>${images.map(image => `<binary id="${image.id}" content-type="image/png">${image.data}</binary>`).join('')}</FictionBook>`;
        rows.push([author + ':', 'prose:', title, series, String(number), String(index + 1), String(Buffer.byteLength(book)), String(index + 1), '0', 'fb2', date, lang, '4', ''].join('\x04'));
        files.push([`${index + 1}.fb2`, book]);
    }
    await archive(path.join(directory, 'sample.inpx'), [['collection.info', 'Проверка новых возможностей\n'], ['version.info', '20261107'], ['sample.inp', rows.join('\n') + '\n']]);
    await archive(path.join(directory, 'sample.zip'), files);
    await fs.writeJson(path.join(directory, 'config.json'), {loggingEnabled: false, allowAnonymousAccess: true,
        onlineReaderEnabled: true, discovery: {enabled: true}, telegramBotEnabled: false});
}

(async() => {
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-discovery-browser-'));
    await fs.ensureDir(directory);
    let child, browser, output = '';
    try {
        const library = path.join(directory, 'library'); await fixture(library);
        const dataDir = path.join(directory, 'data'); await fs.copy(path.resolve('dist/tmp/public'), path.join(dataDir, 'public'));
        assert(await fs.pathExists(path.join(dataDir,'public/index.html')), 'Build the production UI before copying browser fixtures');
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [path.resolve('server'), `--data-dir=${dataDir}`, `--config=${library}/config.json`, `--lib-dir=${library}`, `--port=${port}`, '--host=127.0.0.1'],
            {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, INPX_TTS_ENABLED: 'false', INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
                INPX_ADMIN_PASSWORD: 'discovery-browser-test', INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ALLOW_ANONYMOUS_ACCESS: 'true', INPX_TELEGRAM_BOT_ENABLED: 'false', TELEGRAM_BOT_TOKEN: ''}});
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output = (output + data).slice(-16000);});
        let ready = false;
        for (let i = 0; i < 120; i++) {
            try {const response = await fetch(base + '/ready'); ready = response.ok && (await response.json()).ready;} catch { /* Booting. */ }
            if (ready || child.exitCode !== null) break; await pause(500);
        }
        assert(ready, output);
        assert(!await fs.pathExists(path.join(dataDir, 'db/catalog_lookup')), 'Startup must not build an unused suggestions index');
        browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
        const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
        let externalFixture = false;
        let cardGridFixture = false;
        const gridBooks = Array.from({length:6}, (_, index) => ({_uid:`card-grid-${index}`, ext:'fb2', lang:'ru', genre:'prose', size:300,
            title:index === 0 ? 'Сетка 0. ' + 'Очень длинное название сборника разных произведений '.repeat(6) + 'Конец названия' : `Сетка ${index}. Короткая книга`,
            author:index === 0 || index === 2 ? Array.from({length:40}, (_, author) => `Автор ${author + 1} Фамилия Имя Отчество`).join(', ') : 'Краткий Автор',
            series:index === 0 || index === 2 ? 'Длинная серия со всеми важными подробностями '.repeat(5) + 'Конец серии' : '',
        }));
        let galleryFixture = 'actual';
        const suggestionRequests = new Map();
        const suggestionScopes = [];
        const invalidBookRequests = [];
        const inactiveReaderRequests = [];
        await page.routeWebSocket('**', socket => {
            const server = socket.connectToServer(), suggestions = new Map(), configs = new Set(), galleries = new Set();
            socket.onMessage(message => {
                const request = JSON.parse(String(message));
                if (request.action === 'get-book-info' && !request.bookUid) invalidBookRequests.push({card: request.card, readerOnly: request.readerOnly, url: page.url()});
                if (request.action === 'get-book-info' && request.readerOnly && !page.url().includes('#/reader')) inactiveReaderRequests.push(request.bookUid);
                if (request.action === 'catalog-suggest') {
                    suggestions.set(request.requestId, request.options);
                    suggestionScopes.push({query:request.options.query,kind:request.options.kind,filters:request.options.filters});
                    suggestionRequests.set(request.options.query, (suggestionRequests.get(request.options.query) || 0) + 1);
                }
                if (request.action === 'get-config') configs.add(request.requestId);
                if (cardGridFixture && request.action === 'bookSearch') {
                    socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                    socket.send(JSON.stringify({requestId:request.requestId,found:gridBooks,totalFound:gridBooks.length,inpxHash:'card-grid-fixture'}));
                    return;
                }
                if (request.action === 'get-book-gallery') galleries.add(request.requestId);
                if (externalFixture && request.action === 'get-discovery-shelves') {
                    socket.send(JSON.stringify({requestId: request.requestId, _rok: 1}));
                    socket.send(JSON.stringify({requestId: request.requestId, shelves: [{id: 'external', source: 'external', sourceName: 'Тестовая витрина',
                        title: 'Тестовая витрина', updatedAt: Date.now(), items: Array.from({length: 48}, (_, id) => ({id, title: `Тестовая книга ${id + 1}`,
                            author: 'Тестовый автор', ext: 'fb2', discoveryMissingLocal: true}))}]}));
                    return;
                }
                server.send(message);
            });
            server.onMessage(message => {
                const response = JSON.parse(String(message));
                if (configs.has(response.requestId) && !response._rok) {
                    configs.delete(response.requestId);
                    if (externalFixture) {
                        response.discovery = {...response.discovery, enabled: true, externalSource: 'web-page', externalName: 'Тестовая витрина', externalUrl: 'https://example.invalid/catalog'};
                        socket.send(JSON.stringify(response)); return;
                    }
                }
                if (suggestions.has(response.requestId) && !response._rok) {
                    const {query,kind} = suggestions.get(response.requestId);
                    suggestions.delete(response.requestId);
                    // Compatibility: an older server's warming response must not make the client poll.
                    if (query === 'Тест') message = JSON.stringify({requestId:response.requestId, query, warming:true, groups:[], corrections:[], progress:{done:20, total:100}});
                    else if (query === 'Кост') message = JSON.stringify({...response, limited:true});
                    else if (query === 'Туман' && kind === 'title') message = JSON.stringify({...response,
                        groups:[...response.groups,{kind:'author',items:[{name:'Туман лишний автор',count:1}]},{kind:'series',items:[{name:'Туман лишняя серия',count:1}]}],
                        corrections:[{kind:'author',query:'Туман лишняя коррекция'}]});
                    // A real library can respond after the 500 ms automatic search changes the route.
                    setTimeout(() => socket.send(message), 800); return;
                }
                if (galleries.has(response.requestId) && !response._rok) {
                    galleries.delete(response.requestId);
                    if (galleryFixture === 'empty-limited') message = JSON.stringify({...response, images:[], limited:true, omitted:20});
                }
                socket.send(message);
            });
        });
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {if (/Failed to resolve component/.test(message.text())) errors.push(message.text());});
        const screenshot = name => page.screenshot({path: path.join(directory, name + '.png'), animations: 'disabled'});
        const geometry = async(label) => {
            await pause(150);
            const result = await page.evaluate(() => {
                const page = document.querySelector('.catalog-page');
                const scrollers = page ? [page, ...page.querySelectorAll('*')].filter(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
                    && node.scrollHeight > node.clientHeight + 8 && node.clientHeight > 30).map(node => node.className) : [];
                const right = page?.getBoundingClientRect().right || innerWidth;
                const overflow = page ? [...page.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > right + 1)
                    .slice(0, 8).map(node => ({tag: node.tagName, className: node.className, width: node.getBoundingClientRect().width})) : [];
                return {width: innerWidth, documentWidth: document.documentElement.scrollWidth, pageWidth: page?.scrollWidth, mainWidth: page?.clientWidth, scrollers, overflow};
            });
            assert(result.documentWidth <= result.width + 1, label + ': document overflow ' + JSON.stringify(result));
            if (result.mainWidth) assert(result.pageWidth <= result.mainWidth + 1, label + ': page overflow ' + JSON.stringify(result));
            assert(result.scrollers.length <= 1, label + ': nested scrolling ' + JSON.stringify(result));
            assert.equal(await page.locator('q-menu,q-file,q-pagination').count(), 0, 'Quasar components must be registered');
        };
        await page.goto(base + '/#/books');
        await page.locator('.profile-login-action,.profile-status-chip').first().click();
        await page.getByRole('textbox', {name: 'Логин', exact: true}).fill('admin');
        await page.getByRole('textbox', {name: 'Пароль', exact: true}).fill('discovery-browser-test');
        await page.getByRole('button', {name: 'OK', exact: true}).click();
        await page.locator('.profile-controls .profile-logout').waitFor();
        await page.getByRole('button', {name: 'Переключить дизайн', exact: true}).click();
        await page.getByRole('navigation', {name: 'Разделы библиотеки'}).waitFor();
        await page.goto(base + '/#/');
        await page.waitForURL(url => url.hash === '#/overview');
        await page.getByRole('link', {name: 'Каталог', exact: true}).click();
        await page.goto(base + '/#/books?lang=ru');
        const input = page.locator('.catalog-search-panel__main input').first();
        await input.fill('Те'); await input.press('Enter');
        await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('title') === '*Те');
        await pause(600);
        assert.equal(suggestionRequests.get('Те') || 0, 0, 'Two characters still allow ordinary Enter search but never request suggestions');
        await input.fill('😀а'); await pause(600);
        assert.equal(suggestionRequests.get('😀а') || 0, 0, 'Count Unicode characters rather than UTF-16 units');
        await input.fill('Тес');
        for (let i=0; i<30 && !suggestionRequests.get('Тес'); i++) await pause(100);
        assert(suggestionRequests.get('Тес') >= 1, 'Three characters request suggestions');
        await input.fill('Тест');
        const directSearch = page.getByRole('button', {name: 'Искать «Тест»', exact: true});
        await directSearch.waitFor();
        assert(await page.getByRole('button', {name: 'Найти', exact: true}).isEnabled(), 'Main search never waits for suggestions');
        assert.equal(await page.getByText('Подсказок нет. Можно искать по всему каталогу.', {exact:true}).count(), 0, 'Direct search is available before the delayed suggestion response');
        await directSearch.click();
        await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('title') === '*Тест');
        await input.click();
        await page.getByText('Подсказок нет. Можно искать по всему каталогу.', {exact:true}).waitFor();
        const requestsAfterReply = suggestionRequests.get('Тест');
        await pause(1800);
        assert.equal(suggestionRequests.get('Тест'), requestsAfterReply, 'Even a legacy warming response must not trigger periodic polling');
        assert.equal(await page.getByText(/Подготавливаем подсказки|20%/).count(), 0, 'No misleading preparation percentage is displayed');
        await screenshot('suggestions-no-wait-1440');
        await input.fill('Кост');
        await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('title') === '*Кост');
        await page.getByRole('option', {name: /Косточка/}).waitFor();
        await page.getByText('Показана часть совпадений. Полный результат — в поиске.', {exact:true}).waitFor();
        await page.setViewportSize({width:320, height:780});
        await pause(150);
        const suggestionGeometry = await page.locator('.catalog-suggestions').evaluate(node => ({left:node.getBoundingClientRect().left,
            right:node.getBoundingClientRect().right, width:innerWidth, scroll:node.scrollWidth, client:node.clientWidth}));
        assert(suggestionGeometry.left >= 0 && suggestionGeometry.right <= suggestionGeometry.width + 1
            && suggestionGeometry.scroll <= suggestionGeometry.client + 1, 'Suggestions and direct search fit mobile: ' + JSON.stringify(suggestionGeometry));
        await screenshot('suggestions-partial-320');
        await page.setViewportSize({width:1440, height:1000});
        await input.press('Escape'); await page.locator('.catalog-suggestions').waitFor({state: 'hidden'});
        await input.fill('Косто'); await page.getByRole('option', {name: /Косточка/}).waitFor();
        await input.press('ArrowDown');
        assert(await input.getAttribute('aria-activedescendant'));
        const catalogUrl = page.url();
        await input.press('Enter');
        await page.locator('.q-dialog [data-dialog-kind="book"]').getByRole('heading', {name: 'Косточка', exact: true}).waitFor();
        assert.equal(page.url(), catalogUrl, 'Choosing a title suggestion opens a preview without changing the search URL');
        await page.locator('.q-dialog [data-dialog-kind="book"]').getByRole('button', {name:'Поделиться книгой', exact:true}).click();
        await page.getByRole('menu', {name:'Поделиться книгой', exact:true}).getByRole('menuitem', {name:'Открыть страницу книги', exact:true}).click();
        await page.locator('.catalog-book-details').waitFor();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('lang'), 'ru', 'Choosing a suggestion retains the language');
        await page.locator('.catalog-book-details').waitFor();
        assert(!page.url().includes('/reader'));
        const bookUrl = page.url();
        await page.locator('.fb2-gallery').scrollIntoViewIfNeeded();
        await page.getByText('Показаны первые 18. Остальные иллюстрации доступны в читалке.', {exact:true}).waitFor();
        assert.equal(await page.locator('.fb2-gallery-image').count(), 18, 'The real gallery endpoint returns a bounded preview');
        await screenshot('gallery-limited-1440');
        galleryFixture = 'empty-limited';
        await page.reload();
        await page.locator('.fb2-gallery').scrollIntoViewIfNeeded();
        await page.getByText('Превью иллюстраций ограничено. Откройте книгу в читалке.', {exact:true}).waitFor();
        assert.equal(await page.getByText('Иллюстрации не найдены', {exact:true}).count(), 0, 'A bounded empty preview does not claim that the book has no illustrations');
        assert.equal(await page.locator('.fb2-gallery .loading-state').count(), 0);
        galleryFixture = 'actual';
        await page.locator('.library-book-actions').getByRole('button', {name: 'Читать', exact: true}).click();
        await page.locator('.reader-body').getByText('Текст книги для проверки.', {exact: true}).first().waitFor();
        await page.goto(bookUrl);
        await page.locator('.catalog-book-details').waitFor();
        for (const width of [1440, 760, 390, 320]) {
            await page.setViewportSize({width, height: 900}); await geometry('book ' + width);
            await screenshot('book-light-' + width);
        }
        await page.getByRole('button', {name: 'Включить тёмную тему', exact: true}).click();
        await geometry('book dark 320'); await screenshot('book-dark-320');
        await page.getByRole('button', {name: 'Включить светлую тему', exact: true}).click();
        await page.setViewportSize({width: 1440, height: 1000});
        await page.locator('.book-actions-author').click();
        await page.getByRole('heading', {name: 'Толстой Лев', exact: true}).waitFor();
        await page.locator('.catalog-book-grid .book-tile').first().waitFor();
        assert.equal(await page.locator('.catalog-book-grid .book-tile').count(), 2);
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('lang'), 'ru');
        const authorUrl = page.url();
        await page.goto(authorUrl.replace('lang=ru', 'lang=en'));
        await page.getByRole('button', {name:'Открыть карточку: Childhood', exact:true}).waitFor();
        assert.equal(await page.locator('.catalog-book-grid .book-tile').count(), 1, 'Language changes scope to the English edition');
        await page.goBack(); await page.getByRole('button', {name:'Открыть карточку: Косточка', exact:true}).waitFor();
        await page.goBack(); await page.locator('.catalog-book-details').waitFor();
        await page.locator('.book-actions-series').click();
        await page.getByRole('heading', {name: 'Рассказы', exact: true}).waitFor();
        await page.locator('.catalog-book-grid .book-tile').first().waitFor();
        assert.equal(await page.locator('.catalog-book-grid .book-tile').count(), 2);
        await page.getByRole('button', {name: 'Следить за новинками', exact: true}).click();
        await page.getByRole('button', {name: 'В избранном', exact: true}).waitFor();
        await page.getByRole('button', {name: 'Прочитано до этого тома', exact: true}).first().click();
        await page.getByRole('button', {name: /^(Да|OK|ОК|Подтвердить)$/}).last().click();
        await page.getByText('Прочитано 1 из 2', {exact: false}).waitFor();
        for (const width of [1440, 390, 320]) {await page.setViewportSize({width, height: 900}); await geometry('series ' + width);}
        await screenshot('series-light-320');
        for(const [kind,label] of [['title','Книги'],['author','Авторы'],['series','Серии']]) {
            await page.goto(base + '/#/books?lang=ru');
            let field=input;
            if(kind!=='title') {
                const toggle=page.getByRole('button',{name:'Автор и серия',exact:true});
                if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
                field=page.locator('.catalog-search-panel__extra .catalog-text-field').nth(kind==='author'?0:1).locator('input').first();
            }
            await field.fill('Туман');
            const listId=await field.getAttribute('aria-controls');
            assert(listId,'Each field owns its suggestion listbox');
            const listbox=page.locator('#'+listId);
            const expected=kind==='title'?'Туман над рекой':kind==='author'?'Туман Автор':'Туман серия';
            // An exiting title menu includes its book's author in the option name.
            // Wait for this field's list, rather than matching that stale option.
            await listbox.getByText(label,{exact:true}).waitFor();
            await listbox.getByRole('option',{name:new RegExp('^'+expected)}).waitFor();
            assert.deepEqual((await listbox.locator('.catalog-suggestions__heading').allTextContents()).map(value=>value.trim()),[label],kind+' displays only matching field suggestions');
            assert.equal(await listbox.getByRole('option',{name:/лишни/}).count(),0,'Old mixed responses cannot leak groups or corrections into a named field');
            await field.press('Escape');
            await listbox.waitFor({state:'hidden'});
        }
        const fieldRequests=suggestionScopes.filter(request=>request.query==='Туман');
        assert.deepEqual([...new Set(fieldRequests.map(request=>request.kind))].sort(),['author','series','title']);
        assert(fieldRequests.every(request=>request.filters.lang==='ru'),'Field scopes retain catalog filters');
        await page.goto(base + '/#/books?lang=ru');
        const extraFieldsToggle=page.getByRole('button',{name:'Автор и серия',exact:true});
        if(await extraFieldsToggle.getAttribute('aria-expanded')!=='true')await extraFieldsToggle.click();
        const authorField=page.locator('.catalog-search-panel__extra .catalog-text-field').first().locator('input').first();
        await authorField.fill('Толс');
        const authorListbox=page.locator('#'+await authorField.getAttribute('aria-controls'));
        await authorListbox.getByRole('option', {name:/^Толстой Лев/}).waitFor();
        await authorListbox.getByRole('option', {name:/^Толстой Лев/}).click();
        await page.getByRole('heading', {name:'Толстой Лев', exact:true}).waitFor();
        await page.getByRole('button', {name:'Открыть карточку: Косточка', exact:true}).waitFor();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('lang'), 'ru', 'Author suggestions retain the language');
        assert.equal(await page.locator('.catalog-book-grid .book-tile').count(), 2);
        await page.goto(base + '/#/books?lang=ru&title=*Кост');
        await page.locator('.library-result-card__author').first().click();
        await page.getByRole('heading', {name:'Толстой Лев', exact:true}).waitFor();
        await page.getByRole('button', {name:'Открыть карточку: Косточка', exact:true}).waitFor();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('lang'), 'ru', 'Clicking the author on a search result retains language');
        assert.equal(await page.locator('.catalog-book-grid .book-tile').count(), 2);
        await page.getByRole('link', {name:'Авторы', exact:true}).click();
        assert.equal(new URLSearchParams(page.url().split('?')[1]).get('lang'), 'ru', 'Alphabet navigation retains the scope');
        await page.goto(base + '/#/authors');
        await page.locator('.catalog-alphabet button').first().waitFor();
        let depth = 0;
        while (await page.locator('.catalog-alphabet button').count()) {
            const before = page.url();
            await page.locator('.catalog-alphabet button').filter({hasText: /^К/}).first().click().catch(async() => page.locator('.catalog-alphabet button').first().click());
            await page.waitForFunction(before => location.href !== before, before);
            await page.locator('.catalog-page__loading').waitFor({state: 'hidden'});
            await page.locator('.catalog-alphabet button,.catalog-entities a').first().waitFor();
            assert(++depth < 40, 'Alphabet refinement must terminate');
        }
        assert(await page.locator('.catalog-entities a').count());
        assert(await page.locator('.catalog-breadcrumbs button').count() > 1);
        await geometry('alphabet'); await screenshot('alphabet-light-320');
        await page.locator('.catalog-breadcrumbs button').first().click();
        await page.locator('.catalog-alphabet button').first().waitFor();
        await page.getByRole('link', {name: 'Профиль', exact: true}).click();
        await page.getByRole('button', {name: /Telegram-бот/}).click();
        await page.getByText('Интерактивный бот выключен.', {exact: false}).waitFor();
        await page.setViewportSize({width: 1440, height: 1000});
        await page.getByRole('button', {name: 'Настройки библиотеки', exact: true}).click();
        const backupHeading = page.locator('.admin-collapse-head').filter({hasText: /Бэкап|Резерв/}).first();
        await backupHeading.click();
        const panel = page.locator('.backup-panel'); await panel.getByRole('heading', {name: 'Защита и расписание'}).waitFor();
        await panel.getByLabel('Пароль копий (от 10 символов)', {exact: true}).fill('browser-backup-password');
        await panel.getByLabel('Повторите пароль', {exact: true}).fill('browser-backup-password');
        await panel.getByRole('button', {name: 'Сохранить настройки', exact: true}).click();
        await panel.getByText('Новые копии будут зашифрованы.', {exact: false}).waitFor();
        await panel.getByRole('button', {name: 'Создать копию', exact: true}).click();
        await panel.locator('.backup-panel__row').first().waitFor();
        await panel.locator('.backup-panel__row').getByRole('button', {name: 'Восстановить', exact: true}).click();
        await panel.getByLabel('Пароль копии (для зашифрованного файла)', {exact: true}).fill('browser-backup-password');
        await panel.getByRole('button', {name: 'Проверить копию', exact: true}).click();
        await panel.getByRole('heading', {name: 'Копия проверена', exact: true}).waitFor();
        await page.waitForFunction(() => !document.querySelector('.q-notification'), undefined, {timeout: 15000});
        await screenshot('backup-preview-1440');
        await page.setViewportSize({width: 320, height: 780}); await panel.locator('.backup-panel__preview').scrollIntoViewIfNeeded(); await screenshot('backup-preview-320');
        const modalGeometry = await page.locator('.library-dialog-card').evaluate(node => ({width: node.getBoundingClientRect().width, scroll: node.scrollWidth, viewport: innerWidth,
            scrollers: [node, ...node.querySelectorAll('*')].filter(item => ['auto','scroll'].includes(getComputedStyle(item).overflowY) && item.scrollHeight > item.clientHeight + 8 && item.clientHeight > 30).map(item => item.className)}));
        assert(modalGeometry.width <= modalGeometry.viewport && modalGeometry.scroll <= modalGeometry.width + 1, JSON.stringify(modalGeometry));
        assert(modalGeometry.scrollers.length <= 1, 'Backup dialog has one vertical scrollbar: ' + JSON.stringify(modalGeometry));
        await page.getByRole('button', {name: 'Закрыть окно', exact: true}).click();
        await page.goto(base + '/#/book');
        await page.getByRole('heading', {name: 'Не удалось открыть книгу', exact: true}).waitFor();
        externalFixture = true;
        await page.setViewportSize({width: 1440, height: 1000});
        await page.evaluate(() => {
            const saved = JSON.parse(localStorage.getItem('vuex') || '{}');
            saved.settings = {...saved.settings, discoveryExternalSource: 'web-page', discoveryExternalName: 'Тестовая витрина',
                discoveryExternalUrl: 'https://example.invalid/catalog', showDiscoveryExternal: true};
            localStorage.setItem('vuex', JSON.stringify(saved));
        });
        // A document navigation hydrates the synthetic source preferences saved above.
        await page.goto(base + '/?external-fixture=1#/bestsellers');
        const controls = page.getByRole('group', {name: 'Книг на странице', exact: true});
        await controls.waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.discovery-shelf .library-result-card').length === 12);
        await controls.getByRole('button', {name: '24', exact: true}).click();
        await page.waitForFunction(() => document.querySelectorAll('.discovery-shelf .library-result-card').length === 24);
        assert.equal(await controls.getByRole('button', {name: '24', exact: true}).getAttribute('aria-pressed'), 'true');
        const cardHeight = (await page.locator('.discovery-shelf .library-result-card').first().boundingBox()).height;
        await page.getByRole('button', {name: 'Компактные карточки', exact: true}).click();
        await page.locator('.library-result-card--compact').first().waitFor();
        assert((await page.locator('.library-result-card--compact').first().boundingBox()).height < cardHeight, 'Compact mode actually reduces card height');
        assert.equal(await page.locator('.discovery-wrap').getByText('Тестовая витрина', {exact: true}).count(), 1, 'The external title is not repeated');
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({width, height: 900});
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Discovery controls fit the viewport');
            await screenshot('discovery-controls-light-' + width);
        }
        await page.getByRole('button', {name: 'Включить тёмную тему', exact: true}).click();
        await screenshot('discovery-controls-dark-320');
        cardGridFixture = true;
        await page.goto(base + '/?card-grid-fixture=1#/books?title=*Сетка');
        await page.waitForFunction(() => document.querySelectorAll('.books-grid .library-result-card').length === 6);
        const cardGridGeometry = [];
        for (const width of [1440,320]) {
            await page.setViewportSize({width,height:1000}); await pause(150);
            const measured = await page.locator('.books-grid').evaluate(grid => ({width:innerWidth,scroll:grid.scrollWidth,client:grid.clientWidth,
                cards:[...grid.querySelectorAll('.library-result-card')].map(card => {
                    const box=card.getBoundingClientRect(), actions=card.querySelector('.library-result-card__actions').getBoundingClientRect();
                    const fields=Object.fromEntries(['title','author','series'].map(name => {
                        const field=card.querySelector('.library-result-card__'+name), rect=field?.getBoundingClientRect();
                        return [name,field ? {height:rect.height,lineHeight:parseFloat(getComputedStyle(field).lineHeight),scroll:field.scrollHeight,client:field.clientHeight} : null];
                    }));
                    return {top:box.top,bottom:box.bottom,height:box.height,left:box.left,right:box.right,actionsBottom:actions.bottom,fields};
                })}));
            assert(measured.scroll<=measured.client+1 && measured.cards.every(card => card.left>=0 && card.right<=width+1), 'Cards fit the viewport: '+JSON.stringify(measured));
            const rows=[];
            for(const card of measured.cards) {
                let row=rows.find(row => Math.abs(row.top-card.top)<1);
                if(!row){row={top:card.top,bottom:card.bottom,height:card.height,cards:[]};rows.push(row);}
                row.cards.push(card);
                assert(card.height<380, 'Long metadata must not create a tall card');
                for(const [field,lines] of [['title',2],['author',2],['series',1]])
                    if(card.fields[field]) assert(card.fields[field].height<=card.fields[field].lineHeight*lines+1, field+' is clamped');
            }
            assert(rows.length>=3);
            for(const row of rows) {
                assert(Math.max(...row.cards.map(card=>card.height))-Math.min(...row.cards.map(card=>card.height))<=1,'Cards in a row have equal height');
                assert(Math.max(...row.cards.map(card=>card.actionsBottom))-Math.min(...row.cards.map(card=>card.actionsBottom))<=1,'Actions align at the bottom of each row');
            }
            for(let i=1;i<rows.length;i++)assert(rows[i].top-rows[i-1].bottom<=20+1,'Rows have no inherited empty track space');
            assert(rows.at(-1).height<rows[0].height-10,'Short rows do not inherit the tallest row height');
            assert(measured.cards[0].fields.author.scroll>measured.cards[0].fields.author.client,'The long author fixture exercises actual clipping');
            cardGridGeometry.push({width,rows:rows.map(row=>({height:row.height,count:row.cards.length}))});
            await screenshot('result-cards-long-'+width);
        }
        const firstCard=page.locator('.books-grid .library-result-card').first();
        assert.equal(await firstCard.locator('.library-result-card__title').textContent(),gridBooks[0].title);
        assert.equal(await firstCard.locator('.library-result-card__author').textContent(),gridBooks[0].author);
        await firstCard.locator('.library-result-card__title').click();
        const fullPreview=page.locator('.q-dialog [data-dialog-kind="book"]');
        await fullPreview.waitFor();
        assert.equal(await fullPreview.getByRole('heading',{level:2}).textContent(),gridBooks[0].title);
        assert.deepEqual((await fullPreview.locator('.book-actions-author').textContent()).split(',').map(value=>value.trim()),gridBooks[0].author.split(',').map(value=>value.trim()));
        assert((await fullPreview.locator('.book-actions-series').textContent()).includes(gridBooks[0].series));
        const seriesHref=await fullPreview.locator('.book-actions-series').getAttribute('href');
        assert.equal(new URLSearchParams(seriesHref.split('?')[1]).get('name'),gridBooks[0].series);
        assert.deepEqual(errors, []);
        assert.deepEqual(invalidBookRequests, [], 'Deactivated book pages must not reload with an empty UID');
        assert.deepEqual(inactiveReaderRequests, [], 'A cached reader must not prepare documents while another page is active');
        await fs.writeJson(path.join(directory, 'result.json'), {base, errors, depth, cardGridGeometry, suggestionScopes, suggestionRequests: Object.fromEntries(suggestionRequests)}, {spaces: 2});
        console.log('Catalog discovery browser: OK. Artifacts: ' + directory);
    } catch (error) {
        if (browser) {const page = browser.contexts().flatMap(context => context.pages())[0]; if (page) {await page.screenshot({path: path.join(directory, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(directory, 'failure.html'), await page.content());}}
        console.error(output); throw error;
    } finally {if (browser) await browser.close(); if (child) child.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
