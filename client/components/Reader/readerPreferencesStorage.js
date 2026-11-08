import localForage from 'localforage';

const key = 'inpx.reader.preferences.v1';
const database = localForage.createInstance({name: 'inpxReaderPreferences'});
const isInlineImage = value => String(value || '').startsWith('data:image/');
const localStorageIfAvailable = () => typeof localStorage === 'undefined' ? null : localStorage;

// Large images belong in IndexedDB, once per profile. localStorage keeps only
// small preferences for a synchronous first paint when IndexedDB is unavailable.
export class ReaderPreferencesStorage {
    constructor(db = database, storage = localStorageIfAvailable) {
        this.db = db;
        this.storage = storage;
        this.pending = Promise.resolve();
        this.migrated = false;
    }

    legacy() {
        try {return JSON.parse(this.storage()?.getItem(key) || '{}');} catch {return {};}
    }

    readSync(userId = '') {
        const data = this.legacy();
        return userId ? data.byUser?.[userId] || null : data.preferences || null;
    }

    record(preferences, previous = null, background = null) {
        const value = JSON.parse(JSON.stringify(preferences || {}));
        const image = String(value.backgroundImage || '');
        if (isInlineImage(image)) {
            value.backgroundImage = '';
            return {preferences: value, background: {source: 'upload', data: image}};
        }
        const stored = background?.source === image ? background
            : previous?.background?.source === image ? previous.background : null;
        // Component state can be a Vue proxy, which IndexedDB cannot clone.
        return {preferences: value, background: stored ? {source: String(stored.source || ''), data: String(stored.data || '')} : null};
    }

    unpack(record) {
        if (!record?.preferences) return null;
        const preferences = {...record.preferences};
        if (record.background?.source === 'upload') preferences.backgroundImage = record.background.data;
        return {preferences, background: record.background};
    }

    compact(record) {return record.preferences;}

    async migrate() {
        if (this.migrated) return;
        const old = this.legacy(), compact = {byUser: {}};
        for (const [userId, preferences] of Object.entries(old.byUser || {})) {
            const record = this.record(preferences);
            if (!await this.db.getItem(`profile:${userId}`)) await this.db.setItem(`profile:${userId}`, record);
            compact.byUser[userId] = this.compact(record);
        }
        // The old global copy was also overwritten by signed-in profiles. Only
        // a genuinely unscoped legacy store can be assigned to anonymous use.
        if (old.preferences && !Object.keys(old.byUser || {}).length) {
            const record = this.record(old.preferences);
            if (!await this.db.getItem('profile:')) await this.db.setItem('profile:', record);
            compact.preferences = this.compact(record);
        }
        this.storage()?.setItem(key, JSON.stringify(compact));
        this.migrated = true;
    }

    enqueue(work, fallback) {
        const result = this.pending.then(async() => {await this.migrate(); return work();}).catch(fallback);
        this.pending = result.then(() => {});
        return result;
    }

    read(userId = '') {
        return this.enqueue(async() => this.unpack(await this.db.getItem(`profile:${userId}`)), () => {
            const preferences = this.readSync(userId);
            return preferences ? {preferences, background: null} : null;
        });
    }

    write(userId = '', preferences = {}, background = null) {
        // Capture mutable component preferences before the queued write starts.
        const captured = JSON.parse(JSON.stringify(preferences));
        return this.enqueue(async() => {
            const id = `profile:${userId}`;
            const record = this.record(captured, await this.db.getItem(id), background);
            await this.db.setItem(id, record);
            const compact = this.legacy();
            if (userId) compact.byUser = {...compact.byUser, [userId]: this.compact(record)};
            else compact.preferences = this.compact(record);
            try {this.storage()?.setItem(key, JSON.stringify(compact));} catch { /* IndexedDB still has the preferences. */ }
            return true;
        }, () => false);
    }
}

export default new ReaderPreferencesStorage();
