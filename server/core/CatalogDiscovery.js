const search = require('../../shared/CatalogSearch');
const model = require('../../shared/CatalogDiscovery');
const MAX_CHAR = String.fromCodePoint(0xFFFFF);
const KINDS = ['author', 'series', 'title'];

class CatalogDiscovery {
    constructor(worker) {this.worker = worker; this.cache = new Map(); this.pending = new Map(); this.cacheBytes = 0;}

    async warm(wait = false) {
        if (!this.lookup || this.lookup.db !== this.worker.db || this.lookup.generation !== this.worker.libraryAssetGeneration) {
            const previous = this.lookup;
            this.lookup = new (require('./CatalogLookupIndex'))(this.worker);
            const lookup = this.lookup;
            this.lookupStart = (async() => {await previous?.close(); await lookup.ensure();})();
        }
        const lookup = this.lookup;
        await this.lookupStart;
        await lookup.ensure();
        if (wait && lookup.building) await lookup.building;
        return lookup.ready;
    }

    async close() {await this.lookup?.close(); this.cache.clear(); this.pending.clear(); this.cacheBytes = 0;}

    async cached(key, work) {
        const {db, libraryAssetGeneration: generation} = this.worker;
        if (this.db !== db || this.generation !== generation) {
            this.db = db; this.generation = generation; this.cache.clear(); this.pending.clear(); this.cacheBytes = 0;
        }
        const saved = this.cache.get(key);
        if (saved && Date.now() - saved.at < 60000) {this.cache.delete(key); this.cache.set(key, saved); return saved.value;}
        if (this.pending.has(key)) return this.pending.get(key);
        const promise = (async() => {
            const value = await work(db);
            if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration)
                throw new Error('Библиотека обновилась. Повторите запрос');
            const bytes = Buffer.byteLength(JSON.stringify(value));
            if (bytes <= 1024 * 1024) {
                this.cacheBytes -= this.cache.get(key)?.bytes || 0;
                this.cache.set(key, {at: Date.now(), value, bytes}); this.cacheBytes += bytes;
                while (this.cache.size > 100 || this.cacheBytes > 8 * 1024 * 1024) {
                    const oldest = this.cache.keys().next().value;
                    this.cacheBytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
                }
            }
            return value;
        })().finally(() => {if (this.pending.get(key) === promise) this.pending.delete(key);});
        this.pending.set(key, promise);
        return promise;
    }

    async suggest(options = {}) {
        const query = model.text(options.query || ''), filters = model.scope(options.filters);
        const kind = options.kind && KINDS.includes(options.kind) ? options.kind : '';
        if (Array.from(query).length < 2 || !search.words(query).length || /^[=~*#?]/.test(query)) return {query, groups: [], corrections: []};
        if (!await this.warm()) return {query, groups: [], corrections: [], warming: true, progress:{...this.lookup.progress}};
        return this.cached(JSON.stringify(['suggest', query, filters, kind]), async db => {
            const groups = [];
            const scoped = Object.keys(filters).length > 1;
            const selected = scoped ? Array.from(await this.worker.dbSearcher.selectBookIds(filters)) : null;
            for (const field of kind ? [kind] : KINDS) {
                const ids = await this.lookup.ids(field, query);
                const rows = await db.select({table: field, rawResult: true, where: `
                    const normalize = ${search.normalize.toString()}, words = ${search.words.toString()};
                    const relevance = ${model.relevance.toString()};
                    const selected = ${selected ? `new Set(${db.esc(selected)})` : 'null'};
                    const result = [];
                    for (const id of ${db.esc(Array.from(ids))}) {
                        const row = @unsafeRow(id);
                        if (!row || row.value === '?') continue;
                        let count = selected ? 0 : row.bookCount;
                        const bookIds = [];
                        for (const id of row.bookIds) {
                            if (selected && !selected.has(id)) continue;
                            if (selected) count++;
                            if (bookIds.length < 20) bookIds.push(id);
                            if (!selected && bookIds.length >= 20) break;
                        }
                        if (!count) continue;
                        const item = {name: row.name, count, bookIds, score: relevance(row.name, ${db.esc(query)})};
                        result.push(item);
                        result.sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
                        if (result.length > 6) result.pop();
                    }
                    return result;
                `});
                const items = rows[0].rawResult;
                if (field === 'title' && items.length) {
                    const books = await db.select({table: 'book', where: `@@id(${db.esc(items.flatMap(row => row.bookIds))})`});
                    const byId = new Map(books.map(book => [book.id, book]));
                    for (const item of items) {
                        item.book = item.bookIds.map(id => byId.get(id)).find(book => book && !book.del);
                        if (!item.book) {
                            const ids = await this.worker.dbSearcher.selectBookIds({...filters, title: '=' + item.name});
                            const fallback = ids?.length ? await db.select({table: 'book', where: `@@id(${db.esc(Array.from(ids.slice(0, 1)))})`}) : [];
                            item.book = fallback[0];
                        }
                    }
                }
                groups.push({kind: field, items: items.map(item => ({name: item.name, count: item.count, ...(item.book ? {book: item.book} : {})}))});
            }
            const corrections = groups.some(group => group.items.length) ? [] : await this.correct(query, kind ? [kind] : KINDS, filters, db);
            return {query, groups, corrections};
        });
    }

    async correct(query, fields, filters, db) {
        const tokens = search.words(query), result = [], deadline = Date.now() + 240;
        if (tokens.length > 6 || !await db.tableExists({table: 'word'})) return result;
        for (const field of fields) for (let position = 0; position < tokens.length; position++) {
            if (result.length >= 3 || Date.now() >= deadline) return result;
            if (tokens[position].length < 4 || tokens[position].length > 40) continue;
            const token = search.root(tokens[position]), prefix = `${field}:`;
            const rows = await db.select({table: 'word', rawResult: true, where: `
                const exact = @dirtyIndexLR('value', ${db.esc(prefix + token)}, ${db.esc(prefix + token + MAX_CHAR)});
                if (exact.size) return [];
                const distance = ${model.distance.toString()}, candidates = [], start = Date.now();
                let scanned = 0;
                for (const id of @dirtyIndexLR('value', ${db.esc(prefix)}, ${db.esc(prefix + MAX_CHAR)})) {
                    if (++scanned > 50000 || Date.now() - start > 60 || Date.now() > ${deadline}) break;
                    const row = @unsafeRow(id), word = row.value.slice(${prefix.length});
                    if (distance(word, ${db.esc(token)}, 1) === 1 && row.bookIds.length)
                        candidates.push({word, bookId: row.bookIds[0], count: row.bookIds.length});
                    if (candidates.length >= 100) break;
                }
                return candidates.sort((a, b) => b.count - a.count).slice(0, 5);
            `});
            const candidates = rows[0].rawResult;
            if (!candidates.length) continue;
            const books = await db.select({table: 'book', where: `@@id(${db.esc(candidates.map(row => row.bookId))})`});
            for (const candidate of candidates) {
                const book = books.find(book => book.id === candidate.bookId);
                const word = search.words(book?.[field]).find(word => search.root(word) === candidate.word);
                if (!word) continue;
                const corrected = tokens.map((value, index) => index === position ? word : value).join(' ');
                if (result.some(item => item.kind === field && item.query === corrected)) continue;
                if ((await this.worker.dbSearcher.selectBookIds({...filters, [field]: corrected})).length)
                    result.push({kind: field, query: corrected});
                if (result.length >= 3) return result;
            }
        }
        return result;
    }

    async browse(options = {}) {
        const kind = options.kind;
        if (!['author', 'series'].includes(kind)) throw new Error('Укажите авторов или серии');
        const prefix = model.prefix(options.prefix || ''), filters = model.scope(options.filters);
        return this.cached(JSON.stringify(['browse', kind, prefix, filters]), async db => {
            const scoped = Object.keys(filters).length > 1;
            const selected = scoped ? Array.from(await this.worker.dbSearcher.selectBookIds(filters)) : null;
            const result = await db.select({table: kind, rawResult: true, where: `
                const selected = ${selected ? `new Set(${db.esc(selected)})` : 'null'};
                const prefix = ${db.esc(prefix)}, groups = new Map(), items = [];
                let total = 0;
                for (const id of ${prefix ? `@dirtyIndexLR('value', ${db.esc(prefix)}, ${db.esc(prefix + MAX_CHAR)})` : '@all()'}) {
                    const row = @unsafeRow(id);
                    if (!row || row.value === '?' || !row.value.startsWith(prefix)) continue;
                    const count = selected ? row.bookIds.reduce((n, id) => n + Number(selected.has(id)), 0) : row.bookCount;
                    if (!count) continue;
                    total++;
                    if (items.length < 201) items.push({name: row.name, count});
                    const remaining = row.value.slice(prefix.length);
                    let next = '';
                    for (const char of Array.from(remaining)) {next += char; if (char.trim()) break;}
                    const value = prefix + next;
                    const group = groups.get(value) || {prefix: value, count: 0, books: 0};
                    if (!remaining) group.name = row.name;
                    group.count++; group.books += count; groups.set(value, group);
                }
                return {prefix, total, groups: total > 200 ? Array.from(groups.values()).sort((a, b) => a.prefix.localeCompare(b.prefix)) : [],
                    items: total <= 200 ? items.sort((a, b) => a.name.localeCompare(b.name)) : []};
            `});
            return {...result[0].rawResult, kind};
        });
    }

    async entity(options = {}, user = null) {
        const kind = options.kind, name = model.text(options.name || '', 500);
        if (!['author', 'series'].includes(kind) || !name) throw new Error('Укажите автора или серию');
        const filters = model.scope(options.filters), page = Math.max(1, Math.floor(Number(options.page) || 1));
        const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 40)));
        const db = this.worker.db, generation = this.worker.libraryAssetGeneration;
        // Only public order/metadata is cached. Progress is evaluated against the current profile on every request.
        const ordered = await this.cached(JSON.stringify(['entity', kind, name, filters]), async activeDb => {
            if (activeDb !== db) throw new Error('Библиотека обновилась. Повторите запрос');
            const ids = await this.worker.dbSearcher.selectBookIds({...filters, [kind]: '=' + name});
            if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Повторите запрос');
            const result = await db.select({table: 'book', rawResult: true, where: `
                const rows = [];
                for (const id of ${db.esc(Array.from(ids || []))}) {
                    const row = @unsafeRow(id);
                    rows.push({id: row.id, uid: row._uid, title: row.title, series: row.series || '', number: Number(row.serno) || 0});
                }
                rows.sort((a, b) => ${kind === 'author' ? "a.series.localeCompare(b.series, 'ru') ||" : ''}
                    a.number - b.number || a.title.localeCompare(b.title, 'ru') || a.uid.localeCompare(b.uid));
                return rows;
            `});
            return result[0].rawResult;
        });
        const progress = user?.readerProgress || {}, completed = row => !progress[row.uid]?.hidden && Number(progress[row.uid]?.percent) >= .999;
        const read = ordered.filter(completed).length, next = ordered.find(row => !completed(row));
        const pageCount = Math.max(1, Math.ceil(ordered.length / limit)), currentPage = Math.min(page, pageCount);
        const slice = ordered.slice((currentPage - 1) * limit, currentPage * limit);
        const wanted = [...new Set([...slice.map(row => row.id), ...(next ? [next.id] : [])])];
        const books = wanted.length ? await db.select({table: 'book', where: `@@id(${db.esc(wanted)})`}) : [];
        await this.worker.applyMetadataOverridesToSearchResult({found: books});
        const byId = new Map(books.map(book => [book.id, {...book, _readerProgress: progress[book._uid]}]));
        if (db !== this.worker.db || generation !== this.worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Повторите запрос');
        return {kind, name, total: ordered.length, page: currentPage, pageCount, limit,
            read: user ? read : null, next: next ? byId.get(next.id) : null,
            books: slice.map(row => byId.get(row.id)),
            series: kind === 'author' ? [...new Set(ordered.map(row => row.series).filter(Boolean))].slice(0, 200) : [],
        };
    }

    async markSeriesUntil(userId, options) {
        const name = model.text(options.name || '', 500), uid = model.text(options.bookUid || '', 512);
        if (!name || !uid) throw new Error('Выберите том серии');
        const result = await this.worker.getSeriesBookList(name, {del: '0'});
        const target = result.books.find(book => book._uid === uid);
        if (!target || !Number.isFinite(Number(target.serno)) || Number(target.serno) <= 0)
            throw new Error('Для этого тома не указан номер в серии');
        const uids = result.books.filter(book => Number(book.serno) > 0 && Number(book.serno) <= Number(target.serno)).map(book => book._uid);
        if (uids.length > 5000) throw new Error('В серии больше 5000 книг. Выберите меньший диапазон');
        return this.worker.readingListStore.setBooksRead(userId, uids, true);
    }
}

module.exports = CatalogDiscovery;
