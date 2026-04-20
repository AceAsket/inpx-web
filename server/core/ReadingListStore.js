const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class ReadingListStore {
    constructor(config) {
        this.config = config;
        this.file = path.join(config.dataDir, 'reading-lists.json');
    }

    async ensureData() {
        await fs.ensureDir(path.dirname(this.file));

        if (!await fs.pathExists(this.file)) {
            await this.save({
                version: 3,
                users: [this.makeDefaultUser()],
                lists: [],
            });
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

    normalizeBookUid(bookUid) {
        return String(bookUid || '').trim();
    }

    normalizeVisibility(value) {
        return (value === 'opds' ? 'opds' : 'private');
    }

    makeDefaultUser() {
        const now = this.nowIso();
        return {
            id: 'default',
            name: 'Основной',
            emailTo: String(this.config.emailTo || '').trim(),
            telegramChatId: String(this.config.telegramChatId || '').trim(),
            opdsEnabled: true,
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
        normalized.emailTo = String(normalized.emailTo || '').trim();
        normalized.telegramChatId = String(normalized.telegramChatId || '').trim();
        normalized.opdsEnabled = (normalized.opdsEnabled !== false);
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
        const source = Object.assign({version: 3, users: [], lists: []}, data || {});
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
            version: 3,
            users,
            lists,
        };
    }

    async load() {
        await this.ensureData();
        const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
        const data = this.normalizeData(raw);
        return data;
    }

    async save(data) {
        const out = this.normalizeData(data);
        await fs.writeFile(this.file, JSON.stringify(out, null, 2));
    }

    async resolveUser(userId = '') {
        const data = await this.load();
        const normalizedUserId = String(userId || '').trim();
        const user = data.users.find((item) => item.id === normalizedUserId) || data.users[0];
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

    async getUsers(currentUserId = '') {
        const {data, user} = await this.resolveUser(currentUserId);
        return {
            users: data.users,
            currentUser: user,
        };
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

        return data.users
            .filter((item) => item.opdsEnabled && stats.has(item.id))
            .map((item) => ({
                id: item.id,
                name: item.name,
                opdsListCount: stats.get(item.id) || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }

    async createUser(profile = {}) {
        const data = await this.load();
        const normalizedName = this.validateUserName(profile.name);
        this.ensureUniqueUserName(data.users, normalizedName);

        const user = this.normalizeUser({
            name: normalizedName,
            emailTo: profile.emailTo,
            telegramChatId: profile.telegramChatId,
            opdsEnabled: profile.opdsEnabled,
        });

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
        this.ensureUniqueUserName(data.users, nextName, target.id);

        target.name = nextName;
        if (utilsHasProp(patch, 'emailTo'))
            target.emailTo = String(patch.emailTo || '').trim();
        if (utilsHasProp(patch, 'telegramChatId'))
            target.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utilsHasProp(patch, 'opdsEnabled'))
            target.opdsEnabled = (patch.opdsEnabled !== false);
        target.updatedAt = this.nowIso();

        await this.save(data);
        return target;
    }

    async deleteUser(userId) {
        const data = await this.load();
        if (data.users.length <= 1)
            throw new Error('Нельзя удалить последнего пользователя');

        const index = data.users.findIndex((item) => item.id === userId);
        if (index < 0)
            throw new Error('Пользователь не найден');

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
            version: 3,
            exportedAt: this.nowIso(),
            user: {
                id: user.id,
                name: user.name,
                emailTo: user.emailTo,
                telegramChatId: user.telegramChatId,
                opdsEnabled: user.opdsEnabled,
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
        let importedLists = 0;
        let importedBooks = 0;

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
        return {importedLists, importedBooks};
    }
}

function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = ReadingListStore;
