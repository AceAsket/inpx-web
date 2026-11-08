<template>
    <q-dialog :model-value="modelValue" :position="$q.screen.width < 600 ? 'bottom' : 'standard'" @update:model-value="$emit('update:modelValue', $event)">
        <q-card class="catalog-filters-dialog">
            <div class="catalog-filters-dialog__header"><h2>Фильтры поиска</h2><q-btn flat round dense icon="la la-times" aria-label="Закрыть фильтры" @click="close" /></div>
            <div class="catalog-filters-dialog__body">
                <p>Условия применяются вместе с названием, автором и серией.</p>
                <div class="catalog-filters-dialog__grid">
                    <q-input :model-value="genreLabel" outlined clearable readonly label="Жанры" @click="genreVisible = true" @clear="draft.genre = ''"><template #append><q-icon name="la la-angle-down" /></template></q-input>
                    <q-input :model-value="draft.lang" outlined clearable readonly label="Языки" @click="langVisible = true" @clear="draft.lang = ''"><template #append><q-icon name="la la-angle-down" /></template></q-input>
                    <q-input :model-value="draft.ext.toUpperCase()" outlined clearable readonly label="Форматы" @click="extVisible = true" @clear="draft.ext = ''"><template #append><q-icon name="la la-angle-down" /></template></q-input>
                    <q-input :model-value="draft.librate" outlined clearable readonly label="Оценки читателей" @click="rateVisible = true" @clear="draft.librate = ''"><template #append><q-icon name="la la-angle-down" /></template></q-input>
                    <q-input :model-value="draft.date.replace(',', ' — ')" outlined clearable readonly label="Дата добавления" @click="dateVisible = true" @clear="draft.date = ''"><template #append><q-icon name="la la-calendar" /></template></q-input>
                    <q-select v-model="draft.sourceId" outlined emit-value map-options label="Библиотека" :options="sourceOptions" />
                    <q-input v-model="draft.ratingCount" outlined clearable label="Число голосов" placeholder="Например, 10..100" maxlength="100" />
                    <q-input v-model="draft.isbn" outlined clearable label="ISBN" maxlength="32" />
                    <q-input v-model="draft.keywords" outlined clearable label="Ключевые слова" maxlength="1000" class="catalog-filters-dialog__wide" />
                </div>
                <q-checkbox v-model="draft.hideCopies" label="Скрывать повторные издания" />
            </div>
            <div class="catalog-filters-dialog__footer">
                <q-btn flat no-caps label="Сбросить" @click="reset" />
                <span />
                <q-btn flat no-caps label="Отмена" @click="close" />
                <q-btn unelevated color="primary" no-caps label="Применить" @click="apply" />
            </div>
        </q-card>
        <SelectGenreDialog v-model="genreVisible" v-model:genre="draft.genre" :genre-tree="genreTree" />
        <SelectLangDialog v-model="langVisible" v-model:lang="draft.lang" :lang-list="langList" />
        <SelectExtDialog v-model="extVisible" v-model:ext="draft.ext" :ext-list="extList" />
        <SelectLibRateDialog v-model="rateVisible" v-model:librate="draft.librate" />
        <SelectDateDialog v-model="dateVisible" v-model:date="draft.date" />
    </q-dialog>
</template>

<script setup>
import {reactive, ref, computed, watch} from 'vue';
import SelectGenreDialog from '../Search/SelectGenreDialog/SelectGenreDialog.vue';
import SelectLangDialog from '../Search/SelectLangDialog/SelectLangDialog.vue';
import SelectExtDialog from '../Search/SelectExtDialog/SelectExtDialog.vue';
import SelectLibRateDialog from '../Search/SelectLibRateDialog/SelectLibRateDialog.vue';
import SelectDateDialog from '../Search/SelectDateDialog/SelectDateDialog.vue';
import {filtersFrom} from './catalogSearchModel';

const props = defineProps({modelValue: Boolean, search: {type: Object, required: true}, genreMap: {type: Object, required: true},
    genreTree: Array, langList: Array, extList: Array, sources: {type: Array, default: () => []}});
const emit = defineEmits(['update:modelValue', 'apply']);
const draft = reactive(filtersFrom());
const genreVisible = ref(false), langVisible = ref(false), extVisible = ref(false), rateVisible = ref(false), dateVisible = ref(false);
watch(() => props.modelValue, visible => {
    if (visible) Object.assign(draft, filtersFrom(props.search));
    else {genreVisible.value = false; langVisible.value = false; extVisible.value = false; rateVisible.value = false; dateVisible.value = false;}
}, {immediate: true});
const genreLabel = computed(() => draft.genre.split(',').filter(Boolean).map(code => props.genreMap.get(code) || code).join(', '));
const sourceOptions = computed(() => [{label: 'Все библиотеки', value: ''}, ...props.sources.map(source => ({label: source.name || source.id, value: source.id}))]);
function close() {emit('update:modelValue', false);}
function reset() {Object.assign(draft, filtersFrom());}
function apply() {emit('apply', {...draft}); close();}
</script>

<style>
.catalog-filters-dialog {width: 600px; max-width: calc(100vw - 32px); max-height: min(760px, 90vh); display: flex; flex-direction: column; border-radius: 22px !important; background: var(--app-surface); color: var(--app-text);}
.catalog-filters-dialog__header {display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 22px 24px 12px;}
.catalog-filters-dialog h2 {font-size: 21px; font-weight: 550; line-height: 1.4; margin: 0;}
.catalog-filters-dialog__body {overflow: auto; padding: 0 24px 16px;}
.catalog-filters-dialog__body > p {color: var(--app-muted); font-size: 13px; margin: 0 0 22px; line-height: 1.6;}
.catalog-filters-dialog__grid {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 14px; margin-bottom: 12px;}
.catalog-filters-dialog__wide {grid-column: 1 / -1;}
.catalog-filters-dialog__footer {display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--app-border); padding: 14px 24px;}
.catalog-filters-dialog__footer > span {flex: 1;}
@media (max-width: 599px) {.catalog-filters-dialog {max-width: 100%; width: 100%; border-radius: 22px 22px 0 0 !important; max-height: 90vh;} .catalog-filters-dialog__header {padding: 18px 20px;} .catalog-filters-dialog__body {padding: 0 20px 18px;} .catalog-filters-dialog__grid {grid-template-columns: minmax(0, 1fr); gap: 17px;} .catalog-filters-dialog__footer {padding: 12px 12px max(12px, env(safe-area-inset-bottom)); gap: 4px;} .catalog-filters-dialog__footer .q-btn {font-size: 13px; padding-left: 10px; padding-right: 10px;}}
</style>
