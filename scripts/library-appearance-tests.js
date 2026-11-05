const assert = require('assert/strict');
const {LibraryRepository} = require('../client/components/Library/libraryRepository');
const model = require('../client/components/Library/libraryModel');
const catalog = require('../client/components/Library/catalogSearchModel');

const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function fixture() {
    const calls = [];
    const api = Object.fromEntries(['getMobileHome', 'getUserReadingLibrary', 'getReadingLists', 'getDiscoveryShelves'].map(name => [name, async(...args) => {
        calls.push({name, args});
        if (name === 'getMobileHome') return {reading: {items: [{bookUid: 'first'}]}, lists: [{id: 'list'}]};
        if (name === 'getUserReadingLibrary') return {items: [{bookUid: 'first'}]};
        if (name === 'getReadingLists') return {lists: [{id: 'list'}]};
        return {shelves: [{id: 'newest', items: [{_uid: 'first'}]}]};
    }]));
    let time = 0;
    const repository = new LibraryRepository(api, () => {}, () => time);
    const config = {currentUserId: 'one', profileAuthorized: true, clientApi: {features: ['mobileHome']}};
    const settings = {currentUserId: 'one', profileAccessToken: 'session-one'};
    repository.setContext(config, settings);
    return {repository, api, calls, config, settings, advance: value => {time += value;}};
}

async function testLibraryHomeCachesExpensiveShelvesAndRefreshesReadingIndependently() {
    const {repository, calls, advance} = fixture();
    await repository.loadHome();
    await repository.loadHome();
    assert.deepEqual(calls.map(call => call.name), ['getMobileHome', 'getDiscoveryShelves']);
    assert.equal(repository.state.shelves[0].books[0]._uid, 'first', 'Discovery uses the real server items contract');
    advance(31000);
    await repository.loadHome();
    assert.equal(calls.filter(call => call.name === 'getMobileHome').length, 2);
    assert.equal(calls.filter(call => call.name === 'getDiscoveryShelves').length, 1);
    await repository.loadHome({freshReading: true});
    assert.equal(calls.filter(call => call.name === 'getDiscoveryShelves').length, 1, 'Returning from the reader must not recalculate discovery');
    advance(15 * 60000);
    await repository.loadHome();
    assert.equal(calls.filter(call => call.name === 'getDiscoveryShelves').length, 2);
}

async function testLibraryHomeCoalescesConcurrentRefreshes() {
    const {repository, api} = fixture(), response = deferred();
    let requests = 0;
    api.getMobileHome = () => {requests++; return response.promise;};
    const first = repository.loadReading(), second = repository.loadReading(true);
    assert.equal(requests, 1);
    response.resolve({reading: {items: []}, lists: []});
    await Promise.all([first, second]);
    assert.equal(repository.state.readingLoading, false);
}

async function testLibraryHomeClearsPrivateDataAndRejectsLateProfileResponses() {
    const {repository, api, config} = fixture();
    await repository.loadHome();
    const response = deferred();
    api.getMobileHome = () => response.promise;
    const old = repository.loadReading(true);
    repository.setContext({...config, currentUserId: 'two'}, {currentUserId: 'two', profileAccessToken: 'session-two'});
    assert.equal(repository.state.reading, null);
    assert.deepEqual(repository.state.lists, []);
    assert.deepEqual(repository.state.shelves, []);
    api.getMobileHome = async() => ({reading: {items: [{bookUid: 'second'}]}, lists: []});
    await repository.loadReading();
    response.resolve({reading: {items: [{bookUid: 'private-first'}]}, lists: [{id: 'private-list'}]});
    await old;
    assert.equal(repository.state.reading.items[0].bookUid, 'second');
    assert.deepEqual(repository.state.lists, []);
}

async function testLibraryHomeProtectsProfileSwitchBeforeNewConfigArrives() {
    const {repository, config, calls} = fixture();
    await repository.loadHome();
    repository.setContext(config, {currentUserId: 'two', profileAccessToken: ''});
    assert.equal(repository.state.reading, null);
    assert.equal(repository.state.locked, true);
    const before = calls.length;
    await repository.loadHome();
    assert.equal(calls.length, before, 'No background request may use credentials during a profile switch');
}

async function testLibraryHomeFallbackDoesNotOpenLoginAndKeepsHistoryWhenListsFail() {
    const {repository, api, config, settings, calls} = fixture();
    repository.setContext({...config, clientApi: {}}, settings);
    api.getReadingLists = async() => {throw new Error('Lists unavailable');};
    await repository.loadHome();
    assert.equal(repository.state.reading.items[0].bookUid, 'first');
    assert.equal(repository.state.listsError, 'Lists unavailable');
    assert.equal(calls.some(call => call.name === 'getMobileHome'), false);
    assert.equal(calls.find(call => call.name === 'getUserReadingLibrary').args[1].suppressProfileLogin, true);
    assert.equal(calls.find(call => call.name === 'getDiscoveryShelves').args[1].suppressProfileLogin, true);
}

async function testLibraryHomeRetainsCachedShelvesOnFailureAndAllowsRetry() {
    const {repository, api} = fixture();
    await repository.loadShelves();
    api.getDiscoveryShelves = async() => {throw new Error('Network unavailable');};
    await repository.loadShelves(true);
    assert.equal(repository.state.shelves[0].id, 'newest');
    assert.equal(repository.state.shelvesError, 'Network unavailable');
    assert.equal(repository.state.shelvesLoading, false);
    api.getDiscoveryShelves = async() => ({shelves: []});
    await repository.loadShelves(true);
    assert.deepEqual(repository.state.shelves, []);
    assert.equal(repository.state.shelvesError, '');
}

async function testLibraryHomeRejectsLateShelvesAfterOptionsChange() {
    const {repository, api, config, settings} = fixture(), old = deferred();
    api.getDiscoveryShelves = () => old.promise;
    const first = repository.loadShelves();
    repository.setContext(config, {...settings, discoveryNewestLimit: 16});
    api.getDiscoveryShelves = async options => ({shelves: [{id: String(options.newestLimit)}]});
    await repository.loadShelves();
    old.resolve({shelves: [{id: 'old'}]}); await first;
    assert.equal(repository.state.shelves[0].id, '16');
}

async function testLibraryHomeDisabledDiscoveryAndProtectedProfileAvoidRequests() {
    const {repository, config, settings, calls} = fixture();
    repository.setContext({...config, discovery: {enabled: false}}, settings);
    await repository.loadShelves();
    assert.equal(calls.length, 0);
    assert.equal(repository.state.shelvesLoaded, true);
    repository.setContext({...config, profileAuthorized: false, profileLoginRequired: true}, settings);
    await repository.loadHome();
    assert.equal(calls.length, 0);
    assert.equal(repository.state.locked, true);
}

async function testLibraryAppearancePreservesCatalogLinksAndReaderRoutes() {
    for (const path of ['/reader', '/reader-lab', '/books', '/title', '/extended'])
        assert.equal(model.appearanceRedirect({path, query: {title: 'test'}}, 'shelves'), '');
    assert.equal(model.appearanceRedirect({path: '/', query: {}}, 'shelves'), '/overview');
    assert.equal(model.appearanceRedirect({path: '/', query: {author: 'Толстой'}}, 'shelves'), '');
    assert.equal(model.appearanceRedirect({path: '/overview'}, 'classic'), '/for-you');
    assert.equal(model.appearanceRedirect({path: '/profile'}, 'invalid-old-setting'), '/books');
    assert.equal(model.appearance('unknown'), 'classic');
}

async function testLibraryBooksUseStructuredProgressStableIdsAndRealAvailability() {
    const items = [
        {bookUid: 'read', state: 'read', percent: 1, updatedAt: '2026-11-05'},
        {bookUid: 'hidden', hidden: true, percent: .2, updatedAt: '2026-11-06'},
        {bookUid: 'gone', unavailable: true, percent: .4, updatedAt: '2026-11-06'},
        {bookUid: 'current', percent: .34, updatedAt: '2026-11-04'},
        {bookUid: 'current', percent: .1, updatedAt: '2026-11-03'},
    ];
    const home = model.homeBooks(items);
    assert.equal(home.current.bookUid, 'current');
    assert.deepEqual(home.recent.map(book => book.bookUid), ['read']);
    assert.equal(model.progress({_readerProgress: {percent: .23}}), .23);
    assert.equal(model.progress({discoveryReason: '37% прочитано'}), null, 'Never parse UI text as reading state');
    assert.equal(model.readable({bookUid: 'a', ext: 'epub'}, {onlineReaderEnabled: true}), false);
    assert.equal(model.readable({bookUid: 'a', ext: 'fb2'}, {onlineReaderEnabled: true}), true);
    assert.equal(model.readable({bookUid: 'a', ext: 'fb2', unavailable: true}, {onlineReaderEnabled: true}), false);
    assert.equal(model.coverUrl({bookUid: 'source:a/b'}, '/library/'), '/library/cover/by-uid?uid=source%3Aa%2Fb');
    assert.equal(model.coverUrl({libid: 7, sourceId: 'other lib'}, '/library'), '/library/cover/other%20lib/7');
}

async function testLibrarySearchPreservesMatchingModesAndNeverSearchesBlankWildcards() {
    for (const value of ['*Ася', '=Ася', 'Ася', '~^Ася', '?', '#Книга']) {
        const decoded = catalog.decodeText(value);
        assert.equal(catalog.encodeText(decoded.text, decoded.mode), value);
    }
    assert.equal(catalog.encodeText('   ', 'contains'), '');
    assert.equal(catalog.encodeText(null, 'exact'), '');
    assert.equal(catalog.encodeText('Тургенев', 'contains'), '*Тургенев');
    assert.equal(catalog.encodeText('Тургенев', 'exact'), '=Тургенев');
    assert.equal(catalog.canAutoSearch({title: {text: 'А'}}), false, 'A single typed letter cannot start an expensive substring search');
    assert.equal(catalog.canAutoSearch({title: {text: 'Ася'}, author: {text: 'Иван'}}), true);
    const original = {title: '*Ася', author: '*Иван', genre: 'prose', ext: 'fb2', hideCopies: true};
    const draft = catalog.filtersFrom(original);
    draft.ext = 'epub';
    assert.equal(original.ext, 'fb2', 'Editing a filter draft must not mutate the applied query');
    assert.equal(Object.hasOwn(draft, 'title'), false, 'Resetting filters keeps the title/author/series independent');
    const chips = catalog.activeFilters(original, new Map([['prose', 'Проза']]));
    assert(chips.some(chip => chip.label === 'Жанр: Проза'));
    assert(chips.some(chip => chip.label === 'Формат: FB2'));
    assert(chips.some(chip => chip.field === 'hideCopies'));
}

async function testLibraryDialogsSupportLazyInitialOpening() {
    const path = require('path');
    const {loadClient} = require('./catalog-list-filter-tests');
    for (const [name, method] of [['BookInfoDialog', 'init'], ['ReadingListsDialog', 'init'], ['UserProfilesDialog', 'loadProfiles'], ['SettingsDialog', '']]) {
        const Type = loadClient(path.resolve(__dirname, `../client/components/Search/${name}/${name}.vue`)).default;
        let loads = 0;
        const instance = {modelValue: true, dialogVisible: false, init() {loads++;}, loadProfiles() {loads++;}};
        Type.prototype.mounted.call(instance);
        assert.equal(instance.dialogVisible, true, `${name} must honor the first model value after lazy loading`);
        if (method) assert.equal(loads, 1, `${name} must populate its initial contents`);
    }
}

module.exports = [testLibraryHomeCachesExpensiveShelvesAndRefreshesReadingIndependently, testLibraryHomeCoalescesConcurrentRefreshes,
    testLibraryHomeClearsPrivateDataAndRejectsLateProfileResponses, testLibraryHomeProtectsProfileSwitchBeforeNewConfigArrives,
    testLibraryHomeFallbackDoesNotOpenLoginAndKeepsHistoryWhenListsFail, testLibraryHomeRetainsCachedShelvesOnFailureAndAllowsRetry,
    testLibraryHomeRejectsLateShelvesAfterOptionsChange, testLibraryHomeDisabledDiscoveryAndProtectedProfileAvoidRequests,
    testLibraryAppearancePreservesCatalogLinksAndReaderRoutes, testLibraryBooksUseStructuredProgressStableIdsAndRealAvailability,
    testLibrarySearchPreservesMatchingModesAndNeverSearchesBlankWildcards, testLibraryDialogsSupportLazyInitialOpening];
