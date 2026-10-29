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

async function testBookCardSkipsIllustrationsAndPreparesBookInBackground() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-book-card-'));
    try {
        const record = {id: 7, _uid: 'card-book', ext: 'fb2', file: '12345', folder: 'f.fb2-12000-12999.7z', title: 'Карточка'};
        const xml = '<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Карточка</book-title>' +
            '<annotation><p>Аннотация книги.</p></annotation><coverpage><image l:href="#cover"/></coverpage></title-info></description>' +
            '<body><section><title><p>Глава 1</p></title><p>Текст <image l:href="#1"/> и <image l:href="#2"/></p>' +
            Array.from({length: 25}, (_, num) => `<image l:href="#${num + 3}"/>`).join('') + '<image l:href="#1"/></section></body></FictionBook>';
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = {bookDir: dir};
        worker.checkMyState = () => {};
        worker.fb2Helper = new Fb2Helper();
        worker.db = {esc: JSON.stringify, select: async() => [record]};
        worker.readingListStore = {getMetadataOverrides: async() => ({})};
        worker.applyPreparedBookSizesToRows = async() => {};
        worker.dbConfig = async() => ({inpxHash: 'card-index-v1'});
        worker.getReviewArchiveState = async() => ({signature: 'reviews-v1'});
        worker.getBookReviews = async() => [{text: 'Отзыв'}];
        worker.getBookLibraryRating = async() => null;
        worker.injectFblibraryImages = async() => { throw new Error('Card must not extract illustrations'); };
        let extractions = 0;
        worker.extractBook = async() => {
            extractions++;
            const file = path.join(dir, `extracted-${extractions}`);
            await fs.writeFile(file, xml);
            return file;
        };
        let prepared;
        const preparedOnce = new Promise(resolve => { prepared = resolve; });
        let preparations = 0;
        worker.prepareBookLink = async(bookUid) => {
            preparations++;
            await new Promise(resolve => setTimeout(resolve, 20));
            prepared(bookUid);
            return {link: '/book/hash', size: 1};
        };

        const {bookInfo} = await worker.getBookCardInfo(record._uid);
        assert.strictEqual(bookInfo.book.title, 'Карточка');
        assert.strictEqual(bookInfo.cover, '');
        assert.deepStrictEqual(bookInfo.reviews, [{text: 'Отзыв'}]);
        assert.deepStrictEqual(bookInfo.contents.map(item => item.title), ['Глава 1']);
        assert.strictEqual(bookInfo.annotationMeta.stats.images, 27, 'Different illustrations referenced in the text');
        assert.strictEqual(bookInfo.galleryCount, 18);
        const fb2 = JSON.stringify(bookInfo.fb2);
        assert.ok(fb2.includes('Аннотация книги.'));
        assert.ok(!fb2.includes('Текст'), 'The card sends only <description>');
        assert.strictEqual(await preparedOnce, record._uid, 'The full book is prepared in the background');

        // Reading and downloading during the background preparation wait for the same work.
        await Promise.all(worker.bookLinkJobs.values());
        const [first, second] = await Promise.all([worker.getBookLink(record._uid), worker.getBookLink(record._uid)]);
        assert.strictEqual(preparations, 2, 'Two parallel requests prepare the book once');
        assert.notStrictEqual(first, second);
        assert.deepStrictEqual(first, second);

        worker.getReviewArchiveState = async() => { throw new Error('Broken review archive'); };
        const cached = (await worker.getBookCardInfo(record._uid)).bookInfo;
        assert.strictEqual(extractions, 1, 'The second card opening uses the card cache');
        assert.strictEqual(cached.book.title, 'Карточка', 'A review failure does not block the card');
        assert.deepStrictEqual(cached.reviews, [{text: 'Отзыв'}]);
        assert.ok(!(await fs.readdir(dir)).some(name => name.startsWith('extracted-')), 'Extracted FB2 files are removed');
    } finally {
        await fs.remove(dir);
    }
}

async function testBackgroundLibraryWorkWaitsForUser() {
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const events = [];
    let finishCard;
    const card = worker.runForeground(() => new Promise(resolve => { finishCard = resolve; }));

    const covers = [1, 2, 3].map(n => worker.runBackground(async() => { events.push(`cover ${n}`); }));
    const cancelled = worker.runBackground(async() => { events.push('closed cover'); }, () => true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepStrictEqual(events, [], 'Covers wait while the user waits for the card');

    finishCard();
    await card;
    await Promise.all([...covers, cancelled]);
    assert.deepStrictEqual(events, ['cover 1', 'cover 2', 'cover 3'], 'Covers run after the card, a closed request is skipped');

    // Background reads use the profile limit and the shared background mark;
    // the book preparation inside them does not stop other background work.
    const resourceRuntime = require('../server/core/ResourceRuntime');
    let active = 0, maxActive = 0;
    await Promise.all(Array.from({length: 5}, () => worker.runBackground(async() => {
        assert.ok(resourceRuntime.isBackground());
        await worker.runForeground(async() => {});
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
    })));
    assert.strictEqual(maxActive, resourceRuntime.settings.limits.background);
    assert.strictEqual(worker.foregroundJobs, 0);
}

async function testBookGalleryReturnsFirstImagesWithoutCover() {
    const Fb2Parser = require('../server/core/fb2/Fb2Parser');
    const parser = new Fb2Parser();
    parser.fromString('<FictionBook xmlns:l="x"><description><title-info><coverpage><image l:href="#cover"/></coverpage></title-info></description>' +
        '<binary id="cover" content-type="image/png">Y292ZXI=</binary>' +
        Array.from({length: 20}, (_, num) => `<binary id="${num}" content-type="${num ? 'image/png' : 'image/jpg'}">aW1n</binary>`).join('') +
        '</FictionBook>', {lowerCase: true});
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    worker.getBookInfo = async(bookUid, options) => {
        assert.deepStrictEqual(options, {readerOnly: true}, 'The gallery does not wait for reviews');
        return {bookInfo: {fb2: parser.rawNodes}};
    };
    const {images} = await worker.getBookGallery('gallery-book');
    assert.deepStrictEqual(images.map(image => image.id), Array.from({length: 18}, (_, num) => String(num)));
    assert.strictEqual(images[0].contentType, 'image/jpeg');
    assert.strictEqual(images[1].data, 'aW1n');
}

module.exports = [testReaderColdDocumentDoesNotWaitForReviewIndex, testCatalogOpensReaderBeforeColdFilePreparation,
    testBookCardSkipsIllustrationsAndPreparesBookInBackground, testBackgroundLibraryWorkWaitsForUser, testBookGalleryReturnsFirstImagesWithoutCover];
