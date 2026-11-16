const fs = require('fs-extra');
//const _ = require('lodash');
const utils = require('./utils');
const {RustLookupIndex} = require('./RustLookupIndex');
const {compareBooks, compareBookFields, bookScore, normalizeKeyPart, physicalBookKey} = require('./BookSearchProjection');
const {words, root} = require('../../shared/CatalogSearch');
const nameRanges = require('./CatalogueNameRanges');

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
const maxNativeSearchCandidates = 65536;
const nativeTextFields = ['author','series','title'];
const facetCollation = new Intl.Collator('en');

function facetRows(runs, ranges) {
    const result = new Set();
    for (const [from,to] of ranges) {
        const compare = typeof (from ?? to) === 'number' ? (a,b) => a-b : facetCollation.compare;
        const groups = runs.map(run => new Set(run.filter(([,value]) => (from == null || compare(value,from) >= 0)
            && (to == null || compare(value,to) <= 0)).map(([id]) => id)));
        const largest = groups.reduce((best,group) => group.size > best.size ? group : best,new Set());
        for (const id of largest) result.add(id);
        for (const group of groups) if (group !== largest) for (const id of group) result.add(id);
    }
    return [...result];
}

function rankMergedBooks(matches) {
    matches.sort(compareBooks);
    const groups = new Map();
    for (const [rank,row] of matches.entries()) {
        const current = groups.get(row.copy);
        if (!current) groups.set(row.copy,{row,rank});
        else if (row.score > current.row.score || row.score === current.row.score && row.id < current.row.id) current.row = row;
    }
    return [...groups.values()].sort((a,b) => compareBookFields(a.row,b.row) || a.rank - b.rank).map(group => group.row);
}

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
            const order = await process.labelOrder?.(table);
            const groups = order && ranges.every(([from,to]) => from.length<=1000000 && to.length<=1000000)
                ? ranges.map(([from,to])=>nameRanges.range(order,from,to))
                : (await db.select({table, rawResult:true, where:`
                const ranges = ${db.esc(ranges)}, groups = [];
                const index = __tr._index?.get('value');
                for (const [start, end] of ranges) {
                    if (!index?.unique || index.depth !== 1000000 ||
                        index.prepareValue(start) !== start || index.prepareValue(end) !== end) return null;
                    groups.push(Array.from(@dirtyIndexLR('value', start, end)));
                }
                return groups;
            `}))[0].rawResult;
            if (!groups) return fallback();
            const ids = await process.query({op:'books', table, groups});
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

    async namedIds(order,value,{looseTitlePrefix=false} = {}) {
        if (value[0] !== '~') value = value.toLowerCase();
        if (value[0]==='=') return nameRanges.range(order,value.slice(1),value.slice(1));
        if (!['*','#','~'].includes(value[0])) {
            const prefixes = looseTitlePrefix ? this.getTitleSearchPrefixCandidates(value) : [value];
            return [...new Set(prefixes.flatMap(prefix=>nameRanges.range(order,prefix,prefix+maxUtf8Char)))];
        }
        const expression = value[0]==='~' ? new RegExp(value.slice(1),'i') : null;
        const terms = value.slice(1), special = value[0]==='#';
        const allowed = special ? new Set(enruArr) : null;
        const result=[];
        for (const [index,[id,label]] of order.labels.entries()) {
            if (index && index%16384===0) await utils.processLoop();
            if (expression ? expression.test(label) : label!=='?' && (!special || label && !allowed.has(label[0])) && label.includes(terms))
                result.push(id);
        }
        return result;
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

        const facetBookIds = async (table,key,ranges) => {
            const cached = await this.getCached(key);
            if (cached !== null) return cached;
            if ((bookPredicates || db.nativeCatalogue) && db.bookStoreAdvanced && db.bookStoreFacets) {
                const smallest = idsArr.length ? idsArr.reduce((a,b) => a.length <= b.length ? a : b) : null;
                if (smallest?.length===0) return smallest;
                const found = await db.bookStore.run(async process => {
                    const labels = await this.nativeFacetLabels(process,table);
                    if (!labels) return null;
                    const rows = facetRows(labels,ranges);
                    if (!rows.length) return new Uint32Array();
                    const candidates = smallest?.length<=maxNativeSearchCandidates ? Array.from(smallest) : null;
                    const ids = await process.query({op:'facetBooks',table,rows,candidates});
                    if (!Array.isArray(ids)) throw new Error('Invalid Rust facet response');
                    return new Uint32Array(ids);
                },() => null);
                if (found !== null) return found;
            }
            const ids = await tableBookIds(table,`await (async () => {
                const ids = new Set();
                for (const [from,to] of ${db.esc(ranges)}) {
                    for (const id of @indexLR('value',from ?? undefined,to ?? undefined)) ids.add(id);
                }
                return ids;
            })()`);
            await this.putCached(key,ids);
            return ids;
        };

        const nameBookIds = (table, value, options) => {
            const where = this.getWhere(value, options);
            const fallback = () => tableBookIds(table, where);
            if (!this.rustLookup) return fallback();
            return this.rustLookup.run(async process=>{
                const order = await process.labelOrder?.(table);
                if (!order || value.length>1000000) return fallback();
                const ids = await this.namedIds(order,value,options);
                return new Uint32Array(await process.query({op:'books',table,groups:[ids]}));
            },fallback);
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
            idsArr.push(await facetBookIds('genre',key,query.genre.split(',').map(value => [value,value])));
        }

        //языки
        if (query.lang) {
            const key = `book-ids-lang-${bookPredicates ? 'prefix-' : ''}${query.lang}`;
            const suffix = bookPredicates && !query.lang.includes(',') && query.lang !== '?' ? maxUtf8Char : '';
            const values = query.lang.split(',').map(value => value.trim().toLowerCase());
            idsArr.push(await facetBookIds('lang',key,values.map(value => [value,value+suffix])));
        }

        //удаленные
        if (query.del) {
            const del = parseInt(query.del, 10) || 0;
            const key = `book-ids-del-${del}`;
            idsArr.push(await facetBookIds('del',key,[[del,del]]));
        }

        //дата поступления
        if (query.date) {
            const key = `book-ids-date-${query.date}`;
            const [from,to] = query.date.split(',');
            idsArr.push(await facetBookIds('date',key,[[from || null,to || null]]));
        }

        //оценка
        if (query.librate) {
            const key = `book-ids-librate-${query.librate}`;
            const rates = query.librate.split(',').map(value => parseInt(value,10)).filter(value => !isNaN(value));
            idsArr.push(await facetBookIds('librate',key,rates.map(value => [value,value])));
        }

        //тип файла
        if (query.ext) {
            const key = `book-ids-ext-${bookPredicates ? 'prefix-' : ''}${query.ext}`;
            const suffix = bookPredicates && !query.ext.includes('|') && query.ext !== '?' ? maxUtf8Char : '';
            const values = query.ext.split('|').map(value => value.trim().toLowerCase());
            idsArr.push(await facetBookIds('ext',key,values.map(value => [value,value+suffix])));
        }

        //источник библиотеки
        if (query.sourceId) {
            const sourceId = String(query.sourceId || '').trim();
            const key = `book-ids-source-${sourceId}`;
            if (await this.db.tableExists({table:'source'})) {
                const value = sourceId.toLowerCase();
                idsArr.push(await facetBookIds('source',key,[[value,value]]));
            } else {
                let ids = await this.getCached(key);
                if (ids === null) {
                    const [{rawResult}] = await db.select({table:'book',rawResult:true,where:`
                            const sourceId = ${db.esc(sourceId)};
                            const result = [];
                            for (const id of @all()) {
                                const row = @unsafeRow(id);
                                if ((row.sourceId || '') === sourceId) result.push(id);
                            }
                            return new Uint32Array(result);
                    `});
                    ids = rawResult;
                    await this.putCached(key,ids);
                }
                idsArr.push(ids);
            }
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
        if (this.db.nativeCatalogue) {
            this.dbConfig = this.db.nativeCatalogue;
            this.recStruct = this.dbConfig.inpxInfo.recStruct;
            return;
        }
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
        if (!this.rustLookup) return fallback();
        if (explicit || !(candidates?.size <= 32768)) return this.rustLookup.run(async process=>{
            const order = await process.labelOrder?.(from);
            if (!order) return fallback();
            if (explicit) {this.getWhere(query.author);return new Set(await this.namedIds(order,query.author));}
            const match = search.createMatcher(query.author), selected = new Set();
            for (const [index,[id,label]] of order.labels.entries()) {
                if (index && index%16384===0) await utils.processLoop();
                if ((!candidates || candidates.has(id)) && match(label)) selected.add(id);
            }
            return selected;
        },fallback);
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
                const fallback = async()=> (await db.select({
                    table: from,
                    rawResult: true,
                    where: `return new Uint32Array(@all())`
                }))[0].rawResult;
                tableIds = this.rustLookup ? await this.rustLookup.run(async process=>{
                    const order = await process.labelOrder?.(from);
                    return order ? new Uint32Array(order.labels.map(([id])=>id)) : fallback();
                },fallback) : await fallback();
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

    async readNameRows(table, ids, op = 'nameRows') {
        const db = this.db;
        const keys = Array.from(ids).map(Number).filter(id=>Number.isInteger(id) && id>0 && id<=0xffffffff);
        if (!keys.length) return [];
        const fallback = () => db.select({table,where:`@@id(${db.esc(keys)})`});
        if (!db.nativeCatalogue) return fallback();
        return this.rustLookup.run(async process=>{
            const rows = [];
            for (let offset=0;offset<keys.length;offset+=1024)
                rows.push(...await process.query({op,table,ids:keys.slice(offset,offset+1024)}));
            return rows;
        },fallback);
    }

    async nameKeys(table,from,to=from) {
        const db = this.db;
        return this.rustLookup.run(async process=>{
            const order = await process.labelOrder(table);
            if (!order) throw new Error(`Rust catalogue names for ${table} are unavailable`);
            return {order,ids:from===undefined ? order.labels.map(([id])=>id) : nameRanges.range(order,from,to)};
        },()=>{throw new Error(`Rust catalogue names for ${table} are unavailable`);});
    }

    async restoreBooks(from, ids, query = {}) {
        query = await this.prepareRatingQuery(query);
        const db = this.db;
        const bookTable = `${from}_book`;

        const rows = db.nativeCatalogue
            ? (await Promise.all(ids.map(id=>this.getCached(`group-${from}-${id}`)))).filter(Boolean)
            : await db.select({
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

        if (db.nativeCatalogue && this.config.rustBookGroups!==false) {
            const lookupGeneration=this.dbConfig.rustLookupGeneration;
            const native = await db.bookStore.run(async process=>{
                try {return await process.query({op:'bookGroups',table:from,ids:tableIds.map(Number),lookupGeneration});}
                catch (error) {
                    if (error.message.includes('unknown variant `bookGroups`')) return null;
                    throw error;
                }
            },()=>null);
            if (native) {
                rows.push(...native);
                for (const row of native) await this.putCached(`group-${from}-${row.id}`,row);
                return this.filterRestoredRows(rows,query);
            }
        }

        const findRows = () => db.select({
            table: from,
            where: `@@id(${db.esc(tableIds)})`
        });
        const tableRows = db.nativeCatalogue ? await this.readNameRows(from,tableIds,'postings') : this.rustLookup ? await this.rustLookup.run(async process=>{
            const order = await process.labelOrder?.(from);
            return order ? process.query({op:'postings',table:from,ids:tableIds}) : findRows();
        },findRows) : await findRows();

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

            const group = {id:row.id,name:row.name,books};
            rows.push(group);
            if (db.nativeCatalogue) await this.putCached(`group-${from}-${row.id}`,group);
        }

        if (!db.nativeCatalogue) await db.insert({table: bookTable, ignore: true, rows});

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
            const findNames = () => db.select({
                table: from,
                map: `(r) => ({id: r.id, ${from}: r.name, bookCount: r.bookCount, bookDelCount: r.bookDelCount})`,
                where: `@@id(${db.esc(Array.from(slice))})`
            });
            const found = this.rustLookup ? await this.rustLookup.run(async process=>{
                const order = await process.labelOrder?.(from);
                if (!order) return findNames();
                const rows = await process.query({op:'nameRows',table:from,ids:Array.from(slice)});
                return rows.map(({name,...row})=>({...row,[from]:name}));
            },findNames) : await findNames();

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

    async nativeFacetLabels(process,table) {
        this.nativeFacetTables ||= new Map();
        if (!this.nativeFacetTables.has(table)) {
            const labels = await process.query({op:'facetLabels',table});
            if (labels !== null && !Array.isArray(labels)) throw new Error('Invalid Rust facet labels');
            if (labels && this.db.nativeCatalogue)
                for (const run of labels) run.sort(([,a],[,b])=>typeof a==='number' ? a-b : facetCollation.compare(a,b));
            this.nativeFacetTables.set(table,labels);
        }
        return this.nativeFacetTables.get(table);
    }

    async nativeBookVocabulary(process,field) {
        if (this.db.bookStoreFacets) {
            const runs = await this.nativeFacetLabels(process,field);
            if (runs) return ['',...runs.flat().map(([,value]) => value)];
        }
        this.nativeBookVocabularies ||= new Map();
        if (!this.nativeBookVocabularies.has(field)) {
            const loaded = this.db.select({table:field,rawResult:true,where:`
                const values=[''];
                for (const id of @all()) {
                    const row = @unsafeRow(id);
                    const value = row?.value;
                    if (typeof value === 'string') values.push(value);
                }
                return values;
            `}).then(([{rawResult}]) => rawResult).catch(error => {
                this.nativeBookVocabularies.delete(field);
                throw error;
            });
            this.nativeBookVocabularies.set(field,loaded);
        }
        return this.nativeBookVocabularies.get(field);
    }

    async facetValues(table) {
        if (this.db.nativeCatalogue) {
            const runs = await this.db.bookStore.run(process=>this.nativeFacetLabels(process,table),()=>null);
            if (!runs) throw new Error(`Rust catalogue facet ${table} is unavailable`);
            return runs.flat().map(([,value])=>value);
        }
        return (await this.db.select({table,map:'row => ({value:row.value})'})).map(row=>row.value);
    }

    async nativeBookSearch(query, ids, prefixLimit, plan, copies) {
        const db = this.db;
        const wide = !ids || ids.length>maxNativeSearchCandidates;
        let orderKey;
        if (wide) {
            if (!db.bookStoreWide || ids?.length>2_000_000) return null;
            const RustWideOrder = require('./RustWideOrder');
            db.rustWideOrder ||= new RustWideOrder(this.dbPath,db.bookStore);
            orderKey = await db.rustWideOrder.available();
            if (!orderKey) return null;
        }
        return (wide ? db.rustWideStore : db.bookStore).run(async process => {
            const filters = [...plan.filters];
            for (const {field,exact,value} of plan.localeFilters) {
                if (!await db.tableExists({table:field})) return null;
                const vocabulary = await this.nativeBookVocabulary(process,field);
                const values = vocabulary.filter(label => exact ? label.localeCompare(value) === 0
                    : label.localeCompare(value) >= 0 && label.localeCompare(value + maxUtf8Char) <= 0);
                filters.push({kind:'textValues',field,values});
            }
            const source = query.sourceId ? String(query.sourceId).trim() : null;
            if (wide) {
                const keys = ids instanceof Uint32Array ? ids : ids ? Uint32Array.from(ids) : null;
                const packed = keys && Buffer.from(keys.buffer,keys.byteOffset,keys.byteLength).toString('base64');
                const result = await process.query({op:'wideSearch',orderKey,ids:packed,limit:prefixLimit,terms:plan.terms,filters,copies,source});
                if (!Array.isArray(result?.ids) || !Number.isSafeInteger(result.totalFound)) throw new Error('Invalid Rust wide search result');
                return {ids:new Uint32Array(result.ids),totalFound:result.totalFound};
            }
            const result = await process.query({op:'search',ids:Array.from(ids),terms:plan.terms,filters,copies,
                source});
            if (!Array.isArray(result)) throw new Error('Invalid Rust book search result');
            const ranked = copies === 'ranked' ? rankMergedBooks(result) : result.sort(compareBooks);
            return {ids:Uint32Array.from(prefixLimit ? ranked.slice(0,prefixLimit) : ranked,row => row.id),totalFound:ranked.length};
        },() => null);
    }

    async scanBookSearch(query, prefixLimit) {
        const db = this.db;
        const predicates = [];
        const native = db.bookStoreAdvanced ? {filters:[],localeFilters:[],terms:[[],[],[]],supported:true} : null;
        const filterBySearch = (bookField, searchValue) => {
            if (searchValue[0] !== '~') searchValue = searchValue.toLowerCase();
            //особая обработка префиксов
            if (searchValue == emptyFieldValue) {
                native?.filters.push({kind:'empty',field:bookField});
                return `(row.${bookField} === '' || row.${bookField}.indexOf(${db.esc(emptyFieldValue)}) === 0)`;
            } else if (searchValue[0] == '=') {

                searchValue = searchValue.substring(1);
                if (native && ['lang','ext'].includes(bookField)) native.localeFilters.push({field:bookField,exact:true,value:searchValue});
                else if (native) native.supported = false;
                return `(row.${bookField}.toLowerCase().localeCompare(${db.esc(searchValue)}) === 0)`;
            } else if (searchValue[0] == '*') {

                searchValue = searchValue.substring(1);
                native?.filters.push({kind:'contains',field:bookField,value:searchValue,special:false});
                return `(row.${bookField} && row.${bookField}.toLowerCase().indexOf(${db.esc(searchValue)}) >= 0)`;
            } else if (searchValue[0] == '#') {

                searchValue = searchValue.substring(1);
                native?.filters.push({kind:'contains',field:bookField,value:searchValue,special:true});
                return `(row.${bookField} === '' || (!enru.has(row.${bookField}.toLowerCase()[0]) && row.${bookField}.toLowerCase().indexOf(${db.esc(searchValue)}) >= 0))`;
            } else if (searchValue[0] == '~') {//RegExp
                searchValue = searchValue.substring(1);
                utils.checkSearchRegExp(searchValue);
                if (native) native.supported = false;

                const name = `predicate${predicates.length}`;
                predicates.push(`const ${name} = new RegExp(${db.esc(searchValue)}, 'i');`);
                return `${name}.test(row.${bookField})`;
            } else if (['title', 'author', 'series', 'keywords'].includes(bookField)) {
                if (native) {
                    const terms = words(searchValue).map(word => [word,root(word)]);
                    const position = nativeTextFields.indexOf(bookField);
                    if (position >= 0 && terms.length) native.terms[position] = terms;
                    else native.filters.push({kind:'terms',field:bookField,terms});
                }
                const name = `predicate${predicates.length}`;
                predicates.push(`const ${name} = ${require('../../shared/CatalogSearch').matcherSource(db.esc(searchValue))};`);
                return `${name}(row.${bookField})`;
            } else {
                if (native && ['lang','ext'].includes(bookField)) native.localeFilters.push({field:bookField,value:searchValue});
                else if (native) native.supported = false;
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
                    native?.filters.push({kind:'date',from:from || '',to:to || ''});
                    if (from) checks.push(`row.date >= ${db.esc(from)}`);
                    if (to) checks.push(`row.date <= ${db.esc(to)}`);
                    continue;
                }
                if (f.field === 'genre' && !/^[=*#~]/.test(searchValue)) {
                    const genres = searchValue.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
                    native?.filters.push({kind:'genre',values:genres});
                    const name = `predicate${predicates.length}`;
                    predicates.push(`const ${name} = new Set(${db.esc(genres)});`);
                    checks.push(`String(row.genre || '').toLowerCase().split(',').some(value => ${name}.has(value.trim()) || (value === '' && ${genres.includes(emptyFieldValue)}))`);
                    continue;
                }
                if (f.field === 'librate' && searchValue.includes(',')) {
                    const rates = searchValue.split(',').map(Number);
                    if (rates.some(value => !Number.isFinite(value))) throw new Error('Некорректный фильтр оценки');
                    native?.filters.push({kind:'numberValues',field:f.field,values:rates});
                    checks.push(`${db.esc(rates)}.includes(row.librate)`);
                    continue;
                }
                if (f.type === 'S') {
                    if (['lang', 'ext'].includes(f.field) && (searchValue.includes(',') || f.field === 'ext' && searchValue.includes('|')) && !/^[=*#~]/.test(searchValue)) {
                        const values = searchValue.split(f.field === 'ext' ? /[,|]/ : ',').map(value => value.trim().toLowerCase()).filter(Boolean);
                        native?.filters.push({kind:'textValues',field:f.field,values,emptyAlias:true});
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

                        native?.filters.push({kind:'numberValues',field:f.field,values:[searchValue]});
                        checks.push(`row.${f.field} === ${searchValue}`);
                    } else {
                        const from = parseInt(v[0] || '0', 10);
                        const to = parseInt(v[1] || '0', 10);
                        if (isNaN(from) || isNaN(to))
                            throw new Error(`Wrong query param, ${f.field}=${searchValue}`);

                        native?.filters.push({kind:'numberRange',field:f.field,from,to});
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
        if (db.bookStore && native?.supported && (db.bookStoreWide || candidateIds && candidateIds.length<=maxNativeSearchCandidates)) {
            const copies = hideCopies ? rankPhysicalCopiesFirst && !cachedPhysicalIds ? 'ranked' : 'merge' : 'physical';
            const result = await this.nativeBookSearch(query,candidateIds,prefixLimit,native,copies);
            if (result) return result;
        } else if (db.bookStore && candidateIds && !hideCopies && !query[ratingSelection]
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
        const rows = await require('./CatalogueScan').scanBooks(db, scanLoop => `
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
                ${scanLoop}
                    if (!row) continue;
                    if (++position % 1024 === 0)
                        await new Promise(resolve => setImmediate(resolve));
                    const order = ${scanInTableOrder ? 'candidateOrder.get(row.id)' : 'position'};
                    if (order === undefined) continue;
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
            `,{ids:scanInTableOrder ? null : candidateIds});
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

    async groupOpdsNames(from,ids,depth) {
        const groups = new Map();
        const width = Math.min(0xffffffff,Math.max(0,Math.trunc(Number(depth)) || 0));
        if (this.config.rustOpdsGrouping!==false) {
            const count = 262144;
            const reader = ids.length>maxNativeSearchCandidates
                ? (this.rustOpdsLookup ||= new RustLookupIndex(this.dbPath,this.dbConfig)) : this.rustLookup;
            const native = await reader.run(async process=>{
                for (let offset=0;offset<ids.length;offset+=count) {
                    const buffer=ids.subarray(offset,offset+count);
                    const keys=Buffer.from(buffer.buffer,buffer.byteOffset,buffer.byteLength).toString('base64');
                    const rows=await process.query({op:'opdsGroups',table:from,ids:keys,depth:width}).catch(error=>{
                        if (error.message.includes('unknown variant `opdsGroups`')) return null;
                        throw error;
                    });
                    if (!rows) return false;
                    for (const row of rows) {
                        let value='';
                        for (let offset=0;offset<row.value.length;offset+=8192)
                            value+=String.fromCharCode(...row.value.slice(offset,offset+8192));
                        const existing=groups.get(value);
                        if (existing) {existing.count+=row.count;existing.bookCount+=row.bookCount;}
                        else groups.set(value,{...row,value});
                    }
                }
                return true;
            },()=>false);
            if (native) return [...groups.values()].sort((a,b)=>a.value.localeCompare(b.value));
            groups.clear();
        }
        const {order} = await this.nameKeys(from);
        const values = order.labelById ||= new Map(order.labels);
        for (let offset=0;offset<ids.length;offset+=1024) {
            for (const row of await this.readNameRows(from,ids.slice(offset,offset+1024))) {
                const value = values.get(row.id).substring(0,depth);
                const group = groups.get(value);
                if (group) {group.count++;group.bookCount+=row.bookCount;}
                else groups.set(value,{id:row.id,name:row.name,value,count:1,bookCount:row.bookCount});
            }
            await utils.processLoop();
        }
        return [...groups.values()].sort((a,b)=>a.value.localeCompare(b.value));
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
                if (db.nativeCatalogue) {
                    result = {found:await this.groupOpdsNames(from,ids,depth),totalFound};
                    await this.putCached(opdsKey,result);
                    return result;
                }
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

                const rows = db.nativeCatalogue ? [{rawResult:(await this.nameKeys('author',author)).ids}] : await db.select({
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
                if (db.nativeCatalogue) {
                    const {order} = await this.nameKeys('series');
                    const ids = new Set();
                    for (const value of seriesSet) for (const id of nameRanges.range(order,value,value)) ids.add(id);
                    series = (await this.readNameRows('series',ids)).map(({name,...row})=>({...row,series:name}));
                } else series = await db.select({
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
            let rows = db.nativeCatalogue ? [{rawResult:(await this.nameKeys('series',series)).ids}] : await db.select({
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
            if (db.serviceCache) {
                result = await db.serviceCache.get(key);
                if (result !== null && this.queryCacheMemSize > 0) memCache.set(key,result);
                return result;
            }
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
            if (db.serviceCache) {
                await db.serviceCache.put(key,value,this.queryCacheDiskSize,this.queryCacheDiskBytes);
                return;
            }
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

            if (this.db.serviceCache) await this.db.serviceCache.trim(this.queryCacheDiskSize,this.queryCacheDiskBytes);
            else await this.withDiskCache(async() => {await this.initDiskCache(); await this.trimDiskCache();});
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
        await this.rustOpdsLookup?.close();
        await this.rustLookup?.close();
        await this.diskCacheQueue?.catch(() => {});
        this.diskCacheItems?.clear();
        this.memCache.close();
        this.bookIdMap = {};
    }
}

module.exports = DbSearcher;
