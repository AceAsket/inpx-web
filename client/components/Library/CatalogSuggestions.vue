<template>
    <q-menu :model-value="visible" no-parent-event no-focus no-refocus no-route-dismiss fit :offset="[0, 8]" class="catalog-suggestions" @update:model-value="value => !value && dismiss()">
        <div :id="listId" role="listbox" aria-label="Подсказки поиска" class="catalog-suggestions__list">
            <p v-if="loading && !items.length" role="status">
                Ищем подсказки…
            </p>
            <p v-if="error" role="status">
                {{ error }}
            </p>
            <p v-if="data?.warming" role="status">
                Готовим индекс подсказок. Поиск уже доступен.
            </p>
            <div v-for="(item, index) in items" :key="`${item.kind}:${item.name}`">
                <div v-if="index === 0 || items[index - 1].kind !== item.kind" class="catalog-suggestions__heading">
                    {{ labels[item.kind] }}
                </div>
                <button :id="`${listId}-${index}`" role="option" type="button" :aria-selected="index === selected" :class="{'is-selected': index === selected}" @mousedown.prevent @click="choose(item)">
                    <q-icon :name="icons[item.kind]" size="21px" /><span>{{ item.name }}<small v-if="item.book?.author">{{ item.book.author }}</small></span><small v-if="item.count">{{ item.count }}</small>
                </button>
            </div>
        </div>
    </q-menu>
</template>

<script setup>
import {ref, computed, watch, onBeforeUnmount, onDeactivated, getCurrentInstance} from 'vue';
import {QMenu} from 'quasar';
const props = defineProps({query: {type: String, default: ''}, kind: {type: String, default: ''}, filters: {type: Object, default: () => ({})},
    focused: Boolean, context: {type: String, default: ''}, listId: {type: String, required: true}});
const emit = defineEmits(['choose', 'dismiss', 'active', 'expanded']);
const root = getCurrentInstance().proxy.$root;
const data = ref(null), loading = ref(false), error = ref(''), selected = ref(-1);
const visible = computed(() => !!(props.focused && (loading.value || data.value?.warming || error.value || items.value.length)));
const labels = {title: 'Книги', author: 'Авторы', series: 'Серии', correction: 'Возможно, вы искали'};
const icons = {title: 'la la-book', author: 'la la-user-edit', series: 'la la-layer-group', correction: 'la la-spell-check'};
const items = computed(() => [...(data.value?.groups || []).flatMap(group => group.items.map(item => ({...item, kind: group.kind}))),
    ...(data.value?.corrections || []).map(item => ({kind: 'correction', name: item.query, targetKind: item.kind}))]);
let timer, revision = 0;
watch(() => [props.query, props.kind, JSON.stringify(props.filters), props.context, props.focused], () => {
    clearTimeout(timer); const request = ++revision;
    data.value = null; selected.value = -1; error.value = ''; loading.value = false;
    if (!props.focused || Array.from((props.query || '').trim()).length < 2) return;
    const requestSuggestions = async() => {
        loading.value = true;
        try {
            const result = await root.api.catalogSuggest({query: props.query, kind: props.kind, filters: props.filters});
            if (request === revision) {
                data.value = result;
                if (result.warming) timer = setTimeout(requestSuggestions, 1500);
            }
        } catch (e) {if (request === revision && e.message !== 'need_profile_login') error.value = 'Подсказки недоступны. Можно выполнить поиск.';}
        finally {if (request === revision) loading.value = false;}
    };
    timer = setTimeout(requestSuggestions, 250);
});
watch(selected, index => emit('active', index >= 0 ? `${props.listId}-${index}` : undefined));
watch(visible, value => emit('expanded', value));
function dismiss() {emit('dismiss');}
function choose(item) {emit('choose', item); dismiss();}
function keydown(event) {
    if (!props.focused) return;
    if (event.key === 'Escape') {event.preventDefault(); dismiss(); return;}
    if (!items.value.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected.value = selected.value < 0 ? (event.key === 'ArrowDown' ? 0 : items.value.length - 1)
            : (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + items.value.length) % items.value.length;
        requestAnimationFrame(() => document.getElementById(`${props.listId}-${selected.value}`)?.scrollIntoView({block: 'nearest'}));
    }
    if (event.key === 'Enter' && selected.value >= 0) {event.preventDefault(); event.stopPropagation(); choose(items.value[selected.value]);}
}
function cancel() {clearTimeout(timer); revision++; loading.value = false; data.value = null;}
onBeforeUnmount(cancel); onDeactivated(cancel);
defineExpose({keydown});
</script>

<style>
.catalog-suggestions {max-width: min(640px, calc(100vw - 24px)); max-height: min(520px, 60vh); background: var(--app-surface, white); color: var(--app-text, #183236); border: 1px solid var(--app-border, #d6e3e3); border-radius: 14px;}
.catalog-suggestions__list {padding: 8px;}
.catalog-suggestions__heading {padding: 10px 10px 5px; font-size: 11px; color: var(--app-muted, #52696d); text-transform: uppercase; letter-spacing: .05em;}
.catalog-suggestions button {display: flex; gap: 12px; align-items: center; width: 100%; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; padding: 10px; font: inherit; cursor: pointer;}
.catalog-suggestions button:hover, .catalog-suggestions button.is-selected {background: var(--app-surface-2, #d7eeea);}
.catalog-suggestions button > span {flex: 1; min-width: 0; overflow-wrap: anywhere;}
.catalog-suggestions small {display: block; color: var(--app-muted, #52696d); font-size: 11px;}
.catalog-suggestions p {padding: 10px; margin: 0; color: var(--app-muted, #52696d);}
</style>
