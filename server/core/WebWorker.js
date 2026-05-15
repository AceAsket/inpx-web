const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const _ = require('lodash');
const iconv = require('iconv-lite');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const yazl = require('yazl');

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
const appLogger = new (require('./AppLogger'))();//singleton
const log = appLogger.log;
const utils = require('./utils');
const genreTree = require('./genres');
const Fb2Helper = require('./fb2/Fb2Helper');
const ConfigManager = require('../config');
const {getEnabledLibrarySources} = require('./LibrarySources');

//server states
const ssNormal = 'normal';
const ssDbLoading = 'db_loading';
const ssDbCreating = 'db_creating';

const stateToText = {
    [ssNormal]: '',
    [ssDbLoading]: 'Загрузка поисковой базы',
    [ssDbCreating]: 'Создание поисковой базы',
};

const checkReleaseInterval = 7*60*60*1000;//каждые 7 часов
const discoveryCacheTtl = 15*60*1000;//15 minutes
const externalDiscoveryCacheVersion = 'v4';
const bookAssetVersion = 'fblibrary-assets-v2';
const bookInfoVersion = 'fb2-binaries-v6';

function cleanDirInterval(config) {
    const minutes = parseFloat(config.cacheCleanInterval);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return 0;

    return minutes*60*1000;
}

function cleanDirNextAlignedDelay(config, now = new Date()) {
    const interval = cleanDirInterval(config);
    if (!interval)
        return null;

    const date = now instanceof Date ? now : new Date(now);
    const localTime = date.getTime() - date.getTimezoneOffset()*60*1000;
    const remainder = ((localTime % interval) + interval) % interval;
    return Math.round(remainder === 0 ? 0 : interval - remainder);
}

function parseCronField(field, min, max, options = {}) {
    const text = String(field || '').trim().toLowerCase();
    const values = new Set();
    const aliases = options.aliases || {};
    const normalize = options.normalize || (value => value);
    const inputMin = options.inputMin === undefined ? min : options.inputMin;
    const inputMax = options.inputMax === undefined ? max : options.inputMax;
    const parseValue = (value) => {
        const normalized = aliases[String(value || '').toLowerCase()];
        const number = parseInt(normalized !== undefined ? normalized : value, 10);
        if (!Number.isFinite(number))
            throw new Error(`Некорректное значение cron: ${value}`);

        if (number < inputMin || number > inputMax)
            throw new Error(`Значение cron вне диапазона: ${value}`);

        return number;
    };

    if (!text)
        throw new Error('Пустое поле cron');

    for (const token of text.split(',')) {
        const item = token.trim();
        if (!item)
            throw new Error('Пустое значение cron');

        const [rangeText, stepText] = item.split('/');
        const step = stepText === undefined ? 1 : parseInt(stepText, 10);
        if (!Number.isFinite(step) || step <= 0)
            throw new Error(`Некорректный шаг cron: ${item}`);

        let start;
        let end;
        if (rangeText === '*') {
            start = min;
            end = max;
        } else if (rangeText.includes('-')) {
            const parts = rangeText.split('-');
            if (parts.length !== 2)
                throw new Error(`Некорректный диапазон cron: ${item}`);

            start = parseValue(parts[0]);
            end = parseValue(parts[1]);
        } else {
            start = parseValue(rangeText);
            end = start;
        }

        if (start > end)
            throw new Error(`Некорректный диапазон cron: ${item}`);

        for (let value = start; value <= end; value += step) {
            const normalized = normalize(value);
            if (normalized < min || normalized > max)
                throw new Error(`Значение cron вне диапазона: ${value}`);

            values.add(normalized);
        }
    }

    return values;
}

function parseCleanDirCron(schedule) {
    const fields = String(schedule || '').trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error('Расписание кэша должно быть в формате cron из 5 полей: минута час день месяц день-недели');

    const monthAliases = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const weekAliases = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };

    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dayOfMonth: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12, {aliases: monthAliases}),
        dayOfWeek: parseCronField(fields[4], 0, 6, {
            aliases: weekAliases,
            inputMax: 7,
            normalize: value => value === 7 ? 0 : value,
        }),
        dayOfMonthAny: fields[2] === '*',
        dayOfWeekAny: fields[4] === '*',
    };
}

function cleanDirCronMatches(parsed, date) {
    if (!parsed.minute.has(date.getMinutes()) || !parsed.hour.has(date.getHours()) || !parsed.month.has(date.getMonth() + 1))
        return false;

    const dayOfMonthMatches = parsed.dayOfMonth.has(date.getDate());
    const dayOfWeekMatches = parsed.dayOfWeek.has(date.getDay());
    if (parsed.dayOfMonthAny && parsed.dayOfWeekAny)
        return true;
    if (parsed.dayOfMonthAny)
        return dayOfWeekMatches;
    if (parsed.dayOfWeekAny)
        return dayOfMonthMatches;

    return dayOfMonthMatches || dayOfWeekMatches;
}

function cleanDirNextCronDelay(schedule, now = new Date()) {
    const parsed = parseCleanDirCron(schedule);
    const current = now instanceof Date ? now : new Date(now);
    const candidate = new Date(current.getTime());
    candidate.setSeconds(0, 0);

    if (cleanDirCronMatches(parsed, candidate))
        return 0;

    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 366*24*60; i++) {
        if (cleanDirCronMatches(parsed, candidate))
            return Math.max(0, candidate.getTime() - current.getTime());

        candidate.setMinutes(candidate.getMinutes() + 1);
    }

    throw new Error('Не удалось найти следующий запуск cron в пределах года');
}

function cleanDirSchedule(config) {
    if (!utils.hasProp(config, 'cacheCleanSchedule'))
        return null;

    return String(config.cacheCleanSchedule || '').trim();
}

function cleanDirNextScheduledDelay(config, now = new Date()) {
    const schedule = cleanDirSchedule(config);
    if (schedule !== null)
        return schedule ? cleanDirNextCronDelay(schedule, now) : null;

    return cleanDirNextAlignedDelay(config, now);
}

function cleanDirMaxSize(value) {
    if (value === null || value === undefined || value === '')
        return null;

    const maxSize = Number(value);
    return (Number.isFinite(maxSize) && maxSize >= 0 ? maxSize : null);
}

function cleanDirTargetRatio(value) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio <= 0)
        return 0.8;

    return Math.max(0.1, Math.min(1, ratio));
}

function cleanDirTargetSize(maxSize, value, ratio) {
    const targetSize = cleanDirMaxSize(value);
    if (targetSize !== null)
        return Math.max(0, Math.min(maxSize, targetSize));

    return Math.floor(maxSize * cleanDirTargetRatio(ratio));
}

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

function getUserDisplayName(user = {}) {
    const name = String(user.name || '').trim();
    if (isAnonymousDefaultUser(user))
        return 'Без профиля';
    return name;
}

function isAnonymousDefaultUser(user = {}) {
    const name = String(user.name || '').trim();
    return user.id === 'default' && (name === 'Основной' || name === 'Без профиля') && !user.login && !user.passwordHash;
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

function getExternalItemKind(sourceUrl = '', itemUrl = '') {
    const absoluteUrl = String(itemUrl || '').trim();
    if (!absoluteUrl)
        return '';

    try {
        const source = new URL(String(sourceUrl || '').trim() || absoluteUrl);
        const target = new URL(absoluteUrl, source);
        const hostname = String(target.hostname || '').toLowerCase();
        const pathname = String(target.pathname || '').toLowerCase();

        if (hostname.endsWith('litres.ru')) {
            if (/\/book\//.test(pathname))
                return 'book';
            if (/\/genre\//.test(pathname))
                return 'genre';
            return '';
        }

        return 'book';
    } catch (e) {
        return 'book';
    }
}

function sanitizeExternalBrowseUrl(baseUrl = '', browseUrl = '') {
    const rawBaseUrl = String(baseUrl || '').trim();
    const rawBrowseUrl = String(browseUrl || '').trim();
    if (!rawBaseUrl || !rawBrowseUrl)
        return '';

    try {
        const base = new URL(rawBaseUrl);
        const target = new URL(rawBrowseUrl, base);
        if (String(base.hostname || '').toLowerCase() !== String(target.hostname || '').toLowerCase())
            return '';

        target.hash = '';
        return target.toString();
    } catch (e) {
        return '';
    }
}

function buildExternalFlagsByUrl(sourceUrl = '') {
    const normalized = String(sourceUrl || '').trim().toLowerCase();
    return {
        isNew: /\/showroom\/new\/|\/catalog\/new\/|\/novinki\/|\/new\/|[?&]new\b/.test(normalized),
        isBestseller: /\/popular\/|\/bestsellers?\/|best[_-]?seller|хиты|popular/.test(normalized),
    };
}

function buildExternalFeedIdentity(item = {}) {
    const title = normalizeDiscoveryText(item.title || '');
    if (!title)
        return '';

    const kind = String(item.kind || 'book').trim().toLowerCase() || 'book';
    const author = normalizeAuthorText(item.author || '');
    if (author)
        return `${kind}|${title}|${author}`;

    const url = String(item.url || '').trim().toLowerCase();
    return `${kind}|${title}|${url}`;
}

function dedupeExternalFeedItems(items = [], limit = 8) {
    const result = [];
    const seen = new Set();

    for (const item of items) {
        const title = decodeExternalText(item.title || '');
        const url = String(item.url || '').trim();
        if (!title || !url)
            continue;

        const key = buildExternalFeedIdentity(Object.assign({}, item, {title}))
            || `${title.toLowerCase()}|${url.toLowerCase()}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(Object.assign({}, item, {title}));
        if (result.length >= limit)
            break;
    }

    return result;
}

function buildExternalGenreOptions(items = [], sourceUrl = '') {
    const result = [];
    const seen = new Set();

    for (const item of (Array.isArray(items) ? items : [])) {
        if (String(item && item.kind || '').trim().toLowerCase() !== 'genre')
            continue;

        const label = decodeExternalText(item.title || item.name || '');
        const url = sanitizeExternalBrowseUrl(sourceUrl, item.url || item.link || '');
        if (!label || !url || seen.has(url))
            continue;

        seen.add(url);
        result.push({
            label,
            value: url,
        });
    }

    return result;
}

function limitExternalFeedItemsByBooks(items = [], bookLimit = 8) {
    const result = [];
    const maxBooks = Math.max(1, parseInt(bookLimit, 10) || 8);
    let bookCount = 0;
    let hasMore = false;

    for (const item of (Array.isArray(items) ? items : [])) {
        const kind = String(item && item.kind || 'book').trim().toLowerCase() || 'book';
        if (kind !== 'genre') {
            if (bookCount >= maxBooks) {
                hasMore = true;
                break;
            }
            bookCount++;
        }

        result.push(item);
    }

    return {items: result, hasMore};
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
        .replace(/ё/g, 'е')
        .replace(/[()[\]{}.,;:!?'"`«»]/g, ' ')
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
        .replace(/ё/g, 'е')
        .replace(/&[a-z0-9#]+;/gi, ' ')
        .replace(/[^a-zа-я0-9]+/gi, ' ')
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

function getAuthorArchiveEntryHash(entryName = '') {
    const normalized = String(entryName || '').replace(/\\/g, '/');
    const baseName = path.basename(normalized, path.extname(normalized)).toLowerCase();
    return /^[a-f0-9]{32}$/.test(baseName) ? baseName : '';
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
            this.sharedDiscoveryConfig = null;
            this.authorInfoArchives = null;
            this.authorPictureArchives = null;
            this.authorToArchive = null;
            this.reviewArchives = null;
            this.reviewToArchives = null;
            this.cacheCleanTimer = null;
            this.cacheCleanRunning = false;

            this.wState = this.workerState.getControl('server_state');
            this.myState = '';
            this.db = null;
            this.dbSearcher = null;
            this.adminEvents = [];
            const cpuUsage = process.cpuUsage();
            this.adminCpuSnapshot = {
                at: Date.now(),
                totalMicros: cpuUsage.user + cpuUsage.system,
            };
            appLogger.setEventListener((level, message) => {
                const eventLevel = (level >= LM_ERR ? 'error' : 'warn');
                this.addAdminEvent(eventLevel, 'system', message);
            });

            asyncExit.add(this.closeDb.bind(this));

            this.loadOrCreateDb();//no await
            this.periodicLogServerStats();//no await

            this.periodicCleanDir();//no await
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

    async getIndexStatus() {
        const workerState = this.wState.get() || {};
        const ready = this.myState === ssNormal && !!this.db && !!this.dbSearcher;
        const result = {
            ready,
            state: this.myState || workerState.state || '',
            serverMessage: workerState.serverMessage || '',
            job: workerState.job || '',
            jobMessage: workerState.jobMessage || '',
            jobStep: workerState.jobStep || 0,
            jobStepCount: workerState.jobStepCount || 0,
            progress: workerState.progress || 0,
            recsLoaded: workerState.recsLoaded || 0,
            inpxFileHash: this.inpxFileHash || '',
            dbLoaded: !!this.db,
            searchReady: !!this.dbSearcher,
            version: this.config.version,
            sources: (Array.isArray(this.config.librarySources) ? this.config.librarySources : []).map(source => ({
                id: source.id,
                name: source.name,
                enabled: source.enabled !== false,
            })),
        };

        if (ready) {
            try {
                const dbConfig = await this.dbConfig();
                result.inpxHash = dbConfig.inpxHash || '';
                result.stats = dbConfig.stats || {};
                result.inpxInfo = dbConfig.inpxInfo || {};
            } catch (e) {
                result.ready = false;
                result.error = e.message;
            }
        }

        return result;
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

            //проверим полный InxpHash (включая фильтр и версию БД)
            //для этого заглянем в конфиг внутри БД, если он есть
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

            //удалим БД если нужно
            if (config.recreateDb || recreate)
                await fs.remove(dbPath);

            //пересоздаем БД из INPX если нужно
            if (!await fs.pathExists(dbPath)) {
                await this.createDb(dbPath);
                utils.freeMemory();
            }

            //загружаем БД
            this.setMyState(ssDbLoading);
            log('Searcher DB loading');

            const db = new JembaDbThread();//в отдельном потоке
            await db.lock({
                dbPath,
                softLock: true,

                tableDefaults: {
                    cacheSize: config.dbCacheSize,
                },
            });

            try {
                //открываем таблицы
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

            //поисковый движок
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
        await this.applyMetadataOverridesToSearchResult(result);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async bookSearch(query) {
        this.checkMyState();

        const result = await this.dbSearcher.bookSearch(query);
        await this.applyMetadataOverridesToSearchResult(result);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async opdsQuery(from, query) {
        this.checkMyState();

        return await this.dbSearcher.opdsQuery(from, query);
    }

    async getAuthorBookList(authorId, author, query = {}) {
        this.checkMyState();

        const result = await this.dbSearcher.getAuthorBookList(authorId, author, query);
        await this.applyMetadataOverridesToSearchResult(result);
        return result;
    }

    async getAuthorSeriesList(authorId, query = {}) {
        this.checkMyState();

        return await this.dbSearcher.getAuthorSeriesList(authorId, query);
    }

    async getSeriesBookList(series, query = {}) {
        this.checkMyState();

        const result = await this.dbSearcher.getSeriesBookList(series, query);
        await this.applyMetadataOverridesToSearchResult(result);
        return result;
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

            //добавим к жанрам те, что нашлись при парсинге
            const genreParsed = new Set();
            let rows = await db.select({table: 'genre', map: `(r) => ({value: r.value})`});
            for (const row of rows) {
                genreParsed.add(row.value);

                if (!genreValues.has(row.value))
                    last.value.push({name: row.value, value: row.value});
            }

            //уберем те, которые не нашлись при парсинге
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
            externalBrowseUrl: '',
            externalBrowseName: '',
        }, this.config.discovery || {}, this.sharedDiscoveryConfig || {}, options || {});

        discovery.enabled = (discovery.enabled !== false);
        discovery.shelfLimit = Math.max(1, Math.min(parseInt(discovery.shelfLimit, 10) || 8, 24));
        discovery.externalLimit = Math.max(1, Math.min(parseInt(discovery.externalLimit, 10) || discovery.shelfLimit, 120));
        discovery.externalSource = String(discovery.externalSource || 'none').trim().toLowerCase();
        if (discovery.externalSource && discovery.externalSource !== 'none')
            discovery.externalSource = 'web-page';
        discovery.externalUrl = String(discovery.externalUrl || '').trim();
        discovery.externalName = String(discovery.externalName || '').trim();
        discovery.externalTtlMinutes = Math.max(1440, Math.min(parseInt(discovery.externalTtlMinutes, 10) || 1440, 10080));
        discovery.externalBrowseUrl = sanitizeExternalBrowseUrl(discovery.externalUrl, discovery.externalBrowseUrl || '');
        discovery.externalBrowseName = (discovery.externalBrowseUrl ? String(discovery.externalBrowseName || '').trim() : '');

        return discovery;
    }

    async getSharedDiscoveryConfig() {
        this.sharedDiscoveryConfig = await this.readingListStore.getSharedDiscoveryConfig();
        return _.cloneDeep(this.sharedDiscoveryConfig);
    }

    async getDiscoveryConfigForRequest(options = {}) {
        await this.getSharedDiscoveryConfig();
        const requestOptions = Object.assign({}, options || {});
        const hasAdminExternalOverrides = (
            Object.prototype.hasOwnProperty.call(requestOptions, 'externalSource')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalName')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalUrl')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalTtlMinutes')
        );

        if (!hasAdminExternalOverrides)
            return this.getDiscoveryConfig(requestOptions);

        try {
            await this.requireAdmin(requestOptions.userId, requestOptions.profileAccessToken);
        } catch (e) {
            delete requestOptions.externalSource;
            delete requestOptions.externalName;
            delete requestOptions.externalUrl;
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
            return 'Добавлена сегодня';
        if (diffDays === 1)
            return 'Добавлена 1 день назад';
        if (diffDays < 5)
            return `Добавлена ${diffDays} дня назад`;
        return `Добавлена ${diffDays} дней назад`;
    }

    getDiscoveryMatchLabel(kind = '') {
        switch (String(kind || '').trim()) {
            case 'exact':
                return 'Точное совпадение';
            case 'title-author':
                return 'Совпадение по названию и автору';
            case 'title':
                return 'Совпадение по названию';
            case 'title-partial':
                return 'Частичное совпадение по названию';
            case 'missing-local':
                return 'Нет в локальной библиотеке';
            case 'genre':
                return 'Жанр внешнего каталога';
            default:
                return 'Совпадение с внешней витриной';
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
                    reasons.push(`В чтении: ${popularityInfo.progressCount}`);
                if (popularityInfo.listCount > 0)
                    reasons.push(`В списках: ${popularityInfo.listCount}`);
                if (popularityInfo.finishedCount > 0)
                    reasons.push(`Прочитано: ${popularityInfo.finishedCount}`);
            }
            if (book.librate)
                reasons.push(`Оценка библиотеки ${book.librate}/5`);
        }

        if (options.discoverySource) {
            const matchLabel = this.getDiscoveryMatchLabel(options.matchKind);
            if (options.matchKind === 'missing-local')
                reasons.unshift(`${options.discoverySource} · ${matchLabel}`);
            else
                reasons.unshift(`Источник ${options.discoverySource} · ${matchLabel}`);
        }

        result.discoveryReason = reasons.join(' · ');
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

    async rememberPersistedDiscovery(key, loader, ttl = discoveryCacheTtl, options = {}) {
        const forceRefresh = !!(options && options.forceRefresh);
        const cached = this.discoveryCache.get(key);
        if (!forceRefresh && cached && Date.now() - cached.time < ttl)
            return _.cloneDeep(cached.value);

        const diskCache = await this.getDiscoveryDiskCache();
        const persisted = diskCache[key];
        if (!forceRefresh && persisted && Date.now() - persisted.time < ttl) {
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
                    const sourceKey = row.sourceId || '';
                    if (row.libid)
                        return 'libid:' + sourceKey + ':' + row.libid;

                    const parts = [
                        sourceKey,
                        row.folder || '',
                        row.file || '',
                        row.ext || '',
                        String(row.insno || 0),
                    ];
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
                title: 'Новинки библиотеки',
                subtitle: 'Последние поступления в индекс',
                mode: 'newest',
            },
            popular: {
                id: 'popular',
                title: 'Популярное в библиотеке',
                subtitle: 'Пилот по локальной оценке библиотеки',
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

                    const itemUrl = toAbsoluteExternalUrl(sourceUrl, item.url || item.link);
                    const itemKind = getExternalItemKind(sourceUrl, itemUrl);
                    if (!itemKind)
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
                        kind: itemKind,
                        title: decodeExternalText(item.title || item.name),
                        author: decodeExternalText(authors.join(', ') || getPrimaryDiscoveryAuthor(item.persons)),
                        url: itemUrl,
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
                    kind: 'book',
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
                            kind: 'book',
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
                isNew: flags.isNew || /Новинка/.test(titleBlock),
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
            throw new Error('Не задан URL внешней витрины');

        const requestPageHtml = async(pageUrl = '') => {
            const response = await axios.get(pageUrl, {
                responseType: 'text',
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
                },
            });

            return String(response.data || '');
        };

        const requestedItems = Math.max(1, parseInt(limit, 10) || 8);
        const parserLimit = Math.max(requestedItems + 24, requestedItems);
        const host = (() => {
            try {
                return new URL(sourceUrl).hostname.toLowerCase();
            } catch (e) {
                return '';
            }
        })();

        const parseItemsFromHtml = (html = '', pageUrl = sourceUrl) => {
            const parserChain = [
                () => this.parseExternalFeedItemsFromNextData(html, pageUrl, parserLimit),
            ];

            if (host.includes('litres.ru'))
                parserChain.push(() => this.parseLitresFeedItemsFromHtml(html, pageUrl, parserLimit));
            if (host.includes('mann-ivanov-ferber.ru'))
                parserChain.push(
                    () => this.parseMifFeedItemsFromHtml(html, pageUrl, parserLimit),
                    () => this.parseJsonLdProductFeedItems(html, pageUrl, parserLimit),
                );
            if (host.includes('alpinabook.ru'))
                parserChain.push(() => this.parseAlpinaFeedItemsFromHtml(html, pageUrl, parserLimit));

            parserChain.push(
                () => this.parseJsonLdProductFeedItems(html, pageUrl, parserLimit),
                () => this.parseMifFeedItemsFromHtml(html, pageUrl, parserLimit),
                () => this.parseLitresFeedItemsFromHtml(html, pageUrl, parserLimit),
                () => this.parseAlpinaFeedItemsFromHtml(html, pageUrl, parserLimit),
            );

            for (const parseItems of parserChain) {
                const items = dedupeExternalFeedItems(parseItems(), parserLimit);
                if (items.length)
                    return items;
            }

            return [];
        };

        let items = [];
        let hasMore = false;
        let genreOptions = [];

        const html = await requestPageHtml(sourceUrl);
        const parsedItems = parseItemsFromHtml(html, sourceUrl);
        const limited = limitExternalFeedItemsByBooks(parsedItems, requestedItems);
        items = limited.items;
        hasMore = limited.hasMore;
        genreOptions = buildExternalGenreOptions(parsedItems, sourceUrl);

        if (!items.length)
            throw new Error('Не удалось прочитать внешнюю витрину');

        return {sourceUrl, items, hasMore, genreOptions};
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

    externalDiscoverySearchQueries(item = {}, limit = 32) {
        const title = String(item.title || '').trim();
        if (!title)
            return [];

        const baseQueries = [
            {title: `=${title}`, limit},
            {title: `*${title.substring(0, 80)}`, limit},
        ];
        const sources = getEnabledLibrarySources(this.config);
        if (sources.length <= 1)
            return baseQueries;

        return sources.flatMap((source) => baseQueries.map(query => Object.assign({}, query, {
            sourceId: source.id,
        })));
    }

    async findExternalDiscoveryCandidates(item = {}, limit = 32) {
        const found = [];
        const seen = new Set();
        for (const query of this.externalDiscoverySearchQueries(item, limit)) {
            const response = await this.dbSearcher.bookSearch(query);
            for (const book of (response.found || [])) {
                const key = String(book._uid || book.id || '').trim();
                if (key && seen.has(key))
                    continue;
                if (key)
                    seen.add(key);
                found.push(book);
            }

            await utils.processLoop();
        }

        return found;
    }

    async matchExternalItemsToLocalBooks(items = [], limit = 8) {
        const result = [];
        const seenBookUids = new Set();
        const seenExternalItems = new Set();

        for (const item of items) {
            const externalKey = buildExternalFeedIdentity(item);
            if (externalKey && seenExternalItems.has(externalKey))
                continue;
            if (externalKey)
                seenExternalItems.add(externalKey);

            const candidates = await this.findExternalDiscoveryCandidates(item, 32);
            const match = this.pickDiscoveryBookMatch(item, candidates);

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
            throw new Error(`Неизвестный источник витрины: ${discovery.externalSource}`);

        const feed = await this.fetchExternalFeedItems(discovery.externalLimit, discovery.externalUrl);
        const items = await this.matchExternalItemsToLocalBooks(feed.items || [], limit);
        const sourceName = (discovery.externalName || 'Внешний источник');

        return {
            id: 'external-source',
            title: sourceName,
            subtitle: `Совпадений ${items.length} из ${feed.items.length}`,
            source: 'external',
            sourceName,
            sourceUrl: feed.sourceUrl,
            items,
            emptyMessage: 'Совпадений с локальной библиотекой пока не нашлось.',
        };
    }

    async getDiscoveryShelves(options = {}) {
        this.checkMyState();

        const discovery = this.getDiscoveryConfig();
        if (!discovery.enabled)
            return {shelves: []};

        const newestLimit = Math.max(1, Math.min(parseInt(options.newestLimit, 10) || discovery.shelfLimit, 24));
        const popularLimit = Math.max(1, Math.min(parseInt(options.popularLimit, 10) || discovery.shelfLimit, 24));
        const externalShelfLimit = Math.max(1, Math.min(parseInt(options.externalLimit, 10) || discovery.shelfLimit, 120));

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
                    title: (discovery.externalName || 'Внешний источник'),
                    subtitle: 'Внешний источник временно недоступен',
                    source: 'external',
                    sourceName: (discovery.externalName || 'Внешний источник'),
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
                title: `Новинки за ${options.daysWindow || 0} дней`,
                subtitle: `Книги, добавленные за последние ${options.daysWindow || 0} дней`,
                mode: 'newest',
            };
        } else if (kind === 'popular') {
            shelfConfig = {
                id: 'popular',
                title: 'Популярное в библиотеке',
                subtitle: 'Локальный рейтинг по чтению, спискам и оценкам',
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
            sourceName: 'Локальная библиотека',
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
            discoveryMatchType: (item.kind === 'genre' ? 'genre' : 'missing-local'),
            discoveryMissingLocal: true,
            discoveryItemKind: String(item.kind || 'book').trim().toLowerCase() || 'book',
            discoveryFlags: {
                bestseller: !!item.isBestseller,
                isNew: !!item.isNew,
            },
        };
    }

    async matchExternalItemsToLocalBooksV2(items = [], limit = 8) {
        const result = [];
        const seenBookUids = new Set();
        const seenExternalItems = new Set();
        let matchedCount = 0;
        let missingCount = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const externalKey = buildExternalFeedIdentity(item);
            if (externalKey && seenExternalItems.has(externalKey))
                continue;
            if (externalKey)
                seenExternalItems.add(externalKey);

            const candidates = await this.findExternalDiscoveryCandidates(item, 32);
            const match = this.pickDiscoveryBookMatchV2(item, candidates);

            if (match && match.book) {
                if (!seenBookUids.has(match.book._uid)) {
                    seenBookUids.add(match.book._uid);
                    result.push(Object.assign({}, match.book, {
                        discoveryUrl: item.url,
                        discoveryCoverUrl: item.cover,
                        discoveryRating: item.rating,
                        discoveryMatchType: match.kind,
                        discoveryItemKind: String(item.kind || 'book').trim().toLowerCase() || 'book',
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
            const targetUrl = (discovery.externalBrowseUrl || discovery.externalUrl);
            return await this.fetchExternalFeedItems(discovery.externalLimit, targetUrl);
        } catch (e) {
            const details = String(e && e.message || '').trim();
            const suffix = details ? `: ${details}` : '';
            throw new Error(`Не удалось обновить внешний источник "${discovery.externalName || 'Внешний источник'}"${suffix}`);
        }
    }

    async buildExternalDiscoveryShelfV2(limit = 8, options = {}) {
        const discovery = this.getDiscoveryConfig(options);
        if (discovery.externalSource === 'none')
            return null;

        if (discovery.externalSource !== 'web-page')
            throw new Error(`Неизвестный источник витрины: ${discovery.externalSource}`);

        const feed = await this.fetchExternalDiscoveryItemsV2(discovery);
        const feedBooks = (Array.isArray(feed.items) ? feed.items : [])
            .filter(item => String(item && item.kind || 'book').trim().toLowerCase() !== 'genre');
        const matched = await this.matchExternalItemsToLocalBooksV2(feedBooks, limit);
        const items = matched.items
            .map((book) => this.decorateDiscoveryBook(book, {
                discoverySource: (discovery.externalName || 'Внешний источник'),
                matchKind: book.discoveryMatchType,
            }));
        const sourceName = (discovery.externalName || 'Внешний источник');
        const activeGenreName = String(discovery.externalBrowseName || '').trim();
        const genrePrefix = (activeGenreName ? `Жанр: ${activeGenreName} · ` : '');

        return {
            id: 'external-source',
            title: sourceName,
            subtitle: `${genrePrefix}В библиотеке ${matched.matchedCount} · вне библиотеки ${matched.missingCount}`,
            source: 'external',
            sourceName,
            sourceUrl: feed.sourceUrl,
            updatedAt: Date.now(),
            discoveryStale: false,
            discoveryHasMore: !!feed.hasMore,
            genreOptions: (feed.genreOptions || []),
            activeGenreUrl: (discovery.externalBrowseUrl || ''),
            activeGenreName,
            items,
            emptyMessage: 'Во внешнем источнике пока ничего не найдено.',
        };
    }
    async getDiscoveryShelvesV2(options = {}) {
        this.checkMyState();

        const discovery = await this.getDiscoveryConfigForRequest(options);
        if (!discovery.enabled)
            return {shelves: []};

        const newestLimit = Math.max(1, Math.min(parseInt(options.newestLimit, 10) || discovery.shelfLimit, 24));
        const popularLimit = Math.max(1, Math.min(parseInt(options.popularLimit, 10) || discovery.shelfLimit, 24));
        const externalShelfLimit = Math.max(1, Math.min(parseInt(options.externalLimit, 10) || discovery.shelfLimit, 120));
        const personalShelfLimit = Math.max(1, Math.min(parseInt(options.personalLimit, 10) || discovery.shelfLimit, 24));
        const personalSimilarLimit = Math.max(personalShelfLimit, Math.min(parseInt(options.personalSimilarLimit, 10) || Math.max(personalShelfLimit, 16), 96));

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

        for (const shelf of await this.getPersonalDiscoveryShelvesV2(options.userId, options.profileAccessToken, personalShelfLimit, Object.assign({}, options, {personalSimilarLimit}))) {
            if (shelf)
                shelves.push(shelf);
        }

        if (discovery.externalSource !== 'none') {
            try {
                const externalShelf = await this.rememberPersistedDiscovery(
                    `discovery:${inpxHash}:external:${externalDiscoveryCacheVersion}:${discovery.externalSource}:${discovery.externalName}:${discovery.externalLimit}:${externalShelfLimit}:${discovery.externalUrl}:${discovery.externalBrowseUrl}:${discovery.externalBrowseName}:${discovery.externalTtlMinutes}`,
                    () => this.buildExternalDiscoveryShelfV2(externalShelfLimit, options),
                    discovery.externalTtlMinutes * 60 * 1000,
                    {forceRefresh: options.forceRefresh === true},
                );
                if (externalShelf)
                    shelves.push(externalShelf);
            } catch (e) {
                shelves.push({
                    id: 'external-error',
                    title: (discovery.externalName || 'Внешний источник'),
                    subtitle: 'Внешний источник временно недоступен',
                    source: 'external',
                    sourceName: (discovery.externalName || 'Внешний источник'),
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
            .filter((item) => item.bookUid && item.progress.hidden !== true && !hiddenBookUids.has(item.bookUid) && Number(item.progress.percent || 0) < 0.999)
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

        const getRecencyMultiplier = (stamp = '') => {
            const time = Date.parse(String(stamp || '')) || 0;
            if (!time)
                return 1;

            const ageDays = Math.max(0, Math.floor((Date.now() - time) / 86400000));
            if (ageDays <= 7)
                return 1.45;
            if (ageDays <= 30)
                return 1.25;
            if (ageDays <= 90)
                return 1.1;
            return 1;
        };

        const applyBookSignals = (book, amount = 1, stamp = '') => {
            if (!book)
                return;

            const recencyMultiplier = getRecencyMultiplier(stamp);
            const weightedAmount = Number(amount || 0) * recencyMultiplier;
            knownBookUids.add(book._uid);
            addWeight(authorWeights, book.author, 4 * weightedAmount);
            addWeight(seriesWeights, book.series, 6 * weightedAmount);
            String(book.genre || '')
                .split(',')
                .map(item => item.trim())
                .filter(Boolean)
                .forEach((genre) => addWeight(genreWeights, genre, 2 * weightedAmount));

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
        const displayLimit = Math.max(1, Math.min(parseInt(limit, 10) || 8, 96));
        const probeLimit = displayLimit + 1;
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

        const rotationSeed = String(user.id || '')
            .split('')
            .reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) % 9973, Math.floor(Date.now() / 86400000));

        const rows = await this.db.select({
            table: 'book',
            rawResult: true,
            where: `
                const knownBookUids = new Set(${this.db.esc(Array.from(knownBookUids))});
                const preferredAuthors = ${this.db.esc(preferredAuthors)};
                const preferredSeries = ${this.db.esc(preferredSeries)};
                const preferredGenres = ${this.db.esc(preferredGenres)};
                const limit = ${this.db.esc(Math.max(probeLimit * 8 + 24, 48))};
                const rotationSeed = ${this.db.esc(rotationSeed)};

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

                    const stableHash = String(row._uid || row.id || '')
                        .split('')
                        .reduce((sum, char) => ((sum * 33) + char.charCodeAt(0) + rotationSeed) % 9973, rotationSeed);
                    score += (stableHash / 9973) * 12;

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
            if (items.length >= probeLimit)
                break;
        }

        const hasMore = items.length > displayLimit;
        const visibleItems = items.slice(0, displayLimit);

        return {
            id: 'similar-books',
            title: '\u041f\u043e\u0445\u043e\u0436\u0435 \u043d\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0447\u0438\u0442\u0430\u043b\u0438',
            subtitle: '\u041f\u043e\u0434\u0431\u043e\u0440\u043a\u0430 \u043f\u043e \u0430\u0432\u0442\u043e\u0440\u0430\u043c, \u0441\u0435\u0440\u0438\u044f\u043c \u0438 \u0436\u0430\u043d\u0440\u0430\u043c \u0438\u0437 \u0432\u0430\u0448\u0435\u0439 \u0438\u0441\u0442\u043e\u0440\u0438\u0438',
            source: 'personal',
            sourceName: '\u0414\u043b\u044f \u0432\u0430\u0441',
            updatedAt: updatedAt || Date.now(),
            discoveryHasMore: hasMore,
            items: visibleItems,
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

        if (options && options.personalSimilarEnabled !== false) {
            const similarLimit = Math.max(limit, Math.min(parseInt(options.personalSimilarLimit, 10) || Math.max(limit, 16), 96));
            shelves.push(await this.buildSimilarBooksShelfV2(user, similarLimit, context));
        }

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
                title: book.title || 'Без названия',
                author: book.author || '',
                series: book.series || '',
                serno: book.serno || '',
                ext: book.ext || '',
                percent: Math.max(0, Math.min(1, Number(item.progress.percent || 0) || 0)),
                sectionId: String(item.progress.sectionId || '').trim(),
                pageIndex: Math.max(0, Math.round(Number(item.progress.pageIndex || 0) || 0)),
                textOffset: Math.max(-1, Math.round(Number(item.progress.textOffset || -1) || -1)),
                textSnippet: String(item.progress.textSnippet || '').trim(),
                updatedAt: String(item.progress.updatedAt || '').trim(),
            });
        }

        return {
            count: Object.values(progressMap).filter(progress => progress && progress.hidden !== true).length,
            items: result,
        };
    }

    async getUserReadingLibrary(user = null, options = {}) {
        this.checkMyState();

        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});
        const state = ['reading', 'read', 'hidden', 'all'].includes(String(options.state || '').trim())
            ? String(options.state || '').trim()
            : 'reading';
        const query = String(options.query || '').trim().toLowerCase();
        const sort = String(options.sort || 'updatedDesc').trim();
        const limit = Math.max(1, Math.min(500, Number(options.limit || 200) || 200));

        const counters = {
            all: 0,
            reading: 0,
            read: 0,
            hidden: 0,
        };
        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => {
                const normalizedProgress = Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, progress || {});
                const percent = Math.max(0, Math.min(1, Number(normalizedProgress.percent || 0) || 0));
                const hidden = normalizedProgress.hidden === true;
                const rowState = hidden ? 'hidden' : (percent >= 0.999 ? 'read' : 'reading');
                counters.all++;
                counters[rowState]++;
                return {
                    bookUid: String(bookUid || '').trim(),
                    progress: Object.assign(normalizedProgress, {percent, hidden}),
                    state: rowState,
                };
            })
            .filter((item) => item.bookUid && (state === 'all' || item.state === state));

        const items = [];
        for (const item of rows) {
            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            const resultItem = {
                bookUid: item.bookUid,
                title: book.title || 'Без названия',
                author: book.author || '',
                series: book.series || '',
                serno: book.serno || '',
                ext: book.ext || '',
                percent: item.progress.percent,
                hidden: item.progress.hidden === true,
                state: item.state,
                sectionId: String(item.progress.sectionId || '').trim(),
                updatedAt: String(item.progress.updatedAt || '').trim(),
            };
            if (query) {
                const haystack = `${resultItem.title} ${resultItem.author} ${resultItem.series}`.toLowerCase();
                if (!haystack.includes(query))
                    continue;
            }
            items.push(resultItem);
        }

        const compareText = (a, b, field) => String(a[field] || '').localeCompare(String(b[field] || ''), 'ru');
        items.sort((a, b) => {
            switch (sort) {
                case 'updatedAsc':
                    return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
                case 'titleAsc':
                    return compareText(a, b, 'title');
                case 'authorAsc':
                    return compareText(a, b, 'author') || compareText(a, b, 'title');
                case 'progressDesc':
                    return (Number(b.percent || 0) - Number(a.percent || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
                case 'progressAsc':
                    return (Number(a.percent || 0) - Number(b.percent || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
                case 'updatedDesc':
                default:
                    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
            }
        });

        return {
            state,
            query,
            sort,
            counters,
            count: items.length,
            items: items.slice(0, limit),
        };
    }

    async getUserProfiles(currentUserId = '') {
        this.checkMyState();

        const {users, currentUser} = await this.readingListStore.getUsers(currentUserId);
        return {
            users: users
                .map((item) => ({
                    id: item.id,
                    name: getUserDisplayName(item),
                    login: item.login || '',
                    requiresLogin: !!item.passwordHash,
                    anonymousProfile: isAnonymousDefaultUser(item),
                    isAdmin: !!item.isAdmin,
                    opdsEnabled: item.opdsEnabled !== false,
                    opdsAuthEnabled: item.opdsAuthEnabled === true,
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
            throw new Error('Только администратор может управлять профилями');
        return user;
    }

    async getCurrentUserProfile(userId = '', profileAccessToken = '') {
        this.checkMyState();

        const user = await this.getEffectiveUser(userId, profileAccessToken);
        const anonymousProfile = isAnonymousDefaultUser(user);
        const profileAuthorized = (!anonymousProfile && (!user.passwordHash || this.getProfileSessionUser(profileAccessToken) === user.id));
        const readingSummary = (profileAuthorized ? await this.buildUserReadingSummary(user, 48) : {count: 0, items: []});
        return {
            currentUserId: user.id,
            profileAuthorized,
            currentUserProfile: {
                id: user.id,
                name: getUserDisplayName(user),
                login: user.login || '',
                hasPassword: !!user.passwordHash,
                anonymousProfile,
                isAdmin: !!user.isAdmin,
                emailTo: (profileAuthorized ? user.emailTo || '' : ''),
                telegramChatId: (profileAuthorized ? user.telegramChatId || '' : ''),
                opdsEnabled: user.opdsEnabled !== false,
                opdsAuthEnabled: user.opdsAuthEnabled === true,
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
            throw new Error('Неверный логин или пароль');

        const passwordHash = this.hashProfilePassword(user.login, password);
        if (passwordHash !== user.passwordHash)
            throw new Error('Неверный логин или пароль');

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

    async getOpdsUserReadingLibrary(publicId = '', options = {}) {
        this.checkMyState();
        const user = await this.readingListStore.getOpdsUser(publicId);
        if (!user)
            throw new Error('Профиль OPDS не найден');

        return await this.getUserReadingLibrary(user, options);
    }

    async verifyOpdsPassword(publicId = '', login = '', password = '') {
        this.checkMyState();
        return await this.readingListStore.verifyOpdsPassword(publicId, login, password);
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

    async updateSharedDiscoveryConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const discovery = await this.readingListStore.updateSharedDiscoveryConfig(patch || {});
        this.sharedDiscoveryConfig = _.cloneDeep(discovery);
        return {discovery};
    }

    getAdminIntegrationConfig() {
        const hasTelegramToken = !!String(this.config.telegramBotToken || '').trim();
        const hasSmtpPassword = !!String(this.config.smtpPass || '').trim();

        return {
            telegramShareEnabled: !!this.config.telegramShareEnabled,
            telegramBotToken: hasTelegramToken ? '__KEEP__' : '',
            telegramBotTokenSet: hasTelegramToken,
            telegramChatId: String(this.config.telegramChatId || ''),
            telegramCaptionTemplate: String(this.config.telegramCaptionTemplate || '${AUTHOR} - ${TITLE}'),
            emailShareEnabled: !!this.config.emailShareEnabled,
            smtpHost: String(this.config.smtpHost || ''),
            smtpPort: parseInt(this.config.smtpPort, 10) || 587,
            smtpSecure: !!this.config.smtpSecure,
            smtpUser: String(this.config.smtpUser || ''),
            smtpPass: hasSmtpPassword ? '__KEEP__' : '',
            smtpPassSet: hasSmtpPassword,
            emailFrom: String(this.config.emailFrom || ''),
            emailTo: String(this.config.emailTo || ''),
        };
    }

    getAdminOpdsConfig() {
        const opds = this.config.opds || {};
        const hasPassword = !!String(opds.password || '').trim();
        return {
            enabled: opds.enabled !== false,
            root: String(opds.root || '/opds'),
            user: String(opds.user || ''),
            password: hasPassword ? '__KEEP__' : '',
            passwordSet: hasPassword,
        };
    }

    addAdminEvent(level = 'info', category = 'system', message = '', details = {}) {
        if (this.config.adminEventLogEnabled === false)
            return null;

        const maxEvents = Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300));
        const event = {
            id: `${Date.now()}-${utils.randomHexString(6)}`,
            time: new Date().toISOString(),
            level: String(level || 'info'),
            category: String(category || 'system'),
            message: String(message || ''),
            details: details || {},
        };

        this.adminEvents.push(event);
        if (this.adminEvents.length > maxEvents)
            this.adminEvents.splice(0, this.adminEvents.length - maxEvents);

        return event;
    }

    async dirSize(dir = '', maxFiles = 20000) {
        const result = {path: dir, exists: false, size: 0, files: 0, truncated: false};
        if (!dir || !await fs.pathExists(dir))
            return result;

        result.exists = true;
        const stack = [dir];
        while (stack.length) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current);
            } catch (e) {
                continue;
            }

            for (const name of list) {
                const filePath = path.join(current, name);
                let stat = null;
                try {
                    stat = await fs.stat(filePath);
                } catch (e) {
                    continue;
                }

                if (stat.isDirectory()) {
                    stack.push(filePath);
                } else {
                    result.files++;
                    result.size += stat.size;
                    if (result.files >= maxFiles) {
                        result.truncated = true;
                        return result;
                    }
                }
            }
        }

        return result;
    }

    async findFilesByExt(dir = '', exts = [], maxFiles = 200) {
        const result = [];
        const normalizedExts = new Set(exts.map(ext => String(ext || '').toLowerCase()));
        if (!dir || !await fs.pathExists(dir))
            return result;

        const stack = [dir];
        while (stack.length && result.length < maxFiles) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current, {withFileTypes: true});
            } catch (e) {
                continue;
            }

            for (const entry of list) {
                const filePath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(filePath);
                    continue;
                }

                if (normalizedExts.has(path.extname(entry.name).toLowerCase()))
                    result.push(filePath);

                if (result.length >= maxFiles)
                    break;
            }
        }

        return result;
    }

    async countArchives(dir = '', maxFiles = 20000) {
        const result = {count: 0, truncated: false};
        if (!dir || !await fs.pathExists(dir))
            return result;

        const stack = [dir];
        while (stack.length) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current, {withFileTypes: true});
            } catch (e) {
                continue;
            }

            for (const entry of list) {
                const filePath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(filePath);
                    continue;
                }

                if (['.zip', '.7z', '.fb2', '.epub'].includes(path.extname(entry.name).toLowerCase()))
                    result.count++;

                if (result.count >= maxFiles) {
                    result.truncated = true;
                    return result;
                }
            }
        }

        return result;
    }

    async getLibrarySourceDiagnostics(source = {}) {
        const libDir = String(source.libDir || '').trim();
        const inpx = String(source.inpx || source.inpxFile || '').trim();
        const foundInpx = libDir ? await this.findFilesByExt(libDir, ['.inpx'], 20) : [];
        const archiveInfo = libDir ? await this.countArchives(libDir) : {count: 0, truncated: false};
        const exists = async(name) => !!(libDir && await fs.pathExists(path.join(libDir, name)));

        return {
            inpxExists: !!inpx && await fs.pathExists(inpx),
            libDirExists: !!libDir && await fs.pathExists(libDir),
            foundInpx,
            archiveCount: archiveInfo.count,
            archiveCountTruncated: archiveInfo.truncated,
            hasCovers: await exists('covers'),
            hasEtc: await exists('etc'),
            hasImages: await exists('images'),
            hasBin: await exists('bin'),
        };
    }

    async cleanBrokenCoverCacheFiles(dir = '') {
        const result = {dir, removed: 0, checked: 0};
        if (!dir || !await fs.pathExists(dir))
            return result;

        const allowed = new Set(['.png', '.jpg', '.gif']);
        const list = await fs.readdir(dir);
        for (const name of list) {
            const filePath = path.join(dir, name);
            let stat = null;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;
            }

            if (stat.isDirectory())
                continue;

            result.checked++;
            const broken = stat.size <= 0 || !allowed.has(path.extname(name).toLowerCase());
            if (!broken)
                continue;

            await fs.remove(filePath);
            result.removed++;
        }

        return result;
    }

    async buildAdminDashboardMetrics(index = null, dbConfig = null) {
        index = index || await this.getIndexStatus();
        dbConfig = dbConfig || (index.ready ? await this.dbConfig() : {});
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const coverSize = await this.dirSize(coverDir);
        const bookCacheSize = this.effectiveBookCacheSize();
        const coverCacheSize = cleanDirMaxSize(this.config.coverCacheSize);
        const cacheCleanTargetRatio = this.cacheCleanTargetRatio();
        const uptime = process.uptime();
        const cpuUsage = process.cpuUsage();
        const cpuTotalMicros = cpuUsage.user + cpuUsage.system;
        const cpuTotalSeconds = cpuTotalMicros / 1000000;
        const cpuNow = Date.now();
        const previousCpuSnapshot = this.adminCpuSnapshot || null;
        const cpuElapsedSeconds = previousCpuSnapshot ? Math.max(0, (cpuNow - previousCpuSnapshot.at) / 1000) : 0;
        const cpuCurrentPercent = (previousCpuSnapshot && cpuElapsedSeconds > 0)
            ? ((cpuTotalMicros - previousCpuSnapshot.totalMicros) / 1000000 / cpuElapsedSeconds) * 100
            : null;

        this.adminCpuSnapshot = {
            at: cpuNow,
            totalMicros: cpuTotalMicros,
        };

        return {
            generatedAt: new Date().toISOString(),
            uptime,
            memory: process.memoryUsage(),
            cpu: {
                userSeconds: cpuUsage.user / 1000000,
                systemSeconds: cpuUsage.system / 1000000,
                totalSeconds: cpuTotalSeconds,
                currentPercent: cpuCurrentPercent,
                averagePercent: uptime > 0 ? (cpuTotalSeconds / uptime) * 100 : 0,
            },
            index,
            stats: (dbConfig && dbConfig.stats) || (index && index.stats) || {},
            paths: {
                dataDir: this.config.dataDir,
                db: `${this.config.dataDir}/db`,
                bookCache: this.config.bookDir,
                coverCache: coverDir,
                tempDir: this.config.tempDir,
            },
            sizes: {
                db: await this.dirSize(`${this.config.dataDir}/db`),
                bookCache: await this.dirSize(this.config.bookDir),
                coverCache: coverSize,
                tempDir: await this.dirSize(this.config.tempDir, 5000),
            },
            limits: {
                maxFilesDirSize: this.config.maxFilesDirSize,
                bookCacheSize,
                bookCacheTargetSize: (bookCacheSize === null ? null : cleanDirTargetSize(bookCacheSize, null, cacheCleanTargetRatio)),
                coverCacheSize,
                coverCacheTargetSize: (coverCacheSize === null ? null : cleanDirTargetSize(coverCacheSize, null, cacheCleanTargetRatio)),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio,
            },
        };
    }

    async getAdminDashboardMetrics(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        return await this.buildAdminDashboardMetrics();
    }

    async getAdminDashboard(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const index = await this.getIndexStatus();
        const dbConfig = (index.ready ? await this.dbConfig() : {});
        const metrics = await this.buildAdminDashboardMetrics(index, dbConfig);
        const sources = await Promise.all(getEnabledLibrarySources(this.config).map(async(source) => Object.assign({
            id: source.id || '',
            name: source.name || '',
            enabled: source.enabled !== false,
            inpx: source.inpx || source.inpxFile || '',
            libDir: source.libDir || '',
        }, await this.getLibrarySourceDiagnostics(source))));
        const coverErrors = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse())
            .filter(event => {
                if (event.level !== 'error')
                    return false;

                const text = `${event.category || ''} ${event.message || ''}`.toLowerCase();
                return text.includes('cover') || text.includes('облож') || /\bimage\s+\S+:/i.test(text);
            })
            .slice(0, 8);
        const state = this.wState.get() || {};

        return Object.assign({}, metrics, {
            sources,
            covers: {
                dir: metrics.paths.coverCache,
                size: metrics.sizes.coverCache.size,
                files: metrics.sizes.coverCache.files,
                limit: metrics.limits.coverCacheSize,
                targetSize: metrics.limits.coverCacheTargetSize,
                latestErrors: coverErrors,
            },
            tasks: [
                {
                    id: 'index',
                    title: 'Индексация',
                    active: state.state === 'db_creating' || state.state === 'db_loading',
                    state: state.state,
                    message: state.jobMessage || state.serverMessage || '',
                    progress: state.progress || 0,
                    lastError: (this.adminEvents.slice().reverse().find(event => event.category === 'index' && event.level === 'error') || {}).message || '',
                    cancellable: false,
                },
                {
                    id: 'cache',
                    title: 'Чистка кэша',
                    active: false,
                    state: 'idle',
                    message: 'Ручная чистка выполняется синхронно',
                    progress: 0,
                    lastError: (this.adminEvents.slice().reverse().find(event => event.category === 'cache' && event.level === 'error') || {}).message || '',
                    cancellable: false,
                },
                {
                    id: 'delivery',
                    title: 'Конвертации и отправки',
                    active: false,
                    state: 'events',
                    message: 'Смотрите последние события отправки и конвертации ниже',
                    progress: 0,
                    lastError: (this.adminEvents.slice().reverse().find(event => ['delivery', 'conversion'].includes(event.category) && event.level === 'error') || {}).message || '',
                    cancellable: false,
                },
            ],
        });
    }

    async getAdminEvents(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const level = String(options.level || 'all').trim();
        const category = String(options.category || 'all').trim();
        const limit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 80));
        let events = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse());
        if (level !== 'all')
            events = events.filter(event => event.level === level);
        if (category !== 'all')
            events = events.filter(event => event.category === category);

        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300)),
            events: events.slice(0, limit),
        };
    }

    async addAdminTestEvent(userId = '', profileAccessToken = '', level = 'warn') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = String(level || 'warn').toLowerCase() === 'error' ? 'error' : 'warn';
        log(normalized === 'error' ? LM_ERR : LM_WARN, `Admin event log test: ${normalized}`);
        return {success: true};
    }

    async updateAdminEventLog(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const patch = {
            adminEventLogEnabled: options.enabled !== false,
            adminEventLogSize: Math.max(20, Math.min(2000, parseInt(options.maxSize, 10) || 300)),
        };
        await this.saveRuntimeConfigPatch(patch);
        if (this.adminEvents.length > patch.adminEventLogSize)
            this.adminEvents.splice(0, this.adminEvents.length - patch.adminEventLogSize);
        this.addAdminEvent('info', 'settings', patch.adminEventLogEnabled ? 'Журнал событий включен' : 'Журнал событий выключен');
        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: patch.adminEventLogSize,
        };
    }

    normalizeAdminLibrarySources(sources = []) {
        return (Array.isArray(sources) ? sources : [])
            .map((source, index) => {
                const inpx = String(source.inpx || source.inpxFile || '').trim();
                const libDir = String(source.libDir || '').trim();
                const name = String(source.name || '').trim() || path.basename(inpx, path.extname(inpx)) || `Library ${index + 1}`;
                const idBase = String(source.id || name || `source-${index + 1}`)
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]+/gi, '-')
                    .replace(/^-+|-+$/g, '')
                    .substring(0, 40) || `source-${index + 1}`;

                return {
                    id: idBase,
                    name,
                    inpx,
                    inpxFile: inpx,
                    libDir,
                    enabled: source.enabled !== false,
                };
            })
            .filter(source => source.inpx || source.libDir);
    }

    async updateAdminLibrarySources(userId = '', profileAccessToken = '', sources = []) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminLibrarySources(sources);
        if (!normalized.length)
            throw new Error('Нужно указать хотя бы один источник библиотеки');
        if (!normalized.some(source => source.enabled !== false))
            throw new Error('Должен быть включен хотя бы один источник библиотеки');

        this.config.librarySources = normalized;
        await this.saveRuntimeConfigPatch({librarySources: normalized});
        this.addAdminEvent('info', 'sources', `Обновлены источники библиотек: ${normalized.length}`);
        return {sources: normalized};
    }

    async diagnoseLibrarySource(userId = '', profileAccessToken = '', source = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        return await this.getLibrarySourceDiagnostics(source);
    }

    effectiveBookCacheSize() {
        const bookCacheSize = cleanDirMaxSize(this.config.bookCacheSize);
        if (bookCacheSize !== null)
            return bookCacheSize;

        return cleanDirMaxSize(this.config.maxFilesDirSize);
    }

    cacheCleanTargetRatio() {
        return cleanDirTargetRatio(this.config.cacheCleanTargetRatio);
    }

    cacheCleanNextScheduledDelay(now = new Date()) {
        try {
            return cleanDirNextScheduledDelay(this.config, now);
        } catch(e) {
            log(LM_ERR, `cacheCleanSchedule: ${e.message}`);
            return cleanDirNextAlignedDelay(this.config, now);
        }
    }

    cacheCleanNextRunAt(now = new Date()) {
        const delay = this.cacheCleanNextScheduledDelay(now);
        if (delay === null)
            return '';

        return new Date(now.getTime() + delay).toISOString();
    }

    cacheDirConfig(kind = 'all') {
        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        const targetRatio = this.cacheCleanTargetRatio();
        const result = [];
        const bookMaxSize = this.effectiveBookCacheSize();
        if ((normalizedKind === 'all' || normalizedKind === 'book') && bookMaxSize !== null && bookMaxSize > 0) {
            result.push({
                id: 'book',
                title: 'Книжный кэш',
                dir: this.config.bookDir,
                maxSize: bookMaxSize,
                targetRatio,
            });
        }

        const coverMaxSize = cleanDirMaxSize(this.config.coverCacheSize);
        if ((normalizedKind === 'all' || normalizedKind === 'cover') && coverMaxSize !== null && coverMaxSize > 0) {
            result.push({
                id: 'cover',
                title: 'Кэш обложек',
                dir: this.config.coverDir || `${this.config.publicFilesDir}/cover`,
                maxSize: coverMaxSize,
                targetRatio,
            });
        }

        return result;
    }

    async runCacheClean(reason = 'manual', options = {}) {
        if (this.cacheCleanRunning)
            return {skipped: true, reason: 'already-running'};

        this.cacheCleanRunning = true;
        try {
            const result = [];
            for (const config of this.cacheDirConfig(options.kind || 'all')) {
                try {
                    result.push(await this.cleanDir(Object.assign({}, config, {
                        forceTarget: options.forceTarget === true,
                    })));
                } catch(e) {
                    log(LM_ERR, e.stack || e.message);
                    result.push({
                        id: config.id || '',
                        title: config.title || '',
                        dir: config.dir,
                        error: e.message,
                    });
                }
            }

            if (reason)
                this.addAdminEvent('info', 'cache', `Чистка кэша: ${reason}`, {result});

            return {cleaned: result};
        } finally {
            this.cacheCleanRunning = false;
        }
    }

    scheduleCacheClean(reason = 'deferred', delay = 10*60*1000) {
        const interval = cleanDirInterval(this.config);
        if (!interval || this.cacheCleanTimer)
            return;

        this.cacheCleanTimer = setTimeout(async() => {
            this.cacheCleanTimer = null;
            try {
                await this.runCacheClean(reason);
            } catch(e) {
                log(LM_ERR, e.stack || e.message);
            }
        }, Math.max(60*1000, delay));
    }

    async runAdminCacheClean(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        return await this.runCacheClean('ручной запуск', {
            kind: 'all',
            forceTarget: true,
        });
    }

    async runAdminCacheCleanKind(userId = '', profileAccessToken = '', kind = 'all') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        if (!['all', 'book', 'cover'].includes(normalizedKind))
            throw new Error('Неизвестный кэш для очистки');

        return await this.runCacheClean('ручной запуск', {
            kind: normalizedKind,
            forceTarget: true,
        });
    }

    normalizeAdminCachePatch(patch = {}) {
        const normalized = {};
        const mb = 1024*1024;

        const sizeFromMb = (value, fallback) => {
            const mbValue = parseFloat(value);
            if (!Number.isFinite(mbValue))
                return fallback;

            return Math.round(Math.max(1, mbValue) * mb);
        };

        if (utils.hasProp(patch, 'bookCacheSizeMb')) {
            const current = this.effectiveBookCacheSize() || 2048*mb;
            normalized.bookCacheSize = sizeFromMb(patch.bookCacheSizeMb, current);
            normalized.maxFilesDirSize = normalized.bookCacheSize;
        }

        if (utils.hasProp(patch, 'coverCacheSizeMb')) {
            const current = cleanDirMaxSize(this.config.coverCacheSize) || 512*mb;
            normalized.coverCacheSize = sizeFromMb(patch.coverCacheSizeMb, current);
        }

        if (utils.hasProp(patch, 'cacheCleanIntervalMinutes')) {
            const minutes = parseFloat(patch.cacheCleanIntervalMinutes);
            if (Number.isFinite(minutes))
                normalized.cacheCleanInterval = Math.max(0, Math.round(minutes));
        }

        if (utils.hasProp(patch, 'cacheCleanSchedule')) {
            const schedule = String(patch.cacheCleanSchedule || '').trim();
            if (schedule)
                parseCleanDirCron(schedule);

            normalized.cacheCleanSchedule = schedule;
        }

        if (utils.hasProp(patch, 'cacheCleanTargetPercent')) {
            const percent = parseFloat(patch.cacheCleanTargetPercent);
            if (Number.isFinite(percent))
                normalized.cacheCleanTargetRatio = Math.max(0.1, Math.min(1, percent / 100));
        }

        return normalized;
    }

    async updateAdminCacheConfig(userId = '', profileAccessToken = '', patch = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminCachePatch(patch || {});
        if (Object.keys(normalized).length)
            await this.saveRuntimeConfigPatch(normalized);

        this.addAdminEvent('info', 'settings', 'Обновлены настройки ротации кэша', normalized);
        return {
            cache: {
                bookCacheSize: this.effectiveBookCacheSize(),
                coverCacheSize: cleanDirMaxSize(this.config.coverCacheSize),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio: this.cacheCleanTargetRatio(),
            },
        };
    }

    async cleanBrokenCoverCache(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const result = await this.cleanBrokenCoverCacheFiles(this.config.coverDir || `${this.config.publicFilesDir}/cover`);
        this.addAdminEvent('info', 'cover', `Очищены битые файлы обложек: ${result.removed}`, result);
        return result;
    }

    async rebuildCoverCacheForBook(userId = '', profileAccessToken = '', bookUid = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error('Книга не найдена');

        const libid = parseInt(book.libid, 10);
        if (!libid)
            throw new Error('У книги нет LibId для обложки');

        const sourceId = String(book.sourceId || '').trim();
        const sourceKey = sourceId.replace(/[^a-z0-9._-]+/gi, '_');
        const cacheBase = sourceKey ? `${sourceKey}-${libid}` : String(libid);
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const removed = [];
        for (const ext of ['.png', '.jpg', '.gif']) {
            const filePath = path.join(coverDir, `${cacheBase}${ext}`);
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                removed.push(filePath);
            }
        }

        const coverUrl = `${this.config.rootPathStatic || ''}/cover/${sourceId ? `${encodeURIComponent(sourceId)}/` : ''}${libid}`;
        this.addAdminEvent('info', 'cover', `Сброшен кэш обложки для ${book.title || bookUid}`, {bookUid, libid, sourceId, removed});
        return {
            success: true,
            bookUid,
            libid,
            sourceId,
            removed: removed.length,
            coverUrl,
        };
    }

    async startAdminReindex(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        this.addAdminEvent('warn', 'index', 'Запущено переиндексирование библиотеки');
        this.recreateDb();//no await
        return {started: true};
    }

    async saveRuntimeConfigPatch(patch = {}) {
        Object.assign(this.config, patch);
        const configManager = new ConfigManager();
        configManager.config = this.config;
        await configManager.save();
    }

    normalizeIntegrationPatch(patch = {}) {
        const normalized = {};

        if (utils.hasProp(patch, 'telegramShareEnabled'))
            normalized.telegramShareEnabled = !!patch.telegramShareEnabled;
        if (utils.hasProp(patch, 'telegramBotToken')) {
            const token = String(patch.telegramBotToken || '').trim();
            if (token !== '__KEEP__')
                normalized.telegramBotToken = token;
        }
        if (utils.hasProp(patch, 'telegramChatId'))
            normalized.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utils.hasProp(patch, 'telegramCaptionTemplate'))
            normalized.telegramCaptionTemplate = String(patch.telegramCaptionTemplate || '').trim() || '${AUTHOR} - ${TITLE}';

        if (utils.hasProp(patch, 'emailShareEnabled'))
            normalized.emailShareEnabled = !!patch.emailShareEnabled;
        if (utils.hasProp(patch, 'smtpHost'))
            normalized.smtpHost = String(patch.smtpHost || '').trim();
        if (utils.hasProp(patch, 'smtpPort'))
            normalized.smtpPort = Math.max(1, Math.min(parseInt(patch.smtpPort, 10) || 587, 65535));
        if (utils.hasProp(patch, 'smtpSecure'))
            normalized.smtpSecure = !!patch.smtpSecure;
        if (utils.hasProp(patch, 'smtpUser'))
            normalized.smtpUser = String(patch.smtpUser || '').trim();
        if (utils.hasProp(patch, 'smtpPass')) {
            const pass = String(patch.smtpPass || '');
            if (pass !== '__KEEP__')
                normalized.smtpPass = pass;
        }
        if (utils.hasProp(patch, 'emailFrom'))
            normalized.emailFrom = String(patch.emailFrom || '').trim();
        if (utils.hasProp(patch, 'emailTo'))
            normalized.emailTo = String(patch.emailTo || '').trim();

        return normalized;
    }

    normalizeAdminOpdsPatch(patch = {}) {
        const current = this.config.opds || {};
        const normalized = Object.assign({}, current);

        if (utils.hasProp(patch, 'enabled'))
            normalized.enabled = (patch.enabled !== false);
        if (utils.hasProp(patch, 'root')) {
            let root = String(patch.root || '/opds').trim() || '/opds';
            if (!root.startsWith('/'))
                root = `/${root}`;
            normalized.root = root.replace(/\/+$/g, '') || '/opds';
        }
        if (utils.hasProp(patch, 'user'))
            normalized.user = String(patch.user || '').trim();
        if (utils.hasProp(patch, 'password')) {
            const password = String(patch.password || '');
            if (password !== '__KEEP__')
                normalized.password = password;
        }

        if (normalized.password && !normalized.user)
            throw new Error('Для общего OPDS-пароля нужно указать логин');

        return normalized;
    }

    async updateAdminIntegrationConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeIntegrationPatch(patch || {});
        await this.saveRuntimeConfigPatch(normalized);
        this.addAdminEvent('info', 'settings', 'Обновлены настройки отправки книг');

        return {integrations: this.getAdminIntegrationConfig()};
    }

    async updateAdminOpdsConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const opds = this.normalizeAdminOpdsPatch(patch || {});
        await this.saveRuntimeConfigPatch({opds});
        this.addAdminEvent('info', 'settings', 'Обновлены настройки общего OPDS');

        return {opds: this.getAdminOpdsConfig()};
    }

    async updateBookMetadata(userId = '', profileAccessToken = '', bookUid = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const override = await this.readingListStore.updateMetadataOverride(bookUid, patch);
        return {bookUid, override};
    }

    buildSmtpTransportOptions() {
        return {
            host: this.config.smtpHost,
            port: parseInt(this.config.smtpPort, 10) || 587,
            secure: !!this.config.smtpSecure,
            auth: (this.config.smtpUser ? {
                user: this.config.smtpUser,
                pass: this.config.smtpPass,
            } : undefined),
        };
    }

    async testAdminIntegrationConfig(userId = '', profileAccessToken = '', kind = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalizedKind = String(kind || '').trim().toLowerCase();
        if (normalizedKind === 'smtp') {
            if (!this.config.smtpHost)
                throw new Error('SMTP host не указан');

            const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());
            await transporter.verify();
            return {success: true, message: 'SMTP подключение проверено'};
        }

        if (normalizedKind === 'telegram') {
            if (!this.config.telegramBotToken)
                throw new Error('Telegram bot token не указан');

            const response = await axios.get(`https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`, {
                timeout: 15000,
            });

            if (!response.data || response.data.ok !== true)
                throw new Error('Telegram API не принял токен');

            return {
                success: true,
                message: `Telegram бот доступен: ${((response.data.result || {}).username || (response.data.result || {}).first_name || 'ok')}`,
            };
        }

        throw new Error('Неизвестный тип проверки');
    }

    async exportAdminSettings(userId = '', profileAccessToken = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const data = _.cloneDeep(this.config);
        const opdsSettings = Object.assign({}, data.opds || {});
        opdsSettings.passwordSet = !!String(opdsSettings.password || '').trim();
        delete opdsSettings.password;
        delete data.adminPassword;
        delete data.webConfigParams;
        delete data.inpxFileHash;

        const result = {
            exportedAt: new Date().toISOString(),
            settings: _.pick(data, this.adminSettingsExportKeys()),
        };
        result.settings.opds = opdsSettings;
        return result;
    }

    adminSettingsExportKeys() {
        return [
            'libDir',
            'inpx',
            'librarySources',
            'inpxFilterFile',
            'extendedSearch',
            'bookReadLink',
            'loggingEnabled',
            'logServerStats',
            'logQueries',
            'loginRateLimitEnabled',
            'loginRateLimitWindowMs',
            'loginRateLimitMaxAttempts',
            'requireAuth',
            'authMode',
            'trustProxy',
            'proxyAuthHeader',
            'trustedProxyCidrs',
            'authExemptHealth',
            'metricsEnabled',
            'metricsPath',
            'metricsExemptAuth',
            'dbCacheSize',
            'maxFilesDirSize',
            'bookCacheSize',
            'coverCacheSize',
            'queryCacheEnabled',
            'queryCacheMemSize',
            'queryCacheDiskSize',
            'cacheCleanInterval',
            'cacheCleanTargetRatio',
            'adminEventLogEnabled',
            'adminEventLogSize',
            'inpxCheckInterval',
            'lowMemoryMode',
            'fullOptimization',
            'converterPaths',
            'server',
            'opds',
            'telegramShareEnabled',
            'telegramChatId',
            'telegramCaptionTemplate',
            'emailShareEnabled',
            'smtpHost',
            'smtpPort',
            'smtpSecure',
            'smtpUser',
            'emailFrom',
            'emailTo',
            'discovery',
            'uiDefaults',
        ];
    }

    normalizeImportedAdminSettings(payload = {}) {
        const source = (payload && payload.settings && typeof payload.settings === 'object')
            ? payload.settings
            : payload;
        if (!source || typeof source !== 'object' || Array.isArray(source))
            throw new Error('Файл настроек имеет неверный формат');

        const patch = _.pick(_.cloneDeep(source), this.adminSettingsExportKeys());
        if (!Object.keys(patch).length)
            throw new Error('В файле не найдены настройки для восстановления');

        if (patch.opds && typeof patch.opds === 'object') {
            const currentOpds = this.config.opds || {};
            const opds = Object.assign({}, currentOpds, patch.opds);
            if (utils.hasProp(opds, 'passwordSet'))
                delete opds.passwordSet;
            if (!utils.hasProp(patch.opds, 'password'))
                opds.password = currentOpds.password || '';
            patch.opds = opds;
        }

        if (utils.hasProp(patch, 'librarySources') && !Array.isArray(patch.librarySources))
            throw new Error('librarySources должен быть массивом');

        return patch;
    }

    async importAdminSettings(userId = '', profileAccessToken = '', payload = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const patch = this.normalizeImportedAdminSettings(payload);
        await this.saveRuntimeConfigPatch(patch);
        this.addAdminEvent('info', 'settings', 'Восстановлены настройки администратора из файла');

        return {
            success: true,
            importedKeys: Object.keys(patch),
            settings: (await this.exportAdminSettings(userId, profileAccessToken)).settings,
        };
    }

    async addBackupPath(zipFile, sourcePath, zipPath) {
        if (!sourcePath || !await fs.pathExists(sourcePath))
            return;

        const stat = await fs.stat(sourcePath);
        if (stat.isDirectory()) {
            const entries = await fs.readdir(sourcePath);
            for (const entry of entries)
                await this.addBackupPath(zipFile, path.join(sourcePath, entry), `${zipPath}/${entry}`);
            return;
        }

        zipFile.addFile(sourcePath, zipPath);
    }

    async createAdminBackup(userId = '', profileAccessToken = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const backupDir = path.join(this.config.bookDir, 'backup');
        await fs.ensureDir(backupDir);

        const createdAt = new Date();
        const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
        const fileName = `inpx-web-backup-${stamp}-${utils.randomHexString(4)}.zip`;
        const outFile = path.join(backupDir, fileName);
        const zipFile = new yazl.ZipFile();
        const output = fs.createWriteStream(outFile);
        const done = new Promise((resolve, reject) => {
            output.on('finish', resolve);
            output.on('error', reject);
            zipFile.outputStream.on('error', reject);
        });
        zipFile.outputStream.pipe(output);

        zipFile.addBuffer(Buffer.from(JSON.stringify({
            app: this.config.name,
            version: this.config.version,
            createdAt: createdAt.toISOString(),
            note: 'Backup includes runtime config, secrets, user profiles, reading lists, reader progress and bookmarks. It does not include source book archives, generated search DB or caches.',
        }, null, 4)), 'backup-info.json');

        await this.addBackupPath(zipFile, this.config.configFile, 'config.json');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'secret.key'), 'secret.key');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'reading-lists.json'), 'reading-lists.json');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'discovery-cache.json'), 'discovery-cache.json');

        zipFile.end();
        await done;

        return {
            success: true,
            fileName,
            link: `${this.config.bookPathStatic}/backup/${encodeURIComponent(fileName)}`,
            createdAt: createdAt.toISOString(),
        };
    }

    async importAdminBackup(userId = '', profileAccessToken = '', payload = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const rawBase64 = String((payload && (payload.contentBase64 || payload.data)) || '').trim()
            .replace(/^data:[^,]+,/, '');
        if (!rawBase64)
            throw new Error('Файл бэкапа не передан');

        const backupBuffer = Buffer.from(rawBase64, 'base64');
        if (!backupBuffer.length)
            throw new Error('Файл бэкапа пустой');

        const tempDir = this.config.tempDir || os.tmpdir();
        await fs.ensureDir(tempDir);
        const tempFile = path.join(tempDir, `admin-backup-${utils.randomHexString(12)}.zip`);
        const zipReader = new ZipReader();

        try {
            await fs.writeFile(tempFile, backupBuffer);
            await zipReader.open(tempFile, true);

            const entryByName = new Map();
            for (const entry of Object.values(zipReader.entries || {})) {
                if (!entry || entry.isDirectory)
                    continue;
                entryByName.set(String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, ''), entry.name);
            }

            if (!entryByName.has('backup-info.json') || (!entryByName.has('config.json') && !entryByName.has('reading-lists.json')))
                throw new Error('Файл не похож на полный бэкап inpx-web');

            const readEntry = async(name) => {
                const entryName = entryByName.get(name);
                return entryName ? await zipReader.extractToBuf(entryName) : null;
            };
            const readJsonEntry = async(name) => {
                const data = await readEntry(name);
                return data ? JSON.parse(data.toString('utf8')) : null;
            };

            const restored = [];
            const configData = await readJsonEntry('config.json');
            if (configData && typeof configData === 'object' && !Array.isArray(configData)) {
                await fs.ensureDir(path.dirname(this.config.configFile));
                await fs.writeFile(this.config.configFile, JSON.stringify(configData, null, 4));
                Object.assign(this.config, this.normalizeImportedAdminSettings(configData));
                restored.push('config.json');
            }

            const secretKey = await readEntry('secret.key');
            if (secretKey) {
                await fs.ensureDir(this.config.dataDir);
                await fs.writeFile(path.join(this.config.dataDir, 'secret.key'), secretKey);
                restored.push('secret.key');
            }

            const readingLists = await readJsonEntry('reading-lists.json');
            if (readingLists && typeof readingLists === 'object') {
                await this.readingListStore.save(readingLists);
                restored.push('reading-lists.json');
            }

            const discoveryCache = await readJsonEntry('discovery-cache.json');
            if (discoveryCache && typeof discoveryCache === 'object') {
                await fs.ensureDir(this.config.dataDir);
                await fs.writeFile(path.join(this.config.dataDir, 'discovery-cache.json'), JSON.stringify(discoveryCache, null, 2));
                this.discoveryCache = null;
                restored.push('discovery-cache.json');
            }

            if (!restored.length)
                throw new Error('В бэкапе не найдено данных для восстановления');

            this.addAdminEvent('warn', 'settings', `Восстановлен полный бэкап: ${restored.join(', ')}`);
            return {
                success: true,
                restored,
                restartRecommended: true,
                message: 'Полный бэкап восстановлен. Перезапустите приложение, чтобы настройки и ключи точно перечитались. Если менялись источники библиотек, выполните переиндексацию.',
            };
        } finally {
            await zipReader.close().catch(() => {});
            await fs.remove(tempFile);
        }
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
            throw new Error('Список не найден');

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
            throw new Error('404 Файл не найден');

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
            throw new Error('404 Файл не найден');

        const item = await this.readingListStore.setBookRead(userId, listId, bookUid, read);
        await this.readingListStore.setBooksRead(userId, [bookUid], read, {listIds: [listId]});
        return {
            list: this.readingListStore.listStats(item),
            bookUid,
            read: !!read,
        };
    }

    async markReaderBooksRead(userId = '', bookUids = [], read = true, options = {}) {
        this.checkMyState();

        const normalized = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
            .map((bookUid) => String(bookUid || '').trim())
            .filter(Boolean)));
        if (!normalized.length)
            throw new Error('bookUids is empty');

        for (const bookUid of normalized) {
            const book = await this.getBookRecordByUid(bookUid);
            if (!book)
                throw new Error('404 Файл не найден');
        }

        return await this.readingListStore.setBooksRead(userId, normalized, read, options);
    }

    async markSeriesRead(userId = '', series = '', read = true) {
        this.checkMyState();

        const seriesName = String(series || '').trim();
        if (!seriesName)
            throw new Error('series is empty');

        const result = await this.dbSearcher.getSeriesBookList(seriesName);
        const bookUids = (result.books || []).map((book) => book._uid).filter(Boolean);
        const markResult = await this.readingListStore.setBooksRead(userId, bookUids, read);

        return Object.assign({}, markResult, {
            series: seriesName,
        });
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

    async extractBook(libFolder, libFile, sourceLibDir = '') {
        const outFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;

        libFolder = libFolder.replace(/\\/g, '/').replace(/\/\//g, '/');
        const libDir = sourceLibDir || this.config.libDir;

        const file = libFile;
        const resolveFolder = async() => {
            const folder = `${libDir}/${libFolder}`;

            return await this.resolveLibraryArchivePath(folder, libDir);
        };

        const folder = await resolveFolder();
        
        const fullPath = `${folder}/${file}`;

        if (!file || await fs.pathExists(fullPath)) {// файл есть на диске
            
            await fs.copy(fullPath, outFile);
            return outFile;
        } else {// файл в zip-архиве
            if (!await fs.pathExists(folder))
                throw new Error(`archive not found: ${folder}`);

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

                if (!await fs.pathExists(outFile)) {//не удалось найти в архиве, попробуем имя файла в кодировке cp866
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

    async resolveLibraryArchivePath(folder = '', libDir = '') {
        const candidates = [folder];
        const ext = path.extname(folder).toLowerCase();
        if (ext === '.zip')
            candidates.push(`${folder.substring(0, folder.length - 4)}.7z`);
        else if (ext === '.7z')
            candidates.push(`${folder.substring(0, folder.length - 3)}.zip`);

        for (const candidate of candidates) {
            const resolved = await this.resolveExistingPath(candidate);
            if (resolved)
                return resolved;
        }

        const baseName = path.basename(folder);
        const relativeFolder = String(folder || '').startsWith(`${libDir}/`)
            ? String(folder || '').substring(String(libDir || '').length + 1)
            : baseName;
        const directRoots = [
            libDir,
            `${libDir}/fb2`,
            `${libDir}/books`,
            `${libDir}/archives`,
        ].filter(Boolean);

        for (const root of directRoots) {
            for (const name of Array.from(new Set([relativeFolder, baseName]))) {
                const resolved = await this.resolveArchiveNameInDir(root, name);
                if (resolved)
                    return resolved;
            }
        }

        const scanned = new Set(directRoots.map(item => path.resolve(item)));
        try {
            if (libDir && await fs.pathExists(libDir)) {
                const entries = await fs.readdir(libDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;

                    const dir = path.join(libDir, entry.name);
                    const key = path.resolve(dir);
                    if (scanned.has(key))
                        continue;

                    scanned.add(key);
                    const resolved = await this.resolveArchiveNameInDir(dir, baseName);
                    if (resolved)
                        return resolved;
                }
            }
        } catch(e) {
            // keep the original missing archive error
        }

        return folder;
    }

    async resolveArchiveNameInDir(dir = '', name = '') {
        const candidate = path.join(dir, name);
        const candidates = [candidate];
        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.zip')
            candidates.push(`${candidate.substring(0, candidate.length - 4)}.7z`);
        else if (ext === '.7z')
            candidates.push(`${candidate.substring(0, candidate.length - 3)}.zip`);

        for (const item of candidates) {
            const resolved = await this.resolveExistingPath(item);
            if (resolved)
                return resolved;
        }

        return '';
    }

    async resolveExistingPath(filePath = '') {
        if (!filePath)
            return '';
        if (await fs.pathExists(filePath))
            return filePath;

        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath).toLowerCase();
        if (!dir || !baseName || !await fs.pathExists(dir))
            return '';

        try {
            const entries = await fs.readdir(dir);
            const match = entries.find(item => item.toLowerCase() === baseName);
            return match ? path.join(dir, match) : '';
        } catch(e) {
            return '';
        }
    }

    async resolveLibraryAssetDir(subDir = '', sourceLibDir = '') {
        const normalizedSubDir = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        const candidates = [
            `${libDir}/${normalizedSubDir}`,
            `${path.dirname(libDir)}/${normalizedSubDir}`,
        ];

        for (const dir of Array.from(new Set(candidates))) {
            if (await fs.pathExists(dir))
                return dir;
        }

        return candidates[0];
    }

    async resolveLibraryAssetDirs(subDir = '', sourceLibDir = '') {
        const normalizedSubDir = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        const candidates = [
            `${libDir}/${normalizedSubDir}`,
            `${path.dirname(libDir)}/${normalizedSubDir}`,
        ].filter(item => item && !item.startsWith('./'));

        const result = [];
        const seen = new Set();
        for (const dir of candidates) {
            const key = path.resolve(dir).toLowerCase();
            if (seen.has(key))
                continue;

            seen.add(key);
            if (await fs.pathExists(dir))
                result.push(dir);
        }

        return result;
    }

    libraryToolDirs(sourceLibDir = '') {
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        return Array.from(new Set([
            `${libDir}/bin`,
            `${path.dirname(libDir)}/bin`,
        ]));
    }

    async ensureFblibraryArchives(subDir, sourceLibDir = '') {
        if (!this.fblibraryArchives)
            this.fblibraryArchives = {};

        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;

        if (!this.fblibraryArchives[cacheKey] || !this.fblibraryArchives[cacheKey].length) {
            const result = [];
            const dir = await this.resolveLibraryAssetDir(subDir, libDir);

            if (await fs.pathExists(dir)) {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const match = file.match(/(\d{4,})-(\d{4,})\.(zip|7z)$/i);
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
            this.fblibraryArchives[cacheKey] = result;
        }
    }

    async getFblibraryArchive(subDir, libid, sourceLibDir = '') {
        return (await this.getFblibraryArchives(subDir, libid, sourceLibDir))[0];
    }

    async getFblibraryArchives(subDir, libid, sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;
        await this.ensureFblibraryArchives(subDir, libDir);

        return this.fblibraryArchives[cacheKey]
            .filter(item => libid >= item.from && libid <= item.to)
            .sort((a, b) => {
                const aspan = a.to - a.from;
                const bspan = b.to - b.from;
                if (aspan !== bspan)
                    return aspan - bspan;

                return a.from - b.from;
            });
    }

    async getFblibraryImages(libid, sourceLibDir = '') {
        const archives = await this.getFblibraryArchives('images', libid, sourceLibDir);
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
                        result.push(Object.assign({id}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(sourceLibDir), this.config.converterPaths)));
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

    async getFblibraryCover(libid, sourceLibDir = '') {
        const archives = await this.getFblibraryArchives('covers', libid, sourceLibDir);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            try {
                const data = await zipReader.extractToBuf(String(libid));
                return Object.assign({id: '0'}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(sourceLibDir), this.config.converterPaths));
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

        this.authorInfoArchives = [];
        this.authorPictureArchives = [];
        this.authorToArchive = new Map();

        const sources = getEnabledLibrarySources(this.config);
        const scannedAuthorDirs = new Set();

        for (const source of sources) {
            const authorDirs = [
                ...await this.resolveLibraryAssetDirs('etc/authors', source.libDir),
                ...await this.resolveLibraryAssetDirs('authors', source.libDir),
            ];
            for (const authorsDir of authorDirs) {
                const dirKey = path.resolve(authorsDir).toLowerCase();
                if (scannedAuthorDirs.has(dirKey))
                    continue;

                scannedAuthorDirs.add(dirKey);

                const files = await fs.readdir(authorsDir);
                for (const file of files) {
                    if (!/^\d+\.(7z|zip)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    this.authorInfoArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${authorsDir}/${file}`,
                    });
                }

                const picturesDir = `${authorsDir}/pictures`;
                if (!await fs.pathExists(picturesDir))
                    continue;

                const pictureFiles = await fs.readdir(picturesDir);
                for (const file of pictureFiles) {
                    if (!/^\d+\.(zip|7z)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    this.authorPictureArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${picturesDir}/${file}`,
                    });
                }
            }
        }

        const bySourceAndId = (a, b) => {
            const sourceCompare = String(a.sourceId || '').localeCompare(String(b.sourceId || ''));
            if (sourceCompare)
                return sourceCompare;

            return parseInt(a.id, 10) - parseInt(b.id, 10);
        };

        this.authorInfoArchives.sort(bySourceAndId);
        this.authorPictureArchives.sort(bySourceAndId);

        for (const archive of this.authorInfoArchives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                for (const entry of Object.values(zipReader.entries)) {
                    const name = (entry.name || '').replace(/\\/g, '/');
                    if (!name || entry.isDirectory)
                        continue;

                    const hash = getAuthorArchiveEntryHash(name);
                    if (!hash)
                        continue;

                    if (!this.authorToArchive.has(hash))
                        this.authorToArchive.set(hash, []);

                    this.authorToArchive.get(hash).push({
                        archive,
                        entryName: name,
                    });
                }
            } finally {
                await zipReader.close();
            }
        }
    }

    async getAuthorPictureByKey(authorKey, archiveId = '', sourceId = '') {
        await this.ensureAuthorInfoArchives();

        const archives = [];
        if (archiveId) {
            const exactArchive = this.authorPictureArchives.find(item => item.id === String(archiveId) && (!sourceId || item.sourceId === sourceId));
            if (exactArchive)
                archives.push(exactArchive);
        }

        archives.push(...this.authorPictureArchives.filter(item => {
            if (archives.includes(item))
                return false;

            return sourceId && item.sourceId === sourceId;
        }));
        archives.push(...this.authorPictureArchives.filter(item => !archives.includes(item)));

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
                        const image = await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(archive.sourceLibDir), this.config.converterPaths);
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
        const matches = this.authorToArchive.get(hashed) || [];
        if (!hashed || !matches.length)
            return null;

        for (const match of matches) {
            const archive = match.archive;
            const entryName = match.entryName || hashed;
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            let html = '';
            try {
                html = decodeHtmlBuffer(await zipReader.extractToBuf(entryName));
            } catch(e) {
                log(LM_WARN, `author info ${archive.file}:${entryName}: ${e.message}`);
                continue;
            } finally {
                await zipReader.close();
            }

            return {
                key: hashed,
                html,
                text: stripHtml(html),
                photo: await this.getAuthorPictureByKey(hashed, archive.id, archive.sourceId),
            };
        }

        return null;
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

    async injectFblibraryImages(bookFile, libid, sourceLibDir = '') {
        const images = await this.getFblibraryImages(libid, sourceLibDir);
        const cover = await this.getFblibraryCover(libid, sourceLibDir);
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

        let coverHrefId = '';
        const coverHrefMatch = text.match(/<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?([^"']+)["'][^>]*\/?>[\s\S]*?<\/coverpage>/i);
        if (coverHrefMatch)
            coverHrefId = String(coverHrefMatch[1] || '').trim();

        const binaries = [];
        const effectiveCover = (cover && coverHrefId && !existingBinaryIds.has(coverHrefId))
            ? Object.assign({}, cover, {id: coverHrefId})
            : cover;
        const assets = (effectiveCover && !images.some(image => image.id === effectiveCover.id) ? [effectiveCover, ...images] : images);
        for (const image of assets) {
            if (existingBinaryIds.has(image.id))
                continue;

            const base64 = image.data.toString('base64');
            binaries.push(`<binary id="${image.id}" content-type="${image.contentType}">${base64}</binary>`);
        }

        let coverLinked = false;
        if (effectiveCover) {
            coverLinked = /<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?[^"']+["'][^>]*\/?>[\s\S]*?<\/coverpage>/i.test(text);
            if (!coverLinked) {
                const titleInfoRe = /<title-info\b[^>]*>/i;
                const titleInfoMatch = text.match(titleInfoRe);
                if (titleInfoMatch) {
                    const hrefAttr = 'xlink:href';
                    const coverpage = `\n<coverpage><image ${hrefAttr}="#${effectiveCover.id}"/></coverpage>`;
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

    async shouldInjectFblibraryImages(bookFile, libFolder = '') {
        if (path.extname(String(libFolder || '')).toLowerCase() === '.7z')
            return true;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        const text = data.toString();

        return !/<binary\b/i.test(text);
    }

    async restoreBook(bookUid, libFolder, libFile, downFileName, sourceLibDir = '') {
        const db = this.db;

        let extractedFile = '';
        let hash = '';

        if (!this.remoteLib) {
            extractedFile = await this.extractBook(libFolder, libFile, sourceLibDir);
            if (path.extname(libFile).toLowerCase() === '.fb2') {
                const libid = parseInt(path.basename(libFile, path.extname(libFile)), 10);
                if (libid && await this.shouldInjectFblibraryImages(extractedFile, libFolder))
                    await this.injectFblibraryImages(extractedFile, libid, sourceLibDir);
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

        await fs.writeFile(bookFileDesc, JSON.stringify({libFolder, libFile, sourceLibDir, downFileName, assetVersion: bookAssetVersion}));
        this.scheduleCacheClean('после подготовки книги');

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

            //найдем downFileName, libFolder, libFile
            let rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
            if (!rows.length)
                throw new Error('404 Файл не найден');

            const book = rows[0];
            let downFileName = book.file;
            const authors = book.author.split(',');
            let author = authors[0];
            author = author.split(' ').filter(r => r.trim());
            for (let i = 1; i < author.length; i++)
                author[i] = `${(i === 1 ? ' ' : '')}${author[i][0]}.`;
            if (authors.length > 1)
                author.push(' и др.');

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
            const sourceLibDir = book.sourceLibDir || this.config.libDir;

            //найдем хеш
            rows = await db.select({table: 'file_hash', where: `@@id(${db.esc(bookUid)})`});
            if (rows.length) {//хеш найден по bookUid
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
                link = await this.restoreBook(bookUid, libFolder, libFile, downFileName, sourceLibDir);
            }

            if (!link)
                throw new Error('404 Файл не найден');

            return {link, libFolder, libFile, downFileName};
        } catch(e) {
            log(LM_ERR, `getBookLink error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Файл не найден');
            throw e;
        }
    }

    async getPreparedBookFile(bookUid, format = '') {
        const {link, downFileName} = await this.getBookLink(bookUid);
        const hash = path.basename(link);
        const gzipFile = `${this.config.bookDir}/${hash}`;
        const rawFile = `${gzipFile}.raw`;

        let cacheChanged = false;
        if (!await fs.pathExists(rawFile)) {
            await utils.gunzipFile(gzipFile, rawFile);
            cacheChanged = true;
        }

        await utils.touchFile(gzipFile);
        await utils.touchFile(rawFile);

        let rows = await this.db.select({table: 'book', where: `@@hash('_uid', ${this.db.esc(bookUid)})`});
        if (!rows.length)
            throw new Error('404 Файл не найден');

        let preparedFile = rawFile;
        let preparedFileName = downFileName;
        const targetFormat = String(format || '').toLowerCase();
        const sourceFormat = String(rows[0].ext || '').toLowerCase();

        if (targetFormat && targetFormat !== sourceFormat) {
            if (!bookConverter.canConvertSourceTo(sourceFormat, targetFormat))
                throw new Error(`Неподдерживаемый формат отправки: ${targetFormat}`);

            if (!this.config.conversionEnabled)
                throw new Error('Конвертация книг отключена в текущем образе.');

            preparedFile = `${gzipFile}.${targetFormat}`;
            if (!await fs.pathExists(preparedFile)) {
                await bookConverter.convert({
                    inputFile: rawFile,
                    outputFile: preparedFile,
                    format: targetFormat,
                    sourceFileName: downFileName,
                    converterPaths: this.config.converterPaths,
                });
                cacheChanged = true;
            }
            preparedFileName = convertedFileName(downFileName, targetFormat);
            await utils.touchFile(preparedFile);
        }

        if (cacheChanged)
            this.scheduleCacheClean('после обновления книжного кэша');

        return {
            book: rows[0],
            rawFile: preparedFile,
            downFileName: preparedFileName,
        };
    }

    async sendBookToTelegram(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const chatId = String((currentUser && currentUser.telegramChatId) || '').trim();
        if (!this.config.telegramShareEnabled)
            throw new Error('Отправка в Telegram отключена в настройках');
        if (!this.config.telegramBotToken)
            throw new Error('Telegram bot token не указан');
        if (!chatId)
            throw new Error('Telegram chat id не указан в текущем профиле пользователя');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', `Отправка книги в Telegram: ${book.title || downFileName}`);
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
            throw new Error('Telegram API не принял файл');

        this.addAdminEvent('info', 'delivery', `Книга отправлена в Telegram: ${book.title || downFileName}`);
        return {success: true};
    }

    async sendBookToEmail(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const emailTo = String((currentUser && currentUser.emailTo) || this.config.emailTo || '').trim();
        if (!this.config.emailShareEnabled || !this.config.smtpHost || !emailTo)
            throw new Error('Отправка на email не настроена');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', `Отправка книги на email: ${book.title || downFileName}`, {
            to: emailTo,
            format: format || book.ext || '',
        });
        const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());

        const subject = [book.author, book.title].filter(Boolean).join(' - ') || downFileName;
        try {
            await transporter.sendMail({
                from: this.config.emailFrom || this.config.smtpUser || 'inpx-web@localhost',
                to: emailTo,
                subject: `Книга: ${subject}`,
                text: `Во вложении книга "${book.title || downFileName}".`,
                attachments: [
                    {
                        filename: downFileName,
                        path: rawFile,
                    },
                ],
            });
        } catch (err) {
            const response = String((err && (err.response || err.message)) || 'SMTP error');
            const code = (err && (err.responseCode || err.code)) || '';
            const message = `Email не отправлен: ${response}`;
            this.addAdminEvent('error', 'delivery', message, {
                to: emailTo,
                code,
                command: err && err.command,
                rejected: err && err.rejected,
                rejectedErrors: err && err.rejectedErrors ? err.rejectedErrors.map(item => ({
                    recipient: item.recipient,
                    response: item.response,
                    responseCode: item.responseCode,
                    command: item.command,
                })) : undefined,
            });
            throw new Error(message);
        }

        this.addAdminEvent('info', 'delivery', `Книга отправлена на email: ${book.title || downFileName}`);
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

    async getReviewArchives(sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        if (!this.reviewArchives)
            this.reviewArchives = {};

        if (this.reviewArchives[libDir] !== undefined)
            return this.reviewArchives[libDir];

        const reviewsDir = await this.resolveLibraryAssetDir('reviews', libDir);
        const result = [];

        if (!await fs.pathExists(reviewsDir)) {
            this.reviewArchives[libDir] = result;
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

        this.reviewArchives[libDir] = result;
        return result;
    }

    metadataBookUid(book = {}) {
        return String(book._uid || book.uid || book.bookUid || '').trim();
    }

    applyMetadataOverrideToBook(book = {}, overrides = {}) {
        const uid = this.metadataBookUid(book);
        const override = uid ? overrides[uid] : null;
        if (!override)
            return book;

        for (const field of ['title', 'author', 'series', 'serno']) {
            if (utils.hasProp(override, field))
                book[field] = override[field];
        }
        book.metadataOverridden = true;
        book.metadataOverrideUpdatedAt = override.updatedAt || '';
        return book;
    }

    applyMetadataOverridesToRows(rows = [], overrides = {}) {
        for (const row of (Array.isArray(rows) ? rows : [])) {
            this.applyMetadataOverrideToBook(row, overrides);
            if (Array.isArray(row.books))
                row.books.forEach((book) => this.applyMetadataOverrideToBook(book, overrides));
        }
    }

    async applyMetadataOverridesToSearchResult(result = {}) {
        const overrides = await this.readingListStore.getMetadataOverrides();
        this.applyMetadataOverridesToRows(result.found || [], overrides);
        this.applyMetadataOverridesToRows(result.books || [], overrides);
        return result;
    }

    async ensureReviewIndex(sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        if (!this.reviewToArchives)
            this.reviewToArchives = {};

        if (this.reviewToArchives[libDir])
            return this.reviewToArchives[libDir];

        const reviewToArchives = new Map();
        const archives = await this.getReviewArchives(libDir);

        for (const archive of archives) {
            const zipReader = new ZipReader();
            try {
                await zipReader.open(archive.file);
                for (const item of Object.values(zipReader.entries || {})) {
                    const entryName = String(item.name || '').replace(/\\/g, '/');
                    if (!entryName || item.isDirectory)
                        continue;

                    const list = reviewToArchives.get(entryName) || [];
                    list.push({archive: archive.file, entryName});
                    reviewToArchives.set(entryName, list);
                }
            } catch(e) {
                log(LM_WARN, `review archive ${archive.file}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        this.reviewToArchives[libDir] = reviewToArchives;
        return reviewToArchives;
    }

    async getBookReviews(book) {
        const entryKey = `${book.folder}#${book.file}.${book.ext}`;
        const reviewIndex = await this.ensureReviewIndex(book.sourceLibDir);
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
                        name: String(item.name || '').trim() || 'Аноним',
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
                throw new Error('404 Файл не найден');
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

                //проверим существование файла обложки, восстановим если нету
                let coverFile = '';
                if (tmpInfo.cover)
                    coverFile = `${this.config.publicFilesDir}${tmpInfo.cover}`;

                if (book.id != tmpInfo.book.id || tmpInfo.infoVersion !== bookInfoVersion || (coverFile && !await fs.pathExists(coverFile))) {
                    await restoreBookInfo(bookInfo);
                } else {
                    bookInfo = tmpInfo;
                }
            }

            const overrides = await this.readingListStore.getMetadataOverrides();
            if (bookInfo && bookInfo.book)
                this.applyMetadataOverrideToBook(bookInfo.book, overrides);

            return {bookInfo};
        } catch(e) {
            log(LM_ERR, `getBookInfo error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Файл не найден');
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
        const {dir} = config;
        const maxSize = cleanDirMaxSize(config.maxSize);
        const targetRatio = cleanDirTargetRatio(config.targetRatio);
        const targetSize = (maxSize === null ? null : cleanDirTargetSize(maxSize, config.targetSize, targetRatio));
        const result = {
            id: config.id || '',
            title: config.title || '',
            dir,
            maxSize,
            targetSize,
            targetRatio,
            forceTarget: config.forceTarget === true,
            exists: false,
            found: 0,
            removed: 0,
            size: 0,
            after: 0,
            overLimit: false,
        };
        if (!dir || maxSize === null)
            return result;

        if (!await fs.pathExists(dir))
            return result;

        result.exists = true;
        const list = await fs.readdir(dir);

        let size = 0;
        let files = [];
        //формируем список
        for (const filename of list) {
            const filePath = `${dir}/${filename}`;
            const stat = await fs.stat(filePath);
            if (!stat.isDirectory()) {
                size += stat.size;
                files.push({name: filePath, stat});
            }
        }

        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        const initialSize = size;
        result.found = files.length;
        result.size = initialSize;
        result.overLimit = initialSize > maxSize;
        let i = 0;
        //удаляем
        while ((result.overLimit || result.forceTarget) && i < files.length && size > targetSize) {
            const file = files[i];
            const oldFile = file.name;
            try {
                await fs.remove(oldFile);
            } catch (e) {
                log(LM_ERR, `clean dir ${dir}, remove ${oldFile}: ${e.message}`);
            }
            size -= file.stat.size;
            i++;
        }

        if (i) {
            log(LM_WARN, `clean dir ${dir}, maxSize=${maxSize}, targetSize=${targetSize}, found ${files.length} files, total size=${initialSize}, after=${size}`);
            log(LM_WARN, `removed ${i} files`);
        }

        result.removed = i;
        result.after = size;
        return result;
    }

    async periodicCleanDir() {
        try {
            for (const config of this.cacheDirConfig())
                await fs.ensureDir(config.dir);

            while (1) {// eslint-disable-line no-constant-condition
                const delay = this.cacheCleanNextScheduledDelay();
                if (delay === null) {
                    await utils.sleep(60*1000);
                } else if (delay <= 1000) {
                    await this.runCacheClean('плановая ротация');

                    await utils.sleep(60*1000);
                } else {
                    await utils.sleep(Math.min(delay, 60*1000));//интервал проверки не чаще 1 минуты
                }
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


