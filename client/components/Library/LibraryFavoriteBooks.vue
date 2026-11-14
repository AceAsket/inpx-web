<template>
    <section aria-label="Новое у любимых">
        <LibraryNotice v-if="!authorized || loginRequired" title="Войдите в свой профиль" message="Здесь появятся новые книги авторов и серий, за которыми вы следите." action-label="Войти в профиль" @action="library.login" />
        <template v-else>
            <div class="favorite-books__actions">
                <q-btn flat no-caps icon="la la-star" label="Управление подписками" @click="library.openFollows()" />
                <q-btn flat no-caps icon="la la-sync" label="Проверить новинки" :disable="busy" @click="load(0, true)" />
                <q-btn flat no-caps icon="la la-check" label="Отметить показанные просмотренными" :disable="busy || !books.length" @click="markSeen" />
            </div>
            <div class="favorite-books__results" :aria-busy="busy || (!loaded && !error)">
                <div v-if="!loaded && !error" class="favorite-books__grid" role="status" aria-label="Загружаем книги">
                    <div v-for="slot in 3" :key="slot" class="favorite-books__placeholder" aria-hidden="true" />
                </div>
                <div v-else-if="books.length" class="favorite-books__grid">
                    <BookTile v-for="book in books" :key="bookUid(book)" :book="book" />
                </div>
                <div v-else-if="!error" class="library-empty">
                    <q-icon name="la la-star" size="32px" />
                    <h2>{{ follows.length ? 'Новых книг пока нет' : 'Подписок пока нет' }}</h2>
                    <p v-if="!follows.length">Подпишитесь на любимых авторов и серии в каталоге или в настройках подписок.</p>
                </div>
                <LibraryNotice v-if="error" error title="Не удалось обновить новинки" :message="error" action-label="Повторить" :busy="busy" @action="load(offset)" />
            </div>
            <div v-if="count > pageSize" class="favorite-books__actions" aria-label="Страницы новинок">
                <q-btn flat no-caps label="Назад" :disable="busy || offset === 0" @click="load(offset - pageSize)" />
                <span>{{ offset + 1 }}–{{ offset + books.length }} из {{ count }}</span>
                <q-btn flat no-caps label="Дальше" :disable="busy || offset + books.length >= count" @click="load(offset + pageSize)" />
            </div>
        </template>
    </section>
</template>

<script setup>
import {computed, inject, onBeforeUnmount, ref, watch} from 'vue';
import {libraryContextKey} from './libraryContext';
import {bookUid, profileLoginError} from './libraryModel';
import BookTile from './BookTile.vue';
import LibraryNotice from './LibraryNotice.vue';

const props = defineProps({active:Boolean});
const emit = defineEmits(['count']);
const library = inject(libraryContextKey);
const {state, config, api} = library;
const authorized = computed(() => config.value.profileAuthorized && !state.locked && !state.readingLoginRequired);
const pageSize = 40;
const count = ref(0), offset = ref(0), books = ref([]), follows = ref([]);
const busy = ref(false), loaded = ref(false), error = ref(''), loginRequired = ref(false);
let request = 0;

async function update(pageOffset, action) {
    if (!authorized.value || !props.active || busy.value) return;
    const id = ++request, epoch = state.revision;
    const current = () => props.active && authorized.value && request === id && epoch === state.revision;
    busy.value = true;
    error.value = '';
    try {
        let result = await action();
        if (!current()) return;
        if (!result.books?.length && pageOffset > 0) {
            pageOffset = Math.max(0, Math.floor(((result.unseenCount || 1) - 1) / pageSize) * pageSize);
            result = await api.getLibraryFollows({autoRefresh:true, offset:pageOffset, limit:pageSize}, {suppressProfileLogin:true});
            if (!current()) return;
        }
        offset.value = pageOffset;
        books.value = result.books || [];
        follows.value = result.follows || [];
        count.value = Number(result.unseenCount) || books.value.length;
        loaded.value = true;
        loginRequired.value = false;
        emit('count', count.value);
    } catch (failure) {
        if (!current()) return;
        if (profileLoginError(failure)) {
            loginRequired.value = true;
            books.value = [];
            emit('count', null);
        } else error.value = failure.message || 'Проверьте подключение и попробуйте ещё раз.';
    } finally {
        if (current()) busy.value = false;
    }
}

function load(pageOffset, refresh = false) {
    return update(pageOffset, () => api.getLibraryFollows({autoRefresh:true, offset:pageOffset, limit:pageSize, refresh}, {suppressProfileLogin:true}));
}

function markSeen() {
    return update(offset.value, () => api.changeLibraryFollow('seen-books', {
        bookUids:books.value.map(bookUid), offset:offset.value, limit:pageSize,
    }, {suppressProfileLogin:true}));
}

watch([() => props.active, () => state.revision, authorized], ([active, revision, allowed], previous) => {
    request++;
    busy.value = false;
    if (revision !== previous?.[1] || !allowed) {
        books.value = [];
        follows.value = [];
        loaded.value = false;
        offset.value = count.value = 0;
        loginRequired.value = false;
        error.value = '';
    }
    if (active && allowed) load(offset.value);
}, {immediate:true});
onBeforeUnmount(() => {request++;});
</script>

<style scoped>
.favorite-books__actions {display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 20px;}
.favorite-books__results {min-height: 260px;}
.favorite-books__grid {display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 28px 24px; margin-bottom: 20px;}
.favorite-books__grid :deep(.book-cover) {max-height: 230px;}
.favorite-books__placeholder {aspect-ratio: 2 / 3; max-height: 230px; border-radius: 9px; background: var(--app-surface-3);}
@media (max-width: 599px) {.favorite-books__grid {gap: 24px 18px; grid-template-columns: repeat(3, minmax(0, 1fr));}}
@media (max-width: 359px) {.favorite-books__grid {grid-template-columns: repeat(2, minmax(0, 1fr));} .favorite-books__placeholder:nth-child(3) {display: none;}}
</style>
