const caches = new WeakMap();
const {normalize} = require('./ShelfOptions');

async function load(worker, userId, listId) {
    if (!worker.readingListStore?.getList) return worker.getReadingList(userId, listId, {visibility:'opds'});
    const store = worker.readingListStore;
    const item = await store.getList(userId, listId, {visibility:'opds'});
    if (!item) throw Object.assign(new Error('Список не найден'), {status:404});
    const {user} = await store.resolveUser(userId);
    const lists = await store.getLists(userId);
    const stat = store.file ? await require('fs-extra').stat(store.file) : null;
    const key = JSON.stringify([userId, listId, item.updatedAt, user.updatedAt, lists.map(list => [list.id, list.updatedAt]),
        stat && [stat.ino, stat.mtimeMs, stat.size], worker.libraryAssetGeneration]);
    let cache = caches.get(worker);
    if (!cache) {cache = new Map(); caches.set(worker, cache);}
    const previous = cache.get(key);
    if (previous && Date.now() - previous.time < 30000) return previous.promise;
    const promise = worker.getReadingList(userId, listId, {visibility:'opds'}).catch(error => {cache.delete(key); throw error;});
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, {time:Date.now(), promise});
    return promise;
}

function page(books, options, query) {
    const grouping = normalize(options).grouping;
    const group = String(query.group || '');
    const pageNumber = Math.max(1, Math.min(1000000, Number.parseInt(query.page, 10) || 1));
    const limit = 50;
    let entries = books;
    const names = book => {
        if (grouping !== 'authors') return [String(book.series || '').trim() || 'Без серии'];
        const authors = [...new Set(String(book.author || '').split(',').map(name => name.trim()).filter(Boolean))];
        return authors.length ? authors : ['Без автора'];
    };
    if (grouping !== 'books') {
        if (group) entries = books.filter(book => names(book).includes(group));
        else {
            const groups = new Map();
            for (const book of books) for (const name of names(book)) groups.set(name, (groups.get(name) || 0) + 1);
            entries = [...groups].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([name, count]) => ({group:name, count}));
        }
    }
    return {entries:entries.slice((pageNumber - 1) * limit, pageNumber * limit), total:entries.length,
        number:pageNumber, previous:pageNumber > 1, next:pageNumber * limit < entries.length, group, grouping};
}

module.exports = {load, page};
