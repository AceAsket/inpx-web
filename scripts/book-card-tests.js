const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const resourceRuntime = require('../server/core/ResourceRuntime');

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {resolve = a; reject = b;});
    return {promise, resolve, reject};
}

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-card-tests-'));
    try {await task(dir);} finally {await fs.remove(dir);}
}

function cardFixture(dir) {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const fixture = {worker, index:'index-1', annotation:'First annotation', extracted:0};
    fixture.record = {id:7, _uid:'stable-uid', ext:'fb2', folder:'books.zip', file:'123', title:'Book',
        sourceId:'source', sourceLibDir:'/library/first', _recordHash:'record-1'};
    worker.config = {bookDir:dir};
    worker.fb2Helper = new (require('../server/core/fb2/Fb2Helper'))();
    worker.checkMyState = () => {};
    worker.db = {esc:JSON.stringify, select:async() => [fixture.record]};
    worker.dbConfig = async() => ({inpxHash:fixture.index});
    worker.readingListStore = {getMetadataOverrides:async() => ({})};
    worker.applyPreparedBookSizesToRows = async() => {};
    worker.getReviewArchiveState = async() => ({signature:'reviews'});
    worker.getBookReviews = async() => [];
    worker.getBookLibraryRating = async() => null;
    worker.prepareBookInBackground = () => {};
    worker.extractBook = async() => {
        const file = path.join(dir, `extracted-${++fixture.extracted}`);
        await fs.writeFile(file, '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
            `<description><title-info><annotation><p>${fixture.annotation}</p></annotation></title-info></description>` +
            '<body><section><p>Body</p></section></body></FictionBook>');
        return file;
    };
    fixture.read = async() => JSON.stringify((await worker.getBookCardInfo(fixture.record._uid)).bookInfo.fb2);
    return fixture;
}

async function testCardCacheTracksIndexRecordAndSourceAcrossRestarts() {
    await temporary(async dir => {
        const fixture = cardFixture(dir);
        assert((await fixture.read()).includes('First annotation'));
        await fixture.read();
        assert.strictEqual(fixture.extracted, 1);
        const restarted = cardFixture(dir);
        restarted.worker.resetLibraryAssetCaches();
        assert((await restarted.read()).includes('First annotation'));
        assert.strictEqual(restarted.extracted, 0, 'A restart with the same index retains the persistent cache');

        for (const [kind, change] of [
            ['record', () => {fixture.record._recordHash = 'record-2';}],
            ['source', () => {fixture.record.sourceLibDir = '/library/replacement';}],
            ['index', () => {fixture.index = 'index-2';}],
        ]) {
            fixture.annotation = `Updated ${kind}`;
            change();
            assert((await fixture.read()).includes(fixture.annotation), `${kind} changes must refresh the description`);
        }
        assert.strictEqual(fixture.extracted, 4);
        assert(!(await fs.readdir(dir)).some(name => name.startsWith('extracted-')));
    });
}

async function testLateCardCannotOverwriteTheNewIndexCache() {
    await temporary(async dir => {
        const fixture = cardFixture(dir), started = deferred(), release = deferred();
        const original = fixture.worker.readBookCardFb2.bind(fixture.worker);
        let first = true;
        fixture.worker.readBookCardFb2 = async book => {
            const result = await original(book);
            if (first) {first = false; started.resolve(); await release.promise;}
            return result;
        };
        const old = fixture.read();
        const rejected = assert.rejects(old, {code:'INPX_LIBRARY_CHANGED'});
        try {
            await started.promise;
            fixture.index = 'new-index'; fixture.annotation = 'Current annotation';
            fixture.worker.resetLibraryAssetCaches();
            assert((await fixture.read()).includes('Current annotation'));
        } finally {release.resolve(); await rejected;}
        assert((await fixture.read()).includes('Current annotation'));
        const caches = (await fs.readdir(dir)).filter(name => name.endsWith('.card.json'));
        assert.strictEqual(caches.length, 1, 'The obsolete request must not save a card');
    });
}

async function testBookPreparationSharesOnlyTheCurrentLibraryGeneration() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    worker.checkMyState = () => {};
    worker.db = {}; worker.libraryAssetGeneration = 1;
    const gates = [deferred(), deferred()];
    let calls = 0;
    worker.prepareBookLink = async() => await gates[calls++].promise;
    const old = Promise.allSettled([worker.getBookLink('same'), worker.getBookLink('same')]);
    assert.strictEqual(calls, 1);
    worker.checkMyState = () => {throw new Error('Index is being rebuilt');};
    await assert.rejects(worker.getBookLink('same'), /Index is being rebuilt/);
    worker.checkMyState = () => {};
    worker.resetLibraryAssetCaches(); worker.db = {};
    const current = Promise.all([worker.getBookLink('same'), worker.getBookLink('same')]);
    assert.strictEqual(calls, 2);
    gates[0].resolve({link:'/book/old'});
    const previous = await old;
    assert(previous.every(item => item.status === 'rejected' && item.reason.code === 'INPX_LIBRARY_CHANGED'));
    assert.strictEqual(worker.bookLinkJobs.size, 1, 'Old completion must not remove the current job');
    gates[1].resolve({link:'/book/current'});
    const [a, b] = await current;
    assert.deepStrictEqual(a, {link:'/book/current'});
    assert.notStrictEqual(a, b); a.extra = true; assert.strictEqual(b.extra, undefined);
    assert.strictEqual(worker.bookLinkJobs.size, 0);
    worker.prepareBookLink = async() => {throw new Error('Archive unavailable');};
    await assert.rejects(worker.getBookLink('same'), /Archive unavailable/);
    assert.strictEqual(worker.bookLinkJobs.size, 0);
    worker.prepareBookLink = async() => ({link:'/book/retry'});
    assert.strictEqual((await worker.getBookLink('same')).link, '/book/retry');
}

async function testCardBackgroundPreparationRespectsPriorityAndSkipsOldQueue() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const settings = require('../server/core/ResourcePolicy').resolve({INPX_RESOURCE_MAX_PROCESSES:'2'}, {cpu:4, memoryLimit:8 * 1024 ** 3});
    const native = new resourceRuntime.ResourceRuntime(settings);
    const started = deferred(), release = deferred(), calls = [], events = [];
    worker.getBookLink = async uid => {
        calls.push(uid);
        assert(resourceRuntime.isBackground(), 'Both running and queued books must retain the background context');
        if (uid === 'first') {
            await Promise.all([
                native.run(async() => {events.push('background-1'); started.resolve(); await release.promise;}, {kind:'images'}),
                native.run(async() => {events.push('background-2');}, {kind:'images'}),
            ]);
        }
    };
    const first = worker.prepareBookInBackground('first');
    await started.promise;
    const obsolete = worker.prepareBookInBackground('obsolete');
    worker.resetLibraryAssetCaches();
    const current = worker.prepareBookInBackground('current');
    try {
        assert.strictEqual(native.snapshot().background, 1);
        await native.run(async() => {events.push('foreground');}, {kind:'images'});
        assert.deepStrictEqual(events, ['background-1', 'foreground'], 'Foreground work has an available slot');
    } finally {release.resolve(); await Promise.all([first, obsolete, current]);}
    assert.deepStrictEqual(calls, ['first', 'current']);
    assert.deepStrictEqual(events, ['background-1', 'foreground', 'background-2']);
    assert.strictEqual(native.active, 0); assert.strictEqual(worker.backgroundBookQueue.freed, true);
    worker.getBookLink = async() => {throw new Error('Background archive unavailable');};
    await worker.prepareBookInBackground('failed');
    assert.strictEqual(worker.backgroundBookQueue.freed, true);
}

async function testCardIgnoresLateSuccessAndErrorsAcrossCloseAndReopen() {
    const base = await fs.readFile(path.join(__dirname, '../client/components/Search/BaseList.js'), 'utf8');
    const method = base.slice(base.indexOf('    async openBookCard('), base.indexOf('    getBookUid('));
    const List = new Function(`let nextBookCardRequestId = 0; return class {${method}}`)();
    const source = await fs.readFile(path.join(__dirname, '../client/components/Search/Search.vue'), 'utf8');
    const Search = new Function(`return class {${source.slice(source.indexOf('    listEvent(event)'), source.indexOf('    openReaderLibrary()'))}}`)();
    const parent = new Search(), requests = [], alerts = [];
    parent.$root = {stdDialog:{alert:(...args) => alerts.push(args)}};
    const list = new List();
    list.$emit = (_, event) => parent.listEvent(event);
    list.api = {getBookCard:async() => {const request = deferred(); requests.push(request); return await request.promise;}};
    list.getErrorMessage = async e => e.message;
    const firstBook = {_uid:'same', size:1};
    const first = list.openBookCard(firstBook, 'fb2');
    parent.bookInfoDialogVisible = false;
    const second = list.openBookCard({_uid:'same', size:2}, 'fb2');
    requests[0].resolve({bookInfo:{book:{_uid:'same', size:100}, marker:'stale'}});
    await first;
    assert.strictEqual(parent.bookInfo.loading, true, 'A previous opening of the same UID must not replace the current card');
    assert.strictEqual(firstBook.size, 1, 'Discarded replies must not mutate the catalog row');
    requests[1].resolve({bookInfo:{book:{_uid:'same', size:200}, marker:'current'}});
    await second;
    assert.strictEqual(parent.bookInfo.marker, 'current');

    const oldError = list.openBookCard({_uid:'A'}, 'fb2');
    parent.bookInfoDialogVisible = false;
    const active = list.openBookCard({_uid:'B'}, 'fb2');
    requests[2].reject(new Error('Late error A')); await oldError;
    assert.strictEqual(alerts.length, 0);
    requests[3].reject(new Error('Current error B')); await active;
    assert.deepStrictEqual(alerts, [['Current error B', 'Ошибка']]);
    assert.strictEqual(parent.bookInfo.loading, undefined);

    const closed = list.openBookCard({_uid:'C'}, 'fb2');
    parent.bookInfoDialogVisible = false;
    requests[4].reject(new Error('Closed C')); await closed;
    assert.strictEqual(alerts.length, 1, 'Closing without another card must also discard errors');
}

async function testBookRequestsSharePendingWorkWithoutRetainingDocuments() {
    await temporary(async dir => {
        const {worker, record} = cardFixture(dir);
        const original = worker.readBookCardFb2.bind(worker), gate = deferred(), started = deferred();
        worker.readBookCardFb2 = async book => {started.resolve(); await gate.promise; return original(book);};
        const one = worker.getBookCardInfo(record._uid), two = worker.getBookCardInfo(record._uid);
        await started.promise; gate.resolve();
        const [a, b] = await Promise.all([one, two]);
        assert.strictEqual((await fs.readdir(dir)).filter(name => name.endsWith('.card.json')).length, 1);
        assert.notStrictEqual(a.bookInfo.book, b.bookInfo.book, 'Response decoration cannot mutate another caller');
        assert.strictEqual(worker.bookInfoJobs.size, 0, 'Parsed metadata is not retained after delivery');

        let parses = 0, release = deferred();
        worker.buildBookInfo = async() => {parses++; await release.promise; return {bookInfo: {book: record, fb2: 'large document'}};};
        const readers = Array.from({length: 12}, () => worker.getBookInfo(record._uid, {readerOnly: true}));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(parses, 1, 'Concurrent reader openings parse once');
        release.resolve(); await Promise.all(readers);
        assert.strictEqual(worker.bookInfoJobs.size, 0);
        await worker.getBookInfo(record._uid, {readerOnly: true});
        assert.strictEqual(parses, 2, 'Finished document promises must not become an unbounded memory cache');
        worker.buildBookInfo = async() => {throw new Error('Failed document');};
        await assert.rejects(worker.getBookInfo(record._uid, {readerOnly: true}), /Failed document/);
        assert.strictEqual(worker.bookInfoJobs.size, 0, 'Failed jobs are released and may be retried');
        release = deferred();
        worker.buildBookInfo = async() => {await release.promise; return {bookInfo: {book: record}};};
        const old = worker.getBookInfo(record._uid, {readerOnly: true});
        const rejected = assert.rejects(old, {code: 'INPX_LIBRARY_CHANGED'});
        await new Promise(resolve => setImmediate(resolve));
        worker.resetLibraryAssetCaches();
        const fresh = worker.getBookInfo(record._uid, {readerOnly: true});
        release.resolve(); await rejected; await fresh;
        assert.strictEqual(worker.bookInfoJobs.size, 0);
    });
}

async function testLookupWaitingForReaderDoesNotReserveBackgroundResources() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    worker.db = {close: async() => {}}; worker.libraryAssetGeneration = 1;
    const lookup = new (require('../server/core/CatalogLookupIndex'))(worker);
    const release = deferred();
    const foreground = worker.runForeground(() => release.promise);
    const lookupJob = resourceRuntime.withBackground(() => lookup.background(async() => 'indexed'));
    try {
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(resourceRuntime.snapshot().background, 0, 'A lookup waiting for foreground I/O must not occupy a background resource slot');
        let completed = false;
        const preparedBook = resourceRuntime.withBackground(() => resourceRuntime.run(async() => {completed = true;}, {kind: 'images'}));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert(completed, 'An existing background book needed by the reader can finish while the lookup waits');
        await preparedBook;
    } finally {release.resolve(); await foreground; await lookupJob; await lookup.close();}
}

module.exports = [testCardCacheTracksIndexRecordAndSourceAcrossRestarts, testLateCardCannotOverwriteTheNewIndexCache,
    testBookPreparationSharesOnlyTheCurrentLibraryGeneration, testCardBackgroundPreparationRespectsPriorityAndSkipsOldQueue,
    testCardIgnoresLateSuccessAndErrorsAcrossCloseAndReopen, testBookRequestsSharePendingWorkWithoutRetainingDocuments,
    testLookupWaitingForReaderDoesNotReserveBackgroundResources];
