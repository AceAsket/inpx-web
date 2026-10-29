const {normalize} = require('../../shared/LibraryFollows');

class LibraryFollows {
    constructor(worker) { this.worker = worker; this.pending = new Map(); }
    async matches(kind, value) {
        if (!['author','series'].includes(kind) || typeof value !== 'string' || !value.trim() || value.length > 200)
            throw new Error('Укажите автора или серию (до 200 символов)');
        const db = this.worker.db;
        const ids = await this.worker.dbSearcher.bookSearchIds({[kind]:'=' + value.trim(),del:'0'});
        if (ids.length > 5000) throw new Error('Слишком много книг для одной подписки (лимит 5000)');
        const books = [];
        for (let offset = 0; offset < ids.length; offset += 1000) books.push(...await db.select({table:'book',
            where:`@@id(${db.esc(Array.from(ids.slice(offset,offset + 1000)))})`,map:'row => ({_uid:row._uid,title:row.title,author:row.author,series:row.series,ext:row.ext})'}));
        return books;
    }
    async change(userId, operation, payload = {}) {
        const store = this.worker.readingListStore;
        if (operation === 'add') {
            if (typeof payload.value === 'string') payload = {...payload,value:payload.value.replace(/\s+/g,' ').trim()};
            const generation = this.worker.libraryAssetGeneration, db = this.worker.db;
            const books = await this.matches(payload.kind,payload.value);
            if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Повторите подписку');
            await store.changeLibraryFollow(userId,'add',{kind:payload.kind,value:payload.value,knownUids:books.map(book => book._uid)});
        } else if (['remove','seen'].includes(operation)) await store.changeLibraryFollow(userId,operation,{id:payload.id});
        else throw new Error('Неизвестное действие с избранным');
        if (this.pending.has(userId)) await this.pending.get(userId).promise.catch(() => {});
        return this.list(userId);
    }
    async list(userId, refresh = false) {
        const pending = this.pending.get(userId);
        if (pending) {
            if (refresh && !pending.refresh) {await pending.promise; return this.list(userId,true);}
            return pending.promise;
        }
        const loading = this.read(userId,refresh).finally(() => {if (this.pending.get(userId)?.promise === loading) this.pending.delete(userId);});
        this.pending.set(userId,{promise:loading,refresh});
        return loading;
    }
    async read(userId, refresh) {
        const store = this.worker.readingListStore, generation = this.worker.libraryAssetGeneration, db = this.worker.db;
        const {user} = await store.resolveUser(userId);
        let follows = normalize(user.libraryFollows);
        const available = new Map();
        for (const follow of follows) {
            if (refresh) {
                const books = await this.matches(follow.kind,follow.value);
                if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Обновите избранное');
                const current = new Set(books.map(book => book._uid)), previous = new Set(follow.knownUids);
                const unread = new Set(follow.newUids);
                const fresh = [...current].filter(uid => !previous.has(uid) || unread.has(uid));
                await store.changeLibraryFollow(userId,'snapshot',{id:follow.id,revision:follow.revision,knownUids:[...current],newUids:fresh});
                books.forEach(book => available.set(book._uid,book));
            }
        }
        follows = normalize((await store.resolveUser(userId)).user.libraryFollows);
        const wanted = [...new Set(follows.flatMap(row => row.newUids))].slice(0,200);
        const missing = wanted.filter(uid => !available.has(uid));
        if (missing.length) {
            const rows = await db.select({table:'book',where:`@@hash('_uid', ${db.esc(missing)})`,
                map:'row => ({_uid:row._uid,title:row.title,author:row.author,series:row.series,ext:row.ext})'});
            rows.forEach(book => available.set(book._uid,book));
        }
        return {follows:follows.map(row => ({id:row.id,kind:row.kind,value:row.value,revision:row.revision,createdAt:row.createdAt,unread:row.newUids.length})),
            books:wanted.map(uid => available.get(uid)).filter(Boolean), truncated:new Set(follows.flatMap(row => row.newUids)).size > 200};
    }
}
module.exports = LibraryFollows;
