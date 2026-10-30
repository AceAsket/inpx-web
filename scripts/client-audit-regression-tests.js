const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const {parse} = require('@vue/compiler-sfc');
const {loadClient} = require('./catalog-list-filter-tests');

const filename = relative => path.resolve(__dirname, '../client/components', relative);
const component = relative => loadClient(filename(relative)).default;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
function instance(options, props = {}) {
    const value = {...options.data?.(), ...props};
    for (const [name, method] of Object.entries(options.methods || {})) value[name] = method.bind(value);
    for (const [name, getter] of Object.entries(options.computed || {}))
        Object.defineProperty(value, name, {get: () => getter.call(value)});
    return value;
}
function api(clock = {setTimeout, clearTimeout}) {
    const file = filename('Api/Api.vue');
    const source = parse(fs.readFileSync(file, 'utf8')).descriptor.script.content;
    const body = source.slice(source.indexOf('class Api {'), source.indexOf('export default'));
    const Api = new Function('require', 'componentOptions', 'setTimeout', 'clearTimeout', `${body};return Api;`)(
        require('module').createRequire(file), {}, clock.setTimeout, clock.clearTimeout);
    // Exercise Vue's treatment of cancellation state and shared promises too.
    return require('vue').reactive(new Api());
}
function list(apiValue, query) {
    const value = new (component('Search/BaseList.js'))();
    Object.assign(value, {list: {totalFound: -1}, api: apiValue, getQuery: () => ({...query.value}),
        updateTableData: async function() {this.tableData = this.searchResult.found;},
        scrollToTop() {}, highlightPageScroller() {}});
    return value;
}

async function testRemovingVoteFilterDoesNotWaitForObsoleteIndexBuild() {
    for (const kind of ['title', 'books']) {
        const index = deferred(), calls = [], value = api();
        value.request = async request => {
            if (request.action === 'get-rating-index-status') return index.promise;
            calls.push(request.query);
            return {found: [{title: request.query.title}], totalFound: 1};
        };
        const query = {value: {title: 'Old', ratingCount: '20..'}}, current = list(value, query);
        const running = current.refreshSearch(kind, 'Searching');
        try {
            await tick();
            query.value = {title: 'New'};
            await current.refreshSearch(kind, 'Searching');
            await tick();
            assert.deepStrictEqual(calls, [{title: 'New'}], 'The new search must run before index readiness');
            await running;
            assert.deepStrictEqual(current.tableData, [{title: 'New'}]);
            assert.strictEqual(value.indexWaitMessage, '');
        } finally {
            current.beforeUnmount(); index.resolve({state: 'ready'}); await running;
        }
        await tick();
        assert.deepStrictEqual(calls, [{title: 'New'}], 'The obsolete filtered search must never be sent later');
    }
}

async function testVoteWaitCancellationPreservesOtherSearchesAndUnmounts() {
    const index = deferred(), value = api(), calls = [];
    value.request = async request => {
        if (request.action === 'get-rating-index-status') {calls.push('status'); return index.promise;}
        calls.push(request.query.title); return {found: [], totalFound: 0};
    };
    const current = list(value, {value: {title: 'Old', ratingCount: '20..'}});
    const running = current.refreshSearch('title', 'Searching');
    const other = value.search('title', {title: 'Other', ratingCount: '30..'});
    try {
        await tick(); current.beforeUnmount(); await tick();
        assert.strictEqual(current.refreshing, false, 'Unmount must release its pending wait');
        assert.deepStrictEqual(calls, ['status'], 'Concurrent users share status polling');
        index.resolve({state: 'ready'}); await Promise.all([running, other]);
        assert.deepStrictEqual(calls, ['status', 'Other'], 'Cancelling one search must preserve the other waiter');
        assert.strictEqual(value.ratingIndexWait, null);
        assert.strictEqual(value.indexWaitMessage, '');
    } finally {index.resolve({state: 'ready'}); await Promise.allSettled([running, other]);}
}

async function testCancelledVotePollCannotClearANewerWait() {
    const timers = new Map(), searches = []; let next = 0, statusReads = 0, ready = false;
    const value = api({setTimeout: callback => {timers.set(++next, callback); return next;}, clearTimeout: id => timers.delete(id)});
    value.request = async request => {
        if (request.action === 'get-rating-index-status') return {state: ready ? 'ready' : 'running', done: ++statusReads, total: 10};
        searches.push(request.query.title); return {found: []};
    };
    const oldController = new AbortController(), freshController = new AbortController();
    const old = value.search('title', {title: 'Old', ratingCount: '20..'}, oldController.signal).catch(error => error.name);
    await tick(); assert.strictEqual(timers.size, 1);
    oldController.abort();
    const fresh = value.search('title', {title: 'New', ratingCount: '30..'}, freshController.signal);
    try {
        await tick(); assert.strictEqual(await old, 'AbortError');
        assert.strictEqual(timers.size, 1, 'Only the new wait keeps a timer');
        assert.match(value.indexWaitMessage, /2 из 10/, 'The old poll must not clear the current message');
        assert(value.ratingIndexWait);
        ready = true;
        const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
        await fresh;
        assert.deepStrictEqual(searches, ['New']);
        assert.strictEqual(value.ratingIndexWait, null); assert.strictEqual(value.indexWaitMessage, '');
        assert.strictEqual(timers.size, 0);
    } finally {oldController.abort(); freshController.abort(); await Promise.allSettled([old, fresh]);}
}

function audio() {
    const file = filename('Reader/ReaderAudio.vue');
    const source = parse(fs.readFileSync(file, 'utf8')).descriptor.script.content;
    const storage = new Map();
    return new Function('navigator', 'localStorage', 'MediaMetadata', 'require', source.replace('export default', 'return'))(
        {}, {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}, undefined,
        require('module').createRequire(file));
}
async function testClosedAnchoredAudioCannotRestartAfterLateResponses() {
    for (const pendingStage of ['plan', 'position', 'mode']) {
        const delayed = deferred(), options = audio(); let preparations = 0;
        const chapters = [{index: 0, title: 'Chapter', characters: 100}];
        const plan = {chapters, startChapter: 0};
        const element = {currentTime: 0, duration: 60, paused: true, pause() {this.paused = true;},
            load() {}, removeAttribute() {}, play() {this.paused = false; return Promise.resolve();}};
        const player = instance(options, {bookUid: 'book', title: 'Book', $emit() {},
            $nextTick: () => pendingStage === 'mode' ? delayed.promise : Promise.resolve(),
            $store: {state: {settings: {currentUserId: 'reader'}, config: {profileAuthorized: true}}},
            $refs: {audio: element, preloadAudio: {...element}},
            $root: {api: {
                getReaderAudioPlan: async(uid, mode, anchor) => anchor && pendingStage === 'plan' ? delayed.promise : plan,
                audioPosition: async() => pendingStage === 'position' ? delayed.promise : {progress: {revision: 0}},
                prepareReaderAudio: async() => {preparations++; return {state: 'ready', url: '/late.mp3'};},
            }}});
        if (pendingStage === 'mode') player.mode = 'book';
        const opening = player.openAt({textSnippet: 'Current reader paragraph'});
        await tick(); player.close();
        delayed.resolve(pendingStage === 'position' ? {progress: {revision: 0}} : plan);
        await opening;
        assert.strictEqual(preparations, 0, pendingStage);
        assert.strictEqual(player.visible, false); assert.strictEqual(player.src, '');
        assert.strictEqual(element.paused, true);
        // A deliberate later open still works and is not blocked by the cancelled request.
        player.$nextTick = async() => {};
        await player.openAt({textSnippet: 'Current reader paragraph'});
        assert.strictEqual(preparations, 1); assert.strictEqual(player.src, '/late.mp3');
        player.close(); await player.positionWrite;
    }
}

const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=';
function bookCard(light = true) {
    const parser = new (require('../server/core/fb2/Fb2Parser'))();
    parser.fromString('<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>' +
        '<book-title>Book</book-title><annotation><p>Annotation <image l:href="#pic"/></p></annotation></title-info>' +
        '<document-info><history><p>History <image l:href="#pic"/></p></history></document-info></description>' +
        '<body><section><p>Body</p></section></body>' +
        (light ? '' : `<binary id="pic" content-type="image/png">${picture}</binary>`) + '</FictionBook>');
    return {book: {_uid: 'same-book', title: 'Book', ext: 'fb2'}, fb2: parser.rawNodes, ...light ? {galleryCount: 1} : {}};
}
function card(apiValue, light = true) {
    const value = new (component('Search/BookInfoDialog/BookInfoDialog.vue'))();
    Object.assign(value, {bookInfo: bookCard(light), api: apiValue, $root: {api: apiValue},
        $store: {state: {config: {}, settings: {}}}, $refs: {}, $emit() {}, dialogVisible: true});
    value.init(); return value;
}
const gallery = id => ({images: [{id, contentType: 'image/png', data: picture}]});
async function testReopenedGalleryIgnoresOldSuccessAndFailure() {
    for (const failure of [false, true]) {
        const old = deferred(), fresh = deferred(); let calls = 0;
        const value = card({getBookGallery: () => ++calls === 1 ? old.promise : fresh.promise});
        const first = value.loadGallery();
        value.dialogVisible = false; value._options.watch.dialogVisible.call(value, false);
        value.init(); value.dialogVisible = true;
        const second = value.loadGallery(); fresh.resolve(gallery('current')); await second;
        if (failure) old.reject(new Error('obsolete gallery failure'));
        else old.resolve(gallery('obsolete'));
        await first;
        assert.deepStrictEqual(value.fb2Images.map(image => image.id), ['current']);
        assert.strictEqual(value.galleryError, ''); assert.strictEqual(value.galleryLoading, false);
    }
}
async function testClosedGalleryDoesNotPublishLateResults() {
    for (const unmount of [false, true]) {
        const pending = deferred(), value = card({getBookGallery: () => pending.promise});
        const loading = value.loadGallery();
        if (unmount) value.beforeUnmount();
        else {value.dialogVisible = false; value._options.watch.dialogVisible.call(value, false);}
        pending.resolve(gallery('obsolete')); await loading;
        assert.deepStrictEqual(value.fb2Images, [], 'Closed and unmounted cards must not accept gallery responses');
    }
}
async function testLazyGalleryRestoresInlineAnnotationAndHistoryImages() {
    const value = card({getBookGallery: async() => gallery('pic')}), full = card({}, false);
    const history = cardValue => cardValue.fb2.find(item => item.name === 'documentInfo')?.value.find(item => item.name === 'historyHtml')?.value;
    assert(full.annotation.includes('<img'), 'The full-card path must retain inline images');
    assert(!value.annotation.includes('<img'));
    await value.loadGallery();
    assert.strictEqual(value.annotation, full.annotation, 'Lazy images must restore the same annotation markup');
    assert(history(full)?.includes('<img'), 'The fixture must include FB2 history with an inline image');
    assert.strictEqual(history(value), history(full), 'History must be regenerated too');
    assert.strictEqual(value.fb2Images.length, 1);
}

async function testFollowLinkUsesIndividualAuthorIndex() {
    const dir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'inpx-client-follow-'));
    const libDir = path.join(dir, 'books'), dataDir = path.join(dir, 'data');
    await fs.ensureDir(libDir); await fs.ensureDir(dataDir);
    const xml = authors => '<FictionBook><description><title-info>' + authors.map(name =>
        '<author><last-name>' + name + '</last-name></author>').join('') +
        '<book-title>Book ' + authors.length + '</book-title></title-info></description><body><section><p>Text</p></section></body></FictionBook>';
    await fs.writeFile(path.join(libDir, 'solo.fb2'), xml(['Author']));
    await fs.writeFile(path.join(libDir, 'joint.fb2'), xml(['Author', 'Coauthor']));
    const config = {dataDir, libDir, dbVersion: 14, dbCacheSize: 5, inpxFilterFile: path.join(dir, 'none'),
        queryCacheEnabled: false, librarySources: [{id: 'own', name: 'Own', type: 'folder', libDir}]};
    const db = new (require('jembadb').JembaDb)(); let searcher;
    try {
        await db.lock({dbPath: path.join(dataDir, 'db'), create: true});
        await new (require('../server/core/DbCreator'))(config).run(db, () => {}); await db.openAll();
        searcher = new (require('../server/core/DbSearcher'))(config, db); await searcher.init();
        const follows = new (require('../server/core/LibraryFollows'))({config, db, dbSearcher: searcher});
        const matches = await follows.matches('author', 'Author');
        const tools = instance(component('Search/LibraryTools.vue'));
        const url = new URL(tools.followHref({kind: 'author', value: 'Author'}).slice(1), 'http://fixture');
        const query = {...Object.fromEntries(url.searchParams), del: '0'};
        const linkedIds = url.pathname === '/author' ? await searcher.selectBookIds(query) : await searcher.bookSearchIds(query);
        assert.strictEqual(matches.length, 2);
        assert.strictEqual(linkedIds.length, matches.length, 'The follow collection must include coauthored books');
        assert.strictEqual(tools.followHref({kind: 'series', value: 'A & B'}), '#/books?series=%3DA%20%26%20B');
    } finally {if (searcher) await searcher.close(); await db.unlock(); await fs.remove(dir);}
}

async function testIsbnActionFailureResumesTaskPollingWithoutRevivingClosedDialog() {
    const file = filename('Search/LibraryTools.vue');
    const source = parse(fs.readFileSync(file, 'utf8')).descriptor.script.content;
    for (const operation of ['start', 'cancel']) for (const close of [false, true]) {
        const timers = new Map(), action = deferred(); let next = 0, reads = 0;
        const options = new Function('setTimeout', 'clearTimeout', source.replace('export default', 'return'))(
            callback => {timers.set(++next, callback); return next;}, id => timers.delete(id));
        const value = instance(options, {$root: {api: {
            getBackgroundTasks: async() => {reads++; return {tasks: [], isbnIndex: {state: 'running'}};},
            manageIsbnIndex: () => action.promise,
        }}});
        value.tasksOpen = true; await value.loadTasks(value.generation);
        assert.strictEqual(timers.size, 1);
        const managing = value.manageIsbn(operation);
        if (close) {value.tasksOpen = false; value.stopPolling();}
        action.reject(new Error('temporary network failure')); await managing;
        assert.strictEqual(timers.size, close ? 0 : 1);
        if (!close) {
            assert.match(value.error, /temporary/);
            const [id, callback] = timers.entries().next().value; timers.delete(id); await callback();
            assert.strictEqual(reads, 2); assert.strictEqual(timers.size, 1);
        }
        value.stopPolling();
    }
}

module.exports = [testRemovingVoteFilterDoesNotWaitForObsoleteIndexBuild,
    testVoteWaitCancellationPreservesOtherSearchesAndUnmounts, testCancelledVotePollCannotClearANewerWait,
    testClosedAnchoredAudioCannotRestartAfterLateResponses,
    testReopenedGalleryIgnoresOldSuccessAndFailure, testClosedGalleryDoesNotPublishLateResults,
    testLazyGalleryRestoresInlineAnnotationAndHistoryImages, testFollowLinkUsesIndividualAuthorIndex,
    testIsbnActionFailureResumesTaskPollingWithoutRevivingClosedDialog];
