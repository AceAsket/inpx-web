<template>
    <main class="library-page catalog-page">
        <nav class="catalog-breadcrumbs" aria-label="Путь в каталоге">
            <RouterLink to="/books">
                Каталог
            </RouterLink><q-icon name="la la-angle-right" /><RouterLink :to="kind === 'author' ? '/authors' : '/series-index'">
                {{ kind === 'author' ? 'Авторы' : 'Серии' }}
            </RouterLink>
        </nav>
        <LibraryNotice v-if="error" error title="Не удалось загрузить страницу" :message="error" action-label="Повторить" @action="load" />
        <section class="catalog-entity-heading">
            <span class="catalog-page__muted">{{ kind === 'author' ? 'Автор' : 'Серия' }}</span><h1>{{ name }}</h1>
            <template v-if="data">
                <p class="catalog-page__muted">
                    Книг: {{ data.total }}<span v-if="data.read !== null"> · Прочитано {{ data.read }} из {{ data.total }}</span>
                </p>
                <q-linear-progress v-if="kind === 'series' && data.read !== null && data.total" :value="data.read / data.total" rounded color="primary" class="q-mb-md" />
                <div class="catalog-page__actions">
                    <q-btn v-if="data.next && canRead(data.next)" no-caps unelevated color="primary" icon="la la-book-open" :label="data.read ? (kind === 'series' ? 'Продолжить серию' : 'Продолжить чтение') : 'Начать читать'" @click="library.openBook(data.next)" /><q-btn v-if="library.config.value.profileAuthorized" outline no-caps icon="la la-star" :label="following ? 'В избранном' : 'Следить за новинками'" :loading="followBusy" @click="toggleFollow" /><q-btn v-if="kind === 'series' && data.total && library.config.value.profileAuthorized" outline no-caps icon="la la-check-circle" label="Отметить серию прочитанной" :loading="marking" @click="markAll" />
                </div>
            </template>
        </section>
        <div v-if="loading" class="catalog-page__loading" role="status">
            <q-spinner size="26px" /> Загружаем книги…
        </div>
        <template v-if="data">
            <nav v-if="data.series.length" class="catalog-series-links" aria-label="Серии автора">
                <RouterLink v-for="series in data.series" :key="series" :to="{path: '/series-details', query: {name: series}}">
                    {{ series }}
                </RouterLink>
            </nav>
            <p v-if="!data.total" class="library-empty">
                Книги сейчас недоступны. Возможно, состав библиотеки изменился.
            </p>
            <div class="catalog-book-grid">
                <article v-for="book in data.books" :key="book._uid">
                    <BookTile :book="book" /><div v-if="kind === 'series'" class="catalog-volume">
                        <span>{{ book.serno > 0 ? `Том ${book.serno}` : 'Без номера' }}</span><button v-if="book.serno > 0 && library.config.value.profileAuthorized" type="button" :disabled="marking" @click="markUntil(book)">
                            Прочитано до этого тома
                        </button>
                    </div>
                </article>
            </div>
            <q-pagination v-if="data.pageCount > 1" :model-value="data.page" :max="data.pageCount" :max-pages="7" boundary-numbers direction-links class="catalog-page__pagination" aria-label="Страницы книг" @update:model-value="page => router.push({path: route.path, query: {...route.query, page}})" />
        </template>
    </main>
</template>
<script setup>
import {computed, ref, watch, onBeforeUnmount, onDeactivated, getCurrentInstance} from 'vue';
import {QPagination} from 'quasar';
import {useRoute, useRouter} from 'vue-router';
import {useLibraryPage} from './useLibraryPage';
import {readable} from './libraryModel';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';
import './catalogPages.css';
const route = useRoute(), router = useRouter(), root = getCurrentInstance().proxy.$root;
const data = ref(null), loading = ref(false), error = ref(''), following = ref(null), followBusy = ref(false), marking = ref(false);
const kind = computed(() => route.path === '/author-details' ? 'author' : 'series'), name = computed(() => String(route.query.name || ''));
const {library, active} = useLibraryPage('Каталог', load);
let request = 0;
const canRead = book => readable(book, library.config.value);
async function load() {
    const id = ++request; loading.value = true; error.value = ''; data.value = null; following.value = null;
    document.title = `${name.value} · INPX Web`;
    try {
        const result = await library.api.catalogEntity({kind: kind.value, name: name.value, page: Number(route.query.page) || 1, filters: {lang: String(route.query.lang || ''), sourceId: String(route.query.sourceId || '')}});
        if (id !== request) return; data.value = result;
        if (library.config.value.profileAuthorized) {
            const follows = await library.api.getLibraryFollows({refresh: false});
            if (id === request) following.value = follows.follows.find(row => row.kind === kind.value && row.value.toLowerCase() === name.value.toLowerCase()) || null;
        }
    } catch (e) {if (id === request) error.value = e.message;}
    finally {if (id === request) loading.value = false;}
}
async function toggleFollow() {
    if (followBusy.value) return; followBusy.value = true;
    try {await library.api.changeLibraryFollow(following.value ? 'remove' : 'add', following.value ? {id: following.value.id} : {kind: kind.value, value: name.value}); await load();}
    catch (e) {root.stdDialog.alert(e.message, 'Избранное');} finally {followBusy.value = false;}
}
async function markAll() {
    if (marking.value || !await root.stdDialog.confirm(`Отметить все книги серии «${name.value}» прочитанными?`, 'Прочитанность серии')) return;
    marking.value = true;
    try {await library.api.markSeriesRead(name.value, true); await load(); library.repository.loadReading(true);}
    catch (e) {root.stdDialog.alert(e.message, 'Прочитанность серии');} finally {marking.value = false;}
}
async function markUntil(book) {
    if (marking.value || !await root.stdDialog.confirm(`Отметить прочитанными тома до №${book.serno} включительно?`, 'Прочитанность серии')) return;
    marking.value = true;
    try {await library.api.markSeriesUntil({name: name.value, bookUid: book._uid}); await load(); library.repository.loadReading(true);}
    catch (e) {root.stdDialog.alert(e.message, 'Прочитанность серии');} finally {marking.value = false;}
}
watch(() => route.fullPath, () => {if (active.value && ['/author-details', '/series-details'].includes(route.path)) load();});
onDeactivated(() => {request++;}); onBeforeUnmount(() => {request++;});
</script>
