<template>
    <div class="library-page">
        <div class="library-page__body">
            <div class="books-heading"><h1>{{ selectedList?.name || 'Мои книги' }}</h1><q-btn flat no-caps icon="la la-bookmark" label="Управление полками" @click="library.openLists()" /></div>
            <p class="library-page__subtitle">{{ selectedList ? 'Книги на вашей полке' : 'Продолжайте читать и возвращайтесь к любимым историям' }}</p>
            <LibraryNotice v-if="state.locked || state.readingLoginRequired" title="Войдите в свой профиль" message="История чтения и личные полки появятся после входа." action-label="Войти в профиль" @action="library.login" />
            <template v-else>
                <div v-if="state.lists.length" class="books-lists" aria-label="Мои полки">
                    <RouterLink to="/my-books" :class="{'is-active': !listId}">История чтения</RouterLink>
                    <RouterLink v-for="list in state.lists" :key="list.id" :to="{path: '/my-books', query: {list: list.id}}" :class="{'is-active': listId === list.id}">{{ list.name }} <span>{{ list.bookCount }}</span></RouterLink>
                </div>
                <div v-if="!listId" class="books-filters">
                    <div class="books-tabs" aria-label="Состояние чтения">
                        <button v-for="tab in tabs" :key="tab.id" type="button" :aria-pressed="filter === tab.id" :class="{'is-active': filter === tab.id}" @click="filter = tab.id">{{ tab.label }}<span v-if="state.reading?.counters">{{ state.reading.counters[tab.id] || 0 }}</span></button>
                    </div>
                    <q-input v-model="query" outlined dense clearable label="Найти среди моих книг" class="books-search"><template #prepend><q-icon name="la la-search" /></template></q-input>
                </div>
                <LibraryNotice v-if="error" error title="Не удалось загрузить книги" message="Проверьте подключение и попробуйте ещё раз." action-label="Повторить" :busy="loading" @action="load" />
                <div v-if="loading" class="library-notice" role="status"><q-spinner size="20px" /> Загружаем книги…</div>
                <div v-if="items.length" class="books-grid" :aria-busy="loading">
                    <BookTile v-for="book in items" :key="bookUid(book)" :book="book" />
                </div>
                <div v-else-if="!loading && !error" class="library-empty"><q-icon name="la la-book-open" size="32px" /><h2>{{ query ? 'Книги не найдены' : 'Здесь пока нет книг' }}</h2><p>{{ query ? 'Попробуйте другое название или имя автора.' : 'Открытые книги появятся в истории. Сохраняйте понравившиеся книги на свои полки.' }}</p><q-btn unelevated no-caps color="primary" label="Открыть каталог" to="/books" /></div>
                <p v-if="count > items.length" class="library-page__subtitle">Показано {{ items.length }} из {{ count }}. Уточните поиск, чтобы найти нужную книгу.</p>
            </template>
        </div>
    </div>
</template>

<script setup>
import {ref, computed, watch, onBeforeUnmount, onDeactivated} from 'vue';
import {useRoute} from 'vue-router';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';
import {bookUid, profileLoginError} from './libraryModel';
import {useLibraryPage} from './useLibraryPage';

const {library, active} = useLibraryPage('Мои книги', async() => {await library.repository.loadReading(true); if (active.value) load();});
const {state} = library;
const route = useRoute(), filter = ref('reading'), query = ref(''), items = ref([]), count = ref(0), error = ref(''), loading = ref(false);
const listId = computed(() => route.path === '/my-books' ? String(route.query.list || '') : '');
const selectedList = computed(() => state.lists.find(list => list.id === listId.value));
const tabs = [{id: 'reading', label: 'Читаю'}, {id: 'read', label: 'Прочитано'}, {id: 'all', label: 'Все'}];
let sequence = 0, timer, running = false, queued = false;
function schedule() {
    sequence++;
    clearTimeout(timer);
    if (active.value) timer = setTimeout(load, 500);
}
async function load() {
    if (!active.value || state.locked || state.readingLoginRequired) return;
    queued = true;
    sequence++;
    if (running) return;
    running = true;
    loading.value = true;
    try {
        while (queued && active.value) {
            queued = false;
            const request = sequence, epoch = state.revision, list = listId.value;
            error.value = '';
            try {
                const response = list ? await library.api.getReadingList(list, {suppressProfileLogin: true})
                    : await library.api.getUserReadingLibrary({state: filter.value, query: query.value || '', sort: 'updatedDesc', limit: 100}, {suppressProfileLogin: true});
                if (!active.value || request !== sequence || epoch !== state.revision) continue;
                items.value = (list ? response.books || [] : response.items || []).filter(book => bookUid(book) && !book.hidden);
                count.value = Number(list ? response.list?.bookCount : response.count) || items.value.length;
            } catch (failure) {
                if (active.value && request === sequence && epoch === state.revision) {
                    items.value = [];
                    if (profileLoginError(failure)) library.repository.requireLogin('reading');
                    else error.value = failure.message || 'Не удалось загрузить книги';
                }
            }
        }
    } finally {running = false; loading.value = false;}
}
watch([filter, query], schedule);
watch(listId, () => {items.value = []; if (active.value) load();});
watch(() => state.revision, () => {items.value = []; error.value = ''; sequence++;});
onDeactivated(() => {sequence++; queued = false; clearTimeout(timer);});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.books-heading {display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;}
.books-lists {display: flex; gap: 10px; overflow: auto; padding: 2px 2px 16px; margin-bottom: 18px;}
.books-lists a {border: 1px solid var(--app-border); border-radius: 12px; padding: 10px 16px; text-decoration: none; color: var(--app-muted); white-space: nowrap; font-size: 13px;}
.books-lists a.is-active {background: var(--app-surface-2); color: var(--app-primary); border-color: transparent;}
.books-lists span {margin-left: 6px; font-size: 11px; opacity: .8;}
.books-filters {display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-bottom: 28px;}
.books-tabs {display: flex; gap: 6px;}
.books-tabs button {border: 0; border-radius: 12px; padding: 11px 16px; color: var(--app-muted); background: transparent; font: inherit; font-size: 13px; cursor: pointer;}
.books-tabs button.is-active {background: var(--app-surface-2); color: var(--app-primary);}
.books-tabs span {margin-left: 8px; font-size: 11px;}
.books-search {flex: 1; min-width: 220px; max-width: 360px;}
.books-grid {display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 28px 24px;}
.books-grid :deep(.book-cover) {max-height: 230px;}
@media (max-width: 599px) {.books-heading .q-btn {font-size: 12px; padding-left: 0;} .books-tabs button {padding: 10px;} .books-search {max-width: none;} .books-grid {gap: 24px 18px; grid-template-columns: repeat(3, minmax(0, 1fr));}}
@media (max-width: 359px) {.books-grid {grid-template-columns: repeat(2, minmax(0, 1fr));}}
</style>
