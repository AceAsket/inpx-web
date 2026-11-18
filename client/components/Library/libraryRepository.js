const {identity, personalAccess, discoveryOptions, normalizeShelves, profileLoginError} = require('./libraryModel');

const READING_TTL = 30000;
const DISCOVERY_TTL = 15 * 60 * 1000;

function emptyState() {
    return {revision: 0, readingRevision: 0, reading: null, lists: [], shelves: [], externalShelves: [], recommendations: [], readingLoading: false, shelvesLoading: false,
        readingError: '', listsError: '', shelvesError: '', readingLoginRequired: false, shelvesLoginRequired: false,
        externalShelvesLoading: false, externalShelvesLoaded: false, externalShelvesError: '', externalShelvesLoginRequired: false,
        recommendationsLoading: false, recommendationsLoaded: false, recommendationsError: '', recommendationsLoginRequired: false,
        pinnedShelves: [], pinnedShelvesLoading: false, pinnedShelvesLoaded: false, pinnedShelvesError: '', pinnedShelvesLoginRequired: false,
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
        this.discoveryRevision = 0;
        this.pinnedShelvesRevision = 0;
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
        const discoveryKey = JSON.stringify([!!config.version, discoveryOptions(settings), config.discovery, this.overviewShelfEnabled('discovery:external-source', settings.showDiscoveryExternal !== false),
            config.clientApi?.features?.includes('separateExternalDiscovery'), this.overviewShelfEnabled('recommendations', settings.showDiscoverySimilar !== false),
            config.currentUserProfile?.personalRecommendationsEnabled !== false]);
        if (discoveryKey !== this.discoveryKey) {
            this.discoveryKey = discoveryKey;
            this.discoveryRevision++;
            delete this.loadedAt.shelves;
            delete this.pending.shelves;
            delete this.loadedAt.recommendations;
            delete this.pending.recommendations;
            delete this.loadedAt.externalShelves;
            delete this.pending.externalShelves;
            this.patch({shelvesLoading: false, externalShelves: [], externalShelvesLoading: false, externalShelvesLoaded: false,
                externalShelvesError: '', externalShelvesLoginRequired: false, recommendationsLoading: false,
                ...(!this.overviewShelfEnabled('recommendations', settings.showDiscoverySimilar !== false) || config.currentUserProfile?.personalRecommendationsEnabled === false ? {recommendations: []} : {})});
        }
    }

    async run(kind, force, ttl, work) {
        if (this.state.locked || this.state[`${kind}LoginRequired`]) return;
        if (this.pending[kind]) return this.pending[kind];
        if (!force && this.loadedAt[kind] !== undefined && this.now() - this.loadedAt[kind] < ttl) return;
        const epoch = this.epoch;
        const readingRevision = this.state.readingRevision;
        const discoveryRevision = this.discoveryRevision;
        const pinnedShelvesRevision = this.pinnedShelvesRevision;
        const current = () => epoch === this.epoch && (kind === 'pinnedShelves' ? pinnedShelvesRevision === this.pinnedShelvesRevision
            : kind === 'reading' ? readingRevision === this.state.readingRevision : discoveryRevision === this.discoveryRevision);
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
        if (kind === 'reading') {
            delete this.pending.reading;
            this.invalidatePinnedShelves();
        }
        this.patch({[`${kind}LoginRequired`]: true, [`${kind}Error`]: '', [`${kind}Loaded`]: false,
            ...(kind === 'reading' ? {readingRevision:this.state.readingRevision+1,readingLoading:false,
                reading: null, lists: [], listsError: '', pinnedShelves: [], pinnedShelvesError: ''} : {[kind]: []})});
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

    refreshReading() {
        delete this.pending.reading;
        delete this.loadedAt.reading;
        this.invalidatePinnedShelves();
        this.patch({readingRevision:this.state.readingRevision+1,readingLoading:false});
        return this.loadReading(true);
    }

    loadShelves(force = false) {
        if (this.config.discovery?.enabled === false) {
            this.patch({shelves: [], shelvesLoaded: true});
            return Promise.resolve();
        }
        return this.run('shelves', force, DISCOVERY_TTL, async() => {
            const options = discoveryOptions(this.settings);
            if (this.config.clientApi?.features?.includes('separateExternalDiscovery')) options.includeExternal = false;
            const result = await this.api.getDiscoveryShelves(options, {suppressProfileLogin: true});
            return {shelves: normalizeShelves(Array.isArray(result.shelves) ? result.shelves : [])};
        });
    }

    overviewShelfEnabled(id, fallback) {
        const rows = this.config.profileAuthorized && this.config.currentUserProfile?.overviewShelfLayout;
        const row = Array.isArray(rows) && rows.find(item => item.id === id);
        return row ? !row.hidden : fallback;
    }

    loadExternalShelves(force = false) {
        if (!this.config.clientApi?.features?.includes('separateExternalDiscovery') || this.config.discovery?.enabled === false
            || !this.config.discovery?.externalSource || this.config.discovery.externalSource === 'none'
            || !this.overviewShelfEnabled('discovery:external-source', this.settings.showDiscoveryExternal !== false))
            return Promise.resolve();
        return this.run('externalShelves', force, DISCOVERY_TTL, async() => {
            const result = await this.api.getDiscoveryShelves({externalOnly:true, externalLimit:8, forceRefresh:force}, {suppressProfileLogin:true});
            return {externalShelves: normalizeShelves(Array.isArray(result.shelves) ? result.shelves : [])};
        });
    }

    loadRecommendations(force = false) {
        if (this.config.discovery?.enabled === false || !this.config.profileAuthorized || !this.overviewShelfEnabled('recommendations', this.settings.showDiscoverySimilar !== false)
            || this.config.currentUserProfile?.personalRecommendationsEnabled === false
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

    invalidatePinnedShelves() {
        this.pinnedShelvesRevision++;
        delete this.pending.pinnedShelves;
        delete this.loadedAt.pinnedShelves;
        this.patch({pinnedShelvesLoading: false, pinnedShelvesError: ''});
    }

    loadPinnedShelves(force = false) {
        if (!this.config.profileAuthorized || this.state.readingLoginRequired
            || !this.config.clientApi?.features?.includes('overviewPinnedShelves')) return;
        return this.run('pinnedShelves', force, READING_TTL, async() => {
            const result = await this.api.getOverviewPinnedShelves();
            return {pinnedShelves: normalizeShelves(result.shelves || [])};
        });
    }

    loadHome({freshReading = false, freshShelves = false} = {}) {
        const reading = this.loadReading(freshReading);
        const shelves = this.loadShelves(freshShelves);
        const discoveryRevision = this.discoveryRevision;
        return Promise.all([reading, shelves, this.loadRecommendations(freshShelves), this.loadPinnedShelves(freshShelves),
            shelves.then(() => {
                if (discoveryRevision === this.discoveryRevision) return this.loadExternalShelves(freshShelves);
            })]);
    }
}

module.exports = {LibraryRepository, emptyState};
