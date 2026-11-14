const {MemoryCache} = require('./MemoryCache');
const {withFileTransaction} = require('./FilePersistence');

const listLimit = 200;
const compareNewest = (a, b) => String(b.date || '').localeCompare(String(a.date || ''))
    || String(a.title || '').localeCompare(String(b.title || ''), 'ru') || a._uid.localeCompare(b._uid);

class LibraryFollows {
    constructor(worker) {
        this.worker = worker;
        this.pending = new Map();
        this.catalogueChecks = new MemoryCache({bytes:128 * 1024, entries:256, ttl:60 * 60 * 1000});
        this.news = new MemoryCache({bytes:8 * 1024 ** 2, entries:32, ttl:15 * 60 * 1000});
    }
    async matches(kind, value) {
        if (!['author','series'].includes(kind) || typeof value !== 'string' || !value.trim() || value.length > 200)
            throw new Error('Укажите автора или серию (до 200 символов)');
        const db = this.worker.db;
        // The author index contains individual coauthors; bookSearchIds compares
        // an exact author filter with the book's entire comma-separated field.
        const ids = await this.worker.dbSearcher.selectBookIds({[kind]:'=' + value.trim(),del:'0'});
        if (ids.length > 5000) throw new Error('Слишком много книг для одной подписки (лимит 5000)');
        const books = [];
        for (let offset = 0; offset < ids.length; offset += 1000) books.push(...await db.select({table:'book',
            where:`@@id(${db.esc(Array.from(ids.slice(offset,offset + 1000)))})`,
            map:'row => ({_uid:row._uid,title:row.title,author:row.author,series:row.series,ext:row.ext,del:row.del})'}));
        return books.filter(book => book._uid && !book.del);
    }
    async change(userId, operation, payload = {}, authorize = null) {
        const store = this.worker.readingListStore;
        const persist = fields => authorize ? withFileTransaction(store.file, async () => {
            await authorize();
            await store.changeLibraryFollow(userId,operation,fields);
        }) : store.changeLibraryFollow(userId,operation,fields);
        if (operation === 'add') {
            if (typeof payload.value === 'string') payload = {...payload,value:payload.value.replace(/\s+/g,' ').trim()};
            const generation = this.worker.libraryAssetGeneration, db = this.worker.db;
            const books = await this.matches(payload.kind,payload.value);
            if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Повторите подписку');
            await persist({kind:payload.kind,value:payload.value,knownUids:books.map(book => book._uid)});
        } else if (['remove','seen'].includes(operation)) await persist({id:payload.id});
        else if (operation === 'seen-books') {
            const {bookUids} = payload;
            if (!Array.isArray(bookUids) || !bookUids.length || bookUids.length > listLimit
                || bookUids.some(uid => typeof uid !== 'string' || !uid || uid.length > 512))
                throw new Error('Некорректный список просмотренных книг');
            await persist({bookUids});
        } else throw new Error('Неизвестное действие с избранным');
        if (this.pending.has(userId)) await this.pending.get(userId).promise.catch(() => {});
        return this.list(userId,false,payload);
    }
    async list(userId, refresh = false, options = {}) {
        const {follows, books} = await this.load(userId,refresh,options.autoRefresh === true);
        const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
        const size = Number.isSafeInteger(options.limit) && options.limit >= 0 ? Math.min(options.limit,listLimit) : listLimit;
        return {follows, books:books.slice(offset,offset + size), unseenCount:books.length, truncated:offset + size < books.length};
    }
    async load(userId, refresh, autoRefresh) {
        const pending = this.pending.get(userId);
        if (pending) {
            if (!pending.refresh && (refresh || (autoRefresh && !pending.autoRefresh))) {
                await pending.promise;
                return this.load(userId,refresh,autoRefresh);
            }
            return pending.promise;
        }
        const loading = this.read(userId,refresh,autoRefresh).finally(() => {if (this.pending.get(userId)?.promise === loading) this.pending.delete(userId);});
        this.pending.set(userId,{promise:loading,refresh,autoRefresh});
        return loading;
    }
    async read(userId, refresh, autoRefresh) {
        const store = this.worker.readingListStore, generation = this.worker.libraryAssetGeneration, db = this.worker.db;
        const assertCurrent = () => {
            if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration)
                throw new Error('Библиотека обновилась. Обновите избранное');
        };
        let {follows, cacheKey} = await store.getLibraryFollows(userId);
        assertCurrent();
        const cached = this.news.get(userId);
        const refreshed = refresh || (autoRefresh && this.catalogueChecks.get(userId) !== generation);
        if (!refreshed && cached?.generation === generation && cached?.key === cacheKey) return cached.result;
        if (refreshed) {
            for (const follow of follows) {
                const books = await this.matches(follow.kind,follow.value);
                assertCurrent();
                const current = new Set(books.map(book => book._uid)), previous = new Set(follow.knownUids);
                const unread = new Set(follow.newUids);
                const fresh = [...current].filter(uid => !previous.has(uid) || unread.has(uid));
                await store.changeLibraryFollow(userId,'snapshot',{id:follow.id,revision:follow.revision,knownUids:[...current],newUids:fresh});
            }
            ({follows, cacheKey} = await store.getLibraryFollows(userId));
            assertCurrent();
            this.catalogueChecks.set(userId,generation);
        }
        const wanted = [...new Set(follows.flatMap(row => row.newUids))];
        const available = new Map();
        for (let offset = 0; offset < wanted.length; offset += 1000) {
            const rows = await db.select({table:'book',where:`@@hash('_uid', ${db.esc(wanted.slice(offset,offset + 1000))})`,
                map:'row => ({_uid:row._uid,title:row.title,author:row.author,series:row.series,ext:row.ext,date:row.date,del:row.del})'});
            for (const {del,...book} of rows) if (!del) available.set(book._uid,book);
            assertCurrent();
        }
        const result = {follows:follows.map(row => ({id:row.id,kind:row.kind,value:row.value,revision:row.revision,
            createdAt:row.createdAt,unread:row.newUids.filter(uid => available.has(uid)).length})),
            books:[...available.values()].sort(compareNewest)};
        this.news.set(userId,{generation,key:cacheKey,result});
        return result;
    }
}
module.exports = LibraryFollows;
