<template>
    <div class="library-page library-books">
        <div class="library-page__body">
            <div class="books-heading"><h1>{{ favoritesView ? 'Новое у любимых' : selectedList?.name || 'Мои книги' }}</h1><q-btn v-if="!favoritesView" flat no-caps icon="la la-bookmark" label="Управление полками" @click="library.openLists()" /></div>
            <p v-if="!favoritesView" class="library-page__subtitle">{{ selectedList ? 'Книги на вашей полке' : 'Продолжайте читать и возвращайтесь к любимым историям' }}</p>
            <div class="books-lists" aria-label="Мои полки">
                <RouterLink to="/my-books" :class="{'is-active': !listId && !favoritesView}" :aria-current="!listId && !favoritesView ? 'page' : undefined">История чтения</RouterLink>
                <RouterLink v-if="favoritesSupported" :to="{path: '/my-books', query: {view: 'favorites'}}" :class="{'is-active': favoritesView}" :aria-current="favoritesView ? 'page' : undefined">Новое у любимых <span class="books-count"><span v-if="favoriteCount > 0" data-testid="favorite-books-count">{{ favoriteCount }}</span></span></RouterLink>
                <RouterLink v-for="list in visibleLists" :key="list.id" :to="{path: '/my-books', query: {list: list.id}}" :class="{'is-active': listId === list.id}" :aria-current="listId === list.id ? 'page' : undefined">{{ list.name }} <span>{{ list.bookCount }}</span></RouterLink>
            </div>
            <LibraryFavoriteBooks v-if="favoritesView" :active="active" @count="favoriteCount = $event" />
            <LibraryNotice v-else-if="readingLocked" title="Войдите в свой профиль" message="История чтения и личные полки появятся после входа." action-label="Войти в профиль" @action="library.login" />
            <template v-else>
                <div v-if="!listId" class="books-filters">
                    <div class="books-tabs" aria-label="Состояние чтения">
                        <button v-for="tab in tabs" :key="tab.id" type="button" :aria-pressed="filter === tab.id" :class="{'is-active': filter === tab.id}" @click="filter = tab.id">{{ tab.label }}<span class="books-count">{{ state.reading?.counters ? state.reading.counters[tab.id] || 0 : '' }}</span></button>
                    </div>
                    <q-input v-model="query" outlined dense clearable label="Найти среди моих книг" class="books-search"><template #prepend><q-icon name="la la-search" /></template></q-input>
                </div>
                <div class="books-results" :aria-busy="loading || (!loaded && !error)">
                    <div v-if="!loaded && !error" class="books-grid" role="status" aria-label="Загружаем книги">
                        <div v-for="slot in 3" :key="slot" class="books-placeholder" aria-hidden="true" />
                    </div>
                    <div v-else-if="items.length" class="books-grid">
                        <BookTile v-for="book in items" :key="bookUid(book)" :book="book" />
                    </div>
                    <div v-else-if="!error" class="library-empty"><q-icon name="la la-book-open" size="32px" /><h2>{{ query ? 'Книги не найдены' : 'Здесь пока нет книг' }}</h2><p>{{ query ? 'Попробуйте другое название или имя автора.' : 'Открытые книги появятся в истории. Сохраняйте понравившиеся книги на свои полки.' }}</p><q-btn unelevated no-caps color="primary" label="Открыть каталог" to="/books" /></div>
                    <LibraryNotice v-if="error" error title="Не удалось загрузить книги" message="Проверьте подключение и попробуйте ещё раз." action-label="Повторить" :busy="loading" @action="load" />
                    <p v-if="count > items.length" class="library-page__subtitle">Показано {{ items.length }} из {{ count }}. Уточните поиск, чтобы найти нужную книгу.</p>
                </div>
            </template>
        </div>
    </div>
</template>

<script setup>
import {ref, computed, watch, onBeforeUnmount, onDeactivated} from 'vue';
import {useRoute} from 'vue-router';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';
import LibraryFavoriteBooks from './LibraryFavoriteBooks.vue';
import {bookUid, profileLoginError} from './libraryModel';
import {useLibraryPage} from './useLibraryPage';

const {library, active} = useLibraryPage('Мои книги', () => {library.repository.loadReading(true); load();});
const {state, config} = library;
const route = useRoute(), filter = ref('reading'), query = ref(''), items = ref([]), count = ref(0), error = ref(''), loading = ref(false), loaded = ref(false);
const favoritesSupported = computed(() => config.value.clientApi?.features?.includes('libraryFollowNews') === true);
const favoritesView = computed(() => favoritesSupported.value && route.path === '/my-books' && route.query.view === 'favorites');
const listId = computed(() => route.path === '/my-books' && !favoritesView.value ? String(route.query.list || '') : '');
const favoriteCount = ref(null);
const readingLocked = computed(() => state.locked || state.readingLoginRequired);
const favoritesAuthorized = computed(() => favoritesSupported.value && config.value.profileAuthorized && !readingLocked.value);
const visibleLists = computed(() => readingLocked.value ? [] : state.lists);
const selectedList = computed(() => visibleLists.value.find(list => list.id === listId.value));
const tabs = [{id: 'reading', label: 'Читаю'}, {id: 'read', label: 'Прочитано'}, {id: 'all', label: 'Все'}];
let sequence = 0, timer, running = false, queued = false;
let resultList;
function invalidateRequest() {
    sequence++;
    clearTimeout(timer);
}
function schedule() {
    invalidateRequest();
    if (active.value) timer = setTimeout(load, 500);
}
async function load() {
    if (!active.value || route.path !== '/my-books' || favoritesView.value || readingLocked.value) return;
    queued = true;
    sequence++;
    if (running) return;
    running = true;
    loading.value = true;
    try {
        while (queued && active.value && route.path === '/my-books' && !favoritesView.value && !readingLocked.value) {
            queued = false;
            const request = sequence, epoch = state.revision, list = listId.value;
            error.value = '';
            try {
                const response = list ? await library.api.getReadingList(list, {suppressProfileLogin: true})
                    : await library.api.getUserReadingLibrary({state: filter.value, query: query.value || '', sort: 'updatedDesc', limit: 100}, {suppressProfileLogin: true});
                if (!active.value || request !== sequence || epoch !== state.revision) continue;
                items.value = (list ? response.books || [] : response.items || []).filter(book => bookUid(book) && !book.hidden);
                count.value = Number(list ? response.list?.bookCount : response.count) || items.value.length;
                resultList = list;
                loaded.value = true;
            } catch (failure) {
                if (active.value && request === sequence && epoch === state.revision) {
                    if (profileLoginError(failure)) library.repository.requireLogin('reading');
                    else error.value = failure.message || 'Не удалось загрузить книги';
                }
            }
        }
    } finally {running = false; loading.value = false;}
}
watch([filter, query, () => state.readingRevision], schedule);
function clearResults() {
    items.value = [];
    count.value = 0;
    loaded.value = false;
    error.value = '';
}
watch([listId, favoritesView], ([list, favorites]) => {
    if (route.path !== '/my-books') return;
    if (!favorites && resultList !== list) clearResults();
    invalidateRequest();
    if (active.value) load();
});
watch(() => state.revision, () => {clearResults(); favoriteCount.value = null;});
watch(() => state.readingLoginRequired, required => {if (required) {sequence++; clearResults();}});
watch([active, favoritesView, () => state.revision, favoritesAuthorized, () => state.readingRevision], async([enabled, favorites, epoch, authorized], _, cleanup) => {
    if (!authorized) {favoriteCount.value = null; return;}
    if (!enabled || favorites) return;
    let current = true;
    cleanup(() => {current = false;});
    try {
        const result = await library.api.getLibraryFollows({autoRefresh:true, offset:0, limit:0}, {suppressProfileLogin:true});
        if (current && epoch === state.revision) favoriteCount.value = Number(result.unseenCount) || 0;
    } catch (failure) {
        if (current && profileLoginError(failure)) favoriteCount.value = null;
    }
}, {immediate:true});
onDeactivated(() => {invalidateRequest(); queued = false;});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.library-books {scrollbar-gutter: stable;}
.books-heading {display: flex; align-items: center; justify-content: space-between; gap: 16px;}
.books-heading h1 {overflow: hidden; white-space: nowrap; text-overflow: ellipsis;}
.books-heading .q-btn {flex-shrink: 0;}
.books-lists {display: flex; gap: 10px; overflow-x: scroll; overflow-y: hidden; scrollbar-width: thin; padding: 2px 2px 16px; margin-bottom: 18px;}
.books-lists a {flex: 0 0 auto; border: 1px solid var(--app-border); border-radius: 12px; padding: 10px 16px; text-decoration: none; color: var(--app-muted); white-space: nowrap; font-size: 13px;}
.books-lists a.is-active {background: var(--app-surface-2); color: var(--app-primary); border-color: transparent;}
.books-lists span {margin-left: 6px; font-size: 11px; opacity: .8;}
.books-filters {display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-bottom: 28px;}
.books-tabs {display: flex; gap: 6px;}
.books-tabs button {border: 0; border-radius: 12px; padding: 11px 16px; color: var(--app-muted); background: transparent; font: inherit; font-size: 13px; cursor: pointer;}
.books-tabs button.is-active {background: var(--app-surface-2); color: var(--app-primary);}
.books-tabs span {margin-left: 8px; font-size: 11px;}
.books-count {display: inline-block; min-width: 3ch; text-align: end; font-variant-numeric: tabular-nums;}
.books-lists .books-count span {margin-left: 0;}
.books-search {flex: 1; min-width: 220px; max-width: 360px;}
.books-results {min-height: 260px;}
.books-grid {display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 28px 24px;}
.books-grid :deep(.book-cover) {max-height: 230px;}
.books-placeholder {aspect-ratio: 2 / 3; max-height: 230px; border-radius: 9px; background: var(--app-surface-3);}
@media (max-width: 599px) {.books-heading .q-btn {font-size: 12px; padding-left: 0;} .books-tabs button {padding: 10px;} .books-search {max-width: none;} .books-grid {gap: 24px 18px; grid-template-columns: repeat(3, minmax(0, 1fr));}}
@media (max-width: 359px) {.books-grid {grid-template-columns: repeat(2, minmax(0, 1fr));} .books-placeholder:nth-child(3) {display: none;}}
</style>
