const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class ReadingListStore {
    constructor(config) {
        this.config = config;
        this.file = path.join(config.dataDir, 'reading-lists.json');
    }

    makeDefaultData() {
        return {
            version: 5,
            users: [this.makeDefaultUser()],
            lists: [],
            sharedDiscoveryConfig: this.normalizeSharedDiscoveryConfig(),
            metadataOverrides: {},
        };
    }

    async ensureData() {
        await fs.ensureDir(path.dirname(this.file));

        if (!await fs.pathExists(this.file)) {
            await this.save(this.makeDefaultData());
        }
    }

    makeId() {
        return crypto.randomBytes(8).toString('hex');
    }

    nowIso() {
        return new Date().toISOString();
    }

    normalizeName(name) {
        return String(name || '').replace(/\s+/g, ' ').trim();
    }

    validateName(name) {
        const normalized = this.normalizeName(name);
        if (!normalized)
            throw new Error('Название списка не должно быть пустым');
        if (normalized.length > 120)
            throw new Error('Название списка слишком длинное');
        return normalized;
    }

    validateUserName(name) {
        const normalized = this.normalizeName(name);
        if (!normalized)
            throw new Error('Имя пользователя не должно быть пустым');
        if (normalized.length > 80)
            throw new Error('Имя пользователя слишком длинное');
        return normalized;
    }

    normalizeLogin(login) {
        return String(login || '').trim().toLowerCase();
    }

    validateLogin(login) {
        const normalized = this.normalizeLogin(login);
        if (!normalized)
            return '';
        if (!/^[a-z0-9._-]{3,64}$/i.test(normalized))
            throw new Error('Логин должен содержать 3-64 символа: буквы, цифры, точку, дефис или подчёркивание');
        return normalized;
    }

    adminLogin() {
        return this.validateLogin(this.config.adminLogin || 'admin');
    }

    adminPassword() {
        return String(this.config.adminPassword || 'admin');
    }

    hashProfilePassword(login, password) {
        return crypto.createHash('sha256')
            .update(`${String(login || '').trim().toLowerCase()}::${String(password || '')}`, 'utf8')
            .digest('hex');
    }

    makeAdminUser() {
        const now = this.nowIso();
        const login = this.adminLogin();
        return {
            id: 'admin',
            name: 'Администратор',
            login,
            passwordHash: this.hashProfilePassword(login, this.adminPassword()),
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: false,
            opdsAuthEnabled: false,
            isAdmin: true,
            createdAt: now,
            updatedAt: now,
        };
    }

    normalizeBookUid(bookUid) {
        return String(bookUid || '').trim();
    }

    normalizeVisibility(value) {
        return (value === 'opds' ? 'opds' : 'private');
    }

    normalizeReaderTheme(theme) {
        const value = String(theme || '').trim().toLowerCase();
        return (['light', 'sepia', 'dark', 'eink'].includes(value) ? value : 'dark');
    }

    normalizeReaderRuntimeSettings(value = {}, defaults = {}) {
        const fontFamily = String(value.fontFamily || defaults.fontFamily || 'serif').trim().toLowerCase();
        const contentWidthMode = String(value.contentWidthMode || defaults.contentWidthMode || 'fixed').trim().toLowerCase();
        const pagedSpreadMode = String(value.pagedSpreadMode || defaults.pagedSpreadMode || 'single').trim().toLowerCase();
        return {
            readMode: (String(value.readMode || defaults.readMode || '').trim().toLowerCase() === 'paged' ? 'paged' : 'scroll'),
            pagedNavigation: (String(value.pagedNavigation || defaults.pagedNavigation || '').trim().toLowerCase() === 'wheel' ? 'wheel' : 'tap'),
            pagedDirection: (String(value.pagedDirection || defaults.pagedDirection || '').trim().toLowerCase() === 'horizontal' ? 'horizontal' : 'vertical'),
            showStatusBar: (value.showStatusBar !== false),
            fontFamily: (['serif', 'sans', 'mono', 'system'].includes(fontFamily) ? fontFamily : 'serif'),
            fontSize: Math.max(14, Math.min(30, parseInt(value.fontSize || defaults.fontSize || 18, 10) || 18)),
            lineHeight: Math.max(1.15, Math.min(2.2, Number(value.lineHeight || defaults.lineHeight || 1.7) || 1.7)),
            contentWidth: Math.max(480, Math.min(2200, parseInt(value.contentWidth || defaults.contentWidth || 1040, 10) || 1040)),
            contentWidthMode: (contentWidthMode === 'viewport' ? 'viewport' : 'fixed'),
            pagedSpreadMode: (pagedSpreadMode === 'dual' ? 'dual' : 'single'),
            einkContrast: Math.max(72, Math.min(100, parseInt(value.einkContrast || defaults.einkContrast || 92, 10) || 92)),
            einkPaperTone: Math.max(84, Math.min(99, parseInt(value.einkPaperTone || defaults.einkPaperTone || 94, 10) || 94)),
            einkInkTone: Math.max(4, Math.min(26, parseInt(value.einkInkTone || defaults.einkInkTone || 10, 10) || 10)),
        };
    }

    normalizeReaderPreferences(value = {}) {
        const defaults = {
            readMode: 'scroll',
            pagedNavigation: 'tap',
            pagedDirection: 'vertical',
            showStatusBar: true,
            fontFamily: 'serif',
            fontSize: 18,
            lineHeight: 1.7,
            contentWidth: 1040,
            contentWidthMode: 'fixed',
            pagedSpreadMode: 'single',
            einkContrast: 92,
            einkPaperTone: 94,
            einkInkTone: 10,
        };
        const einkDefaults = {
            readMode: 'paged',
            pagedNavigation: 'tap',
            pagedDirection: 'vertical',
            showStatusBar: true,
            fontFamily: 'serif',
            fontSize: 19,
            lineHeight: 1.8,
            contentWidth: 920,
            contentWidthMode: 'fixed',
            pagedSpreadMode: 'single',
            einkContrast: 92,
            einkPaperTone: 94,
            einkInkTone: 10,
        };
        return {
            theme: this.normalizeReaderTheme(value.theme),
            ...this.normalizeReaderRuntimeSettings(value, defaults),
            einkProfile: this.normalizeReaderRuntimeSettings(value.einkProfile || {}, einkDefaults),
        };
    }

    normalizeDiscoveryPreferences(value = {}) {
        const hiddenBooks = Array.from(new Set(
            (Array.isArray(value.hiddenBooks) ? value.hiddenBooks : [])
                .map((bookUid) => this.normalizeBookUid(bookUid))
                .filter(Boolean)
        )).slice(0, 5000);

        return {
            hiddenBooks,
        };
    }

    normalizeSharedDiscoveryConfig(value = {}) {
        const sourceValue = String(value.externalSource || 'none').trim().toLowerCase();
        return {
            externalSource: (sourceValue && sourceValue !== 'none' ? 'web-page' : 'none'),
            externalName: String(value.externalName || '').trim(),
            externalUrl: String(value.externalUrl || '').trim(),
            externalLimit: Math.max(1, Math.min(parseInt(value.externalLimit, 10) || 8, 24)),
            externalTtlMinutes: Math.max(1440, Math.min(parseInt(value.externalTtlMinutes, 10) || 1440, 10080)),
        };
    }

    normalizeReaderProgress(value = {}) {
        const result = {};
        for (const [bookUid, row] of Object.entries(value || {})) {
            const normalizedBookUid = this.normalizeBookUid(bookUid);
            if (!normalizedBookUid || !row || typeof(row) !== 'object')
                continue;

            const percent = Number(row.percent);
            result[normalizedBookUid] = {
                percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
                sectionId: String(row.sectionId || '').trim(),
                updatedAt: String(row.updatedAt || '').trim() || this.nowIso(),
                hidden: (row.hidden === true),
            };
        }
        return result;
    }

    normalizeReaderBookmarks(value = {}) {
        const result = {};

        for (const [bookUid, rows] of Object.entries(value || {})) {
            const normalizedBookUid = this.normalizeBookUid(bookUid);
            if (!normalizedBookUid || !Array.isArray(rows))
                continue;

            const seenIds = new Set();
            result[normalizedBookUid] = rows
                .map((row) => ({
                    id: String(row && row.id ? row.id : '').trim() || this.makeId(),
                    sectionId: String(row && row.sectionId ? row.sectionId : '').trim(),
                    title: this.normalizeName(row && row.title ? row.title : '') || 'Закладка',
                    excerpt: this.normalizeName(row && row.excerpt ? row.excerpt : ''),
                    note: this.normalizeName(row && row.note ? row.note : ''),
                    percent: Number.isFinite(Number(row && row.percent)) ? Math.max(0, Math.min(1, Number(row.percent))) : 0,
                    createdAt: String(row && row.createdAt ? row.createdAt : '').trim() || this.nowIso(),
                }))
                .filter((item) => {
                    if (!item.id || seenIds.has(item.id))
                        return false;
                    seenIds.add(item.id);
                    return true;
                })
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        }

        return result;
    }

    normalizeMetadataPatch(value = {}) {
        const result = {};
        if (Object.prototype.hasOwnProperty.call(value, 'title')) {
            result.title = this.normalizeName(value.title);
            if (!result.title)
                throw new Error('Название книги не должно быть пустым');
        }
        if (Object.prototype.hasOwnProperty.call(value, 'author')) {
            result.author = this.normalizeName(value.author);
            if (!result.author)
                throw new Error('Автор книги не должен быть пустым');
        }
        if (Object.prototype.hasOwnProperty.call(value, 'series'))
            result.series = this.normalizeName(value.series);
        if (Object.prototype.hasOwnProperty.call(value, 'serno')) {
            const serno = parseInt(value.serno, 10);
            result.serno = Number.isFinite(serno) && serno > 0 ? serno : '';
        }
        return result;
    }

    normalizeMetadataOverrides(value = {}) {
        const result = {};
        for (const [bookUid, row] of Object.entries(value || {})) {
            const uid = this.normalizeBookUid(bookUid);
            if (!uid || !row || typeof(row) !== 'object')
                continue;

            const patch = this.normalizeMetadataPatch(row);
            if (Object.keys(patch).length) {
                result[uid] = Object.assign(patch, {
                    updatedAt: String(row.updatedAt || '').trim() || this.nowIso(),
                });
            }
        }
        return result;
    }

    makeDefaultUser() {
        const now = this.nowIso();
        return {
            id: 'default',
            name: 'Без профиля',
            login: '',
            passwordHash: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: true,
            opdsAuthEnabled: false,
            readerPreferences: this.normalizeReaderPreferences(),
            readerProgress: {},
            readerBookmarks: {},
            discoveryPreferences: this.normalizeDiscoveryPreferences(),
            createdAt: now,
            updatedAt: now,
        };
    }

    normalizeEntries(entries) {
        const result = [];
        const seen = new Set();

        for (const row of (Array.isArray(entries) ? entries : [])) {
            let entry;
            if (typeof(row) === 'string') {
                entry = {
                    bookUid: this.normalizeBookUid(row),
                    read: false,
                };
            } else {
                entry = {
                    bookUid: this.normalizeBookUid(row.bookUid || row.uid || row.id),
                    read: !!row.read,
                };
            }

            if (!entry.bookUid || seen.has(entry.bookUid))
                continue;

            seen.add(entry.bookUid);
            result.push(entry);
        }

        return result;
    }

    normalizeUser(item, fallback = {}) {
        const now = this.nowIso();
        const normalized = Object.assign({}, fallback, item);
        normalized.id = String(normalized.id || '').trim() || this.makeId();
        normalized.name = this.validateUserName(normalized.name || fallback.name || 'Пользователь');
        normalized.login = this.validateLogin(normalized.login || '');
        normalized.passwordHash = String(normalized.passwordHash || '').trim();
        normalized.emailTo = String(normalized.emailTo || '').trim();
        normalized.telegramChatId = String(normalized.telegramChatId || '').trim();
        normalized.opdsEnabled = (normalized.opdsEnabled !== false);
        normalized.opdsAuthEnabled = (normalized.opdsAuthEnabled === true);
        normalized.readerPreferences = this.normalizeReaderPreferences(normalized.readerPreferences);
        normalized.readerProgress = this.normalizeReaderProgress(normalized.readerProgress);
        normalized.readerBookmarks = this.normalizeReaderBookmarks(normalized.readerBookmarks);
        normalized.discoveryPreferences = this.normalizeDiscoveryPreferences(normalized.discoveryPreferences);
        normalized.isAdmin = !!normalized.isAdmin;
        normalized.createdAt = normalized.createdAt || now;
        normalized.updatedAt = normalized.updatedAt || now;
        return normalized;
    }

    normalizeList(item, defaultUserId) {
        const now = this.nowIso();
        const normalized = Object.assign({}, item);
        normalized.id = String(normalized.id || '').trim() || this.makeId();
        normalized.userId = String(normalized.userId || defaultUserId || '').trim();
        normalized.name = this.validateName(normalized.name);
        normalized.visibility = this.normalizeVisibility(normalized.visibility);
        normalized.createdAt = normalized.createdAt || now;
        normalized.updatedAt = normalized.updatedAt || now;
        normalized.books = this.normalizeEntries(normalized.books);
        return normalized;
    }

    normalizeData(data) {
        const defaultUser = this.makeDefaultUser();
        const source = Object.assign({version: 5, users: [], lists: [], sharedDiscoveryConfig: {}, metadataOverrides: {}}, data || {});
        let users = [];

        if (Array.isArray(source.users) && source.users.length) {
            for (const item of source.users) {
                try {
                    users.push(this.normalizeUser(item, defaultUser));
                } catch (e) {
                    // ignore malformed user rows
                }
            }
        }

        if (!users.length) {
            users = [defaultUser];
        }

        const seenUserIds = new Set();
        users = users.filter((item) => {
            if (!item.id || seenUserIds.has(item.id))
                return false;
            seenUserIds.add(item.id);
            return true;
        });

        const defaultUserId = users[0].id;
        const lists = [];
        for (const item of (Array.isArray(source.lists) ? source.lists : [])) {
            try {
                const normalized = this.normalizeList(item, defaultUserId);
                if (!seenUserIds.has(normalized.userId))
                    normalized.userId = defaultUserId;
                lists.push(normalized);
            } catch (e) {
                // ignore malformed lists
            }
        }

        return {
            version: 5,
            users,
            lists,
            sharedDiscoveryConfig: this.normalizeSharedDiscoveryConfig(source.sharedDiscoveryConfig),
            metadataOverrides: this.normalizeMetadataOverrides(source.metadataOverrides),
        };
    }

    applyAdminBootstrap(data) {
        const source = this.normalizeData(data);
        const users = [...source.users];
        let changed = false;

        const adminTemplate = this.makeAdminUser();
        let admin = users.find((item) => item.isAdmin) || users.find((item) => item.id === adminTemplate.id) || null;

        if (!admin) {
            users.unshift(adminTemplate);
            changed = true;
        } else {
            if (!admin.isAdmin) {
                admin.isAdmin = true;
                changed = true;
            }

            if (!admin.login) {
                admin.login = adminTemplate.login;
                changed = true;
            }

            const duplicate = users.find((item) => item.id !== admin.id && item.login === adminTemplate.login);
            if (duplicate && this.config.resetAdminPassword)
                throw new Error(`Admin login "${adminTemplate.login}" already used by another profile`);

            if (!admin.passwordHash || this.config.resetAdminPassword) {
                admin.login = adminTemplate.login;
                admin.passwordHash = adminTemplate.passwordHash;
                admin.updatedAt = this.nowIso();
                changed = true;
            }

            if (admin.opdsEnabled !== false) {
                admin.opdsEnabled = false;
                changed = true;
            }

            if (admin.opdsAuthEnabled !== false) {
                admin.opdsAuthEnabled = false;
                changed = true;
            }
        }

        const adminIndex = users.findIndex((item) => item.id === adminTemplate.id || item.isAdmin);
        if (adminIndex > 0) {
            const [adminUser] = users.splice(adminIndex, 1);
            users.unshift(adminUser);
            changed = true;
        }

        return {
            data: {
                version: 5,
                users,
                lists: source.lists,
                sharedDiscoveryConfig: source.sharedDiscoveryConfig,
                metadataOverrides: source.metadataOverrides,
            },
            changed,
        };
    }

    async load() {
        await this.ensureData();
        let raw = null;
        try {
            const text = await fs.readFile(this.file, 'utf8');
            const normalized = String(text || '').trim();
            if (!normalized)
                throw new Error('reading-lists.json is empty');
            raw = JSON.parse(normalized);
        } catch (e) {
            await this.backupBrokenStore(e);
            raw = this.makeDefaultData();
            await this.save(raw);
        }

        const {data, changed} = this.applyAdminBootstrap(raw);
        if (changed)
            await this.writeData(data);
        return data;
    }

    async backupBrokenStore(error = null) {
        if (!await fs.pathExists(this.file))
            return;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = `${this.file}.broken-${stamp}`;
        try {
            await fs.copy(this.file, backupFile, {overwrite: false});
        } catch (copyError) {
            try {
                await fs.copy(this.file, `${backupFile}-${crypto.randomBytes(3).toString('hex')}`, {overwrite: false});
            } catch (e) {
                // Keep loading usable even if the broken file cannot be backed up.
            }
        }

        if (error && error.message)
            await fs.writeFile(`${backupFile}.error.txt`, String(error.stack || error.message));
    }

    async save(data) {
        const out = this.normalizeData(data);
        await this.writeData(out);
    }

    async writeData(data) {
        await fs.ensureDir(path.dirname(this.file));
        const tmpFile = `${this.file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
        await fs.rename(tmpFile, this.file);
    }

    async getSharedDiscoveryConfig() {
        const data = await this.load();
        return this.normalizeSharedDiscoveryConfig(data.sharedDiscoveryConfig);
    }

    async updateSharedDiscoveryConfig(patch = {}) {
        const data = await this.load();
        data.sharedDiscoveryConfig = this.normalizeSharedDiscoveryConfig(Object.assign({}, data.sharedDiscoveryConfig || {}, patch || {}));
        await this.save(data);
        return data.sharedDiscoveryConfig;
    }

    async getMetadataOverrides() {
        const data = await this.load();
        return this.normalizeMetadataOverrides(data.metadataOverrides);
    }

    async updateMetadataOverride(bookUid = '', patch = {}) {
        const uid = this.normalizeBookUid(bookUid);
        if (!uid)
            throw new Error('Не указан идентификатор книги');

        const data = await this.load();
        const normalized = this.normalizeMetadataPatch(patch || {});
        if (!Object.keys(normalized).length)
            throw new Error('Не указаны данные для сохранения');

        data.metadataOverrides = this.normalizeMetadataOverrides(data.metadataOverrides);
        data.metadataOverrides[uid] = Object.assign({}, data.metadataOverrides[uid] || {}, normalized, {
            updatedAt: this.nowIso(),
        });
        await this.save(data);
        return data.metadataOverrides[uid];
    }

    async resolveUser(userId = '') {
        const data = await this.load();
        const normalizedUserId = String(userId || '').trim();
        const user = data.users.find((item) => item.id === normalizedUserId)
            || data.users.find((item) => item.login === normalizedUserId)
            || data.users[0];
        if (!user)
            throw new Error('Пользователь не найден');

        return {
            data,
            user,
        };
    }

    ensureUniqueUserName(users, name, excludeId = '') {
        const duplicate = users.find((item) => item.id !== excludeId && item.name.toLowerCase() === name.toLowerCase());
        if (duplicate)
            throw new Error('Пользователь с таким именем уже существует');
    }

    ensureUniqueUserLogin(users, login, excludeId = '') {
        if (!login)
            return;

        const duplicate = users.find((item) => item.id !== excludeId && item.login === login);
        if (duplicate)
            throw new Error('Пользователь с таким логином уже существует');
    }

    async getUsers(currentUserId = '') {
        const {data, user} = await this.resolveUser(currentUserId);
        return {
            users: data.users,
            currentUser: user,
        };
    }

    async getUser(userId = '') {
        const {user} = await this.resolveUser(userId);
        return user;
    }

    async findUserByLogin(login = '') {
        const normalizedLogin = this.validateLogin(login);
        if (!normalizedLogin)
            return null;

        const data = await this.load();
        return data.users.find((item) => item.login === normalizedLogin) || null;
    }

    async getOpdsUsers() {
        const data = await this.load();
        const stats = new Map();

        for (const item of data.lists) {
            if (item.visibility !== 'opds')
                continue;

            const count = stats.get(item.userId) || 0;
            stats.set(item.userId, count + 1);
        }

        const progressCounts = new Map();
        for (const item of data.users) {
            const progressMap = (item && item.readerProgress && typeof(item.readerProgress) === 'object' ? item.readerProgress : {});
            const count = Object.values(progressMap).filter((progress) => progress && progress.hidden !== true).length;
            if (count)
                progressCounts.set(item.id, count);
        }

        return data.users
            .filter((item) => item.opdsEnabled && (stats.has(item.id) || progressCounts.has(item.id)))
            .map((item) => ({
                id: item.id,
                publicId: item.login || item.id,
                name: item.name,
                opdsAuthEnabled: item.opdsAuthEnabled === true,
                opdsListCount: stats.get(item.id) || 0,
                opdsProgressCount: progressCounts.get(item.id) || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }

    async getOpdsUser(publicId = '') {
        const normalized = String(publicId || '').trim();
        if (!normalized)
            return null;

        const data = await this.load();
        const user = data.users.find((item) => item.id === normalized || item.login === normalized);
        if (!user || user.opdsEnabled === false)
            return null;

        return user;
    }

    async verifyOpdsPassword(publicId = '', login = '', password = '') {
        const user = await this.getOpdsUser(publicId);
        if (!user || user.opdsAuthEnabled !== true)
            return {user, authorized: true};

        if (!user.login || !user.passwordHash)
            return {user, authorized: false};

        const normalizedLogin = this.normalizeLogin(login);
        const passwordHash = this.hashProfilePassword(user.login, password);
        return {
            user,
            authorized: normalizedLogin === user.login && passwordHash === user.passwordHash,
        };
    }

    async createUser(profile = {}) {
        const data = await this.load();
        const normalizedName = this.validateUserName(profile.name);
        this.ensureUniqueUserName(data.users, normalizedName);
        const normalizedLogin = this.validateLogin(profile.login);
        this.ensureUniqueUserLogin(data.users, normalizedLogin);

        const user = this.normalizeUser({
            name: normalizedName,
            login: normalizedLogin,
            passwordHash: String(profile.passwordHash || '').trim(),
            emailTo: profile.emailTo,
            telegramChatId: profile.telegramChatId,
            opdsEnabled: profile.opdsEnabled,
            opdsAuthEnabled: profile.opdsAuthEnabled,
            isAdmin: false,
        });
        if (user.opdsAuthEnabled && (!user.login || !user.passwordHash))
            throw new Error('Для OPDS-авторизации у профиля должен быть логин и пароль');

        data.users.push(user);
        await this.save(data);
        return user;
    }

    async updateUser(userId, patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const nextName = this.validateUserName(utilsHasProp(patch, 'name') ? patch.name : target.name);
        const nextLogin = this.validateLogin(utilsHasProp(patch, 'login') ? patch.login : target.login);
        this.ensureUniqueUserName(data.users, nextName, target.id);
        this.ensureUniqueUserLogin(data.users, nextLogin, target.id);

        target.name = nextName;
        target.login = nextLogin;
        if (utilsHasProp(patch, 'passwordHash'))
            target.passwordHash = String(patch.passwordHash || '').trim();
        if (utilsHasProp(patch, 'emailTo'))
            target.emailTo = String(patch.emailTo || '').trim();
        if (utilsHasProp(patch, 'telegramChatId'))
            target.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utilsHasProp(patch, 'opdsEnabled'))
            target.opdsEnabled = (patch.opdsEnabled !== false);
        if (utilsHasProp(patch, 'opdsAuthEnabled'))
            target.opdsAuthEnabled = (patch.opdsAuthEnabled === true);
        if (utilsHasProp(patch, 'readerPreferences'))
            target.readerPreferences = this.normalizeReaderPreferences(patch.readerPreferences);
        if (target.opdsAuthEnabled && (!target.login || !target.passwordHash))
            throw new Error('Для OPDS-авторизации у профиля должен быть логин и пароль');
        target.updatedAt = this.nowIso();

        await this.save(data);
        return target;
    }

    async getReaderState(userId = '', bookUid = '') {
        const {user} = await this.resolveUser(userId);
        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        return {
            preferences: this.normalizeReaderPreferences(user.readerPreferences),
            progress: Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, user.readerProgress[normalizedBookUid] || {}),
            bookmarks: (user.readerBookmarks && Array.isArray(user.readerBookmarks[normalizedBookUid]) ? user.readerBookmarks[normalizedBookUid] : []),
        };
    }

    async updateReaderPreferences(userId = '', patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        target.readerPreferences = this.normalizeReaderPreferences(Object.assign({}, target.readerPreferences || {}, patch || {}));
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerPreferences;
    }

    async updateDiscoveryPreferences(userId = '', patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const current = this.normalizeDiscoveryPreferences(target.discoveryPreferences);
        let hiddenBooks = Array.from(current.hiddenBooks || []);

        if (utilsHasProp(patch, 'hiddenBooks'))
            hiddenBooks = this.normalizeDiscoveryPreferences({hiddenBooks: patch.hiddenBooks}).hiddenBooks;

        if (Array.isArray(patch.hiddenBooksAdd)) {
            const additions = this.normalizeDiscoveryPreferences({hiddenBooks: patch.hiddenBooksAdd}).hiddenBooks;
            hiddenBooks = Array.from(new Set(hiddenBooks.concat(additions)));
        }

        if (Array.isArray(patch.hiddenBooksRemove) && patch.hiddenBooksRemove.length) {
            const removals = new Set(this.normalizeDiscoveryPreferences({hiddenBooks: patch.hiddenBooksRemove}).hiddenBooks);
            hiddenBooks = hiddenBooks.filter((bookUid) => !removals.has(bookUid));
        }

        target.discoveryPreferences = this.normalizeDiscoveryPreferences({hiddenBooks});
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.discoveryPreferences;
    }

    async updateReaderProgress(userId = '', bookUid = '', patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        if (!target.readerProgress || typeof(target.readerProgress) !== 'object')
            target.readerProgress = {};

        const current = target.readerProgress[normalizedBookUid] || {};
        const percent = Number(utilsHasProp(patch, 'percent') ? patch.percent : current.percent);
        const sectionId = String(utilsHasProp(patch, 'sectionId') ? patch.sectionId : current.sectionId || '').trim();
        const hidden = (utilsHasProp(patch, 'hidden') ? patch.hidden === true : false);
        target.readerProgress[normalizedBookUid] = {
            percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
            sectionId,
            updatedAt: this.nowIso(),
            hidden,
        };
        target.updatedAt = this.nowIso();

        await this.save(data);
        return target.readerProgress[normalizedBookUid];
    }

    async deleteReaderProgress(userId = '', bookUid = '') {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        if (target.readerProgress && typeof(target.readerProgress) === 'object')
            delete target.readerProgress[normalizedBookUid];

        target.updatedAt = this.nowIso();
        await this.save(data);
        return {success: true};
    }

    async addReaderBookmark(userId = '', bookUid = '', bookmark = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        if (!target.readerBookmarks || typeof(target.readerBookmarks) !== 'object')
            target.readerBookmarks = {};

        const current = Array.isArray(target.readerBookmarks[normalizedBookUid]) ? target.readerBookmarks[normalizedBookUid] : [];
        current.unshift({
            id: this.makeId(),
            sectionId: String(bookmark.sectionId || '').trim(),
            title: this.normalizeName(bookmark.title || '') || 'Закладка',
            excerpt: this.normalizeName(bookmark.excerpt || ''),
            note: this.normalizeName(bookmark.note || ''),
            percent: Number.isFinite(Number(bookmark.percent)) ? Math.max(0, Math.min(1, Number(bookmark.percent))) : 0,
            createdAt: this.nowIso(),
        });

        target.readerBookmarks[normalizedBookUid] = this.normalizeReaderBookmarks({[normalizedBookUid]: current})[normalizedBookUid] || [];
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerBookmarks[normalizedBookUid];
    }

    async deleteReaderBookmark(userId = '', bookUid = '', bookmarkId = '') {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        const normalizedBookmarkId = String(bookmarkId || '').trim();
        if (!normalizedBookmarkId)
            throw new Error('bookmarkId is empty');

        const current = Array.isArray(target.readerBookmarks && target.readerBookmarks[normalizedBookUid])
            ? target.readerBookmarks[normalizedBookUid]
            : [];
        target.readerBookmarks = Object.assign({}, target.readerBookmarks, {
            [normalizedBookUid]: current.filter((item) => item.id !== normalizedBookmarkId),
        });
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerBookmarks[normalizedBookUid] || [];
    }

    async deleteUser(userId) {
        const data = await this.load();
        if (data.users.length <= 1)
            throw new Error('Нельзя удалить последнего пользователя');

        const index = data.users.findIndex((item) => item.id === userId);
        if (index < 0)
            throw new Error('Пользователь не найден');

        if (data.users[index].isAdmin)
            throw new Error('Нельзя удалить профиль администратора');

        const [removed] = data.users.splice(index, 1);
        data.lists = data.lists.filter((item) => item.userId !== removed.id);

        await this.save(data);
        return {
            success: true,
            nextUserId: data.users[0] ? data.users[0].id : '',
        };
    }

    countRead(entries) {
        return this.normalizeEntries(entries).filter((item) => item.read).length;
    }

    listStats(item, bookUid = '') {
        const entries = this.normalizeEntries(item.books);
        const currentEntry = (bookUid ? this.findEntry(entries, bookUid) : null);
        return {
            id: item.id,
            userId: item.userId,
            name: item.name,
            visibility: this.normalizeVisibility(item.visibility),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            bookCount: entries.length,
            readCount: this.countRead(entries),
            containsBook: !!currentEntry,
            readBook: !!(currentEntry && currentEntry.read),
        };
    }

    async getLists(userId = '', options = {}) {
        const {data, user} = await this.resolveUser(userId);
        const visibility = (options && options.visibility ? this.normalizeVisibility(options.visibility) : '');

        return data.lists
            .filter((item) => item.userId === user.id)
            .filter((item) => (!visibility || item.visibility === visibility))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }

    async getList(userId = '', listId = '', options = {}) {
        const allowForeign = !!(options && options.allowForeign);
        const visibility = (options && options.visibility ? this.normalizeVisibility(options.visibility) : '');
        const normalizedListId = String(listId || '').trim();
        if (!normalizedListId)
            return null;

        const data = await this.load();
        let item = data.lists.find((row) => row.id === normalizedListId) || null;
        if (!item)
            return null;

        if (!allowForeign) {
            const {user} = await this.resolveUser(userId);
            if (item.userId !== user.id)
                return null;
        }

        if (visibility && item.visibility !== visibility)
            return null;

        return item;
    }

    ensureUniqueListName(lists, userId, name, excludeId = '') {
        const duplicate = lists.find((item) => item.userId === userId && item.id !== excludeId && item.name.toLowerCase() === name.toLowerCase());
        if (duplicate)
            throw new Error('Список с таким названием уже существует');
    }

    async createList(userId = '', name, visibility = 'private') {
        const {data, user} = await this.resolveUser(userId);
        const normalized = this.validateName(name);
        this.ensureUniqueListName(data.lists, user.id, normalized);

        const now = this.nowIso();
        const item = this.normalizeList({
            id: this.makeId(),
            userId: user.id,
            name: normalized,
            visibility,
            createdAt: now,
            updatedAt: now,
            books: [],
        }, user.id);

        data.lists.push(item);
        await this.save(data);
        return item;
    }

    async renameList(userId = '', listId, name) {
        const {data, user} = await this.resolveUser(userId);
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error('Список не найден');

        const normalized = this.validateName(name);
        this.ensureUniqueListName(data.lists, user.id, normalized, item.id);
        item.name = normalized;
        item.updatedAt = this.nowIso();

        await this.save(data);
        return item;
    }

    async setListVisibility(userId = '', listId, visibility) {
        const {data, user} = await this.resolveUser(userId);
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error('Список не найден');

        item.visibility = this.normalizeVisibility(visibility);
        item.updatedAt = this.nowIso();

        await this.save(data);
        return item;
    }

    async deleteList(userId = '', listId) {
        const {data, user} = await this.resolveUser(userId);
        const index = data.lists.findIndex((row) => row.id === listId && row.userId === user.id);
        if (index < 0)
            throw new Error('Список не найден');

        data.lists.splice(index, 1);
        await this.save(data);
        return {success: true};
    }

    findEntry(entries, bookUid) {
        return this.normalizeEntries(entries).find((item) => item.bookUid === bookUid) || null;
    }

    async setBookMembership(userId = '', listId, bookUid, enabled) {
        const {data, user} = await this.resolveUser(userId);
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error('Список не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        item.books = this.normalizeEntries(item.books);
        const existing = item.books.find((row) => row.bookUid === normalizedBookUid);

        if (enabled) {
            if (!existing)
                item.books.push({bookUid: normalizedBookUid, read: false});
        } else {
            item.books = item.books.filter((row) => row.bookUid !== normalizedBookUid);
        }

        item.updatedAt = this.nowIso();
        await this.save(data);
        return item;
    }

    async setBookRead(userId = '', listId, bookUid, read) {
        const {data, user} = await this.resolveUser(userId);
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error('Список не найден');

        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');

        item.books = this.normalizeEntries(item.books);
        const existing = item.books.find((row) => row.bookUid === normalizedBookUid);
        if (!existing)
            throw new Error('Книга не найдена в списке');

        existing.read = !!read;
        item.updatedAt = this.nowIso();
        await this.save(data);
        return item;
    }

    async setBooksRead(userId = '', bookUids = [], read = true, options = {}) {
        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        if (!target)
            throw new Error('Пользователь не найден');

        const normalizedBookUids = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
            .map((bookUid) => this.normalizeBookUid(bookUid))
            .filter(Boolean)));
        if (!normalizedBookUids.length)
            throw new Error('bookUids is empty');

        const bookUidSet = new Set(normalizedBookUids);
        const listIds = Array.isArray(options.listIds)
            ? new Set(options.listIds.map((id) => String(id || '').trim()).filter(Boolean))
            : null;

        if (!target.readerProgress || typeof(target.readerProgress) !== 'object')
            target.readerProgress = {};

        const updatedAt = this.nowIso();
        for (const bookUid of normalizedBookUids) {
            if (read) {
                target.readerProgress[bookUid] = {
                    percent: 1,
                    sectionId: '',
                    updatedAt,
                    hidden: false,
                };
            } else {
                delete target.readerProgress[bookUid];
            }
        }

        const updatedLists = [];
        for (const item of data.lists) {
            if (item.userId !== user.id)
                continue;
            if (listIds && !listIds.has(String(item.id || '').trim()))
                continue;

            let changed = false;
            item.books = this.normalizeEntries(item.books);
            for (const entry of item.books) {
                if (bookUidSet.has(entry.bookUid) && entry.read !== !!read) {
                    entry.read = !!read;
                    changed = true;
                }
            }

            if (changed) {
                item.updatedAt = updatedAt;
                updatedLists.push(this.listStats(item));
            }
        }

        target.updatedAt = updatedAt;
        await this.save(data);
        return {
            success: true,
            read: !!read,
            bookUids: normalizedBookUids,
            changedBooks: normalizedBookUids.length,
            updatedLists,
        };
    }

    async addBooks(userId = '', listId, bookUids = []) {
        const {data, user} = await this.resolveUser(userId);
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error('Список не найден');

        item.books = this.normalizeEntries(item.books);
        const existing = new Set(item.books.map((row) => row.bookUid));

        let added = 0;
        for (const rawUid of bookUids) {
            const bookUid = this.normalizeBookUid(rawUid);
            if (!bookUid || existing.has(bookUid))
                continue;

            existing.add(bookUid);
            item.books.push({bookUid, read: false});
            added++;
        }

        item.updatedAt = this.nowIso();
        await this.save(data);
        return {item, added};
    }

    async exportData(userId = '') {
        const {user} = await this.resolveUser(userId);
        const lists = await this.getLists(user.id);

        return {
            version: 4,
            exportedAt: this.nowIso(),
            user: {
                id: user.id,
                name: user.name,
                emailTo: user.emailTo,
                telegramChatId: user.telegramChatId,
                opdsEnabled: user.opdsEnabled,
                opdsAuthEnabled: user.opdsAuthEnabled,
                readerPreferences: this.normalizeReaderPreferences(user.readerPreferences),
                readerProgress: this.normalizeReaderProgress(user.readerProgress),
                readerBookmarks: this.normalizeReaderBookmarks(user.readerBookmarks),
                discoveryPreferences: this.normalizeDiscoveryPreferences(user.discoveryPreferences),
            },
            lists: lists.map((item) => ({
                name: item.name,
                visibility: this.normalizeVisibility(item.visibility),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                books: this.normalizeEntries(item.books),
            })),
        };
    }

    async importData(userId = '', payload) {
        if (!payload || !Array.isArray(payload.lists))
            throw new Error('Некорректный файл импорта списков');

        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        const incomingUser = (payload.user && typeof(payload.user) === 'object') ? payload.user : {};
        let importedLists = 0;
        let importedBooks = 0;
        let importedProgress = 0;
        let importedBookmarks = 0;

        if (target) {
            if (utilsHasProp(incomingUser, 'name')) {
                const normalizedName = this.validateUserName(incomingUser.name);
                const duplicateName = data.users.find((item) => item.id !== target.id && item.name.toLowerCase() === normalizedName.toLowerCase());
                if (!duplicateName)
                    target.name = normalizedName;
            }
            if (utilsHasProp(incomingUser, 'emailTo'))
                target.emailTo = String(incomingUser.emailTo || '').trim();
            if (utilsHasProp(incomingUser, 'telegramChatId'))
                target.telegramChatId = String(incomingUser.telegramChatId || '').trim();
            if (utilsHasProp(incomingUser, 'opdsEnabled'))
                target.opdsEnabled = (incomingUser.opdsEnabled !== false);
            if (utilsHasProp(incomingUser, 'opdsAuthEnabled'))
                target.opdsAuthEnabled = (incomingUser.opdsAuthEnabled === true);
            if (utilsHasProp(incomingUser, 'readerPreferences'))
                target.readerPreferences = this.normalizeReaderPreferences(incomingUser.readerPreferences);
            if (utilsHasProp(incomingUser, 'discoveryPreferences'))
                target.discoveryPreferences = this.normalizeDiscoveryPreferences(incomingUser.discoveryPreferences);

            if (utilsHasProp(incomingUser, 'readerProgress')) {
                const progress = this.normalizeReaderProgress(incomingUser.readerProgress);
                target.readerProgress = Object.assign({}, target.readerProgress || {}, progress);
                importedProgress = Object.keys(progress).length;
            }

            if (utilsHasProp(incomingUser, 'readerBookmarks')) {
                const bookmarks = this.normalizeReaderBookmarks(incomingUser.readerBookmarks);
                target.readerBookmarks = Object.assign({}, target.readerBookmarks || {});
                for (const [bookUid, incomingRows] of Object.entries(bookmarks)) {
                    const current = Array.isArray(target.readerBookmarks[bookUid]) ? target.readerBookmarks[bookUid] : [];
                    const seenIds = new Set(current.map((item) => String(item.id || '').trim()).filter(Boolean));
                    const merged = current.slice();
                    for (const bookmark of incomingRows) {
                        if (seenIds.has(bookmark.id))
                            continue;

                        seenIds.add(bookmark.id);
                        merged.push(bookmark);
                        importedBookmarks++;
                    }
                    target.readerBookmarks[bookUid] = this.normalizeReaderBookmarks({[bookUid]: merged})[bookUid] || [];
                }
            }

            target.updatedAt = this.nowIso();
        }

        for (const incoming of payload.lists) {
            const normalizedIncoming = this.normalizeList({
                name: incoming.name,
                visibility: incoming.visibility,
                books: incoming.books,
                createdAt: incoming.createdAt,
                updatedAt: incoming.updatedAt,
                userId: user.id,
            }, user.id);

            let item = data.lists.find((row) => row.userId === user.id && row.name.toLowerCase() === normalizedIncoming.name.toLowerCase());

            if (!item) {
                item = {
                    id: this.makeId(),
                    userId: user.id,
                    name: normalizedIncoming.name,
                    visibility: normalizedIncoming.visibility,
                    createdAt: normalizedIncoming.createdAt,
                    updatedAt: normalizedIncoming.updatedAt,
                    books: [],
                };
                data.lists.push(item);
                importedLists++;
            }

            item.visibility = this.normalizeVisibility(item.visibility || normalizedIncoming.visibility);
            item.books = this.normalizeEntries(item.books);
            const existing = new Map(item.books.map((row) => [row.bookUid, row]));

            for (const entry of normalizedIncoming.books) {
                if (!existing.has(entry.bookUid)) {
                    existing.set(entry.bookUid, {bookUid: entry.bookUid, read: !!entry.read});
                    importedBooks++;
                } else if (entry.read) {
                    existing.get(entry.bookUid).read = true;
                }
            }

            item.books = Array.from(existing.values());
            item.updatedAt = this.nowIso();
        }

        await this.save(data);
        return {importedLists, importedBooks, importedProgress, importedBookmarks};
    }
}

function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = ReadingListStore;
