const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const Fb2Helper = require('../server/core/fb2/Fb2Helper');

async function testReaderColdDocumentDoesNotWaitForReviewIndex() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-reader-opening-'));
    let releaseReviews;
    let normalInfo;
    let timeout;
    const reviewGate = new Promise(resolve => { releaseReviews = resolve; });
    try {
        const record = {id: 1, _uid: 'cold-book', ext: 'fb2', title: 'Первое открытие', author: 'Автор'};
        const xml = '<FictionBook><description><title-info><book-title>Первое открытие</book-title><lang>ru</lang></title-info></description>' +
            '<body><section><p>Текст книги доступен без отзывов.</p></section></body></FictionBook>';
        await fs.writeFile(path.join(dir, 'cold'), xml);
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = {bookDir: dir, bookPathStatic: '/book', branch: 'production'};
        worker.checkMyState = () => {};
        worker.fb2Helper = new Fb2Helper();
        worker.db = {esc: JSON.stringify, select: async() => [record]};
        worker.getBookLink = async() => ({link: '/book/cold', size: Buffer.byteLength(xml)});
        worker.readingListStore = {getMetadataOverrides: async() => ({})};
        let reviewCalls = 0;
        let indexingStarted;
        const indexing = new Promise(resolve => { indexingStarted = resolve; });
        worker.getReviewArchiveState = async() => ({signature: 'reviews-v1'});
        worker.getBookReviews = async() => {
            reviewCalls++;
            indexingStarted();
            await reviewGate;
            return [{text: 'Отзыв из библиотеки'}];
        };
        worker.getBookLibraryRating = async() => { await reviewGate; return {rating: 5}; };
        normalInfo = worker.getBookInfo(record._uid);
        await indexing;
        const reader = await Promise.race([
            worker.getBookInfo(record._uid, {readerOnly: true}),
            new Promise((resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Reader waited for review indexing')), 1500);
            }),
        ]);
        clearTimeout(timeout);
        assert.strictEqual(reader.bookInfo.book.title, record.title);
        assert.ok(JSON.stringify(reader.bookInfo.fb2).includes('Текст книги доступен без отзывов.'));
        assert.deepStrictEqual(reader.bookInfo.reviews, []);
        assert.strictEqual((await fs.readJson(path.join(dir, 'cold.i.json'))).reviewSignature, undefined);
        releaseReviews();
        const full = await normalInfo;
        assert.deepStrictEqual(full.bookInfo.reviews, [{text: 'Отзыв из библиотеки'}]);
        assert.deepStrictEqual(full.bookInfo.libraryRating, {rating: 5});
        assert.strictEqual(full.bookInfo.reviewSignature, 'reviews-v1');
        worker.getReviewArchiveState = async() => { throw new Error('Reader accessed review archives'); };
        assert.deepStrictEqual((await worker.getBookInfo(record._uid, {readerOnly: true})).bookInfo.fb2, reader.bookInfo.fb2);
        worker.getReviewArchiveState = async() => ({signature: 'reviews-v1'});
        await worker.getBookInfo(record._uid);
        assert.strictEqual(reviewCalls, 1, 'Full book info must retain its review cache');
        // A cache created by reading must still receive reviews on a later Info request.
        await fs.remove(path.join(dir, 'cold.i.json'));
        await worker.getBookInfo(record._uid, {readerOnly: true});
        const laterInfo = await worker.getBookInfo(record._uid);
        assert.deepStrictEqual(laterInfo.bookInfo.reviews, full.bookInfo.reviews);
        assert.strictEqual(reviewCalls, 2);
    } finally {
        clearTimeout(timeout);
        releaseReviews();
        if (normalInfo) await normalInfo.catch(() => {});
        await fs.remove(dir);
    }
}

async function testCatalogOpensReaderBeforeColdFilePreparation() {
    const source = await fs.readFile(path.resolve(__dirname, '../client/components/Search/BaseList.js'), 'utf8');
    const method = source.slice(source.indexOf('    async download(book, action, format = '), source.indexOf('    getBookUid(book = {}'));
    const pendingPreparation = new Promise(() => {});
    const BaseList = new Function('utils', 'axios', 'window', `return class {${method}}`)(
        {sleep: () => pendingPreparation}, {}, {location: {origin: 'http://localhost'}});
    const list = new BaseList();
    list.config = {onlineReaderEnabled: true};
    const events = [];
    list.$router = {push: async route => { events.push(route); }};
    list.api = {getBookLink: async() => { throw new Error('Reader must prepare its own file'); }};
    list.$root = {stdDialog: {alert: message => { throw new Error(message); }}};
    list.getErrorMessage = async error => error.message;
    await list.download({_uid: 'cold-book', ext: 'FB2'}, 'readBook');
    assert.deepStrictEqual(events, [{path: '/reader', query: {bookUid: 'cold-book'}}]);
    assert.strictEqual(list.downloadFlag, false);
    assert.strictEqual(list.loadingMessage2, '');
    // External readers still need a prepared URL.
    list.config.onlineReaderEnabled = false;
    list.list = {liberamaReady: true};
    list.api.getBookLink = async() => ({link: '/book/prepared'});
    list.$emit = (name, event) => { events.push({name, event}); };
    await list.download({_uid: 'external-book', ext: 'fb2'}, 'readBook');
    assert.deepStrictEqual(events[1], {name: 'listEvent', event: {action: 'submitUrl', data: 'http://localhost/book/prepared'}});
}

module.exports = [testReaderColdDocumentDoesNotWaitForReviewIndex, testCatalogOpensReaderBeforeColdFilePreparation];
