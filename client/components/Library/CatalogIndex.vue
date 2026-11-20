<template>
    <main class="library-page catalog-page" :aria-busy="loading">
        <div class="catalog-page__heading">
            <div>
                <RouterLink :to="catalogTarget('/books', {}, route.query)">
                    Каталог
                </RouterLink><h1>{{ kind === 'author' ? 'Авторы' : 'Серии' }}</h1>
            </div><RouterLink :to="catalogTarget(kind === 'author' ? '/series-index' : '/authors', {}, route.query)">
                {{ kind === 'author' ? 'Серии' : 'Авторы' }} <q-icon name="la la-arrow-right" />
            </RouterLink>
        </div>
        <nav class="catalog-breadcrumbs" aria-label="Алфавитный указатель">
            <button type="button" @click="go('')">
                Все
            </button><span v-for="part in prefixParts" :key="part"><q-icon name="la la-angle-right" /><q-select v-if="part === '…'" :model-value="prefix" :options="prefixOptions" emit-value map-options borderless dense options-dense display-value="…" hide-dropdown-icon class="catalog-breadcrumb-more" aria-label="Вернуться к префиксу" @update:model-value="go" /><button v-else type="button" :aria-current="part === prefix ? 'page' : undefined" @click="go(part)">{{ part.toUpperCase() }}</button></span>
        </nav>
        <div class="catalog-index-filters">
            <q-select v-model="language" :options="languages" emit-value map-options outlined dense label="Язык книг" /><q-select v-model="source" :options="sources" emit-value map-options outlined dense label="Библиотека" />
        </div>
        <LibraryNotice v-if="error" error title="Не удалось загрузить каталог" :message="error" action-label="Повторить" @action="load" />
        <div v-if="loading && !data" class="catalog-page__loading" role="status">
            <q-spinner size="26px" /> Загружаем указатель…
        </div>
        <template v-if="data">
            <p class="catalog-page__muted">
                {{ kind === 'author' ? 'Авторов' : 'Серий' }}: {{ data.total.toLocaleString('ru') }}
            </p>
            <div v-if="data.groups.length" class="catalog-alphabet">
                <button v-for="group in data.groups" :key="group.prefix" type="button" :disabled="loading" @click="group.name ? openEntity(group.name) : go(group.prefix)">
                    <strong>{{ group.prefix.toUpperCase() }}</strong><small>{{ group.count.toLocaleString('ru') }}</small>
                </button>
            </div>
            <div v-else-if="data.items.length" class="catalog-entities">
                <RouterLink v-for="item in data.items" :key="item.name" :to="catalogTarget(kind === 'author' ? '/author-details' : '/series-details', {name:item.name}, resultScope)">
                    <span>{{ item.name }}</span><small>{{ item.count.toLocaleString('ru') }}</small><q-icon name="la la-angle-right" />
                </RouterLink>
            </div>
            <p v-else class="library-empty">
                По этим условиям ничего не найдено. Измените язык или библиотеку.
            </p>
        </template>
    </main>
</template>
<script setup>
import {computed, ref, watch, onBeforeUnmount, onDeactivated} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {useLibraryPage} from './useLibraryPage';
import {catalogScope, catalogTarget} from './catalogSearchModel';
import {languageOptions, sortIndexRows} from './catalogLanguages';
import LibraryNotice from './LibraryNotice.vue';
import './catalogPages.css';
const route = useRoute(), router = useRouter(), data = ref(null), loading = ref(false), error = ref('');
const kind = computed(() => route.path === '/authors' ? 'author' : 'series');
const prefix = computed(() => String(route.query.prefix || ''));
const fullPrefix = computed(() => Array.from(prefix.value).map((value, index, parts) => parts.slice(0, index + 1).join('')).filter(part => part.trim() === part));
const prefixParts = computed(() => fullPrefix.value.length <= 3 ? fullPrefix.value : [fullPrefix.value[0], '…', ...fullPrefix.value.slice(-2)]);
const prefixOptions = computed(() => fullPrefix.value.map(value => ({label: value.toUpperCase(), value})));
const language = computed({get: () => String(route.query.lang || ''), set: lang => router.push({path: route.path, query: {...route.query, lang: lang || undefined, prefix: undefined}})});
const source = computed({get: () => String(route.query.sourceId || ''), set: sourceId => router.push({path: route.path, query: {...route.query, sourceId: sourceId || undefined, prefix: undefined}})});
const languages = ref(languageOptions([], true));
const {library, active} = useLibraryPage('Каталог', load);
const sources = computed(() => [{label: 'Все библиотеки', value: ''}, ...(library.config.value.librarySources || []).map(item => ({label: item.name, value: item.id}))]);
const resultScope = ref({});
let request = 0, currentKind = '', currentRevision, languageRevision, languagesPending;
function loadLanguages(revision) {
    if (languageRevision === revision || languagesPending === revision) return;
    languagesPending = revision;
    library.api.getGenreTree().then(result => {
        if (revision !== library.state.revision) return;
        languages.value = languageOptions(result.langList || [], true);
        languageRevision = revision;
    }).catch(() => {}).finally(() => {
        if (languagesPending === revision) languagesPending = undefined;
    });
}
async function load() {
    const id = ++request, revision = library.state.revision, group = kind.value, scope = catalogScope(route.query);
    const path = route.fullPath;
    const current = () => id === request && revision === library.state.revision && route.fullPath === path;
    if (currentRevision !== revision || currentKind !== group) data.value = null;
    currentRevision = revision;
    currentKind = group;
    loading.value = true;
    error.value = '';
    loadLanguages(revision);
    try {
        const result = await library.api.catalogBrowse({kind:group, prefix:prefix.value, filters:scope});
        if (!current()) return;
        resultScope.value = scope;
        data.value = {...result,
            groups:sortIndexRows(result.groups, 'prefix', result.prefix, scope.lang),
            items:sortIndexRows(result.items, 'name', result.prefix, scope.lang)};
        document.title = `${group === 'author' ? 'Авторы' : 'Серии'} · INPX Web`;
    } catch (e) {if (current()) error.value = e.message;}
    finally {if (current()) loading.value = false;}
}
function go(value) {router.push({path: route.path, query: {...route.query, prefix: value || undefined}});}
function openEntity(name) {router.push(catalogTarget(kind.value === 'author' ? '/author-details' : '/series-details', {name}, resultScope.value));}
watch(() => route.fullPath, () => {if (active.value && ['/authors', '/series-index'].includes(route.path)) load();});
onDeactivated(() => {request++;}); onBeforeUnmount(() => {request++;});
</script>
