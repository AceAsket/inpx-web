<template>
    <div class="library-page library-overview">
        <div class="library-page__body">
            <form class="overview-search" role="search" aria-label="Поиск в библиотеке" @submit.prevent="search">
                <q-icon name="la la-search" size="26px" aria-hidden="true" />
                <input v-model="query" type="search" maxlength="1000" placeholder="Найти книгу в библиотеке" aria-label="Название книги" role="combobox" aria-autocomplete="list"
                    :aria-controls="suggestionListId" :aria-expanded="suggestionsExpanded" :aria-activedescendant="activeSuggestionId"
                    @focus="searchFocused = true" @click="searchFocused = true" @input="searchFocused = true" @blur="searchFocused = false" @keydown="completion?.keydown($event)" />
                <button v-if="query.trim()" type="submit" class="overview-search__submit" aria-label="Найти книгу"><q-icon name="la la-arrow-right" size="22px" /></button>
                <RouterLink :to="catalogTarget('/books', {}, searchFilters)" class="overview-search__filters" aria-label="Открыть каталог и фильтры"><q-icon name="la la-sliders-h" size="24px" /></RouterLink>
                <CatalogSuggestions ref="completion" :list-id="suggestionListId" :query="query" kind="title" :filters="searchFilters" :context="suggestionContext"
                    :focused="searchFocused && active" @choose="chooseSuggestion" @search="search" @dismiss="searchFocused = false" @active="activeSuggestionId = $event" @expanded="suggestionsExpanded = $event" />
            </form>

            <LibraryNotice v-if="state.locked || state.readingLoginRequired" title="Войдите в свой профиль" message="История чтения, сохранённое место и личные полки появятся после входа." action-label="Войти в профиль" @action="library.login" />
            <template v-if="!state.locked">
                <LibraryNotice v-if="state.readingError" error title="Не удалось обновить историю" message="Проверьте подключение и попробуйте ещё раз." action-label="Повторить" :busy="state.readingLoading" @action="repository.loadReading(true)" />
                <div v-if="!state.readingLoginRequired" class="overview-reading" :class="{'overview-reading--paired': books.current && books.recent.length}">
                    <section v-if="books.current" class="current-book" aria-labelledby="current-book-heading">
                        <div class="current-book__caption">
                            <q-icon name="la la-book-open" size="21px" aria-hidden="true" />
                            <h1 id="current-book-heading">Сейчас читаю</h1>
                            <button type="button" :aria-label="`Действия с книгой: ${books.current.title}`" @click="library.openActions(books.current)"><q-icon name="la la-ellipsis-v" size="23px" /></button>
                        </div>
                        <div class="current-book__body">
                            <button type="button" class="current-book__cover" :aria-label="`Открыть карточку: ${books.current.title}`" @click="library.openCard(books.current)"><BookCover :book="books.current" /></button>
                            <div class="current-book__info">
                                <button type="button" class="current-book__title" @click="library.openCard(books.current)">{{ books.current.title }}</button>
                                <div class="current-book__author">{{ books.current.author || 'Автор не указан' }}</div>
                                <div v-if="books.current.series" class="current-book__series">{{ books.current.series }}<span v-if="books.current.serno"> · {{ books.current.serno }}</span></div>
                                <div v-if="currentGenres.length" class="current-book__genres" :title="currentGenres.join(', ')">Жанр: {{ currentGenres.join(', ') }}</div>
                                <div v-if="currentYear" class="current-book__year">Год: {{ currentYear }}</div>
                            </div>
                        </div>
                        <div class="current-book__footer">
                            <div class="current-book__progress">
                                <span>{{ Math.round((progress(books.current) || 0) * 100) }}% прочитано</span>
                                <progress :value="progress(books.current) || 0" max="1" aria-label="Прогресс чтения" />
                            </div>
                            <q-btn unelevated no-caps color="primary" :label="readable(books.current, config) ? 'Читать' : 'Открыть'" @click="library.openBook(books.current)" />
                        </div>
                    </section>
                    <div v-else-if="state.readingLoading && !state.readingLoaded" class="overview-skeleton overview-skeleton--hero" role="status" aria-label="Загружаем историю чтения" />
                    <section v-else-if="state.readingLoaded" class="library-empty overview-welcome">
                        <q-icon name="la la-book-open" size="32px" />
                        <h2>{{ books.recent.length ? 'Выберите следующую книгу' : 'Ваша следующая история — здесь' }}</h2>
                        <p>{{ books.recent.length ? 'Вернитесь к недавним книгам или найдите что-нибудь новое в каталоге.' : 'Откройте книгу из каталога. Мы сохраним место, и вы сможете продолжить чтение с главной.' }}</p>
                        <q-btn unelevated no-caps color="primary" label="Открыть каталог" to="/books" />
                    </section>
                    <BookShelf v-if="books.recent.length" title="Недавно читали" :books="books.recent" heading-id="recent-books-heading">
                        <template #action><RouterLink to="/my-books" class="overview-text-link">Все</RouterLink></template>
                    </BookShelf>
                </div>

                <LibraryNotice v-if="state.shelvesLoginRequired && !state.readingLoginRequired" title="Подборки доступны после входа" message="Войдите в профиль, чтобы увидеть свои рекомендации." action-label="Войти в профиль" @action="library.login" />
                <LibraryNotice v-if="state.shelvesError" error title="Не удалось обновить подборки" message="Проверьте подключение и попробуйте ещё раз." action-label="Повторить" :busy="state.shelvesLoading" @action="repository.loadShelves(true)" />
                <div v-if="state.shelvesLoading && !state.shelvesLoaded" class="overview-loading" role="status" aria-label="Загружаем подборки">
                    <span>Собираем полки вашей библиотеки</span>
                    <div class="overview-loading__covers"><div v-for="i in 6" :key="i" class="overview-skeleton" /></div>
                </div>
                <div class="overview-shelves">
                    <BookShelf v-if="state.recommendations.length" title="Рекомендуем вам" :books="recommendations" heading-id="recommended-books-heading">
                        <template #action><RouterLink to="/for-you" class="overview-text-link">Все</RouterLink></template>
                    </BookShelf>
                    <BookShelf v-for="shelf in shelves" :key="shelf.id" :title="shelf.title" :books="shelf.books" :heading-id="`shelf-${shelf.id}`" />
                </div>
                <div class="overview-footer">
                    <RouterLink to="/books">Весь каталог <q-icon name="la la-arrow-right" /></RouterLink>
                    <q-btn flat dense no-caps icon="la la-sync" label="Обновить" :loading="state.readingLoading || state.shelvesLoading" @click="refresh" />
                </div>
            </template>
        </div>
    </div>
</template>

<script setup>
import {computed, ref, watch, getCurrentInstance} from 'vue';
import {useRouter} from 'vue-router';
import BookCover from './BookCover.vue';
import BookShelf from './BookShelf.vue';
import LibraryNotice from './LibraryNotice.vue';
import CatalogSuggestions from './CatalogSuggestions.vue';
import {homeBooks, progress, readable, bookUid} from './libraryModel';
import {useLibraryPage} from './useLibraryPage';
import {catalogTarget, effectiveCatalogScope} from './catalogSearchModel';
import previewMetadata from '../../../shared/BookPreview';

const {library, active} = useLibraryPage('Обзор', value => value.repository.loadHome({freshReading: true}));
const {state, repository, config, settings} = library;
const router = useRouter(), query = ref('');
const completion = ref(null), searchFocused = ref(false), suggestionsExpanded = ref(false), activeSuggestionId = ref();
const suggestionListId = `overview-suggestions-${getCurrentInstance().uid}`;
const searchFilters = computed(() => effectiveCatalogScope({}, settings.value, config.value));
const suggestionContext = computed(() => String(state.revision));
watch(() => [active.value, state.revision], () => {searchFocused.value = false; activeSuggestionId.value = undefined; suggestionsExpanded.value = false;});
const books = computed(() => homeBooks(state.reading?.items || []));
const currentDetails = ref({});
const currentGenres = computed(() => previewMetadata.tokens(books.value.current?.genre || currentDetails.value.genres)
    .map(code => library.genreMap.value.get(code) || code));
const currentYear = computed(() => previewMetadata.year(books.value.current?.publishedYear)
    || previewMetadata.year(books.value.current?.year) || previewMetadata.year(currentDetails.value.publishedYear));
watch([active, () => state.revision, () => bookUid(books.value.current || {})], async([enabled, revision, uid], previous, cleanup) => {
    currentDetails.value = {};
    if (!enabled || !uid) return;
    library.ensureGenres().catch(() => {});
    if (currentYear.value && previewMetadata.tokens(books.value.current.genre).length) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    try {
        // Only the current book needs a bounded prefix read; the rest of the
        // reading history remains an index-only query.
        const response = await library.api.getBookPreview(uid, {signal:controller.signal});
        if (!controller.signal.aborted && response?.bookPreview?.bookUid === uid)
            currentDetails.value = {publishedYear:previewMetadata.year(response.bookPreview.publishedYear), genres:previewMetadata.tokens(response.bookPreview.genres)};
    } catch (_) { /* Optional metadata must not block the reading card. */ }
}, {immediate:true});
const recommendations = computed(() => {
    const reading = new Map((state.reading?.items || []).map(book => [bookUid(book),book]));
    return state.recommendations.map(book => {
        const item = reading.get(bookUid(book));
        return item ? {...book,percent:item.percent} : book;
    });
});
const shelves = computed(() => {
    const reading = new Map((state.reading?.items || []).map(book => [bookUid(book), book]));
    const flags = {'newest': 'showDiscoveryNewest', 'popular': 'showDiscoveryPopular', 'from-your-lists': 'showDiscoveryFromLists',
        'unfinished-series': 'showDiscoveryUnfinishedSeries', 'external': 'showDiscoveryExternal', 'similar': 'showDiscoverySimilar'};
    return state.shelves.filter(shelf => shelf.id !== 'continue-reading' && shelf.books?.length
        && settings.value[flags[shelf.mode] || flags[shelf.id]] !== false)
        .map((shelf, index) => ({...shelf, id: shelf.id || `discovery-${index}`, books: shelf.books.map(book => {
            const item = reading.get(bookUid(book));
            return item ? {...book, percent: item.percent} : book;
        })})).slice(0, 4);
});
function search() {
    searchFocused.value = false;
    router.push(catalogTarget('/books', query.value.trim() ? {title: `*${query.value.trim()}`} : {}, searchFilters.value));
}
function chooseSuggestion(item) {
    if (item.kind === 'title' && item.book) library.openCard(item.book);
    else if (item.kind === 'correction' && item.targetKind === 'title') {query.value = item.name; search();}
}
function refresh() {repository.loadHome({freshReading: true, freshShelves: true});}
</script>

<style scoped>
.overview-search {display: flex; align-items: center; gap: 14px; max-width: 960px; margin-bottom: 24px; padding: 0 17px; height: 54px; border-radius: 16px; background: var(--app-surface); color: var(--app-primary);}
.overview-search:focus-within {box-shadow: 0 0 0 2px var(--app-primary);}
input {min-width: 0; flex: 1; background: transparent; color: var(--app-text); border: 0; outline: 0; font: inherit; font-size: 15px;}
input::placeholder {color: var(--app-muted); opacity: 1;}
.overview-search__filters, .overview-search__submit {color: var(--app-muted); border: 0; background: transparent; display: grid; place-items: center; width: 32px; height: 42px; border-radius: 8px; cursor: pointer; flex-shrink: 0;}
.overview-reading {min-width: 0;}
.current-book {display: flex; flex-direction: column; max-width: 440px; border-radius: 20px; padding: 20px; background: var(--library-hero);}
.current-book__caption {display: flex; align-items: center; gap: 9px; color: var(--library-on-hero); margin-bottom: 16px;}
.current-book__caption h1 {font-size: 14px; font-weight: 550; letter-spacing: 0; flex: 1;}
.current-book__caption button {border: 0; color: var(--library-on-hero); background: transparent; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; margin: -4px -7px -4px 0;}
.current-book__body {display: flex; align-items: flex-start; gap: 18px;}
.current-book__cover {width: 86px; flex: 0 0 86px; padding: 0; border: 0; background: transparent; border-radius: 9px; cursor: pointer;}
.current-book__info {min-width: 0;}
.current-book__title {display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; padding: 0; background: transparent; color: var(--app-text); border: 0; text-align: left; font: inherit; font-weight: 550; font-size: 19px; line-height: 1.4; cursor: pointer; overflow-wrap: anywhere;}
.current-book__author {color: var(--app-muted); margin-top: 6px; font-size: 14px; line-height: 1.5;}
.current-book__series {color: var(--app-muted); font-size: 12px; margin-top: 4px; line-height: 1.5;}
.current-book__genres, .current-book__year {color: var(--app-muted); font-size: 12px; margin-top: 6px; line-height: 1.5;}
.current-book__genres {display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;}
.current-book__footer {display: flex; align-items: flex-end; gap: 20px; margin-top: auto; padding-top: 16px;}
.current-book__progress {flex: 1; min-width: 0; font-size: 12px; color: var(--app-muted); padding-bottom: 5px;}
progress {display: block; margin-top: 7px; width: 100%; height: 4px; border: 0; border-radius: 0; appearance: none; background: var(--app-border); color: var(--app-primary);}
progress::-webkit-progress-bar {background: var(--app-border);} progress::-webkit-progress-value {background: var(--app-primary);} progress::-moz-progress-bar {background: var(--app-primary);}
.current-book__footer .q-btn {padding: 11px 20px; border-radius: 13px; font-size: 14px; font-weight: 550; min-height: 44px;}
.overview-text-link {font-size: 13px; color: var(--app-primary); text-decoration: none; padding: 4px;}
.overview-welcome {max-width: 690px;}
.overview-footer {display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 32px; padding-top: 14px; border-top: 1px solid var(--app-border); color: var(--app-muted);}
.overview-footer > a {color: var(--app-primary); font-size: 14px; text-decoration: none;}
.overview-loading {color: var(--app-muted); margin-top: 32px; font-size: 14px;}
.overview-shelves {display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px 36px; margin-top: 28px;}
.overview-shelves :deep(.book-shelf) {margin-top: 0;}
.overview-loading__covers {display: grid; grid-template-columns: repeat(6, minmax(0, 130px)); gap: 24px; margin-top: 16px; overflow: hidden;}
.overview-skeleton {aspect-ratio: 2 / 3; background: var(--app-surface-3); border-radius: 10px;}
.overview-skeleton--hero {aspect-ratio: auto; height: 295px; max-width: 460px; border-radius: 22px;}
@media (min-width: 1100px) {.overview-reading--paired {display: grid; grid-template-columns: minmax(320px, 440px) minmax(0, 960px); align-items: stretch; gap: 38px;} .overview-reading--paired > :deep(.book-shelf) {margin-top: 0;}}
@media (max-width: 599px) {.overview-search {height: 54px; gap: 10px; margin-bottom: 24px; padding: 0 12px;} input {font-size: 14px;} .current-book {padding: 18px; max-width: none;} .current-book__body {gap: 15px;} .current-book__cover {width: 76px; flex-basis: 76px;} .current-book__title {font-size: 18px;} .current-book__caption {margin-bottom: 22px;} .current-book__footer {padding-top: 22px;} .overview-loading__covers {grid-template-columns: repeat(6, 112px); gap: 20px;}}
</style>
