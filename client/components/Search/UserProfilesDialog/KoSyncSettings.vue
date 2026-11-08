<template>
    <section class="kosync-settings" aria-label="Синхронизация с KOReader">
        <strong>KOReader</strong>
        <p>Позиция чтения между KOReader и INPX Web. Подключение использует отдельный ключ этого профиля.</p>
        <p v-if="loading" role="status">
            Загрузка настроек…
        </p>
        <p v-if="error" role="alert" class="text-negative">
            {{ error }}
        </p>
        <template v-if="settings">
            <p v-if="!settings.available">
                KOSync выключен при запуске сервера.
            </p>
            <template v-else>
                <div v-if="settings.enabled" class="kosync-fields">
                    <label>Сервер синхронизации<input :value="serverUrl" readonly @click="$event.target.select()"></label>
                    <label>Имя пользователя<input :value="settings.username" readonly @click="$event.target.select()"></label>
                    <label v-if="password">Пароль KOReader — сохраните сейчас<input :value="password" readonly autocomplete="off" @click="$event.target.select()"></label>
                </div>
                <div class="kosync-actions">
                    <q-btn outline no-caps color="primary" :disable="loading" :label="settings.enabled ? 'Создать новый ключ' : 'Подключить KOReader'" @click="change('enable')" />
                    <q-btn v-if="settings.enabled" flat no-caps color="negative" :disable="loading" label="Отключить" @click="change('disable')" />
                </div>
                <p v-if="settings.enabled">
                    В KOReader: «Синхронизация прогресса» → свой сервер → войти с этими данными. Выберите сопоставление по содержимому. Книгу один раз скачайте через этот сервер, например из OPDS.
                </p>
                <p v-if="settings.enabled">
                    Для FB2 позиция переносится по абзацу. Перед отправкой прогресса получите актуальную позицию. Новый ключ отключит старый на всех устройствах.
                </p>
            </template>
        </template>
    </section>
</template>

<script>
export default {
    props: {userId: {type: String, required: true}},
    data: () => ({settings: null, password: '', loading: false, error: '', generation: 0}),
    computed: {serverUrl() { return window.location.origin + (this.settings?.path || '/kosync'); }},
    watch: {userId() { this.settings = null; this.password = ''; this.change('status'); }},
    mounted() { this.change('status'); },
    beforeUnmount() { this.generation++; this.password = ''; },
    methods: {
        async change(operation) {
            const generation = ++this.generation;
            this.loading = true; this.error = ''; this.password = '';
            try {
                const result = await this.$root.api.koSyncSettings(operation);
                if (generation !== this.generation) return;
                this.password = result.password || '';
                const {password, ...settings} = result; // eslint-disable-line no-unused-vars
                this.settings = settings;
            } catch (error) { if (generation === this.generation) this.error = error.message || String(error); }
            finally { if (generation === this.generation) this.loading = false; }
        },
    },
};
</script>

<style scoped>
.kosync-settings {
    grid-column: 1/-1;
    padding-top: 16px;
    border-top: 1px solid #8885;
}

.kosync-settings p {
    font-size: 13px;
    line-height: 1.5;
    margin: 8px 0;
}

.kosync-fields {
    display: grid;
    gap: 10px;
    margin: 12px 0;
}

.kosync-fields label {
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: 13px;
}

.kosync-fields input {
    width: 100%;
    min-width: 0;
    padding: 10px;
    border: 1px solid #8887;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
}

.kosync-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
}
</style>
