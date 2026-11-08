const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const {parse} = require('@vue/compiler-sfc');
const {loadClient, createWebList} = require('./catalog-list-filter-tests');
const clientRoot = path.resolve(__dirname, '../client');
const tick = () => new Promise(resolve => setImmediate(resolve));

function memoryStorage(initial = []) {
    const items = new Map(initial), counts = {reads: 0, scans: 0, writes: 0};
    return {items, counts, getItem: async key => {counts.reads++; return items.get(key) ?? null;},
        setItem: async(key, value) => {counts.writes++; items.set(key, value); return value;},
        keys: async() => {counts.scans++; return [...items.keys()];}, removeItem: async key => items.delete(key)};
}
function syncStorage(initial = []) {
    const items = new Map(initial);
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key)};
}
function freshClient(relative, cache) {
    const modules = new Map();
    const load = file => {
        if (modules.has(file)) return modules.get(file).exports;
        let source = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.vue')) source = parse(source).descriptor.script.content;
        const code = require('@babel/core').transformSync(source, {filename: file, configFile: false, babelrc: false,
            presets: [[require('@babel/preset-env'), {targets: {node: 'current'}, modules: 'commonjs'}]]}).code;
        const loaded = new Module(file, module), native = Module.createRequire(file);
        loaded.filename = file; modules.set(file, loaded);
        loaded.require = name => {
            if (name.endsWith('authorBooksStorage')) return cache;
            if (name.endsWith('.vue')) return {};
            const resolved = native.resolve(name);
            if (resolved === path.join(clientRoot, 'components/vueComponent.js')) return Type => Type;
            return resolved.startsWith(clientRoot + path.sep) ? load(resolved) : native(name);
        };
        loaded._compile(code, file); return loaded.exports;
    };
    return load(path.join(clientRoot, relative)).default;
}

async function testRc13KeywordFiltersApplyToRestoredGroupBooks() {
    const books = [{id: 1, file: 'one', title: 'Общее название', author: 'Автор', series: 'Серия', keywords: 'волки, лес', ext: 'fb2', genre: 'sf', lang: 'ru', del: 0},
        {id: 2, file: 'two', title: 'Общее название', author: 'Автор', series: 'Серия', keywords: 'кошки', ext: 'fb2', genre: 'sf', lang: 'ru', del: 0}];
    for (const keywords of ['волк', '*волки', '=волки, лес', '~^волки']) {
        const list = createWebList(); list.search = {keywords};
        assert.deepEqual(list.filterBooks(books).map(book => book.id), [1], keywords);
    }
    const Type = loadClient(path.join(clientRoot, 'components/Search/TitleList/TitleList.vue')).default;
    const list = new Type(); list.search = {keywords: 'волки'}; list.searchResult = {found: [{id: 1, title: 'Общее название', books}]};
    await list.updateTableData();
    assert.equal(list.tableData[0].book.id, 1); assert.deepEqual(list.tableData[0].books, []);
}

async function testRc13CatalogCacheEnforcesBudgetAndLinearStartupCleanup() {
    const {AuthorBooksStorage} = loadClient(path.join(clientRoot, 'components/Search/authorBooksStorage.js'));
    const backing = memoryStorage(Array.from({length: 30}, (_, i) => [`legacy-${i}1`, 'x'.repeat(10)]));
    backing.items.set('addTime-orphan1', 1);
    let time = 100;
    const cache = new AuthorBooksStorage(backing, 100, () => ++time);
    await cache.init();
    assert(cache.bytes <= 100); assert.equal(cache.entries.size, 5);
    assert.equal(backing.counts.scans, 1); assert(backing.counts.reads <= 90, 'Read each legacy payload and its metadata once');
    assert(!backing.items.has('addTime-orphan1'));
    await Promise.all(Array.from({length: 20}, (_, i) => cache.setData(`new-${i}`, 'y'.repeat(10))));
    assert(cache.bytes <= 100); assert.equal(cache.entries.size, 5);
    assert.equal(backing.counts.scans, 1, 'Writes use the LRU index rather than rescan full payloads');
    assert.equal(await cache.setData('oversized', 'z'.repeat(51)), false);
    const keysBefore = [...backing.items.keys()];
    assert.equal(await cache.getData('missing'), null);
    assert.deepEqual([...backing.items.keys()], keysBefore, 'A miss must not create timestamp records');
    await cache.getData('new-15'); await cache.setData('latest', 'z'.repeat(10));
    assert.equal(await cache.getData('new-15'), 'y'.repeat(10), 'Reading refreshes LRU retention');
    assert.equal(await cache.getData('new-16'), null);
    const broken = new AuthorBooksStorage({keys: async() => {throw new Error('Storage disabled');}}, 100);
    assert.equal(await broken.getData('key'), null); assert.equal(await broken.setData('key', 'data'), false);
}

async function testRc13CacheQuotaFailuresPreserveServerResultsAndAuthorKeyScope() {
    const {AuthorBooksStorage} = loadClient(path.join(clientRoot, 'components/Search/authorBooksStorage.js'));
    const backing = memoryStorage(); backing.setItem = async() => {throw Object.assign(new Error('Full'), {name: 'QuotaExceededError'});};
    const cache = new AuthorBooksStorage(backing, 1000);
    const Type = freshClient('components/Search/BaseList.js', cache), list = new Type();
    const books = [{id: 1, title: 'Received successfully'}];
    Object.assign(list, {getQuery: () => ({}), list: {inpxHash: 'hash'}, api: {getAuthorBookList: async() => ({books}),
        getSeriesBookList: async() => ({books})}, $root: {stdDialog: {alert: message => assert.fail(message)}}});
    assert.deepEqual(await list.loadAuthorBooks(1), books);
    assert.deepEqual(await list.loadSeriesBooks('Series'), books);

    const entries = new Map(), calls = [];
    const working = {getData: async key => {calls.push(key); return entries.get(key) || null;}, setData: async(key, value) => entries.set(key, value)};
    const Author = freshClient('components/Search/AuthorList/AuthorList.vue', working), author = new Author();
    let query = {sourceId: 'one', hideCopies: true};
    Object.assign(author, {list: {inpxHash: 'hash'}, getQuery: () => query, cachedAuthors: {Author: {id: 7, author: 'Author'}}, api: {getAuthorBookList: async() => ({books})}});
    await author.loadAuthorBooks(7);
    assert.equal((await author.getCachedSearchResult({author: '=Author'})).totalFound, 1);
    assert.equal(calls[0], calls[1]);
    query = {sourceId: 'two', hideCopies: true};
    assert.equal(await author.getCachedSearchResult({author: '=Author'}), null, 'Different source must not reuse the cached author response');
}

async function testRc13ReaderProgressIsScopedAcrossFreshInstancesAndClears() {
    const Type = loadClient(path.join(clientRoot, 'components/Reader/Reader.vue')).default;
    const previous = global.localStorage, storage = syncStorage(); global.localStorage = storage;
    const reader = id => {
        const value = new Type(); value.$route = {path: '/reader', query: {bookUid: 'book'}};
        value.$store = {state: {settings: {currentUserId: id}, config: {currentUserId: id, profileAuthorized: !!id}}};
        return value;
    };
    try {
        const alice = reader('alice'); alice.progress = {percent: .73, pageIndex: 73, textSnippet: 'Alice position'};
        alice.writeStoredReaderProgress();
        const bob = reader('bob'); assert.equal(bob.readStoredReaderProgress(), null);
        assert.equal(reader('alice').readStoredReaderProgress().percent, .73);
        const anonymous = reader(''); anonymous.progress = {percent: .2}; anonymous.writeStoredReaderProgress();
        bob.clearStoredReaderProgress('', {all: true});
        assert.equal(reader('alice').readStoredReaderProgress().percent, .73);
        assert.equal(reader('').readStoredReaderProgress().percent, .2);
        const old = JSON.parse(storage.getItem('inpx.reader.progress.v1'));
        old.progress.book = {percent: .9}; storage.setItem('inpx.reader.progress.v1', JSON.stringify(old));
        assert.equal(bob.readStoredReaderProgress(), null, 'Legacy global progress is not assigned to a new signed-in user');
    } finally {if (previous === undefined) delete global.localStorage; else global.localStorage = previous;}
}

async function testRc13ReaderPreferencesMigrateImagesOnceAndRestoreOfflineByProfile() {
    const {ReaderPreferencesStorage} = loadClient(path.join(clientRoot, 'components/Reader/readerPreferencesStorage.js'));
    const image = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024), preferences = {theme: 'sepia', fontSize: 20, backgroundImage: image};
    const local = syncStorage([['inpx.reader.preferences.v1', JSON.stringify({preferences, byUser: {alice: preferences}})]]);
    const backing = memoryStorage();
    backing.setItem = async(key, value) => backing.items.set(key, structuredClone(value));
    const cache = new ReaderPreferencesStorage(backing, () => local);
    assert.equal(cache.readSync('bob'), null);
    const first = await cache.read('alice'); assert.equal(first.preferences.backgroundImage, image);
    assert.equal(await cache.read('bob'), null); assert.equal(await cache.read(''), null, 'Do not import the old signed-in global copy as anonymous preferences');
    assert(local.getItem('inpx.reader.preferences.v1').length < 1024);
    const entry = backing.items.get('profile:alice');
    assert.equal(entry.preferences.backgroundImage, ''); assert.equal(entry.background.data, image);
    assert.equal(backing.items.size, 1, 'Keep a single profile image rather than a duplicate global copy');
    const url = '/library/reader-background/alice/' + 'a'.repeat(64) + '.png';
    await cache.write('alice', {...preferences, backgroundImage: url}, require('vue').reactive({source: url, data: image}));
    await cache.write('alice', {...preferences, fontSize: 22, backgroundImage: url});
    const reloaded = new ReaderPreferencesStorage(backing, () => local);
    const restored = await reloaded.read('alice');
    assert.equal(restored.preferences.backgroundImage, url); assert.equal(restored.preferences.fontSize, 22);
    assert.equal(restored.background.data, image, 'Keep the offline bitmap while preferences use the canonical server URL');
    assert(!local.getItem('inpx.reader.preferences.v1').includes(image));
}

async function testRc13ReaderAcceptsCanonicalBackgroundWithoutPersistingAccessToken() {
    const Type = loadClient(path.join(clientRoot, 'components/Reader/Reader.vue')).default, reader = new Type();
    const image = 'data:image/png;base64,AAAA', url = '/reader-background/alice/' + 'b'.repeat(64) + '.png';
    reader.$store = {state: {settings: {currentUserId: 'alice', profileAccessToken: 'private-token'}, config: {}}};
    reader.preferences = {...reader.preferences, backgroundImage: image};
    const writes = []; reader.writeStoredReaderPreferences = async() => {writes.push({...reader.preferences});};
    reader.$root = {api: {updateReaderPreferences: async submitted => {assert.equal(submitted.backgroundImage, image);return {preferences: {...submitted, backgroundImage: url}};}}};
    await reader.persistPreferences();
    assert.equal(reader.preferences.backgroundImage, url); assert.equal(reader.localReaderBackground.data, image);
    assert.equal(writes.length, 2); assert.equal(writes[1].backgroundImage, url);
    assert(!JSON.stringify(writes).includes('private-token'));
    reader.localReaderBackground = null;
    assert(reader.readerBackgroundStyle['--reader-background-image'].includes('?access=private-token'));
    assert.equal(reader.preferences.backgroundImage, url);
    let alerts = 0; reader.$root.stdDialog = {alert: () => alerts++};
    reader.handleReaderBackgroundUpload({target: {files: [{type: 'image/svg+xml', size: 10}], value: 'chosen'}});
    assert.equal(alerts, 1, 'New uploads accept only the raster formats supported by the asset route');
}

async function testRc13VuexPersistencePurgesConfigAndIgnoresConfigMutations() {
    const {persistenceOptions} = loadClient(path.join(clientRoot, 'store/persistence.js'));
    const VuexPersistence = require('vuex-persist').default, {createStore} = require('vuex');
    const storage = syncStorage([['vuex', JSON.stringify({settings: {darkTheme: true}, config: {readerPreferences: {backgroundImage: 'large-private-image'}}})]]);
    const plugin = new VuexPersistence({...persistenceOptions, storage});
    const store = createStore({state: {settings: {darkTheme: false}, config: {}}, mutations: {
        setConfig: (state, value) => {state.config = value;}, setSettings: (state, value) => Object.assign(state.settings, value),
    }, plugins: [plugin.plugin]});
    assert.equal(store.state.settings.darkTheme, true); assert.deepEqual(store.state.config, {});
    assert(!storage.getItem('vuex').includes('large-private-image'));
    store.commit('setConfig', {backgroundImage: 'x'.repeat(1024 * 1024)});
    store.commit('setSettings', {darkTheme: false});
    assert.deepEqual(JSON.parse(storage.getItem('vuex')), {settings: {darkTheme: false}});
    storage.setItem = () => {throw new Error('Quota');};
    assert.doesNotThrow(() => store.commit('setSettings', {darkTheme: true}));
}

function serviceWorker() {
    const scope = 'https://fixture.test/library/', handlers = new Map(), entries = new Map();
    let online = true, calls = 0;
    const urlKey = request => new URL(typeof request === 'string' ? request : request.url, scope).href;
    const cache = {match: async request => entries.get(urlKey(request))?.clone(), delete: async request => entries.delete(urlKey(request)),
        put: async(request, response) => entries.set(urlKey(request), response.clone()), keys: async() => [...entries.keys()].map(url => new Request(url))};
    const environment = {URL, Headers, Response, Request: class extends Request {
        constructor(input, options) {super(typeof input === 'string' ? new URL(input, scope) : input, options);}
    }, self: {registration: {scope}, location: {origin: 'https://fixture.test'}, addEventListener: (name, handler) => handlers.set(name, handler),
        skipWaiting: async() => {}, clients: {claim: async() => {}}}, caches: {open: async() => cache, keys: async() => [], delete: async() => {}},
    fetch: async request => {
        calls++; if (!online) throw new Error('Offline');
        const url = new URL(typeof request === 'string' ? request : request.url, scope), headers = new Headers();
        headers.set('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
        headers.set('cache-control', url.searchParams.has('private') ? 'private, no-store' : url.pathname.endsWith('index.html') ? 'no-cache, must-revalidate' : 'public, max-age=60');
        return new Response(url.searchParams.has('large') ? 'x'.repeat(3 * 1024 * 1024) : `body:${url.pathname}`, {headers});
    }};
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/assets/sw.js'), 'utf8'), environment);
    return {entries, calls: () => calls, offline: () => {online = false;}, async request(relative, navigate = false, headers = {}) {
        const request = new Request(new URL(relative, scope), {headers});
        if (navigate) Object.defineProperty(request, 'mode', {value: 'navigate'});
        let response; const waits = [];
        handlers.get('fetch')({request, respondWith: value => {response = value;}, waitUntil: value => waits.push(value)});
        const result = response ? await response : await environment.fetch(request);
        await Promise.all(waits); await tick(); return result;
    }};
}

async function testRc13ServiceWorkerBypassesDynamicPrivateAndRangeRequests() {
    const worker = serviceWorker();
    await worker.request('index.html', true);
    const shell = await worker.entries.get('https://fixture.test/library/index.html').clone().text();
    for (const resource of ['reader-audio/' + 'a'.repeat(64) + '.mp3?access=secret', 'admin-backups/private.zip', 'reader-background/alice/hash.png', 'api/index-status']) {
        await worker.request(resource); await worker.request(resource);
    }
    await worker.request('admin-backups/private.zip', true);
    assert.equal(worker.entries.size, 1); assert.equal(await worker.entries.get('https://fixture.test/library/index.html').clone().text(), shell);
    await worker.request('appabcdef/bundle.js?private=1'); await worker.request('appabcdef/bundle.js?private=1');
    await worker.request('appabcdef/bundle.js', false, {Range: 'bytes=0-9'});
    assert.equal(worker.entries.size, 1);
    const before = worker.calls();
    await worker.request('appabcdef/bundle.js'); await worker.request('appabcdef/bundle.js');
    assert.equal(worker.calls() - before, 1, 'Public static assets are cached');
    worker.offline(); assert.equal(await (await worker.request('index.html', true)).text(), shell, 'Offline navigation retains the real app document');
}

async function testRc13ServiceWorkerBoundsEntriesAndPayloadBytes() {
    const worker = serviceWorker();
    for (let i = 0; i < 110; i++) await worker.request(`appabcdef/${i}.js`);
    assert(worker.entries.size <= 96);
    for (let i = 0; i < 7; i++) await worker.request(`appabcdef/large${i}.js?large=1`);
    let bytes = 0; for (const response of worker.entries.values()) bytes += Number(response.headers.get('x-inpx-cache-bytes'));
    assert(bytes <= 16 * 1024 * 1024); assert(worker.entries.size <= 96);
}

module.exports = [testRc13KeywordFiltersApplyToRestoredGroupBooks, testRc13CatalogCacheEnforcesBudgetAndLinearStartupCleanup,
    testRc13CacheQuotaFailuresPreserveServerResultsAndAuthorKeyScope, testRc13ReaderProgressIsScopedAcrossFreshInstancesAndClears,
    testRc13ReaderPreferencesMigrateImagesOnceAndRestoreOfflineByProfile, testRc13ReaderAcceptsCanonicalBackgroundWithoutPersistingAccessToken,
    testRc13VuexPersistencePurgesConfigAndIgnoresConfigMutations, testRc13ServiceWorkerBypassesDynamicPrivateAndRangeRequests,
    testRc13ServiceWorkerBoundsEntriesAndPayloadBytes];
