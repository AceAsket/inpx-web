<template>
    <div class="library-page library-overview">
        <div class="library-page__body">
            <form class="overview-search" role="search" aria-label="Поиск в библиотеке" @submit.prevent="search">
                <q-icon name="la la-search" size="26px" aria-hidden="true" />
                <input v-model="query" type="search" maxlength="1000" placeholder="Найти книгу в библиотеке" aria-label="Название книги" />
                <button v-if="query.trim()" type="submit" class="overview-search__submit" aria-label="Найти книгу"><q-icon name="la la-arrow-right" size="22px" /></button>
                <RouterLink to="/books" class="overview-search__filters" aria-label="Открыть каталог и фильтры"><q-icon name="la la-sliders-h" size="24px" /></RouterLink>
            </form>

            <div v-if="state.locked" class="library-empty">
                <q-icon name="la la-user-lock" size="32px" />
                <h2>Войдите в свой профиль</h2>
                <p>Ваши книги, место чтения и личные подборки появятся здесь после входа.</p>
                <q-btn unelevated no-caps color="primary" label="Войти в профиль" @click="library.login" />
            </div>
            <template v-else>
                <div v-if="state.readingError" class="library-notice" role="alert">
                    <q-icon name="la la-exclamation-circle" size="20px" />
                    <span>Не удалось обновить историю. {{ state.readingError }}</span>
                    <q-btn flat dense no-caps label="Повторить" @click="repository.loadReading(true)" />
                </div>
                <div class="overview-reading" :class="{'overview-reading--paired': books.current && books.recent.length}">
                    <section v-if="books.current" class="current-book" aria-labelledby="current-book-heading">
                        <div class="current-book__caption">
                            <q-icon name="la la-book-open" size="21px" aria-hidden="true" />
                            <h1 id="current-book-heading">Сейчас читаю</h1>
                            <button type="button" :aria-label="`Действия с книгой: ${books.current.title}`" @click="library.openActions(books.current)"><q-icon name="la la-ellipsis-v" size="23px" /></button>
                        </div>
                        <div class="current-book__body">
                            <button type="button" class="current-book__cover" :aria-label="`Открыть: ${books.current.title}`" @click="library.openBook(books.current)"><BookCover :book="books.current" /></button>
                            <div class="current-book__info">
                                <button type="button" class="current-book__title" @click="library.openBook(books.current)">{{ books.current.title }}</button>
                                <div class="current-book__author">{{ books.current.author || 'Автор не указан' }}</div>
                                <div v-if="books.current.series" class="current-book__series">{{ books.current.series }}<span v-if="books.current.serno"> · {{ books.current.serno }}</span></div>
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

                <div v-if="state.shelvesError" class="library-notice" role="alert">
                    <q-icon name="la la-exclamation-circle" size="20px" /><span>Не удалось обновить подборки. {{ state.shelvesError }}</span>
                    <q-btn flat dense no-caps label="Повторить" @click="repository.loadShelves(true)" />
                </div>
                <div v-if="state.shelvesLoading && !state.shelvesLoaded" class="overview-loading" role="status" aria-label="Загружаем подборки">
                    <span>Собираем полки вашей библиотеки</span>
                    <div class="overview-loading__covers"><div v-for="i in 6" :key="i" class="overview-skeleton" /></div>
                </div>
                <BookShelf v-for="shelf in shelves" :key="shelf.id" :title="shelf.title" :books="shelf.books" :heading-id="`shelf-${shelf.id}`" />
                <div class="overview-footer">
                    <RouterLink to="/books">Весь каталог <q-icon name="la la-arrow-right" /></RouterLink>
                    <q-btn flat dense no-caps icon="la la-sync" label="Обновить" :loading="state.readingLoading || state.shelvesLoading" @click="refresh" />
                </div>
            </template>
        </div>
    </div>
</template>

<script setup>
import {computed, ref} from 'vue';
import {useRouter} from 'vue-router';
import BookCover from './BookCover.vue';
import BookShelf from './BookShelf.vue';
import {homeBooks, progress, readable, bookUid} from './libraryModel';
import {useLibraryPage} from './useLibraryPage';

const {library} = useLibraryPage('Обзор', value => value.repository.loadHome({freshReading: true}));
const {state, repository, config, settings} = library;
const router = useRouter(), query = ref('');
const books = computed(() => homeBooks(state.reading?.items || []));
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
    router.push({path: '/books', query: query.value.trim() ? {title: `*${query.value.trim()}`} : {}});
}
function refresh() {repository.loadHome({freshReading: true, freshShelves: true});}
</script>

<style scoped>
.overview-search {display: flex; align-items: center; gap: 14px; max-width: 690px; margin-bottom: 28px; padding: 0 17px; height: 58px; border-radius: 18px; background: var(--app-surface); color: var(--app-primary);}
.overview-search:focus-within {box-shadow: 0 0 0 2px var(--app-primary);}
input {min-width: 0; flex: 1; background: transparent; color: var(--app-text); border: 0; outline: 0; font: inherit; font-size: 15px;}
input::placeholder {color: var(--app-muted); opacity: 1;}
.overview-search__filters, .overview-search__submit {color: var(--app-muted); border: 0; background: transparent; display: grid; place-items: center; width: 32px; height: 42px; border-radius: 8px; cursor: pointer; flex-shrink: 0;}
.overview-reading {min-width: 0;}
.current-book {max-width: 460px; border-radius: 22px; padding: 22px; background: var(--library-hero);}
.current-book__caption {display: flex; align-items: center; gap: 9px; color: var(--library-on-hero); margin-bottom: 24px;}
.current-book__caption h1 {font-size: 14px; font-weight: 550; letter-spacing: 0; flex: 1;}
.current-book__caption button {border: 0; color: var(--library-on-hero); background: transparent; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; margin: -4px -7px -4px 0;}
.current-book__body {display: flex; align-items: flex-start; gap: 18px;}
.current-book__cover {width: 86px; flex: 0 0 86px; padding: 0; border: 0; background: transparent; border-radius: 9px; cursor: pointer;}
.current-book__info {min-width: 0;}
.current-book__title {display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; padding: 0; background: transparent; color: var(--app-text); border: 0; text-align: left; font: inherit; font-weight: 550; font-size: 19px; line-height: 1.4; cursor: pointer; overflow-wrap: anywhere;}
.current-book__author {color: var(--app-muted); margin-top: 6px; font-size: 14px; line-height: 1.5;}
.current-book__series {color: var(--app-muted); font-size: 12px; margin-top: 4px; line-height: 1.5;}
.current-book__footer {display: flex; align-items: flex-end; gap: 20px; margin-top: 24px;}
.current-book__progress {flex: 1; min-width: 0; font-size: 12px; color: var(--app-muted); padding-bottom: 5px;}
progress {display: block; margin-top: 7px; width: 100%; height: 4px; border: 0; border-radius: 0; appearance: none; background: var(--app-border); color: var(--app-primary);}
progress::-webkit-progress-bar {background: var(--app-border);} progress::-webkit-progress-value {background: var(--app-primary);} progress::-moz-progress-bar {background: var(--app-primary);}
.current-book__footer .q-btn {padding: 11px 20px; border-radius: 13px; font-size: 14px; font-weight: 550; min-height: 44px;}
.overview-text-link {font-size: 13px; color: var(--app-primary); text-decoration: none; padding: 4px;}
.overview-welcome {max-width: 690px;}
.overview-footer {display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 32px; padding-top: 14px; border-top: 1px solid var(--app-border); color: var(--app-muted);}
.overview-footer > a {color: var(--app-primary); font-size: 14px; text-decoration: none;}
.overview-loading {color: var(--app-muted); margin-top: 32px; font-size: 14px;}
.overview-loading__covers {display: grid; grid-template-columns: repeat(6, minmax(0, 130px)); gap: 24px; margin-top: 16px; overflow: hidden;}
.overview-skeleton {aspect-ratio: 2 / 3; background: var(--app-surface-3); border-radius: 10px;}
.overview-skeleton--hero {aspect-ratio: auto; height: 295px; max-width: 460px; border-radius: 22px;}
@media (min-width: 1100px) {.overview-reading--paired {display: grid; grid-template-columns: minmax(320px, 440px) minmax(0, 1fr); align-items: start; gap: 38px;} .overview-reading--paired > :deep(.book-shelf) {margin-top: 0;}}
@media (max-width: 599px) {.overview-search {height: 54px; gap: 10px; margin-bottom: 24px; padding: 0 12px;} input {font-size: 14px;} .current-book {padding: 18px; max-width: none;} .current-book__body {gap: 15px;} .current-book__cover {width: 76px; flex-basis: 76px;} .current-book__title {font-size: 18px;} .current-book__caption {margin-bottom: 22px;} .current-book__footer {margin-top: 22px;} .overview-loading__covers {grid-template-columns: repeat(6, 112px); gap: 20px;}}
</style>
