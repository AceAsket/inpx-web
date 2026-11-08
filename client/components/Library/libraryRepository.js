const {identity, personalAccess, discoveryOptions, normalizeShelves, profileLoginError} = require('./libraryModel');

const READING_TTL = 30000;
const DISCOVERY_TTL = 15 * 60 * 1000;

function emptyState() {
    return {revision: 0, reading: null, lists: [], shelves: [], recommendations: [], readingLoading: false, shelvesLoading: false,
        readingError: '', listsError: '', shelvesError: '', readingLoginRequired: false, shelvesLoginRequired: false,
        recommendationsLoading: false, recommendationsLoaded: false, recommendationsError: '', recommendationsLoginRequired: false,
        readingLoaded: false, shelvesLoaded: false, locked: false};
}

// Private, in-memory data only. Never add this state to the persisted settings store.
class LibraryRepository {
    constructor(api, publish = () => {}, now = () => Date.now()) {
        this.api = api;
        this.publish = publish;
        this.now = now;
        this.state = emptyState();
        this.contextKey = '';
        this.epoch = 0;
        this.pending = {};
        this.loadedAt = {};
    }

    patch(patch) {
        Object.assign(this.state, patch);
        this.publish(patch);
    }

    setContext(config, settings) {
        this.config = config;
        this.settings = settings;
        const key = identity(config, settings);
        if (key !== this.contextKey) {
            this.contextKey = key;
            this.epoch++;
            this.pending = {};
            this.loadedAt = {};
            this.discoveryKey = '';
            this.patch({...emptyState(), revision: this.epoch, locked: !personalAccess(config, settings)});
        }
        const discoveryKey = JSON.stringify([discoveryOptions(settings), config.discovery?.enabled, settings.showDiscoverySimilar !== false]);
        if (discoveryKey !== this.discoveryKey) {
            this.discoveryKey = discoveryKey;
            delete this.loadedAt.shelves;
            delete this.pending.shelves;
            delete this.loadedAt.recommendations;
            delete this.pending.recommendations;
            this.patch({shelvesLoading: false, recommendationsLoading: false,
                ...(settings.showDiscoverySimilar === false ? {recommendations: []} : {})});
        }
    }

    async run(kind, force, ttl, work) {
        if (this.state.locked || this.state[`${kind}LoginRequired`]) return;
        if (this.pending[kind]) return this.pending[kind];
        if (!force && this.loadedAt[kind] !== undefined && this.now() - this.loadedAt[kind] < ttl) return;
        const epoch = this.epoch;
        const discoveryKey = this.discoveryKey;
        const current = () => epoch === this.epoch && (!['shelves','recommendations'].includes(kind) || discoveryKey === this.discoveryKey);
        this.patch({[`${kind}Loading`]: true, [`${kind}Error`]: ''});
        const pending = (async() => {
            try {
                const patch = await work();
                if (!current()) return;
                this.loadedAt[kind] = this.now();
                this.patch({...patch, [`${kind}Loaded`]: true});
            } catch (error) {
                if (current()) {
                    if (profileLoginError(error)) this.requireLogin(kind);
                    else this.patch({[`${kind}Error`]: error.message || 'Не удалось загрузить данные'});
                }
            } finally {
                if (current()) {
                    delete this.pending[kind];
                    this.patch({[`${kind}Loading`]: false});
                }
            }
        })();
        this.pending[kind] = pending;
        return pending;
    }

    requireLogin(kind) {
        delete this.loadedAt[kind];
        this.patch({[`${kind}LoginRequired`]: true, [`${kind}Error`]: '', [`${kind}Loaded`]: false,
            ...(kind === 'reading' ? {reading: null, lists: [], listsError: ''} : kind === 'recommendations' ? {recommendations: []} : {shelves: []})});
    }

    loadReading(force = false) {
        return this.run('reading', force, READING_TTL, async() => {
            const options = {suppressProfileLogin: true};
            if (this.config.profileAuthorized && this.config.clientApi?.features?.includes('mobileHome')) {
                const result = await this.api.getMobileHome(100, options);
                return {reading: result.reading, lists: result.lists || [], listsError: ''};
            }
            const [reading, lists] = await Promise.allSettled([
                this.api.getUserReadingLibrary({state: 'all', sort: 'updatedDesc', limit: 100}, options),
                this.api.getReadingLists('', options),
            ]);
            if (reading.status === 'rejected') throw reading.reason;
            return {reading: reading.value, lists: lists.status === 'fulfilled' ? lists.value.lists || [] : [],
                listsError: lists.status === 'rejected' && !profileLoginError(lists.reason) ? lists.reason.message : ''};
        });
    }

    loadShelves(force = false) {
        if (this.config.discovery?.enabled === false) {
            this.patch({shelves: [], shelvesLoaded: true});
            return Promise.resolve();
        }
        return this.run('shelves', force, DISCOVERY_TTL, async() => {
            const result = await this.api.getDiscoveryShelves(discoveryOptions(this.settings), {suppressProfileLogin: true});
            return {shelves: normalizeShelves(Array.isArray(result.shelves) ? result.shelves : [])};
        });
    }

    loadRecommendations(force = false) {
        if (this.config.discovery?.enabled === false || !this.config.profileAuthorized || this.settings.showDiscoverySimilar === false
            || !this.config.clientApi?.features?.includes('overviewRecommendations')) {
            this.patch({recommendations: [], recommendationsLoaded: true});
            return Promise.resolve();
        }
        return this.run('recommendations',force,DISCOVERY_TTL,async() => {
            const result = await this.api.getDiscoveryShelves({recommendationsOnly:true,personalLimit:12}, {suppressProfileLogin:true});
            const shelf = normalizeShelves(Array.isArray(result.shelves) ? result.shelves : []).find(shelf => shelf.id === 'similar-books');
            return {recommendations:shelf?.books || []};
        });
    }

    loadHome({freshReading = false, freshShelves = false} = {}) {
        return Promise.all([this.loadReading(freshReading), this.loadShelves(freshShelves), this.loadRecommendations(freshShelves)]);
    }
}

module.exports = {LibraryRepository, emptyState};
