const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const {pipeline} = require('stream/promises');
const {JembaDb} = require('jembadb');
const DbSearcher = require('../server/core/DbSearcher');
const Security = require('../server/core/Security');
const provider = require('../server/core/AudiobookshelfProvider');
const Fb2Helper = require('../server/core/fb2/Fb2Helper');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');
const fb2 = '<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><genre>sf</genre><author><last-name>Тестов</last-name><first-name>Автор</first-name></author><book-title>Проверка метаданных</book-title><annotation><p>Первый абзац.</p><p>Второй &amp; третий.</p></annotation><keywords>тест; метаданные</keywords><lang>ru</lang></title-info><publish-info><publisher>Тестовое &amp; издательство &#xED;</publisher><year>2026</year><isbn>978-0-123456-47-2</isbn></publish-info></description><body><section><p>Тестовый текст.</p></section></body></FictionBook>';

async function fixture(test, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-abs-test-'));
    const db = new JembaDb(); let server;
    try {
        const config = {dataDir: dir, libDir: path.join(dir, 'source'), tempDir: path.join(dir, 'tmp'), bookDir: path.join(dir, 'book'),
            publicFilesDir: path.join(dir, 'public-files'), rootPathStatic: '', absEnabled: true, absToken: 'fixture-abs-token', ...options};
        await Promise.all([config.libDir, config.tempDir, config.bookDir, path.join(dir, 'db')].map(value => fs.ensureDir(value)));
        await db.lock({dbPath: path.join(dir, 'db')});
        await db.create({table: 'book', hash: {field: '_uid', unique: true, type: 'string'}}); await db.create({table: 'file_hash'});
        await fs.writeFile(path.join(config.libDir, '1.fb2'), require('iconv-lite').encode(fb2, 'windows-1251'));
        const zip = new(require('yazl').ZipFile)();
        const done = pipeline(zip.outputStream, fs.createWriteStream(path.join(config.libDir, '2.epub')));
        zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
        zip.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:description>EPUB description</dc:description><dc:publisher>EPUB &amp; publisher</dc:publisher><dc:date>2024-05-01</dc:date><dc:language>en</dc:language><dc:identifier>urn:isbn:978-0-123456-47-2</dc:identifier><dc:subject>epub tag</dc:subject></metadata></package>'), 'OEBPS/book.opf');
        zip.end(); await done;
        const common = {author: 'Тестов Автор', title: 'Проверка метаданных', genre: 'sf', series: 'Тестовая серия', serno: 2,
            year: '2025', keywords: '', lang: 'ru', del: 0, folder: '', sourceLibDir: config.libDir, sourceId: 'main', size: 0, insno: 0};
        const books = [{...common, id: 1, _uid: 'fb2-uid', file: '1', ext: 'fb2'},
            {...common, id: 2, _uid: 'epub-uid', file: '2', ext: 'epub'},
            {...common, id: 3, _uid: 'other-author', file: 'missing', ext: 'fb2', author: 'Другой Автор'},
            {...common, id: 4, _uid: 'deleted', file: 'deleted', ext: 'fb2', del: 1}];
        await db.insert({table: 'book', rows: books});
        const searcher = Object.create(DbSearcher.prototype);
        Object.assign(searcher, {db, closed: false, searchFlag: 0, recStruct: ['author', 'title', 'file', 'ext', 'lang', 'folder'].map(field => ({field, type: 'S'}))});
        searcher.recStruct.push({field: 'del', type: 'N'});
        const cache = new Map(); searcher.getCached = async key => cache.has(key) ? cache.get(key) : null; searcher.putCached = async(key, value) => cache.set(key, value);
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        Object.assign(worker, {config, db, dbSearcher: searcher, fb2Helper: new Fb2Helper(), checkMyState: () => {},
            readingListStore: {getMetadataOverrides: async() => ({})}, dbConfig: async() => ({})});
        let extractions = 0; let coverLoads = 0;
        const extractBook = worker.extractBook.bind(worker);
        worker.extractBook = async(...args) => {extractions++; return extractBook(...args);};
        worker.getBookInfo = async() => {throw new Error('ABS must not prepare full book information');};
        worker.getBookLink = async() => {throw new Error('ABS must not restore/download the book');};
        worker.getBookCover = async() => {coverLoads++; return {contentType: 'image/png', data: png};};
        const security = new Security(config); await security.init();
        const app = require('express')(); app.use(security.middleware()); app.use(security.requiredAuthMiddleware());
        const metadata = provider.init(app, config, worker, security);
        app.get('/protected', (req, res) => res.send('protected'));
        server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const root = provider.rootPath(config);
        const request = (suffix, authorization = config.absToken) => fetch(base + root + suffix,
            {headers: authorization ? {Authorization: authorization} : {}});
        await test({dir, config, worker, metadata, security, request, base, root, count: () => ({extractions, coverLoads})});
    } finally {
        if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
        await db.unlock(); await fs.remove(dir);
    }
}

async function testAudiobookshelfNativeMetadataAndAuthorOrder() {
    await fixture(async({request, count, dir}) => {
        const response = await request('/search?query=' + encodeURIComponent('Проверка метаданных') + '&author=' + encodeURIComponent('Автор Тестов'));
        assert.strictEqual(response.status, 200);
        const {matches} = await response.json();
        assert.strictEqual(matches.length, 2);
        assert.strictEqual(matches[0].title, 'Проверка метаданных');
        assert.strictEqual(matches[0].author, 'Тестов Автор');
        assert.strictEqual(matches[0].description, 'Первый абзац.\nВторой & третий.');
        assert.strictEqual(matches[0].publisher, 'Тестовое & издательство í');
        assert.strictEqual(matches[0].publishedYear, '2026');
        assert.strictEqual(matches[0].isbn, '978-0-123456-47-2');
        assert.deepStrictEqual(matches[0].series, [{series: 'Тестовая серия', sequence: '2'}]);
        assert.ok(matches[0].genres.length && matches[0].tags.includes('метаданные'));
        assert.strictEqual(matches[1].description, 'EPUB description');
        assert.strictEqual(matches[1].publisher, 'EPUB & publisher');
        assert.strictEqual(matches[1].publishedYear, '2024');
        assert.strictEqual(matches[1].language, 'en');
        assert.strictEqual(matches[1].isbn, '978-0-123456-47-2');
        assert.ok(matches[1].tags.includes('epub tag'));
        assert.ok(matches.every(book => !Object.hasOwn(book, 'duration') && !Object.hasOwn(book, 'narrator')));
        assert.ok((await (await request('/search?query=&author=' + encodeURIComponent('Тестов Автор'))).json()).matches.length === 2);
        assert.deepStrictEqual((await (await request('/search?query=NoSuchBook')).json()).matches, []);
        assert.strictEqual(count().extractions, 2, 'Repeat searches should reuse metadata without extracting again');
        assert.deepStrictEqual(await fs.readdir(path.join(dir, 'tmp')), []);
        assert.deepStrictEqual(await fs.readdir(path.join(dir, 'book')), [], 'Search must not create restored book caches');
    });
}

async function testAudiobookshelfTokenScopeAndSignedCoverLinks() {
    await fixture(async({config, request, root, base, count}) => {
        assert.strictEqual((await request('', '')).status, 403);
        const diagnostic = await (await request('')).json();
        assert.strictEqual(diagnostic.search, root + '/search');
        assert.strictEqual(diagnostic.authorizationRequired, true);
        assert.notStrictEqual((await request('/search?query=abc', '')).status, 200);
        assert.notStrictEqual((await request('/search?query=abc', 'wrong-token')).status, 200);
        const response = await request('/search?query=' + encodeURIComponent('Проверка метаданных'), `Bearer ${config.absToken}`);
        assert.strictEqual(response.status, 200);
        const book = (await response.json()).matches[0];
        const cover = new URL(book.cover);
        const originalUid = cover.searchParams.get('uid');
        assert.strictEqual(cover.pathname, root + '/cover');
        const download = await fetch(base + cover.pathname + cover.search);
        assert.strictEqual(download.status, 200);
        assert.ok(Buffer.from(await download.arrayBuffer()).equals(png));
        assert.strictEqual((await fetch(base + cover.pathname + cover.search)).status, 200);
        assert.strictEqual(count().coverLoads, 1, 'ABS and web covers must share the persistent cover cache');
        cover.searchParams.set('uid', originalUid === 'fb2-uid' ? 'epub-uid' : 'fb2-uid');
        assert.notStrictEqual((await fetch(base + cover.pathname + cover.search)).status, 200, 'A signature must not grant access to another book');
        cover.searchParams.set('uid', originalUid); cover.searchParams.set('expires', '1');
        assert.notStrictEqual((await fetch(base + cover.pathname + cover.search)).status, 200);
        assert.strictEqual((await fetch(base + '/protected', {headers: {Authorization: config.absToken}})).status, 403, 'The service token must not bypass proxy auth on other routes');
        config.absToken = 'rotated-token';
        assert.notStrictEqual((await fetch(base + new URL(book.cover).pathname + new URL(book.cover).search)).status, 200, 'Rotation must revoke existing cover capabilities');
    }, {rootPathStatic: '/library', requireAuth: true, authMode: 'proxy', trustProxy: false});
    await fixture(async({config, request}) => {
        config.absEnabled = false; assert.strictEqual((await request('/search?query=x')).status, 404);
        assert.strictEqual((await request('')).status, 404);
        config.absEnabled = true; config.absToken = ''; assert.strictEqual((await request('/search?query=x')).status, 503);
        assert.strictEqual((await request('')).status, 503);
    });
}

async function testAudiobookshelfSearchBoundsAndCacheInvalidation() {
    await fixture(async({request, config, worker, count}) => {
        for (const query of ['/search', '/search?query=', '/search?query[0]=x', '/search?query=x&author[0]=x', '/search?query=' + 'x'.repeat(201)])
            assert.strictEqual((await request(query)).status, 400, query);
        config.absMaxResults = 1;
        const query = '/search?query=' + encodeURIComponent('Проверка метаданных') + '&author=' + encodeURIComponent('Тестов');
        assert.strictEqual((await (await request(query)).json()).matches.length, 1);
        const first = count().extractions;
        await request(query);
        assert.strictEqual(count().extractions, first);
        worker.libraryAssetGeneration = 1;
        await request(query);
        assert.strictEqual(count().extractions, first + 1, 'Reindex must invalidate metadata');
        let release; const gate = new Promise(resolve => {release = resolve;});
        const previous = worker.bookSearch.bind(worker);
        let started; const ready = new Promise(resolve => {started = resolve;}); let searches = 0;
        worker.bookSearch = async value => {if (++searches === 2) started(); await gate; return previous(value);};
        const firstRequest = request(query); const secondRequest = request(query);
        await ready;
        try {assert.strictEqual((await request(query)).status, 429);} finally {release();}
        assert.strictEqual((await firstRequest).status, 200); assert.strictEqual((await secondRequest).status, 200);
        assert.strictEqual((await request(query)).status, 200, 'An overload must not leave a busy slot occupied');
        config.absPublicUrl = 'https://books.example.test/library';
        const book = (await (await request(query)).json()).matches[0];
        assert.ok(book.cover.startsWith('https://books.example.test/library/api/audiobookshelf/cover?'));
    });
}

async function testAudiobookshelfReturnsMatchesBeforeClientTimeout() {
    await fixture(async({worker, metadata, request, config, base, root}) => {
        config.absMaxResults = 20;
        const record = (await worker.bookSearch({title: '*Проверка метаданных'})).found.find(book => book.file === '1');
        const books = Array.from({length: 20}, (_, i) => ({...record, _uid: `slow-archive-${i}`}));
        worker.bookSearch = async() => ({found: books});
        let release;
        const gate = new Promise(resolve => {release = resolve;});
        const extract = worker.extractBook.bind(worker);
        let started = 0;
        worker.extractBook = async(...args) => {started++; await gate; return extract(...args);};
        const query = '/search?query=' + encodeURIComponent('Проверка метаданных');
        try {
            const start = Date.now();
            const responses = await Promise.all([1, 2].map(() => fetch(base + root + query, {
                headers: {Authorization: config.absToken}, signal: AbortSignal.timeout(10000),
            })));
            assert.ok(Date.now() - start < 8000, 'Matches must arrive before the ABS 10-second client timeout');
            for (const response of responses) {
                assert.strictEqual(response.status, 200, 'A full metadata queue must not hide index matches');
                const result = await response.json();
                assert.strictEqual(result.matches.length, 20);
                assert.ok(result.matches.every(book => book.title && book.author && book.cover));
            }
            assert.strictEqual(started, 2, 'Only two physical archive reads may run');
            assert.ok(metadata.queue.length <= 16);
        } finally {
            release();
            await Promise.allSettled([...metadata.pending.values()]);
        }
        const warm = await request(query);
        assert.strictEqual(warm.status, 200, 'Background archive reads must not occupy HTTP search slots');
        assert.strictEqual((await warm.json()).matches[0].publisher, 'Тестовое & издательство í');
    });
}

async function testAudiobookshelfDiagnosticsExplainAuthorizationWithoutExposingSecrets() {
    await fixture(async({request, config, count, root, metadata}) => {
        config.absMaxResults = 100;
        let response = await request('', '');
        assert.strictEqual(response.status, 401);
        assert.strictEqual(response.headers.get('cache-control'), 'no-store');
        let info = await response.json();
        assert.strictEqual(info.search, root + '/search');
        assert.deepStrictEqual(info.configuration, {enabled: true, tokenConfigured: true});
        assert.ok(info.example.curl.includes('Authorization: <INPX_ABS_TOKEN>'));
        assert.strictEqual(info.limits.maxResults, 20);
        assert.ok(info.troubleshooting['401'].includes('Authorization'));
        assert.ok(!info.diagnostics, 'Runtime diagnostics require the service token');
        assert.ok(!JSON.stringify(info).includes(config.absToken), 'Help must not disclose the configured token');
        response = await request('/', `Bearer ${config.absToken}`);
        assert.strictEqual(response.status, 200);
        info = await response.json();
        assert.strictEqual(info.cover, root + '/cover');
        assert.deepStrictEqual(info.diagnostics, {activeSearches: 0, activeArchiveReads: 0, queuedArchiveReads: 0, pendingMetadata: 0, cachedMetadata: 0});
        await request('/search?query=' + encodeURIComponent('Проверка метаданных') + '&author=' + encodeURIComponent('Тестов'));
        info = await (await request('')).json();
        assert.strictEqual(info.diagnostics.cachedMetadata, metadata.cache.size);
        assert.ok(info.diagnostics.cachedMetadata > 0);
        config.absEnabled = false;
        response = await request('');
        assert.strictEqual(response.status, 404);
        info = await response.json();
        assert.strictEqual(info.configuration.enabled, false);
        assert.ok(info.troubleshooting['404'].includes('INPX_ABS_ENABLED=true'));
        config.absEnabled = true; config.absToken = '';
        response = await request('');
        assert.strictEqual(response.status, 503);
        info = await response.json();
        assert.strictEqual(info.configuration.tokenConfigured, false);
        assert.strictEqual(info.error, 'INPX_ABS_TOKEN is required');
        assert.deepStrictEqual(count(), {extractions: 2, coverLoads: 0}, 'Diagnostics must not read archives or generate covers');
    }, {rootPathStatic: '/library'});
}

async function testAudiobookshelfOmitsMissingAndNullMetadata() {
    await fixture(async({dir, worker, metadata, request, count}) => {
        await fs.writeFile(path.join(dir, 'source', '1.fb2'), '<FictionBook><description><title-info><book-title>Без метаданных</book-title></title-info><publish-info><book-name>Без метаданных</book-name></publish-info></description></FictionBook>');
        const zip = new(require('yazl').ZipFile)();
        const done = pipeline(zip.outputStream, fs.createWriteStream(path.join(dir, 'source', '2.epub')));
        zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
        zip.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:description>null</dc:description><dc:publisher>null</dc:publisher><dc:language>null</dc:language><dc:identifier>urn:isbn:null</dc:identifier><dc:subject>null</dc:subject></metadata></package>'), 'book.opf');
        zip.end(); await done;
        const found = (await worker.bookSearch({title: '*Проверка метаданных'})).found.filter(book => ['1', '2'].includes(book.file));
        const books = found.map(book => ({...book, lang: null, year: ' null ', genre: 'NULL', keywords: 'null', series: null, serno: 'null'}));
        worker.bookSearch = async() => ({found: books});
        const query = '/search?query=' + encodeURIComponent('Проверка метаданных');
        let response = await request(query);
        assert.strictEqual(response.status, 200);
        let {matches} = await response.json();
        assert.strictEqual(matches.length, 2);
        for (const book of matches) {
            assert.deepStrictEqual(Object.keys(book).sort(), ['author', 'cover', 'title']);
            assert.ok(book.cover && book.author && book.title);
        }
        const cachedFb2 = [...metadata.cache.values()].find(entry => entry.value.publisher === '');
        assert.ok(cachedFb2, 'Missing FB2 elements must not become the string null during parsing');
        assert.strictEqual(cachedFb2.value.description, '');
        assert.strictEqual(cachedFb2.value.isbn, '');
        assert.deepStrictEqual(cachedFb2.value.tags, []);
        // Legacy cached placeholders must not mask valid index values, and a
        // mixed list must retain real tags while dropping only null entries.
        for (const book of books) Object.assign(book, {lang: 'ru', year: '2025', genre: 'sf, null', keywords: 'null; полезный тег; ещё тег'});
        for (const entry of metadata.cache.values()) Object.assign(entry.value, {
            language: ' null ', publishedYear: 'null', tags: [null, ' NULL ', '', ' полезный тег ', 'null programming'],
        });
        response = await request(query);
        assert.strictEqual(response.status, 200);
        ({matches} = await response.json());
        for (const book of matches) {
            assert.strictEqual(book.language, 'ru');
            assert.strictEqual(book.publishedYear, '2025');
            assert.deepStrictEqual(book.tags, ['полезный тег', 'null programming', 'ещё тег']);
            assert.strictEqual(book.genres.length, 1);
            for (const field of ['publisher', 'isbn', 'description', 'series']) assert.ok(!Object.hasOwn(book, field), field);
        }
        assert.strictEqual(count().extractions, 2, 'Cached metadata must be sanitized without re-reading archives');
    });
}

module.exports = [testAudiobookshelfNativeMetadataAndAuthorOrder, testAudiobookshelfTokenScopeAndSignedCoverLinks, testAudiobookshelfSearchBoundsAndCacheInvalidation, testAudiobookshelfReturnsMatchesBeforeClientTimeout, testAudiobookshelfDiagnosticsExplainAuthorizationWithoutExposingSecrets, testAudiobookshelfOmitsMissingAndNullMetadata];
