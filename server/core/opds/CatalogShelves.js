const fs = require('fs/promises');
const path = require('path');
const smartShelf = require('../SmartShelf');

const MAX_FILE_BYTES = 256 * 1024;
const PAGE_SIZE = 50;
const failures = new WeakMap();
const caches = new WeakMap();

function normalize(raw) {
    if (raw?.version !== 1 || !Array.isArray(raw.shelves) || raw.shelves.length > 64)
        throw new Error('Ожидается version: 1 и массив shelves, не более 64 подборок');
    const result = new Map();
    const allowed = new Set([...smartShelf.fields, 'hideCopies']);
    for (const value of raw.shelves) {
        if (value?.active === false) continue;
        if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id || '') || typeof value.id !== 'string' || result.has(value.id))
            throw new Error('Некорректный или повторяющийся id подборки');
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || [...value.name].some(char => char.charCodeAt(0) < 32))
            throw new Error('Задайте название подборки длиной до 100 символов');
        const grouping = value.grouping === undefined ? 'books' : value.grouping;
        if (!['books', 'authors', 'series'].includes(grouping)) throw new Error('Некорректная группировка подборки');
        if (!value.filters || typeof value.filters !== 'object' || Array.isArray(value.filters)) throw new Error('Задайте filters подборки');
        for (const [key, filter] of Object.entries(value.filters)) {
            if (!allowed.has(key) || (key === 'hideCopies' ? typeof filter !== 'boolean' : typeof filter !== 'string'))
                throw new Error(`Неподдерживаемый фильтр подборки: ${key}`);
        }
        result.set(value.id, {id:value.id, name:value.name.trim(), grouping, filters:smartShelf.normalize(value.filters)});
    }
    return result;
}

async function load(config) {
    if (!config.opdsFeedsFile) return new Map();
    let file;
    try {
        file = await fs.open(path.resolve(config.dataDir || '.', config.opdsFeedsFile), 'r');
        if (!(await file.stat()).isFile()) throw new Error('Настройки подборок должны быть обычным файлом');
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > MAX_FILE_BYTES) throw new Error('Файл подборок превышает 256 КиБ');
        const result = normalize(JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, '')));
        failures.delete(config);
        return result;
    } catch (error) {
        const previous = failures.get(config);
        if (!previous || previous.message !== error.message || Date.now() - previous.time > 60000) {
            failures.set(config, {message:error.message, time:Date.now()});
            new (require('../AppLogger'))().log(LM_WARN, `OPDS shelves: ${error.message}`);
        }
        throw Object.assign(new Error('Общие подборки OPDS временно недоступны. Проверьте файл настроек.'),
            {status:503, code:'OPDS_SHELVES_UNAVAILABLE'});
    } finally {
        if (file) await file.close();
    }
}

function tableIds(mapping, bookId) {
    return mapping.arr[bookId] ? [mapping.arr[bookId]] : mapping.map.get(bookId) || [0];
}

async function selection(worker, shelf) {
    worker.checkMyState();
    const searcher = worker.dbSearcher, db = worker.db, generation = worker.libraryAssetGeneration;
    const current = () => {
        if (worker.dbSearcher !== searcher || worker.db !== db || worker.libraryAssetGeneration !== generation)
            throw Object.assign(new Error('Каталог обновился. Откройте подборку ещё раз.'), {status:503});
    };
    const query = await searcher.prepareRatingQuery(smartShelf.query(shelf.filters));
    current();
    let cache = caches.get(worker);
    if (!cache || cache.searcher !== searcher || cache.generation !== generation) {
        cache = {searcher, generation, entries:new Map(), pending:new Set()};
        caches.set(worker, cache);
    }
    const key = JSON.stringify([searcher.queryKey(query), shelf.grouping]);
    const previous = cache.entries.get(key);
    if (previous && (cache.pending.has(previous.promise) || Date.now() - previous.time < 30000)) return previous.promise;
    if (cache.pending.size >= 2) throw Object.assign(new Error('Подборки OPDS заняты. Повторите запрос немного позже.'), {status:503});
    const promise = (async() => {
        const ids = await searcher.bookSearchIds(query);
        current();
        const groups = [];
        let mapping;
        if (shelf.grouping !== 'books') {
            const kind = shelf.grouping === 'authors' ? 'author' : 'series';
            mapping = searcher.bookIdMap[kind];
            const counts = new Map();
            for (const id of ids) for (const tableId of tableIds(mapping, id)) counts.set(tableId, (counts.get(tableId) || 0) + 1);
            const groupIds = [...counts.keys()].filter(id => id !== 0);
            for (let offset = 0; offset < groupIds.length; offset += 1000) {
                const rows = await db.select({table:kind, where:`@@id(${db.esc(groupIds.slice(offset, offset + 1000))})`,
                    map:'(row) => ({id:row.id, name:row.name})'});
                current();
                for (const row of rows) {
                    // The author index also contains joint-author strings for exact book searches.
                    if (kind === 'author' && String(row.name || '').includes(',')) continue;
                    groups.push({group:row.name || (kind === 'author' ? 'Без автора' : 'Без серии'), groupId:String(row.id), count:counts.get(row.id)});
                }
            }
            if (counts.has(0)) groups.push({group:kind === 'author' ? 'Без автора' : 'Без серии', groupId:'0', count:counts.get(0)});
            groups.sort((a, b) => a.group.localeCompare(b.group, 'ru') || Number(a.groupId) - Number(b.groupId));
        }
        current();
        return {ids, groups, mapping, db, current};
    })();
    const entry = {promise, time:Date.now()};
    if (cache.entries.size >= 2) {
        const expired = [...cache.entries].find(([, value]) => !cache.pending.has(value.promise));
        if (expired) cache.entries.delete(expired[0]);
    }
    cache.entries.set(key, entry);
    cache.pending.add(promise);
    try {
        const result = await promise;
        entry.time = Date.now();
        return result;
    } catch (error) {
        if (cache.entries.get(key) === entry) cache.entries.delete(key);
        throw error;
    } finally {cache.pending.delete(promise);}
}

async function page(worker, shelf, query) {
    const selected = await selection(worker, shelf);
    selected.current();
    const number = Math.max(1, Math.min(1000000, Number.parseInt(query.page, 10) || 1));
    const offset = (number - 1) * PAGE_SIZE;
    const group = shelf.grouping === 'books' ? '' : String(query.group || '');
    let groupTitle = '', entries, total;
    if (shelf.grouping !== 'books' && !group) {
        total = selected.groups.length;
        entries = selected.groups.slice(offset, offset + PAGE_SIZE);
    } else {
        let ids = selected.ids;
        if (group) {
            const found = selected.groups.find(item => item.groupId === group);
            if (!found) throw Object.assign(new Error('Группа не найдена'), {status:404});
            groupTitle = found.group;
            ids = ids.filter(id => tableIds(selected.mapping, id).includes(Number(group)));
            if (shelf.grouping === 'series' && ids.length) {
                const sorted = await selected.db.select({table:'book', rawResult:true, where:`
                    const ids = ${selected.db.esc(Array.from(ids))};
                    const keys = new Map();
                    for (const id of ids) {
                        const row = @unsafeRow(id);
                        keys.set(id, {number:row.serno || 0, title:String(row.title || '')});
                    }
                    ids.sort((a, b) => {
                        const left = keys.get(a), right = keys.get(b);
                        return left.number - right.number || left.title.localeCompare(right.title, 'ru') || a - b;
                    });
                    return new Uint32Array(ids);
                `});
                selected.current();
                ids = sorted[0].rawResult;
            }
        }
        total = ids.length;
        const slice = Array.from(ids.slice(offset, offset + PAGE_SIZE));
        const rows = slice.length ? await selected.db.select({table:'book', where:`@@id(${selected.db.esc(slice)})`}) : [];
        selected.current();
        const byId = new Map(rows.map(row => [row.id, row]));
        entries = slice.map(id => byId.get(id)).filter(Boolean);
        if (worker.applyMetadataOverridesToSearchResult) await worker.applyMetadataOverridesToSearchResult({books:entries});
        selected.current();
    }
    return {entries, total, number, group, groupTitle, previous:number > 1, next:offset + PAGE_SIZE < total};
}

module.exports = {load, normalize, page};
