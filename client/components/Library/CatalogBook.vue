<template>
    <main class="library-page catalog-page">
        <nav class="catalog-breadcrumbs" aria-label="Путь в каталоге">
            <RouterLink to="/books">
                Каталог
            </RouterLink><template v-if="details?.book?.series">
                <q-icon name="la la-angle-right" /><RouterLink :to="{path: '/series-details', query: {name: details.book.series}}">
                    {{ details.book.series }}
                </RouterLink>
            </template>
        </nav>
        <div v-if="loading" class="catalog-page__loading" role="status">
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
import {genreMapFromTree} from './libraryModel';
import BookActionsDialog from './BookActionsDialog.vue';
import BookInfoDialog from '../Search/BookInfoDialog/BookInfoDialog.vue';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';
import './catalogPages.css';
const route = useRoute(), router = useRouter(), uid = computed(() => String(route.query.bookUid || ''));
const details = ref(null), genres = ref(new Map()), related = ref([]), loading = ref(false), error = ref('');
const {library, active} = useLibraryPage('Книга', load);
let request = 0;
async function load() {
    if (route.path !== '/book') return;
    const id = ++request; details.value = null; related.value = []; error.value = ''; loading.value = true;
    const bookUid = uid.value;
    if (!bookUid) {error.value = 'В ссылке не указан идентификатор книги.'; loading.value = false; return;}
    try {
        const result = await library.api.getBookCard(bookUid);
        if (id !== request || route.path !== '/book' || uid.value !== bookUid) return;
        details.value = result.bookInfo; document.title = `${details.value.book.title} · INPX Web`;
        const book = details.value.book;
        loading.value = false;
        await Promise.allSettled([
            library.api.getGenreTree().then(tree => {if (id === request) genres.value = genreMapFromTree(tree.genreTree || []);}),
            ...(library.config.value.profileAuthorized ? [library.api.getReaderState(bookUid, {suppressProfileLogin: true}).then(state => {
                if (id === request && state.progress?.updatedAt) details.value = {...details.value, book: {...book, _readerProgress: state.progress}};
            })] : []),
            ...(book.series ? [library.api.catalogEntity({kind: 'series', name: book.series, limit: 12}).then(series => {
                if (id === request) related.value = series.books.filter(book => book._uid !== bookUid);
            })] : []),
        ]);
    } catch (e) {if (id === request) error.value = e.message;}
    finally {if (id === request) loading.value = false;}
}
function navigate({type, value}) {
    if (type === 'author' || type === 'series') router.push({path: type === 'author' ? '/author-details' : '/series-details', query: {name: value}});
    else router.push({path: '/books', query: {[type === 'keyword' ? 'keywords' : type]: type === 'genre' ? value : '*' + value}});
}
watch(() => route.fullPath, () => {if (active.value && route.path === '/book') load();});
onDeactivated(() => {request++;}); onBeforeUnmount(() => {request++;});
</script>
