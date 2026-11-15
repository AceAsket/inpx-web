<template>
    <section class="kosync-settings" aria-label="Синхронизация с KOReader">
        <h3>KOReader</h3>
        <p>Синхронизация позиции чтения между KOReader и INPX Web.</p>
        <p v-if="loading" role="status">
            Загрузка настроек…
        </p>
        <p v-if="error" role="alert" class="text-negative">
            {{ error }}
        </p>
        <p v-if="passwordSaved" role="status">
            Пароль KOReader сохранён.
        </p>
        <template v-if="settings">
            <p v-if="!settings.available">
                KOSync выключен при запуске сервера.
            </p>
            <template v-else>
                <div v-if="settings.enabled" class="kosync-fields">
                    <label>Сервер синхронизации<input :value="serverUrl" readonly @click="$event.target.select()"></label>
                    <label>Имя пользователя<input :value="settings.username" readonly @click="$event.target.select()"></label>
                    <label v-if="password" class="kosync-generated">Пароль KOReader — сохраните сейчас<input :value="password" readonly autocomplete="off" @click="$event.target.select()"></label>
                </div>
                <p v-if="settings.webPasswordChanged" role="status">
                    Пароль INPX Web изменился. Подтвердите текущий пароль для KOReader.
                </p>
                <div v-if="!editingPassword" class="kosync-actions">
                    <q-btn outline no-caps color="primary" :disable="loading" :label="settings.enabled ? 'Изменить пароль' : 'Подключить KOReader'" @click="openPasswordForm" />
                    <q-btn flat no-caps color="primary" :disable="loading" label="Сгенерировать пароль" @click="change('enable')" />
                    <q-btn v-if="settings.enabled" flat no-caps color="negative" :disable="loading" label="Отключить" @click="change('disable')" />
                </div>
                <form v-else class="kosync-password-form" @submit.prevent="savePassword">
                    <q-checkbox v-if="settings.hasWebPassword" v-model="useWebPassword" :disable="loading" dense
                        label="Использовать пароль INPX Web" @update:model-value="clearPasswordInput" />
                    <q-input
                        v-model="inputPassword" outlined dense :disable="loading"
                        :type="passwordVisible ? 'text' : 'password'" :maxlength="useWebPassword ? 4096 : 128"
                        :autocomplete="useWebPassword ? 'section-koreader current-password' : 'section-koreader new-password'"
                        autocapitalize="none" spellcheck="false"
                        :label="useWebPassword ? 'Пароль INPX Web' : 'Новый пароль KOReader'"
                        :hint="useWebPassword ? 'Подтвердите пароль профиля для синхронизации.' : 'От 6 до 128 символов.'"
                    >
                        <template #append>
                            <q-btn flat round dense :icon="passwordVisible ? 'la la-eye-slash' : 'la la-eye'"
                                :aria-label="passwordVisible ? 'Скрыть пароль KOReader' : 'Показать пароль KOReader'"
                                @click="passwordVisible = !passwordVisible" />
                        </template>
                    </q-input>
                    <div class="kosync-actions">
                        <q-btn unelevated no-caps color="primary" type="submit" label="Сохранить" aria-label="Сохранить пароль" :disable="!canSavePassword" :loading="loading" />
                        <q-btn flat no-caps :disable="loading" label="Отмена" @click="closePasswordForm" />
                    </div>
                </form>
                <p v-if="settings.enabled">
                    В KOReader: «Синхронизация прогресса» → свой сервер → войти с этими данными. Выберите сопоставление по содержимому. Книгу один раз скачайте через этот сервер, например из OPDS.
                </p>
                <p v-if="settings.enabled">
                    Для FB2 позиция переносится по абзацу. Перед отправкой прогресса получите актуальную позицию. После смены пароля войдите заново на устройствах с KOReader.
                </p>
            </template>
        </template>
    </section>
</template>

<script>
export default {
    props: {userId: {type: String, required: true}},
    data: () => ({settings: null, password: '', loading: false, error: '', generation: 0,
        editingPassword: false, useWebPassword: false, inputPassword: '', passwordVisible: false, passwordSaved: false}),
    computed: {
        serverUrl() { return window.location.origin + (this.settings?.path || '/kosync'); },
        canSavePassword() {
            if (this.loading) return false;
            return this.useWebPassword ? !!this.inputPassword : this.inputPassword.trim().length >= 6 && this.inputPassword.length <= 128;
        },
    },
    watch: {userId() { this.settings = null; this.closePasswordForm(); this.change('status'); }},
    mounted() { this.change('status'); },
    beforeUnmount() { this.generation++; this.password = ''; this.closePasswordForm(); },
    methods: {
        openPasswordForm() {
            this.useWebPassword = this.settings.hasWebPassword && (!this.settings.enabled || this.settings.usesWebPassword);
            this.clearPasswordInput();
            this.passwordSaved = false;
            this.editingPassword = true;
        },
        clearPasswordInput() {
            this.inputPassword = '';
            this.passwordVisible = false;
            this.error = '';
        },
        closePasswordForm() {
            this.editingPassword = false;
            this.clearPasswordInput();
        },
        savePassword() {
            if (this.canSavePassword) return this.change(this.useWebPassword ? 'use-web-password' : 'set-password', this.inputPassword);
        },
        async change(operation, newPassword) {
            const generation = ++this.generation;
            this.loading = true; this.error = ''; this.password = ''; this.passwordSaved = false;
            try {
                const result = await this.$root.api.koSyncSettings(operation, newPassword);
                if (generation !== this.generation) return;
                this.password = result.password || '';
                const {password, ...settings} = result; // eslint-disable-line no-unused-vars
                this.settings = settings;
                if (operation === 'set-password' || operation === 'use-web-password') {
                    this.closePasswordForm();
                    this.passwordSaved = true;
                }
            } catch (error) { if (generation === this.generation) this.error = error.message || String(error); }
            finally { if (generation === this.generation) this.loading = false; }
        },
    },
};
</script>

<style scoped>
.kosync-settings p {
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
}

.kosync-fields {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 10px;
    margin: 2px 0;
}

.kosync-generated {grid-column: 1 / -1;}

@media (max-width: 600px) {
    .kosync-fields {grid-template-columns: minmax(0, 1fr);}
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
    margin: 2px 0;
}

.kosync-password-form .q-checkbox {margin-bottom: 8px;}
.kosync-password-form .kosync-actions {margin: 8px 0 0;}
</style>
