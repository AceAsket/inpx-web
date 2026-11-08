<template>
    <div class="telegram-status" aria-label="Состояние интерактивного бота">
        <template v-if="status">
            <p class="telegram-status__heading" :class="{'telegram-status__heading--error': status.state === 'error'}" role="status"><q-icon :name="status.state === 'error' ? 'la la-exclamation-circle' : 'lab la-telegram-plane'" size="22px" /><strong>{{ labels[status.state] || status.state }}</strong><span v-if="status.username"> · @{{ status.username }}</span></p>
            <p class="telegram-status__scope">Это состояние приёма сообщений. Кнопка «Проверить» отдельно проверяет токен и подключение.</p><p v-if="status.error" role="alert" class="telegram-status__error">
                {{ status.error }}
            </p><p v-if="status.lastPollAt">
                Последний успешный приём обновлений: {{ new Date(status.lastPollAt).toLocaleString('ru') }}
            </p>
        </template><p v-if="error" role="alert">
            {{ error }}
        </p><q-btn flat dense no-caps icon="la la-sync" label="Обновить состояние бота" :loading="loading" @click="load" />
    </div>
</template>
<script setup>
import {ref, onMounted, onBeforeUnmount, getCurrentInstance} from 'vue';
const root = getCurrentInstance().proxy.$root, status = ref(null), error = ref(''), loading = ref(false);
const labels = {disabled: 'Интерактивный бот выключен', connecting: 'Бот подключается к приёму сообщений', running: 'Бот принимает сообщения', error: 'Интерактивный бот не подключён'};
let alive = true, timer, revision = 0;
async function load() {
    const request = ++revision; loading.value = true; error.value = '';
    try {
        const result = await root.api.request({action: 'admin-telegram-bot-status'}, 30);
        if (!alive || request !== revision) return null;
        status.value = result.telegramBotStatus || result; return status.value;
    } catch (e) {if (alive && request === revision) error.value = e.message; return null;}
    finally {if (alive && request === revision) loading.value = false;}
}
defineExpose({refresh:load});
onMounted(() => {load(); timer = setInterval(() => {if (!loading.value) load();}, 10000);});
onBeforeUnmount(() => {alive = false; revision++; clearInterval(timer);});
</script>
<style scoped>
.telegram-status {margin-top: 12px; padding: 12px 14px; border: 1px solid var(--app-border, #d6e3e3); border-radius: 14px; font-size: 12px; color: var(--app-muted, #52696d);}
.telegram-status p {margin: 6px 0; line-height: 1.5; overflow-wrap: anywhere;}
.telegram-status__heading {display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--app-text, #183236);}
.telegram-status__heading .q-icon {color: var(--app-primary, #00796f);}
.telegram-status__heading--error .q-icon {color: #bd7b22;}
.telegram-status__error {color: #d75570;}
</style>
