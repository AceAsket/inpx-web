<template>
    <section class="catalog-search-panel" aria-label="Поиск книг">
        <div class="catalog-search-panel__heading">
            <h1>Каталог</h1><q-select :model-value="selectedList" :options="sections" emit-value map-options outlined dense options-dense class="catalog-search-panel__section" aria-label="Раздел каталога" @update:model-value="changeSection" />
        </div>
        <form v-if="!discovery && !extended" role="search" @submit.prevent="flush">
            <div class="catalog-search-panel__main">
                <CatalogTextField v-model:text="draft.title.text" v-model:mode="draft.title.mode" label="Название книги" mode-label="Совпадение названия" search-icon suggestions kind="title" :filters="suggestionFilters" :context="suggestionContext" @choose="chooseSuggestion" @search="flush" @update:text="schedule" @update:mode="schedule" />
                <q-btn unelevated no-caps color="primary" label="Найти" icon="la la-arrow-right" type="submit" />
            </div>
            <div v-if="moreFields" class="catalog-search-panel__extra">
                <CatalogTextField v-for="field in extraFields" :key="field.id" v-model:text="draft[field.id].text" v-model:mode="draft[field.id].mode" :label="field.label" suggestions :kind="field.id" :filters="suggestionFilters" :context="suggestionContext" @choose="chooseSuggestion" @search="flush" @update:text="schedule" @update:mode="schedule" />
            </div>
        </form>
        <div v-if="extended" class="catalog-search-panel__extended">
            <span>{{ extSummary || 'Задайте условия расширенного поиска' }}</span><q-btn outline no-caps label="Параметры поиска" @click="$emit('edit-extended')" /><q-btn v-if="extSummary" flat no-caps label="Очистить" @click="$emit('clear-extended')" />
        </div>
        <div v-if="!discovery && !extended" class="catalog-search-panel__tools">
            <button type="button" :aria-expanded="moreFields" @click="moreFields = !moreFields">
                <q-icon v-if="!moreFields" name="la la-plus" /><q-icon v-else name="la la-minus" /> Автор и серия
            </button>
            <button type="button" :class="{'has-filters': chips.length}" @click="flush(); filtersVisible = true">
                <q-icon name="la la-sliders-h" size="19px" /> Фильтры <span v-if="chips.length" class="catalog-search-panel__count">{{ chips.length }}</span>
            </button>
            <button v-if="authorized" type="button" class="catalog-search-panel__save" @click="flush(); $emit('save-shelf')">
                <q-icon name="la la-bookmark" size="18px" /> <span>Сохранить поиск</span>
            </button>
        </div>
        <div v-if="(chips.length || hiddenTextChips.length) && !discovery && !extended" class="catalog-search-panel__chips" aria-label="Активные фильтры">
            <q-chip v-for="chip in [...hiddenTextChips, ...chips]" :key="chip.field" removable @remove="patch({[chip.field]: ''})">
                {{ chip.label }}
            </q-chip>
            <button v-if="chips.length" type="button" @click="patch(filtersFrom())">
                Сбросить фильтры
            </button>
        </div>
        <CatalogFiltersDialog v-model="filtersVisible" :search="search" :genre-map="genreMap" :genre-tree="genreTree" :lang-list="langList" :ext-list="extList" :sources="sources" @apply="patch" />
        <nav class="catalog-index-links" aria-label="Обзор каталога">
            <RouterLink :to="catalogTarget('/authors', {}, suggestionFilters)">
                Авторы по алфавиту <q-icon name="la la-arrow-right" />
            </RouterLink><RouterLink :to="catalogTarget('/series-index', {}, suggestionFilters)">
                Серии по алфавиту <q-icon name="la la-arrow-right" />
            </RouterLink>
        </nav>
    </section>
</template>

<script setup>
import {reactive, ref, computed, watch, onBeforeUnmount, onDeactivated, inject} from 'vue';
import CatalogFiltersDialog from './CatalogFiltersDialog.vue';
import CatalogTextField from './CatalogTextField.vue';
import {useRouter} from 'vue-router';
import {useStore} from 'vuex';
import {textFields, decodeText, encodeText, canAutoSearch, filtersFrom, activeFilters, catalogScope, catalogTarget} from './catalogSearchModel';
import {libraryContextKey} from './libraryContext';
import {bookUid} from './libraryModel';

const props = defineProps({search: {type: Object, required: true}, selectedList: String, listOptions: Array,
    discovery: Boolean, extended: Boolean, extSummary: String, authorized: Boolean, genreMap: {type: Object, required: true},
    genreTree: Array, langList: Array, extList: Array, sources: {type: Array, default: () => []}});
const emit = defineEmits(['patch', 'section', 'save-shelf', 'edit-extended', 'clear-extended']);
const router = useRouter(), store = useStore();
const library = inject(libraryContextKey, null);
const suggestionFilters = computed(() => catalogScope(props.search));
const suggestionContext = computed(() => `${store.state.config.profileAuthorized}:${store.state.config.currentUserProfile?.id || ''}`);
const draft = reactive(Object.fromEntries(textFields.map(field => [field, decodeText(props.search[field])])));
const moreFields = ref(!!(props.search.author || props.search.series)), filtersVisible = ref(false);
const extraFields = [{id: 'author', label: 'Автор'}, {id: 'series', label: 'Серия'}];
const sections = computed(() => (props.listOptions || []).map(option => ({...option, label: option.value === 'extended' ? 'Расширенный поиск' : option.value === 'books' ? 'Все книги' : option.label})));
const chips = computed(() => activeFilters(props.search, props.genreMap, props.sources));
const hiddenTextChips = computed(() => moreFields.value ? [] : extraFields.filter(field => props.search[field.id])
    .map(field => ({field: field.id, label: `${field.label}: ${decodeText(props.search[field.id]).text}`})));
let timer;
watch(() => textFields.map(field => props.search[field]), () => {
    clearTimeout(timer);
    for (const field of textFields) {
        if (props.search[field]) Object.assign(draft[field], decodeText(props.search[field]));
        else draft[field].text = '';
    }
    if (props.search.author || props.search.series) moreFields.value = true;
});
function schedule() {clearTimeout(timer); if (canAutoSearch(draft)) timer = setTimeout(flush, 500);}
function flush() {
    clearTimeout(timer);
    const values = Object.fromEntries(textFields.map(field => [field, encodeText(draft[field].text, draft[field].mode)]));
    if (textFields.some(field => values[field] !== (props.search[field] || ''))) emit('patch', values);
}
function patch(values) {flush(); emit('patch', values);}
function changeSection(section) {flush(); emit('section', section);}
function chooseSuggestion(item) {
    clearTimeout(timer);
    if (item.kind === 'correction') {
        router.push({path: item.targetKind === 'title' ? '/books' : `/${item.targetKind}`, query: {...suggestionFilters.value, [item.targetKind]: item.name}});
        return;
    }
    if (item.kind === 'title' && bookUid(item.book) && library?.openCard) {
        library.openCard(item.book);
        return;
    }
    router.push(item.kind === 'title' ? catalogTarget('/book', {bookUid:bookUid(item.book)}, suggestionFilters.value)
        : catalogTarget(item.kind === 'author' ? '/author-details' : '/series-details', {name:item.name}, suggestionFilters.value));
}
onDeactivated(() => {clearTimeout(timer); filtersVisible.value = false;});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.catalog-search-panel {padding: 26px 30px 20px; border-bottom: 1px solid var(--app-border); background: var(--app-bg);}
.catalog-search-panel__heading {display: flex; justify-content: space-between; gap: 18px; align-items: center; margin-bottom: 24px;}
h1 {font-size: 26px; font-weight: 550; line-height: 1.3; letter-spacing: -.03em; margin: 0;}
.catalog-search-panel__heading > .q-select {min-width: 140px; font-size: 13px;}
.catalog-search-panel__section :deep(.q-field__control) {border-radius: 12px; background: var(--app-surface); min-height: 40px;}
.catalog-search-panel__section :deep(.q-field__control::before) {border-color: var(--app-border);}
.catalog-search-panel__main {display: flex; gap: 12px; align-items: stretch;}
.catalog-search-panel__main > .catalog-text-field {flex: 1; min-width: 0;}
.catalog-search-panel__main > .q-btn {border-radius: 14px; padding: 0 24px;}
.catalog-search-panel__extra {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px;}
.catalog-search-panel__tools {display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center;}
.catalog-search-panel__tools > button {display: flex; align-items: center; justify-content: center; gap: 7px; background: transparent; color: var(--app-muted); font: inherit; font-size: 13px; border: 0; border-radius: 10px; padding: 9px 10px; cursor: pointer;}
.catalog-search-panel__tools > button:hover {background: var(--app-surface-3);}
.catalog-search-panel__tools > .has-filters {color: var(--app-primary);}
.catalog-search-panel__save {margin-left: auto;}
.catalog-search-panel__count {display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: var(--app-primary); background: var(--app-surface-2); font-size: 11px;}
.catalog-search-panel__chips {display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px;}
.catalog-search-panel__chips :deep(.q-chip) {margin: 0; background: var(--app-surface-2); color: var(--app-text); font-size: 12px; height: auto; min-height: 30px; padding-top: 6px; padding-bottom: 6px; max-width: 100%;}
.catalog-search-panel__chips :deep(.q-chip__content) {white-space: normal; overflow-wrap: anywhere;}
.catalog-search-panel__chips > button {border: 0; color: var(--app-muted); background: transparent; font: inherit; font-size: 12px; cursor: pointer; padding: 5px;}
.catalog-search-panel__extended {display: flex; align-items: center; gap: 12px; flex-wrap: wrap;}
.catalog-search-panel__extended > span {color: var(--app-muted); font-size: 13px;}
button:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 2px;}
.catalog-index-links {display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px;}
.catalog-index-links a {color: var(--app-primary); font-size: 12px; text-decoration: none; padding: 5px 0;}
@media (max-width: 599px) {.catalog-search-panel {padding: 12px 16px 16px;} .catalog-search-panel__heading {margin-bottom: 18px;} h1 {font-size: 23px;} .catalog-search-panel__main {gap: 8px;} .catalog-search-panel__main > .q-btn {padding: 0 14px; font-size: 12px;} .catalog-search-panel__main > .q-btn :deep(.q-icon) {display: none;} .catalog-search-panel__extra {grid-template-columns: minmax(0, 1fr);} .catalog-search-panel__tools > button {font-size: 12px; padding: 8px 6px;} .catalog-search-panel__save > span {display: none;}}
</style>
