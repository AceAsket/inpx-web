import localForage from 'localforage';

const maxDataSize = 100 * 1024 * 1024;
const storageVersion = '1';
const metadataPrefix = 'cache-meta-';
const abStore = localForage.createInstance({name: 'authorBooksStorage'});

// Cache failures must never discard a successful server response. Serialize
// mutations so concurrent requests share the same payload budget and LRU index.
export class AuthorBooksStorage {
    constructor(storage = abStore, maxBytes = maxDataSize, now = () => Date.now()) {
        this.storage = storage;
        this.maxBytes = maxBytes;
        this.now = now;
        this.entries = new Map();
        this.bytes = 0;
        this.loaded = false;
        this.pending = Promise.resolve();
    }

    enqueue(work, fallback = false) {
        const result = this.pending.then(work).catch(() => fallback);
        this.pending = result.then(() => {});
        return result;
    }

    async remove(fullKey) {
        await this.storage.removeItem(fullKey);
        await this.storage.removeItem(metadataPrefix + fullKey);
        await this.storage.removeItem(`addTime-${fullKey}`);
        const entry = this.entries.get(fullKey);
        if (entry) this.bytes -= entry.bytes;
        this.entries.delete(fullKey);
    }

    async evict(reservedBytes = 0, replacingKey = '') {
        const previous = this.entries.get(replacingKey);
        const available = () => this.bytes - (previous && this.entries.has(replacingKey) ? previous.bytes : 0) + reservedBytes;
        if (available() <= this.maxBytes) return;
        const oldest = [...this.entries].filter(([key]) => key !== replacingKey)
            .sort((a, b) => a[1].time - b[1].time);
        for (const [key] of oldest) {
            if (available() <= this.maxBytes) break;
            await this.remove(key);
        }
    }

    async ensureLoaded() {
        if (this.loaded) return;
        const keys = await this.storage.keys();
        const dataKeys = new Set(keys.filter(key => !key.startsWith('addTime-') && !key.startsWith(metadataPrefix)));
        const entries = new Map();
        let bytes = 0;
        for (const key of dataKeys) {
            const data = await this.storage.getItem(key);
            if (typeof data !== 'string') {await this.storage.removeItem(key); continue;}
            const metadata = await this.storage.getItem(metadataPrefix + key);
            const time = Number(metadata?.time ?? await this.storage.getItem(`addTime-${key}`)) || 0;
            // Count UTF-16 payload bytes conservatively, rather than treating a
            // string's character count as its storage size.
            const entry = {bytes: data.length * 2, time};
            entries.set(key, entry);
            bytes += entry.bytes;
        }
        for (const key of keys) {
            if (key.startsWith('addTime-') || (key.startsWith(metadataPrefix) && !dataKeys.has(key.slice(metadataPrefix.length))))
                await this.storage.removeItem(key);
        }
        this.entries = entries;
        this.bytes = bytes;
        await this.evict();
        this.loaded = true;
    }

    init() {return this.cleanStorage();}

    setData(key, data) {
        if (typeof data !== 'string') return Promise.reject(new Error('AuthorBooksStorage: data must be a string'));
        const bytes = data.length * 2;
        if (bytes > this.maxBytes) return Promise.resolve(false);
        const fullKey = key + storageVersion;
        return this.enqueue(async() => {
            await this.ensureLoaded();
            await this.evict(bytes, fullKey);
            await this.storage.setItem(fullKey, data);
            const previous = this.entries.get(fullKey);
            const metadata = {bytes, time: this.now()};
            this.bytes += bytes - (previous?.bytes || 0);
            this.entries.set(fullKey, metadata);
            // The payload is usable even if writing its optional LRU metadata fails.
            try {await this.storage.setItem(metadataPrefix + fullKey, metadata);} catch { /* Best-effort cache. */ }
            return true;
        });
    }

    getData(key) {
        const fullKey = key + storageVersion;
        return this.enqueue(async() => {
            await this.ensureLoaded();
            const data = await this.storage.getItem(fullKey);
            if (typeof data !== 'string') {
                if (this.entries.has(fullKey)) await this.remove(fullKey);
                return null;
            }
            const metadata = {bytes: data.length * 2, time: this.now()};
            const previous = this.entries.get(fullKey);
            this.bytes += metadata.bytes - (previous?.bytes || 0);
            this.entries.set(fullKey, metadata);
            await this.evict();
            try {await this.storage.setItem(metadataPrefix + fullKey, metadata);} catch { /* Best-effort cache. */ }
            return data;
        }, null);
    }

    cleanStorage() {
        return this.enqueue(async() => {await this.ensureLoaded(); await this.evict(); return true;});
    }
}

export default new AuthorBooksStorage();
