const fs = require('fs-extra');
//const _ = require('lodash');
const utils = require('./utils');

const maxLimit = 1000;

const emptyFieldValue = '?';
const maxUtf8Char = String.fromCodePoint(0xFFFFF);
const ruAlphabet = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const enAlphabet = 'abcdefghijklmnopqrstuvwxyz';
const enruArr = (ruAlphabet + enAlphabet).split('');

class DbSearcher {
    constructor(config, db) {
        this.config = config;
        this.queryCacheMemSize = this.config.queryCacheMemSize;
        this.queryCacheDiskSize = this.config.queryCacheDiskSize;
        this.queryCacheEnabled = this.config.queryCacheEnabled
            && (this.queryCacheMemSize > 0 || this.queryCacheDiskSize > 0);

        this.db = db;

        this.searchFlag = 0;
        this.timer = null;
        this.closed = false;

        this.memCache = new Map();
        this.bookIdMap = {};

        this.periodicCleanCache();//no await
    }

    async init() {
        await this.fillBookIdMap('author');
        await this.fillBookIdMap('series');
        await this.fillBookIdMap('title');
        await this.fillDbConfig();
    }

    queryKey(q) {
        const result = [];
        for (const f of this.recStruct) {
            result.push(q[f.field]);
        }
        result.push(String(q.sourceId || '').trim());
        result.push(q.hideCopies === true || q.hideCopies === 'true' || q.hideCopies === '1' ? '1' : '');

        return JSON.stringify(result);
    }

    getWhere(a) {
        const db = this.db;

        if (a[0] !== '~')
            a = a.toLowerCase();
        let where;

        //особая обработка префиксов
        if (a[0] == '=') {
            a = a.substring(1);
            where = `@dirtyIndexLR('value', ${db.esc(a)}, ${db.esc(a)})`;
        } else if (a[0] == '*') {
            a = a.substring(1);
            where = `@indexIter('value', (v) => (v !== ${db.esc(emptyFieldValue)} && v.indexOf(${db.esc(a)}) >= 0) )`;
        } else if (a[0] == '#') {
            a = a.substring(1);
            where = `@indexIter('value', (v) => {
                const enru = new Set(${db.esc(enruArr)});
                if (!v)
                    return false;
                return v !== ${db.esc(emptyFieldValue)} && !enru.has(v[0]) && v.indexOf(${db.esc(a)}) >= 0;
            })`;
        } else if (a[0] == '~') {//RegExp
            a = a.substring(1);
            where = `
                await (async() => {
                    const re = new RegExp(${db.esc(a)}, 'i');
                    @@indexIter('value', (v) => re.test(v) );
                })()
            `;
        } else {
            where = `@dirtyIndexLR('value', ${db.esc(a)}, ${db.esc(a + maxUtf8Char)})`;
        }

        return where;
    }

    async selectBookIds(query) {
        const db = this.db;

        const idsArr = [];

        const tableBookIds = async(table, where) => {
            const rows = await db.select({
                table,
                rawResult: true,
                where: `
                    const ids = ${where};

                    const result = new Set();
                    for (const id of ids) {
                        const row = @unsafeRow(id);
                        for (const bookId of row.bookIds)
                            result.add(bookId);
                    }

                    return new Uint32Array(result);
                `
            });

            return rows[0].rawResult;
        };

        //авторы
        if (query.author) {
            const key = `book-ids-author-${query.author}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await tableBookIds('author', this.getWhere(query.author));

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //серии
        if (query.series) {
            const key = `book-ids-series-${query.series}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await tableBookIds('series', this.getWhere(query.series));

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //названия
        if (query.title) {
            const key = `book-ids-title-${query.title}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await tableBookIds('title', this.getWhere(query.title));

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //жанры
        if (query.genre) {
            const key = `book-ids-genre-${query.genre}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const genreRows = await db.select({
                    table: 'genre',
                    rawResult: true,
                    where: `
                        const genres = ${db.esc(query.genre.split(','))};

                        const ids = new Set();
                        for (const g of genres) {
                            for (const id of @indexLR('value', g, g))
                                ids.add(id);
                        }
                        
                        const result = new Set();
                        for (const id of ids) {
                            const row = @unsafeRow(id);
                            for (const bookId of row.bookIds)
                                result.add(bookId);
                        }

                        return new Uint32Array(result);
                    `
                });

                ids = genreRows[0].rawResult;
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //языки
        if (query.lang) {
            const key = `book-ids-lang-${query.lang}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const langRows = await db.select({
                    table: 'lang',
                    rawResult: true,
                    where: `
                        const langs = ${db.esc(query.lang.split(','))};

                        const ids = new Set();
                        for (const l of langs) {
                            for (const id of @indexLR('value', l, l))
                                ids.add(id);
                        }
                        
                        const result = new Set();
                        for (const id of ids) {
                            const row = @unsafeRow(id);
                            for (const bookId of row.bookIds)
                                result.add(bookId);
                        }

                        return new Uint32Array(result);
                    `
                });

                ids = langRows[0].rawResult;
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //удаленные
        if (query.del) {
            const del = parseInt(query.del, 10) || 0;
            const key = `book-ids-del-${del}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await tableBookIds('del', `@indexLR('value', ${db.esc(del)}, ${db.esc(del)})`);

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //дата поступления
        if (query.date) {
            const key = `book-ids-date-${query.date}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                let [from = '', to = ''] = query.date.split(',');
                ids = await tableBookIds('date', `@indexLR('value', ${db.esc(from)} || undefined, ${db.esc(to)} || undefined)`);

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //оценка
        if (query.librate) {
            const key = `book-ids-librate-${query.librate}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const dateRows = await db.select({
                    table: 'librate',
                    rawResult: true,
                    where: `
                        const rates = ${db.esc(query.librate.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)))};

                        const ids = new Set();
                        for (const rate of rates) {
                            for (const id of @indexLR('value', rate, rate))
                                ids.add(id);
                        }
                        
                        const result = new Set();
                        for (const id of ids) {
                            const row = @unsafeRow(id);
                            for (const bookId of row.bookIds)
                                result.add(bookId);
                        }

                        return new Uint32Array(result);
                    `
                });

                ids = dateRows[0].rawResult;
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //тип файла
        if (query.ext) {
            const key = `book-ids-ext-${query.ext}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const extRows = await db.select({
                    table: 'ext',
                    rawResult: true,
                    where: `
                        const exts = ${db.esc(query.ext.split('|'))};

                        const ids = new Set();
                        for (const l of exts) {
                            for (const id of @indexLR('value', l, l))
                                ids.add(id);
                        }
                        
                        const result = new Set();
                        for (const id of ids) {
                            const row = @unsafeRow(id);
                            for (const bookId of row.bookIds)
                                result.add(bookId);
                        }

                        return new Uint32Array(result);
                    `
                });

                ids = extRows[0].rawResult;
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //источник библиотеки
        if (query.sourceId) {
            const sourceId = String(query.sourceId || '').trim();
            const key = `book-ids-source-${sourceId}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const sourceRows = await db.select({
                    table: 'book',
                    rawResult: true,
                    where: `
                        const sourceId = ${db.esc(sourceId)};
                        const result = [];
                        for (const id of @all()) {
                            const row = @unsafeRow(id);
                            if ((row.sourceId || '') === sourceId)
                                result.push(id);
                        }

                        return new Uint32Array(result);
                    `
                });

                ids = sourceRows[0].rawResult;
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        if (idsArr.length > 1) {
            //ищем пересечение множеств
            let proc = 0;
            let nextProc = 0;
            let inter = new Set(idsArr[0]);
            for (let i = 1; i < idsArr.length; i++) {
                const newInter = new Set();

                for (const id of idsArr[i]) {
                    if (inter.has(id))
                        newInter.add(id);

                    //прерываемся иногда, чтобы не блокировать Event Loop
                    proc++;
                    if (proc >= nextProc) {
                        nextProc += 10000;
                        await utils.processLoop();
                    }
                }
                inter = newInter;
            }

            return new Uint32Array(inter);
        } else if (idsArr.length == 1) {            
            return idsArr[0];
        } else {
            return false;
        }
    }

    async fillDbConfig() {
        if (!this.dbConfig) {
            const rows = await this.db.select({table: 'config'});
            const config = {};

            for (const row of rows) {
                config[row.id] = row.value;
            }

            this.dbConfig = config;
            this.recStruct = config.inpxInfo.recStruct;
        }
    }

    async fillBookIdMap(from) {
        const data = await fs.readFile(`${this.config.dataDir}/db/${from}_id.map`, 'utf-8');

        const idMap = JSON.parse(data);
        idMap.arr = new Uint32Array(idMap.arr);
        idMap.map = new Map(idMap.map);

        this.bookIdMap[from] = idMap;
    }

    async tableIdsFilter(from, query) {
        //т.к. авторы у книги идут списком (т.е. одна книга относиться сразу к нескольким авторам),
        //то в выборку по bookId могут попасть авторы, которые отсутствуют в критерии query.author,
        //поэтому дополнительно фильтруем
        let result = null;
        if (from == 'author' && query.author) {
            const key = `filter-ids-author-${query.author}`;
            let authorIds = await this.getCached(key);

            if (authorIds === null) {
                const rows = await this.db.select({
                    table: 'author',
                    rawResult: true,
                    where: `return new Uint32Array(${this.getWhere(query.author)})`
                });

                authorIds = rows[0].rawResult;

                await this.putCached(key, authorIds);
            }

            result = new Set(authorIds);
        }

        return result;
    }

    async selectTableIds(from, query) {
        const db = this.db;
        const queryKey = this.queryKey(query);
        const tableKey = `${from}-table-ids-${queryKey}`;
        let tableIds = await this.getCached(tableKey);

        if (tableIds === null) {
            const bookKey = `book-ids-${queryKey}`;
            let bookIds = await this.getCached(bookKey);

            if (bookIds === null) {
                bookIds = await this.selectBookIds(query);
                await this.putCached(bookKey, bookIds);
            }

            //id книг (bookIds) нашли, теперь надо их смаппировать в id таблицы from (авторов, серий, названий)
            if (bookIds) {
                //т.к. авторы у книги идут списком, то дополнительно фильтруем
                const filter = await this.tableIdsFilter(from, query);

                const tableIdsSet = new Set();
                const idMap = this.bookIdMap[from];
                let proc = 0;
                let nextProc = 0;
                for (const bookId of bookIds) {
                    const tableId = idMap.arr[bookId];
                    if (tableId) {
                        if (!filter || filter.has(tableId))
                            tableIdsSet.add(tableId);
                        proc++;
                    } else {
                        const tableIdArr = idMap.map.get(bookId);
                        if (tableIdArr) {
                            for (const tableId of tableIdArr) {
                            if (!filter || filter.has(tableId))
                                    tableIdsSet.add(tableId);
                                proc++;
                            }
                        }
                    }

                    //прерываемся иногда, чтобы не блокировать Event Loop
                    if (proc >= nextProc) {
                        nextProc += 10000;
                        await utils.processLoop();
                    }
                }

                tableIds = new Uint32Array(tableIdsSet);
            } else {//bookIds пустой - критерии не заданы, значит берем все id из from
                const rows = await db.select({
                    table: from,
                    rawResult: true,
                    where: `return new Uint32Array(@all())`
                });

                tableIds = rows[0].rawResult;
            }

            //сортируем по id
            //порядок id соответствует ASC-сортировке по строковому значению из from (имя автора, назание серии, название книги)
            tableIds.sort((a, b) => a - b);

            await this.putCached(tableKey, tableIds);
        }

        return tableIds;
    }

    normalizeCopyKeyPart(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
    }

    copyKey(book = {}) {
        const title = this.normalizeCopyKeyPart(book.title);
        const author = this.normalizeCopyKeyPart(book.author)
            .split(/[;,\n]/)[0]
            .split(/\s+/)[0];

        if (title && author)
            return `copy:${author}|${title}`;
        if (title)
            return `copy-title:${title}`;

        return [
            'fallback',
            book.author || '',
            book.series || '',
            String(book.serno || 0),
            book.title || '',
        ].map(value => this.normalizeCopyKeyPart(value)).join('|');
    }

    filterRestoredRows(rows, query = {}) {
        const sourceId = String(query.sourceId || '').trim();
        const hideCopies = query.hideCopies === true || query.hideCopies === 'true' || query.hideCopies === '1';
        if (!sourceId && !hideCopies)
            return rows;

        return rows.map((row) => {
            let books = Array.isArray(row.books) ? row.books : [];
            if (sourceId)
                books = books.filter(book => String((book && book.sourceId) || '').trim() === sourceId);

            if (hideCopies) {
                const deduped = new Map();
                for (const book of books) {
                    const key = this.copyKey(book);
                    if (!deduped.has(key))
                        deduped.set(key, book);
                }
                books = Array.from(deduped.values());
            }

            return Object.assign({}, row, {books});
        });
    }

    async restoreBooks(from, ids, query = {}) {
        const db = this.db;
        const bookTable = `${from}_book`;

        const rows = await db.select({
            table: bookTable,
            where: `@@id(${db.esc(ids)})`
        });

        if (rows.length == ids.length)
            return this.filterRestoredRows(rows, query);

        //далее восстановим книги из book в <from>_book
        const idsSet = new Set(rows.map(r => r.id));

        //недостающие
        const tableIds = [];
        for (const id of ids) {
            if (!idsSet.has(id))
                tableIds.push(id);
        }

        const tableRows = await db.select({
            table: from,
            where: `@@id(${db.esc(tableIds)})`
        });

        //список недостающих bookId
        const bookIds = [];
        for (const row of tableRows) {
            for (const bookId of row.bookIds)
                bookIds.push(bookId);
        }

        //выбираем книги
        const books = await db.select({
            table: 'book',
            where: `@@id(${db.esc(bookIds)})`
        });

        const booksMap = new Map();
        for (const book of books)
            booksMap.set(book.id, book);

        //распределяем
        for (const row of tableRows) {
            const books = [];
            for (const bookId of row.bookIds) {
                const book = booksMap.get(bookId);
                if (book)
                    books.push(book);
            }

            rows.push({id: row.id, name: row.name, books});
        }

        await db.insert({table: bookTable, ignore: true, rows});

        return this.filterRestoredRows(rows, query);
    }

    async search(from, query) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        if (!['author', 'series', 'title'].includes(from))
            throw new Error(`Unknown value for param 'from'`);

        this.searchFlag++;

        try {
            const db = this.db;

            const ids = await this.selectTableIds(from, query);

            const totalFound = ids.length;            
            let limit = (query.limit ? query.limit : 100);
            limit = (limit > maxLimit ? maxLimit : limit);
            const offset = (query.offset ? query.offset : 0);

            const slice = ids.slice(offset, offset + limit);

            //выборка найденных значений
            const found = await db.select({
                table: from,
                map: `(r) => ({id: r.id, ${from}: r.name, bookCount: r.bookCount, bookDelCount: r.bookDelCount})`,
                where: `@@id(${db.esc(Array.from(slice))})`
            });

            //для title восстановим books
            if (from == 'title') {
                const bookIds = found.map(r => r.id);
                const rows = await this.restoreBooks(from, bookIds, query);
                const rowsMap = new Map();
                for (const row of rows)
                    rowsMap.set(row.id, row);

                for (const f of found) {
                    const b = rowsMap.get(f.id);
                    if (b)
                        f.books = b.books;
                }
            }

            return {found, totalFound};
        } finally {
            this.searchFlag--;
        }
    }

    async bookSearchIds(query) {
        const queryKey = this.queryKey(query);
        const bookKey = `book-search-ids-${queryKey}`;
        let bookIds = await this.getCached(bookKey);

        if (bookIds === null) {
            const db = this.db;
            const filterBySearch = (bookField, searchValue) => {
                searchValue = searchValue.toLowerCase();
                //особая обработка префиксов
                if (searchValue == emptyFieldValue) {
                    return `(row.${bookField} === '' || row.${bookField}.indexOf(${db.esc(emptyFieldValue)}) === 0)`;
                } else if (searchValue[0] == '=') {

                    searchValue = searchValue.substring(1);
                    return `(row.${bookField}.toLowerCase().localeCompare(${db.esc(searchValue)}) === 0)`;
                } else if (searchValue[0] == '*') {

                    searchValue = searchValue.substring(1);
                    return `(row.${bookField} && row.${bookField}.toLowerCase().indexOf(${db.esc(searchValue)}) >= 0)`;
                } else if (searchValue[0] == '#') {

                    searchValue = searchValue.substring(1);
                    return `(row.${bookField} === '' || (!enru.has(row.${bookField}.toLowerCase()[0]) && row.${bookField}.toLowerCase().indexOf(${db.esc(searchValue)}) >= 0))`;
                } else if (searchValue[0] == '~') {//RegExp
                    searchValue = searchValue.substring(1);

                    return `
                        (() => {
                            const re = new RegExp(${db.esc(searchValue)}, 'i');
                            return re.test(row.${bookField});
                        })()
                    `;
                } else {

                    return `(row.${bookField}.toLowerCase().localeCompare(${db.esc(searchValue)}) >= 0 ` +
                        `&& row.${bookField}.toLowerCase().localeCompare(${db.esc(searchValue)} + ${db.esc(maxUtf8Char)}) <= 0)`;
                }
            };

            const checks = ['true'];
            if (query.sourceId) {
                const sourceId = String(query.sourceId || '').trim();
                checks.push(`(row.sourceId || '') === ${db.esc(sourceId)}`);
            }
            for (const f of this.recStruct) {
                if (query[f.field]) {
                    let searchValue = query[f.field];
                    if (f.type === 'S') {
                        checks.push(filterBySearch(f.field, searchValue));
                    } if (f.type === 'N') {
                        const v = searchValue.split('..');

                        if (v.length == 1) {
                            searchValue = parseInt(searchValue, 10);
                            if (isNaN(searchValue))
                                throw new Error(`Wrong query param, ${f.field}=${searchValue}`);

                            checks.push(`row.${f.field} === ${searchValue}`);
                        } else {
                            const from = parseInt(v[0] || '0', 10);
                            const to = parseInt(v[1] || '0', 10);
                            if (isNaN(from) || isNaN(to))
                                throw new Error(`Wrong query param, ${f.field}=${searchValue}`);

                            checks.push(`row.${f.field} >= ${from} && row.${f.field} <= ${to}`);
                        }
                    }
                }
            }

            const hideCopies = query.hideCopies === true || query.hideCopies === 'true' || query.hideCopies === '1';
            const hasNarrowingFilter = !!String(query.sourceId || '').trim()
                || this.recStruct.some(f => f.field !== 'del' && !!query[f.field]);
            const candidateIds = hideCopies && hasNarrowingFilter
                ? await this.bookSearchIds(Object.assign({}, query, {hideCopies: false}))
                : null;
            const iterator = candidateIds ? db.esc(Array.from(candidateIds)) : '@all()';
            const rows = await db.select({
                table: 'book',
                rawResult: true,
                where: `
                    const enru = new Set(${db.esc(enruArr)});
                    const hideCopies = ${hideCopies ? 'true' : 'false'};

                    const checkBook = (row) => {
                        return ${checks.join(' && ')};
                    };

                    const normalizeKeyPart = (value) => String(value || '').trim().toLowerCase().replace(/\\s+/g, ' ');

                    const authorKey = (value) => normalizeKeyPart(value).split(/[;,\\n]/)[0].split(/\\s+/)[0] || '';

                    const dedupeKey = (row) => {
                        const sourceKey = hideCopies ? '' : (row.sourceId || '');

                        if (hideCopies) {
                            const titleKey = normalizeKeyPart(row.title);
                            const mainAuthorKey = authorKey(row.author);

                            if (titleKey && mainAuthorKey)
                                return 'copy:' + mainAuthorKey + '|' + titleKey;
                            if (titleKey)
                                return 'copy-title:' + titleKey;
                        }

                        if (row.libid)
                            return 'libid:' + sourceKey + ':' + row.libid;

                        const parts = [
                            sourceKey,
                            row.folder || '',
                            row.file || '',
                            row.ext || '',
                            String(row.insno || 0),
                        ].map(normalizeKeyPart);

                        if (parts.some(Boolean))
                            return 'file:' + parts.join('|');

                        return [
                            'meta',
                            sourceKey,
                            row.author || '',
                            row.series || '',
                            String(row.serno || 0),
                            row.title || '',
                            String(row.size || 0),
                            row.ext || '',
                        ].map(normalizeKeyPart).join('|');
                    };

                    const rowScore = (row) => {
                        let score = 0;
                        if (!row.del)
                            score += 1000;
                        if (row.librate)
                            score += row.librate * 100;
                        if (row.ext === 'fb2')
                            score += 20;
                        if (row.size)
                            score += Math.min(row.size, 100000000) / 1000000;

                        return score;
                    };

                    const pickBetterRow = (current, next) => {
                        const currentScore = rowScore(current);
                        const nextScore = rowScore(next);

                        if (nextScore !== currentScore)
                            return (nextScore > currentScore ? next : current);

                        return (next.id < current.id ? next : current);
                    };

                    const deduped = new Map();
                    for (const id of ${iterator}) {
                        const row = @unsafeRow(id);
                        if (!checkBook(row))
                            continue;

                        const key = dedupeKey(row);
                        const existing = deduped.get(key);
                        deduped.set(key, existing ? pickBetterRow(existing, row) : row);
                    }

                    const result = Array.from(deduped.values());

                    result.sort((a, b) => {
                        let cmp = a.author.localeCompare(b.author);
                        if (cmp === 0 && (a.series || b.series)) {
                            cmp = (a.series && b.series ? a.series.localeCompare(b.series) : (a.series ? -1 : 1));
                        }
                        if (cmp === 0)
                            cmp = a.serno - b.serno;
                        if (cmp === 0)
                            cmp = a.title.localeCompare(b.title);

                        return cmp;
                    });

                    return new Uint32Array(result.map(row => row.id));
                `
            });

            bookIds = rows[0].rawResult;
    
            await this.putCached(bookKey, bookIds);
        }

        return bookIds;
    }

    //неоптимизированный поиск по всем книгам, по всем полям
    async bookSearch(query) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        this.searchFlag++;

        try {
            const db = this.db;

            const ids = await this.bookSearchIds(query);

            const totalFound = ids.length;            
            let limit = (query.limit ? query.limit : 100);
            limit = (limit > maxLimit ? maxLimit : limit);
            const offset = (query.offset ? query.offset : 0);

            const slice = ids.slice(offset, offset + limit);

            //выборка найденных значений
            const found = await db.select({
                table: 'book',
                where: `@@id(${db.esc(Array.from(slice))})`
            });

            return {found, totalFound};
        } finally {
            this.searchFlag--;
        }
    }

    async opdsQuery(from, query) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        if (!['author', 'series', 'title'].includes(from))
            throw new Error(`Unknown value for param 'from'`);

        this.searchFlag++;

        try {
            const db = this.db;

            const depth = query.depth || 1;
            const queryKey = this.queryKey(query);
            const opdsKey = `${from}-opds-d${depth}-${queryKey}`;
            let result = await this.getCached(opdsKey);

            if (result === null) {
                const ids = await this.selectTableIds(from, query);

                const totalFound = ids.length;

                //группировка по name длиной depth
                const found = await db.select({
                    table: from,
                    rawResult: true,
                    where: `
                        const depth = ${db.esc(depth)};
                        const group = new Map();

                        const ids = ${db.esc(Array.from(ids))};
                        for (const id of ids) {
                            const row = @unsafeRow(id);
                            const s = row.value.substring(0, depth);
                            let g = group.get(s);
                            if (!g) {
                                g = {id: row.id, name: row.name, value: s, count: 0, bookCount: 0};
                                group.set(s, g);
                            }
                            g.count++;
                            g.bookCount += row.bookCount;
                        }

                        const result = Array.from(group.values());
                        result.sort((a, b) => a.value.localeCompare(b.value));

                        return result;
                    `
                });

                result = {found: found[0].rawResult, totalFound};
                
                await this.putCached(opdsKey, result);
            }

            return result;
        } finally {
            this.searchFlag--;
        }
    }

    async getAuthorBookList(authorId, author, query = {}) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        if (!authorId && !author)
            return {author: '', books: []};

        this.searchFlag++;

        try {
            const db = this.db;

            if (!authorId) {                
                //восстановим authorId
                authorId = 0;
                author = author.toLowerCase();

                const rows = await db.select({
                    table: 'author',
                    rawResult: true,
                    where: `return Array.from(@dirtyIndexLR('value', ${db.esc(author)}, ${db.esc(author)}))`
                });

                if (rows.length && rows[0].rawResult.length)
                    authorId = rows[0].rawResult[0];
            }

            //выборка книг автора по authorId
            const rows = await this.restoreBooks('author', [authorId], query);

            let authorName = '';
            let books = [];

            if (rows.length) {
                authorName = rows[0].name;
                books = rows[0].books;
            }

            return {author: authorName, books};
        } finally {
            this.searchFlag--;
        }
    }

    async getAuthorSeriesList(authorId, query = {}) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        if (!authorId)
            return {author: '', series: []};

        this.searchFlag++;

        try {
            const db = this.db;

            //выборка книг автора по authorId
            const bookList = await this.getAuthorBookList(authorId, undefined, query);
            const books = bookList.books;
            const seriesSet = new Set();
            for (const book of books) {
                if (book.series)
                    seriesSet.add(book.series.toLowerCase());
            }

            let series = [];
            if (seriesSet.size) {
                //выборка серий по названиям
                series = await db.select({
                    table: 'series',
                    map: `(r) => ({id: r.id, series: r.name, bookCount: r.bookCount, bookDelCount: r.bookDelCount})`,
                    where: `
                        const seriesArr = ${db.esc(Array.from(seriesSet))};
                        const ids = new Set();
                        for (const value of seriesArr) {
                            for (const id of @dirtyIndexLR('value', value, value))
                                ids.add(id);
                        }

                        return ids;
                    `
                });
            }

            return {author: bookList.author, series};
        } finally {
            this.searchFlag--;
        }
    }

    async getSeriesBookList(series, query = {}) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        if (!series)
            return {books: []};

        this.searchFlag++;

        try {
            const db = this.db;

            series = series.toLowerCase();

            //выборка серии по названию серии
            let rows = await db.select({
                table: 'series',
                rawResult: true,
                where: `return Array.from(@dirtyIndexLR('value', ${db.esc(series)}, ${db.esc(series)}))`
            });

            let books = [];
            if (rows.length && rows[0].rawResult.length) {
                //выборка книг серии
                const bookRows = await this.restoreBooks('series', [rows[0].rawResult[0]], query)

                if (bookRows.length)
                    books = bookRows[0].books;
            }

            return {books};
        } finally {
            this.searchFlag--;
        }
    }

    async getCached(key) {
        if (!this.queryCacheEnabled)
            return null;

        let result = null;

        const db = this.db;
        const memCache = this.memCache;

        if (this.queryCacheMemSize > 0 && memCache.has(key)) {//есть в недавних
            result = memCache.get(key);

            //изменим порядок ключей, для последующей правильной чистки старых
            memCache.delete(key);
            memCache.set(key, result);
        } else if (this.queryCacheDiskSize > 0) {//смотрим в таблице
            const rows = await db.select({table: 'query_cache', where: `@@id(${db.esc(key)})`});

            if (rows.length) {//нашли в кеше
                await db.insert({
                    table: 'query_time',
                    replace: true,
                    rows: [{id: key, time: Date.now()}],
                });

                result = rows[0].value;

                //заполняем кеш в памяти
                if (this.queryCacheMemSize > 0) {
                    memCache.set(key, result);

                    if (memCache.size > this.queryCacheMemSize) {
                        //удаляем самый старый ключ-значение
                        for (const k of memCache.keys()) {
                            memCache.delete(k);
                            break;
                        }
                    }
                }
            }
        }

        return result;
    }

    async putCached(key, value) {
        if (!this.queryCacheEnabled)
            return;

        const db = this.db;

        if (this.queryCacheMemSize > 0) {
            const memCache = this.memCache;
            memCache.set(key, value);

            if (memCache.size > this.queryCacheMemSize) {
                //удаляем самый старый ключ-значение
                for (const k of memCache.keys()) {
                    memCache.delete(k);
                    break;
                }
            }
        }

        if (this.queryCacheDiskSize > 0) {
            //кладем в таблицу асинхронно
            (async() => {
                try {
                    await db.insert({
                        table: 'query_cache',
                        replace: true,
                        rows: [{id: key, value}],
                    });

                    await db.insert({
                        table: 'query_time',
                        replace: true,
                        rows: [{id: key, time: Date.now()}],
                    });
                } catch(e) {
                    console.error(`putCached: ${e.message}`);
                }
            })();
        }
    }

    async periodicCleanCache() {
        this.timer = null;
        const cleanInterval = this.config.cacheCleanInterval*60*1000;
        if (!cleanInterval)
            return;

        try {
            if (!this.queryCacheEnabled || this.queryCacheDiskSize <= 0)
                return;

            const db = this.db;

            let rows = await db.select({table: 'query_time', count: true});
            const delCount = rows[0].count - this.queryCacheDiskSize;

            if (delCount < 1)
                return;

            //выберем delCount кандидатов на удаление
            rows = await db.select({
                table: 'query_time',
                rawResult: true,
                where: `
                    const delCount = ${delCount};
                    const rows = [];

                    @unsafeIter(@all(), (r) => {
                        rows.push(r);
                        return false;
                    });

                    rows.sort((a, b) => a.time - b.time);

                    return rows.slice(0, delCount).map(r => r.id);
                `
            });

            const ids = rows[0].rawResult;

            //удаляем
            await db.delete({table: 'query_cache', where: `@@id(${db.esc(ids)})`});
            await db.delete({table: 'query_time', where: `@@id(${db.esc(ids)})`});
            
            //console.log('Cache clean', ids);
        } catch(e) {
            console.error(e.message);
        } finally {
            if (!this.closed) {
                this.timer = setTimeout(() => { this.periodicCleanCache(); }, cleanInterval);
            }
        }
    }

    async close() {
        while (this.searchFlag > 0) {
            await utils.sleep(50);
        }

        this.searchCache = null;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.closed = true;
    }
}

module.exports = DbSearcher;
