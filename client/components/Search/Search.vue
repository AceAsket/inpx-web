<template>
    <div class="root column fit search--shelves" style="position: relative">
        <div ref="scroller" class="col fit column no-wrap search-scroll" style="overflow: auto; position: relative">
            <CatalogSearchPanel :search="search" :selected-list="selectedList" :list-options="listOptions"
                :discovery="isDiscoveryList" :extended="isExtendedSearch" :ext-summary="extSearchNames" :authorized="!!config.profileAuthorized"
                :genre-map="genreMap" :genre-tree="genreTree" :lang-list="langList" :ext-list="extList" :sources="config.librarySources || []"
                @patch="applyCatalogSearch" @section="changeCatalogSection" @save-shelf="saveSearchShelf" @edit-extended="selectExtSearch" @clear-extended="clearExtSearch" />

            <div v-if="!isDiscoveryList" class="result-bar row items-center q-ml-lg q-mt-sm">
                <div v-show="pageCount > 1" class="result-scroller-wrap">
                    <LibraryPagination v-model="search.page" :page-count="pageCount" :disable="list.totalFound < 0" />
                </div>

                <div v-show="list.totalFound > 0" class="text-bold" style="font-size: 120%; padding-bottom: 2px">
                    {{ foundCountMessage }}
                </div>

                <div v-show="list.totalFound > 0 && isExtendedSearch" class="q-ml-md">
                    <q-checkbox v-model="showJson" size="36px" label="Показывать JSON" />
                </div>
            </div>

            <!-- Формирование списка ------------------------------------------------------------------------>
            <div v-if="selectedListComponent">
                <div class="separator" />
                <DiscoveryShelves
                    v-if="selectedListComponent === 'DiscoveryShelves'"
                    ref="list"
                    :section-title="getRouteLabel(selectedList)"
                    :compact-mode="compactDiscoveryCards"
                    :personal-mode="selectedList === 'for-you'"
                    :profile-key="currentUserId"
                    :external-filter="discoveryExternalFilter"
                    :show-external-filter="selectedList === 'bestsellers'"
                    :external-genre-options="externalDiscoveryGenreOptions"
                    :external-genre-url="discoveryExternalGenreUrl"
                    :external-pagination="externalDiscoveryPagination"
                    :show-external-pagination="selectedList === 'bestsellers'"
                    :unread-only="showDiscoveryUnreadOnly"
                    :shelves="selectedDiscoveryShelves"
                    :loading="discoveryShelvesLoading"
                    :error-message="discoveryShelvesError"
                    :list="list"
                    :search="search"
                    :ext-search="extSearch"
                    :genre-map="genreMap"
                    @list-event="listEvent"
                    @refresh-shelves="refreshDiscoveryShelves(true)"
                    @hide-shelf="hideDiscoveryShelf"
                    @dismiss-book="dismissDiscoveryBook"
                    @feedback-book="setDiscoveryFeedback"
                    @save-taste="saveDiscoveryTaste"
                    @dismiss-taste="dismissDiscoveryTasteSetup"
                    @restore-book="restoreDiscoveryBook"
                    @discovery-interaction="recordDiscoveryInteraction"
                    @toggle-unread-only="toggleDiscoveryUnreadOnly"
                    @toggle-compact="toggleCompactDiscoveryCards"
                    @set-external-filter="setDiscoveryExternalFilter"
                    @set-external-genre="setDiscoveryExternalGenre"
                    @set-external-limit="setDiscoveryExternalLimit"
                    @change-external-page="changeDiscoveryExternalPage"
                    @load-more-external="loadMoreExternalDiscovery"
                    @load-more-recommendations="loadMoreSimilarRecommendations"
                />
                <component
                    :is="selectedListComponent"
                    v-else
                    ref="list"
                    :list="list"
                    :search="search"
                    :ext-search="extSearch"
                    :genre-map="genreMap"
                    @list-event="listEvent"
                />
                <div class="separator" />
            </div>
            <!-- Формирование списка конец ------------------------------------------------------------------>

            <div v-if="!isDiscoveryList" class="bottom-scroller-bar row q-ml-lg q-mb-sm">
                <LibraryPagination v-show="pageCount > 1" v-model="search.page" :page-count="pageCount" :disable="list.totalFound < 0" />
            </div>

            <footer class="catalog-footer">
                <button type="button" class="project-pill bg-cyan-2" @click.stop.prevent="openReleasePage">
                    {{ projectName }}
                </button>
                <a
                    class="community-link"
                    href="https://t.me/inpxweb"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Сообщество INPX Web в Telegram (откроется в новой вкладке)"
                >
                    <q-icon name="lab la-telegram-plane" size="18px" aria-hidden="true" />
                    <span>Сообщество в Telegram</span>
                </a>
            </footer>
        </div>

        <BookInfoDialog
            v-model="bookInfoDialogVisible"
            :book-info="bookInfo"
            :genre-map="genreMap"
            :initial-tab="bookInfoDialogTab"
            @navigate="bookInfoNavigate"
        />
        <ReadingListsDialog v-model="readingListsDialogVisible" :book="readingListsDialogBook" />
        <Dialog v-model="saveShelfDialogVisible">
            <template #header>Создать умную полку</template>
            <form class="save-shelf-form" @submit.prevent="createSearchShelf">
                <q-input
                    v-model="shelfName"
                    outlined dense autofocus maxlength="200"
                    label="Название полки"
                    :disable="shelfSaving"
                />
                <q-checkbox v-model="shelfUnreadOnly" label="Только непрочитанные" :disable="shelfSaving" />
                <div class="save-shelf-description">
                    Книги на полке обновляются автоматически по текущим фильтрам поиска.
                </div>
                <div v-if="shelfError" role="alert" class="text-negative">{{ shelfError }}</div>
            </form>
            <template #footer>
                <q-btn flat no-caps label="Отмена" :disable="shelfSaving" @click="saveShelfDialogVisible = false" />
                <q-btn
                    color="primary" no-caps label="Создать полку"
                    :loading="shelfSaving" :disable="!shelfName.trim() || shelfSaving"
                    @click="createSearchShelf"
                />
            </template>
        </Dialog>
        <SelectExtSearchDialog v-model="selectExtSearchDialogVisible" v-model:ext-search="extSearch" />        
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import AuthorList from './AuthorList/AuthorList.vue';
import SeriesList from './SeriesList/SeriesList.vue';
import TitleList from './TitleList/TitleList.vue';
import AllBooksList from './AllBooksList/AllBooksList.vue';
import ExtendedList from './ExtendedList/ExtendedList.vue';
import DiscoveryShelves from './DiscoveryShelves/DiscoveryShelves.vue';

import LibraryPagination from '../Library/LibraryPagination.vue';
import BookInfoDialog from './BookInfoDialog/BookInfoDialog.vue';
import SelectExtSearchDialog from './SelectExtSearchDialog/SelectExtSearchDialog.vue';
import ReadingListsDialog from './ReadingListsDialog/ReadingListsDialog.vue';

import authorBooksStorage from './authorBooksStorage';
import Dialog from '../share/Dialog.vue';
import CatalogSearchPanel from '../Library/CatalogSearchPanel.vue';

import cloneDeep from 'lodash/cloneDeep';
import isEqual from 'lodash/isEqual';
import isObject from 'lodash/isObject';
import pickBy from 'lodash/pickBy';
const _ = {cloneDeep, isEqual, isObject, pickBy};

const maxLimit = 1000;
const searchRoutePaths = new Set(['/', '/author', '/series', '/title', '/books', '/for-you', '/newest', '/popular', '/bestsellers', '/extended']);

const route2component = {
    'for-you': {component: 'DiscoveryShelves', label: 'Для вас'},
    'newest': {component: 'DiscoveryShelves', label: 'Новинки'},
    'popular': {component: 'DiscoveryShelves', label: 'Популярное'},
    'bestsellers': {component: 'DiscoveryShelves', label: 'Внешний источник'},
    'author': {component: 'AuthorList', label: 'Авторы'},
    'series': {component: 'SeriesList', label: 'Серии'},
    'title': {component: 'TitleList', label: 'Названия'},
    'books': {component: 'AllBooksList', label: 'Книги'},
    'extended': {component: 'ExtendedList', label: 'Расширенный поиск'},
};

const componentOptions = {
    components: {
        AuthorList,
        SeriesList,
        TitleList,
        AllBooksList,
        ExtendedList,
        DiscoveryShelves,
        LibraryPagination,
        BookInfoDialog,
        ReadingListsDialog,
        SelectExtSearchDialog,
        Dialog,
        CatalogSearchPanel
    },
    watch: {
        config(newValue) {
            this.makeProjectName();
            if (newValue.dbConfig)
                this.list.inpxHash = newValue.dbConfig.inpxHash;
            this.refreshDiscoveryShelves(true);
        },
        settings() {
            this.loadSettings();
            if (this.isDiscoveryList && !this.isDiscoveryListEnabled(this.selectedList)) {
                this.selectedList = 'books';
                return;
            }
            this.selectedListComponent = this.getSelectedListComponent(this.selectedList);
        },
        search: {
            handler(newValue) {
                this.limit = newValue.limit;

                this.makeTitle();
                this.updateRouteQueryFromSearch();
                this.refreshDiscoveryShelves();

                //extSearch
                if (this.isExtendedSearch) {
                    this.extSearch.page = newValue.page;
                    this.extSearch.limit = newValue.limit;
                }
            },
            deep: true,
        },
        extSearch: {
            handler() {
                this.makeTitle();
                this.updateRouteQueryFromSearch();
            },
            deep: true,
        },
        limit(newValue) {
            this.setSetting('limit', newValue);

            this.updatePageCount();
        },
        $route(to) {
            if (!this.isSearchRoute(to))
                return;

            this.updateListFromRoute(to);
            this.updateSearchFromRouteQuery(to);
            this.makeTitle();
        },
        langDefault() {
            this.updateSearchFromRouteQuery(this.$route);
        },
        showJson(newValue) {
            this.setSetting('showJson', newValue);
        },
        list: {
            handler(newValue) {
                this.updateGenreTreeIfNeeded();

                if (this.prevList.totalFound != newValue.totalFound || this.prevList.searchRequestId !== newValue.searchRequestId) {
                    this.updatePageCount();
                    this.$nextTick(() => {
                        this.foundCountMessage = this.$refs.list ? this.$refs.list.foundCountMessage : '';
                    });
                }

                this.prevList = _.cloneDeep(newValue);
            },
            deep: true,
        },
        selectedList(newValue) {
            if (this.selectedListComponent) {
                this.pageCount = 1;
                this.list.totalFound = -1;
                this.list.searchRequestId = 0;
            }

            this.selectedListComponent = this.getSelectedListComponent(newValue);

            if (this.getListRoute() != newValue) {
                this.updateRouteQueryFromSearch();
            }

            this.makeTitle();
            if (!this.isDiscoveryList) {
                this.discoveryShelvesRequestSeq++;
                this.discoveryShelvesLoading = false;
                this.discoveryShelvesError = '';
            }
            this.refreshDiscoveryShelves();
        },
    },
};
class Search {
    _options = componentOptions;
    
    ready = false;

    selectedList = '';
    selectedListComponent = '';

    collection = '';
    projectName = '';

    foundCountMessage = '';

    bookInfoDialogVisible = false;
    bookInfoRequestId = 0;
    bookInfoDialogTab = 'fb2';
    readingListsDialogVisible = false;
    selectExtSearchDialogVisible = false;

    pageCount = 1;    

    //input field consts 

    //search fields
    search = {};
    extSearch = {};


    //settings
    abCacheEnabled = true;
    langDefault = '';
    limit = 20;
    showJson = false;
    showDiscoveryNewest = true;
    showDiscoveryPopular = true;
    showDiscoveryContinueReading = true;
    showDiscoveryFromLists = true;
    showDiscoveryUnfinishedSeries = true;
    showDiscoverySimilar = true;
    showDiscoveryExternal = true;
    showDiscoveryUnreadOnly = false;
    compactDiscoveryCards = false;
    discoveryNewestLimit = 8;
    discoveryPopularLimit = 8;
    discoverySimilarLimit = 16;
    discoveryExternalLimit = 12;
    discoveryExternalSource = '';
    discoveryExternalName = '';
    discoveryExternalUrl = '';
    discoveryExternalTtlMinutes = 1440;
    discoveryExternalFilter = 'books';
    discoveryExternalGenreUrl = '';
    discoveryExternalGenreName = '';
    discoveryExternalPage = 1;
    //stuff
    prevList = {};
    list = {
        queryFound: -1,
        totalFound: -1,
        inpxHash: '',
        liberamaReady: false,
    };

    genreTree = [];
    genreMap = new Map();
    langList = [];
    extList = [];
    genreTreeInpxHash = '';

    bookInfo = {};
    readingListsDialogBook = null;
    saveShelfDialogVisible = false;
    shelfName = '';
    shelfUnreadOnly = true;
    shelfSaving = false;
    shelfError = '';
    shelfFilters = {};
    discoveryShelves = [];
    discoveryShelvesLoading = false;
    discoveryShelvesError = '';
    discoveryShelvesCacheKey = '';
    discoveryShelvesPendingKey = '';
    discoveryShelvesRequestSeq = 0;
    discoverySimilarExhausted = false;

    generateDefaults(obj, fields) {
        obj.setDefaults = (self, value = {}) => {
            for (const f of fields)
                self[f] = value[f] || '';

            const page = parseInt(value.page, 10);
            const limit = parseInt(value.limit, 10);
            self.page = Number.isSafeInteger(page) && page > 0 ? page : 1;
            self.limit = Math.max(1, Math.min(maxLimit, Number.isFinite(limit) ? limit : 50));
        };
    }

    created() {
        this.commit = this.$store.commit;
        this.api = this.$root.api;

        this.generateDefaults(this.search, ['author', 'series', 'title', 'keywords', 'genre', 'lang', 'date', 'librate', 'ratingCount', 'isbn', 'ext', 'sourceId', 'hideCopies']);
        this.search.setDefaults(this.search);

        this.loadSettings();
    }

    activated() {
        this.makeTitle();
    }

    mounted() {
        (async() => {
            //для срабатывания watch.config
            await this.api.updateConfig();

            //устанавливаем uiDefaults от сервера, если это необходимо
            if (!this.settings.defaultsSet) {
                const uiDefaults = _.cloneDeep(this.config.uiDefaults);
                uiDefaults.defaultsSet = true;
                this.commit('setSettings', uiDefaults);
            }

            this.generateDefaults(this.extSearch, this.recStruct.map(f => f.field));
            this.extSearch.setDefaults(this.extSearch);
            this.search.lang = this.langDefault;

            //для встраивания в liberama
            this.parentOrigin = '';
            if (window.parent && window.parent !== window && document.referrer) {
                try {
                    const parsed = new URL(document.referrer);
                    if (['http:', 'https:'].includes(parsed.protocol))
                        this.parentOrigin = parsed.origin;
                } catch {
                    this.parentOrigin = '';
                }
            }
            this.handleWindowMessage = (event) => {
                if (window.parent === window || event.source !== window.parent)
                    return;
                if (!this.parentOrigin || event.origin !== this.parentOrigin)
                    return;
                if (!_.isObject(event.data) || event.data.from != 'ExternalLibs')
                    return;

                this.recvMessage(event.data);
            };
            window.addEventListener('message', this.handleWindowMessage);

            //локальный кеш
            await authorBooksStorage.init();

            this.updateListFromRoute(this.$route);

            this.ready = true;

            this.sendMessage({type: 'mes', data: 'hello-from-inpx-web'});
            this.updateSearchFromRouteQuery(this.$route);
            await this.refreshDiscoveryShelves(true);
        })();
    }

    beforeUnmount() {
        if (this.handleWindowMessage) {
            window.removeEventListener('message', this.handleWindowMessage);
            this.handleWindowMessage = null;
        }
    }

    loadSettings() {
        const settings = this.settings;

        this.search.limit = settings.limit;

        this.expandedAuthor = _.cloneDeep(settings.expandedAuthor);
        this.expandedSeries = _.cloneDeep(settings.expandedSeries);
        this.abCacheEnabled = settings.abCacheEnabled;
        this.langDefault = settings.langDefault;
        this.showJson = settings.showJson;
        this.showDiscoveryNewest = (settings.showDiscoveryNewest !== false);
        this.showDiscoveryPopular = (settings.showDiscoveryPopular !== false);
        this.showDiscoveryContinueReading = (settings.showDiscoveryContinueReading !== false);
        this.showDiscoveryFromLists = (settings.showDiscoveryFromLists !== false);
        this.showDiscoveryUnfinishedSeries = (settings.showDiscoveryUnfinishedSeries !== false);
        this.showDiscoverySimilar = (settings.showDiscoverySimilar !== false);
        this.showDiscoveryExternal = (settings.showDiscoveryExternal !== false);
        this.showDiscoveryUnreadOnly = (settings.showDiscoveryUnreadOnly === true);
        this.compactDiscoveryCards = (settings.compactDiscoveryCards === true);
        this.discoveryNewestLimit = parseInt(settings.discoveryNewestLimit, 10) || 8;
        this.discoveryPopularLimit = parseInt(settings.discoveryPopularLimit, 10) || 8;
        this.discoveryExternalLimit = Math.max(12, Math.min(parseInt(settings.discoveryExternalLimit, 10) || 12, 120));
        this.discoveryExternalSource = String(settings.discoveryExternalSource || ((this.config.discovery || {}).externalSource || '')).trim().toLowerCase();
        this.discoveryExternalName = String(settings.discoveryExternalName || ((this.config.discovery || {}).externalName || '')).trim();
        this.discoveryExternalUrl = String(settings.discoveryExternalUrl || ((this.config.discovery || {}).externalUrl || '')).trim();
        this.discoveryExternalTtlMinutes = Math.max(
            1440,
            parseInt(settings.discoveryExternalTtlMinutes, 10) || parseInt(((this.config.discovery || {}).externalTtlMinutes), 10) || 1440,
        );
        this.discoveryExternalFilter = (
            ['all', 'books', 'genres'].includes(String(settings.discoveryExternalFilter || '').trim().toLowerCase())
                ? String(settings.discoveryExternalFilter || '').trim().toLowerCase()
                : 'books'
        );
        this.discoveryExternalGenreUrl = String(settings.discoveryExternalGenreUrl || '').trim();
        this.discoveryExternalGenreName = String(settings.discoveryExternalGenreName || '').trim();
    }

    recvMessage(d) {
        if (d.type == 'mes') {
            switch(d.data) {
                case 'ready':
                    this.list.liberamaReady = true;
                    this.sendMessage({type: 'mes', data: 'ready'});
                    this.sendCurrentUrl();
                    this.makeTitle();
                    break;
            }
        }
    }

    sendMessage(d) {
        if (!window.parent || window.parent === window || !this.parentOrigin)
            return;
        window.parent.postMessage(Object.assign({}, {from: 'inpx-web'}, d), this.parentOrigin);
    }

    sendCurrentUrl() {
        this.sendMessage({type: 'urlChange', data: window.location.href});
    }

    get config() {
        return this.$store.state.config;
    }

    applyCatalogSearch(patch) {
        Object.assign(this.search, patch, {page: 1});
    }

    changeCatalogSection(section, values) {
        const {sectionSearchValues} = require('../Library/catalogSearchModel');
        this.applyCatalogSearch(sectionSearchValues(values, this.selectedList, section));
        this.selectedList = section;
    }

    get recStruct() {
        if (this.config.dbConfig && this.config.dbConfig.inpxInfo.recStruct)
            return this.config.dbConfig.inpxInfo.recStruct;
        else
            return [];
    }

    get settings() {
        return this.$store.state.settings;
    }

    get listOptions() {
        const result = [];
        const discovery = (this.config.discovery || {});
        const discoveryEnabled = (discovery.enabled !== false);
        const externalEnabled = !!(discoveryEnabled && this.activeDiscoveryExternalSource && this.activeDiscoveryExternalSource !== 'none');
        const routeOrder = ['author', 'series', 'title', 'books', 'for-you', 'newest', 'popular', 'bestsellers', 'extended'];

        for (const route of routeOrder) {
            const rec = route2component[route];
            if (!rec)
                continue;
            if (route == 'extended') {
                if (this.config.extendedSearch) {
                    result.push({value: route, icon: 'la la-code', size: '10px'});
                }
            } else if ((route === 'for-you' || route === 'newest' || route === 'popular') && !discoveryEnabled) {
                continue;
            } else if (route === 'bestsellers' && !externalEnabled) {
                continue;
            } else if (!this.isDiscoveryListEnabled(route)) {
                continue;
            } else {
                result.push({label: this.getRouteLabel(route), value: route, icon: rec.icon});
            }
        }
        return result;
    }

    get currentUserId() {
        return this.settings.currentUserId || this.config.currentUserId || '';
    }

    get currentSelectedProfile() {
        const users = this.config.userProfiles || [];
        return users.find((item) => item.id === this.currentUserId) || null;
    }

    get currentProfileNeedsLogin() {
        const current = this.currentSelectedProfile;
        return !!(current && current.requiresLogin && !this.config.profileAuthorized);
    }

    get canEditExternalDiscovery() {
        const current = this.config.currentUserProfile || {};
        return !!(this.config.profileAuthorized && current.isAdmin);
    }

    getSelectedListComponent(route) {
        return (route2component[route] ? route2component[route].component : null);
    }

    getRouteLabel(route) {
        if (route === 'bestsellers')
            return this.activeDiscoveryExternalLabel;
        return (route2component[route] ? route2component[route].label : route);
    }

    isSearchRoute(route = this.$route) {
        const path = (typeof(route) === 'string' ? route : ((route && route.path) || ''));
        return searchRoutePaths.has(path);
    }

    get isExtendedSearch() {
        return this.selectedList === 'extended';
    }

    get isDiscoveryList() {
        return ['for-you', 'newest', 'popular', 'bestsellers'].includes(this.selectedList);
    }

    get activeDiscoveryExternalSource() {
        const value = String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalSource || ((this.config.discovery || {}).externalSource || ''))
                : ((this.config.discovery || {}).externalSource || ''),
        ).trim().toLowerCase();
        return (value && value !== 'none' ? 'web-page' : 'none');
    }

    get activeDiscoveryExternalName() {
        return String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalName || ((this.config.discovery || {}).externalName || ''))
                : ((this.config.discovery || {}).externalName || ''),
        ).trim();
    }

    get activeDiscoveryExternalLabel() {
        return (this.activeDiscoveryExternalName || 'Внешний источник');
    }

    get activeDiscoveryExternalUrl() {
        return String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalUrl || ((this.config.discovery || {}).externalUrl || ''))
                : ((this.config.discovery || {}).externalUrl || ''),
        ).trim();
    }

    get activeDiscoveryExternalTtlMinutes() {
        return Math.max(
            1440,
            this.canEditExternalDiscovery
                ? (parseInt(this.discoveryExternalTtlMinutes, 10) || parseInt(((this.config.discovery || {}).externalTtlMinutes), 10) || 1440)
                : (parseInt(((this.config.discovery || {}).externalTtlMinutes), 10) || 1440),
        );
    }

    isDiscoveryListEnabled(route) {
        const discovery = (this.config.discovery || {});
        const discoveryEnabled = (discovery.enabled !== false);
        const externalEnabled = !!(discoveryEnabled && this.activeDiscoveryExternalSource && this.activeDiscoveryExternalSource !== 'none');

        if (route === 'for-you')
            return !!(discoveryEnabled && this.currentUserId && !this.currentProfileNeedsLogin);
        if (route === 'newest')
            return !!(discoveryEnabled && this.showDiscoveryNewest);
        if (route === 'popular')
            return !!(discoveryEnabled && this.showDiscoveryPopular);
        if (route === 'bestsellers')
            return !!(externalEnabled && this.showDiscoveryExternal);
        return true;
    }

    get isBooksBrowse() {
        return this.selectedList === 'books';
    }

    get showDiscoveryShelves() {
        return !!(this.ready && this.isDiscoveryList);
    }

    get selectedDiscoveryShelves() {
        const shelves = (Array.isArray(this.discoveryShelves) ? this.discoveryShelves : []);
        if (this.selectedList === 'for-you') {
            const allowedShelves = new Set();
            if (this.showDiscoveryContinueReading !== false)
                allowedShelves.add('continue-reading');
            if (this.showDiscoveryFromLists !== false)
                allowedShelves.add('from-your-lists');
            if (this.showDiscoveryUnfinishedSeries !== false)
                allowedShelves.add('unfinished-series');
            if (this.showDiscoverySimilar !== false)
                allowedShelves.add('similar-books');
            allowedShelves.add('hidden-books');

            return shelves
                .filter(item => item && allowedShelves.has(String(item.id || '')))
                .map((shelf) => ({
                    ...shelf,
                    dismissible: (String(shelf.id || '') !== 'hidden-books'),
                    canHide: (String(shelf.id || '') !== 'hidden-books'),
                    discoveryHasMore: (
                        String(shelf.id || '') === 'similar-books' && this.discoverySimilarExhausted === true
                            ? false
                            : shelf.discoveryHasMore
                    ),
                    items: (Array.isArray(shelf.items) ? shelf.items : [])
                        .filter((book) => !(this.showDiscoveryUnreadOnly === true && book && book.discoveryRead === true && String(shelf.id || '') !== 'hidden-books'))
                        .map((book) => ({
                            ...book,
                            discoveryShelfId: String(shelf.id || ''),
                            discoveryDismissible: (String(shelf.id || '') !== 'hidden-books'),
                            discoveryDismissLabel: 'Неинтересно',
                            discoveryRestoreable: (String(shelf.id || '') === 'hidden-books'),
                            discoveryRestoreLabel: 'Вернуть',
                        })),
                }));
        }
        if (this.selectedList === 'newest')
            return shelves.filter(item => item && /^newest-\d+d$/.test(String(item.id || '')));
        if (this.selectedList === 'popular')
            return shelves.filter(item => item && item.id === 'popular');
        if (this.selectedList === 'bestsellers')
            return shelves
                .filter(item => item && item.source === 'external')
                .map((shelf) => ({
                    ...shelf,
                    items: ((Array.isArray(shelf.items) ? shelf.items : []).filter((book) => {
                        const kind = String((book && book.discoveryItemKind) || 'book').trim().toLowerCase() || 'book';
                        return kind !== 'genre';
                    })).slice(this.externalDiscoveryPageStart, this.externalDiscoveryPageEnd),
                }));
        return shelves;
    }

    get externalDiscoverySourceShelves() {
        return (Array.isArray(this.discoveryShelves) ? this.discoveryShelves : [])
            .filter(item => item && item.source === 'external');
    }

    get externalDiscoverySourceShelf() {
        return (this.externalDiscoverySourceShelves[0] || null);
    }

    get externalDiscoveryFilteredItems() {
        const shelf = this.externalDiscoverySourceShelf;
        const items = (shelf && Array.isArray(shelf.items) ? shelf.items : []);
        return items.filter((book) => {
            const kind = String((book && book.discoveryItemKind) || 'book').trim().toLowerCase() || 'book';
            return kind !== 'genre';
        });
    }

    get externalDiscoveryGenreOptions() {
        const shelf = this.externalDiscoverySourceShelf;
        const options = (shelf && Array.isArray(shelf.genreOptions) ? shelf.genreOptions : []);
        const selectedUrl = String(this.discoveryExternalGenreUrl || '').trim();
        const selectedName = String(this.discoveryExternalGenreName || '').trim();
        const result = [{label: 'Все жанры', value: ''}];
        const seen = new Set(['']);

        for (const option of options) {
            const label = String(option && option.label || '').trim();
            const value = String(option && option.value || '').trim();
            if (!label || !value || seen.has(value))
                continue;
            seen.add(value);
            result.push({label, value});
        }

        if (selectedUrl && !seen.has(selectedUrl))
            result.push({label: (selectedName || 'Выбранный жанр'), value: selectedUrl});

        return result;
    }

    get externalDiscoveryHasMore() {
        return !!(this.externalDiscoverySourceShelf && this.externalDiscoverySourceShelf.discoveryHasMore);
    }

    get externalDiscoveryPageSize() {
        const limit = Math.max(12, Math.min(parseInt(this.discoveryExternalLimit, 10) || 12, 120));
        if (limit <= 12)
            return 12;
        if (limit <= 24)
            return 24;
        return 48;
    }

    get externalDiscoveryPageStart() {
        return Math.max(0, (this.externalDiscoveryCurrentPage - 1) * this.externalDiscoveryPageSize);
    }

    get externalDiscoveryPageEnd() {
        return Math.max(this.externalDiscoveryPageStart + this.externalDiscoveryPageSize, parseInt(this.discoveryExternalLimit, 10) || 12);
    }

    get externalDiscoveryCurrentPage() {
        return Math.max(1, parseInt(this.discoveryExternalPage, 10) || 1);
    }

    get externalDiscoveryTotalPages() {
        const totalItems = this.externalDiscoveryFilteredItems.length;
        let totalPages = Math.max(1, Math.ceil(totalItems / this.externalDiscoveryPageSize));
        if (this.externalDiscoveryHasMore && totalItems >= this.externalDiscoveryPageSize * totalPages)
            totalPages++;
        return totalPages;
    }

    get externalDiscoveryEffectiveFetchLimit() {
        return Math.max(
            parseInt(this.discoveryExternalLimit, 10) || this.externalDiscoveryPageSize,
            Math.min(this.externalDiscoveryCurrentPage * this.externalDiscoveryPageSize, 120),
        );
    }

    get externalDiscoveryPagination() {
        const totalItems = this.externalDiscoveryFilteredItems.length;
        const currentPage = this.externalDiscoveryCurrentPage;
        const totalPages = this.externalDiscoveryTotalPages;
        return {
            page: currentPage,
            perPage: this.externalDiscoveryPageSize,
            totalItems,
            totalPages,
            canPrev: currentPage > 1,
            canNext: (currentPage < totalPages),
        };
    }

    get discoveryShelvesRequestKey() {
        const config = this.config || {};
        const discovery = config.discovery || {};
        const dbHash = (config.dbConfig && config.dbConfig.inpxHash ? config.dbConfig.inpxHash : this.list.inpxHash || '');

        return JSON.stringify({
            section: this.selectedList,
            dbHash,
            enabled: (discovery.enabled !== false),
            currentUserId: this.currentUserId || '',
            profileAuthorized: !!this.config.profileAuthorized,
            showContinueReading: this.showDiscoveryContinueReading !== false,
            showFromLists: this.showDiscoveryFromLists !== false,
            showUnfinishedSeries: this.showDiscoveryUnfinishedSeries !== false,
            showSimilar: this.showDiscoverySimilar !== false,
            unreadOnly: this.showDiscoveryUnreadOnly === true,
            compact: this.compactDiscoveryCards === true,
            source: this.activeDiscoveryExternalSource || 'none',
            sourceName: this.activeDiscoveryExternalName || '',
            sourceUrl: this.activeDiscoveryExternalUrl || '',
            sourceTtl: this.activeDiscoveryExternalTtlMinutes || 1440,
            browseUrl: this.discoveryExternalGenreUrl || '',
            browseName: this.discoveryExternalGenreName || '',
            filter: this.discoveryExternalFilter || 'books',
            newestLimit: this.discoveryNewestLimit || 8,
            popularLimit: this.discoveryPopularLimit || 8,
            similarLimit: this.discoverySimilarLimit || 16,
            externalLimit: this.externalDiscoveryEffectiveFetchLimit,
        });
    }

    get extSearchNames() {
        let result = [];
        for (const f of this.recStruct) {
            if (this.extSearch[f.field])
                result.push(`${f.field}=${this.extSearch[f.field]}`);
        }
        return result.join(', ');
    }

    async updateListFromRoute(to) {
        if (!this.isSearchRoute(to))
            return;

        const newPath = to.path;

        let newList = this.getListRoute(newPath);
        if (newList == 'extended' && !this.config.extendedSearch)
            newList = '';
        if (!this.isDiscoveryListEnabled(newList))
            newList = '';
        newList = (newList ? newList : 'books');

        if (this.selectedList != newList)
            this.selectedList = newList;
    }

    getListRoute(newPath) {
        newPath = (newPath ? newPath : this.$route.path);
        const m = newPath.match(/^\/([^/]*).*$/i);
        return (m ? m[1] : newPath);
    }

    openReleasePage() {
        if (!this.config.latestReleaseLink)
            return;
        try {
            const parsed = new URL(this.config.latestReleaseLink, window.location.origin);
            if (!['http:', 'https:'].includes(parsed.protocol))
                return;
            window.open(parsed.href, '_blank', 'noopener,noreferrer');
        } catch {
            // Ignore malformed release link.
        }
    }

    normalizeReleaseVersion(value = '') {
        return String(value || '').trim().replace(/^v/i, '');
    }

    parseReleaseVersion(value = '') {
        const normalized = this.normalizeReleaseVersion(value);
        const [mainPart, prePart = ''] = normalized.split('-', 2);
        const main = mainPart.split('.').map(part => parseInt(part || '0', 10) || 0);
        while (main.length < 3)
            main.push(0);

        let pre = null;
        if (prePart) {
            const match = prePart.match(/^([a-z]+)(?:[.-]?(\d+))?$/i);
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

    compareReleaseVersions(left = '', right = '') {
        const a = this.parseReleaseVersion(left);
        const b = this.parseReleaseVersion(right);

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

    makeProjectName() {
        const collection = this.config.dbConfig.inpxInfo.collection.split('\n');
        this.collection = collection[0].trim();

        let projectName = `${this.config.name} v${this.config.webAppVersion}`;
        if (this.settings.showNewReleaseAvailable && this.config.latestVersion && this.compareReleaseVersions(this.config.latestVersion, this.config.version) > 0)
            projectName += `, доступно обновление: v${this.config.latestVersion}`;

        this.projectName = projectName;
        this.makeTitle();
    }

    makeTitle() {
        if (!this.isSearchRoute(this.$route)) return;
        if (!this.collection)
            return;

        let result = `Коллекция ${this.collection}`;

        if (!this.isExtendedSearch) {
            const search = this.search;
            const correctValue = (v) => {
                if (v) {
                    if (v[0] === '=')
                        v = v.substring(1);
                }
                return v || '';
            };

            if (search.author || search.series || search.title) {
                const as = (search.author ? search.author.split(',') : []);
                const author = (as.length ? as[0] : '') + (as.length > 1 ? ' и др.' : '');

                const a = correctValue(author);
                let s = correctValue(search.series);
                s = (s ? `(Серия: ${s})` : '');
                let t = correctValue(search.title);
                t = (t ? `"${t}"` : '');

                result = [s, t].filter(v => v).join(' ');
                result = [a, result].filter(v => v).join(' ');
            } else if (this.selectedList === 'for-you') {
                result = `Для вас: ${this.collection}`;
            } else if (this.selectedList === 'newest') {
                result = `Новинки: ${this.collection}`;
            } else if (this.selectedList === 'popular') {
                result = `Популярное: ${this.collection}`;
            } else if (this.selectedList === 'bestsellers') {
                result = `${this.activeDiscoveryExternalLabel}: ${this.collection}`;
            } else if (this.isBooksBrowse) {
                result = `Все книги: ${this.collection}`;
            }
        } else {
            if (this.extSearchNames)
                result = this.extSearchNames;
        }

        this.$root.setAppTitle(result);
        if (this.list.liberamaReady)
            this.sendMessage({type: 'titleChange', data: result});
    }

    selectExtSearch() {
        this.selectExtSearchDialogVisible = true;
    }

    clearExtSearch() {
        const self = this.extSearch;
        self.setDefaults(self, {page: self.page, limit: self.limit});
    }
    
    scrollToTop() {
        this.$refs.scroller.scrollTop = 0;
    }

    updatePageCount() {
        if (this.list.totalFound < 0)
            return;

        const activeList = this.$refs.list;
        if (!activeList || typeof activeList.getPaginationContext !== 'function' || this.list.searchRequestId !== activeList.searchRequestId ||
            !_.isEqual(this.list.queryContext, activeList.getPaginationContext()))
            return;

        this.pageCount = Math.ceil(this.list.totalFound/this.limit);
        this.pageCount = (this.pageCount < 1 ? 1 : this.pageCount);

        if (this.search.page > this.pageCount)
            this.search.page = 1;
    }

    listEvent(event) {
        switch (event.action) {
            case 'scrollToTop':
                this.scrollToTop();
                break;
            case 'submitUrl':
                this.sendMessage({type: 'submitUrl', data: event.data});
                break;
            case 'bookInfo':
                this.bookInfoRequestId = event.requestId;
                this.bookInfo = event.data;
                this.bookInfoDialogTab = (event.tab || 'fb2');
                this.bookInfoDialogVisible = true;
                break;
            case 'bookInfoLoaded':
                //пользователь мог закрыть карточку или открыть другую
                if (this.bookInfoDialogVisible && event.requestId === this.bookInfoRequestId
                    && this.bookInfo.book && this.bookInfo.book._uid === event.bookUid) {
                    if (event.data.book && event.data.book.size > 0)
                        this.bookInfo.book.size = event.data.book.size;
                    this.bookInfo = event.data;
                    if (event.error)
                        this.$root.stdDialog.alert(event.error, 'Ошибка');
                }
                break;
            case 'manageReadingLists':
                this.openReadingLists(event.book || null);
                break;
            case 'refreshDiscoveryShelves':
                this.refreshDiscoveryShelves(true); // no await
                break;
            case 'hideDiscoveryShelf':
                this.hideDiscoveryShelf(event.shelfId); // no await
                break;
            case 'dismissDiscoveryBook':
                this.dismissDiscoveryBook(event.book || {}); // no await
                break;
        }
    }

    openReadingLists(book = null) {
        this.readingListsDialogBook = (book || null);
        this.readingListsDialogVisible = true;
    }

    saveSearchShelf() {
        this.shelfName = '';
        this.shelfUnreadOnly = true;
        this.shelfError = '';
        this.shelfFilters = {...this.search};
        this.saveShelfDialogVisible = true;
    }

    async createSearchShelf() {
        const name = this.shelfName.trim();
        if (!name || this.shelfSaving) return;
        this.shelfSaving = true;
        this.shelfError = '';
        try {
            await this.$root.api.createReadingListWithVisibility(name, 'private', {...this.shelfFilters, unreadOnly: this.shelfUnreadOnly});
            this.saveShelfDialogVisible = false;
            this.openReadingLists();
        } catch (error) {
            this.shelfError = error.message;
        } finally {
            this.shelfSaving = false;
        }
    }

    hideDiscoveryShelf(shelfId = '') {
        const id = String(shelfId || '').trim();
        if (!id)
            return;

        const mapping = {
            'continue-reading': 'showDiscoveryContinueReading',
            'from-your-lists': 'showDiscoveryFromLists',
            'unfinished-series': 'showDiscoveryUnfinishedSeries',
            'similar-books': 'showDiscoverySimilar',
        };
        const settingName = mapping[id];
        if (!settingName)
            return;

        this.setSetting(settingName, false);
        this.$root.notify.success('Полка скрыта. Её можно вернуть в настройках.');
    }

    toggleDiscoveryUnreadOnly() {
        this.setSetting('showDiscoveryUnreadOnly', !(this.showDiscoveryUnreadOnly === true));
    }

    toggleCompactDiscoveryCards() {
        this.setSetting('compactDiscoveryCards', !(this.compactDiscoveryCards === true));
    }

    setDiscoveryExternalFilter(value = 'books') {
        const normalized = String(value || '').trim().toLowerCase();
        this.discoveryExternalPage = 1;
        this.discoveryExternalFilter = (['all', 'books', 'genres'].includes(normalized) ? normalized : 'books');
        this.setSetting('discoveryExternalFilter', this.discoveryExternalFilter);
    }

    async setDiscoveryExternalGenre(value = '') {
        const nextUrl = String(value || '').trim();
        const selected = this.externalDiscoveryGenreOptions.find(option => String(option.value || '') === nextUrl);

        this.discoveryExternalPage = 1;
        this.discoveryExternalGenreUrl = nextUrl;
        this.discoveryExternalGenreName = (selected ? selected.label : '');
        this.discoveryExternalFilter = 'books';
        this.discoveryExternalLimit = 12;
        this.setSetting('discoveryExternalGenreUrl', this.discoveryExternalGenreUrl);
        this.setSetting('discoveryExternalGenreName', this.discoveryExternalGenreName);
        this.setSetting('discoveryExternalFilter', this.discoveryExternalFilter);
        this.setSetting('discoveryExternalLimit', this.discoveryExternalLimit);

        this.discoveryShelvesCacheKey = '';
        if (this.selectedList === 'bestsellers') {
            this.discoveryShelvesLoading = true;
            await this.refreshDiscoveryShelves(true);
        }
    }

    async setDiscoveryExternalLimit(value = 12) {
        const raw = parseInt(value, 10) || 12;
        const normalized = ([12, 24, 48].includes(raw) ? raw : 12);
        this.discoveryExternalPage = 1;
        this.discoveryExternalLimit = normalized;
        this.setSetting('discoveryExternalLimit', this.discoveryExternalLimit);
        this.discoveryShelvesCacheKey = '';
        if (this.selectedList === 'bestsellers') {
            this.discoveryShelvesLoading = true;
            await this.refreshDiscoveryShelves(true);
        }
    }

    async changeDiscoveryExternalPage(delta = 0) {
        const nextPage = Math.max(1, (this.externalDiscoveryCurrentPage + (parseInt(delta, 10) || 0)));
        if (nextPage === this.externalDiscoveryCurrentPage && !(delta > 0 && this.externalDiscoveryPagination.canNext))
            return;

        this.discoveryExternalPage = nextPage;
        if (this.selectedList === 'bestsellers' && this.externalDiscoveryEffectiveFetchLimit > this.externalDiscoveryFilteredItems.length)
            await this.refreshDiscoveryShelves(true);
    }

    async loadMoreExternalDiscovery() {
        const current = Math.max(12, Math.min(parseInt(this.discoveryExternalLimit, 10) || 12, 120));
        const step = this.externalDiscoveryPageSize;
        const next = Math.min(120, current + step);
        if (next <= current)
            return;

        this.discoveryExternalLimit = next;
        this.setSetting('discoveryExternalLimit', this.discoveryExternalLimit);
        this.discoveryShelvesCacheKey = '';
        if (this.selectedList === 'bestsellers') {
            this.discoveryShelvesLoading = true;
            await this.refreshDiscoveryShelves(true);
        }
    }

    async loadMoreSimilarRecommendations() {
        const current = Math.max(8, Math.min(parseInt(this.discoverySimilarLimit, 10) || 16, 96));
        const next = Math.min(current + 8, 96);
        if (next === current) {
            this.discoverySimilarExhausted = true;
            this.$root.notify.info('Новых рекомендаций пока нет.');
            return;
        }

        const beforeShelf = (Array.isArray(this.selectedDiscoveryShelves) ? this.selectedDiscoveryShelves : [])
            .find(item => item && String(item.id || '') === 'similar-books');
        const beforeCount = beforeShelf && Array.isArray(beforeShelf.items) ? beforeShelf.items.length : 0;

        this.discoverySimilarLimit = next;
        this.discoveryShelvesCacheKey = '';
        if (this.selectedList === 'for-you') {
            this.discoveryShelvesLoading = true;
            await this.refreshDiscoveryShelves(true);
        }

        const afterShelf = (Array.isArray(this.selectedDiscoveryShelves) ? this.selectedDiscoveryShelves : [])
            .find(item => item && String(item.id || '') === 'similar-books');
        const afterCount = afterShelf && Array.isArray(afterShelf.items) ? afterShelf.items.length : 0;

        if (afterCount <= beforeCount) {
            this.discoverySimilarExhausted = true;
            this.$root.notify.info('Новых рекомендаций пока нет.');
        } else {
            this.discoverySimilarExhausted = !(afterShelf && afterShelf.discoveryHasMore === true);
        }
    }

    async dismissDiscoveryBook(book = {}) {
        await this.setDiscoveryFeedback({book, kind: 'not_interested'});
    }

    async setDiscoveryFeedback(payload = {}) {
        const book = (payload && payload.book ? payload.book : payload);
        const kind = String(payload && payload.kind || 'not_interested').trim().toLowerCase();
        const bookUid = String(book._uid || book.bookUid || '').trim();
        if (!bookUid)
            return;

        try {
            await this.api.updateDiscoveryPreferences({
                feedbackSet: [{
                    bookUid,
                    kind,
                    shelfId: String(book.discoveryShelfId || 'similar-books'),
                }],
            });
            this.discoverySimilarExhausted = false;
            this.discoveryShelvesCacheKey = '';
            await this.refreshDiscoveryShelves(true);
            const messages = {
                more_like_this: 'Будем показывать больше похожих книг.',
                dislike_author: 'Автор будет реже появляться в рекомендациях.',
                dislike_genre: 'Этот жанр будет реже появляться в рекомендациях.',
                already_read: 'Книга убрана из рекомендаций.',
                ignore_for_taste: 'Книга больше не влияет на ваши вкусы и остаётся доступной в библиотеке.',
                not_interested: 'Книга скрыта из персональных витрин.',
            };
            this.$root.notify.success(messages[kind] || messages.not_interested);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async restoreDiscoveryBook(book = {}) {
        const bookUid = String(book._uid || book.bookUid || '').trim();
        if (!bookUid)
            return;

        try {
            await this.api.updateDiscoveryPreferences({
                hiddenBooksRemove: [bookUid],
                feedbackRemove: [bookUid],
            });
            this.discoverySimilarExhausted = false;
            this.discoveryShelvesCacheKey = '';
            await this.refreshDiscoveryShelves(true);
            this.$root.notify.success('Книга возвращена в персональные витрины.');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async saveDiscoveryTaste(taste = {}) {
        try {
            await this.api.updateDiscoveryPreferences({taste});
            this.discoverySimilarExhausted = false;
            this.discoveryShelvesCacheKey = '';
            await this.refreshDiscoveryShelves(true);
            this.$root.notify.success('Вкусы сохранены. Персональная подборка обновлена.');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async dismissDiscoveryTasteSetup() {
        try {
            await this.api.updateDiscoveryPreferences({
                tastePromptDismissedAt: new Date().toISOString(),
            });
            this.discoveryShelvesCacheKey = '';
            await this.refreshDiscoveryShelves(true);
            this.$root.notify.info('Вкусы можно настроить позже на странице «Для вас».');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    recordDiscoveryInteraction(payload = {}) {
        const book = payload && payload.book || {};
        const bookUid = String(book._uid || book.bookUid || '').trim();
        const type = String(payload && payload.type || '').trim().toLowerCase();
        if (!bookUid || !type)
            return;
        this.api.recordDiscoveryEvents([{
            bookUid,
            type,
            shelfId: String(book.discoveryShelfId || ''),
        }]).catch(() => {});
    }

    recordDiscoveryImpressions(shelves = []) {
        if (this.selectedList !== 'for-you')
            return;
        const events = (Array.isArray(shelves) ? shelves : [])
            .filter(shelf => shelf && String(shelf.id || '') !== 'hidden-books')
            .flatMap(shelf => (Array.isArray(shelf.items) ? shelf.items : []).map(book => ({
                bookUid: String(book && (book._uid || book.bookUid) || '').trim(),
                type: 'impression',
                shelfId: String(shelf.id || 'unknown'),
            })))
            .filter(item => item.bookUid);
        if (events.length)
            this.api.recordDiscoveryEvents(events).catch(() => {});
    }

    bookInfoNavigate(event) {
        if (!event || !event.value)
            return;

        switch (event.type) {
            case 'author':
                this.search.author = `=${event.value}`;
                this.selectedList = 'author';
                break;
            case 'series':
                this.search.series = `=${event.value}`;
                this.selectedList = 'series';
                break;
            case 'title':
                this.search.title = `=${event.value}`;
                this.selectedList = 'title';
                break;
            case 'genreName': {
                const genreCode = this.findGenreCodeByName(event.value);
                if (!genreCode)
                    return;

                this.search.genre = genreCode;
                this.selectedList = 'books';
                break;
            }
            case 'keyword':
                this.search.keywords = `*${event.value}`;
                this.selectedList = 'books';
                break;
        }

        this.scrollToTop();
    }

    findGenreCodeByName(name) {
        if (!name)
            return '';

        for (const [code, title] of this.genreMap.entries()) {
            if (title === name)
                return code;
        }

        return '';
    }

    setSetting(name, newValue) {
        this.commit('setSettings', {[name]: _.cloneDeep(newValue)});
    }

    updateSearchFromRouteQuery(to) {
        if (!this.ready)
            return;
        if (!this.isSearchRoute(to))
            return;
        if (this.list.liberamaReady)
            this.sendCurrentUrl();

        const query = to.query;

        this.search.setDefaults(this.search, {
            author: query.author,
            series: query.series,
            title: query.title,
            keywords: query.keywords,
            genre: query.genre,
            lang: (typeof(query.lang) == 'string' ? query.lang : this.langDefault),
            date: query.date,
            librate: query.librate,
            ratingCount: query.ratingCount,
            isbn: query.isbn,
            ext: query.ext,
            sourceId: query.sourceId,
            hideCopies: query.hideCopies === true || query.hideCopies === 'true' || query.hideCopies === '1',

            page: parseInt(query.page, 10),
            limit: parseInt(query.limit, 10) || this.search.limit,
        });

        if (this.search.limit > maxLimit)
            this.search.limit = maxLimit;

        const queryExtSearch = {
            page: this.search.page,
            limit: this.search.limit,
        };

        for (const f of this.recStruct) {
            const field = `ex_${f.field}`;
            if (query[field])
                queryExtSearch[f.field] = query[field];
        }

        this.extSearch.setDefaults(this.extSearch, queryExtSearch);
    }

    updateRouteQueryFromSearch() {
        if (!this.ready)
            return;
        if (!this.isSearchRoute(this.$route))
            return;

        const oldQuery = this.$route.query;
        let query = {};

        const cloned = {};
        this.search.setDefaults(cloned, this.search);

        query = _.pickBy(cloned);

        if (this.search.lang == this.langDefault) {
            delete query.lang;
        } else {
            query.lang = this.search.lang;
        }

        if (this.search.hideCopies)
            query.hideCopies = '1';
        else
            delete query.hideCopies;

        for (const f of this.recStruct) {
            const field = `ex_${f.field}`;
            if (this.extSearch[f.field])
                query[field] = this.extSearch[f.field];
        }

        const normalize = value => Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, Array.isArray(item) ? item.map(String) : item === null ? null : String(item)]));
        if (!_.isEqual(normalize(oldQuery), normalize(query))) {
            this.$router.replace({path: this.selectedList, query});
        }
    }

    async updateGenreTreeIfNeeded() {
        if (this.genreTreeUpdating)
            return;

        this.genreTreeUpdating = true;
        try {
            if (this.genreTreeInpxHash !== this.list.inpxHash) {
                let result;

                if (this.abCacheEnabled) {
                    const key = `genre-tree-${this.list.inpxHash}`;
                    const data = await authorBooksStorage.getData(key);
                    if (data) {
                        result = JSON.parse(data);
                    } else {
                        result = await this.api.getGenreTree();

                        await authorBooksStorage.setData(key, JSON.stringify(result));
                    }
                } else {
                    result = await this.api.getGenreTree();
                }

                this.genreTree = result.genreTree;
                this.genreMap = new Map();
                for (const section of this.genreTree) {
                    for (const g of section.value)
                        this.genreMap.set(g.value, g.name);
                }

                this.langList = result.langList;
                this.extList = result.extList;
                this.genreTreeInpxHash = result.inpxHash;
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        } finally {
            this.genreTreeUpdating = false;
        }
    }

    async refreshDiscoveryShelves(force = false) {
        if (!this.isSearchRoute(this.$route) || !this.showDiscoveryShelves)
            return;
        const cacheKey = this.discoveryShelvesRequestKey;
        if (!force && (this.discoveryShelvesCacheKey === cacheKey
            || (this.discoveryShelvesLoading && this.discoveryShelvesPendingKey === cacheKey)))
            return;

        const requestSeq = ++this.discoveryShelvesRequestSeq;
        this.discoveryShelvesPendingKey = cacheKey;
        this.discoveryShelvesLoading = true;
        this.discoveryShelvesError = '';
        try {
            const response = await this.api.getDiscoveryShelves({
                forceRefresh: force === true,
                personalLimit: this.discoveryPopularLimit,
                personalSimilarLimit: this.discoverySimilarLimit,
                personalSimilarEnabled: this.showDiscoverySimilar,
                newestLimit: this.discoveryNewestLimit,
                popularLimit: this.discoveryPopularLimit,
                ...(this.config.clientApi?.features?.includes('separateExternalDiscovery')
                    ? {externalOnly: this.selectedList === 'bestsellers', includeExternal: false} : {}),
                externalLimit: this.externalDiscoveryEffectiveFetchLimit,
                externalSource: this.activeDiscoveryExternalSource,
                externalName: this.activeDiscoveryExternalName,
                externalUrl: this.activeDiscoveryExternalUrl,
                externalTtlMinutes: this.activeDiscoveryExternalTtlMinutes,
                externalBrowseUrl: this.discoveryExternalGenreUrl,
                externalBrowseName: this.discoveryExternalGenreName,
            });
            if (requestSeq === this.discoveryShelvesRequestSeq && this.showDiscoveryShelves && cacheKey === this.discoveryShelvesRequestKey) {
                this.discoveryShelves = (response && Array.isArray(response.shelves) ? response.shelves : []);
                this.discoveryShelvesCacheKey = cacheKey;
                this.recordDiscoveryImpressions(this.discoveryShelves);
            }
        } catch (e) {
            if (requestSeq === this.discoveryShelvesRequestSeq && this.showDiscoveryShelves) {
                const message = String(e && e.message || '').trim() || 'нет ответа от сервера';
                this.discoveryShelvesError = `Ошибка витрины: ${message}`;
            }
        } finally {
            if (requestSeq === this.discoveryShelvesRequestSeq)
                this.discoveryShelvesLoading = false;
        }
    }

}

export default vueComponent(Search);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.search--shelves .result-bar {margin-top: 18px;}
.search--shelves .catalog-footer {background: transparent;}
.search--shelves :deep(.books-grid:not(.books-grid--list)) {grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); grid-auto-rows: auto; align-items: stretch; gap: 16px 20px;}
.search--shelves :deep(.books-grid:not(.books-grid--list) > .library-result-card) {margin: 0;}
.search--shelves :deep(.rating-toolbar) {display: none;}
.search--shelves :deep(.bulk-read-toolbar) {margin-top: 12px; margin-bottom: 4px;}
.search--shelves .result-bar {font-size: 12px;}
.save-shelf-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(380px, calc(100vw - 64px));
    padding: 8px 0;
}

.save-shelf-description {
    color: var(--app-muted);
}

.root {
}

.search-scroll {
    scrollbar-color: rgba(100, 116, 139, 0.42) transparent;
    scrollbar-width: thin;
}

.result-bar {
    min-height: 40px;
    color: var(--app-muted);
    flex-wrap: wrap;
    gap: 8px 12px;
}

.result-scroller-wrap {
    width: 400px;
    max-width: 100%;
}

.bottom-scroller-bar {
    flex-wrap: wrap;
}

.catalog-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px 12px;
    padding: 12px 16px 24px;
    font-size: 13px;
}

.project-pill,
.community-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    min-height: 40px;
    max-width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    font: inherit;
    line-height: 1.4;
    text-align: center;
    cursor: pointer;
}

.project-pill {
    color: var(--app-muted);
    box-shadow: 0 2px 8px rgba(23, 32, 42, 0.06);
}

.community-link {
    color: var(--app-link);
    text-decoration: none;
}

.project-pill:hover,
.community-link:hover {
    border-color: var(--app-link);
}

.project-pill:focus-visible,
.community-link:focus-visible {
    outline: 2px solid var(--app-link);
    outline-offset: 3px;
}

.separator {
    border-bottom: 1px solid var(--app-border);
    margin: 8px 0;
}

@media (max-width: 640px) {

    .result-bar {
        min-height: auto;
        padding-left: 8px;
        padding-right: 8px;
        font-size: 13px;
        margin-left: 0 !important;
        margin-top: 8px !important;
        align-items: flex-start;
    }

    .result-scroller-wrap {
        width: 100%;
    }

    .bottom-scroller-bar {
        margin-left: 8px !important;
        margin-right: 8px !important;
        margin-bottom: 10px !important;
    }

    .project-pill {
        margin-left: 8px;
        margin-right: 8px;
    }
}
</style>
