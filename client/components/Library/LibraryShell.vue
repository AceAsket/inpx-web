<template>
    <div class="library-shell" :class="{'library-shell--active': enabled}">
        <template v-if="enabled">
            <header class="library-shell__header">
                <RouterLink to="/overview" class="library-brand" aria-label="INPX Web — обзор">
                    <img class="library-brand__mark" :src="`${config.rootPathStatic || ''}/shelves-icon.svg`" width="34" height="34" alt="" />
                    <span>INPX <strong>Web</strong></span>
                </RouterLink>
                <span class="library-shell__collection" :title="collection">{{ collection }}</span>
                <div class="library-shell__header-actions">
                    <q-btn flat round :icon="settings.darkTheme ? 'la la-sun' : 'la la-moon'"
                        :aria-label="settings.darkTheme ? 'Включить светлую тему' : 'Включить тёмную тему'"
                        @click="store.commit('setSettings', {darkTheme: !settings.darkTheme})" />
                    <q-btn flat round icon="la la-cog" aria-label="Настройки библиотеки" @click="settingsVisible = true" />
                </div>
            </header>
            <nav class="library-shell__nav" aria-label="Разделы библиотеки">
                <RouterLink v-for="item in navigation" :key="item.id" :to="item.to" :aria-current="activeSection === item.id ? 'page' : undefined"
                    class="library-nav-link" :class="{'is-active': activeSection === item.id}">
                    <span class="library-nav-link__icon"><q-icon :name="item.icon" size="25px" aria-hidden="true" /></span>
                    <span>{{ item.label }}</span>
                </RouterLink>
                <RouterLink to="/profile" class="library-shell__nav-bottom" aria-label="Открыть мой профиль">
                    <span class="library-shell__profile-initial">{{ profileName.slice(0, 1).toUpperCase() }}</span>
                    <div><strong>{{ profileName }}</strong><small>{{ config.profileAuthorized ? 'Личная библиотека' : 'Общая библиотека' }}</small></div>
                    <q-icon name="la la-angle-right" size="16px" aria-hidden="true" />
                </RouterLink>
            </nav>
        </template>
        <div :class="enabled ? 'library-shell__main' : 'library-shell__passthrough'"><slot /></div>

        <template v-if="enabled">
            <SettingsDialog v-if="settingsVisible" v-model="settingsVisible" @open-library-tasks="libraryTools.openTasks()" />
            <UserProfilesDialog v-if="profilesVisible" v-model="profilesVisible" />
            <ReadingListsDialog v-if="listsVisible" v-model="listsVisible" :book="listsBook" />
            <BookInfoDialog v-if="detailsVisible" v-model="detailsVisible" :book-info="details" :genre-map="genreMap" @navigate="navigateFromBook" />
            <BookActionsDialog v-if="actionsVisible" v-model="actionsVisible" :book="actionsBook" :genre-map="genreMap" @navigate="navigateFromBook" @details="openDetails" @list-event="bookActionEvent" @updated="repository.loadReading(true)" />
            <LibraryTools ref="libraryTools" />
        </template>
    </div>
</template>

<script setup>
import {computed, ref, reactive, watch, provide, getCurrentInstance, defineAsyncComponent} from 'vue';
import {useStore} from 'vuex';
import {useRoute, useRouter} from 'vue-router';
import './librarySurfaces.css';
import {libraryContextKey} from './libraryContext';
import {LibraryRepository, emptyState} from './libraryRepository';
import {identity, bookUid, readable, progress, catalogRoutes, discoveryOptions, genreMapFromTree} from './libraryModel';

const SettingsDialog = defineAsyncComponent(() => import('../Search/SettingsDialog/SettingsDialog.vue'));
const UserProfilesDialog = defineAsyncComponent(() => import('../Search/UserProfilesDialog/UserProfilesDialog.vue'));
const ReadingListsDialog = defineAsyncComponent(() => import('../Search/ReadingListsDialog/ReadingListsDialog.vue'));
const BookInfoDialog = defineAsyncComponent(() => import('../Search/BookInfoDialog/BookInfoDialog.vue'));
const LibraryTools = defineAsyncComponent(() => import('../Search/LibraryTools.vue'));
const BookActionsDialog = defineAsyncComponent(() => import('./BookActionsDialog.vue'));
const props = defineProps({enabled: Boolean});
const store = useStore(), route = useRoute(), router = useRouter();
const root = getCurrentInstance().proxy.$root;
const config = computed(() => store.state.config), settings = computed(() => store.state.settings);
const state = reactive(emptyState());
const repository = new LibraryRepository(root.api, patch => Object.assign(state, patch));
const lastCatalog = ref('/books');
const settingsVisible = ref(false), profilesVisible = ref(false), listsVisible = ref(false), detailsVisible = ref(false);
const details = ref({}), listsBook = ref(null), genreMap = ref(new Map()), libraryTools = ref(null);
const actionsVisible = ref(false), actionsBook = ref({});
let detailRequest = 0;
let genreRequest = null;
let genresLoaded = false;
const profileName = computed(() => config.value.currentUserProfile?.name || (config.value.profileAuthorized ? 'Мой профиль' : 'Общий профиль'));
const collection = computed(() => String(config.value.dbConfig?.inpxInfo?.collection || 'Ваша библиотека').split('\n')[0]);
const activeSection = computed(() => route.path === '/overview' ? 'overview' : route.path === '/my-books' ? 'books' : route.path === '/profile' ? 'profile' : 'catalog');
const navigation = computed(() => [
    {id: 'overview', label: 'Обзор', icon: 'la la-home', to: '/overview'},
    {id: 'catalog', label: 'Каталог', icon: 'la la-search', to: lastCatalog.value},
    {id: 'books', label: 'Мои книги', icon: 'la la-book', to: '/my-books'},
    {id: 'profile', label: 'Профиль', icon: 'la la-user', to: '/profile'},
]);
watch(() => route.fullPath, () => {
    if (catalogRoutes.has(route.path)) lastCatalog.value = route.fullPath;
    settingsVisible.value = false;
    profilesVisible.value = false;
    listsVisible.value = false;
    detailsVisible.value = false;
    actionsVisible.value = false;
}, {immediate: true});
watch(() => [identity(config.value, settings.value), JSON.stringify(discoveryOptions(settings.value)), config.value.discovery?.enabled], () => {
    const previous = repository.epoch;
    repository.setContext(config.value, settings.value);
    if (previous !== repository.epoch) {
        detailsVisible.value = false;
        listsVisible.value = false;
        actionsVisible.value = false;
        details.value = {};
        genreMap.value = new Map();
        genreRequest = null;
        genresLoaded = false;
        detailRequest++;
    }
}, {immediate: true});
watch(listsVisible, (visible, previous) => {if (!visible && previous && props.enabled) repository.loadReading(true);});
watch(() => props.enabled, enabled => {
    if (!enabled) {settingsVisible.value = false; profilesVisible.value = false; detailsVisible.value = false; listsVisible.value = false; actionsVisible.value = false;}
});

function openBook(book) {
    if (readable(book, config.value)) router.push({path: '/reader', query: {bookUid: bookUid(book)}});
    else openActions(book);
}
function openActions(book) {
    actionsBook.value = {...book, _uid: bookUid(book),
        _readerProgress: book._readerProgress || (progress(book) === null ? undefined : {percent: progress(book), started: true})};
    actionsVisible.value = true;
}
async function openDetails(book) {
    ensureGenres().catch(() => {});
    const request = ++detailRequest, epoch = repository.epoch;
    const record = {...book, _uid: bookUid(book)};
    details.value = {book: record, loading: true};
    detailsVisible.value = true;
    try {
        if (!record._uid || record.discoveryMissingLocal) {
            details.value = {book: record};
            return;
        }
        const result = await root.api.getBookCard(record._uid);
        if (request === detailRequest && epoch === repository.epoch && detailsVisible.value)
            details.value = result.bookInfo || {book: record};
    } catch (error) {
        if (request !== detailRequest || epoch !== repository.epoch || !detailsVisible.value) return;
        details.value = {book: record};
        root.stdDialog.alert(error.message, 'Не удалось загрузить карточку');
    }
}
async function ensureGenres() {
    if (genresLoaded) return;
    if (genreRequest) return genreRequest;
    const epoch = repository.epoch;
    genreRequest = (async() => {
        try {
            const result = await root.api.getGenreTree();
            if (epoch === repository.epoch) {genreMap.value = genreMapFromTree(result.genreTree || []); genresLoaded = true;}
        } finally {if (epoch === repository.epoch) genreRequest = null;}
    })();
    return genreRequest;
}
async function navigateFromBook({type, value}) {
    if (type === 'genreName' && value) {
        const epoch = repository.epoch;
        try {await ensureGenres();} catch (error) {root.stdDialog.alert(error.message, 'Не удалось открыть жанр'); return;}
        if (epoch !== repository.epoch) return;
        const name = String(value).trim().toLowerCase();
        value = Array.from(genreMap.value).find(([code, label]) => code.toLowerCase() === name || label.trim().toLowerCase() === name)?.[0]
            || (/^[a-z0-9_-]+$/.test(name) ? name : '');
        type = 'genre';
    }
    const fields = {author: 'author', series: 'series', title: 'title', keyword: 'keywords', genre: 'genre'};
    if (!fields[type] || !value) return;
    detailsVisible.value = false;
    router.push({path: ['keyword', 'genre'].includes(type) ? '/books' : `/${type}`, query: {[fields[type]]: `${type === 'genre' ? '' : type === 'keyword' ? '*' : '='}${value}`}});
}
function bookActionEvent(event) {
    if (event.action === 'manageReadingLists') {listsBook.value = event.book; listsVisible.value = true;}
}
async function login() {
    try {await root.api.showProfileLoginDialog('', {required: false}); await root.api.updateConfig();}
    catch (error) {root.stdDialog.alert(error.message, 'Вход в профиль');}
}
provide(libraryContextKey, {state, repository, config, settings, api: root.api, openBook, openDetails, openActions, login,
    openSettings: () => {settingsVisible.value = true;},
    openProfiles: () => {profilesVisible.value = true;},
    openLists: book => {listsBook.value = book ? {...book, _uid: bookUid(book)} : null; listsVisible.value = true;},
    openFollows: () => libraryTools.value?.openFollows(),
});
</script>

<style>
body[data-catalog-appearance="shelves"] {
    --app-bg: #f1f6f6; --app-surface: #ffffff; --app-surface-2: #d7eeea; --app-surface-3: #e8f0f0;
    --app-text: #183236; --app-muted: #52696d; --app-border: #d6e3e3; --app-primary: #00796f;
    --app-link: #00796f; --app-secondary: #00796f; --library-on-primary: #ffffff; --library-hero: #d7eeea; --library-on-hero: #005148;
    --q-primary: #00796f;
}
body.body--dark[data-catalog-appearance="shelves"] {
    --app-bg: #101d23; --app-surface: #192a32; --app-surface-2: #193f40; --app-surface-3: #20353c;
    --app-text: #e3eff0; --app-muted: #abc0c5; --app-border: #334a53; --app-primary: #6bdac9;
    --app-link: #6bdac9; --app-secondary: #6bdac9; --library-on-primary: #00382f; --library-hero: #193f40; --library-on-hero: #b4f1e5;
    --q-primary: #6bdac9;
}
body[data-catalog-appearance="shelves"] .q-btn.bg-primary {color: var(--library-on-primary) !important; background: var(--app-primary) !important;}
.library-page {height: 100%; overflow-y: auto; overflow-x: hidden; padding: 24px 32px 36px; scrollbar-color: var(--app-border) transparent;}
.library-page__body {width: 100%; margin: 0;}
.library-page h1 {font-size: 28px; font-weight: 550; line-height: 1.3; letter-spacing: -.035em; margin: 0;}
.library-page__subtitle {color: var(--app-muted); margin: 8px 0 28px; line-height: 1.6;}
.library-empty {padding: 30px; border: 1px solid var(--app-border); border-radius: 20px; color: var(--app-muted); line-height: 1.7;}
.library-empty h2 {font-size: 20px; font-weight: 550; line-height: 1.4; color: var(--app-text); margin: 8px 0;}
.library-empty .q-btn {margin-top: 14px;}
.library-notice {display: flex; align-items: center; flex-wrap: wrap; gap: 10px; color: var(--app-muted); padding: 12px 0; font-size: 13px;}
.library-notice[role="alert"] {color: var(--app-danger);}
.library-page button:focus-visible, .library-page a:focus-visible {outline: 3px solid var(--app-primary); outline-offset: 3px;}
@media (max-width: 899px) {.library-page {padding: 24px;}}
@media (max-width: 599px) {.library-page {padding: 18px 16px 28px;} .library-page h1 {font-size: 25px;} .library-empty {padding: 22px;}}
</style>

<style scoped>
.library-shell {height: 100%; min-width: 0;}
.library-shell__passthrough {height: 100%;}
.library-shell--active {display: grid; grid-template: 'header header' 64px 'nav main' minmax(0, 1fr) / 204px minmax(0, 1fr); background: var(--app-bg); color: var(--app-text);}
.library-shell__header {grid-area: header; display: flex; align-items: center; gap: 28px; padding: 0 28px; border-bottom: 1px solid var(--app-border);}
.library-brand {display: flex; align-items: center; gap: 10px; color: var(--app-text); text-decoration: none; white-space: nowrap; font-size: 22px; letter-spacing: -.04em;}
.library-brand strong {font-weight: 500;}
.library-brand__mark {display: block; width: 34px; height: 34px;}
.library-shell__collection {color: var(--app-muted); font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1;}
.library-shell__header-actions {display: flex; align-items: center; margin-left: auto; gap: 6px;}
.library-shell__header-actions .q-btn {color: var(--app-text);}
.library-shell__nav {grid-area: nav; display: flex; flex-direction: column; gap: 8px; padding: 26px 16px 22px; border-right: 1px solid var(--app-border);}
.library-nav-link {display: flex; gap: 12px; align-items: center; min-height: 52px; border-radius: 15px; padding: 0 16px; color: var(--app-muted); font-size: 14px; text-decoration: none; font-weight: 500;}
.library-nav-link.is-active {background: var(--app-surface-2); color: var(--app-primary);}
.library-nav-link:focus-visible {outline: 3px solid var(--app-primary); outline-offset: 2px;}
.library-shell__main {grid-area: main; min-width: 0; min-height: 0; overflow: hidden;}
.library-shell__nav-bottom {margin-top: auto; display: flex; gap: 10px; align-items: center; padding: 12px 8px; min-width: 0; border-radius: 14px; color: var(--app-text); text-decoration: none;}
.library-shell__nav-bottom:hover {background: var(--app-surface-3);}
.library-shell__nav-bottom:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 2px;}
.library-shell__nav-bottom > .q-icon {margin-left: auto; color: var(--app-muted);}
.library-shell__profile-initial {display: grid; place-items: center; background: var(--app-surface-2); border-radius: 11px; width: 34px; height: 34px; color: var(--app-primary); flex-shrink: 0; font-weight: 600;}
.library-shell__nav-bottom > div {min-width: 0;}
.library-shell__nav-bottom strong {display: block; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
.library-shell__nav-bottom small {color: var(--app-muted); font-size: 10px;}
@media (min-width: 600px) and (max-width: 899px) {.library-shell--active {grid-template-columns: 84px minmax(0, 1fr);} .library-shell__nav {padding: 22px 8px;} .library-nav-link {flex-direction: column; justify-content: center; gap: 3px; font-size: 10px; padding: 8px 2px;} .library-shell__nav-bottom {justify-content: center;} .library-shell__nav-bottom > div, .library-shell__nav-bottom > .q-icon {display: none;}}
@media (max-width: 599px) {
    .library-shell--active {grid-template: 'header' 64px 'main' minmax(0, 1fr) 'nav' auto / minmax(0, 1fr);}
    .library-shell__header {padding: 0 16px; gap: 8px; border-bottom: 0;}
    .library-brand {font-size: 20px; gap: 9px;}
    .library-brand__mark {width: 30px; height: 30px; border-radius: 9px;}
    .library-shell__collection {display: none;}
    .library-shell__header-actions {gap: 0;}
    .library-shell__header-actions .q-btn {min-width: 38px; min-height: 38px;}
    .library-shell__nav {flex-direction: row; justify-content: space-around; gap: 0; padding: 8px 4px max(8px, env(safe-area-inset-bottom)); border-right: 0; border-top: 1px solid var(--app-border); background: var(--app-surface);}
    .library-nav-link {flex: 1; min-width: 0; flex-direction: column; justify-content: center; gap: 3px; min-height: 54px; padding: 0 2px; font-size: 11px; border-radius: 0;}
    .library-nav-link.is-active {background: transparent; color: var(--app-text);}
    .library-nav-link__icon {display: grid; place-items: center; width: 54px; height: 30px; border-radius: 12px;}
    .is-active .library-nav-link__icon {background: var(--app-surface-2); color: var(--app-primary);}
    .library-shell__nav-bottom {display: none;}
}
</style>
