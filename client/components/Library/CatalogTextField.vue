<template>
    <div class="catalog-text-field">
        <q-input :model-value="text" borderless clearable :label="label" maxlength="1000" class="catalog-text-field__input" :role="suggestions ? 'combobox' : undefined" :aria-controls="suggestions ? listId : undefined" :aria-expanded="suggestions ? expanded : undefined" :aria-activedescendant="activeId" :aria-autocomplete="suggestions ? 'list' : undefined" @focus="focused = true" @click="focused = true" @blur="focused = false" @keydown="completion?.keydown($event)" @update:model-value="focused = true; $emit('update:text', $event)">
            <template v-if="searchIcon" #prepend>
                <q-icon name="la la-search" size="24px" />
            </template>
            <CatalogSuggestions v-if="suggestions" ref="completion" :list-id="listId" :query="text" :kind="kind" :filters="filters" :context="context" :focused="focused" @choose="$emit('choose', $event)" @search="$emit('search')" @dismiss="focused = false" @active="activeId = $event" @expanded="expanded = $event" />
        </q-input>
        <q-select :model-value="mode" :options="modes" emit-value map-options borderless dense options-dense dropdown-icon="la la-angle-down" class="catalog-text-field__mode" :aria-label="modeLabel || `Совпадение: ${label}`" @update:model-value="$emit('update:mode', $event)" />
    </div>
</template>

<script setup>
import {ref, getCurrentInstance} from 'vue';
import CatalogSuggestions from './CatalogSuggestions.vue';
defineProps({text: {type: String, default: ''}, mode: {type: String, default: 'contains'}, label: {type: String, default: ''},
    modeLabel: {type: String, default: ''}, searchIcon: Boolean, suggestions: Boolean, kind: {type: String, default: ''},
    filters: {type: Object, default: () => ({})}, context: {type: String, default: ''}});
defineEmits(['update:text', 'update:mode', 'choose', 'search']);
const focused = ref(false), expanded = ref(false), activeId = ref(), completion = ref(null);
const listId = `catalog-suggestions-${getCurrentInstance().uid}`;
const modes = [{label: 'Содержит', value: 'contains'}, {label: 'Начинается', value: 'starts'}, {label: 'Точно', value: 'exact'}];
</script>

<style scoped>
.catalog-text-field {display: flex; align-items: center; min-width: 0; min-height: 56px; border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-surface);}
.catalog-text-field:focus-within {border-color: var(--app-primary); box-shadow: 0 0 0 1px var(--app-primary);}
.catalog-text-field__input {flex: 1; min-width: 0;}
.catalog-text-field__input :deep(.q-field__control) {height: 56px; min-height: 56px; padding: 0 12px; box-shadow: none !important;}
.catalog-text-field__mode {width: 120px; flex: 0 0 120px; border-left: 1px solid var(--app-border); padding: 0 10px; font-size: 12px;}
.catalog-text-field__mode :deep(.q-field__control), .catalog-text-field__mode :deep(.q-field__marginal) {height: 36px; min-height: 36px; padding: 0; box-shadow: none !important;}
.catalog-text-field__mode :deep(.q-field__native) {min-height: 36px; padding: 0; align-items: center; flex-wrap: nowrap; white-space: nowrap; line-height: 1.4;}
.catalog-text-field__mode :deep(.q-field__append) {padding-left: 6px;}
.catalog-text-field__mode :deep(.q-select__dropdown-icon) {font-size: 16px;}
@media (max-width: 599px) {.catalog-text-field__mode {width: 108px; flex-basis: 108px; font-size: 11px; padding: 0 8px;} .catalog-text-field__input :deep(.q-field__label) {font-size: 13px;}}
@media (max-width: 440px) {
    .catalog-text-field__input :deep(.q-field__prepend) {display: none;}
    .catalog-text-field__input :deep(.q-field__control) {padding-inline: 8px;}
}
@media (max-width: 359px) {
    .catalog-text-field__input :deep(.q-field__control) {padding-inline: 6px;}
    .catalog-text-field__input :deep(.q-field__append) {padding-left: 4px;}
    .catalog-text-field__input :deep(.q-field__label) {font-size: 12px;}
    .catalog-text-field__mode {width: 100px; flex-basis: 100px; padding-inline: 6px;}
    .catalog-text-field__mode :deep(.q-field__append) {padding-left: 2px;}
}
</style>
