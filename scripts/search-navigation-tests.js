const assert = require('assert');
const path = require('path');
const _ = require('lodash');
const {loadClient} = require('./catalog-list-filter-tests');

function type(name) {
    return loadClient(path.resolve(__dirname, '../client/components', name)).default;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
function view(name, query, list = {}) {
    const Type = type(`Search/${name}/${name}.vue`);
    const result = new Type();
    result.list = list;
    result.getQuery = () => _.cloneDeep(query.value);
    result.updateTableData = async function() { this.tableData = this.searchResult.found; };
    result.scrollToTop = () => {};
    result.highlightPageScroller = () => {};
    return result;
}
function search() {
    const Type = type('Search/Search.vue');
    const result = new Type();
    result.$store = {state: {config: {extendedSearch: true, dbConfig: {inpxInfo: {recStruct: []}}}, settings: {}}};
    result.$refs = {};
    result.$route = {path: '/author', query: {author: 'Стругацкий', page: '5', limit: '20'}};
    result.$router = {replace: route => result.writtenRoutes.push(route)};
    result.writtenRoutes = [];
    result.ready = true;
    result.langDefault = '';
    result.makeTitle = () => {};
    result.updateSearchDate = () => {};
    result.refreshDiscoveryShelves = () => {};
    result.generateDefaults(result.search, ['author', 'series', 'title', 'keywords', 'genre', 'lang', 'date', 'librate', 'ext', 'sourceId', 'hideCopies']);
    result.generateDefaults(result.extSearch, []);
    result.selectedList = 'author';
    result.selectedListComponent = 'AuthorList';
    result.updateSearchFromRouteQuery(result.$route);
    return result;
}
function route(state, to) {
    const oldList = state.selectedList;
    state.$route = to;
    state._options.watch.$route.call(state, to);
    if (oldList !== state.selectedList) state._options.watch.selectedList.call(state, state.selectedList);
    state._options.watch.search.handler.call(state, state.search);
}
function count(state, context, totalFound) {
    state.$refs.list = {searchRequestId: 77, getPaginationContext: () => _.cloneDeep(context.value)};
    state.list.searchRequestId = 77;
    state.list.queryContext = _.cloneDeep(context.value);
    state.list.totalFound = totalFound;
    state.updatePageCount();
}

async function testSearchRoutePageAndBoundsIsolation() {
    const state = search();
    state.pageCount = 5;
    state.prevPage = 5; // Previously restored even for a different route.
    route(state, {path: '/series', query: {series: 'Звездные', page: '2', limit: '20'}});
    assert.strictEqual(state.search.page, 2);
    assert.strictEqual(state.list.totalFound, -1);
    state.updatePageCount();
    assert.strictEqual(state.search.page, 2, 'Unknown count must not reset an explicit URL page');
    const context = {value: {series: 'Звездные'}};
    count(state, context, 240);
    assert.strictEqual(state.pageCount, 12);
    assert.strictEqual(state.search.page, 2);
    state.search.page = 5;
    state.search.series = 'Новый поиск';
    context.value = {series: 'Новый поиск'};
    state.list.totalFound = 3; // Results still belong to the previous filter.
    state.updatePageCount();
    assert.strictEqual(state.search.page, 5);
    count(state, context, 240);
    assert.strictEqual(state.search.page, 5, 'Reloading the same query retains the page');
    state.limit = 100;
    state.updatePageCount();
    assert.strictEqual(state.pageCount, 3);
    assert.strictEqual(state.search.page, 1, 'A known shorter result must clamp an invalid page');
    count(state, context, 0);
    assert.strictEqual(state.pageCount, 1);
}

async function testSearchRouteHistoryAndNumericParameters() {
    const state = search();
    state.updateRouteQueryFromSearch();
    assert.strictEqual(state.writtenRoutes.length, 0, 'String and numeric URL values are equivalent');
    state.search.author = 'Новый автор';
    state.updateRouteQueryFromSearch();
    assert.strictEqual(state.writtenRoutes.length, 1);
    // Real navigation in the same tick must not be suppressed by an own URL write.
    route(state, {path: '/author', query: {author: 'Прежний автор', page: '2', limit: '20'}});
    assert.strictEqual(state.search.author, 'Прежний автор');
    assert.strictEqual(state.search.page, 2);
    route(state, {path: '/title', query: {title: 'Стая', page: '4', limit: '20'}});
    assert.strictEqual(state.search.title, 'Стая');
    assert.strictEqual(state.search.page, 4);
    state.$store.state.config.dbConfig.inpxInfo.recStruct = [{field: 'title'}];
    state.generateDefaults(state.extSearch, ['title']);
    route(state, {path: '/extended', query: {page: '3', limit: '100', ex_title: '*стая'}});
    assert.strictEqual(state.search.page, 3);
    assert.strictEqual(state.extSearch.page, 3);
    assert.strictEqual(state.extSearch.title, '*стая');
    state.updateSearchFromRouteQuery({path: '/title', query: {page: '-5', limit: '-20'}});
    assert.strictEqual(state.search.page, 1);
    assert.strictEqual(state.search.limit, 1);
    state.updateSearchFromRouteQuery({path: '/title', query: {page: 'invalid', limit: '9999999'}});
    assert.strictEqual(state.search.page, 1);
    assert.strictEqual(state.search.limit, 1000);
}

async function testCatalogSearchIgnoresSupersededResponses() {
    for (const name of ['TitleList', 'AuthorList', 'SeriesList', 'AllBooksList', 'ExtendedList']) {
        for (const failure of [false, true]) {
            const query = {value: {title: 'old', page: 1, limit: 20}};
            const first = deferred(), started = deferred(), published = [];
            const shared = new Proxy({}, {set(target, key, value) {
                target[key] = value;
                if (key === 'totalFound' && value >= 0) published.push(value);
                return true;
            }});
            const current = view(name, query, shared);
            const calls = [];
            const api = async(...args) => {
                calls.push(args.at(-1));
                if (calls.length === 1) {started.resolve(); return first.promise;}
                return {found: [{title: 'new'}], totalFound: 240, inpxHash: 'new'};
            };
            current.api = {search: api, bookSearch: api};
            const running = current.refresh();
            await started.promise;
            query.value = {title: 'new', page: 5, limit: 20};
            await current.refresh();
            if (failure) first.reject(new Error('obsolete failure'));
            else first.resolve({found: [{title: 'old'}], totalFound: 3, inpxHash: 'old'});
            await running;
            assert.deepStrictEqual(published, [240], name);
            assert.deepStrictEqual(current.tableData, [{title: 'new'}]);
            assert.strictEqual(current.error, '');
            assert.strictEqual(calls[1].page, 5);
            assert.strictEqual(shared.inpxHash, 'new');
        }
    }
}

async function testCatalogSearchRetryAndCoalescing() {
    const query = {value: {title: 'retry', page: 5, limit: 20}};
    const current = view('TitleList', query);
    let calls = 0;
    current.api = {search: async() => {
        if (++calls === 1) throw new Error('temporary network failure');
        return {found: [], totalFound: 240};
    }};
    await current.refresh();
    assert.match(current.error, /temporary/);
    assert.strictEqual(current.list.totalFound, -1);
    assert.strictEqual(query.value.page, 5);
    await current.refresh();
    assert.strictEqual(calls, 2);
    assert.strictEqual(current.error, '');
    await current.refresh();
    assert.strictEqual(calls, 2, 'Successful identical queries are deduplicated');
    const first = deferred(), started = deferred(), requests = [];
    current.api.search = async(...args) => {
        const q = args.at(-1);
        requests.push(q.title);
        if (requests.length === 1) {started.resolve(); return first.promise;}
        return {found: [{title: q.title}], totalFound: 1};
    };
    query.value.title = 'A';
    const running = current.refresh();
    await started.promise;
    query.value.title = 'B'; await current.refresh();
    query.value.title = 'C'; await current.refresh(); await current.refresh();
    first.resolve({found: [], totalFound: 100});
    await running;
    assert.deepStrictEqual(requests, ['A', 'C']);
    assert.deepStrictEqual(current.tableData, [{title: 'C'}]);
}

async function testCatalogSearchUnmountAndCacheRaces() {
    const first = deferred(), started = deferred(), shared = {};
    const old = view('AuthorList', {value: {author: 'old'}}, shared);
    old.api = {search: async() => {started.resolve(); return first.promise;}};
    const running = old.refresh();
    await started.promise;
    old.beforeUnmount();
    const current = view('SeriesList', {value: {series: 'new'}}, shared);
    current.api = {search: async() => ({found: [{series: 'new'}], totalFound: 240})};
    await current.refresh();
    first.reject(new Error('unmounted request failed'));
    await running;
    assert.strictEqual(shared.totalFound, 240);
    assert.deepStrictEqual(current.tableData, [{series: 'new'}]);
    const late = deferred(), lateStarted = deferred();
    const previous = view('TitleList', {value: {title: 'previous'}}, shared);
    previous.api = {search: async() => {lateStarted.resolve(); return late.promise;}};
    const previousLoad = previous.refresh();
    await lateStarted.promise;
    const next = view('AllBooksList', {value: {title: 'next'}}, shared);
    next.api = {bookSearch: async() => ({found: [{title: 'next'}], totalFound: 80})};
    await next.refresh();
    // Ownership must protect the shared count even before the old unmount hook.
    late.resolve({found: [{title: 'previous'}], totalFound: 999});
    await previousLoad;
    assert.strictEqual(shared.totalFound, 80);
    assert.deepStrictEqual(next.tableData, [{title: 'next'}]);
    const query = {value: {author: '=cached'}};
    const cached = view('AuthorList', query);
    const cacheWait = deferred(), cacheStarted = deferred();
    cached.getCachedSearchResult = async q => {
        if (q.author === '=cached') {cacheStarted.resolve(); return cacheWait.promise;}
        return null;
    };
    cached.api = {search: async() => ({found: [{author: 'fresh'}], totalFound: 1})};
    const loading = cached.refresh();
    await cacheStarted.promise;
    query.value = {author: 'fresh'};
    await cached.refresh();
    cacheWait.resolve({found: [{author: 'cached'}], totalFound: 999});
    await loading;
    assert.deepStrictEqual(cached.tableData, [{author: 'fresh'}]);
    assert.strictEqual(cached.list.totalFound, 1);
}

async function testCatalogExpandedRowsDoNotPublishAfterNewQuery() {
    for (const name of ['AuthorList', 'SeriesList']) {
        const Type = type(`Search/${name}/${name}.vue`), current = new Type();
        const gate = deferred(), started = deferred();
        const query = {title: 'old'};
        current.getQuery = () => query;
        current.list = {searchRequestId: 1};
        current.searchResult = {found: [{id: 1, author: 'A', series: 'A', bookCount: 1, bookDelCount: 0}]};
        current.tableData = ['existing'];
        current.expandedAuthor = ['A']; current.expandedSeries = ['A'];
        current.loadAuthorInfo = () => {};
        current.getAuthorBooks = current.getSeriesBooks = async() => {started.resolve(); await gate.promise; return true;};
        const loading = current.updateTableData({id: 1, query: {...query}});
        await started.promise;
        query.title = 'new'; current.list.searchRequestId = 2;
        gate.resolve(); await loading;
        assert.deepStrictEqual(current.tableData, ['existing'], name);
    }
}

async function testPageScrollerFollowsModelOnMountAndRemount() {
    const {createRenderer, h, ref, nextTick} = require('vue');
    const register = type('vueComponent.js');
    const component = register(type('Search/PageScroller/PageScroller.vue'));
    component.render = function() {return h('input', {value: this.page});};
    const renderer = createRenderer({createElement: name => ({name, children: []}),
        insert: (node, parent) => parent.children.push(node), remove: () => {}, setElementText: () => {},
        patchProp: (node, key, old, value) => {node[key] = value;}, createText: text => ({text}), createComment: text => ({text}),
        setText: () => {}, setComment: () => {}, parentNode: () => null, nextSibling: () => null});
    const page = ref(5), instance = ref();
    const app = renderer.createApp({render: () => h(component, {ref: instance, modelValue: page.value, pageCount: 12,
        'onUpdate:modelValue': value => {page.value = value;}})});
    app.mount({children: []});
    assert.strictEqual(instance.value.page, 5);
    instance.value.page++;
    await nextTick();
    assert.strictEqual(page.value, 6);
    page.value = 9; await nextTick();
    assert.strictEqual(instance.value.page, 9);
    app.unmount();
    const remounted = renderer.createApp(component, {modelValue: page.value, pageCount: 12});
    const restored = remounted.mount({children: []});
    assert.strictEqual(restored.page, 9);
    remounted.unmount();
}

module.exports = [testSearchRoutePageAndBoundsIsolation, testSearchRouteHistoryAndNumericParameters,
    testCatalogSearchIgnoresSupersededResponses, testCatalogSearchRetryAndCoalescing,
    testCatalogSearchUnmountAndCacheRaces, testCatalogExpandedRowsDoNotPublishAfterNewQuery,
    testPageScrollerFollowsModelOnMountAndRemount];
