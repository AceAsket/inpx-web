const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const _ = require('lodash');
const iconv = require('iconv-lite');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');

const ZipReader = require('./ZipReader');
const WorkerState = require('./WorkerState');//singleton
const { JembaDb, JembaDbThread } = require('jembadb');
const DbCreator = require('./DbCreator');
const DbSearcher = require('./DbSearcher');
const InpxHashCreator = require('./InpxHashCreator');
const RemoteLib = require('./RemoteLib');//singleton
const FileDownloader = require('./FileDownloader');
const ReadingListStore = require('./ReadingListStore');
const imageUtils = require('./ImageUtils');
const bookConverter = require('./BookConverter');

const asyncExit = new (require('./AsyncExit'))();
const log = new (require('./AppLogger'))().log;//singleton
const utils = require('./utils');
const genreTree = require('./genres');
const Fb2Helper = require('./fb2/Fb2Helper');

//server states
const ssNormal = 'normal';
const ssDbLoading = 'db_loading';
const ssDbCreating = 'db_creating';

const stateToText = {
    [ssNormal]: '',
    [ssDbLoading]: 'Р—Р°РіСЂСѓР·РєР° РїРѕРёСЃРєРѕРІРѕР№ Р±Р°Р·С‹',
    [ssDbCreating]: 'РЎРѕР·РґР°РЅРёРµ РїРѕРёСЃРєРѕРІРѕР№ Р±Р°Р·С‹',
};

const cleanDirInterval = 60*60*1000;//РєР°Р¶РґС‹Р№ С‡Р°СЃ
const checkReleaseInterval = 7*60*60*1000;//РєР°Р¶РґС‹Рµ 7 С‡Р°СЃРѕРІ
const discoveryCacheTtl = 15*60*1000;//15 minutes
const bookAssetVersion = 'fblibrary-assets-v1';
const bookInfoVersion = 'fb2-binaries-v6';

function normalizeVersionTag(value = '') {
    return String(value || '').trim().replace(/^v/i, '');
}

function parseReleaseVersion(value = '') {
    const normalized = normalizeVersionTag(value);
    const [mainPart, prePart = ''] = normalized.split('-', 2);
    const main = mainPart.split('.').map(part => parseInt(part || '0', 10) || 0);
    while (main.length < 3)
        main.push(0);

    let pre = null;
    if (prePart) {
        const match = prePart.match(/^([a-z]+)(?:[.\-]?(\d+))?$/i);
        if (match) {
            pre = {
                label: String(match[1] || '').toLowerCase(),
                num: parseInt(match[2] || '0', 10) || 0,
            };
        } else {
            pre = {
                label: prePart.toLowerCase(),
                num: 0,
            };
        }
    }

    return {main, pre};
}

function compareReleaseVersions(left = '', right = '') {
    const a = parseReleaseVersion(left);
    const b = parseReleaseVersion(right);

    for (let i = 0; i < 3; i++) {
        if (a.main[i] !== b.main[i])
            return (a.main[i] > b.main[i] ? 1 : -1);
    }

    if (!a.pre && !b.pre)
        return 0;
    if (!a.pre)
        return 1;
    if (!b.pre)
        return -1;

    if (a.pre.label !== b.pre.label)
        return a.pre.label.localeCompare(b.pre.label);

    if (a.pre.num !== b.pre.num)
        return (a.pre.num > b.pre.num ? 1 : -1);

    return 0;
}

function isRcReleaseTag(value = '') {
    return /-rc(?:[.\-]?\d+)?$/i.test(normalizeVersionTag(value));
}

function resolveReleaseChannel(config = {}) {
    const raw = String(config.updateChannel || '').trim().toLowerCase();
    if (raw === 'rc' || raw === 'stable')
        return raw;

    return (isRcReleaseTag(config.version) ? 'rc' : 'stable');
}

function decodeExternalText(value = '') {
    return _.unescape(String(value || ''))
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripExternalHtml(value = '') {
    return decodeExternalText(String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '));
}

function toAbsoluteExternalUrl(baseUrl = '', value = '') {
    const raw = String(value || '').trim();
    if (!raw)
        return '';

    try {
        return new URL(raw, baseUrl).toString();
    } catch (e) {
        return raw;
    }
}

function buildExternalFlagsByUrl(sourceUrl = '') {
    const normalized = String(sourceUrl || '').trim().toLowerCase();
    return {
        isNew: /\/showroom\/new\/|\/catalog\/new\/|\/novinki\/|\/new\/|[?&]new\b/.test(normalized),
        isBestseller: /\/popular\/|\/bestsellers?\/|best[_-]?seller|хиты|popular/.test(normalized),
    };
}

function dedupeExternalFeedItems(items = [], limit = 8) {
    const result = [];
    const seen = new Set();

    for (const item of items) {
        const title = decodeExternalText(item.title || '');
        const url = String(item.url || '').trim();
        if (!title || !url)
            continue;

        const key = `${title.toLowerCase()}|${url.toLowerCase()}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(Object.assign({}, item, {title}));
        if (result.length >= limit)
            break;
    }

    return result;
}

function buildReleaseCheckRequest(checkReleaseLink = '', channel = 'stable') {
    const baseLink = String(checkReleaseLink || '').trim();
    if (!baseLink)
        return null;

    if (channel === 'rc') {
        const rcLink = baseLink.replace(/\/latest\/?$/i, '');
        const separator = (rcLink.includes('?') ? '&' : '?');
        return {url: `${rcLink}${separator}per_page=20`};
    }

    return {url: baseLink};
}

function pickReleaseFromPayload(payload, channel = 'stable') {
    const list = (Array.isArray(payload) ? payload : [payload])
        .filter(item => item && item.tag_name && !item.draft);

    if (channel === 'rc') {
        return list
            .filter(item => item.prerelease || isRcReleaseTag(item.tag_name))
            .sort((a, b) => compareReleaseVersions(b.tag_name, a.tag_name))[0] || null;
    }

    return list
        .filter(item => !item.prerelease)
        .sort((a, b) => compareReleaseVersions(b.tag_name, a.tag_name))[0] || null;
}

function decodeHtmlBuffer(data) {
    let text = iconv.decode(data, 'utf8');
    if (text.includes('\uFFFD'))
        text = iconv.decode(data, 'win1251');

        return text;
}

function decodeArchiveText(data) {
    let text = iconv.decode(data, 'utf8');
    if (text.includes('\uFFFD'))
        text = iconv.decode(data, 'win1251');

    return text;
}

function stripHtml(html) {
    return (html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAuthorText(value) {
    return stripHtml(value)
        .toLowerCase()
        .replace(/С‘/g, 'Рµ')
        .replace(/[()[\]{}.,;:!?'"`В«В»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatTemplate(template, book = {}) {
    return String(template || '')
        .replace(/\$\{AUTHOR\}/g, book.author || '')
        .replace(/\$\{TITLE\}/g, book.title || '')
        .replace(/\$\{SERIES\}/g, book.series || '')
        .replace(/\$\{EXT\}/g, book.ext || '');
}

function convertedFileName(downFileName, format) {
    const ext = path.extname(downFileName);
    const base = (ext ? downFileName.slice(0, -ext.length) : downFileName);
    return `${base}.${format}`;
}

function buildAuthorVariants(author) {
    const result = new Set();
    const normalized = normalizeAuthorText(author);
    if (normalized)
        result.add(normalized);

    const parts = (author || '')
        .split(',')
        .map(part => normalizeAuthorText(part))
        .filter(Boolean);

    if (parts.length) {
        result.add(parts.join(' '));
        result.add(parts.join(', '));
    }

    if (parts.length > 1)
        result.add([...parts].reverse().join(' '));

    return Array.from(result)
        .filter(value => value.length >= 3)
        .sort((a, b) => b.length - a.length);
}

function normalizeDiscoveryText(value) {
    return stripHtml(value)
        .toLowerCase()
        .replace(/С‘/g, 'Рµ')
        .replace(/&[a-z0-9#]+;/gi, ' ')
        .replace(/[^a-zР°-СЏ0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractDiscoveryAuthorTokens(author = '') {
    return Array.from(new Set(
        normalizeDiscoveryText(author)
            .split(' ')
            .map(token => token.trim())
            .filter(token => token.length >= 3)
    ));
}

function getPrimaryDiscoveryAuthor(persons = []) {
    const list = (Array.isArray(persons) ? persons : [])
        .filter(person => person && String(person.role || '').toLowerCase() === 'author')
        .map(person => String(person.full_name || '').trim())
        .filter(Boolean);

    return (list.length ? list[0] : '');
}

function flibraryAuthorHash(author) {
    return crypto.createHash('md5')
        .update((author || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase().trim(), 'utf8')
        .digest('hex');
}

//singleton
let instance = null;

class WebWorker {
    constructor(config) {
        if (!instance) {
            this.config = config;
            this.workerState = new WorkerState();

            this.remoteLib = null;
            if (config.remoteLib) {
                this.remoteLib = new RemoteLib(config);
            }
            
            this.inpxHashCreator = new InpxHashCreator(config);
            this.readingListStore = new ReadingListStore(config);
            this.fb2Helper = new Fb2Helper();
            this.profileSessions = new Map();
            this.inpxFileHash = '';
            this.authorInfoCache = new Map();
            this.discoveryCache = new Map();
            this.authorInfoArchives = null;
            this.authorPictureArchives = null;
            this.authorToArchive = null;
            this.reviewArchives = null;
            this.reviewToArchives = null;

            this.wState = this.workerState.getControl('server_state');
            this.myState = '';
            this.db = null;
            this.dbSearcher = null;

            asyncExit.add(this.closeDb.bind(this));

            this.loadOrCreateDb();//no await
            this.periodicLogServerStats();//no await

            const dirConfig = [
                {
                    dir: config.bookDir,
                    maxSize: config.maxFilesDirSize,
                },
            ];

            this.periodicCleanDir(dirConfig);//no await
            this.periodicCheckInpx();//no await
            this.periodicCheckNewRelease();//no await

            instance = this;
        }

        return instance;
    }

    checkMyState() {
        if (this.myState != ssNormal)
            throw new Error('server_busy');
    }

    setMyState(newState, workerState = {}) {
        this.myState = newState;
        this.wState.set(Object.assign({}, workerState, {
            state: newState,
            serverMessage: stateToText[newState]
        }));
    }

    async closeDb() {
        if (this.db) {
            await this.db.unlock();
            this.db = null;
        }
    }

    async createDb(dbPath) {
        this.setMyState(ssDbCreating);
        log('Searcher DB create start');

        const config = this.config;

        if (await fs.pathExists(dbPath))
            throw new Error(`createDb.pathExists: ${dbPath}`);

        const db = new JembaDbThread();
        await db.lock({
            dbPath,
            create: true,
            softLock: true,

            tableDefaults: {
                cacheSize: config.dbCacheSize,
            },
        });

        try {
            const dbCreator = new DbCreator(config);        

            await dbCreator.run(db, (state) => {
                this.setMyState(ssDbCreating, state);

                if (state.fileName)
                    log(`  load ${state.fileName}`);
                if (state.recsLoaded)
                    log(`  processed ${state.recsLoaded} records`);
                if (state.job)
                    log(`  ${state.job}`);
            });

            log('Searcher DB successfully created');
        } finally {
            await db.unlock();
        }
    }

    async loadOrCreateDb(recreate = false, iteration = 0) {
        this.setMyState(ssDbLoading);

        try {
            const config = this.config;
            const dbPath = `${config.dataDir}/db`;

            this.inpxFileHash = await this.inpxHashCreator.getInpxFileHash();

            //РїСЂРѕРІРµСЂРёРј РїРѕР»РЅС‹Р№ InxpHash (РІРєР»СЋС‡Р°СЏ С„РёР»СЊС‚СЂ Рё РІРµСЂСЃРёСЋ Р‘Р”)
            //РґР»СЏ СЌС‚РѕРіРѕ Р·Р°РіР»СЏРЅРµРј РІ РєРѕРЅС„РёРі РІРЅСѓС‚СЂРё Р‘Р”, РµСЃР»Рё РѕРЅ РµСЃС‚СЊ
            if (!(config.recreateDb || recreate) && await fs.pathExists(dbPath)) {
                const newInpxHash = await this.inpxHashCreator.getHash();

                const tmpDb = new JembaDb();
                await tmpDb.lock({dbPath, softLock: true});

                try {
                    await tmpDb.open({table: 'config'});
                    const rows = await tmpDb.select({table: 'config', where: `@@id('inpxHash')`});

                    if (!rows.length || newInpxHash !== rows[0].value)
                        throw new Error('inpx file: changes found on start, recreating DB');
                } catch (e) {
                    log(LM_WARN, e.message);
                    recreate = true;
                } finally {
                    await tmpDb.unlock();
                }
            }

            //СѓРґР°Р»РёРј Р‘Р” РµСЃР»Рё РЅСѓР¶РЅРѕ
            if (config.recreateDb || recreate)
                await fs.remove(dbPath);

            //РїРµСЂРµСЃРѕР·РґР°РµРј Р‘Р” РёР· INPX РµСЃР»Рё РЅСѓР¶РЅРѕ
            if (!await fs.pathExists(dbPath)) {
                await this.createDb(dbPath);
                utils.freeMemory();
            }

            //Р·Р°РіСЂСѓР¶Р°РµРј Р‘Р”
            this.setMyState(ssDbLoading);
            log('Searcher DB loading');

            const db = new JembaDbThread();//РІ РѕС‚РґРµР»СЊРЅРѕРј РїРѕС‚РѕРєРµ
            await db.lock({
                dbPath,
                softLock: true,

                tableDefaults: {
                    cacheSize: config.dbCacheSize,
                },
            });

            try {
                //РѕС‚РєСЂС‹РІР°РµРј С‚Р°Р±Р»РёС†С‹
                await db.openAll({exclude: ['author_id', 'series_id', 'title_id', 'book']});

                const bookCacheSize = 500;
                await db.open({
                    table: 'book',
                    cacheSize: (config.lowMemoryMode || config.dbCacheSize > bookCacheSize ? config.dbCacheSize : bookCacheSize)
                });
            } catch(e) {
                log(LM_ERR, `Database error: ${e.message}`);
                if (iteration < 1) {
                    log('Recreating DB');
                    await this.loadOrCreateDb(true, iteration + 1);
                } else
                    throw e;
                return;
            }

            //РїРѕРёСЃРєРѕРІС‹Р№ РґРІРёР¶РѕРє
            this.dbSearcher = new DbSearcher(config, db);
            await this.dbSearcher.init();

            //stuff
            db.wwCache = {};            
            this.db = db;

            this.setMyState(ssNormal);

            log('Searcher DB ready');
            this.logServerStats();
        } catch (e) {
            log(LM_FATAL, e.message);            
            asyncExit.exit(1);
        }
    }

    async recreateDb() {
        this.setMyState(ssDbCreating);

        if (this.dbSearcher) {
            await this.dbSearcher.close();
            this.dbSearcher = null;
        }

        await this.closeDb();

        await this.loadOrCreateDb(true);
    }

    async dbConfig() {
        this.checkMyState();

        const db = this.db;
        if (!db.wwCache.config) {
            const rows = await db.select({table: 'config'});
            const config = {};

            for (const row of rows) {
                config[row.id] = row.value;
            }

            db.wwCache.config = config;
        }

        return db.wwCache.config;
    }

    async search(from, query) {
        this.checkMyState();

        const result = await this.dbSearcher.search(from, query);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async bookSearch(query) {
        this.checkMyState();

        const result = await this.dbSearcher.bookSearch(query);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async opdsQuery(from, query) {
        this.checkMyState();

        return await this.dbSearcher.opdsQuery(from, query);
    }

    async getAuthorBookList(authorId, author) {
        this.checkMyState();

        return await this.dbSearcher.getAuthorBookList(authorId, author);
    }

    async getAuthorSeriesList(authorId) {
        this.checkMyState();

        return await this.dbSearcher.getAuthorSeriesList(authorId);
    }

    async getSeriesBookList(series) {
        this.checkMyState();

        return await this.dbSearcher.getSeriesBookList(series);
    }

    async getGenreTree() {
        this.checkMyState();

        const config = await this.dbConfig();

        let result;
        const db = this.db;
        if (!db.wwCache.genreTree) {
            const genres = _.cloneDeep(genreTree);
            const last = genres[genres.length - 1];

            const genreValues = new Set();
            for (const section of genres) {
                for (const g of section.value)
                    genreValues.add(g.value);
            }

            //РґРѕР±Р°РІРёРј Рє Р¶Р°РЅСЂР°Рј С‚Рµ, С‡С‚Рѕ РЅР°С€Р»РёСЃСЊ РїСЂРё РїР°СЂСЃРёРЅРіРµ
            const genreParsed = new Set();
            let rows = await db.select({table: 'genre', map: `(r) => ({value: r.value})`});
            for (const row of rows) {
                genreParsed.add(row.value);

                if (!genreValues.has(row.value))
                    last.value.push({name: row.value, value: row.value});
            }

            //СѓР±РµСЂРµРј С‚Рµ, РєРѕС‚РѕСЂС‹Рµ РЅРµ РЅР°С€Р»РёСЃСЊ РїСЂРё РїР°СЂСЃРёРЅРіРµ
            for (let j = 0; j < genres.length; j++) {
                const section = genres[j];
                for (let i = 0; i < section.value.length; i++) {
                    const g = section.value[i];
                    if (!genreParsed.has(g.value))
                        section.value.splice(i--, 1);
                }

                if (!section.value.length)
                    genres.splice(j--, 1);
            }

            // langs
            rows = await db.select({table: 'lang', map: `(r) => ({value: r.value})`});
            const langs = rows.map(r => r.value);            

            // exts
            rows = await db.select({table: 'ext', map: `(r) => ({value: r.value})`});
            const exts = rows.map(r => r.value);            

            result = {
                genreTree: genres,
                langList: langs,
                extList: exts,
                inpxHash: (config.inpxHash ? config.inpxHash : ''),
            };

            db.wwCache.genreTree = result;
        } else {
            result = db.wwCache.genreTree;
        }

        return result;
    }

    async getGenreMap() {
        this.checkMyState();

        let result;
        const db = this.db;
        if (!db.wwCache.genreMap) {
            const genreTree = await this.getGenreTree();

            result = new Map();
            for (const section of genreTree.genreTree) {
                for (const g of section.value)
                    result.set(g.value, g.name);
            }

            db.wwCache.genreMap = result;
        } else {
            result = db.wwCache.genreMap;
        }

        return result;
    }

    getDiscoveryConfig(options = {}) {
        const discovery = Object.assign({
            enabled: true,
            shelfLimit: 8,
            externalSource: 'none',
            externalLimit: 8,
            externalUrl: '',
            externalName: '',
            externalTtlMinutes: 1440,
        }, this.config.discovery || {}, options || {});

        discovery.enabled = (discovery.enabled !== false);
        discovery.shelfLimit = Math.max(1, Math.min(parseInt(discovery.shelfLimit, 10) || 8, 24));
        discovery.externalLimit = Math.max(1, Math.min(parseInt(discovery.externalLimit, 10) || discovery.shelfLimit, 24));
        discovery.externalSource = String(discovery.externalSource || 'none').trim().toLowerCase();
        if (discovery.externalSource && discovery.externalSource !== 'none')
            discovery.externalSource = 'web-page';
        discovery.externalUrl = String(discovery.externalUrl || '').trim();
        discovery.externalName = String(discovery.externalName || '').trim();
        discovery.externalTtlMinutes = Math.max(1440, Math.min(parseInt(discovery.externalTtlMinutes, 10) || 1440, 10080));

        return discovery;
    }

    async getDiscoveryConfigForRequest(options = {}) {
        const requestOptions = Object.assign({}, options || {});
        const hasExternalOverrides = (
            Object.prototype.hasOwnProperty.call(requestOptions, 'externalSource')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalName')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalUrl')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalLimit')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalTtlMinutes')
        );

        if (!hasExternalOverrides)
            return this.getDiscoveryConfig(requestOptions);

        try {
            await this.requireAdmin(requestOptions.userId, requestOptions.profileAccessToken);
        } catch (e) {
            delete requestOptions.externalSource;
            delete requestOptions.externalName;
            delete requestOptions.externalUrl;
            delete requestOptions.externalLimit;
            delete requestOptions.externalTtlMinutes;
        }

        return this.getDiscoveryConfig(requestOptions);
    }

    async rememberDiscovery(key, loader, ttl = discoveryCacheTtl) {
        const cached = this.discoveryCache.get(key);
        if (cached && Date.now() - cached.time < ttl)
            return _.cloneDeep(cached.value);

        const value = await loader();
        this.discoveryCache.set(key, {time: Date.now(), value: _.cloneDeep(value)});
        return value;
    }

    getDiscoveryAgeLabel(dateValue = '') {
        const time = Date.parse(String(dateValue || ''));
        if (!Number.isFinite(time))
            return '';

        const diffDays = Math.max(0, Math.floor((Date.now() - time) / 86400000));
        if (diffDays <= 0)
            return 'Р”РѕР±Р°РІР»РµРЅР° СЃРµРіРѕРґРЅСЏ';
        if (diffDays === 1)
            return 'Р”РѕР±Р°РІР»РµРЅР° 1 РґРµРЅСЊ РЅР°Р·Р°Рґ';
        if (diffDays < 5)
            return `Р”РѕР±Р°РІР»РµРЅР° ${diffDays} РґРЅСЏ РЅР°Р·Р°Рґ`;
        return `Р”РѕР±Р°РІР»РµРЅР° ${diffDays} РґРЅРµР№ РЅР°Р·Р°Рґ`;
    }

    getDiscoveryMatchLabel(kind = '') {
        switch (String(kind || '').trim()) {
            case 'exact':
                return '?????? ??????????';
            case 'title-author':
                return '?????????? ?? ???????? ? ??????';
            case 'title':
                return '?????????? ?? ????????';
            case 'title-partial':
                return '??????? ?????????? ?? ????????';
            case 'missing-local':
                return '??? ? ????????? ??????????';
            default:
                return '?????????? ? ??????? ????????';
        }
    }

    decorateDiscoveryBook(book = {}, options = {}) {
        const result = Object.assign({}, book);
        const reasons = [];
        const mode = String(options.mode || '').trim();
        const popularityInfo = (options.popularityInfo && typeof(options.popularityInfo) === 'object' ? options.popularityInfo : null);

        if (mode === 'newest') {
            const ageLabel = this.getDiscoveryAgeLabel(book.date);
            if (ageLabel)
                reasons.push(ageLabel);
        } else if (mode === 'popular') {
            if (popularityInfo) {
                if (popularityInfo.progressCount > 0)
                    reasons.push(`? ??????: ${popularityInfo.progressCount}`);
                if (popularityInfo.listCount > 0)
                    reasons.push(`? ???????: ${popularityInfo.listCount}`);
                if (popularityInfo.finishedCount > 0)
                    reasons.push(`?????????: ${popularityInfo.finishedCount}`);
            }
            if (book.librate)
                reasons.push(`?????? ?????????? ${book.librate}/5`);
        }

        if (options.discoverySource) {
            const matchLabel = this.getDiscoveryMatchLabel(options.matchKind);
            if (options.matchKind === 'missing-local')
                reasons.unshift(`${options.discoverySource} ? ${matchLabel}`);
            else
                reasons.unshift(`??????? ? ${options.discoverySource} ? ${matchLabel}`);
        }

        result.discoveryReason = reasons.join(' ? ');
        return result;
    }
    async getDiscoveryDiskCache() {
        if (this.discoveryDiskCache)
            return this.discoveryDiskCache;

        this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        let cache = {};
        try {
            if (await fs.pathExists(this.discoveryDiskCacheFile))
                cache = JSON.parse(await fs.readFile(this.discoveryDiskCacheFile, 'utf8')) || {};
        } catch(e) {
            cache = {};
        }

        this.discoveryDiskCache = cache;
        return cache;
    }

    async saveDiscoveryDiskCache() {
        if (!this.discoveryDiskCacheFile)
            this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        await fs.ensureDir(path.dirname(this.discoveryDiskCacheFile));
        await fs.writeFile(this.discoveryDiskCacheFile, JSON.stringify(this.discoveryDiskCache || {}, null, 2));
    }

    async rememberPersistedDiscovery(key, loader, ttl = discoveryCacheTtl) {
        const cached = this.discoveryCache.get(key);
        if (cached && Date.now() - cached.time < ttl)
            return _.cloneDeep(cached.value);

        const diskCache = await this.getDiscoveryDiskCache();
        const persisted = diskCache[key];
        if (persisted && Date.now() - persisted.time < ttl) {
            this.discoveryCache.set(key, {time: persisted.time, value: _.cloneDeep(persisted.value)});
            return _.cloneDeep(persisted.value);
        }

        try {
            const value = await loader();
            const time = Date.now();
            this.discoveryCache.set(key, {time, value: _.cloneDeep(value)});
            diskCache[key] = {time, value: _.cloneDeep(value)};
            await this.saveDiscoveryDiskCache();
            return value;
        } catch(e) {
            const fallback = cached || persisted;
            if (fallback) {
                const value = _.cloneDeep(fallback.value);
                if (value && typeof(value) === 'object') {
                    value.discoveryStale = true;
                    value.discoveryRefreshError = e.message;
                }
                return value;
            }
            throw e;
        }
    }

    async buildDiscoveryPopularityMap() {
        let data = null;
        try {
            data = await this.readingListStore.load();
        } catch(e) {
            return {};
        }

        const result = {};
        const addScore = (bookUid, patch = {}) => {
            const normalizedBookUid = this.readingListStore.normalizeBookUid(bookUid);
            if (!normalizedBookUid)
                return;

            if (!result[normalizedBookUid]) {
                result[normalizedBookUid] = {
                    score: 0,
                    progressCount: 0,
                    listCount: 0,
                    finishedCount: 0,
                };
            }

            const target = result[normalizedBookUid];
            target.score += Number(patch.score || 0);
            target.progressCount += Number(patch.progressCount || 0);
            target.listCount += Number(patch.listCount || 0);
            target.finishedCount += Number(patch.finishedCount || 0);
        };

        for (const user of (Array.isArray(data.users) ? data.users : [])) {
            const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {});
            for (const [bookUid, progress] of Object.entries(progressMap)) {
                const percent = Number(progress && progress.percent);
                let score = 8;
                if (percent >= 0.15)
                    score += 8;
                if (percent >= 0.5)
                    score += 12;
                if (percent >= 0.95)
                    score += 18;

                addScore(bookUid, {
                    score,
                    progressCount: 1,
                    finishedCount: (percent >= 0.95 ? 1 : 0),
                });
            }
        }

        for (const list of (Array.isArray(data.lists) ? data.lists : [])) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                addScore(entry.bookUid, {
                    score: (entry.read ? 14 : 6),
                    listCount: 1,
                    finishedCount: (entry.read ? 1 : 0),
                });
            }
        }

        return result;
    }

    async selectDiscoveryBooks(mode = 'newest', limit = 8, options = {}) {
        const db = this.db;
        const daysWindow = Math.max(0, parseInt(options.daysWindow, 10) || 0);
        const excludedBookUids = Array.isArray(options.excludedBookUids) ? options.excludedBookUids.filter(Boolean) : [];
        const popularityMap = (options.popularityMap && typeof(options.popularityMap) === 'object' ? options.popularityMap : {});
        const rows = await db.select({
            table: 'book',
            rawResult: true,
            where: `
                const mode = ${db.esc(mode)};
                const limit = ${db.esc(limit)};
                const daysWindow = ${db.esc(daysWindow)};
                const excludedBookUids = new Set(${db.esc(excludedBookUids)});
                const popularityMap = ${db.esc(popularityMap)};
                const dedupeKey = (row) => {
                    if (row.libid)
                        return 'libid:' + row.libid;

                    const parts = [
                        row.folder || '',
                        row.file || '',
                        row.ext || '',
                        String(row.insno || 0),
                    ];
                    if (parts.some(Boolean))
                        return 'file:' + parts.join('|');

                    return [
                        'meta',
                        row.author || '',
                        row.series || '',
                        String(row.serno || 0),
                        row.title || '',
                        String(row.size || 0),
                        row.ext || '',
                    ].join('|');
                };
                const rowQuality = (row) => {
                    let score = 0;
                    if (!row.del)
                        score += 1000;
                    if (row.ext === 'fb2')
                        score += 120;
                    else if (row.ext === 'epub')
                        score += 90;
                    else if (row.ext === 'mobi')
                        score += 70;
                    else if (row.ext === 'pdf')
                        score += 50;
                    if (row.librate)
                        score += row.librate * 10;
                    if (row.size)
                        score += Math.min(row.size, 50000000) / 1000000;
                    return score;
                };
                const pickBetterRow = (current, next) => {
                    const currentScore = rowQuality(current);
                    const nextScore = rowQuality(next);
                    if (nextScore !== currentScore)
                        return (nextScore > currentScore ? next : current);
                    return (next.id < current.id ? next : current);
                };

                const deduped = new Map();
                for (const id of @all()) {
                    const row = @unsafeRow(id);
                    if (!row || row.del || !row.title)
                        continue;
                    if (excludedBookUids.has(row._uid))
                        continue;
                    if (mode === 'popular' && !((row.librate > 0) || (((popularityMap[row._uid] || {}).score) > 0)))
                        continue;
                    if (mode === 'newest' && !row.date)
                        continue;
                    if (mode === 'newest' && daysWindow > 0) {
                        const age = Math.floor((Date.now() - Date.parse(row.date)) / 86400000);
                        if (!(age >= 0 && age <= daysWindow))
                            continue;
                    }

                    const key = dedupeKey(row);
                    const existing = deduped.get(key);
                    deduped.set(key, existing ? pickBetterRow(existing, row) : row);
                }

                const result = Array.from(deduped.values());
                result.sort((a, b) => {
                    if (mode === 'popular') {
                        const popularityCmp = (((popularityMap[b._uid] || {}).score) || 0) - (((popularityMap[a._uid] || {}).score) || 0);
                        if (popularityCmp)
                            return popularityCmp;
                        const rateCmp = (b.librate || 0) - (a.librate || 0);
                        if (rateCmp)
                            return rateCmp;
                        const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
                        if (dateCmp)
                            return dateCmp;
                    } else {
                        const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
                        if (dateCmp)
                            return dateCmp;
                        const rateCmp = (b.librate || 0) - (a.librate || 0);
                        if (rateCmp)
                            return rateCmp;
                    }

                    let cmp = (a.author || '').localeCompare(b.author || '', 'ru');
                    if (cmp === 0)
                        cmp = (a.title || '').localeCompare(b.title || '', 'ru');
                    if (cmp === 0)
                        cmp = a.id - b.id;
                    return cmp;
                });

                const filtered = [];
                const authorCounts = new Map();
                const seriesCounts = new Map();

                for (const row of result) {
                    const authorKey = String(row.author || '').trim().toLowerCase();
                    const seriesKey = String(row.series || '').trim().toLowerCase();
                    if (authorKey && (authorCounts.get(authorKey) || 0) >= 2)
                        continue;
                    if (seriesKey && (seriesCounts.get(seriesKey) || 0) >= 2)
                        continue;

                    filtered.push(row);
                    if (authorKey)
                        authorCounts.set(authorKey, (authorCounts.get(authorKey) || 0) + 1);
                    if (seriesKey)
                        seriesCounts.set(seriesKey, (seriesCounts.get(seriesKey) || 0) + 1);
                    if (filtered.length >= limit)
                        break;
                }

                return filtered;
            `
        });

        return ((rows[0] && rows[0].rawResult) ? rows[0].rawResult : []);
    }

    async buildLocalDiscoveryShelf(kind = 'newest', limit = 8, options = {}) {
        const shelfConfig = {
            newest: {
                id: `newest-${options.daysWindow || 0}d`,
                title: 'РќРѕРІРёРЅРєРё Р±РёР±Р»РёРѕС‚РµРєРё',
                subtitle: 'РџРѕСЃР»РµРґРЅРёРµ РїРѕСЃС‚СѓРїР»РµРЅРёСЏ РІ РёРЅРґРµРєСЃ',
                mode: 'newest',
            },
            popular: {
                id: 'popular',
                title: 'РџРѕРїСѓР»СЏСЂРЅРѕРµ РІ Р±РёР±Р»РёРѕС‚РµРєРµ',
                subtitle: 'РџРёР»РѕС‚ РїРѕ Р»РѕРєР°Р»СЊРЅРѕР№ РѕС†РµРЅРєРµ Р±РёР±Р»РёРѕС‚РµРєРё',
                mode: 'popular',
            },
        }[kind];

        if (!shelfConfig)
            return null;

        const items = await this.selectDiscoveryBooks(shelfConfig.mode, limit);
        if (!items.length)
            return null;

        return {
            id: shelfConfig.id,
            title: shelfConfig.title,
            subtitle: shelfConfig.subtitle,
            source: 'local',
            items,
        };
    }

    parseExternalFeedItemsFromNextData(html = '', sourceUrl = '', limit = 8) {
        const nextDataMatch = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
        if (!nextDataMatch)
            return [];

        let nextData = null;
        try {
            nextData = JSON.parse(nextDataMatch[1]);
        } catch (e) {
            return [];
        }

        let initialState = ((((nextData || {}).props || {}).pageProps || {}).initialState || {});
        if (typeof initialState === 'string') {
            try {
                initialState = JSON.parse(initialState || '{}');
            } catch (e) {
                initialState = {};
            }
        }

        const queries = (((initialState || {}).rtkqApi || {}).queries || {});
        const candidates = [];
        const collectRows = (value, result = []) => {
            if (!value)
                return result;

            if (Array.isArray(value)) {
                if (value.some(item => item && typeof item === 'object' && (item.title || item.name) && (item.url || item.link)))
                    result.push(value);

                for (const item of value) {
                    if (item && typeof item === 'object')
                        collectRows(item, result);
                }

                return result;
            }

            if (typeof value === 'object') {
                for (const nestedValue of Object.values(value))
                    collectRows(nestedValue, result);
            }

            return result;
        };

        for (const query of Object.values(queries)) {
            const rowGroups = collectRows((query || {}).data || {});
            for (const rows of rowGroups) {
                for (const item of rows) {
                    if (!item || (!item.title && !item.name) || (!item.url && !item.link))
                        continue;

                    const authors = Array.isArray(item.authors)
                        ? item.authors
                            .map(author => decodeExternalText(author && typeof author === 'object' ? author.name : author))
                            .filter(Boolean)
                        : [];

                    const cover = item.cover_url
                        || (((item.cover || {}).large) || ((item.cover || {}).small))
                        || (((item.picture || {}).large) || ((item.picture || {}).small))
                        || (((item.image || {}).large) || ((item.image || {}).small))
                        || item.image
                        || '';

                    candidates.push({
                        title: decodeExternalText(item.title || item.name),
                        author: decodeExternalText(authors.join(', ') || getPrimaryDiscoveryAuthor(item.persons)),
                        url: toAbsoluteExternalUrl(sourceUrl, item.url || item.link),
                        cover: toAbsoluteExternalUrl(sourceUrl, cover),
                        rating: (((item.rating || {}).rated_avg) || item.rating || 0),
                        isBestseller: !!(
                            ((item.labels || {}).is_bestseller)
                            || ((item.labels || {}).is_sales_hit)
                            || ((item.specialTypes || {}).best)
                            || ((item.specialTypes || {}).bestseller)
                        ),
                        isNew: !!(
                            ((item.labels || {}).is_new)
                            || ((item.specialTypes || {}).new)
                            || ((item.specialTypes || {}).soon)
                        ),
                    });
                }
            }
        }

        return dedupeExternalFeedItems(candidates, Math.max(limit * 3, limit));
    }

    parseLitresFeedItemsFromHtml(html = '', sourceUrl = '', limit = 8) {
        const coverByUrl = new Map();
        const bookPathByUrl = new Map();
        const flags = buildExternalFlagsByUrl(sourceUrl);
        const normalizedHtml = String(html || '');

        for (const match of normalizedHtml.matchAll(/<a[^>]+href="((?:\/|https:\/\/www\.litres\.ru\/)book\/[^"]+\/?)"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*>/gi)) {
            const bookUrl = toAbsoluteExternalUrl(sourceUrl, match[1]);
            const coverUrl = toAbsoluteExternalUrl(sourceUrl, match[2]);
            if (bookUrl && coverUrl && !coverByUrl.has(bookUrl))
                coverByUrl.set(bookUrl, coverUrl);
        }

        const items = [];
        let lastBook = null;

        for (const match of normalizedHtml.matchAll(/<a[^>]+href="((?:\/|https:\/\/www\.litres\.ru\/)(?:book|author)\/[^"]+\/?)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const href = toAbsoluteExternalUrl(sourceUrl, match[1]);
            const text = stripExternalHtml(match[2]);
            if (!href)
                continue;

            if (/\/book\//i.test(href)) {
                if (!text)
                    continue;

                const item = {
                    title: text,
                    author: '',
                    url: href,
                    cover: (coverByUrl.get(href) || ''),
                    rating: 0,
                    isBestseller: flags.isBestseller,
                    isNew: flags.isNew,
                };

                items.push(item);
                lastBook = item;
                bookPathByUrl.set(href, item);
                if (items.length >= Math.max(limit * 3, limit))
                    break;
                continue;
            }

            if (/\/author\//i.test(href) && lastBook && !lastBook.author && text)
                lastBook.author = text;
        }

        return dedupeExternalFeedItems(items, Math.max(limit * 3, limit));
    }

    parseJsonLdProductFeedItems(html = '', sourceUrl = '', limit = 8) {
        const items = [];
        const flags = buildExternalFlagsByUrl(sourceUrl);
        const scriptMatches = String(html || '').matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);

        for (const match of scriptMatches) {
            const raw = String(match[1] || '').trim();
            if (!raw)
                continue;

            let data = null;
            try {
                data = JSON.parse(raw);
            } catch (e) {
                continue;
            }

            const queue = (Array.isArray(data) ? [...data] : [data]);
            while (queue.length) {
                const node = queue.shift();
                if (!node || typeof node !== 'object')
                    continue;

                const type = String(node['@type'] || '').trim();
                if (type === 'Product') {
                    const title = decodeExternalText(node.name || ((node.offers || {}).name) || '');
                    const url = toAbsoluteExternalUrl(sourceUrl, ((node.offers || {}).url) || node.url || '');
                    const image = Array.isArray(node.image) ? node.image[0] : node.image;
                    if (title && url) {
                        items.push({
                            title,
                            author: decodeExternalText(((node.author || {}).name) || node.author || ''),
                            url,
                            cover: toAbsoluteExternalUrl(sourceUrl, image || ((node.offers || {}).image) || ''),
                            rating: 0,
                            isBestseller: flags.isBestseller,
                            isNew: flags.isNew,
                        });
                    }
                }

                for (const value of Object.values(node)) {
                    if (Array.isArray(value))
                        queue.push(...value);
                    else if (value && typeof value === 'object')
                        queue.push(value);
                }
            }
        }

        return dedupeExternalFeedItems(items, Math.max(limit * 3, limit));
    }

    parseMifFeedItemsFromHtml(html = '', sourceUrl = '', limit = 8) {
        const items = [];
        const flags = buildExternalFlagsByUrl(sourceUrl);
        const normalizedHtml = String(html || '');

        for (const match of normalizedHtml.matchAll(/<div[^>]+class="[^"]*lego-book[^"]*"[\s\S]{0,5000}?<a href="([^"]*\/catalog\/product\/[^"]+)"[^>]*>[\s\S]{0,2500}?<(?:img|source)[^>]+(?:data-original|src)="([^"]+)"[\s\S]{0,2500}?<div class="lego-book__cover-loading-title">([\s\S]{0,400}?)<\/div>/gi)) {
            const titleBlock = match[3] || '';
            const titleParts = Array.from(titleBlock.matchAll(/<p>([\s\S]*?)<\/p>/gi))
                .map(item => stripExternalHtml(item[1]))
                .filter(Boolean);

            const title = decodeExternalText(titleParts[0] || '');
            const author = decodeExternalText(titleParts[1] || '');
            const url = toAbsoluteExternalUrl(sourceUrl, match[1]);
            const cover = toAbsoluteExternalUrl(sourceUrl, match[2]);
            if (!title || !url)
                continue;

            items.push({
                title,
                author,
                url,
                cover,
                rating: 0,
                isBestseller: flags.isBestseller,
                isNew: flags.isNew || /РќРѕРІРёРЅРєР°/.test(titleBlock),
            });

            if (items.length >= Math.max(limit * 3, limit))
                break;
        }

        return dedupeExternalFeedItems(items, Math.max(limit * 3, limit));
    }

    parseAlpinaFeedItemsFromHtml(html = '', sourceUrl = '', limit = 8) {
        const items = [];
        const flags = buildExternalFlagsByUrl(sourceUrl);
        const normalizedHtml = String(html || '');

        for (const match of normalizedHtml.matchAll(/data-book-name="([^"]+)"[\s\S]{0,4000}?<a href="([^"]*\/catalog\/book-[^"]+\/)"[\s\S]{0,2500}?<(?:img|source)[^>]+(?:data-src|src)="([^"]+)"[\s\S]{0,2500}?<div class="book-item-authors[\s\S]{0,2000}?<\/div>/gi)) {
            const block = match[0];
            const title = decodeExternalText(match[1]);
            const url = toAbsoluteExternalUrl(sourceUrl, match[2]);
            const cover = toAbsoluteExternalUrl(sourceUrl, match[3]);
            const authors = [];

            for (const authorMatch of block.matchAll(/book-item-authors__item[\s\S]{0,300}?<span[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/gi)) {
                const author = stripExternalHtml(authorMatch[1]);
                if (author)
                    authors.push(author);
            }

            if (!title || !url)
                continue;

            items.push({
                title,
                author: authors.join(', '),
                url,
                cover,
                rating: 0,
                isBestseller: flags.isBestseller || /book-item-labels__item[^>]*>[\s\S]*?Бестселлер/i.test(block),
                isNew: flags.isNew || /book-item-labels__item[^>]*>[\s\S]*?Новинка/i.test(block),
            });

            if (items.length >= Math.max(limit * 3, limit))
                break;
        }

        return dedupeExternalFeedItems(items, Math.max(limit * 3, limit));
    }

    async fetchExternalFeedItems(limit = 8, url = '') {
        const sourceUrl = String(url || '').trim();
        if (!sourceUrl)
            throw new Error('РќРµ Р·Р°РґР°РЅ URL РІРЅРµС€РЅРµР№ РІРёС‚СЂРёРЅС‹');

        const response = await axios.get(sourceUrl, {
            responseType: 'text',
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
            },
        });

        const html = String(response.data || '');
        const maxItems = Math.max(limit * 3, limit);
        const host = (() => {
            try {
                return new URL(sourceUrl).hostname.toLowerCase();
            } catch (e) {
                return '';
            }
        })();

        const parserChain = [
            () => this.parseExternalFeedItemsFromNextData(html, sourceUrl, limit),
        ];

        if (host.includes('litres.ru'))
            parserChain.push(() => this.parseLitresFeedItemsFromHtml(html, sourceUrl, limit));
        if (host.includes('mann-ivanov-ferber.ru'))
            parserChain.push(
                () => this.parseMifFeedItemsFromHtml(html, sourceUrl, limit),
                () => this.parseJsonLdProductFeedItems(html, sourceUrl, limit),
            );
        if (host.includes('alpinabook.ru'))
            parserChain.push(() => this.parseAlpinaFeedItemsFromHtml(html, sourceUrl, limit));

        parserChain.push(
            () => this.parseJsonLdProductFeedItems(html, sourceUrl, limit),
            () => this.parseMifFeedItemsFromHtml(html, sourceUrl, limit),
            () => this.parseLitresFeedItemsFromHtml(html, sourceUrl, limit),
            () => this.parseAlpinaFeedItemsFromHtml(html, sourceUrl, limit),
        );

        let items = [];
        for (const parseItems of parserChain) {
            items = dedupeExternalFeedItems(parseItems(), maxItems);
            if (items.length)
                break;
        }

        if (!items.length)
            throw new Error('Не удалось прочитать внешнюю витрину');

        return {sourceUrl, items};
    }

    pickDiscoveryBookMatch(item, books = []) {
        const title = normalizeDiscoveryText(item.title || '');
        if (!title)
            return null;

        const authorTokens = extractDiscoveryAuthorTokens(item.author || '');
        let best = null;
        let bestScore = -Infinity;

        for (const book of books) {
            const bookTitle = normalizeDiscoveryText(book.title || '');
            if (!bookTitle)
                continue;

            let score = -Infinity;
            if (bookTitle === title) {
                score = 1000;
            } else if (bookTitle.startsWith(title) || title.startsWith(bookTitle)) {
                score = 700;
            } else if (bookTitle.includes(title) || title.includes(bookTitle)) {
                score = 450;
            } else {
                continue;
            }

            const bookAuthor = normalizeDiscoveryText(book.author || '');
            let authorScore = 0;
            for (const token of authorTokens) {
                if (bookAuthor.includes(token))
                    authorScore += 90;
            }

            if (authorTokens.length && !authorScore)
                score -= 180;

            score += authorScore;
            if (!book.del)
                score += 15;
            if (String(book.ext || '').toLowerCase() === 'fb2')
                score += 12;
            score += parseInt(book.librate || '0', 10) || 0;

            if (score > bestScore) {
                bestScore = score;
                best = book;
            }
        }

        return (bestScore >= 450 ? best : null);
    }

    async matchExternalItemsToLocalBooks(items = [], limit = 8) {
        const result = [];
        const seenBookUids = new Set();

        for (const item of items) {
            let response = await this.dbSearcher.bookSearch({
                title: `=${item.title}`,
                limit: 16,
            });
            let match = this.pickDiscoveryBookMatch(item, response.found || []);

            if (!match) {
                response = await this.dbSearcher.bookSearch({
                    title: `*${String(item.title || '').substring(0, 80)}`,
                    limit: 24,
                });
                match = this.pickDiscoveryBookMatch(item, response.found || []);
            }

            if (match && !seenBookUids.has(match._uid)) {
                seenBookUids.add(match._uid);
                result.push(Object.assign({}, match, {
                    discoveryUrl: item.url,
                    discoveryRating: item.rating,
                    discoveryFlags: {
                        bestseller: !!item.isBestseller,
                        isNew: !!item.isNew,
                    },
                }));
            }

            if (result.length >= limit)
                break;

            await utils.processLoop();
        }

        return result;
    }

    async buildExternalDiscoveryShelf(limit = 8) {
        const discovery = this.getDiscoveryConfig();
        if (discovery.externalSource === 'none')
            return null;

        if (discovery.externalSource !== 'web-page')
            throw new Error(`РќРµРёР·РІРµСЃС‚РЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє РІРёС‚СЂРёРЅС‹: ${discovery.externalSource}`);

        const feed = await this.fetchExternalFeedItems(discovery.externalLimit, discovery.externalUrl);
        const items = await this.matchExternalItemsToLocalBooks(feed.items || [], limit);
        const sourceName = (discovery.externalName || 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє');

        return {
            id: 'external-source',
            title: sourceName,
            subtitle: `РЎРѕРІРїР°РґРµРЅРёР№ ${items.length} РёР· ${feed.items.length}`,
            source: 'external',
            sourceName,
            sourceUrl: feed.sourceUrl,
            items,
            emptyMessage: 'РЎРѕРІРїР°РґРµРЅРёР№ СЃ Р»РѕРєР°Р»СЊРЅРѕР№ Р±РёР±Р»РёРѕС‚РµРєРѕР№ РїРѕРєР° РЅРµ РЅР°С€Р»РѕСЃСЊ.',
        };
    }

    async getDiscoveryShelves(options = {}) {
        this.checkMyState();

        const discovery = this.getDiscoveryConfig();
        if (!discovery.enabled)
            return {shelves: []};

        const newestLimit = Math.max(1, Math.min(parseInt(options.newestLimit, 10) || discovery.shelfLimit, 24));
        const popularLimit = Math.max(1, Math.min(parseInt(options.popularLimit, 10) || discovery.shelfLimit, 24));
        const externalShelfLimit = Math.max(1, Math.min(parseInt(options.externalLimit, 10) || discovery.shelfLimit, 24));

        const dbConfig = await this.dbConfig();
        const inpxHash = String(dbConfig.inpxHash || '').trim();
        const shelves = [];

        const newestShelf = await this.rememberDiscovery(
            `discovery:${inpxHash}:newest:${newestLimit}`,
            () => this.buildLocalDiscoveryShelf('newest', newestLimit),
        );
        if (newestShelf)
            shelves.push(newestShelf);

        const popularShelf = await this.rememberDiscovery(
            `discovery:${inpxHash}:popular:${popularLimit}`,
            () => this.buildLocalDiscoveryShelf('popular', popularLimit),
        );
        if (popularShelf)
            shelves.push(popularShelf);

        if (discovery.externalSource !== 'none') {
            try {
                const externalShelf = await this.rememberDiscovery(
                    `discovery:${inpxHash}:external:${discovery.externalSource}:${discovery.externalLimit}:${externalShelfLimit}:${discovery.externalUrl}`,
                    () => this.buildExternalDiscoveryShelf(externalShelfLimit),
                );
                if (externalShelf)
                    shelves.push(externalShelf);
            } catch (e) {
                shelves.push({
                    id: 'external-error',
                    title: (discovery.externalName || 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє'),
                    subtitle: 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє РІСЂРµРјРµРЅРЅРѕ РЅРµРґРѕСЃС‚СѓРїРµРЅ',
                    source: 'external',
                    sourceName: (discovery.externalName || 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє'),
                    sourceUrl: (discovery.externalUrl || ''),
                    items: [],
                    emptyMessage: e.message,
                });
            }
        }

        return {shelves};
    }

    async buildLocalDiscoveryShelfV2(kind = 'newest', limit = 8, options = {}) {
        let shelfConfig = null;
        if (kind === 'newest') {
            shelfConfig = {
                id: `newest-${options.daysWindow || 0}d`,
                title: `РќРѕРІРёРЅРєРё Р·Р° ${options.daysWindow || 0} РґРЅРµР№`,
                subtitle: `РљРЅРёРіРё, РґРѕР±Р°РІР»РµРЅРЅС‹Рµ Р·Р° РїРѕСЃР»РµРґРЅРёРµ ${options.daysWindow || 0} РґРЅРµР№`,
                mode: 'newest',
            };
        } else if (kind === 'popular') {
            shelfConfig = {
                id: 'popular',
                title: 'РџРѕРїСѓР»СЏСЂРЅРѕРµ РІ Р±РёР±Р»РёРѕС‚РµРєРµ',
                subtitle: 'Р›РѕРєР°Р»СЊРЅС‹Р№ СЂРµР№С‚РёРЅРі РїРѕ С‡С‚РµРЅРёСЋ, СЃРїРёСЃРєР°Рј Рё РѕС†РµРЅРєР°Рј',
                mode: 'popular',
            };
        }

        if (!shelfConfig)
            return null;

        const items = (await this.selectDiscoveryBooks(shelfConfig.mode, limit, options))
            .map((book) => this.decorateDiscoveryBook(book, {
                mode: shelfConfig.mode,
                popularityInfo: ((options.popularityMap || {})[book._uid] || null),
            }));
        if (!items.length)
            return null;

        return {
            id: shelfConfig.id,
            title: shelfConfig.title,
            subtitle: shelfConfig.subtitle,
            source: 'local',
            sourceName: 'Р›РѕРєР°Р»СЊРЅР°СЏ Р±РёР±Р»РёРѕС‚РµРєР°',
            updatedAt: Date.now(),
            items,
        };
    }

    pickDiscoveryBookMatchV2(item, books = []) {
        const title = normalizeDiscoveryText(item.title || '');
        if (!title)
            return null;

        const authorTokens = extractDiscoveryAuthorTokens(item.author || '');
        let best = null;
        let bestKind = '';
        let bestScore = -Infinity;

        for (const book of books) {
            const bookTitle = normalizeDiscoveryText(book.title || '');
            if (!bookTitle)
                continue;

            let score = -Infinity;
            if (bookTitle === title) {
                score = 1000;
            } else if (bookTitle.startsWith(title) || title.startsWith(bookTitle)) {
                score = 700;
            } else if (bookTitle.includes(title) || title.includes(bookTitle)) {
                score = 450;
            } else {
                continue;
            }

            const bookAuthor = normalizeDiscoveryText(book.author || '');
            let authorScore = 0;
            for (const token of authorTokens) {
                if (bookAuthor.includes(token))
                    authorScore += 90;
            }

            if (authorTokens.length && !authorScore)
                score -= 180;

            score += authorScore;
            if (!book.del)
                score += 15;
            if (String(book.ext || '').toLowerCase() === 'fb2')
                score += 12;
            score += parseInt(book.librate || '0', 10) || 0;

            const kind = (
                bookTitle === title && authorScore > 0 ? 'exact'
                    : (authorScore > 0 ? 'title-author'
                        : (bookTitle === title ? 'title' : 'title-partial'))
            );

            if (score > bestScore) {
                bestScore = score;
                best = book;
                bestKind = kind;
            }
        }

        return (bestScore >= 450 ? {book: best, kind: bestKind, score: bestScore} : null);
    }

    makeExternalDiscoveryPlaceholder(item = {}, index = 0) {
        const rawId = `${item.title || ''}|${item.author || ''}|${item.url || ''}|${index}`;
        const hash = crypto.createHash('md5').update(rawId, 'utf8').digest('hex');

        return {
            _uid: `external:${hash}`,
            id: `external-${hash.substring(0, 12)}`,
            title: String(item.title || '').trim(),
            author: String(item.author || '').trim(),
            series: '',
            serno: '',
            genre: '',
            ext: 'web',
            size: 0,
            date: '',
            librate: '',
            del: false,
            libid: '',
            file: '',
            discoveryUrl: String(item.url || '').trim(),
            discoveryCoverUrl: String(item.cover || '').trim(),
            discoveryRating: item.rating,
            discoveryMatchType: 'missing-local',
            discoveryMissingLocal: true,
            discoveryFlags: {
                bestseller: !!item.isBestseller,
                isNew: !!item.isNew,
            },
        };
    }

    async matchExternalItemsToLocalBooksV2(items = [], limit = 8) {
        const result = [];
        const seenBookUids = new Set();
        let matchedCount = 0;
        let missingCount = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            let response = await this.dbSearcher.bookSearch({
                title: `=${item.title}`,
                limit: 16,
            });
            let match = this.pickDiscoveryBookMatchV2(item, response.found || []);

            if (!match) {
                response = await this.dbSearcher.bookSearch({
                    title: `*${String(item.title || '').substring(0, 80)}`,
                    limit: 24,
                });
                match = this.pickDiscoveryBookMatchV2(item, response.found || []);
            }

            if (match && match.book) {
                if (!seenBookUids.has(match.book._uid)) {
                    seenBookUids.add(match.book._uid);
                    result.push(Object.assign({}, match.book, {
                        discoveryUrl: item.url,
                        discoveryCoverUrl: item.cover,
                        discoveryRating: item.rating,
                        discoveryMatchType: match.kind,
                        discoveryFlags: {
                            bestseller: !!item.isBestseller,
                            isNew: !!item.isNew,
                        },
                    }));
                    matchedCount++;
                }
            } else {
                result.push(this.makeExternalDiscoveryPlaceholder(item, index));
                missingCount++;
            }

            if (result.length >= limit)
                break;

            await utils.processLoop();
        }

        return {
            items: result,
            matchedCount,
            missingCount,
        };
    }

    async fetchExternalDiscoveryItemsV2(discovery = {}) {
        try {
            return await this.fetchExternalFeedItems(discovery.externalLimit, discovery.externalUrl);
        } catch (e) {
            throw new Error(`?? ??????? ???????? ???????? "${discovery.externalName || '??????? ????????'}"`);
        }
    }

    async buildExternalDiscoveryShelfV2(limit = 8, options = {}) {
        const discovery = this.getDiscoveryConfig(options);
        if (discovery.externalSource === 'none')
            return null;

        if (discovery.externalSource !== 'web-page')
            throw new Error(`??????????? ???????? ???????: ${discovery.externalSource}`);

        const feed = await this.fetchExternalDiscoveryItemsV2(discovery);
        const matched = await this.matchExternalItemsToLocalBooksV2(feed.items || [], limit);
        const items = matched.items
            .map((book) => this.decorateDiscoveryBook(book, {
                discoverySource: (discovery.externalName || '??????? ????????'),
                matchKind: book.discoveryMatchType,
            }));
        const sourceName = (discovery.externalName || '??????? ????????');

        return {
            id: 'external-source',
            title: sourceName,
            subtitle: `? ?????????? ${matched.matchedCount} ? ??? ?????????? ${matched.missingCount}` ,
            source: 'external',
            sourceName,
            sourceUrl: feed.sourceUrl,
            updatedAt: Date.now(),
            discoveryStale: false,
            items,
            emptyMessage: '?? ??????? ????????? ???? ?????? ?? ???????.',
        };
    }
    async getDiscoveryShelvesV2(options = {}) {
        this.checkMyState();

        const discovery = await this.getDiscoveryConfigForRequest(options);
        if (!discovery.enabled)
            return {shelves: []};

        const newestLimit = Math.max(1, Math.min(parseInt(options.newestLimit, 10) || discovery.shelfLimit, 24));
        const popularLimit = Math.max(1, Math.min(parseInt(options.popularLimit, 10) || discovery.shelfLimit, 24));
        const externalShelfLimit = Math.max(1, Math.min(parseInt(options.externalLimit, 10) || discovery.shelfLimit, 24));
        const personalShelfLimit = Math.max(1, Math.min(parseInt(options.personalLimit, 10) || discovery.shelfLimit, 24));

        const dbConfig = await this.dbConfig();
        const inpxHash = String(dbConfig.inpxHash || '').trim();
        const shelves = [];
        const popularityMap = await this.buildDiscoveryPopularityMap();
        const newestSeen = new Set();

        for (const daysWindow of [7, 30, 90]) {
            const newestShelf = await this.rememberDiscovery(
                `discovery:${inpxHash}:newest:${daysWindow}:${newestLimit}`,
                () => this.buildLocalDiscoveryShelfV2('newest', newestLimit, {
                    daysWindow,
                    excludedBookUids: Array.from(newestSeen),
                }),
            );
            if (newestShelf) {
                shelves.push(newestShelf);
                for (const book of (Array.isArray(newestShelf.items) ? newestShelf.items : [])) {
                    if (book && book._uid)
                        newestSeen.add(book._uid);
                }
            }
        }

        const popularShelf = await this.rememberDiscovery(
            `discovery:${inpxHash}:popular:v2:${popularLimit}`,
            () => this.buildLocalDiscoveryShelfV2('popular', popularLimit, {popularityMap}),
        );
        if (popularShelf)
            shelves.push(popularShelf);

        for (const shelf of await this.getPersonalDiscoveryShelvesV2(options.userId, options.profileAccessToken, personalShelfLimit, options)) {
            if (shelf)
                shelves.push(shelf);
        }

        if (discovery.externalSource !== 'none') {
            try {
                const externalShelf = await this.rememberPersistedDiscovery(
                    `discovery:${inpxHash}:external:v2:${discovery.externalSource}:${discovery.externalName}:${discovery.externalLimit}:${externalShelfLimit}:${discovery.externalUrl}:${discovery.externalTtlMinutes}`,
                    () => this.buildExternalDiscoveryShelfV2(externalShelfLimit, options),
                    discovery.externalTtlMinutes * 60 * 1000,
                );
                if (externalShelf)
                    shelves.push(externalShelf);
            } catch (e) {
                shelves.push({
                    id: 'external-error',
                    title: (discovery.externalName || 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє'),
                    subtitle: 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє РІСЂРµРјРµРЅРЅРѕ РЅРµРґРѕСЃС‚СѓРїРµРЅ',
                    source: 'external',
                    sourceName: (discovery.externalName || 'Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє'),
                    sourceUrl: (discovery.externalUrl || ''),
                    items: [],
                    emptyMessage: e.message,
                });
            }
        }

        return {shelves};
    }

    formatPersonalDiscoveryDate(value = '') {
        const time = Date.parse(String(value || ''));
        if (!Number.isFinite(time))
            return '';

        return new Date(time).toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }


    getHiddenDiscoveryBooks(user = null) {
        const hiddenBooks = (((user || {}).discoveryPreferences || {}).hiddenBooks || []);
        return new Set(
            (Array.isArray(hiddenBooks) ? hiddenBooks : [])
                .map((bookUid) => String(bookUid || '').trim())
                .filter(Boolean)
        );
    }

    getPersonalReadBookSet(user = null, lists = []) {
        const readBookUids = new Set();
        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});

        for (const [bookUid, progress] of Object.entries(progressMap)) {
            if ((Number(progress && progress.percent || 0) || 0) >= 0.999)
                readBookUids.add(String(bookUid || '').trim());
        }

        for (const list of (Array.isArray(lists) ? lists : [])) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                if (entry.read)
                    readBookUids.add(String(entry.bookUid || '').trim());
            }
        }

        return readBookUids;
    }

    async buildContinueReadingShelfV2(user = null, limit = 8, context = null) {
        const hiddenBookUids = this.getHiddenDiscoveryBooks(user);
        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, []));

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: ''}, progress || {}),
            }))
            .filter((item) => item.bookUid && !hiddenBookUids.has(item.bookUid) && Number(item.progress.percent || 0) < 0.999)
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')));

        const items = [];
        let updatedAt = 0;

        for (const item of rows) {
            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            const percent = Math.max(0, Math.min(100, Math.round((Number(item.progress.percent || 0) || 0) * 100)));
            const updatedLabel = this.formatPersonalDiscoveryDate(item.progress.updatedAt);
            items.push(Object.assign({}, book, {
                discoveryReason: `\u041f\u0440\u043e\u0433\u0440\u0435\u0441\u0441 ${percent}%${updatedLabel ? ` \u00b7 \u041e\u0442\u043a\u0440\u044b\u0432\u0430\u043b\u0438 ${updatedLabel}` : ''}`,
                discoveryRead: readBookUids.has(item.bookUid),
            }));

            updatedAt = Math.max(updatedAt, Date.parse(String(item.progress.updatedAt || '')) || 0);
            if (items.length >= limit)
                break;
        }

        return {
            id: 'continue-reading',
            title: '\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c \u0447\u0442\u0435\u043d\u0438\u0435',
            subtitle: '\u041a\u043d\u0438\u0433\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u043b\u0438 \u043d\u0435\u0434\u0430\u0432\u043d\u043e',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: '\u0417\u0434\u0435\u0441\u044c \u043f\u043e\u044f\u0432\u044f\u0442\u0441\u044f \u043a\u043d\u0438\u0433\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u043d\u0430\u0447\u0430\u043b\u0438 \u0447\u0438\u0442\u0430\u0442\u044c.',
        };
    }

    async buildFromReadingListsShelfV2(user = null, limit = 8, context = null) {
        const hiddenBookUids = this.getHiddenDiscoveryBooks(user);
        if (!user || !user.id) {
            return {
                id: 'from-your-lists',
                title: '\u0418\u0437 \u0432\u0430\u0448\u0438\u0445 \u0441\u043f\u0438\u0441\u043a\u043e\u0432',
                subtitle: '\u041d\u0435\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043d\u044b\u0435 \u043a\u043d\u0438\u0433\u0438 \u0438\u0437 \u0432\u0430\u0448\u0438\u0445 \u0441\u043f\u0438\u0441\u043a\u043e\u0432 \u0447\u0442\u0435\u043d\u0438\u044f',
                source: 'personal',
                sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
                updatedAt: Date.now(),
                items: [],
                emptyMessage: '\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u0447\u0442\u0435\u043d\u0438\u044f.',
            };
        }

        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, lists));
        const candidates = [];
        let updatedAt = 0;

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            const listUpdatedAt = Date.parse(String(list.updatedAt || list.createdAt || '')) || 0;
            updatedAt = Math.max(updatedAt, listUpdatedAt);

            entries.forEach((entry, index) => {
                candidates.push({
                    bookUid: entry.bookUid,
                    read: !!entry.read,
                    listName: String(list.name || '').trim() || '\u0421\u043f\u0438\u0441\u043e\u043a \u0447\u0442\u0435\u043d\u0438\u044f',
                    updatedAt: String(list.updatedAt || list.createdAt || ''),
                    order: index,
                });
            });
        }

        candidates.sort((a, b) => {
            if (a.read != b.read)
                return (a.read ? 1 : -1);

            const updatedCmp = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
            if (updatedCmp)
                return updatedCmp;

            return a.order - b.order;
        });

        const items = [];
        const seenBookUids = new Set();

        for (const item of candidates) {
            if (!item.bookUid || hiddenBookUids.has(item.bookUid) || seenBookUids.has(item.bookUid))
                continue;

            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            seenBookUids.add(item.bookUid);
            const updatedLabel = this.formatPersonalDiscoveryDate(item.updatedAt);
            items.push(Object.assign({}, book, {
                discoveryReason: `\u0418\u0437 \u0441\u043f\u0438\u0441\u043a\u0430 \u00ab${item.listName}\u00bb${item.read ? ' \u00b7 \u0423\u0436\u0435 \u043e\u0442\u043c\u0435\u0447\u0435\u043d\u0430 \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043d\u043e\u0439' : ' \u00b7 \u0415\u0449\u0451 \u043d\u0435 \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u0430'}${updatedLabel ? ` \u00b7 \u041e\u0431\u043d\u043e\u0432\u043b\u0451\u043d ${updatedLabel}` : ''}`,
                discoveryRead: (item.read || readBookUids.has(item.bookUid)),
            }));

            if (items.length >= limit)
                break;
        }

        return {
            id: 'from-your-lists',
            title: '\u0418\u0437 \u0432\u0430\u0448\u0438\u0445 \u0441\u043f\u0438\u0441\u043a\u043e\u0432',
            subtitle: '\u041a\u043d\u0438\u0433\u0438 \u0438\u0437 \u0432\u0430\u0448\u0438\u0445 \u043b\u0438\u0447\u043d\u044b\u0445 \u0441\u043f\u0438\u0441\u043a\u043e\u0432 \u0447\u0442\u0435\u043d\u0438\u044f',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: '\u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u043a\u043d\u0438\u0433\u0438 \u0432 \u043b\u0438\u0447\u043d\u044b\u0435 \u0441\u043f\u0438\u0441\u043a\u0438, \u0438 \u043e\u043d\u0438 \u043f\u043e\u044f\u0432\u044f\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c.',
        };
    }

    async buildUnfinishedSeriesShelfV2(user = null, limit = 8, context = null) {
        const hiddenBookUids = this.getHiddenDiscoveryBooks(user);
        if (!user || !user.id) {
            return {
                id: 'unfinished-series',
                title: '\u041d\u0435\u0437\u0430\u043a\u043e\u043d\u0447\u0435\u043d\u043d\u044b\u0435 \u0441\u0435\u0440\u0438\u0438',
                subtitle: '\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0435 \u043a\u043d\u0438\u0433\u0438 \u0432 \u0441\u0435\u0440\u0438\u044f\u0445, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u0443\u0436\u0435 \u043d\u0430\u0447\u0430\u043b\u0438',
                source: 'personal',
                sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
                updatedAt: Date.now(),
                items: [],
                emptyMessage: '\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u0447\u0442\u0435\u043d\u0438\u044f.',
            };
        }

        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? new Set(context.readBookUids) : new Set());
        const seriesState = new Map();

        for (const [bookUid, progress] of Object.entries(progressMap)) {
            const book = await this.getBookRecordByUid(bookUid);
            if (!book || !book.series || !book.serno)
                continue;

            const key = String(book.series || '').trim().toLowerCase();
            const current = seriesState.get(key) || {
                series: book.series,
                maxSerno: 0,
                updatedAt: '',
                lastTitle: '',
            };

            if (Number(book.serno || 0) >= current.maxSerno) {
                current.maxSerno = Number(book.serno || 0);
                current.updatedAt = String(progress && progress.updatedAt || current.updatedAt || '');
                current.lastTitle = String(book.title || current.lastTitle || '');
            }

            readBookUids.add(bookUid);
            seriesState.set(key, current);
        }

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                if (!entry.read)
                    continue;

                readBookUids.add(entry.bookUid);
                const book = await this.getBookRecordByUid(entry.bookUid);
                if (!book || !book.series || !book.serno)
                    continue;

                const key = String(book.series || '').trim().toLowerCase();
                const current = seriesState.get(key) || {
                    series: book.series,
                    maxSerno: 0,
                    updatedAt: '',
                    lastTitle: '',
                };

                if (Number(book.serno || 0) >= current.maxSerno) {
                    current.maxSerno = Number(book.serno || 0);
                    current.updatedAt = String(list.updatedAt || list.createdAt || current.updatedAt || '');
                    current.lastTitle = String(book.title || current.lastTitle || '');
                }

                seriesState.set(key, current);
            }
        }

        const candidates = Array.from(seriesState.values())
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

        const items = [];
        const seenBookUids = new Set();
        let updatedAt = 0;

        for (const state of candidates) {
            const response = await this.getSeriesBookList(state.series);
            const books = Array.isArray(response && response.books) ? response.books : [];
            const nextBook = books
                .filter((book) => book && book.series && Number(book.serno || 0) > Number(state.maxSerno || 0))
                .sort((a, b) => {
                    const sernoCmp = Number(a.serno || 0) - Number(b.serno || 0);
                    if (sernoCmp)
                        return sernoCmp;
                    return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
                })
                .find((book) => book && book._uid && !hiddenBookUids.has(book._uid) && !readBookUids.has(book._uid) && !seenBookUids.has(book._uid));

            if (!nextBook)
                continue;

            seenBookUids.add(nextBook._uid);
            const updatedLabel = this.formatPersonalDiscoveryDate(state.updatedAt);
            items.push(Object.assign({}, nextBook, {
                discoveryReason: `\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0442\u043e\u043c \u043f\u043e\u0441\u043b\u0435 \u00ab${state.lastTitle || '\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0435\u0439 \u043a\u043d\u0438\u0433\u0438'}\u00bb${updatedLabel ? ` \u00b7 \u0421\u0435\u0440\u0438\u044f \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0430 ${updatedLabel}` : ''}`,
                discoveryRead: false,
            }));

            updatedAt = Math.max(updatedAt, Date.parse(String(state.updatedAt || '')) || 0);
            if (items.length >= limit)
                break;
        }

        return {
            id: 'unfinished-series',
            title: '\u041d\u0435\u0437\u0430\u043a\u043e\u043d\u0447\u0435\u043d\u043d\u044b\u0435 \u0441\u0435\u0440\u0438\u0438',
            subtitle: '\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0435 \u043a\u043d\u0438\u0433\u0438 \u0432 \u0441\u0435\u0440\u0438\u044f\u0445, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u0443\u0436\u0435 \u043d\u0430\u0447\u0430\u043b\u0438',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: '\u041a\u0430\u043a \u0442\u043e\u043b\u044c\u043a\u043e \u0432\u044b \u043d\u0430\u0447\u043d\u0451\u0442\u0435 \u0441\u0435\u0440\u0438\u044e, \u0437\u0434\u0435\u0441\u044c \u043f\u043e\u044f\u0432\u0438\u0442\u0441\u044f \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0442\u043e\u043c.',
        };
    }

    async buildSimilarBooksShelfV2(user = null, limit = 8, context = null) {
        const hiddenBookUids = this.getHiddenDiscoveryBooks(user);
        if (!user || !user.id) {
            return {
                id: 'similar-books',
                title: '\u041f\u043e\u0445\u043e\u0436\u0435 \u043d\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0447\u0438\u0442\u0430\u043b\u0438',
                subtitle: '\u041a\u043d\u0438\u0433\u0438 \u0441 \u043f\u043e\u0445\u043e\u0436\u0438\u043c\u0438 \u0430\u0432\u0442\u043e\u0440\u0430\u043c\u0438, \u0441\u0435\u0440\u0438\u044f\u043c\u0438 \u0438 \u0436\u0430\u043d\u0440\u0430\u043c\u0438',
                source: 'personal',
                sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
                updatedAt: Date.now(),
                items: [],
                emptyMessage: '\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u0447\u0442\u0435\u043d\u0438\u044f.',
            };
        }

        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, lists));
        const authorWeights = new Map();
        const seriesWeights = new Map();
        const genreWeights = new Map();
        const knownBookUids = new Set(hiddenBookUids);
        let updatedAt = 0;

        const addWeight = (map, key, amount) => {
            const normalizedKey = String(key || '').trim().toLowerCase();
            if (!normalizedKey)
                return;
            map.set(normalizedKey, (map.get(normalizedKey) || 0) + Number(amount || 0));
        };

        const applyBookSignals = (book, amount = 1, stamp = '') => {
            if (!book)
                return;

            knownBookUids.add(book._uid);
            addWeight(authorWeights, book.author, 4 * amount);
            addWeight(seriesWeights, book.series, 6 * amount);
            String(book.genre || '')
                .split(',')
                .map(item => item.trim())
                .filter(Boolean)
                .forEach((genre) => addWeight(genreWeights, genre, 2 * amount));

            updatedAt = Math.max(updatedAt, Date.parse(String(stamp || '')) || 0);
        };

        for (const [bookUid, progress] of Object.entries(progressMap)) {
            const book = await this.getBookRecordByUid(bookUid);
            if (!book)
                continue;

            const percent = Number(progress && progress.percent || 0) || 0;
            applyBookSignals(book, (percent >= 0.95 ? 3 : (percent >= 0.5 ? 2 : 1)), progress && progress.updatedAt);
        }

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                const book = await this.getBookRecordByUid(entry.bookUid);
                if (!book)
                    continue;

                applyBookSignals(book, (entry.read ? 2 : 1), list.updatedAt || list.createdAt);
            }
        }

        const preferredAuthors = Object.fromEntries(authorWeights);
        const preferredSeries = Object.fromEntries(seriesWeights);
        const preferredGenres = Object.fromEntries(genreWeights);
        if (!Object.keys(preferredAuthors).length && !Object.keys(preferredSeries).length && !Object.keys(preferredGenres).length) {
            return {
                id: 'similar-books',
                title: '\u041f\u043e\u0445\u043e\u0436\u0435 \u043d\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0447\u0438\u0442\u0430\u043b\u0438',
                subtitle: '\u041a\u043d\u0438\u0433\u0438 \u0441 \u043f\u043e\u0445\u043e\u0436\u0438\u043c\u0438 \u0430\u0432\u0442\u043e\u0440\u0430\u043c\u0438, \u0441\u0435\u0440\u0438\u044f\u043c\u0438 \u0438 \u0436\u0430\u043d\u0440\u0430\u043c\u0438',
                source: 'personal',
                sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
                updatedAt: Date.now(),
                items: [],
                emptyMessage: '\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u043f\u043e\u0447\u0438\u0442\u0430\u0439\u0442\u0435 \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u043a\u043d\u0438\u0433 \u0438\u043b\u0438 \u0434\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u0438\u0445 \u0432 \u0441\u043f\u0438\u0441\u043a\u0438.',
            };
        }

        const rows = await this.db.select({
            table: 'book',
            rawResult: true,
            where: `
                const knownBookUids = new Set(${this.db.esc(Array.from(knownBookUids))});
                const preferredAuthors = ${this.db.esc(preferredAuthors)};
                const preferredSeries = ${this.db.esc(preferredSeries)};
                const preferredGenres = ${this.db.esc(preferredGenres)};
                const limit = ${this.db.esc(Math.max(limit * 6, 32))};

                const result = [];
                for (const id of @all()) {
                    const row = @unsafeRow(id);
                    if (!row || row.del || !row.title || !row._uid || knownBookUids.has(row._uid))
                        continue;

                    let score = 0;
                    const authorKey = String(row.author || '').trim().toLowerCase();
                    const seriesKey = String(row.series || '').trim().toLowerCase();
                    const genreKeys = String(row.genre || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

                    if (authorKey && preferredAuthors[authorKey])
                        score += preferredAuthors[authorKey] * 80;
                    if (seriesKey && preferredSeries[seriesKey])
                        score += preferredSeries[seriesKey] * 110;
                    for (const genreKey of genreKeys) {
                        if (preferredGenres[genreKey])
                            score += preferredGenres[genreKey] * 22;
                    }

                    if (!score)
                        continue;

                    if (row.librate)
                        score += row.librate * 6;
                    if (row.date) {
                        const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(row.date)) / 86400000));
                        score += Math.max(0, 30 - Math.min(ageDays, 30));
                    }
                    if (String(row.ext || '').toLowerCase() === 'fb2')
                        score += 10;

                    result.push(Object.assign({}, row, {_similarityScore: score}));
                }

                result.sort((a, b) => {
                    const scoreCmp = Number(b._similarityScore || 0) - Number(a._similarityScore || 0);
                    if (scoreCmp)
                        return scoreCmp;
                    return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
                });

                return result.slice(0, limit);
            `
        });

        const rawItems = ((rows[0] && rows[0].rawResult) ? rows[0].rawResult : []);
        const items = [];
        const authorCounts = new Map();
        const seriesCounts = new Map();

        for (const book of rawItems) {
            const authorKey = String(book.author || '').trim().toLowerCase();
            const seriesKey = String(book.series || '').trim().toLowerCase();
            if (authorKey && (authorCounts.get(authorKey) || 0) >= 2)
                continue;
            if (seriesKey && (seriesCounts.get(seriesKey) || 0) >= 2)
                continue;

            const reasons = [];
            if (authorKey && authorWeights.has(authorKey))
                reasons.push(`\u0410\u0432\u0442\u043e\u0440: ${book.author}`);
            if (seriesKey && seriesWeights.has(seriesKey))
                reasons.push(`\u0421\u0435\u0440\u0438\u044f: ${book.series}`);

            const matchedGenres = String(book.genre || '')
                .split(',')
                .map(item => item.trim())
                .filter(Boolean)
                .filter((genre) => genreWeights.has(String(genre || '').trim().toLowerCase()));
            if (matchedGenres.length)
                reasons.push(`\u0416\u0430\u043d\u0440\u044b: ${matchedGenres.slice(0, 2).join(', ')}`);

            items.push(Object.assign({}, book, {
                discoveryReason: (reasons.length ? reasons.join(' \u00b7 ') : '\u041f\u043e\u0445\u043e\u0436\u0435 \u043d\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0447\u0438\u0442\u0430\u043b\u0438'),
                discoveryRead: readBookUids.has(String(book._uid || '').trim()),
            }));

            if (authorKey)
                authorCounts.set(authorKey, (authorCounts.get(authorKey) || 0) + 1);
            if (seriesKey)
                seriesCounts.set(seriesKey, (seriesCounts.get(seriesKey) || 0) + 1);
            if (items.length >= limit)
                break;
        }

        return {
            id: 'similar-books',
            title: '\u041f\u043e\u0445\u043e\u0436\u0435 \u043d\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0447\u0438\u0442\u0430\u043b\u0438',
            subtitle: '\u041f\u043e\u0434\u0431\u043e\u0440\u043a\u0430 \u043f\u043e \u0430\u0432\u0442\u043e\u0440\u0430\u043c, \u0441\u0435\u0440\u0438\u044f\u043c \u0438 \u0436\u0430\u043d\u0440\u0430\u043c \u0438\u0437 \u0432\u0430\u0448\u0435\u0439 \u0438\u0441\u0442\u043e\u0440\u0438\u0438',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: '\u041f\u043e\u043a\u0430 \u043c\u0430\u043b\u043e \u0434\u0430\u043d\u043d\u044b\u0445 \u0434\u043b\u044f \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u0439. \u041f\u043e\u0447\u0438\u0442\u0430\u0439\u0442\u0435 \u0435\u0449\u0451 \u043d\u0435\u043c\u043d\u043e\u0433\u043e \u0438\u043b\u0438 \u0434\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u043a\u043d\u0438\u0433\u0438 \u0432 \u0441\u043f\u0438\u0441\u043a\u0438.',
        };
    }

    async buildHiddenDiscoveryShelfV2(user = null, limit = 8, context = null) {
        const hiddenBookUids = Array.from(this.getHiddenDiscoveryBooks(user));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, []));
        const items = [];

        for (const bookUid of hiddenBookUids.slice().reverse()) {
            const book = await this.getBookRecordByUid(bookUid);
            if (!book)
                continue;

            items.push(Object.assign({}, book, {
                discoveryReason: '\u0421\u043a\u0440\u044b\u0442\u043e \u0438\u0437 \u043f\u0435\u0440\u0441\u043e\u043d\u0430\u043b\u044c\u043d\u044b\u0445 \u0432\u0438\u0442\u0440\u0438\u043d',
                discoveryRead: readBookUids.has(bookUid),
            }));

            if (items.length >= limit)
                break;
        }

        return {
            id: 'hidden-books',
            title: '\u0421\u043a\u0440\u044b\u0442\u044b\u0435 \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u0438',
            subtitle: '\u041a\u043d\u0438\u0433\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u0441\u043a\u0440\u044b\u043b\u0438 \u0438\u0437 \u043f\u0435\u0440\u0441\u043e\u043d\u0430\u043b\u044c\u043d\u044b\u0445 \u0432\u0438\u0442\u0440\u0438\u043d',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: Date.now(),
            items,
            emptyMessage: '\u0417\u0434\u0435\u0441\u044c \u0431\u0443\u0434\u0443\u0442 \u043a\u043d\u0438\u0433\u0438, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u0432\u044b \u043e\u0442\u043c\u0435\u0442\u0438\u043b\u0438 \u043a\u0430\u043a \u043d\u0435\u0438\u043d\u0442\u0435\u0440\u0435\u0441\u043d\u044b\u0435.',
        };
    }

    async getPersonalDiscoveryShelvesV2(userId = '', profileAccessToken = '', limit = 8, options = {}) {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId)
            return [];

        const user = await this.getEffectiveUser(normalizedUserId, profileAccessToken);
        if (!user)
            return [];

        if (user.passwordHash && this.getProfileSessionUser(profileAccessToken) !== user.id)
            return [];

        const lists = await this.readingListStore.getLists(user.id, {});
        const context = {
            lists,
            progressMap: (user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}),
            readBookUids: this.getPersonalReadBookSet(user, lists),
        };

        const shelves = [
            await this.buildContinueReadingShelfV2(user, limit, context),
            await this.buildFromReadingListsShelfV2(user, limit, context),
            await this.buildUnfinishedSeriesShelfV2(user, limit, context),
        ];

        if (options && options.personalSimilarEnabled !== false)
            shelves.push(await this.buildSimilarBooksShelfV2(user, limit, context));

        shelves.push(await this.buildHiddenDiscoveryShelfV2(user, limit, context));

        return shelves;
    }

    async getBookRecordByUid(bookUid) {
        const rows = await this.db.select({table: 'book', where: `@@hash('_uid', ${this.db.esc(bookUid)})`});
        return (rows.length ? rows[0] : null);
    }

    sortReadingListBooks(books = [], order = []) {
        const orderMap = new Map(order.map((uid, index) => [uid, index]));
        return books.sort((a, b) => {
            const ai = orderMap.has(a._uid) ? orderMap.get(a._uid) : Number.MAX_SAFE_INTEGER;
            const bi = orderMap.has(b._uid) ? orderMap.get(b._uid) : Number.MAX_SAFE_INTEGER;
            if (ai !== bi)
                return ai - bi;

            return (a.title || '').localeCompare(b.title || '', 'ru');
        });
    }

    async buildUserReadingSummary(user = null, limit = 6) {
        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, progress || {}),
            }))
            .filter((item) => item.bookUid && item.progress.hidden !== true)
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')))
            .slice(0, Math.max(0, limit));

        const result = [];
        for (const item of rows) {
            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            result.push({
                bookUid: item.bookUid,
                title: book.title || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ',
                author: book.author || '',
                series: book.series || '',
                serno: book.serno || '',
                ext: book.ext || '',
                percent: Math.max(0, Math.min(1, Number(item.progress.percent || 0) || 0)),
                sectionId: String(item.progress.sectionId || '').trim(),
                updatedAt: String(item.progress.updatedAt || '').trim(),
            });
        }

        return {
            count: Object.keys(progressMap).length,
            items: result,
        };
    }

    async getUserProfiles(currentUserId = '') {
        this.checkMyState();

        const {users, currentUser} = await this.readingListStore.getUsers(currentUserId);
        return {
            users: users
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    login: item.login || '',
                    requiresLogin: !!item.passwordHash,
                    isAdmin: !!item.isAdmin,
                    opdsEnabled: item.opdsEnabled !== false,
                    currentReadingCount: Object.values(item.readerProgress || {}).filter(progress => progress && progress.hidden !== true).length,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                }))
                .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
            currentUserId: (currentUser ? currentUser.id : ''),
        };
    }

    hashProfilePassword(login, password) {
        return utils.getBufHash(`${String(login || '').trim().toLowerCase()}::${String(password || '')}`, 'sha256', 'hex');
    }

    createProfileSession(userId) {
        const token = utils.randomHexString(24);
        this.profileSessions.set(token, {
            userId,
            time: Date.now(),
        });
        return token;
    }

    getProfileSessionUser(token = '') {
        const rec = this.profileSessions.get(String(token || '').trim());
        if (!rec)
            return '';

        rec.time = Date.now();
        return rec.userId || '';
    }

    closeProfileSession(token = '') {
        this.profileSessions.delete(String(token || '').trim());
        return {success: true};
    }

    async getEffectiveUser(userId = '', profileAccessToken = '') {
        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (sessionUserId)
            return await this.readingListStore.getUser(sessionUserId);

        const requestedUser = await this.readingListStore.getUser(userId);
        if (requestedUser && !requestedUser.passwordHash)
            return requestedUser;

        return requestedUser;
    }

    async requireAuthorizedUser(userId = '', profileAccessToken = '') {
        const requestedUser = await this.readingListStore.getUser(userId);
        if (!requestedUser.passwordHash)
            return requestedUser;

        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (!sessionUserId || sessionUserId !== requestedUser.id)
            throw new Error('need_profile_login');

        return requestedUser;
    }

    async requireAdmin(userId = '', profileAccessToken = '') {
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        if (!user.isAdmin)
            throw new Error('РўРѕР»СЊРєРѕ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ РјРѕР¶РµС‚ СѓРїСЂР°РІР»СЏС‚СЊ РїСЂРѕС„РёР»СЏРјРё');
        return user;
    }

    async getCurrentUserProfile(userId = '', profileAccessToken = '') {
        this.checkMyState();

        const user = await this.getEffectiveUser(userId, profileAccessToken);
        const profileAuthorized = (!user.passwordHash || this.getProfileSessionUser(profileAccessToken) === user.id);
        const readingSummary = (profileAuthorized ? await this.buildUserReadingSummary(user) : {count: 0, items: []});
        return {
            currentUserId: user.id,
            profileAuthorized,
            currentUserProfile: {
                id: user.id,
                name: user.name,
                login: user.login || '',
                hasPassword: !!user.passwordHash,
                isAdmin: !!user.isAdmin,
                emailTo: (profileAuthorized ? user.emailTo || '' : ''),
                telegramChatId: (profileAuthorized ? user.telegramChatId || '' : ''),
                opdsEnabled: user.opdsEnabled !== false,
                readerPreferences: (profileAuthorized ? this.readingListStore.normalizeReaderPreferences(user.readerPreferences) : null),
                currentReading: readingSummary.items,
                currentReadingCount: readingSummary.count,
            },
        };
    }

    async loginUserProfile(login = '', password = '') {
        this.checkMyState();

        const user = await this.readingListStore.findUserByLogin(login);
        if (!user || !user.passwordHash)
            throw new Error('РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ');

        const passwordHash = this.hashProfilePassword(user.login, password);
        if (passwordHash !== user.passwordHash)
            throw new Error('РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ');

        return {
            userId: user.id,
            profileAccessToken: this.createProfileSession(user.id),
        };
    }

    async createUserProfile(profile = {}) {
        this.checkMyState();
        return {user: await this.readingListStore.createUser(profile)};
    }

    async updateUserProfile(userId, patch = {}) {
        this.checkMyState();
        return {user: await this.readingListStore.updateUser(userId, patch)};
    }

    async deleteUserProfile(userId) {
        this.checkMyState();
        return await this.readingListStore.deleteUser(userId);
    }

    async getOpdsUsers() {
        this.checkMyState();
        return await this.readingListStore.getOpdsUsers();
    }

    async getReaderState(userId = '', bookUid = '') {
        this.checkMyState();
        return await this.readingListStore.getReaderState(userId, bookUid);
    }

    async updateReaderPreferences(userId = '', patch = {}) {
        this.checkMyState();
        const preferences = await this.readingListStore.updateReaderPreferences(userId, patch);
        return {preferences};
    }

    async updateDiscoveryPreferences(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        const preferences = await this.readingListStore.updateDiscoveryPreferences(user.id, patch);
        return {preferences};
    }

    async updateReaderProgress(userId = '', bookUid = '', patch = {}) {
        this.checkMyState();
        const progress = await this.readingListStore.updateReaderProgress(userId, bookUid, patch);
        return {progress};
    }

    async deleteReaderProgress(userId = '', bookUid = '') {
        this.checkMyState();
        return await this.readingListStore.deleteReaderProgress(userId, bookUid);
    }

    async addReaderBookmark(userId = '', bookUid = '', bookmark = {}) {
        this.checkMyState();
        const bookmarks = await this.readingListStore.addReaderBookmark(userId, bookUid, bookmark);
        return {bookmarks};
    }

    async deleteReaderBookmark(userId = '', bookUid = '', bookmarkId = '') {
        this.checkMyState();
        const bookmarks = await this.readingListStore.deleteReaderBookmark(userId, bookUid, bookmarkId);
        return {bookmarks};
    }

    async getReadingLists(userId = '', bookUid = '', options = {}) {
        this.checkMyState();

        const lists = await this.readingListStore.getLists(userId, options);
        return {
            lists: lists
                .map((item) => this.readingListStore.listStats(item, bookUid))
                .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        };
    }

    async getReadingList(userId = '', listId, options = {}) {
        this.checkMyState();

        const item = await this.readingListStore.getList(userId, listId, options);
        if (!item)
            throw new Error('РЎРїРёСЃРѕРє РЅРµ РЅР°Р№РґРµРЅ');

        const listEntries = this.readingListStore.normalizeEntries(item.books);
        const books = [];
        for (const entry of listEntries) {
            const book = await this.getBookRecordByUid(entry.bookUid);
            if (book) {
                book._readingListRead = !!entry.read;
                books.push(book);
            }
        }

        this.sortReadingListBooks(books, listEntries.map((entry) => entry.bookUid));

        return {
            list: {
                id: item.id,
                userId: item.userId,
                name: item.name,
                visibility: item.visibility,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                bookCount: (item.books || []).length,
                readCount: this.readingListStore.countRead(item.books),
            },
            books,
        };
    }

    async createReadingList(userId = '', name, visibility = 'private') {
        this.checkMyState();

        const item = await this.readingListStore.createList(userId, name, visibility);
        return {
            list: this.readingListStore.listStats(item),
        };
    }

    async renameReadingList(userId = '', listId, name) {
        this.checkMyState();

        const item = await this.readingListStore.renameList(userId, listId, name);
        return {list: this.readingListStore.listStats(item)};
    }

    async setReadingListVisibility(userId = '', listId, visibility) {
        this.checkMyState();
        const item = await this.readingListStore.setListVisibility(userId, listId, visibility);
        return {list: this.readingListStore.listStats(item)};
    }

    async deleteReadingList(userId = '', listId) {
        this.checkMyState();
        return await this.readingListStore.deleteList(userId, listId);
    }

    async exportReadingLists(userId = '') {
        this.checkMyState();
        return await this.readingListStore.exportData(userId);
    }

    async importReadingLists(userId = '', data) {
        this.checkMyState();
        return await this.readingListStore.importData(userId, data);
    }

    async updateReadingListBook(userId = '', listId, bookUid, enabled) {
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');

        const item = await this.readingListStore.setBookMembership(userId, listId, bookUid, enabled);
        return {
            list: this.readingListStore.listStats(item),
            bookUid,
            enabled: !!enabled,
        };
    }

    async setReadingListBookRead(userId = '', listId, bookUid, read) {
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');

        const item = await this.readingListStore.setBookRead(userId, listId, bookUid, read);
        return {
            list: this.readingListStore.listStats(item),
            bookUid,
            read: !!read,
        };
    }

    async addSeriesToReadingList(userId = '', listId, series) {
        this.checkMyState();

        const seriesName = String(series || '').trim();
        if (!seriesName)
            throw new Error('series is empty');

        const result = await this.dbSearcher.getSeriesBookList(seriesName);
        const bookUids = (result.books || []).map((book) => book._uid).filter(Boolean);
        const added = await this.readingListStore.addBooks(userId, listId, bookUids);

        return {
            list: this.readingListStore.listStats(added.item),
            series: seriesName,
            addedBooks: added.added,
        };
    }

    async extractBook(libFolder, libFile) {
        const outFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;

        libFolder = libFolder.replace(/\\/g, '/').replace(/\/\//g, '/');

        const file = libFile;
        const resolveFolder = async() => {
            const folder = `${this.config.libDir}/${libFolder}`;

            if (await fs.pathExists(folder))
                return folder;

            if (path.extname(folder).toLowerCase() === '.zip') {
                const sevenZipFolder = `${folder.substring(0, folder.length - 4)}.7z`;
                if (await fs.pathExists(sevenZipFolder))
                    return sevenZipFolder;
            }

            return folder;
        };

        const folder = await resolveFolder();
        
        const fullPath = `${folder}/${file}`;

        if (!file || await fs.pathExists(fullPath)) {// С„Р°Р№Р» РµСЃС‚СЊ РЅР° РґРёСЃРєРµ
            
            await fs.copy(fullPath, outFile);
            return outFile;
        } else {// С„Р°Р№Р» РІ zip-Р°СЂС…РёРІРµ
            const zipReader = new ZipReader();
            await zipReader.open(folder, false);

            try {
                const extract = async(entryFilePath) => {
                    try {
                        await fs.remove(outFile);
                        await zipReader.extractToFile(entryFilePath, outFile);
                    } catch(e) {
                        await fs.remove(outFile);
                    }
                };

                await extract(file);

                if (!await fs.pathExists(outFile)) {//РЅРµ СѓРґР°Р»РѕСЃСЊ РЅР°Р№С‚Рё РІ Р°СЂС…РёРІРµ, РїРѕРїСЂРѕР±СѓРµРј РёРјСЏ С„Р°Р№Р»Р° РІ РєРѕРґРёСЂРѕРІРєРµ cp866
                    await extract(iconv.encode(file, 'cp866').toString());
                }

                if (!await fs.pathExists(outFile))
                    throw new Error(`file not found in archive: ${file}`);

                return outFile;
            } finally {
                await zipReader.close();
            }
        }
    }

    async ensureFblibraryArchives(subDir) {
        if (!this.fblibraryArchives)
            this.fblibraryArchives = {};

        if (!this.fblibraryArchives[subDir] || !this.fblibraryArchives[subDir].length) {
            const result = [];
            const dir = `${this.config.libDir}/${subDir}`;

            if (await fs.pathExists(dir)) {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const match = file.match(/(\d+)-(\d+)\.(zip|7z)$/i);
                    if (!match)
                        continue;

                    result.push({
                        file: `${dir}/${file}`,
                        from: parseInt(match[1], 10),
                        to: parseInt(match[2], 10),
                    });
                }
            }

            result.sort((a, b) => a.from - b.from);
            this.fblibraryArchives[subDir] = result;
        }
    }

    async getFblibraryArchive(subDir, libid) {
        return (await this.getFblibraryArchives(subDir, libid))[0];
    }

    async getFblibraryArchives(subDir, libid) {
        await this.ensureFblibraryArchives(subDir);

        return this.fblibraryArchives[subDir]
            .filter(item => libid >= item.from && libid <= item.to)
            .sort((a, b) => {
                const aspan = a.to - a.from;
                const bspan = b.to - b.from;
                if (aspan !== bspan)
                    return aspan - bspan;

                return a.from - b.from;
            });
    }

    async getFblibraryImages(libid) {
        const archives = await this.getFblibraryArchives('images', libid);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const prefix = `${libid}/`;
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(prefix))
                    .map(entry => entry.name)
                    .sort((a, b) => {
                        const ai = parseInt(a.substring(prefix.length), 10);
                        const bi = parseInt(b.substring(prefix.length), 10);
                        return ai - bi;
                    });

                const result = [];
                for (const entryName of entryNames) {
                    const id = entryName.substring(prefix.length);
                    if (!id)
                        continue;

                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        result.push(Object.assign({id}, await imageUtils.normalizeForFb2(data, this.config.tempDir)));
                    } catch(e) {
                        log(LM_ERR, `image ${entryName}: ${e.message}`);
                    }
                }

                if (result.length)
                    return result;
            } finally {
                await zipReader.close();
            }
        }

        return [];
    }

    async getFblibraryCover(libid) {
        const archives = await this.getFblibraryArchives('covers', libid);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            try {
                const data = await zipReader.extractToBuf(String(libid));
                return Object.assign({id: '0'}, await imageUtils.normalizeForFb2(data, this.config.tempDir));
            } catch(e) {
                // try next matching archive
            } finally {
                await zipReader.close();
            }
        }

        return null;
    }

    async ensureAuthorInfoArchives() {
        if (this.authorInfoArchives && this.authorPictureArchives && this.authorToArchive)
            return;

        const authorsDir = `${this.config.libDir}/etc/authors`;
        this.authorInfoArchives = [];
        this.authorPictureArchives = [];
        this.authorToArchive = new Map();

        if (!await fs.pathExists(authorsDir))
            return;

        const files = await fs.readdir(authorsDir);
        for (const file of files) {
            if (!/^\d+\.7z$/i.test(file))
                continue;

            const id = path.basename(file, path.extname(file));
            this.authorInfoArchives.push({
                id,
                file: `${authorsDir}/${file}`,
            });
        }

        const picturesDir = `${authorsDir}/pictures`;
        if (await fs.pathExists(picturesDir)) {
            const pictureFiles = await fs.readdir(picturesDir);
            for (const file of pictureFiles) {
                if (!/^\d+\.zip$/i.test(file))
                    continue;

                const id = path.basename(file, path.extname(file));
                this.authorPictureArchives.push({
                    id,
                    file: `${picturesDir}/${file}`,
                });
            }
        }

        this.authorInfoArchives.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
        this.authorPictureArchives.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

        for (const archive of this.authorInfoArchives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                for (const entry of Object.values(zipReader.entries)) {
                    const name = (entry.name || '').replace(/\\/g, '/');
                    if (!name || entry.isDirectory)
                        continue;

                    this.authorToArchive.set(name, archive.id);
                }
            } finally {
                await zipReader.close();
            }
        }
    }

    async getAuthorPictureByKey(authorKey, archiveId = '') {
        await this.ensureAuthorInfoArchives();

        const archives = [];
        if (archiveId) {
            const exactArchive = this.authorPictureArchives.find(item => item.id === String(archiveId));
            if (exactArchive)
                archives.push(exactArchive);
        }

        archives.push(...this.authorPictureArchives.filter(item => item.id !== String(archiveId)));

        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(`${authorKey}/`))
                    .map(entry => entry.name)
                    .sort();

                for (const entryName of entryNames) {
                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        const image = await imageUtils.normalizeForFb2(data, this.config.tempDir);
                        return `data:${image.contentType};base64,${image.data.toString('base64')}`;
                    } catch(e) {
                        log(LM_WARN, `author picture ${entryName}: ${e.message}`);
                    }
                }
            } finally {
                await zipReader.close();
            }
        }

        return '';
    }

    async findAuthorInfo(author) {
        await this.ensureAuthorInfoArchives();

        const hashed = flibraryAuthorHash(author);
        const archiveId = this.authorToArchive.get(hashed);
        if (!hashed || archiveId === undefined)
            return null;

        const archive = this.authorInfoArchives.find(item => item.id === String(archiveId));
        if (!archive)
            return null;

        const zipReader = new ZipReader();
        await zipReader.open(archive.file, false);

        let html = '';
        try {
            html = decodeHtmlBuffer(await zipReader.extractToBuf(hashed));
        } catch(e) {
            log(LM_WARN, `author info ${archive.file}:${hashed}: ${e.message}`);
            return null;
        } finally {
            await zipReader.close();
        }

        return {
            key: hashed,
            html,
            text: stripHtml(html),
            photo: await this.getAuthorPictureByKey(hashed, archive.id),
        };
    }

    async getAuthorInfo(authorId, author) {
        let authorName = author || '';
        if (!authorName && authorId) {
            const rows = await this.db.select({table: 'author', where: `@@id(${this.db.esc(authorId)})`});
            if (rows.length)
                authorName = rows[0].value;
        }

        const normalized = normalizeAuthorText(authorName);
        if (!normalized)
            return {authorInfo: null};

        const cacheKey = flibraryAuthorHash(authorName);
        if (this.authorInfoCache.has(cacheKey))
            return {authorInfo: this.authorInfoCache.get(cacheKey)};

        const authorInfo = await this.findAuthorInfo(authorName);
        this.authorInfoCache.set(cacheKey, authorInfo);
        return {authorInfo};
    }

    async injectFblibraryImages(bookFile, libid) {
        const images = await this.getFblibraryImages(libid);
        const cover = await this.getFblibraryCover(libid);
        if (!images.length && !cover)
            return false;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        let text = data.toString();

        if (!/<FictionBook[\s>]/i.test(text) || !/<\/FictionBook>\s*$/i.test(text))
            return false;

        const existingBinaryIds = new Set();
        for (const match of text.matchAll(/<binary\b[^>]*\bid=(['"])(.*?)\1/gi))
            existingBinaryIds.add(match[2]);

        const binaries = [];
        const assets = (cover && !images.some(image => image.id === cover.id) ? [cover, ...images] : images);
        for (const image of assets) {
            if (existingBinaryIds.has(image.id))
                continue;

            const base64 = image.data.toString('base64');
            binaries.push(`<binary id="${image.id}" content-type="${image.contentType}">${base64}</binary>`);
        }

        let coverLinked = false;
        if (cover) {
            coverLinked = /<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?[^"']+["'][^>]*\/?>[\s\S]*?<\/coverpage>/i.test(text);
            if (!coverLinked) {
                const titleInfoRe = /<title-info\b[^>]*>/i;
                const titleInfoMatch = text.match(titleInfoRe);
                if (titleInfoMatch) {
                    const hrefAttr = 'xlink:href';
                    const coverpage = `\n<coverpage><image ${hrefAttr}="#${cover.id}"/></coverpage>`;
                    const insertAt = titleInfoMatch.index + titleInfoMatch[0].length;
                    text = `${text.slice(0, insertAt)}${coverpage}${text.slice(insertAt)}`;
                    coverLinked = true;
                }
            }
        }

        if (!binaries.length && !coverLinked)
            return false;

        text = text.replace(/<\/FictionBook>\s*$/i, `\n${binaries.join('\n')}\n</FictionBook>`);
        await fs.writeFile(bookFile, text);

        return (binaries.length > 0 || coverLinked);
    }

    async restoreBook(bookUid, libFolder, libFile, downFileName) {
        const db = this.db;

        let extractedFile = '';
        let hash = '';

        if (!this.remoteLib) {
            extractedFile = await this.extractBook(libFolder, libFile);
            if (path.extname(libFile).toLowerCase() === '.fb2') {
                const libid = parseInt(path.basename(libFile, path.extname(libFile)), 10);
                if (libid)
                    await this.injectFblibraryImages(extractedFile, libid);
            }
            hash = await utils.getFileHash(extractedFile, 'sha256', 'hex');
        } else {
            hash = await this.remoteLib.downloadBook(bookUid);
        }

        const link = `${this.config.bookPathStatic}/${hash}`;
        const bookFile = `${this.config.bookDir}/${hash}`;
        const bookFileDesc = `${bookFile}.d.json`;

        if (!await fs.pathExists(bookFile) || !await fs.pathExists(bookFileDesc)) {
            if (!await fs.pathExists(bookFile) && extractedFile) {
                const tmpFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;
                await utils.gzipFile(extractedFile, tmpFile, 4);
                await fs.remove(extractedFile);
                await fs.move(tmpFile, bookFile, {overwrite: true});
            } else {
                await utils.touchFile(bookFile);
            }
        } else {
            if (extractedFile)
                await fs.remove(extractedFile);

            await utils.touchFile(bookFile);
            await utils.touchFile(bookFileDesc);
        }

        await fs.writeFile(bookFileDesc, JSON.stringify({libFolder, libFile, downFileName, assetVersion: bookAssetVersion}));

        await db.insert({
            table: 'file_hash',
            replace: true,
            rows: [
                {id: bookUid, hash},
            ]
        });

        return link;
    }

    async getBookLink(bookUid) {
        this.checkMyState();

        try {
            const db = this.db;
            let link = '';

            //РЅР°Р№РґРµРј downFileName, libFolder, libFile
            let rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
            if (!rows.length)
                throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');

            const book = rows[0];
            let downFileName = book.file;
            const authors = book.author.split(',');
            let author = authors[0];
            author = author.split(' ').filter(r => r.trim());
            for (let i = 1; i < author.length; i++)
                author[i] = `${(i === 1 ? ' ' : '')}${author[i][0]}.`;
            if (authors.length > 1)
                author.push(' Рё РґСЂ.');

            const at = [author.join(''), (book.title ? `_${book.title}` : '')];
            downFileName = utils.makeValidFileNameOrEmpty(at.filter(r => r).join(''))
                || utils.makeValidFileNameOrEmpty(at[0])
                || utils.makeValidFileNameOrEmpty(at[1])
                || downFileName;
            if (downFileName.length > 50)
                downFileName = `${downFileName.substring(0, 50)}_`;

            const ext = `.${book.ext}`;
            if (downFileName.substring(downFileName.length - ext.length) != ext)
                downFileName += ext;

            const libFolder = book.folder;
            const libFile = `${book.file}${ext}`;

            //РЅР°Р№РґРµРј С…РµС€
            rows = await db.select({table: 'file_hash', where: `@@id(${db.esc(bookUid)})`});
            if (rows.length) {//С…РµС€ РЅР°Р№РґРµРЅ РїРѕ bookUid
                const hash = rows[0].hash;
                const bookFile = `${this.config.bookDir}/${hash}`;
                const bookFileDesc = `${bookFile}.d.json`;

                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    try {
                        const desc = JSON.parse(await fs.readFile(bookFileDesc, 'utf8'));
                        if (desc.assetVersion === bookAssetVersion)
                            link = `${this.config.bookPathStatic}/${hash}`;
                    } catch(e) {
                        link = '';
                    }
                }
            }

            if (!link) {
                link = await this.restoreBook(bookUid, libFolder, libFile, downFileName);
            }

            if (!link)
                throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');

            return {link, libFolder, libFile, downFileName};
        } catch(e) {
            log(LM_ERR, `getBookLink error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');
            throw e;
        }
    }

    async getPreparedBookFile(bookUid, format = '') {
        const {link, downFileName} = await this.getBookLink(bookUid);
        const hash = path.basename(link);
        const gzipFile = `${this.config.bookDir}/${hash}`;
        const rawFile = `${gzipFile}.raw`;

        if (!await fs.pathExists(rawFile))
            await utils.gunzipFile(gzipFile, rawFile);

        await utils.touchFile(gzipFile);
        await utils.touchFile(rawFile);

        let rows = await this.db.select({table: 'book', where: `@@hash('_uid', ${this.db.esc(bookUid)})`});
        if (!rows.length)
            throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');

        let preparedFile = rawFile;
        let preparedFileName = downFileName;
        const targetFormat = String(format || '').toLowerCase();
        const sourceFormat = String(rows[0].ext || '').toLowerCase();

        if (targetFormat && targetFormat !== sourceFormat) {
            if (!bookConverter.canConvertTo(targetFormat))
                throw new Error(`РќРµРїРѕРґРґРµСЂР¶РёРІР°РµРјС‹Р№ С„РѕСЂРјР°С‚ РѕС‚РїСЂР°РІРєРё: ${targetFormat}`);

            if (!this.config.conversionEnabled)
                throw new Error('РљРѕРЅРІРµСЂС‚Р°С†РёСЏ РєРЅРёРі РѕС‚РєР»СЋС‡РµРЅР° РІ С‚РµРєСѓС‰РµРј РѕР±СЂР°Р·Рµ.');

            preparedFile = `${gzipFile}.${targetFormat}`;
            if (!await fs.pathExists(preparedFile)) {
                await bookConverter.convert({
                    inputFile: rawFile,
                    outputFile: preparedFile,
                    format: targetFormat,
                    sourceFileName: downFileName,
                });
            }
            preparedFileName = convertedFileName(downFileName, targetFormat);
            await utils.touchFile(preparedFile);
        }

        return {
            book: rows[0],
            rawFile: preparedFile,
            downFileName: preparedFileName,
        };
    }

    async sendBookToTelegram(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const chatId = String((currentUser && currentUser.telegramChatId) || this.config.telegramChatId || '').trim();
        if (!this.config.telegramBotToken || !chatId)
            throw new Error('РћС‚РїСЂР°РІРєР° РІ Telegram РЅРµ РЅР°СЃС‚СЂРѕРµРЅР°');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendDocument`;
        const form = new FormData();

        form.append('chat_id', chatId);
        form.append('caption', formatTemplate(this.config.telegramCaptionTemplate, book).trim());
        form.append('document', fs.createReadStream(rawFile), downFileName);

        const response = await axios.post(url, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 300000,
        });

        if (!response.data || response.data.ok !== true)
            throw new Error('Telegram API РЅРµ РїСЂРёРЅСЏР» С„Р°Р№Р»');

        return {success: true};
    }

    async sendBookToEmail(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const emailTo = String((currentUser && currentUser.emailTo) || this.config.emailTo || '').trim();
        if (!this.config.smtpHost || !emailTo)
            throw new Error('РћС‚РїСЂР°РІРєР° РЅР° email РЅРµ РЅР°СЃС‚СЂРѕРµРЅР°');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        const transporter = nodemailer.createTransport({
            host: this.config.smtpHost,
            port: this.config.smtpPort,
            secure: this.config.smtpSecure,
            auth: (this.config.smtpUser ? {
                user: this.config.smtpUser,
                pass: this.config.smtpPass,
            } : undefined),
        });

        const subject = [book.author, book.title].filter(Boolean).join(' - ') || downFileName;
        await transporter.sendMail({
            from: this.config.emailFrom || this.config.smtpUser || 'inpx-web@localhost',
            to: emailTo,
            subject: `РљРЅРёРіР°: ${subject}`,
            text: `Р’Рѕ РІР»РѕР¶РµРЅРёРё РєРЅРёРіР° "${book.title || downFileName}".`,
            attachments: [
                {
                    filename: downFileName,
                    path: rawFile,
                },
            ],
        });

        return {success: true};
    }

    extractFb2Contents(parser) {
        const result = [];
        const getNodeText = (node) => {
            const parts = [];
            node.eachDeepSelf((item) => {
                if (item.type === parser.TEXT || item.type === parser.CDATA)
                    parts.push(item.value);
            });

            return parts.join(' ').replace(/\s+/g, ' ').trim();
        };

        const walk = (sections, level = 0) => {
            for (const section of sections) {
                const titleNode = section.$$('\/title/');
                let title = '';
                if (titleNode && titleNode.count)
                    title = getNodeText(titleNode);

                if (title)
                    result.push({title, level});

                const childSections = section.$$array('/section');
                if (childSections.length)
                    walk(childSections, level + 1);
            }
        };

        for (const body of parser.$$array('/body'))
            walk(body.$$array('/section'));

        return result.slice(0, 200);
    }

    extractFb2NodeText(node, parser) {
        if (!node)
            return '';

        const parts = [];
        node.eachDeepSelf((item) => {
            if (item.type === parser.TEXT || item.type === parser.CDATA)
                parts.push(item.value);
        });

        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    extractFb2AnnotationMeta(parser) {
        const result = {
            epigraph: [],
            epigraphAuthor: '',
            stats: {
                letters: 0,
                words: 0,
                pages: 0,
                images: 0,
            },
        };

        const topEpigraphs = parser.$$array('/body/epigraph');
        if (topEpigraphs.length) {
            const lines = [];
            let author = '';

            for (const epigraph of topEpigraphs) {
                for (const p of epigraph.$$array('/p')) {
                    const text = this.extractFb2NodeText(p, parser);
                    if (text)
                        lines.push(text);
                }

                if (!author) {
                    const textAuthor = epigraph.$$('\/text-author/');
                    const value = this.extractFb2NodeText(textAuthor, parser);
                    if (value)
                        author = value;
                }
            }

            result.epigraph = lines.slice(0, 12);
            result.epigraphAuthor = author;
        }

        const textParts = [];
        for (const body of parser.$$array('/body')) {
            body.eachDeepSelf((item) => {
                if (item.type === parser.TEXT || item.type === parser.CDATA)
                    textParts.push(item.value);
            });
        }

        const fullText = textParts.join(' ').replace(/\s+/g, ' ').trim();
        const letters = fullText.replace(/\s+/g, '').length;
        const words = (fullText ? fullText.split(/\s+/).filter(Boolean).length : 0);
        const pages = (words ? Math.max(1, Math.round((words / 250) * 10) / 10) : 0);

        let images = 0;
        for (const node of parser.$$array('/binary')) {
            const attrs = node.attrs() || {};
            const contentType = String(attrs['content-type'] || '').toLowerCase();
            if (contentType.startsWith('image/'))
                images++;
        }

        result.stats = {letters, words, pages, images};

        return result;
    }

    async getReviewArchives() {
        if (this.reviewArchives !== null)
            return this.reviewArchives;

        const reviewsDir = `${this.config.libDir}/reviews`;
        const result = [];

        if (!await fs.pathExists(reviewsDir)) {
            this.reviewArchives = result;
            return result;
        }

        const files = await fs.readdir(reviewsDir);
        for (const file of files.sort()) {
            if (!/\.(7z|zip)$/i.test(file))
                continue;

            result.push({
                id: path.basename(file, path.extname(file)),
                file: `${reviewsDir}/${file}`,
            });
        }

        this.reviewArchives = result;
        return result;
    }

    async ensureReviewIndex() {
        if (this.reviewToArchives !== null)
            return this.reviewToArchives;

        this.reviewToArchives = new Map();
        const archives = await this.getReviewArchives();

        for (const archive of archives) {
            const zipReader = new ZipReader();
            try {
                await zipReader.open(archive.file);
                for (const item of Object.values(zipReader.entries || {})) {
                    const entryName = String(item.name || '').replace(/\\/g, '/');
                    if (!entryName || item.isDirectory)
                        continue;

                    const list = this.reviewToArchives.get(entryName) || [];
                    list.push({archive: archive.file, entryName});
                    this.reviewToArchives.set(entryName, list);
                }
            } catch(e) {
                log(LM_WARN, `review archive ${archive.file}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return this.reviewToArchives;
    }

    async getBookReviews(book) {
        const entryKey = `${book.folder}#${book.file}.${book.ext}`;
        const reviewIndex = await this.ensureReviewIndex();
        const matches = reviewIndex.get(entryKey) || [];
        const reviews = [];

        for (const match of matches) {
            const zipReader = new ZipReader();
            try {
                await zipReader.open(match.archive, false);
                const raw = await zipReader.extractToBuf(match.entryName);
                const parsed = JSON.parse(decodeArchiveText(raw));
                if (!Array.isArray(parsed))
                    continue;

                for (const item of parsed) {
                    if (!item || typeof(item) !== 'object')
                        continue;

                    reviews.push({
                        name: String(item.name || '').trim() || 'РђРЅРѕРЅРёРј',
                        time: String(item.time || '').trim(),
                        text: String(item.text || '').replace(/<br\s*\/?>/gi, '\n').trim(),
                    });
                }
            } catch(e) {
                log(LM_WARN, `review entry ${match.archive}:${match.entryName}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return reviews;
    }

    async getBookInfo(bookUid) {
        this.checkMyState();

        try {
            const db = this.db;

            let bookInfo = await this.getBookLink(bookUid);
            const hash = path.basename(bookInfo.link);
            const bookFile = `${this.config.bookDir}/${hash}`;
            const bookFileInfo = `${bookFile}.i.json`;

            let rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
            if (!rows.length)
                throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');
            const book = rows[0];

            const restoreBookInfo = async(info) => {
                const result = {};

                result.book = book;
                result.cover = '';
                result.fb2 = false;
                result.contents = [];
                result.annotationMeta = null;
                result.reviews = [];
                result.infoVersion = bookInfoVersion;
                let parser = null;

                if (book.ext == 'fb2') {
                    const {fb2, cover, coverExt} = await this.fb2Helper.getDescAndCover(bookFile);
                    parser = fb2;
                    result.fb2 = fb2.rawNodes;
                    result.contents = this.extractFb2Contents(fb2);
                    result.annotationMeta = this.extractFb2AnnotationMeta(fb2);

                    if (cover) {
                        result.cover = `${this.config.bookPathStatic}/${hash}${coverExt}`;
                        await fs.writeFile(`${bookFile}${coverExt}`, cover);
                    }
                }

                result.reviews = await this.getBookReviews(book);

                Object.assign(info, result);

                await fs.writeFile(bookFileInfo, JSON.stringify(info));

                if (this.config.branch === 'development') {
                    await fs.writeFile(`${bookFile}.dev`, `${JSON.stringify(info, null, 2)}\n\n${parser ? parser.toString({format: true}) : ''}`);
                }
            };

            if (!await fs.pathExists(bookFileInfo)) {
                await restoreBookInfo(bookInfo);
            } else {
                await utils.touchFile(bookFileInfo);
                const info = await fs.readFile(bookFileInfo, 'utf-8');
                const tmpInfo = JSON.parse(info);

                //РїСЂРѕРІРµСЂРёРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ С„Р°Р№Р»Р° РѕР±Р»РѕР¶РєРё, РІРѕСЃСЃС‚Р°РЅРѕРІРёРј РµСЃР»Рё РЅРµС‚Сѓ
                let coverFile = '';
                if (tmpInfo.cover)
                    coverFile = `${this.config.publicFilesDir}${tmpInfo.cover}`;

                if (book.id != tmpInfo.book.id || tmpInfo.infoVersion !== bookInfoVersion || (coverFile && !await fs.pathExists(coverFile))) {
                    await restoreBookInfo(bookInfo);
                } else {
                    bookInfo = tmpInfo;
                }
            }

            return {bookInfo};
        } catch(e) {
            log(LM_ERR, `getBookInfo error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Р¤Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ');
            throw e;
        }
    }

    async getInpxFile(params) {
        let data = null;
        if (params.inpxFileHash && this.inpxFileHash && params.inpxFileHash === this.inpxFileHash) {
            data = false;
        }

        if (data === null)
            data = await fs.readFile(this.config.inpxFile, 'base64');

        return {data};
    }

    logServerStats() {
        try {
            const memUsage = process.memoryUsage().rss/(1024*1024);//Mb
            let loadAvg = os.loadavg();
            loadAvg = loadAvg.map(v => v.toFixed(2));

            log(`Server stats [ memUsage: ${memUsage.toFixed(2)}MB, loadAvg: (${loadAvg.join(', ')}) ]`);
        } catch (e) {
            log(LM_ERR, e.message);
        }
    }
    
    async periodicLogServerStats() {
        if (!this.config.logServerStats)
            return;

        while (1) {// eslint-disable-line
            this.logServerStats();
            await utils.sleep(60*1000);
        }
    }

    async cleanDir(config) {
        const {dir, maxSize} = config;

        const list = await fs.readdir(dir);

        let size = 0;
        let files = [];
        //С„РѕСЂРјРёСЂСѓРµРј СЃРїРёСЃРѕРє
        for (const filename of list) {
            const filePath = `${dir}/${filename}`;
            const stat = await fs.stat(filePath);
            if (!stat.isDirectory()) {
                size += stat.size;
                files.push({name: filePath, stat});
            }
        }

        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        let i = 0;
        //СѓРґР°Р»СЏРµРј
        while (i < files.length && size > maxSize) {
            const file = files[i];
            const oldFile = file.name;
            await fs.remove(oldFile);
            size -= file.stat.size;
            i++;
        }

        if (i) {
            log(LM_WARN, `clean dir ${dir}, maxSize=${maxSize}, found ${files.length} files, total size=${size}`);
            log(LM_WARN, `removed ${i} files`);
        }
    }

    async periodicCleanDir(dirConfig) {
        try {
            for (const config of dirConfig) 
                await fs.ensureDir(config.dir);

            let lastCleanDirTime = 0;
            while (1) {// eslint-disable-line no-constant-condition
                //С‡РёСЃС‚РєР° РїР°РїРѕРє
                if (Date.now() - lastCleanDirTime >= cleanDirInterval) {
                    for (const config of dirConfig) {
                        try {
                            await this.cleanDir(config);
                        } catch(e) {
                            log(LM_ERR, e.stack);
                        }
                    }

                    lastCleanDirTime = Date.now();
                }

                await utils.sleep(60*1000);//РёРЅС‚РµСЂРІР°Р» РїСЂРѕРІРµСЂРєРё 1 РјРёРЅСѓС‚Р°
            }
        } catch (e) {
            log(LM_FATAL, e.message);
            asyncExit.exit(1);
        }
    }

    async periodicCheckInpx() {
        const inpxCheckInterval = this.config.inpxCheckInterval;
        if (!inpxCheckInterval)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            try {
                while (this.myState != ssNormal)
                    await utils.sleep(1000);

                if (this.remoteLib) {
                    await this.remoteLib.downloadInpxFile();
                }

                const newInpxHash = await this.inpxHashCreator.getHash();

                const dbConfig = await this.dbConfig();
                const currentInpxHash = (dbConfig.inpxHash ? dbConfig.inpxHash : '');

                if (newInpxHash !== currentInpxHash) {
                    log('inpx file: changes found, recreating DB');
                    await this.recreateDb();
                } else {
                    //log('inpx file: no changes');
                }
            } catch(e) {
                log(LM_ERR, `periodicCheckInpx: ${e.message}`);
            }

            await utils.sleep(inpxCheckInterval*60*1000);
        }
    }

    async periodicCheckNewRelease() {
        const checkReleaseLink = this.config.checkReleaseLink;
        if (!checkReleaseLink)
            return;
        const down = new FileDownloader(1024*1024);
        const channel = resolveReleaseChannel(this.config);
        const request = buildReleaseCheckRequest(checkReleaseLink, channel);
        if (!request)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            try {
                let release = await down.load(request.url);
                release = JSON.parse(release.toString());
                const latestRelease = pickReleaseFromPayload(release, channel);

                if (latestRelease && compareReleaseVersions(latestRelease.tag_name, this.config.version) > 0) {
                    this.config.latestVersion = latestRelease.tag_name;
                    this.config.latestReleaseLink = latestRelease.html_url || this.config.latestReleaseLink;
                } else {
                    this.config.latestVersion = '';
                }
            } catch(e) {
                log(LM_ERR, `periodicCheckNewRelease: ${e.message}`);
            }

            await utils.sleep(checkReleaseInterval);
        }
    }
}

module.exports = WebWorker;


