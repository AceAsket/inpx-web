<template>
    <div class="telegram-status" aria-label="Состояние интерактивного бота">
        <template v-if="status">
            <p><strong>{{ labels[status.state] || status.state }}</strong><span v-if="status.username"> · @{{ status.username }}</span></p><p v-if="status.error" role="alert">
                {{ status.error }}
            </p><p v-if="status.lastPollAt">
                Последнее подключение: {{ new Date(status.lastPollAt).toLocaleString('ru') }}
            </p>
        </template><p v-if="error" role="alert">
            {{ error }}
        </p><q-btn flat dense no-caps icon="la la-sync" label="Обновить состояние бота" :loading="loading" @click="load" />
    </div>
</template>
<script setup>
import {ref, onMounted, onBeforeUnmount, getCurrentInstance} from 'vue';
const root = getCurrentInstance().proxy.$root, status = ref(null), error = ref(''), loading = ref(false);
const labels = {disabled: 'Интерактивный бот выключен', connecting: 'Подключаемся к Telegram', running: 'Интерактивный бот работает', error: 'Не удалось подключиться'};
let alive = true, timer;
async function load() {
    if (loading.value) return; loading.value = true; error.value = '';
    try {const result = await root.api.request({action: 'admin-telegram-bot-status'}, 30); if (alive) status.value = result;}
    catch (e) {if (alive) error.value = e.message;}
    finally {if (alive) loading.value = false;}
}
onMounted(() => {load(); timer = setInterval(load, 10000);});
onBeforeUnmount(() => {alive = false; clearInterval(timer);});
</script>
<style scoped>.telegram-status {margin-top: 12px; font-size: 12px; color: var(--app-muted, #52696d);}.telegram-status p {margin: 6px 0; line-height: 1.5; overflow-wrap: anywhere;}</style>
