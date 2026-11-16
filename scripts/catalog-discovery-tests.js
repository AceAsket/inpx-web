const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {distance, relevance, scope} = require('../shared/CatalogDiscovery');

async function fixture(work) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-discovery-'));
    const db = new (require('jembadb').JembaDb)();
    let searcher;
    try {
        const library = path.join(dir, 'books'); await fs.ensureDir(library);
        const entries = [
            ['Косточка', 'Толстой', 'Рассказы', 'ru'], ['Ася', 'Тургенев', 'Рассказы', 'ru'],
            ['Детство', 'Толстой', 'Трилогия', 'ru'], ['Childhood', 'Толстой', 'Trilogy', 'en'],
        ];
        for (let i = 0; i < entries.length; i++) {
            const [title, author, series, lang] = entries[i];
            await fs.writeFile(path.join(library, `${i}.fb2`), `<FictionBook><description><title-info><author><last-name>${author}</last-name></author><book-title>${title}</book-title><sequence name="${series}" number="${i + 1}"/><lang>${lang}</lang></title-info></description><body><section><p>Text</p></section></body></FictionBook>`);
        }
        const config = {dataDir: path.join(dir, 'data'), libDir: library, inpxFilterFile: path.join(dir, 'no-filter'),
            dbVersion: 14, queryCacheEnabled: true, queryCacheMemSize: 30, queryCacheDiskSize: 0,
            librarySources: [{id: 'own', name: 'Own', type: 'folder', libDir: library}]};
        await fs.ensureDir(config.dataDir); await db.lock({dbPath: path.join(config.dataDir, 'db'), create: true});
        await new (require('../server/core/DbCreator'))(config).run(db, () => {}); await db.openAll();
        searcher = new (require('../server/core/DbSearcher'))(config, db); await searcher.init();
        const worker = {db, dbSearcher: searcher, libraryAssetGeneration: 1, applyMetadataOverridesToSearchResult: async() => {}};
        const service = new (require('../server/core/CatalogDiscovery'))(worker);
        await work(service, worker);
        await service.close();
    } finally {if (searcher) await searcher.close(); await db.unlock().catch(() => {}); await fs.remove(dir);}
}

async function testCatalogDiscoveryIndexedSuggestionsAndScopedAlphabet() {
    assert.strictEqual(distance('толстой', 'толстйо', 1), 1);
    assert.strictEqual(distance('толстой', 'тургенев', 1), 2);
    assert(relevance('Ася', 'ася') > relevance('Ася и другие рассказы', 'ася'));
    assert.throws(() => scope({lang: '~.*'}));
    await fixture(async(service, worker) => {
        const author = await service.suggest({query: 'тол'});
        assert.strictEqual(author.groups.find(group => group.kind === 'author').items[0].name, 'Толстой');
        const selectedAuthor = (await worker.dbSearcher.search('author', {author:'тол', lang:'ru'})).found[0];
        const expanded = await worker.dbSearcher.getAuthorBookList(selectedAuthor.id);
        const list = require('./catalog-list-filter-tests').createWebList();
        for (const [lang, expected] of [['ru', 2], ['en', 1], ['ru', 2]]) {
            list.search = {lang};
            assert.strictEqual(list.filterBooks(expanded.books).length, expected, 'Expanded author lists apply the current language even to cached books');
            const page = await service.entity({kind:'author', name:'Толстой', filters:{lang}});
            assert.strictEqual(page.total, expected); assert(page.books.every(book => book.lang === lang));
        }
        const {catalogScope, catalogTarget} = require('../client/components/Library/catalogSearchModel');
        const filters = {lang:'ru', ext:'fb2', genre:'prose', sourceId:'own'};
        assert.deepStrictEqual(catalogScope({...filters, name:'Old author', page:'5', title:'*Old book'}), filters);
        assert.deepStrictEqual(catalogTarget('/author-details', {name:'Толстой'}, {...filters, name:'Old', page:5}),
            {path:'/author-details', query:{...filters, name:'Толстой'}});
        const routes = [];
        list.$router = {push:target => routes.push(target)}; list.search = {...filters};
        list.selectAuthor('Толстой'); list.selectSeries('Рассказы');
        for (const action of ['authorClick', 'seriesClick', 'bookInfo'])
            list.bookEvent({action, book:{_uid:'book', author:'Толстой', series:'Рассказы'}});
        assert.equal(routes.length, 5);
        for (const target of routes) assert.deepStrictEqual(catalogScope(target.query), filters, 'Book-list links carry the same scope as suggestions');
        const title = await service.suggest({query: 'Кост'});
        assert.strictEqual(title.groups.find(group => group.kind === 'title').items[0].book.title, 'Косточка');
        const ru = await service.browse({kind: 'author', filters: {lang: 'ru'}});
        assert.deepStrictEqual(ru.items.map(item => item.name), ['Толстой', 'Тургенев']);
        assert.strictEqual(ru.items[0].count, 2);
        assert.deepStrictEqual((await service.browse({kind: 'author', prefix: 'Тур'})).items.map(item => item.name), ['Тургенев']);
        assert.deepStrictEqual((await service.suggest({query: 'тол', filters: {sourceId: 'missing'}})).groups.flatMap(group => group.items), []);
        const typo = await service.suggest({query: 'толстйо', kind: 'author'});
        assert(typo.corrections.some(item => item.kind === 'author' && item.query === 'толстой'));
        const previous = await service.suggest({query: 'тол'});
        const selectIds = worker.dbSearcher.selectBookIds.bind(worker.dbSearcher);
        worker.dbSearcher.selectBookIds = async() => {throw new Error('Typeahead must not expand authors into all book IDs');};
        assert((await service.suggest({query: 'толс'})).groups.find(group => group.kind === 'author').items.length);
        worker.dbSearcher.selectBookIds = selectIds;
        const entity = await service.entity({kind: 'series', name: 'Рассказы'}, {readerProgress: {[title.groups.find(group => group.kind === 'title').items[0].book._uid]: {percent: 1}}});
        assert.strictEqual(entity.total, 2); assert.strictEqual(entity.read, 1); assert(entity.next);
        assert.strictEqual((await service.entity({kind: 'series', name: 'Рассказы'})).read, null, 'Public entity caches contain no profile progress');
        worker.libraryAssetGeneration++;
        assert.notStrictEqual(await service.suggest({query: 'тол'}), previous, 'Index replacement invalidates cached responses');
        await assert.rejects(service.browse({kind: 'title'}));
        await assert.rejects(service.suggest({query: 'a'.repeat(121)}));
        const authorRows = [{id: 100, name: 'Большой', value: 'большой', bookIds: [1], bookCount: 1, bookDelCount: 0},
            ...Array.from({length: 205}, (_, index) => ({id: 101 + index, name: `Большой Автор ${index}`, value: `большой автор ${index}`,
                bookIds: [1], bookCount: 1, bookDelCount: 0}))];
        await worker.db.insert({table: 'author', rows: authorRows});
        const split = await service.browse({kind: 'author', prefix: 'большой'});
        assert(split.groups.some(group => group.name === 'Большой'), 'An exact name remains selectable beside a larger prefix');
        assert(split.groups.some(group => group.prefix === 'большой а'), 'Refinement skips invisible whitespace-only steps');
        assert.strictEqual((await service.browse({kind: 'author', prefix: 'большой '})).total, 205, 'Trailing whitespace is part of the prefix');
    });
}

async function testCatalogDiscoveryCoalescedCache() {
    await fixture(async(service, worker) => {
        let calls = 0, release;
        const gate = new Promise(resolve => {release = resolve;});
        const one = service.cached('coalesced', async() => {calls++; await gate; return {ok: true};});
        const two = service.cached('coalesced', () => {throw new Error('Concurrent queries should share work');});
        release(); assert.deepStrictEqual(await one, await two); assert.strictEqual(calls, 1);
        let finish;
        const pending = service.cached('obsolete', () => new Promise(resolve => {finish = resolve;}));
        worker.libraryAssetGeneration++;
        const rejection = assert.rejects(pending, /Библиотека обновилась/); finish({old: true}); await rejection;
        assert(!service.cache.has('obsolete'), 'A response from an old catalog cannot enter the new cache');
    });
}

async function testTelegramShortSearchUsesActualIndexedCatalog() {
    await fixture(async(service,worker)=>{
        const TelegramBot=require('../server/core/TelegramBot'),user={id:'reader'},messages=[];
        worker.config={dataDir:os.tmpdir()};worker.readingListStore={findTelegramUser:async()=>user};
        worker.bookSearch=query=>worker.dbSearcher.bookSearch(query);
        worker.getCatalogDiscovery=()=>{throw new Error('The bot must not ask autocomplete to find a short title');};
        const bot=new TelegramBot(worker,{sleep:async()=>{}}),run={botId:'42',controller:new AbortController(),api:{call:async(method,data)=>{messages.push(data);}}};bot.run=run;
        try {
            const ctx={run,chatId:'101',userId:user.id};await bot.dispatch(ctx,user,'search',{query:'Ас'});
            assert(messages.at(-1).text.includes('Найдено: 1'));
            assert(messages.at(-1).reply_markup.inline_keyboard.flat().some(button=>button.text==='Ася'));
            await bot.dispatch(ctx,user,'search',{query:'Толст',kind:'author'});
            assert(messages.at(-1).text.includes('Найдено: 3'));
        }finally{bot.stop();}
    });
}
module.exports = {testCatalogDiscoveryIndexedSuggestionsAndScopedAlphabet, testCatalogDiscoveryCoalescedCache,
    testTelegramShortSearchUsesActualIndexedCatalog};
if (require.main === module) (async() => {for (const test of Object.values(module.exports)) {await test(); console.log(test.name + ': OK');}})()
    .catch(error => {console.error(error); process.exitCode = 1;});
