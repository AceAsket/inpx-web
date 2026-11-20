<template>
    <section class="current-reading-list" aria-label="Книги в чтении" :aria-busy="loading">
        <p v-if="error" role="alert">{{ error }} <q-btn flat dense no-caps label="Повторить" @click="load(page)" /></p>
        <p v-else-if="loading && !books.length" role="status">Загружаем книги…</p>
        <p v-else-if="!books.length">Сейчас нет книг в чтении.</p>
        <ul v-if="books.length">
            <li v-for="book in books" :key="book.bookUid">
                <div>
                    <button v-if="!book.unavailable" type="button" class="reading-title" @click="emit('read', book)">{{ book.title }}</button>
                    <strong v-else>{{ book.title }}</strong>
                    <small>{{ [book.author, book.series, Math.round(book.percent * 100) + '%'].filter(Boolean).join(' · ') }}</small>
                </div>
                <q-btn flat dense no-caps label="Убрать" :aria-label="'Убрать из чтения: ' + book.title" :disable="loading || !!removing" :loading="removing === book.bookUid" @click="hide(book)" />
            </li>
        </ul>
        <nav v-if="count > pageSize" aria-label="Страницы списка чтения">
            <q-btn flat dense round icon="la la-angle-left" aria-label="Предыдущая страница" :disable="!page || loading || !!removing" @click="load(page - 1)" />
            <span>{{ page + 1 }} из {{ Math.ceil(count / pageSize) }}</span>
            <q-btn flat dense round icon="la la-angle-right" aria-label="Следующая страница" :disable="(page + 1) * pageSize >= count || loading || !!removing" @click="load(page + 1)" />
        </nav>
    </section>
</template>

<script setup>
import {computed, getCurrentInstance, onBeforeUnmount, ref, watch} from 'vue';
import {useStore} from 'vuex';

const emit = defineEmits(['read', 'changed']);
const store = useStore();
const api = getCurrentInstance().proxy.$root.api;
const owner = computed(() => store.state.config.profileAuthorized ? store.state.config.currentUserId : '');
const pageSize = 25;
const books = ref([]);
const count = ref(0);
const page = ref(0);
const generation = ref(0);
const loading = ref(false);
const removing = ref('');
const error = ref('');
let revision = 0;

async function load(target) {
    const current = ++revision, userId = owner.value;
    if (!userId) return;
    loading.value = true;
    error.value = '';
    try {
        const result = await api.getUserReadingLibrary({state:'reading', sort:'updatedDesc', limit:pageSize, offset:target * pageSize},
            {userId, suppressProfileLogin:true});
        if (current !== revision || owner.value !== userId) return;
        const last = Math.max(0, Math.ceil(result.count / pageSize) - 1);
        if (target > last) return load(last);
        books.value = result.items;
        count.value = result.count;
        generation.value = result.progressGeneration;
        page.value = target;
    } catch (e) {
        if (current === revision && owner.value === userId) error.value = e.message;
    } finally {
        if (current === revision) loading.value = false;
    }
}
async function hide(book) {
    const userId = owner.value, current = revision;
    if (!userId || removing.value || loading.value) return;
    removing.value = book.bookUid;
    try {
        const result = await api.updateReaderProgress(book.bookUid, {hidden:true, generation:generation.value, baseRevision:book.revision},
            {userId, suppressProfileLogin:true});
        if (current !== revision || owner.value !== userId) return;
        emit('changed');
        await load(page.value);
        if (owner.value === userId && !result.progress?.hidden) error.value = 'Позиция чтения изменилась. Попробуйте ещё раз.';
    } catch (e) {
        if (current === revision && owner.value === userId) error.value = e.message;
    } finally {
        if (owner.value === userId) removing.value = '';
    }
}
watch(owner, () => {
    books.value = [];
    count.value = 0;
    page.value = 0;
    removing.value = '';
    loading.value = false;
    error.value = '';
    load(0);
}, {immediate:true});
onBeforeUnmount(() => {revision++;});
</script>

<style scoped>
.current-reading-list p {margin: 8px 0; color: var(--app-muted);}
.current-reading-list ul {list-style: none; padding: 0; margin: 0;}
.current-reading-list li {display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--app-border);}
.current-reading-list li > div {flex: 1; min-width: 0; overflow-wrap: anywhere;}
.reading-title {padding: 0; border: 0; background: none; color: var(--app-primary); text-align: start; font: inherit; font-weight: 600; cursor: pointer;}
.current-reading-list small {display: block; margin-top: 3px; color: var(--app-muted);}
.current-reading-list nav {display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 12px;}
</style>
