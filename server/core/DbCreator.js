const fs = require('fs-extra');

const InpxParser = require('./InpxParser');
const InpxHashCreator = require('./InpxHashCreator');
const {getEnabledLibrarySources} = require('./LibrarySources');
const utils = require('./utils');

const emptyFieldValue = '?';

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
        return require('crypto').createHash('sha256').update('inpx-physical-v1:' + JSON.stringify(identity)).digest('base64');
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
    async run(db, callback) {
        const scratch = this.config.installMode === 'android'
            ? await require('./DiskIndexScratch').open(this.config.indexDbPath) : null;
        try {return await this.build(db, callback, scratch);}
        finally {if (scratch) await scratch.close();}
    }

    async build(db, callback, scratch) {
        const config = this.config;
        const inpxHashCreator = new InpxHashCreator(config);
        callback({jobStepCount: 10, job: 'hash inpx', jobMessage: 'Проверка версии INPX', jobStep: 1, progress: null});
        const sourceHash = await inpxHashCreator.getHash();
        callback({job: 'load inpx', jobMessage: 'Загрузка INPX', jobStep: 1, progress: 0});

        //временная таблица
        const incremental = await db.tableExists({table: 'book'});
        if (!incremental) await db.create({table: 'book', cacheSize: (config.lowMemoryMode ? 5 : 500)});
        else await db.open({table: 'book'});
        if (incremental && (await db.getDbInfo({table: 'book'})).book.hash.some(hash => hash.field === '_uid'))
            await db.drop({in: 'book', hash: {field: '_uid'}});
        const previous = new Map(), physical = new Map(), legacy = new Map();
        let lastBookId = 0;
        let hasPrevious = false;
        const rememberPrevious = rows => {
            hasPrevious ||= rows.length > 0;
            if (scratch) {
                scratch.remember(rows);
                for (const row of rows) lastBookId = Math.max(lastBookId, row.id);
                return;
            }
            for (const row of rows) {
                previous.set(row.uid,row); lastBookId = Math.max(lastBookId,row.id);
                if (row.identity && row.legacyUid) {
                    const key = `${row.identity}:${row.legacyUid}`;
                    legacy.set(key,legacy.has(key) ? null : row);
                }
                if (row.identity) physical.set(row.identity,physical.has(row.identity) ? null : row);
            }
        };
        if (incremental) {
            await this.previousIdentities(db,rememberPrevious);
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
        const inpxFilter = await this.loadInpxFilter();
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
            if (readState.totalFiles) totalFiles = readState.totalFiles;
            callback(Object.assign({
                sourceId: currentSource.id,
                sourceName: currentSource.name,
                progress: totalFiles ? Math.max(0, (readState.current || 0) - 1) / totalFiles : 0,
            }, readState));
        };

        const parseField = (kind, fieldValue, fieldMap, fieldArr, bookId, rec, fillBookIds = true) => {
            if (scratch) {scratch.add(kind, fieldValue, bookId, rec, !fillBookIds); return;}
            let value = fieldValue;

            if (typeof(fieldValue) == 'string') {
                if (!fieldValue)
                    fieldValue = emptyFieldValue;

                value = fieldValue.toLowerCase();
            }

            let fieldRec;
            if (fieldMap.has(value)) {
                const fieldId = fieldMap.get(value);
                fieldRec = fieldArr[fieldId];
            } else {
                fieldRec = {id: fieldArr.length, value, bookIds: new Set()};                
                if (rec !== undefined) {
                    fieldRec.name = fieldValue;
                    fieldRec.bookCount = 0;
                    fieldRec.bookDelCount = 0;
                }
                fieldArr.push(fieldRec);
                fieldMap.set(value, fieldRec.id);
            }

            if (fieldValue !== emptyFieldValue || fillBookIds)
                fieldRec.bookIds.add(bookId);

            if (rec !== undefined) {
                if (!rec.del)
                    fieldRec.bookCount++;
                else
                    fieldRec.bookDelCount++;
            }
        };        

        const parseBookRec = (rec) => {
            parseField('source', rec.sourceId, sourceMap, sourceArr, rec.id);
            for (const field of ['title', 'author', 'series']) {
                for (const word of new Set(require('../../shared/CatalogSearch').words(rec[field]).map(require('../../shared/CatalogSearch').root)))
                    parseField('word', `${field}:${word}`, wordMap, wordArr, rec.id);
            }
            //авторы
            const author = splitAuthor(rec.author);

            for (let i = 0; i < author.length; i++) {
                const a = author[i];

                //статистика
                if (!(scratch ? scratch.hasAuthor(a.toLowerCase()) : authorMap.has(a.toLowerCase()))
                    && (author.length == 1 || i < author.length - 1)) //без соавторов
                    authorCount++;
                
                parseField('author', a, authorMap, authorArr, rec.id, rec);
            }

            //серии
            parseField('series', rec.series, seriesMap, seriesArr, rec.id, rec, false);

            //названия
            parseField('title', rec.title, titleMap, titleArr, rec.id, rec);

            //жанры
            let genre = rec.genre || emptyFieldValue;
            genre = rec.genre.split(',');

            for (let g of genre) {
                parseField('genre', g, genreMap, genreArr, rec.id);
            }

            //языки
            parseField('lang', rec.lang, langMap, langArr, rec.id);
            
            //удаленные
            parseField('del', rec.del, delMap, delArr, rec.id);

            //дата поступления
            parseField('date', rec.date, dateMap, dateArr, rec.id);

            //оценка
            parseField('librate', rec.librate, librateMap, librateArr, rec.id);

            //тип файла
            parseField('ext', rec.ext, extMap, extArr, rec.id);
        };

        //основная процедура парсинга
        let id = lastBookId;
        const seen = uid => scratch ? scratch.seen(uid) : uidSet.has(uid);
        const findByUid = uid => scratch && hasPrevious ? scratch.findByUid(uid) : previous.get(uid);
        const knowsPhysical = identity => scratch && hasPrevious ? scratch.knowsPhysical(identity) : physical.has(identity);
        const parsedCallback = async(chunk) => {
            const saveChunk = [];
            for (const rec of chunk) {
                rec.sourceId = currentSource.id;
                rec.sourceName = currentSource.name;
                rec.sourceLibDir = currentSource.libDir;

                const identity = currentSource.type === 'folder' ? '' : this.physicalIdentity(rec);
                const parsedUid = rec._uid;
                if (identity) rec._legacyUid = parsedUid;
                const uidPrior = findByUid(parsedUid);
                // An identical INPX line can refer to different archives.
                let prior = uidPrior;
                if (hasPrevious && identity && uidPrior?.identity !== identity)
                    prior = scratch ? scratch.matchArchive(identity, parsedUid)
                        : legacy.get(`${identity}:${parsedUid}`) || physical.get(identity);
                if (prior && !seen(prior.uid)) rec._uid = prior.uid;
                else {
                    prior = null;
                    if (identity && !knowsPhysical(identity) && !seen(identity) && !findByUid(identity)) {
                        rec._uid = identity;
                    } else if (identity && uidPrior && uidPrior.identity !== identity) {
                        rec._uid = require('crypto').createHash('sha256').update(`inpx-record-v1:${identity}:${parsedUid}`).digest('base64');
                        const variant = findByUid(rec._uid);
                        if (variant && variant.identity === identity) prior = variant;
                    }
                }
                if (!filter(rec)) continue;
                if (scratch) {
                    if (!scratch.mark(rec._uid, prior)) continue;
                    scratch.file(rec);
                } else {
                    if (uidSet.has(rec._uid)) continue;
                    uidSet.add(rec._uid);
                    if (prior) prior.retained = true;
                }
                rec._recordHash = require('crypto').createHash('sha256').update(JSON.stringify(rec)).digest('hex');
                rec.id = prior ? prior.id : ++id;

                if (!rec.del) {
                    bookCount++;
                    if (!rec.author)
                        noAuthorBookCount++;
                } else {
                    bookDelCount++;
                }

                parseBookRec(rec);
                const old = incremental && findByUid(rec._uid);
                if (!old || old.id !== rec.id || old.hash !== rec._recordHash) saveChunk.push(rec);
            }
            if (saveChunk.length) await db.insert({table: 'book', rows: saveChunk, replace: true});
            recordsChanged += saveChunk.length;
            callback({recordsChanged, incremental});

            recsLoaded += chunk.length;
            callback({recsLoaded});

            if (chunkNum++ % 10 == 0 && config.lowMemoryMode)
                utils.freeMemory();
        };

        //парсинг
        const parserInfos = [];
        const loadSources = async() => {
            for (const source of librarySources) {
                currentSource = source;
                totalFiles = 0;
                callback({
                    job: 'load inpx',
                    jobMessage: 'Чтение INPX',
                    jobStep: 1,
                    progress: 0,
                    sourceId: source.id,
                    sourceName: source.name,
                    fileName: '',
                });

                const parser = source.type === 'folder' ? new (require('./FolderIndexer').FolderIndexer)(source, config)
                    : new InpxParser(scratch ? 2000 : 10000);
                await parser.parse(source.inpxFile || source.inpx, readFileCallback, parsedCallback);
                callback({progress: 1});
                parserInfos.push({
                    id: source.id,
                    name: source.name,
                    inpx: source.inpxFile || source.inpx,
                    libDir: source.libDir,
                    info: parser.info,
                });
            }
            if (scratch)
                callback({job: 'commit inpx', jobMessage: 'Запись прочитанных книг', jobStep: 2, progress: null});
        };
        if (scratch) await scratch.load(loadSources);
        else await loadSources();

        let recordsRemoved = 0;
        if (incremental) {
            const removed = scratch ? scratch.removed() : (function*() {
                for (const row of previous.values()) if (!row.retained) yield row.id;
            })();
            let batch = [];
            const remove = async() => {
                if (!batch.length) return;
                await db.delete({table: 'book', where: `@@id(${db.esc(batch)})`});
                recordsRemoved += batch.length; batch = [];
            };
            for (const bookId of removed) {
                batch.push(bookId);
                if (batch.length === 10000) await remove();
            }
            await remove();
        }
        const maxBookId = id;

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
        physical.clear(); previous.clear(); legacy.clear();

        uidSet = null;

        if (scratch) callback({jobMessage: 'Закрытие таблицы книг'});
        await db.close({table: 'book'});
        await db.freeMemory();
        utils.freeMemory();

        //отсортируем таблицы выдадим им правильные id
        //порядок id соответствует ASC-сортировке по value
        callback({job: 'sort', jobMessage: 'Сортировка', jobStep: 2, progress: 0});
        await utils.sleep(100);
        //сортировка авторов
        authorArr.sort((a, b) => a.value.localeCompare(b.value));
        callback({progress: 0.2});
        await utils.sleep(100);

        id = 0;
        for (const authorRec of authorArr) {
            authorRec.id = ++id;
        }
        callback({progress: 0.3});
        await utils.sleep(100);

        //сортировка серий
        seriesArr.sort((a, b) => a.value.localeCompare(b.value));
        callback({progress: 0.5});
        await utils.sleep(100);

        id = 0;
        for (const seriesRec of seriesArr) {
            seriesRec.id = ++id;
        }
        callback({progress: 0.6});
        await utils.sleep(100);

        //сортировка названий
        titleArr.sort((a, b) => a.value.localeCompare(b.value));
        callback({progress: 0.8});
        await utils.sleep(100);        
        id = 0;
        for (const titleRec of titleArr) {
            titleRec.id = ++id;
        }

        //stats
        if (scratch) callback({jobMessage: 'Подсчёт записей индекса', progress: null});
        const counts = scratch?.counts();
        const stats = {
            filesCount: 0,//вычислим позднее
            filesCountAll: 0,//вычислим позднее
            filesDelCount: 0,//вычислим позднее
            recsLoaded,
            authorCount,
            authorCountAll: counts?.author ?? authorArr.length,
            bookCount,
            bookCountAll: bookCount + bookDelCount,
            bookDelCount,
            noAuthorBookCount,
            titleCount: counts?.title ?? titleArr.length,
            seriesCount: counts?.series ?? seriesArr.length,
            genreCount: counts?.genre ?? genreArr.length,
            langCount: counts?.lang ?? langArr.length,
        };
        //console.log(stats);

        //сохраним поисковые таблицы
        const chunkSize = 10000;
        const otherTableLabels = {
            lang: 'языков', del: 'статуса записей', date: 'дат', librate: 'оценок',
            ext: 'форматов', source: 'источников', word: 'поисковых слов',
        };

        const saveTable = async(table, arr, nullArr, indexType = 'string', delEmpty = false) => {
            if (scratch) {
                const label = otherTableLabels[table];
                callback({tableRows: 0, progress: counts[table] ? 0 : null,
                    ...(label ? {jobMessage: `Сохранение индекса ${label}`} : {})});
            }
            
            if (indexType == 'string')
                arr.sort((a, b) => a.value.localeCompare(b.value));
            else
                arr.sort((a, b) => a.value - b.value);

            await db.create({
                table,
                index: {field: 'value', unique: true, type: indexType, depth: 1000000},
            });

            if (scratch) {
                let batch = [], weight = 0, saved = 0;
                const write = async() => {
                    if (!batch.length) return;
                    await db.insert({table, rows: batch});
                    saved += batch.length; batch = []; weight = 0;
                    callback({tableRows: saved, ...(counts[table] ? {progress: saved / counts[table]} : {})});
                };
                for (const row of scratch.rows(table)) {
                    batch.push(row);
                    weight += 1 + row.bookIds.length;
                    if (batch.length >= 1000 || weight >= 30000) await write();
                }
                await write();
            }

            //вставка в БД по кусочкам, экономим память
            for (let i = 0; i < arr.length; i += chunkSize) {
                const chunk = arr.slice(i, i + chunkSize);
                
                for (const rec of chunk)
                    rec.bookIds = Array.from(rec.bookIds);

                await db.insert({table, rows: chunk});

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
        wordMap = null;
        await saveTable('word', wordArr, () => {wordArr = null});

        //кэш-таблицы запросов
        await db.create({table: 'query_cache'});
        await db.create({table: 'query_time'});

        //кэш-таблица имен файлов и их хешей
        await db.create({table: 'file_hash'});

        //-- завершающие шаги --------------------------------
        await db.open({
            table: 'book',
            cacheSize: (config.lowMemoryMode ? 5 : 500),
        });

        callback({job: 'optimization', jobMessage: 'Оптимизация', jobStep: 8, progress: 0});
        await this.optimizeTable('author', db, (p) => {
            if (p.progress)
                p.progress = 0.3*p.progress;
            callback(p);
        }, scratch, maxBookId);
        await this.optimizeTable('series', db, (p) => {
            if (p.progress)
                p.progress = 0.3 + 0.2*p.progress;
            callback(p);
        }, scratch, maxBookId);
        await this.optimizeTable('title', db, (p) => {
            if (p.progress)
                p.progress = 0.5 + 0.5*p.progress;
            callback(p);
        }, scratch, maxBookId);

        callback({job: 'stats count', jobMessage: 'Подсчёт статистики', jobStep: 9, progress: null});
        await this.countStats(db, callback, stats, scratch);

        //чистка памяти, ибо жрет как не в себя
        await db.close({table: 'book'});
        await db.freeMemory();
        utils.freeMemory();

        //config сохраняем в самом конце, нет конфига - с базой что-то не так
        callback({job: 'finalizing', jobMessage: 'Проверка и сохранение индекса', jobStep: 10, progress: null});
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
            {id: 'indexUpdate', value: {incremental, recordsChanged, recordsRemoved, updatedAt: new Date().toISOString()}},
        ]});

        callback({job: 'done', jobMessage: 'Индекс сохранён', progress: 1});
    }

    async optimizeTable(from, db, callback, scratch, maxBookId) {
        const config = this.config;

        const to = `${from}_book`;

        await db.open({table: from});
        await db.create({table: to});

        let bookId2RecId = new Map();
        const compact = scratch && new Uint32Array(maxBookId + 1);

        const saveChunk = async(chunk) => {
            if (compact) {
                scratch.batch(() => {
                    for (const rec of chunk) for (const id of rec.bookIds)
                        scratch.rememberReverse(compact, id, rec.id);
                });
                return;
            }
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

        const mapPath = `${config.indexDbPath || `${config.dataDir}/db`}/${from}_id.map`;
        if (compact) {
            await scratch.saveReverse(mapPath, compact);
            callback({progress: 1});
            return;
        }
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
        await fs.writeFile(mapPath, JSON.stringify(idMap));

        bookId2RecId = null;
        utils.freeMemory();
    }

    async countStats(db, callback, stats, scratch) {
        if (scratch) {
            const {total, deleted} = scratch.fileCounts();
            Object.assign(stats, {filesCount: total - deleted, filesCountAll: total, filesDelCount: deleted});
            await db.create({in: 'book', hash: {field: '_uid', type: 'string', depth: 100, unique: true}});
            return;
        }
        let percent = 0;
        const timer = setInterval(() => {
            percent = Math.min(95, percent + 5);
            callback({progress: percent / 100});
        }, 1000);
        try {
            const countRes = await db.select({table: 'book', rawResult: true, where: `
                const files = new Set();
                const filesDel = new Set();

                for (const id of @all()) {
                    const r = @row(id);
                    const file = ${"`${r.folder}/${r.file}.${r.ext}`"};
                    if (!r.del) {
                        files.add(file);
                    } else {
                        filesDel.add(file);
                    }
                }

                for (const file of filesDel)
                    if (files.has(file))
                        filesDel.delete(file);

                return {filesCount: files.size, filesDelCount: filesDel.size};
            `});

            if (countRes.length) {
                const res = countRes[0].rawResult;
                stats.filesCount = res.filesCount;
                stats.filesCountAll = res.filesCount + res.filesDelCount;
                stats.filesDelCount = res.filesDelCount;
            }

            await db.create({
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
