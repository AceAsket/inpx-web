const fs = require('fs-extra');
const path = require('node:path');
const {hash} = require('node:crypto');

const InpxParser = require('./InpxParser');
const RustInpxParser = require('./RustInpxParser');
const RustTableBuilder = require('./RustTableBuilder');
const readBookIdentities = require('./RustIdentityReader');
const {RustBookStoreBuild, exportBooks} = require('./RustBookStoreBuild');
const {readPostings} = require('./RustCatalogUpdate');
const InpxHashCreator = require('./InpxHashCreator');
const {getEnabledLibrarySources} = require('./LibrarySources');
const ImportWriteBudget = require('./ImportWriteBudget');
const {buildLookup} = require('./RustLookupBuilder');
const {executable, fileName:lookupFileName, lookupGeneration} = require('./RustLookupIndex');
const utils = require('./utils');
const search = require('../../shared/CatalogSearch');

const emptyFieldValue = '?';
const bookMapTables = ['author', 'series', 'title'];
const bulkIndexTables = new Set(['author', 'title', 'word']);
const compareLabels = new Intl.Collator().compare;
const compareIndexRows = (left, right) => compareLabels(left.value, right.value);

function fileStatistics() {
    const files = new Set(), deleted = new Set();
    return {
        add(book) {
            (book.del ? deleted : files).add(`${book.folder}/${book.file}.${book.ext}`);
        },
        totals() {
            let filesDelCount = 0;
            for (const file of deleted) if (!files.has(file)) filesDelCount++;
            return {filesCount:files.size, filesDelCount};
        },
    };
}

function appendBook(row, id) {
    const ids = row.bookIds;
    if (ids[ids.length - 1] !== id) ids.push(id);
}

function getPosting(map, rows, value, withCounts = false, name) {
    const id = map.get(value);
    if (id !== undefined) return rows[id];
    const row = {id:rows.length, value, bookIds:[]};
    if (withCounts) Object.assign(row, {name, bookCount:0, bookDelCount:0});
    rows.push(row);
    map.set(value, row.id);
    return row;
}

class DbCreator {
    constructor(config) {
        this.config = config;
    }

    // Metadata changes must not change links to progress, notes or reading lists.
    // Keep legacy UIDs when a physical file can be identified without ambiguity.
    physicalIdentity(rec) {
        const source = String(rec.sourceId || '');
        const ext = String(rec.ext || '').toLowerCase();
        let identity;
        if (rec.file) identity = ['file', source, String(rec.folder || '').replace(/\\/g, '/'), String(rec.file), ext, Number(rec.insno) || 0];
        else if (rec.libid) identity = ['libid', source, String(rec.sourcelib || ''), String(rec.libid), ext];
        else return '';
        return hash('sha256', 'inpx-physical-v1:' + JSON.stringify(identity), 'base64');
    }

    async previousIdentities(db, consume) {
        const cursor = 'identity-' + require('crypto').randomBytes(8).toString('hex');
        try {
            while (true) {
                const rows = await db.select({table:'book', rawResult:true, where:`
                    let cursor = @getItem(${db.esc(cursor)});
                    if (!cursor) {cursor = @all(); @setItem(${db.esc(cursor)}, cursor);}
                    const rows = [];
                    while (rows.length < 1000) {
                        const next = cursor.next(); if (next.done) break;
                        const row = @unsafeRow(next.value);
                        rows.push({uid:row._uid,legacyUid:row._legacyUid,id:row.id,hash:row._recordHash,sourceId:row.sourceId,
                            folder:row.folder,file:row.file,ext:row.ext,insno:row.insno,libid:row.libid,sourcelib:row.sourcelib});
                    }
                    return rows;
                `});
                if (!rows[0].rawResult.length) break;
                // Only one source projection lives here at a time. Retaining
                // paths for every prior record alongside the posting lists
                // would substantially increase full-reindex memory usage.
                await consume(rows[0].rawResult.map(row => ({uid:row.uid,id:row.id,hash:row.hash,
                    identity:this.physicalIdentity(row),legacyUid:row.legacyUid,sourceId:row.sourceId})));
            }
        } finally {await db.select({table:'book',rawResult:true,where:`@delItem(${db.esc(cursor)}); return null;`});}
    }

    async loadInpxFilter() {
        const inpxFilterFile = this.config.inpxFilterFile;

        if (await fs.pathExists(inpxFilterFile)) {
            let filter = await fs.readFile(inpxFilterFile, 'utf8');
            filter = JSON.parse(filter);

            if (filter.includeAuthors) {
                filter.includeAuthors = filter.includeAuthors.map(a => a.toLowerCase());
                filter.includeSet = new Set(filter.includeAuthors);
            }

            if (filter.excludeAuthors) {
                filter.excludeAuthors = filter.excludeAuthors.map(a => a.toLowerCase());
                filter.excludeSet = new Set(filter.excludeAuthors);
            }

            return filter;
        } else {
            return false;
        }
    }

    //процедура формировани БД несколько усложнена, в целях экономии памяти
    async loadBooks(db, callback, sourceHash, inpxFilter) {
        const config = this.config;

        callback({jobStepCount: 5});
        callback({job: 'load inpx', jobMessage: 'Загрузка INPX', jobStep: 1, progress: 0});

        //временная таблица
        const incremental = await db.tableExists({table: 'book'});
        const bookCacheSize = config.lowMemoryMode ? 5 : config.dbCacheSize;
        const binary = executable();
        const useBulkIndexes = !!(binary && config.indexDbPath && !config.lowMemoryMode && !config.fullOptimization
            && require('jembadb/package.json').version === '5.1.7');
        if (incremental) await db.open({table: 'book', cacheSize:bookCacheSize});
        let bookWrites, nativeBook;
        const uidIndex = incremental && (await db.getDbInfo({table:'book'})).book.hash.find(index => index.field === '_uid');
        let keepUidIndex = !!(useBulkIndexes && uidIndex?.unique && uidIndex.type === 'string' && uidIndex.depth === 100);
        const dropUidIndex = async (flushWrites = false) => {
            if (flushWrites) {
                // JembaDB saves accepted inserts asynchronously. Flush the
                // hash deltas before removing the index they refer to.
                await db.close({table:'book'});
                bookWrites.check();
                await db.open({table:'book', cacheSize:bookCacheSize});
                bookWrites = new ImportWriteBudget(db,'book',config.lowMemoryMode);
            }
            await db.drop({in:'book', hash:{field:'_uid'}});
            keepUidIndex = false;
        };
        if (uidIndex && !keepUidIndex) await dropUidIndex();
        const previous = new Map(), physical = new Map(), legacy = new Map();
        let lastBookId = 0, hasLongUid = false;
        const rememberLegacy = row => {
            if (!row.legacyUid) return;
            const key = `${row.identity}:${row.legacyUid}`;
            legacy.set(key, legacy.has(key) ? null : row);
        };
        const rememberPrevious = rows => {
            for (const row of rows) {
                previous.set(row.uid,row); lastBookId = Math.max(lastBookId,row.id);
                hasLongUid ||= typeof row.uid !== 'string' || row.uid.length > 100;
                if (row.identity) {
                    const owner = physical.get(row.identity);
                    if (owner === undefined) physical.set(row.identity, row);
                    else {
                        // Only ambiguous physical identities need another
                        // lookup by the original INPX record's UID.
                        if (owner) rememberLegacy(owner);
                        rememberLegacy(row);
                        physical.set(row.identity, null);
                    }
                }
            }
        };
        if (incremental) {
            let nativeIdentities = false;
            callback({job:'previous identities', jobMessage:'Чтение идентификаторов действующего каталога', jobStep:1, progress:0});
            if (useBulkIndexes) {
                try {
                    const [count] = await db.select({table:'book', count:true});
                    await readBookIdentities(binary, path.join(config.indexDbPath,'book'), count.count,
                        row => this.physicalIdentity(row), rememberPrevious);
                    nativeIdentities = true;
                } catch (error) {
                    previous.clear(); physical.clear(); legacy.clear();
                    lastBookId = 0;
                    hasLongUid = false;
                    callback({rustIdentityWarning:error.message});
                }
            }
            if (!nativeIdentities) await this.previousIdentities(db,rememberPrevious);
            if (keepUidIndex && hasLongUid) await dropUidIndex();
            callback({nativeIdentities});
        } else if (config.identityDbPath) {
            const compatibility = new (require('jembadb/src/JembaDb'))();
            try {
                await compatibility.lock({dbPath:config.identityDbPath,softLock:true});
                await compatibility.open({table:'book',cacheSize:5});
                await this.previousIdentities(compatibility,rememberPrevious);
            } catch (error) {
                throw new Error(`Не удалось сохранить идентификаторы прежней библиотеки: ${error.message}`);
            } finally {await compatibility.unlock();}
        }
        let recordsChanged = 0;

        //поисковые таблицы, позже сохраним в БД
        let authorMap = new Map();//авторы
        let authorArr = [];
        let seriesMap = new Map();//серии
        let seriesArr = [];
        let titleMap = new Map();//названия
        let titleArr = [];
        let genreMap = new Map();//жанры
        let genreArr = [];
        let langMap = new Map();//языки
        let langArr = [];
        let delMap = new Map();//удаленные
        let delArr = [];
        let dateMap = new Map();//дата поступления
        let dateArr = [];
        let librateMap = new Map();//оценка
        let librateArr = [];
        let extMap = new Map();//тип файла
        let extArr = [];
        let wordMap = new Map();
        let wordArr = [];
        const wordCache = {author:new Map(), series:new Map()};
        const wordCacheLimit = config.lowMemoryMode ? 4096 : 32768;
        const genreCache = new Map();
        let importFiles = config.lowMemoryMode ? null : fileStatistics();
        let sourceMap = new Map(), sourceArr = [];

        let uidSet = new Set();//уникальные идентификаторы

        const librarySources = getEnabledLibrarySources(config);

        //stats
        let authorCount = 0;
        let bookCount = 0;
        let noAuthorBookCount = 0;
        let bookDelCount = 0;

        //stuff
        let recsLoaded = 0;
        callback({recsLoaded});
        let chunkNum = 0;

        //фильтр
        let filter = () => true;
        if (inpxFilter) {

            let recFilter = () => true;
            if (inpxFilter.filter) {
                if (config.allowUnsafeFilter)
                    recFilter = new Function(`'use strict'; return ${inpxFilter.filter}`)();
                else
                    throw new Error(`Unsafe property 'filter' detected in ${this.config.inpxFilterFile}. Please specify '--unsafe-filter' param if you know what you're doing.`);
            }

            filter = (rec) => {
                let author = rec.author;
                if (!author)
                    author = emptyFieldValue;

                author = author.toLowerCase();

                let excluded = false;
                if (inpxFilter.excludeSet) {
                    const authors = author.split(',');

                    for (const a of authors) {
                        if (inpxFilter.excludeSet.has(a)) {
                            excluded = true;
                            break;
                        }
                    }
                }

                return recFilter(rec)
                    && (!inpxFilter.includeSet || inpxFilter.includeSet.has(author))
                    && !excluded
                ;
            };
        }

        //вспомогательные функции
        const splitAuthor = (author) => {
            if (!author)
                author = emptyFieldValue;

            const result = author.split(',');
            if (result.length > 1)
                result.push(author);

            return result;
        }

        let currentSource = librarySources[0];
        let totalFiles = 0;
        const readFileCallback = async(readState) => {
            callback(Object.assign({
                sourceId: currentSource.id,
                sourceName: currentSource.name,
            }, readState));

            if (readState.totalFiles)
                totalFiles = readState.totalFiles;

            if (totalFiles)
                callback({progress: (readState.current || 0)/totalFiles});
        };

        const parseField = (fieldValue, fieldMap, fieldArr, bookId, rec, fillBookIds = true) => {
            let value = fieldValue;

            if (typeof(fieldValue) == 'string') {
                if (!fieldValue)
                    fieldValue = emptyFieldValue;

                value = fieldValue.toLowerCase();
            }

            const fieldRec = getPosting(fieldMap, fieldArr, value, rec !== undefined, fieldValue);

            if (fieldValue !== emptyFieldValue || fillBookIds) {
                // All references for a book are processed together, including
                // repeated authors or genres. Each accepted book ID is unique.
                appendBook(fieldRec, bookId);
            }

            if (rec !== undefined) {
                if (!rec.del)
                    fieldRec.bookCount++;
                else
                    fieldRec.bookDelCount++;
            }
        };        

        const wordPostings = (field, value) => {
            const cache = wordCache[field];
            const saved = cache?.get(value);
            if (saved) return saved;
            const keys = new Set(search.words(value).map(word => `${field}:${search.root(word)}`));
            const rows = Array.from(keys, key => getPosting(wordMap, wordArr, key.toLowerCase()));
            if (cache && (!value || value.length <= 512)) {
                if (cache.size >= wordCacheLimit) cache.clear();
                cache.set(value, rows);
            }
            return rows;
        };

        const genrePostings = value => {
            const saved = genreCache.get(value);
            if (saved) return saved;
            const rows = value.split(',').map(genre => getPosting(genreMap, genreArr, (genre || emptyFieldValue).toLowerCase()));
            if (value.length <= 512) {
                if (genreCache.size >= 4096) genreCache.clear();
                genreCache.set(value, rows);
            }
            return rows;
        };

        const parseBookRec = (rec) => {
            parseField(rec.sourceId, sourceMap, sourceArr, rec.id);
            for (const field of ['title', 'author', 'series']) {
                for (const entry of wordPostings(field, rec[field])) appendBook(entry, rec.id);
            }
            //авторы
            const author = splitAuthor(rec.author);

            for (let i = 0; i < author.length; i++) {
                const a = author[i];

                //статистика
                if (!authorMap.has(a.toLowerCase()) && (author.length == 1 || i < author.length - 1)) //без соавторов
                    authorCount++;
                
                parseField(a, authorMap, authorArr, rec.id, rec);                
            }

            //серии
            parseField(rec.series, seriesMap, seriesArr, rec.id, rec, false);

            //названия
            parseField(rec.title, titleMap, titleArr, rec.id, rec);

            //жанры
            for (const entry of genrePostings(rec.genre)) appendBook(entry, rec.id);

            //языки
            parseField(rec.lang, langMap, langArr, rec.id);
            
            //удаленные
            parseField(rec.del, delMap, delArr, rec.id);

            //дата поступления
            parseField(rec.date, dateMap, dateArr, rec.id);

            //оценка
            parseField(rec.librate, librateMap, librateArr, rec.id);

            //тип файла
            parseField(rec.ext, extMap, extArr, rec.id);
        };

        //основная процедура парсинга
        let id = lastBookId;
        let bookStore = null, storeFailed = false, rustBookStoreGeneration;
        const buildStore = useBulkIndexes && !inpxFilter?.filter && config.rustBookStoreEnabled !== false;
        const storeGeneration = buildStore && lookupGeneration({inpxHash:sourceHash,dbVersion:config.dbVersion,
            rustLookupBuiltAt:new Date().toISOString()});
        const storeWork = async work => {
            try {await work();}
            catch (error) {
                storeFailed = true;
                await bookStore?.close();
                bookStore = null;
                callback({rustStoreWarning:error.message});
            }
        };
        if (buildStore && incremental && config.previousIndexPath) {
            await storeWork(async () => {
                bookStore = await RustBookStoreBuild.openPatch(binary,config.indexDbPath,storeGeneration,config.previousIndexPath);
            });
        }
        const parsedCallback = async(chunk) => {
            const encodedBooks = nativeBook ? [] : null;
            const saveChunk = [];
            for (const rec of chunk) {
                rec.sourceId = currentSource.id;
                rec.sourceName = currentSource.name;
                rec.sourceLibDir = currentSource.libDir;

                const identity = currentSource.type === 'folder' ? '' : this.physicalIdentity(rec);
                const parsedUid = rec._uid;
                if (identity) rec._legacyUid = parsedUid;
                const uidPrior = previous.get(parsedUid);
                // The same INPX line can occur in several archives, since the
                // archive name can come from the enclosing .inp entry.
                let prior = uidPrior;
                if (identity && uidPrior?.identity !== identity) {
                    const owner = physical.get(identity);
                    prior = owner === null ? legacy.get(`${identity}:${parsedUid}`) : owner;
                }
                if (prior && !uidSet.has(prior.uid)) rec._uid = prior.uid;
                else {
                    prior = null;
                    if (identity && !physical.has(identity) && !uidSet.has(identity) && !previous.has(identity)) {
                        rec._uid = identity;
                    } else if (identity && uidPrior && uidPrior.identity !== identity) {
                        rec._uid = hash('sha256', `inpx-record-v1:${identity}:${parsedUid}`, 'base64');
                        const variant = previous.get(rec._uid);
                        if (variant && variant.identity === identity) prior = variant;
                    }
                }
                //сначала фильтр
                if (!filter(rec) || uidSet.has(rec._uid)) continue;

                const serialized = JSON.stringify(rec);
                const reuseEncoding = encodedBooks && !Object.hasOwn(rec, 'id') && !Object.hasOwn(rec, '_recordHash');
                if (!reuseEncoding) rec._recordHash = hash('sha256', serialized, 'hex');
                rec.id = prior ? prior.id : ++id;
                if (encodedBooks) {
                    const uidKey = JSON.stringify(rec._uid.slice(0, 100));
                    const row = reuseEncoding ? serialized + ',true' : JSON.stringify(rec);
                    encodedBooks.push(`[${rec.id},${uidKey},${row}]\n`);
                } else if (!incremental || !prior || prior.hash !== rec._recordHash) saveChunk.push(rec);
                if (prior) prior.retained = true;
                uidSet.add(rec._uid);

                if (!rec.del) {
                    bookCount++;
                    if (!rec.author)
                        noAuthorBookCount++;
                } else {
                    bookDelCount++;
                }

                parseBookRec(rec);
                importFiles?.add(rec);
            }

            if (encodedBooks?.length) await nativeBook.append(encodedBooks);
            if (saveChunk.length) {
                if (keepUidIndex && saveChunk.some(rec => {
                    const old = previous.get(rec._uid);
                    return typeof rec._uid !== 'string' || rec._uid.length > 100 || old && old.id !== rec.id;
                })) await dropUidIndex(true);
                await db.insert({table: 'book', rows: saveChunk, replace: true});
                await bookWrites.wait();
                if (bookStore) await storeWork(() => bookStore.add(saveChunk));
            }
            recordsChanged += encodedBooks?.length ?? saveChunk.length;
            callback({recordsChanged, incremental});

            recsLoaded += chunk.length;
            callback({recsLoaded});

            if (chunkNum++ % 10 == 0 && config.lowMemoryMode)
                utils.freeMemory();
        };

        if (useBulkIndexes && !incremental && !config.identityDbPath && !inpxFilter?.filter
            && librarySources.every(source => source.type !== 'folder')) {
            try {
                nativeBook = await RustTableBuilder.open(binary, path.join(config.indexDbPath, 'book'), 'build-book');
            } catch (error) {
                callback({rustBookWarning:error.message});
            }
        }
        if (!nativeBook) {
            if (!incremental) await db.create({table:'book', cacheSize:bookCacheSize});
            bookWrites = new ImportWriteBudget(db, 'book', config.lowMemoryMode);
        }
        //парсинг
        const parserInfos = [];
        try {
            for (const source of librarySources) {
                currentSource = source;
                totalFiles = 0;
                callback({
                    job:'load inpx', jobMessage:`Loading INPX: ${source.name}`, jobStep:1, progress:0,
                    sourceId:source.id, sourceName:source.name,
                });

                const rustReader = process.env.INPX_RUST_READER_BINARY;
                const parser = source.type === 'folder' ? new (require('./FolderIndexer').FolderIndexer)(source, config)
                    : rustReader ? new RustInpxParser(rustReader) : new InpxParser();
                await parser.parse(source.inpxFile || source.inpx, readFileCallback, parsedCallback);
                if (rustReader && source.type !== 'folder') callback({rustReader:!!parser.usedRust});
                parserInfos.push({
                    id:source.id, name:source.name, inpx:source.inpxFile || source.inpx,
                    libDir:source.libDir, info:parser.info,
                });
            }
            if (nativeBook) {
                await nativeBook.finish(recordsChanged);
                callback({nativeBook:true});
            }
        } catch (error) {
            await bookStore?.close();
            throw error;
        } finally {
            await nativeBook?.close();
        }

        const removed = [];
        if (incremental) {
            for (const row of previous.values()) if (!row.retained) removed.push(row.id);
        }
        try {
            for (let offset = 0; offset < removed.length; offset += 10000) {
                const ids = removed.slice(offset,offset+10000);
                await db.delete({table:'book',where:`@@id(${db.esc(ids)})`});
                await bookWrites.wait();
                if (bookStore) await storeWork(() => bookStore.remove(ids));
            }
            if (bookStore) await storeWork(async () => {
                await bookStore.finish();
                rustBookStoreGeneration = storeGeneration;
                callback({bookStoreMode:'patch'});
            });
        } finally {
            await bookStore?.close();
            bookStore = null;
        }

        //чистка памяти, ибо жрет как не в себя
        authorMap = null;
        seriesMap = null;
        titleMap = null;
        genreMap = null;
        langMap = null;
        delMap = null;
        dateMap = null;
        librateMap = null;
        extMap = null;
        sourceMap = null;
        wordMap = null;
        wordCache.author.clear();
        wordCache.series.clear();
        genreCache.clear();
        const fileCounts = importFiles?.totals();
        importFiles = null;
        physical.clear(); previous.clear(); legacy.clear();

        uidSet = null;

        if (!nativeBook) {
            await db.close({table: 'book'});
            bookWrites.check();
        }
        await db.freeMemory();
        utils.freeMemory();

        return {authorArr, seriesArr, titleArr, genreArr, langArr, delArr, dateArr, librateArr, extArr, sourceArr, wordArr,
            authorCount, bookCount, bookDelCount, noAuthorBookCount, fileCounts, parserInfos, recsLoaded,
            incremental, recordsChanged, recordsRemoved:removed.length, bookCacheSize, nativeBook:!!nativeBook,
            useBulkIndexes, keepUidIndex, buildStore, storeFailed, storeGeneration, rustBookStoreGeneration};
    }

    async run(db, callback, prepared = null) {
        const config = this.config;
        const binary = executable();
        const inpxHashCreator = new InpxHashCreator(config);
        const sourceHash = prepared?.sourceHash ?? await inpxHashCreator.getHash();
        const inpxFilter = prepared?.filter ?? await this.loadInpxFilter();
        let {authorArr, seriesArr, titleArr, genreArr, langArr, delArr, dateArr, librateArr, extArr, sourceArr, wordArr,
            authorCount, bookCount, bookDelCount, noAuthorBookCount, fileCounts, parserInfos, recsLoaded,
            incremental, recordsChanged, recordsRemoved, bookCacheSize, nativeBook, useBulkIndexes, keepUidIndex,
            buildStore, storeFailed, storeGeneration, rustBookStoreGeneration} = prepared ? {
                ...await readPostings(config.indexDbPath), ...prepared, ...prepared.counts, fileCounts:prepared.counts,
                incremental:true, nativeBook:true, useBulkIndexes:true, keepUidIndex:true, rustBookStoreGeneration:prepared.generation,
            } : await this.loadBooks(db,callback,sourceHash,inpxFilter);

        //отсортируем таблицы выдадим им правильные id
        //порядок id соответствует ASC-сортировке по value
        callback({job: 'sort', jobMessage: 'Сортировка', jobStep: 2, progress: 0});
        //сортировка авторов
        authorArr.sort(compareIndexRows);
        callback({progress: 0.2});

        authorArr.forEach((row,index) => {row.id = index + 1;});
        callback({progress: 0.3});

        //сортировка серий
        seriesArr.sort(compareIndexRows);
        callback({progress: 0.5});

        seriesArr.forEach((row,index) => {row.id = index + 1;});
        callback({progress: 0.6});

        //сортировка названий
        titleArr.sort(compareIndexRows);
        callback({progress: 0.8});
        await utils.sleep(100);        
        titleArr.forEach((row,index) => {row.id = index + 1;});

        let rustLookupBuiltAt, nativeBookMaps = false;
        if (executable()) {
            const lookupPath = path.join(config.indexDbPath || path.join(config.dataDir, 'db'), lookupFileName);
            const builtAt = new Date().toISOString();
            const generation = lookupGeneration({inpxHash:sourceHash, rustLookupBuiltAt:builtAt, dbVersion:config.dbVersion});
            const tables = Object.entries({author:authorArr, series:seriesArr, title:titleArr, word:wordArr});
            const count = tables.reduce((total, [, rows]) => total + rows.length, 0);
            function* postings() {
                for (const [table, rows] of tables) {
                    for (const row of rows) yield [table, row];
                }
            }
            callback({job:'rust lookup', jobMessage:'Построение Rust-индекса поиска', progress:0});
            try {
                const bookMaps = !config.fullOptimization && !config.lowMemoryMode;
                await buildLookup(executable(), lookupPath, {generation, count, bookMaps, rows:postings()});
                if (bookMaps) nativeBookMaps = (await Promise.all(bookMapTables.map(table =>
                    fs.pathExists(path.join(path.dirname(lookupPath), `${table}_id.map`))))).every(Boolean);
                rustLookupBuiltAt = builtAt;
                callback({progress:1, nativeBookMaps});
            } catch (error) {
                callback({job:'rust lookup unavailable', jobMessage:`Используется JembaDB: ${error.message}`});
            }
        }

        //stats
        const stats = {
            filesCount: 0,//вычислим позднее
            filesCountAll: 0,//вычислим позднее
            filesDelCount: 0,//вычислим позднее
            recsLoaded,
            authorCount,
            authorCountAll: authorArr.length,
            bookCount,
            bookCountAll: bookCount + bookDelCount,
            bookDelCount,
            noAuthorBookCount,
            titleCount: titleArr.length,
            seriesCount: seriesArr.length,
            genreCount: genreArr.length,
            langCount: langArr.length,
        };
        //console.log(stats);

        //сохраним поисковые таблицы
        const chunkSize = 10000;

        const saveTable = async(table, arr, nullArr, indexType = 'string', delEmpty = false) => {
            
            if (indexType === 'string') {
                if (!bookMapTables.includes(table)) arr.sort(compareIndexRows);
            } else {
                arr.sort((a, b) => a.value - b.value);
            }

            if (prepared || (nativeBook || incremental && useBulkIndexes) && bulkIndexTables.has(table)) {
                const tablePath = path.join(config.indexDbPath, table);
                try {
                    const rows = delEmpty ? arr.filter(row => row.value.localeCompare(emptyFieldValue,'en') !== 0) : arr;
                    await RustTableBuilder.buildIndex(binary,tablePath,rows,callback,indexType);
                    if (delEmpty && stats[`${table}Count`]) stats[`${table}Count`] -= arr.length - rows.length;
                    callback({nativeIndex:table});
                    nullArr();
                    return;
                } catch (error) {
                    if (await fs.pathExists(tablePath)) throw error;
                    callback({rustTableWarning:`${table}: ${error.message}`});
                }
            }

            await db.create({
                table,
                index: {field: 'value', unique: true, type: indexType, depth: 1000000},
            });

            //вставка в БД по кусочкам, экономим память
            for (let i = 0; i < arr.length; i += chunkSize) {
                await db.insert({table, rows: arr.slice(i, i + chunkSize)});

                if (i % 5 == 0) {
                    await db.freeMemory();
                    await utils.sleep(10);
                }

                callback({progress: i/arr.length});                
            }

            if (delEmpty) {
                const delResult = await db.delete({table, where: `@@indexLR('value', '?', '?')`});
                const statField = `${table}Count`;
                if (stats[statField])
                    stats[statField] -= delResult.deleted;
            }

            nullArr();
            await db.close({table});
            utils.freeMemory();
            await db.freeMemory();
        };

        //author
        callback({job: 'author save', jobMessage: 'Сохранение индекса авторов', jobStep: 3, progress: 0});
        await saveTable('author', authorArr, () => {authorArr = null});

        //series
        callback({job: 'series save', jobMessage: 'Сохранение индекса серий', jobStep: 4, progress: 0});
        await saveTable('series', seriesArr, () => {seriesArr = null}, 'string', true);

        //title
        callback({job: 'title save', jobMessage: 'Сохранение индекса названий', jobStep: 5, progress: 0});
        await saveTable('title', titleArr, () => {titleArr = null});

        //genre
        callback({job: 'genre save', jobMessage: 'Сохранение индекса жанров', jobStep: 6, progress: 0});
        await saveTable('genre', genreArr, () => {genreArr = null});

        callback({job: 'others save', jobMessage: 'Сохранение остальных индексов', jobStep: 7, progress: 0});
        //lang
        await saveTable('lang', langArr, () => {langArr = null});

        //del
        await saveTable('del', delArr, () => {delArr = null}, 'number');

        //date
        await saveTable('date', dateArr, () => {dateArr = null});

        //librate
        await saveTable('librate', librateArr, () => {librateArr = null}, 'number');

        //ext
        await saveTable('ext', extArr, () => {extArr = null});
        await saveTable('source', sourceArr, () => {sourceArr = null});
        await saveTable('word', wordArr, () => {wordArr = null});

        //кэш-таблицы запросов
        await db.create({table: 'query_cache'});
        await db.create({table: 'query_time'});

        //кэш-таблица имен файлов и их хешей
        await db.create({table: 'file_hash'});

        //-- завершающие шаги --------------------------------
        const needsBookAtEnd = !nativeBook && (!keepUidIndex || !fileCounts || config.fullOptimization);
        if (needsBookAtEnd) await db.open({table:'book', cacheSize:bookCacheSize});

        callback({job: 'optimization', jobMessage: 'Оптимизация', jobStep: 8, progress: 0});
        const mapSteps = [0, 0.3, 0.5, 1];
        for (const [index, table] of bookMapTables.entries()) {
            const start = mapSteps[index], end = mapSteps[index + 1];
            if (nativeBookMaps) {
                await db.create({table:`${table}_book`});
                await db.close({table:`${table}_book`});
                callback({progress:end});
            } else {
                await this.optimizeTable(table, db, state =>
                    callback({...state, progress:start + (end - start) * state.progress}));
            }
        }

        callback({job: 'stats count', jobMessage: 'Подсчет статистики', jobStep: 9, progress: 0});
        await this.countStats(db, callback, stats, fileCounts, !!nativeBook || keepUidIndex);

        //чистка памяти, ибо жрет как не в себя
        if (needsBookAtEnd) await db.close({table: 'book'});
        await db.freeMemory();
        utils.freeMemory();

        if (buildStore && !storeFailed && !rustBookStoreGeneration) {
            callback({job:'book store',jobMessage:'Сборка хранилища книг Rust',progress:0});
            let bookStore;
            try {
                bookStore = await RustBookStoreBuild.open(binary,config.indexDbPath,storeGeneration);
                await db.open({table:'book',cacheSize:bookCacheSize});
                try {
                    await exportBooks(bookStore,db);
                    await bookStore.finish();
                    rustBookStoreGeneration = storeGeneration;
                    callback({bookStoreMode:'base'});
                } finally {
                    await db.close({table:'book'});
                    await bookStore.close();
                }
            } catch (error) {
                await bookStore?.close();
                callback({rustStoreWarning:error.message});
            }
        }

        //config сохраняем в самом конце, нет конфига - с базой что-то не так
        if (sourceHash !== await inpxHashCreator.getHash())
            throw new Error('Источники изменились во время индексации. Повторите обновление.');

        await db.create({
            table: 'config'
        });

        const inpxInfo = parserInfos.length === 1
            ? parserInfos[0].info
            : {
                collection: parserInfos.map(source => source.name).join(' + '),
                version: parserInfos.map(source => source.info && source.info.version).filter(Boolean).join(' + '),
                structure: (parserInfos[0].info || {}).structure,
                recStruct: (parserInfos[0].info || {}).recStruct,
                sources: parserInfos.map(source => ({
                    id: source.id,
                    name: source.name,
                    inpx: source.inpx,
                    libDir: source.libDir,
                    collection: source.info && source.info.collection,
                    version: source.info && source.info.version,
                })),
            };
        if (inpxFilter && inpxFilter.info) {
            if (inpxFilter.info.collection)
                inpxInfo.collection = inpxFilter.info.collection;
            if (inpxFilter.info.version)
                inpxInfo.version = inpxFilter.info.version;
        }

        await db.insert({table: 'config', rows: [
            {id: 'inpxInfo', value: inpxInfo},
            {id: 'stats', value: stats},
            {id: 'inpxHash', value: sourceHash},
            {id: 'dbVersion', value: config.dbVersion},
            {id: 'indexUpdate', value: {incremental, recordsChanged, recordsRemoved, updatedAt: new Date().toISOString()}},
            ...(rustLookupBuiltAt ? [{id:'rustLookupBuiltAt', value:rustLookupBuiltAt}] : []),
            ...(rustBookStoreGeneration ? [{id:'rustBookStoreGeneration',value:rustBookStoreGeneration}] : []),
        ]});

        callback({job:'done', jobMessage:'', reusedUidIndex:keepUidIndex});
    }

    async optimizeTable(from, db, callback) {
        const config = this.config;

        const to = `${from}_book`;

        await db.open({table: from});
        await db.create({table: to});

        let bookId2RecId = new Map();

        const saveChunk = async(chunk) => {
            const ids = [];
            for (const rec of chunk) {
                for (const id of rec.bookIds) {
                    let b2r = bookId2RecId.get(id);
                    if (!b2r) {
                        b2r = [];
                        bookId2RecId.set(id, b2r);
                    }
                    b2r.push(rec.id);

                    ids.push(id);
                }
            }

            if (config.fullOptimization) {
                ids.sort((a, b) => a - b);// обязательно, иначе будет тормозить - особенности JembaDb

                const rows = await db.select({table: 'book', where: `@@id(${db.esc(ids)})`});

                const bookArr = new Map();
                for (const row of rows)
                    bookArr.set(row.id, row);

                for (const rec of chunk) {
                    rec.books = [];

                    for (const id of rec.bookIds) {
                        const book = bookArr.get(id);
                        if (book) {//на всякий случай
                            rec.books.push(book);
                        }
                    }

                    delete rec.name;
                    delete rec.value;
                    delete rec.bookIds;
                }

                await db.insert({
                    table: to,
                    rows: chunk,
                });
            }
        };

        const rows = await db.select({table: from, count: true});
        const fromLength = rows[0].count;

        let processed = 0;
        while (1) {// eslint-disable-line
            const chunk = await db.select({
                table: from,
                where: `
                    let iter = @getItem('optimize');
                    if (!iter) {
                        iter = @all();
                        @setItem('optimize', iter);
                    }

                    const ids = new Set();
                    let bookIdsLen = 0;
                    let id = iter.next();
                    while (!id.done) {
                        ids.add(id.value);

                        const row = @row(id.value);
                        bookIdsLen += row.bookIds.length;
                        if (bookIdsLen >= 50000)
                            break;

                        id = iter.next();
                    }

                    return ids;
                `
            });

            if (chunk.length) {
                await saveChunk(chunk);

                processed += chunk.length;
                callback({progress: 0.9*processed/fromLength});
            } else
                break;

            if (this.config.lowMemoryMode) {
                await utils.sleep(10);
                utils.freeMemory();
                await db.freeMemory();
            }
        }

        await db.close({table: to});
        await db.close({table: from});

        const idMap = {arr: [], map: []};
        for (const [id, value] of bookId2RecId) {
            if (value.length > 1) {
                idMap.map.push([id, value]);
                idMap.arr[id] = 0;
            } else {
                idMap.arr[id] = value[0];
            }
        }

        callback({progress: 1});
        await fs.writeFile(`${this.config.indexDbPath || `${this.config.dataDir}/db`}/${from}_id.map`, JSON.stringify(idMap));

        bookId2RecId = null;
        utils.freeMemory();
    }

    async countStats(db, callback, stats, fileCounts, uidIndexExists = false) {
        let percent = 0;
        const timer = setInterval(() => {
            percent = Math.min(95, percent + 5);
            callback({progress: percent / 100});
        }, 1000);
        try {
            if (!fileCounts) {
                const [result] = await db.select({table:'book', rawResult:true, where:`
                    const count = (${fileStatistics.toString()})();
                    for (const id of @all()) count.add(@unsafeRow(id));
                    return count.totals();
                `});
                fileCounts = result?.rawResult;
            }
            if (fileCounts) {
                stats.filesCount = fileCounts.filesCount;
                stats.filesCountAll = fileCounts.filesCount + fileCounts.filesDelCount;
                stats.filesDelCount = fileCounts.filesDelCount;
            }

            if (!uidIndexExists) await db.create({
                in: 'book',
                hash: {field: '_uid', type: 'string', depth: 100, unique: true},
            });
            callback({progress: 1});
        } finally {
            clearInterval(timer);
        }
    }
}

module.exports = DbCreator;
