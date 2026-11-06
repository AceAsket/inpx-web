<template>
    <section class="telegram-account" aria-label="Telegram-бот">
        <button class="telegram-account__heading" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
            <q-icon name="lab la-telegram-plane" size="25px" /><span><strong>Telegram-бот</strong><small>{{ status?.linked ? 'Профиль подключён' : 'Поиск и получение книг в Telegram' }}</small></span><q-icon :name="expanded ? 'la la-angle-up' : 'la la-angle-down'" />
        </button>
        <div v-if="expanded" class="telegram-account__body">
            <p v-if="error" role="alert">
                {{ error }} <button type="button" @click="load">
                    Повторить
                </button>
            </p>
            <p v-if="!status && !error" role="status">
                Загружаем состояние…
            </p>
            <template v-if="status">
                <p v-if="!status.enabled">
                    Интерактивный бот выключен. Администратор может включить его в настройках Telegram.
                </p>
                <template v-else>
                    <p v-if="status.linked">
                        Этот профиль подключён к личному чату {{ status.chatId }}<span v-if="status.username"> у @{{ status.username }}</span>.
                    </p>
                    <p v-else>
                        Подключите свой личный чат, чтобы искать книги, получать файлы и открывать свои списки. Ссылка действует 10 минут и используется один раз.
                    </p>
                    <div class="telegram-account__actions">
                        <q-btn v-if="!status.linked" color="primary" no-caps unelevated label="Подключить Telegram" :loading="busy" @click="connect" /><q-btn v-else outline no-caps label="Отключить Telegram" :loading="busy" @click="disconnect" /><q-btn flat no-caps label="Обновить состояние" :disable="busy" @click="load" />
                    </div>
                    <div v-if="link" class="telegram-account__link" role="status">
                        <a :href="link.url" target="_blank" rel="noopener noreferrer">Открыть бота и подключить профиль <q-icon name="la la-external-link-alt" /></a><p>В Telegram нажмите «Запустить». Ждём подтверждения…</p>
                    </div>
                    <q-toggle v-if="status.linked" :model-value="status.digest" :disable="busy" label="Еженедельная подборка новинок моих подписок" @update:model-value="digest" />
                    <p v-if="status.linked" class="telegram-account__hint">
                        Команды: /search, /reading, /lists, /favorites, /following.
                    </p>
                </template>
            </template>
        </div>
    </section>
</template>
<script setup>
import {ref, computed, watch, onBeforeUnmount, onActivated, onDeactivated, getCurrentInstance} from 'vue';
import {useStore} from 'vuex';
const root = getCurrentInstance().proxy.$root, store = useStore();
const status = ref(null), error = ref(''), expanded = ref(false), busy = ref(false), link = ref(null);
const identity = computed(() => `${store.state.config.profileAuthorized}:${store.state.config.currentUserProfile?.id || ''}`);
let revision = 0, timer, alive = true;
async function load() {
    const request = ++revision; error.value = '';
    try {
        const result = await root.api.telegramBotAccount('status');
        if (!alive || request !== revision) return;
        status.value = result;
        if (result.linked && link.value) {link.value = null; clearTimeout(timer); await root.api.updateConfig();}
    } catch (e) {if (alive && request === revision) error.value = e.message;}
}
async function poll() {
    if (!link.value || !alive) return;
    if (Date.parse(link.value.expiresAt) <= Date.now()) {link.value = null; error.value = 'Ссылка истекла. Создайте новую.'; return;}
    await load(); if (link.value && alive) timer = setTimeout(poll, 3000);
}
async function connect() {
    if (busy.value) return; busy.value = true; error.value = ''; const request = revision;
    try {
        const result = await root.api.telegramBotAccount('link');
        if (!alive || request !== revision) return;
        const url = new URL(result.url);
        if (url.protocol !== 'https:' || url.hostname !== 't.me') throw new Error('Некорректная ссылка бота');
        link.value = result; clearTimeout(timer); timer = setTimeout(poll, 3000);
    } catch (e) {if (alive && request === revision) error.value = e.message;}
    finally {busy.value = false;}
}
async function disconnect() {
    if (!await root.stdDialog.confirm('Отключить этот Telegram от личного профиля?', 'Telegram-бот')) return;
    busy.value = true;
    try {await root.api.telegramBotAccount('unlink'); link.value = null; clearTimeout(timer); await load(); await root.api.updateConfig();}
    catch (e) {error.value = e.message;} finally {busy.value = false;}
}
async function digest(enabled) {
    busy.value = true;
    try {await root.api.telegramBotAccount('digest', {enabled}); await load();}
    catch (e) {error.value = e.message;} finally {busy.value = false;}
}
watch([identity, expanded], () => {
    clearTimeout(timer); revision++; link.value = null; status.value = null; error.value = '';
    if (expanded.value && store.state.config.profileAuthorized) load();
});
onDeactivated(() => {revision++; clearTimeout(timer); link.value = null;});
onActivated(() => {if (expanded.value && store.state.config.profileAuthorized) load();});
onBeforeUnmount(() => {alive = false; revision++; clearTimeout(timer); link.value = null;});
</script>
<style scoped>
.telegram-account {border: 1px solid var(--app-border, #d6e3e3); border-radius: 16px; overflow: hidden; background: var(--app-surface, white); grid-column: 1 / -1;}
.telegram-account__heading {display: flex; gap: 14px; align-items: center; width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 18px; cursor: pointer; font: inherit;}
.telegram-account__heading > span {flex: 1; min-width: 0;}
.telegram-account__heading strong {display: block; font-size: 15px; font-weight: 550;}
.telegram-account small {display: block; color: var(--app-muted, #52696d); font-size: 12px; margin-top: 4px;}
.telegram-account__body {padding: 0 18px 18px;}
.telegram-account p {font-size: 13px; line-height: 1.65; overflow-wrap: anywhere;}
.telegram-account__actions {display: flex; flex-wrap: wrap; gap: 10px;}
.telegram-account__link {padding: 14px; background: var(--app-surface-2, #d7eeea); border-radius: 12px; margin: 16px 0;}
.telegram-account a {color: var(--app-primary, #00796f);}
.telegram-account__hint {color: var(--app-muted, #52696d);}
</style>
