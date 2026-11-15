const fs = require('fs-extra');
//const _ = require('lodash');
const utils = require('./utils');
const {RustLookupIndex} = require('./RustLookupIndex');
const {compareBooks, compareBookFields, bookScore, normalizeKeyPart, physicalBookKey} = require('./BookSearchProjection');
const {words, root} = require('../../shared/CatalogSearch');

const maxLimit = 1000;

const emptyFieldValue = '?';
const maxUtf8Char = String.fromCodePoint(0xFFFFF);
const ruAlphabet = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const enAlphabet = 'abcdefghijklmnopqrstuvwxyz';
const enruArr = (ruAlphabet + enAlphabet).split('');
const titleSearchLeadingChars = ['«', '"', "'", '„', '“', '”', '‘', '’', '`', '(', '[', '{'];
const copyDedupeVersion = 'copy-dedupe-v5-catalog-words';
const ratingSelection = Symbol('ratingSelection');
const orderedScanThreshold = 8192;
const reorderedIndexFields = ['author', 'series', 'title', 'genre', 'date', 'librate'];
const earlyPageSize = 256;

class DbSearcher {
    constructor(config, db, dbPath = `${config.dataDir}/db`) {
        this.config = config;
        this.dbPath = dbPath;
        this.queryCacheMemSize = this.config.queryCacheMemSize;
        this.queryCacheDiskSize = this.config.queryCacheDiskSize;
        const diskMb = Number(config.queryCacheDiskMb ?? 64);
        if (!Number.isFinite(diskMb) || diskMb < 0 || diskMb > 1024) throw new Error('queryCacheDiskMb: expected 0–1024 MiB');
        this.queryCacheDiskBytes = diskMb * 1024 ** 2;
        this.queryCacheEnabled = this.config.queryCacheEnabled
            && (this.queryCacheMemSize > 0 || this.queryCacheDiskSize > 0);

        this.db = db;

        this.searchFlag = 0;
        this.bookSearches = new Map();
        this.timer = null;
        this.closed = false;

        this.memCache = new (require('./MemoryCache').MemoryCache)({
            bytes: (config.queryCacheMemMb ?? 32) * 1024 ** 2, entries:this.queryCacheMemSize || 0,
        });
        this.bookIdMap = {};

        this.periodicCleanCache();//no await
    }

    async init() {
        await this.fillBookIdMap('author');
        await this.fillBookIdMap('series');
        await this.fillBookIdMap('title');
        await this.fillDbConfig();
        this.rustLookup = new RustLookupIndex(this.dbPath, this.dbConfig);
    }

    queryKey(q) {
        const result = [];
        for (const f of this.recStruct) {
            result.push(q[f.field]);
        }
        result.push(String(q.sourceId || '').trim());
        result.push(q.hideCopies === true || q.hideCopies === 'true' || q.hideCopies === '1' ? '1' : '');
        result.push(copyDedupeVersion);
        result.push(String(q.ratingCount || '').trim(), q[ratingSelection]?.signature || '');
        result.push(String(q.isbn || '').trim());

        return JSON.stringify(result);
    }

    async prepareRatingQuery(query) {
        if (query[ratingSelection]) return query;
        const selections = [];
        if (String(query.ratingCount ?? '').trim()) {
            require('../../shared/RatingCount').parse(query.ratingCount);
            if (!this.ratingIndex) throw new Error('Фильтр числа голосов недоступен для этой библиотеки');
            selections.push(await this.ratingIndex.select(query.ratingCount));
        }
        if (String(query.isbn ?? '').trim()) {
            require('../../shared/Isbn').normalize(query.isbn);
            if (!this.isbnIndex) throw new Error('Поиск ISBN недоступен для этой библиотеки');
            selections.push(await this.isbnIndex.select(query.isbn));
        }
        if (!selections.length) return query;
        const [first, second] = selections;
        const selected = second ? new Set(second.ids) : null;
        return {...query,[ratingSelection]:{ids:selected ? first.ids.filter(id => selected.has(id)) : first.ids,
            deletedIds:first.deletedIds,signature:selections.map(selection => selection.signature).join(':')}};
    }

    getTitleSearchPrefixCandidates(value = '') {
        const result = [];
        const seen = new Set();
        const add = (prefix) => {
            if (!prefix || seen.has(prefix))
                return;
            seen.add(prefix);
            result.push(prefix);
        };

        const safeValue = String(value || '');
        add(safeValue);

        if (!safeValue || ['=', '*', '#', '~'].includes(safeValue[0]) || titleSearchLeadingChars.includes(safeValue[0]))
            return result;

        for (const char of titleSearchLeadingChars) {
            add(`${char}${safeValue}`);
            add(`${char} ${safeValue}`);
        }

        return result;
    }

    getTitlePrefixWhere(a) {
        const db = this.db;
        const candidates = this.getTitleSearchPrefixCandidates(a);

        if (candidates.length <= 1)
            return `@dirtyIndexLR('value', ${db.esc(a)}, ${db.esc(a + maxUtf8Char)})`;

        return `await (async () => {
            const result = new Set();
            const append = (ids) => {
                for (const id of ids)
                    result.add(id);
            };
            ${candidates.map(prefix => `append(@dirtyIndexLR('value', ${db.esc(prefix)}, ${db.esc(prefix + maxUtf8Char)}));`).join('\n            ')}
            return new Uint32Array(result);
        })()`;
    }

    getWhere(a, options = {}) {
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
            utils.checkSearchRegExp(a);
            where = `
                await (async() => {
                    const re = new RegExp(${db.esc(a)}, 'i');
                    @@indexIter('value', (v) => re.test(v) );
                })()
            `;
        } else {
            where = options.looseTitlePrefix ? this.getTitlePrefixWhere(a) : `@dirtyIndexLR('value', ${db.esc(a)}, ${db.esc(a + maxUtf8Char)})`;
        }

        return where;
    }

    async lookupBookIds(fallback, table, ranges) {
        const lookup = this.rustLookup;
        if (!lookup) return fallback();
        const db = this.db;
        return lookup.run(async process => {
            const [result] = await db.select({table, rawResult:true, where:`
                const ranges = ${db.esc(ranges)}, groups = [];
                const index = __tr._index?.get('value');
                for (const [start, end] of ranges) {
                    if (!index?.unique || index.depth !== 1000000 ||
                        index.prepareValue(start) !== start || index.prepareValue(end) !== end) return null;
                    groups.push(Array.from(@dirtyIndexLR('value', start, end)));
                }
                return groups;
            `});
            if (!result.rawResult) return fallback();
            const ids = await process.query({op:'books', table, groups:result.rawResult});
            if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id < 0 || id > 0xffffffff))
                throw new Error('Invalid Rust book lookup response');
            return new Uint32Array(ids);
        }, fallback);
    }

    async wordBookIds(field, query) {
        if (/^[=*#~?]/.test(query) || !await this.db.tableExists({table: 'word'})) return null;
        const search = require('../../shared/CatalogSearch');
        const tokens = [...new Set(search.words(query).map(search.root))];
        if (!tokens.length) return new Uint32Array();
        const ranges = tokens.map(token => {
            const key = `${field}:${token}`;
            return [key, key + maxUtf8Char];
        });
        return this.lookupBookIds(async () => {
            let matches = null;
            for (const [from, to] of ranges) {
                const rows = await this.db.select({table:'word', where:`@@indexLR('value', ${this.db.esc(from)}, ${this.db.esc(to)})`});
                const ids = new Set(rows.flatMap(row => row.bookIds));
                matches = matches === null ? ids : new Set([...matches].filter(id => ids.has(id)));
                if (!matches.size) break;
            }
            return new Uint32Array(matches || []);
        }, 'word', ranges);
    }

    async selectBookIds(query, {bookPredicates = false} = {}) {
        query = await this.prepareRatingQuery(query);
        const db = this.db;

        const idsArr = [];

        const tableBookIds = async(table, where) => {
            const [result] = await db.select({table, rawResult:true, where:`
                const ids = ${where}, result = new Set();
                for (const id of ids) {
                    const row = @unsafeRow(id);
                    for (const bookId of row.bookIds)
                        result.add(bookId);
                }
                return new Uint32Array(result);
            `});
            return result.rawResult;
        };

        const nameBookIds = (table, value, options) => {
            const where = this.getWhere(value, options);
            const fallback = () => tableBookIds(table, where);
            if (!value.startsWith('=')) return fallback();
            const exact = value.toLowerCase().slice(1);
            return this.lookupBookIds(fallback, table, [[exact, exact]]);
        };

        //авторы
        if (query.author) {
            const key = `book-ids-author-${query.author}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await this.wordBookIds('author', query.author) || await nameBookIds('author', query.author);

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //серии
        if (query.series) {
            const key = `book-ids-series-${query.series}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await this.wordBookIds('series', query.series) || await nameBookIds('series', query.series);

                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        //названия
        if (query.title) {
            const key = `book-ids-title-${copyDedupeVersion}-${query.title}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                ids = await this.wordBookIds('title', query.title) || await nameBookIds('title', query.title, {looseTitlePrefix:true});

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
            const key = `book-ids-lang-${bookPredicates ? 'prefix-' : ''}${query.lang}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const langRows = await db.select({
                    table: 'lang',
                    rawResult: true,
                    where: `
                    const langs = ${db.esc(query.lang.split(',').map(value => value.trim().toLowerCase()))};

                        const ids = new Set();
                        for (const l of langs) {
                            for (const id of @indexLR('value', l, l + ${db.esc(bookPredicates && !query.lang.includes(',') && query.lang !== '?' ? maxUtf8Char : '')}))
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
            const key = `book-ids-ext-${bookPredicates ? 'prefix-' : ''}${query.ext}`;
            let ids = await this.getCached(key);

            if (ids === null) {
                const extRows = await db.select({
                    table: 'ext',
                    rawResult: true,
                    where: `
                        const exts = ${db.esc(query.ext.split('|').map(value => value.trim().toLowerCase()))};

                        const ids = new Set();
                        for (const l of exts) {
                            for (const id of @indexLR('value', l, l + ${db.esc(bookPredicates && !query.ext.includes('|') && query.ext !== '?' ? maxUtf8Char : '')}))
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
                if (await this.db.tableExists({table:'source'})) {
                    ids = await tableBookIds('source', `@indexLR('value', ${db.esc(sourceId.toLowerCase())}, ${db.esc(sourceId.toLowerCase())})`);
                } else {
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
                }
                await this.putCached(key, ids);
            }

            idsArr.push(ids);
        }

        if (query[ratingSelection]) idsArr.push(query[ratingSelection].ids);
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
        const data = await fs.readFile(`${this.dbPath}/${from}_id.map`, 'utf-8');

        const idMap = JSON.parse(data);
        idMap.arr = new Uint32Array(idMap.arr);
        idMap.map = new Map(idMap.map);

        this.bookIdMap[from] = idMap;
    }

    async tableIdsFilter(from, query, candidates) {
        //т.к. авторы у книги идут списком (т.е. одна книга относиться сразу к нескольким авторам),
        //то в выборку по bookId могут попасть авторы, которые отсутствуют в критерии query.author,
        //поэтому дополнительно фильтруем
        if (from !== 'author' || !query.author) return null;
        const explicit = /^[=*#~?]/.test(query.author);
        const search = require('../../shared/CatalogSearch');
        const fallback = async () => {
            const key = `filter-ids-author-${query.author}`;
            let authorIds = await this.getCached(key);

            if (authorIds === null) {
                const where = explicit ? this.getWhere(query.author)
                    : `@indexIter('value', (value) => ${search.expression('value', query.author)})`;
                const rows = await this.db.select({
                    table: 'author',
                    rawResult: true,
                    where: `return new Uint32Array(${where})`
                });

                authorIds = rows[0].rawResult;

                await this.putCached(key, authorIds);
            }

            return new Set(authorIds);
        };
        if (explicit || !this.rustLookup || !(candidates?.size <= 32768)) return fallback();
        if (!candidates.size) return candidates;
        return this.rustLookup.run(async process => {
            const ids = [...candidates].sort((a,b) => a-b);
            const labels = await process.query({op:'labels', table:'author', ids});
            if (!Array.isArray(labels) || labels.length !== ids.length || labels.some(label => typeof label !== 'string'))
                throw new Error('Invalid Rust author lookup response');
            const match = search.createMatcher(query.author);
            return new Set(ids.filter((_, index) => match(labels[index].toLowerCase())));
        }, fallback);
    }

    async selectTableIds(from, query) {
        query = await this.prepareRatingQuery(query);
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
                const tableIdsSet = new Set();
                const idMap = this.bookIdMap[from];
                let proc = 0;
                let nextProc = 0;
                for (const bookId of bookIds) {
                    const tableId = idMap.arr[bookId];
                    if (tableId) {
                        tableIdsSet.add(tableId);
                        proc++;
                    } else {
                        const tableIdArr = idMap.map.get(bookId);
                        if (tableIdArr) {
                            for (const tableId of tableIdArr) {
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

                const filter = await this.tableIdsFilter(from, query, tableIdsSet);
                if (filter) {
                    for (const id of tableIdsSet) if (!filter.has(id)) tableIdsSet.delete(id);
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

    authorCopyKey(value) {
        return this.normalizeCopyKeyPart(value)
            .split(/[;,\n]/)
            .map(author => author.trim().split(/\s+/).slice(0, 2).join(' '))
            .filter(Boolean)
            .join('|');
    }

    copyKey(book = {}) {
        const title = this.normalizeCopyKeyPart(book.title);
        const author = this.authorCopyKey(book.author);

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
        if (!sourceId && !hideCopies && !query[ratingSelection])
            return rows;

        const selected = query[ratingSelection] ? new Set(query[ratingSelection].ids) : null;
        return rows.map((row) => {
            let books = Array.isArray(row.books) ? row.books : [];
            if (sourceId)
                books = books.filter(book => String((book && book.sourceId) || '').trim() === sourceId);
            if (selected) {
                books = books.filter(book => selected.has(book.id));
            }

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
        query = await this.prepareRatingQuery(query);
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
        const books = db.booksByIds ? await db.booksByIds(bookIds) : await db.select({
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
        query = await this.prepareRatingQuery(query);
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

            if (query[ratingSelection]) {
                const counts = new Map(found.map(row => [row.id, {bookCount:0, bookDelCount:0}]));
                const mapping = this.bookIdMap[from];
                for (const id of await this.selectBookIds(query)) {
                    for (const tableId of mapping.arr[id] ? [mapping.arr[id]] : mapping.map.get(id) || []) {
                        const count = counts.get(tableId);
                        if (count) count[query[ratingSelection].deletedIds.has(id) ? 'bookDelCount' : 'bookCount']++;
                    }
                }
                for (const row of found) Object.assign(row, counts.get(row.id));
            }

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
        if (this.closed)
            throw new Error('DbSearcher closed');

        this.searchFlag++;
        try {
            return (await this.findBookSearch(query)).ids;
        } finally {
            this.searchFlag--;
        }
    }

    async findBookSearch(query, earlyPages = false) {
        query = await this.prepareRatingQuery(query);
        const bookKey = this.bookSearchKey(query);
        const pageKey = `${bookKey}:first-${earlyPageSize}`;
        // An early-page cache hit must not check the full disk cache first.
        const warmPages = earlyPages && this.queryCacheEnabled && this.memCache.get(pageKey);
        if (warmPages) return warmPages;

        const prefixSearch = this.bookSearches.get(pageKey);
        if (earlyPages && prefixSearch) return prefixSearch.result;
        const fullSearch = this.bookSearches.get(bookKey);
        if (fullSearch) return fullSearch.result;
        // A full ranking also serves first pages. Upgrade an in-flight prefix
        // only until it starts the scan, so early pages can finish independently.
        if (prefixSearch && (prefixSearch.full || !prefixSearch.scanning)) {
            prefixSearch.full = true;
            return prefixSearch.result;
        }

        const key = earlyPages ? pageKey : bookKey;
        const search = {full:!earlyPages, scanning:false};
        search.result = this.loadBookSearch(query, bookKey, pageKey, search);
        this.bookSearches.set(key, search);
        try {
            return await search.result;
        } finally {
            this.bookSearches.delete(key);
        }
    }

    bookSearchKey(query) {
        // An explicit whitespace-only source filters for records without a source.
        const explicitEmptySource = query.sourceId && !String(query.sourceId).trim();
        return `book-search-ids-v2-formats-${this.queryKey(query)}${explicitEmptySource ? ':no-source' : ''}`;
    }

    async loadBookSearch(query, bookKey, pageKey, search) {
        const bookIds = await this.getCached(bookKey);
        if (bookIds !== null) return {ids:bookIds, totalFound:bookIds.length};
        if (!search.full) {
            const saved = await this.getCached(pageKey);
            if (!search.full && saved !== null) return saved;
        }

        search.scanning = true;
        const result = await this.scanBookSearch(query, search.full ? 0 : earlyPageSize);
        if (result.ids.length === result.totalFound)
            await this.putCached(bookKey, result.ids);
        else
            await this.putCached(pageKey, result);
        return result;
    }

    async scanBookSearch(query, prefixLimit) {
        const db = this.db;
        const predicates = [];
        const filterBySearch = (bookField, searchValue) => {
            if (searchValue[0] !== '~') searchValue = searchValue.toLowerCase();
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
                utils.checkSearchRegExp(searchValue);

                const name = `predicate${predicates.length}`;
                predicates.push(`const ${name} = new RegExp(${db.esc(searchValue)}, 'i');`);
                return `${name}.test(row.${bookField})`;
            } else if (['title', 'author', 'series', 'keywords'].includes(bookField)) {
                const name = `predicate${predicates.length}`;
                predicates.push(`const ${name} = ${require('../../shared/CatalogSearch').matcherSource(db.esc(searchValue))};`);
                return `${name}(row.${bookField})`;
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
                if (f.field === 'date' && !/^[=*#~]/.test(searchValue)) {
                    const [from, to] = searchValue.split(',');
                    if (from) checks.push(`row.date >= ${db.esc(from)}`);
                    if (to) checks.push(`row.date <= ${db.esc(to)}`);
                    continue;
                }
                if (f.field === 'genre' && !/^[=*#~]/.test(searchValue)) {
                    const genres = searchValue.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
                    const name = `predicate${predicates.length}`;
                    predicates.push(`const ${name} = new Set(${db.esc(genres)});`);
                    checks.push(`String(row.genre || '').toLowerCase().split(',').some(value => ${name}.has(value.trim()) || (value === '' && ${genres.includes(emptyFieldValue)}))`);
                    continue;
                }
                if (f.field === 'librate' && searchValue.includes(',')) {
                    const rates = searchValue.split(',').map(Number);
                    if (rates.some(value => !Number.isFinite(value))) throw new Error('Некорректный фильтр оценки');
                    checks.push(`${db.esc(rates)}.includes(row.librate)`);
                    continue;
                }
                if (f.type === 'S') {
                    if (['lang', 'ext'].includes(f.field) && (searchValue.includes(',') || f.field === 'ext' && searchValue.includes('|')) && !/^[=*#~]/.test(searchValue)) {
                        const values = searchValue.split(f.field === 'ext' ? /[,|]/ : ',').map(value => value.trim().toLowerCase()).filter(Boolean);
                        checks.push(`(${db.esc(values)}.includes(String(row.${f.field} || '').toLowerCase())
                            || (${values.includes(emptyFieldValue)} && !row.${f.field}))`);
                    } else {
                        checks.push(filterBySearch(f.field, searchValue));
                    }
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
        // The indexed catalogue uses | for formats; direct book predicates also accept commas.
        // Explicit expressions stay in checkBook rather than becoming literal index keys.
        const indexedQuery = {};
        const fields = new Set(this.recStruct.map(field => field.field));
        const hasTable = async table => {
            if (!this.candidateTables) this.candidateTables = new Map();
            if (!this.candidateTables.has(table)) this.candidateTables.set(table,await db.tableExists({table}));
            return this.candidateTables.get(table);
        };
        for (const field of ['title','author','series']) {
            if (fields.has(field) && query[field] && await hasTable(field)
                && (/^[=*#~?]/.test(query[field]) || await hasTable('word')))
                indexedQuery[field] = query[field];
        }
        for (const field of ['genre','lang','ext','date','del','librate']) {
            const value = String(query[field] || '');
            if (!fields.has(field) || !value || !await hasTable(field)) continue;
            if (field === 'del' || field === 'librate') {
                if (!/^\d+(?:,\d+)*$/.test(value) || field === 'del' && value.includes(',')) continue;
            } else if (/^[=*#~]/.test(value)) {
                if (['lang','ext'].includes(field) && value.startsWith('=') && !/[,|]/.test(value)) {
                    indexedQuery[field] = value.slice(1).toLowerCase();
                }
                continue;
            }
            indexedQuery[field] = ['genre','lang','ext'].includes(field)
                ? value.toLowerCase().split(field === 'ext' ? /[,|]/ : ',').map(part => part.trim()).join(field === 'ext' ? '|' : ',') : value;
        }
        if (query.sourceId && await hasTable('source')) indexedQuery.sourceId = query.sourceId;
        const rankPhysicalCopiesFirst = hideCopies && hasNarrowingFilter;
        const cachedPhysicalIds = rankPhysicalCopiesFirst
            ? await this.getCached(this.bookSearchKey({...query, hideCopies:false}))
            : null;
        let candidateIds = cachedPhysicalIds
            ?? (Object.keys(indexedQuery).length ? await this.selectBookIds(indexedQuery,{bookPredicates:true}) : null);
        if (query[ratingSelection] && !cachedPhysicalIds) {
            const selected = new Set(query[ratingSelection].ids);
            candidateIds = candidateIds ? candidateIds.filter(id => selected.has(id)) : query[ratingSelection].ids;
        }
        if (db.bookStore && candidateIds && !hideCopies && !query[ratingSelection]
            && candidateIds.length <= 16384
            && ['author','series','title'].some(field => fields.has(field) && query[field])
            && this.recStruct.every(({field}) => !query[field] || ['author','series','title','del'].includes(field))) {
            const text = ['author','series','title'].map(field => fields.has(field) ? query[field] : '');
            const terms = text.map(value => value ? words(value).map(word => [word,root(word)]) : []);
            if (text.every((value,index) => !value || !/^[=*#~?]/.test(value) && terms[index].length)
                && (!query.del || /^\d+$/.test(query.del))) {
                const result = await db.bookStore.run(async process => {
                    const matches = await process.query({op:'search',ids:Array.from(candidateIds),terms,
                        deleted:fields.has('del') && query.del ? Number(query.del) : null,
                        source:query.sourceId ? String(query.sourceId).trim() : null});
                    if (!Array.isArray(matches)) throw new Error('Invalid Rust book search result');
                    matches.sort(compareBooks);
                    return {ids:Uint32Array.from(prefixLimit ? matches.slice(0,prefixLimit) : matches,row => row.id),
                        totalFound:matches.length};
                },() => null);
                if (result) return result;
            }
        }
        const scanInTableOrder = candidateIds && candidateIds.length >= orderedScanThreshold
            && (cachedPhysicalIds || query[ratingSelection] || reorderedIndexFields.some(field => indexedQuery[field]));
        const idsExpression = candidateIds ? db.esc(Array.from(candidateIds)) : '';
        const iterator = scanInTableOrder || !candidateIds ? '@all()' : idsExpression;
        const rows = await db.select({
            table: 'book',
            rawResult: true,
            where: `
                const enru = new Set(${db.esc(enruArr)});
                const hideCopies = ${hideCopies ? 'true' : 'false'};
                const rankPhysicalCopiesFirst = ${rankPhysicalCopiesFirst && !cachedPhysicalIds};
                ${predicates.join('\n')}
                ${scanInTableOrder ? `
                    // Wide indexed results may be in title or author order;
                    // following them can repeatedly reload the same book blocks.
                    const candidates = ${idsExpression};
                    const candidateOrder = new Map();
                    for (let index = candidates.length - 1; index >= 0; index--)
                        candidateOrder.set(candidates[index], index);
                ` : ''}

                const checkBook = (row) => {
                    return ${checks.join(' && ')};
                };

                const normalizeKeyPart = ${normalizeKeyPart.toString()};
                const physicalBookKey = ${physicalBookKey.toString()};
                const rowScore = ${bookScore.toString()};
                const compareBookFields = ${compareBookFields.toString()};
                const compareBooks = ${compareBooks.toString()};

                const authorKey = (value) => normalizeKeyPart(value)
                    .split(/[;,\\n]/)
                    .map(author => author.trim().split(/\\s+/).slice(0, 2).join(' '))
                    .filter(Boolean)
                    .join('|');

                const dedupeKey = (row, mergeSources) => {
                    if (mergeSources) {
                        const titleKey = normalizeKeyPart(row.title);
                        const mainAuthorKey = authorKey(row.author);

                        if (titleKey && mainAuthorKey)
                            return 'copy:' + mainAuthorKey + '|' + titleKey;
                        if (titleKey)
                            return 'copy-title:' + titleKey;
                    }

                    return physicalBookKey(row,mergeSources);
                };

                const pickBetterRow = (current, next) => {
                    const currentScore = current.score;
                    const nextScore = next.score;

                    if (nextScore !== currentScore)
                        return (nextScore > currentScore ? next : current);

                    return (next.id < current.id ? next : current);
                };

                let deduped = new Map();
                let position = 0;
                for (const id of ${iterator}) {
                    if (++position % 1024 === 0)
                        await new Promise(resolve => setImmediate(resolve));
                    const order = ${scanInTableOrder ? 'candidateOrder.get(id)' : 'position'};
                    if (order === undefined) continue;
                    const row = @unsafeRow(id);
                    if (!checkBook(row))
                        continue;

                    const key = dedupeKey(row, hideCopies && !rankPhysicalCopiesFirst);
                    const existing = deduped.get(key);
                    const score = rowScore(row);
                    if (existing && !(score > existing.score || score === existing.score && row.id < existing.id)) {
                        existing.order = Math.min(existing.order, order);
                        continue;
                    }
                    // Keep only the sort keys, ID and preference score. Holding
                    // full rows here would pin decoded blocks through a scan.
                    const candidate = {id:row.id, author:row.author, series:row.series,
                        serno:row.serno, title:row.title, score, order:existing ? Math.min(existing.order, order) : order};
                    if (rankPhysicalCopiesFirst && !String(row.title || '').trim())
                        candidate.copyKey = dedupeKey(row, true);
                    // Stable sort used the first matching occurrence of each
                    // key, even when a later record won deduplication.
                    deduped.set(key, candidate);
                }

                let compare = compareBooks;
                if (rankPhysicalCopiesFirst) {
                    // The original two-pass search collapsed physical copies,
                    // sorted their winners, then merged copies across sources.
                    // Keep the first rank of each merged group for stable ties.
                    const merged = new Map();
                    for (const [key, row] of deduped) {
                        deduped.delete(key);
                        // A titled result already has all fields needed for its
                        // copy key. Keep a separate rank only when it differs.
                        const copyKey = row.copyKey ?? dedupeKey(row, true);
                        const existing = merged.get(copyKey);
                        if (!existing) {
                            merged.set(copyKey, row);
                            continue;
                        }
                        const previousFirst = existing.firstCopy || existing;
                        const first = compareBooks(previousFirst, row) < 0 ? previousFirst : row;
                        const winner = pickBetterRow(existing, row);
                        winner.firstCopy = first === winner ? null : first;
                        merged.set(copyKey, winner);
                    }
                    deduped = merged;
                    compare = (a, b) => compareBookFields(a, b) || compareBooks(a.firstCopy || a, b.firstCopy || b);
                }

                const prefixLimit = ${db.esc(prefixLimit)};
                let ranked;
                if (prefixLimit && deduped.size > prefixLimit) {
                    const createTopRanked = ${require('./DiscoverySelection').createTopRanked.toString()};
                    const top = createTopRanked(prefixLimit, compare);
                    for (const row of deduped.values()) top.add(row);
                    ranked = top.ranked();
                } else {
                    ranked = Array.from(deduped.values()).sort(compare);
                }
                const ids = Uint32Array.from(ranked, row => row.id);
                return {ids, totalFound:deduped.size};
            `
        });
        return rows[0].rawResult;
    }

    //неоптимизированный поиск по всем книгам, по всем полям
    async bookSearch(query) {
        if (this.closed)
            throw new Error('DbSearcher closed');

        this.searchFlag++;

        try {
            const db = this.db;

            let limit = (query.limit ? query.limit : 100);
            limit = (limit > maxLimit ? maxLimit : limit);
            const offset = (query.offset ? query.offset : 0);
            const earlyPages = Number.isSafeInteger(limit) && limit > 0
                && Number.isSafeInteger(offset) && offset >= 0 && offset + limit <= earlyPageSize;
            const {ids, totalFound} = await this.findBookSearch(query, earlyPages);

            const slice = ids.slice(offset, offset + limit);

            //выборка найденных значений
            const found = db.booksByIds ? await db.booksByIds(slice) : await db.select({
                table: 'book',
                where: `@@id(${db.esc(Array.from(slice))})`
            });

            return {found, totalFound};
        } finally {
            this.searchFlag--;
        }
    }

    async opdsQuery(from, query) {
        query = await this.prepareRatingQuery(query);
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
        } else if (this.queryCacheDiskSize > 0 && this.queryCacheDiskBytes > 0) {//смотрим в таблице
            return this.withDiskCache(async() => {
                await this.initDiskCache();
                const rows = await db.select({table: 'query_cache', where: `@@id(${db.esc(key)})`});

                if (rows.length) {//нашли в кеше
                    await db.insert({
                        table: 'query_time',
                        replace: true,
                        rows: [{id: key, time: Date.now()}],
                    });
                    const item = this.diskCacheItems.get(key);
                    if (item) {this.diskCacheItems.delete(key); this.diskCacheItems.set(key,item);}

                    result = rows[0].value;

                    //заполняем кеш в памяти
                    if (this.queryCacheMemSize > 0) memCache.set(key, result);

                }
                return result;
            });
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

        }

        if (this.queryCacheDiskSize > 0 && this.queryCacheDiskBytes > 0) {
            await this.withDiskCache(async() => {
                try {
                    await this.initDiskCache();
                    const bytes = 128 + Buffer.byteLength(require('jembadb/src/mson').encode([key,{id:key,value}]));
                    if (this.diskCacheItems.has(key)) await this.evictDiskCache([key]);
                    if (bytes > this.queryCacheDiskBytes) return;
                    await this.trimDiskCache(1,bytes);
                    await db.insert({
                        table: 'query_cache',
                        replace: true,
                        rows: [{id: key, value, cacheBytes:bytes}],
                    });

                    await db.insert({
                        table: 'query_time',
                        replace: true,
                        rows: [{id: key, time: Date.now()}],
                    });
                    this.diskCacheItems.set(key,{bytes}); this.diskCacheBytes += bytes;
                } catch(e) {
                    this.diskCacheItems = null;
                    await db.delete({table:'query_cache',where:`@@id(${db.esc(key)})`}).catch(() => {});
                    await db.delete({table:'query_time',where:`@@id(${db.esc(key)})`}).catch(() => {});
                    console.error(`putCached: ${e.message}`);
                }
            });
        }
    }

    withDiskCache(work) {
        const operation = (this.diskCacheQueue || Promise.resolve()).catch(() => {}).then(work);
        this.diskCacheQueue = operation;
        return operation;
    }

    async initDiskCache() {
        if (this.diskCacheItems) return;
        const times = new Map((await this.db.select({table:'query_time'})).map(row => [row.id,row.time]));
        const rows = await this.db.select({table:'query_cache',map:'row => ({id:row.id,bytes:row.cacheBytes})'});
        rows.sort((a,b) => (times.get(a.id) || 0) - (times.get(b.id) || 0));
        this.diskCacheItems = new Map(); this.diskCacheBytes = 0;
        const obsolete = [], present = new Set(rows.map(row => row.id));
        for (const id of times.keys()) if (!present.has(id)) obsolete.push(id);
        for (const row of rows) {
            // Old entries have no size metadata; dropping a rebuildable cache is
            // safer than materializing every old value just to size it.
            if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) obsolete.push(row.id);
            else {this.diskCacheItems.set(row.id,{bytes:row.bytes}); this.diskCacheBytes += row.bytes;}
        }
        if (obsolete.length) await this.evictDiskCache(obsolete);
        await this.trimDiskCache();
    }

    async evictDiskCache(ids) {
        for (let offset = 0; offset < ids.length; offset += 500) {
            const slice = ids.slice(offset,offset+500), where = `@@id(${this.db.esc(slice)})`;
            await this.db.delete({table:'query_cache',where});
            await this.db.delete({table:'query_time',where});
            for (const id of slice) {
                this.diskCacheBytes -= this.diskCacheItems.get(id)?.bytes || 0;
                this.diskCacheItems.delete(id);
            }
        }
    }

    async trimDiskCache(extraEntries = 0, extraBytes = 0) {
        const ids = []; let count = this.diskCacheItems.size, bytes = this.diskCacheBytes;
        for (const [id,item] of this.diskCacheItems) {
            if (count + extraEntries <= this.queryCacheDiskSize && bytes + extraBytes <= this.queryCacheDiskBytes) break;
            ids.push(id); count--; bytes -= item.bytes;
        }
        if (ids.length) await this.evictDiskCache(ids);
    }

    async periodicCleanCache() {
        this.timer = null;
        const cleanInterval = this.config.cacheCleanInterval*60*1000;
        if (!cleanInterval)
            return;

        try {
            if (!this.queryCacheEnabled || this.queryCacheDiskSize <= 0)
                return;

            await this.withDiskCache(async() => {await this.initDiskCache(); await this.trimDiskCache();});
        } catch(e) {
            console.error(e.message);
        } finally {
            if (!this.closed) {
                this.timer = setTimeout(() => { this.periodicCleanCache(); }, cleanInterval);
            }
        }
    }

    async close() {
        this.closed = true;
        while (this.searchFlag > 0) {
            await utils.sleep(50);
        }

        this.searchCache = null;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        await this.ratingIndex?.close?.();
        await this.rustLookup?.close();
        await this.diskCacheQueue?.catch(() => {});
        this.diskCacheItems?.clear();
        this.memCache.close();
        this.bookIdMap = {};
    }
}

module.exports = DbSearcher;
