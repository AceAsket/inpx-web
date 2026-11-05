<template>
    <div class="catalog-text-field">
        <q-input :model-value="text" borderless clearable :label="label" maxlength="1000" class="catalog-text-field__input" @update:model-value="$emit('update:text', $event)">
            <template v-if="searchIcon" #prepend><q-icon name="la la-search" size="24px" /></template>
        </q-input>
        <q-select :model-value="mode" :options="modes" emit-value map-options borderless dense options-dense dropdown-icon="la la-angle-down" class="catalog-text-field__mode" :aria-label="modeLabel || `Совпадение: ${label}`" @update:model-value="$emit('update:mode', $event)" />
    </div>
</template>

<script setup>
defineProps({text: String, mode: String, label: String, modeLabel: String, searchIcon: Boolean});
defineEmits(['update:text', 'update:mode']);
const modes = [{label: 'Содержит', value: 'contains'}, {label: 'Начинается', value: 'starts'}, {label: 'Точно', value: 'exact'}];
</script>

<style scoped>
.catalog-text-field {display: flex; align-items: center; min-width: 0; min-height: 56px; border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-surface);}
.catalog-text-field:focus-within {border-color: var(--app-primary); box-shadow: 0 0 0 1px var(--app-primary);}
.catalog-text-field__input {flex: 1; min-width: 0;}
.catalog-text-field__input :deep(.q-field__control) {height: 56px; min-height: 56px; padding: 0 12px; box-shadow: none !important;}
.catalog-text-field__input :deep(.q-field__label) {max-width: 100%;}
.catalog-text-field__mode {width: 120px; flex: 0 0 120px; border-left: 1px solid var(--app-border); padding: 0 10px; font-size: 12px;}
.catalog-text-field__mode :deep(.q-field__control), .catalog-text-field__mode :deep(.q-field__marginal) {height: 36px; min-height: 36px; padding: 0; box-shadow: none !important;}
.catalog-text-field__mode :deep(.q-field__native) {min-height: 36px; padding: 0; align-items: center; flex-wrap: nowrap; white-space: nowrap; line-height: 1.4;}
.catalog-text-field__mode :deep(.q-field__append) {padding-left: 6px;}
.catalog-text-field__mode :deep(.q-select__dropdown-icon) {font-size: 16px;}
@media (max-width: 599px) {.catalog-text-field__mode {width: 108px; flex-basis: 108px; font-size: 11px; padding: 0 8px;} .catalog-text-field__input :deep(.q-field__label) {font-size: 13px;}}
@media (max-width: 359px) {.catalog-text-field__input :deep(.q-field__prepend) {display: none;} .catalog-text-field__input :deep(.q-field__label) {font-size: 12px;}}
</style>
