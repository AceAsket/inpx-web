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
                version: 2,
                lists: [],
            });
        }
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

    makeId() {
        return crypto.randomBytes(8).toString('hex');
    }

    normalizeBookUid(bookUid) {
        return String(bookUid || '').trim();
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

    normalizeList(item) {
        const now = new Date().toISOString();
        const normalized = Object.assign({}, item);
        normalized.id = normalized.id || this.makeId();
        normalized.name = this.validateName(normalized.name);
        normalized.createdAt = normalized.createdAt || now;
        normalized.updatedAt = normalized.updatedAt || now;
        normalized.books = this.normalizeEntries(normalized.books);
        return normalized;
    }

    async load() {
        await this.ensureData();

        const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
        if (!Array.isArray(data.lists))
            data.lists = [];

        data.version = 2;
        data.lists = data.lists.map((item) => this.normalizeList(item));
        return data;
    }

    async save(data) {
        const out = {
            version: 2,
            lists: (Array.isArray(data.lists) ? data.lists : []).map((item) => this.normalizeList(item)),
        };
        await fs.writeFile(this.file, JSON.stringify(out, null, 2));
    }

    async getLists() {
        const data = await this.load();
        return data.lists;
    }

    async getList(listId) {
        const data = await this.load();
        return data.lists.find((item) => item.id === listId) || null;
    }

    countRead(entries) {
        return this.normalizeEntries(entries).filter((item) => item.read).length;
    }

    async createList(name) {
        const data = await this.load();
        const normalized = this.validateName(name);
        const duplicate = data.lists.find((item) => item.name.toLowerCase() === normalized.toLowerCase());
        if (duplicate)
            throw new Error('Список с таким названием уже существует');

        const now = new Date().toISOString();
        const item = {
            id: this.makeId(),
            name: normalized,
            createdAt: now,
            updatedAt: now,
            books: [],
        };

        data.lists.push(item);
        await this.save(data);
        return item;
    }

    async renameList(listId, name) {
        const data = await this.load();
        const item = data.lists.find((row) => row.id === listId);
        if (!item)
            throw new Error('Список не найден');

        const normalized = this.validateName(name);
        const duplicate = data.lists.find((row) => row.id !== listId && row.name.toLowerCase() === normalized.toLowerCase());
        if (duplicate)
            throw new Error('Список с таким названием уже существует');

        item.name = normalized;
        item.updatedAt = new Date().toISOString();
        await this.save(data);
        return item;
    }

    async deleteList(listId) {
        const data = await this.load();
        const index = data.lists.findIndex((row) => row.id === listId);
        if (index < 0)
            throw new Error('Список не найден');

        data.lists.splice(index, 1);
        await this.save(data);
        return {success: true};
    }

    findEntry(entries, bookUid) {
        return this.normalizeEntries(entries).find((item) => item.bookUid === bookUid) || null;
    }

    async setBookMembership(listId, bookUid, enabled) {
        const data = await this.load();
        const item = data.lists.find((row) => row.id === listId);
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

        item.updatedAt = new Date().toISOString();
        await this.save(data);
        return item;
    }

    async setBookRead(listId, bookUid, read) {
        const data = await this.load();
        const item = data.lists.find((row) => row.id === listId);
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
        item.updatedAt = new Date().toISOString();
        await this.save(data);
        return item;
    }

    async addBooks(listId, bookUids = []) {
        const data = await this.load();
        const item = data.lists.find((row) => row.id === listId);
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

        item.updatedAt = new Date().toISOString();
        await this.save(data);
        return {item, added};
    }

    async exportData() {
        const data = await this.load();
        return {
            version: 2,
            exportedAt: new Date().toISOString(),
            lists: data.lists || [],
        };
    }

    async importData(payload) {
        if (!payload || !Array.isArray(payload.lists))
            throw new Error('Некорректный файл импорта списков');

        const data = await this.load();
        let importedLists = 0;
        let importedBooks = 0;

        for (const incoming of payload.lists) {
            const normalizedIncoming = this.normalizeList(incoming);
            let item = data.lists.find((row) => row.name.toLowerCase() === normalizedIncoming.name.toLowerCase());

            if (!item) {
                item = {
                    id: this.makeId(),
                    name: normalizedIncoming.name,
                    createdAt: normalizedIncoming.createdAt,
                    updatedAt: normalizedIncoming.updatedAt,
                    books: [],
                };
                data.lists.push(item);
                importedLists++;
            }

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
            item.updatedAt = new Date().toISOString();
        }

        await this.save(data);
        return {importedLists, importedBooks};
    }
}

module.exports = ReadingListStore;
