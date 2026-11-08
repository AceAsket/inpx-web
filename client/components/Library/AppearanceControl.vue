<template>
    <fieldset class="appearance-control">
        <legend>Оформление библиотеки</legend>
        <div class="appearance-control__choices">
            <button v-for="option in options" :key="option.value" type="button"
                :class="{'is-selected': value === option.value}" :aria-pressed="value === option.value"
                @click="select(option.value)">
                <q-icon :name="option.icon" size="25px" aria-hidden="true" />
                <span>{{ option.label }}<small>{{ option.description }}</small></span>
                <q-icon v-if="value === option.value" name="la la-check-circle" size="20px" aria-hidden="true" />
            </button>
        </div>
        <div class="appearance-control__app">
            <q-checkbox :model-value="store.state.settings.showAppPromo !== false" size="32px" label="QR-код приложения в боковом меню" @update:model-value="store.commit('setSettings', {showAppPromo:$event})" />
            <AppConnection :root-path="store.state.config.rootPathStatic || ''" button-label="Открыть QR" />
        </div>
    </fieldset>
</template>

<script setup>
import {computed} from 'vue';
import {useStore} from 'vuex';
import {appearance} from './libraryModel';
import AppConnection from '../Search/AppConnection.vue';

const store = useStore();
const emit = defineEmits(['change']);
const value = computed(() => appearance(store.state.settings.catalogAppearance));
const options = [
    {value: 'classic', label: 'Классический', description: 'Привычный каталог', icon: 'la la-list'},
    {value: 'shelves', label: 'Новый дизайн', description: 'Обложки и удобная навигация', icon: 'la la-book-open'},
];
function select(catalogAppearance) {
    if (catalogAppearance !== value.value) {
        store.commit('setSettings', {catalogAppearance});
        emit('change', catalogAppearance);
    }
}
</script>

<style scoped>
.appearance-control {border: 0; padding: 0; margin: 8px 0 20px; min-width: 0; font-size: 14px;}
legend {font-size: 15px; font-weight: 650; margin-bottom: 12px;}
.appearance-control__choices {display: flex; gap: 10px; flex-wrap: wrap;}
button {display: flex; align-items: center; gap: 12px; flex: 1 1 190px; padding: 16px; border: 1px solid var(--app-border); border-radius: 16px; background: var(--app-surface); color: var(--app-text); font: inherit; text-align: left; cursor: pointer;}
button.is-selected {border-color: var(--app-primary); background: var(--app-surface-2);}
button > span {flex: 1; font-weight: 650;}
small {display: block; color: var(--app-muted); font-weight: 400; margin-top: 4px;}
button:focus-visible {outline: 3px solid var(--app-primary); outline-offset: 3px;}
.appearance-control__app {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:12px;}
.appearance-control__app :deep(.q-checkbox) {flex:1;min-width:180px;}
.appearance-control__app :deep(.q-checkbox__label) {font-size:12px;line-height:1.5;}
</style>
