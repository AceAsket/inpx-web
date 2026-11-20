<template>
    <q-btn outline no-caps icon="la la-download" :disable="busy || disabled" :label="busy ? status : label"
           aria-live="polite" @click.stop="download" />
</template>

<script setup>
import {computed, getCurrentInstance, ref} from 'vue';

const props = defineProps({series:{type:String, required:true}, api:{type:Object, required:true},
    label:{type:String, default:'Скачать всю серию в ZIP'}, disabled:Boolean});
const emit = defineEmits(['busy']);
const root = getCurrentInstance().proxy.$root;
const busy = ref(false), progress = ref(null);
const status = computed(() => {
    if (!progress.value?.total) return 'Подготовка ZIP…';
    const {done,total} = progress.value;
    if (done === total) return 'Завершение ZIP…';
    return `ZIP · ${done} из ${total} · ${Math.floor(done * 100 / total)}%`;
});

async function download() {
    if (busy.value || props.disabled) return;
    busy.value = true;
    progress.value = null;
    emit('busy', true);
    try {
        await props.api.downloadBatch({series:props.series}, update => {progress.value = update;});
    } catch (error) {
        root.stdDialog.alert(error.message, 'Скачать серию');
    } finally {
        busy.value = false;
        emit('busy', false);
    }
}
</script>
