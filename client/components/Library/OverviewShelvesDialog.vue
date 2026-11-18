<template>
    <DialogSurface :model-value="true" variant="overview-shelves" @update:model-value="value => { if (!value) emit('close'); }">
        <template #header>Полки на главной</template>
        <div class="shelf-settings">
            <p>Выберите полки и порядок для профиля «{{ profileName }}».</p>
            <ol>
                <li v-for="(row, index) in rows" :key="row.id">
                    <label><input type="checkbox" :checked="!row.hidden" :disabled="saving" @change="toggle(row.id)" />{{ row.title }}</label>
                    <button type="button" :aria-label="`Выше: ${row.title}`" :disabled="saving || !index" @click="move(index, -1)"><q-icon name="la la-arrow-up" /></button>
                    <button type="button" :aria-label="`Ниже: ${row.title}`" :disabled="saving || index === rows.length - 1" @click="move(index, 1)"><q-icon name="la la-arrow-down" /></button>
                </li>
            </ol>
            <q-btn v-if="canPin" flat dense no-caps label="Закрепить личные полки" @click="emit('lists')" />
            <p v-if="error" role="alert">{{ error }}</p>
        </div>
        <template #footer><q-btn flat no-caps label="Отмена" :disable="saving" @click="emit('close')" /><q-btn unelevated no-caps color="primary" label="Сохранить" :loading="saving" @click="save" /></template>
    </DialogSurface>
</template>
<script setup>
import {computed, ref} from 'vue';
import DialogSurface from '../share/DialogSurface.vue';
import layout from '../../../shared/OverviewShelves';

const props = defineProps({shelves: Array, saved: Array, profileName: String, canPin: Boolean, persist: Function});
const emit = defineEmits(['close', 'lists']);
const draft = ref(layout.normalize(props.saved)), saving = ref(false), error = ref('');
const rows = computed(() => layout.arrange(props.shelves, draft.value));

function update(next) {
    const available = new Set(next.map(row => row.id));
    let position = 0;
    const merged = draft.value.map(row => available.has(row.id) ? next[position++] : row);
    draft.value = layout.normalize([...merged, ...next.slice(position)]);
}
function toggle(id) {
    update(rows.value.map(row => row.id === id ? {...row, hidden: !row.hidden} : row));
}
function move(index, step) {
    const next = rows.value.slice();
    next.splice(index + step, 0, next.splice(index, 1)[0]);
    update(next);
}
async function save() {
    if (saving.value) return;
    saving.value = true;
    error.value = '';
    try {
        update(rows.value);
        await props.persist(draft.value);
        emit('close');
    } catch (e) {
        error.value = e.message || 'Не удалось сохранить полки.';
    } finally {
        saving.value = false;
    }
}
</script>
<style scoped>
.shelf-settings {width: 100%; color: var(--app-text);}
.shelf-settings p {color: var(--app-muted); margin: 0 0 14px;}
.shelf-settings ol {list-style: none; padding: 0; margin: 0 0 12px;}
.shelf-settings li {display: flex; align-items: center; gap: 4px; padding: 5px 0; border-bottom: 1px solid var(--app-border);}
.shelf-settings label {display: flex; align-items: center; flex: 1; gap: 10px; min-height: 38px; cursor: pointer; overflow-wrap: anywhere;}
.shelf-settings input {accent-color: var(--app-primary); width: 18px; height: 18px; flex-shrink: 0;}
.shelf-settings li button {background: transparent; border: 0; border-radius: 8px; color: var(--app-text); cursor: pointer; width: 38px; height: 38px; font-size: 19px;}
.shelf-settings li button:disabled {opacity: .28; cursor: default;}
.shelf-settings li button:enabled:hover {background: var(--app-surface-2);}
</style>
