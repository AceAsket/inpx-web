const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');
const {JembaDb} = require('jembadb');
const DbCreator = require('../server/core/DbCreator');
const DbSearcher = require('../server/core/DbSearcher');

const clientRoot = path.resolve(__dirname, '../client');
const titleComponent = path.join(clientRoot, 'components/Search/TitleList/TitleList.vue');
const clientModules = new Map();

// Execute the real list classes and shared search module in Node. Only rendering
// components, Vue registration and browser storage are replaced; filtering,
// title-row construction, deduplication and Vue reactivity stay real.
function loadClient(file) {
    if (clientModules.has(file)) return clientModules.get(file).exports;
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) source = require('@vue/compiler-sfc').parse(source).descriptor.script.content;
    const code = require('@babel/core').transformSync(source, {
        filename: file, configFile: false, babelrc: false,
        presets: [[require('@babel/preset-env'), {targets: {node: 'current'}, modules: 'commonjs'}]],
    }).code;
    const loaded = new Module(file, module);
    loaded.filename = file;
    clientModules.set(file, loaded);
    const nativeRequire = Module.createRequire(file);
    loaded.require = name => {
        if (name === './authorBooksStorage' || name.endsWith('.vue')) return {};
        const resolved = nativeRequire.resolve(name);
        if (resolved === path.join(clientRoot, 'components/vueComponent.js')) return Type => Type;
        return resolved.startsWith(clientRoot + path.sep) ? loadClient(resolved) : nativeRequire(name);
    };
    loaded._compile(code, file);
    return loaded.exports;
}

function createWebList() {
    const Type = loadClient(path.join(clientRoot, 'components/Search/BaseList.js')).default;
    return new Type();
}

function createTitleList() {
    const Type = loadClient(titleComponent).default;
    return new Type();
}

function createOpdsList() {
    return Object.create(require('../server/core/opds/BasePage').prototype);
}

function filters(books, query) {
    const web = createWebList();
    web.search = query;
    const opds = createOpdsList();
    return [web.filterBooks(books), opds.filterBooks(books, query)];
}

async function testCatalogWebAndOpdsWordFilters() {
    const book = {_uid: 'one', title: 'Волчья стая', author: 'Стругацкий Борис', series: 'Звёздные войны',
        genre: 'sf', lang: 'ru', ext: 'fb2', del: 0};
    for (const query of [{title: 'стая'}, {title: 'волчьи'}, {author: 'борис'}, {series: 'звездные'},
        {title: 'стая', author: 'борис', series: 'звездные'}]) {
        for (const result of filters([book], query)) assert.deepStrictEqual(result, [book], JSON.stringify(query));
    }
    for (const title of ['«Волчья стая»', 'Кocмическая стая']) {
        const candidate = {...book, title};
        const query = {title: title.startsWith('К') ? 'космический стая' : 'стая'};
        for (const result of filters([candidate], query)) assert.deepStrictEqual(result, [candidate]);
    }
    for (const query of [{title: 'солярис'}, {author: 'пушкин'}, {series: 'земноморье'}]) {
        for (const result of filters([book], query)) assert.deepStrictEqual(result, []);
    }
}

async function testCatalogWebAndOpdsOperatorsAndMetadataFilters() {
    const books = ['Волчья стая', 'Стая', '«Стая»', ''].map((title, id) => ({
        _uid: String(id), title, author: 'Автор', series: '', genre: 'sf', lang: 'ru', ext: 'fb2', del: 0,
    }));
    const cases = [['=Стая', ['1']], ['*стая', ['0', '1', '2']], ['#стая', ['2']],
        ['~^стая$', ['1']], ['?', ['3']]];
    for (const [title, ids] of cases) {
        for (const result of filters(books, {title})) assert.deepStrictEqual(result.map(book => book._uid), ids, title);
    }
    const candidates = [books[0], {...books[0], _uid: 'deleted', del: 1},
        {...books[0], _uid: 'other-language', lang: 'en'}, {...books[0], _uid: 'other-genre', genre: 'poetry'}];
    for (const result of filters(candidates, {title: 'стая', lang: 'ru', genre: 'sf'}))
        assert.deepStrictEqual(result.map(book => book._uid), ['0']);
    for (const result of filters([books[0]], {series: '?'})) assert.deepStrictEqual(result, [books[0]]);
    const web = createWebList();
    web.search = {title: 'стая', ext: 'fb2'};
    assert.deepStrictEqual(web.filterBooks([books[0], {...books[0], ext: 'epub'}]), [books[0]]);
}

async function testCatalogTitlePaginationRendersEveryMatchedRow() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-title-pages-'));
    const db = new JembaDb();
    let locked = false;
    let searcher;
    try {
        const library = path.join(dir, 'library');
        await fs.ensureDir(library);
        const titles = Array.from({length: 71}, (_, i) => `Волчья стая ${String(i + 1).padStart(2, '0')}`);
        titles.push('Стая', 'Солярис');
        for (const [index, title] of titles.entries()) {
            await fs.writeFile(path.join(library, `${index}.fb2`), `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook><description><title-info><genre>sf</genre><author><last-name>Петров</last-name><first-name>Иван</first-name></author>
<book-title>${title}</book-title><lang>ru</lang></title-info></description><body><section><p>Текст.</p></section></body></FictionBook>`);
        }
        const config = {dataDir: path.join(dir, 'data'), libDir: library, inpxFilterFile: path.join(dir, 'no-filter'),
            dbVersion: 14, dbCacheSize: 10, fullOptimization: false,
            librarySources: [{id: 'own', name: 'Test', type: 'folder', libDir: library, enabled: true}]};
        await fs.ensureDir(config.dataDir);
        await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        locked = true;
        await new DbCreator(config).run(db, () => {});
        await db.openAll();
        searcher = new DbSearcher(config, db);
        await searcher.init();
        const opds = createOpdsList();
        const pagedTitles = [];
        for (const [offset, expected] of [[0, 20], [20, 20], [40, 20], [60, 12], [80, 0]]) {
            const query = {title: 'стая', del: '0', limit: 20, offset};
            const result = await searcher.search('title', query);
            assert.strictEqual(result.totalFound, 72);
            assert.strictEqual(result.found.length, expected);
            const web = createTitleList();
            web.search = query;
            web.searchResult = result;
            await web.updateTableData();
            assert.strictEqual(web.tableData.length, expected, `Web page at offset ${offset}`);
            pagedTitles.push(...web.tableData.map(row => row.title));
            for (const row of result.found) assert.strictEqual(opds.filterBooks(row.books, query).length, 1);
        }
        assert.strictEqual(new Set(pagedTitles).size, 72, 'No duplicate or lost titles between pages');
        const all = await searcher.search('title', {title: 'стая', del: '0', limit: 100, offset: 0});
        assert.deepStrictEqual(pagedTitles, all.found.map(row => row.title));
        for (const title of ['солярис', '=Волчья стая 01']) {
            const query = {title, del: '0', limit: 20, offset: 0};
            const result = await searcher.search('title', query);
            assert.strictEqual(result.totalFound, 1);
            const web = createTitleList();
            web.search = query;
            web.searchResult = result;
            await web.updateTableData();
            assert.strictEqual(web.tableData.length, 1);
            assert.strictEqual(opds.filterBooks(result.found[0].books, query).length, 1);
        }
    } finally {
        if (searcher) await searcher.close();
        if (locked) await db.unlock();
        await fs.remove(dir);
    }
}

module.exports = [testCatalogWebAndOpdsWordFilters, testCatalogWebAndOpdsOperatorsAndMetadataFilters,
    testCatalogTitlePaginationRendersEveryMatchedRow];
module.exports.createWebList = createWebList;
module.exports.loadClient = loadClient;
