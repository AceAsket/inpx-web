<template>
    <main class="library-page catalog-page" :aria-busy="loading">
        <nav class="catalog-breadcrumbs" aria-label="Путь в каталоге">
            <RouterLink :to="catalogTarget('/books', {}, route.query)">
                Каталог
            </RouterLink><template v-if="details?.book?.series">
                <q-icon name="la la-angle-right" /><RouterLink :to="catalogTarget('/series-details', {name:details.book.series}, route.query)">
                    {{ details.book.series }}
                </RouterLink>
            </template>
        </nav>
        <div v-if="loading && !details" class="catalog-page__loading" role="status">
            <q-spinner size="26px" /> Загружаем книгу…
        </div>
        <LibraryNotice v-if="error" error title="Не удалось открыть книгу" :message="error" action-label="Повторить" @action="load" />
        <template v-if="details">
            <BookActionsDialog :key="uid" :model-value="true" :book="details.book" :genre-map="genres" embedded @navigate="navigate" @list-event="event => event.action === 'manageReadingLists' && library.openLists(event.book)" @updated="load" />
            <section class="catalog-book-details">
                <h2>Описание и сведения</h2><BookInfoDialog :key="uid" :model-value="true" :book-info="details" :genre-map="genres" embedded hide-summary @navigate="navigate" @updated="load" />
            </section>
            <section v-if="related.length">
                <h2>Другие книги серии</h2><div class="catalog-book-grid">
                    <BookTile v-for="book in related" :key="book._uid" :book="book" />
                </div>
            </section>
        </template>
    </main>
</template>
<script setup>
import {computed, ref, watch, onBeforeUnmount, onDeactivated} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {useLibraryPage} from './useLibraryPage';
import {catalogScope, catalogTarget} from './catalogSearchModel';
import BookActionsDialog from './BookActionsDialog.vue';
import BookInfoDialog from '../Search/BookInfoDialog/BookInfoDialog.vue';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';
import './catalogPages.css';
const route = useRoute(), router = useRouter(), uid = computed(() => String(route.query.bookUid || ''));
const details = ref(null), related = ref([]), loading = ref(false), error = ref('');
const {library, active} = useLibraryPage('Книга', load);
const genres = library.genreMap;
let request = 0, dataKey = '', relatedKey = '';
async function load() {
    if (route.path !== '/book') return;
    const id = ++request, revision = library.state.revision, bookUid = uid.value, filters = catalogScope(route.query);
    const path = route.fullPath;
    const current = () => id === request && revision === library.state.revision && route.fullPath === path;
    const key = JSON.stringify([revision,bookUid]), relatedScope = JSON.stringify([key,filters]);
    if (key !== dataKey) details.value = null;
    if (relatedScope !== relatedKey) related.value = [];
    dataKey = key;
    relatedKey = relatedScope;
    error.value = '';
    loading.value = true;
    if (!bookUid) {error.value = 'В ссылке не указан идентификатор книги.'; loading.value = false; return;}
    library.ensureGenres().catch(() => {});
    try {
        const result = await library.api.getBookCard(bookUid);
        if (!current()) return;
        const previous = details.value?.book, book = result.bookInfo.book;
        if (previous?.series !== book.series) related.value = [];
        details.value = library.config.value.profileAuthorized && previous?._readerProgress
            ? {...result.bookInfo,book:{...book,_readerProgress:previous._readerProgress}} : result.bookInfo;
        document.title = `${book.title} · INPX Web`;
        loading.value = false;
        await Promise.allSettled([
            ...(library.config.value.profileAuthorized ? [library.api.getReaderState(bookUid, {suppressProfileLogin: true}).then(state => {
                if (!current()) return;
                const updated = {...book};
                if (state.progress?.updatedAt) updated._readerProgress = state.progress;
                else delete updated._readerProgress;
                details.value = {...details.value, book:updated};
            })] : []),
            ...(book.series ? [library.api.catalogEntity({kind:'series',name:book.series,limit:12,filters}).then(series => {
                if (current()) related.value = series.books.filter(book => book._uid !== bookUid);
            })] : []),
        ]);
    } catch (e) {if (current()) error.value = e.message;}
    finally {if (current()) loading.value = false;}
}
async function navigate({type, value}) {
    if (type === 'genreName' && value) {
        try {await library.ensureGenres();} catch {return;}
        const name = String(value).trim().toLowerCase();
        value = Array.from(genres.value).find(([code, label]) => code.toLowerCase() === name || label.trim().toLowerCase() === name)?.[0]
            || (/^[a-z0-9_-]+$/.test(name) ? name : '');
        type = 'genre';
    }
    if (!value) return;
    if (type === 'author' || type === 'series') router.push(catalogTarget(type === 'author' ? '/author-details' : '/series-details', {name:value}, route.query));
    else router.push(catalogTarget('/books', {[type === 'keyword' ? 'keywords' : type]: type === 'genre' ? value : '*' + value}, route.query));
}
watch(() => route.fullPath, () => {if (active.value && route.path === '/book') load();});
onDeactivated(() => {request++;}); onBeforeUnmount(() => {request++;});
</script>
