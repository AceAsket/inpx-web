// initial state
const state = {
    config: {},
    settings: {
        accessToken: '',
        currentUserId: '',
        profileAccessToken: '',
        extendedParams: false,
        expandedAuthor: [],
        expandedSeries: [],

        defaultsSet: false,
        
        //uiDefaults
        limit: 20,
        downloadAsZip: false,
        showCounts: true,
        showRates: true,
        showInfo: true,
        showGenres: true,
        bookCardView: 'cards',
        showDates: false,
        showDeleted: false,
        abCacheEnabled: true,
        langDefault: '',
        showJson: false,
        showNewReleaseAvailable: true,
        darkTheme: false,
        showDiscoveryNewest: true,
        showDiscoveryPopular: true,
        showDiscoveryContinueReading: true,
        showDiscoveryFromLists: true,
        showDiscoveryUnfinishedSeries: true,
        showDiscoveryExternal: true,
        showDiscoverySimilar: true,
        showDiscoveryUnreadOnly: false,
        compactDiscoveryCards: false,
        discoveryNewestLimit: 8,
        discoveryPopularLimit: 8,
        discoveryExternalLimit: 12,
        discoveryExternalSource: '',
        discoveryExternalName: '',
        discoveryExternalUrl: '',
        discoveryExternalTtlMinutes: 1440,
        discoveryExternalFilter: 'books',
        discoveryExternalGenreUrl: '',
        discoveryExternalGenreName: '',
    },    
};

// getters
const getters = {};

// actions
const actions = {};

// mutations
const mutations = {
    setConfig(state, value) {
        state.config = value;
    },
    setSettings(state, value) {
        state.settings = Object.assign({}, state.settings, value);
    },
};

export default {
    namespaced: true,
    state,
    getters,
    actions,
    mutations
};
