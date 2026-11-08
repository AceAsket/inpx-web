<template>
    <nav class="library-pagination" aria-label="Страницы каталога" :aria-busy="disable">
        <div class="library-pagination__pages">
            <button type="button" :disabled="disable || current === 1" aria-label="Предыдущая страница" @click="go(current - 1)"><q-icon name="la la-angle-left" size="20px" /></button>
            <template v-for="item in pages" :key="item">
                <button v-if="typeof item === 'number'" type="button" class="library-pagination__number" :class="{'is-current': item === current}" :aria-current="item === current ? 'page' : undefined" :aria-label="`Страница ${item}`" :disabled="disable" @click="go(item)">{{ item.toLocaleString('ru-RU') }}</button>
                <span v-else class="library-pagination__gap" aria-hidden="true">…</span>
            </template>
            <button type="button" :disabled="disable || current === total" aria-label="Следующая страница" @click="go(current + 1)"><q-icon name="la la-angle-right" size="20px" /></button>
        </div>
        <form class="library-pagination__jump" @submit.prevent="submit">
            <label>Страница <input v-model="draft" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="12" aria-label="Номер страницы" :disabled="disable" @blur="restoreInvalid" /></label>
            <span>из {{ total.toLocaleString('ru-RU') }}</span>
            <button type="submit" :disabled="disable || parsePage(draft, total) === null" aria-label="Перейти на страницу"><q-icon name="la la-arrow-right" size="18px" /></button>
        </form>
    </nav>
</template>

<script setup>
import {computed, ref, watch} from 'vue';
import {pageLimit, boundedPage, parsePage, pageWindow} from './paginationModel';
const props = defineProps({modelValue: Number, pageCount: Number, disable: Boolean});
const emit = defineEmits(['update:modelValue']);
const total = computed(() => pageLimit(props.pageCount));
const current = computed(() => boundedPage(props.modelValue, total.value));
const pages = computed(() => pageWindow(current.value, total.value));
const draft = ref(String(current.value));
watch(current, value => {draft.value = String(value);});
function go(value) {
    if (props.disable) return;
    const page = boundedPage(value, total.value);
    draft.value = String(page);
    if (page !== current.value) emit('update:modelValue', page);
}
function submit() {const page = parsePage(draft.value, total.value); if (page !== null) go(page); else draft.value = String(current.value);}
function restoreInvalid() {if (parsePage(draft.value, total.value) === null) draft.value = String(current.value);}
</script>

<style scoped>
.library-pagination {display: flex; align-items: center; flex-wrap: wrap; gap: 12px 24px; color: var(--app-muted); font-size: 13px;}
.library-pagination__pages, .library-pagination__jump {display: flex; align-items: center; gap: 5px;}
button {display: grid; place-items: center; flex-shrink: 0; min-width: 38px; height: 38px; border: 0; border-radius: 11px; padding: 0 10px; font: inherit; background: transparent; color: var(--app-text); cursor: pointer;}
button:hover:not(:disabled) {background: var(--app-surface-3);}
button.is-current {background: var(--app-surface-2); color: var(--app-primary); font-weight: 650;}
button:disabled {opacity: .4; cursor: default;}
button:focus-visible, input:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 2px;}
.library-pagination__gap {padding: 0 3px;}
.library-pagination__jump {gap: 9px;}
label {display: flex; align-items: center; gap: 9px;}
input {width: 64px; height: 36px; text-align: center; border: 1px solid var(--app-border); border-radius: 10px; background: var(--app-surface); color: var(--app-text); font: inherit;}
.library-pagination__jump > button {min-width: 32px; padding: 0 6px; color: var(--app-primary);}
@media (max-width: 599px) {.library-pagination {gap: 8px; justify-content: space-between;} .library-pagination__number, .library-pagination__gap {display: none;} .library-pagination__pages {gap: 4px;} .library-pagination__pages > button {background: var(--app-surface); min-width: 36px; height: 36px;} .library-pagination__jump {font-size: 12px; gap: 6px;} label {gap: 6px;} input {width: 52px;}}
</style>
