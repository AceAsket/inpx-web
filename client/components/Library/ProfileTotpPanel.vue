<template>
    <section class="profile-totp" aria-label="Двухфакторная авторизация">
        <button class="profile-totp__heading" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
            <q-icon name="la la-shield-alt" size="25px" aria-hidden="true" />
            <span>Двухфакторная авторизация</span>
            <q-icon :name="expanded ? 'la la-angle-up' : 'la la-angle-down'" aria-hidden="true" />
        </button>
        <div v-if="expanded" class="profile-totp__body" :aria-busy="busy">
            <p v-if="error" role="alert">{{ error }}</p>
            <p v-if="!status && busy" role="status">Загружаем состояние…</p>
            <q-btn v-if="!status && error" flat no-caps label="Повторить" @click="run('status')" />
            <template v-if="status">
                <p>{{ status.otpEnabled ? 'Включена' : 'Выключена' }}<span v-if="status.otpEnabled"> · резервных кодов: {{ status.recoveryCodesRemaining }}</span></p>
                <p v-if="status.otpRequired">Для этого профиля администратор требует двухфакторный вход.</p>
                <p v-if="config.profileBoundId">Второй фактор для входа через SSO настраивается у провайдера входа.</p>
                <p v-else-if="!config.currentUserProfile?.hasPassword">Чтобы включить двухфакторный вход, сначала задайте пароль профиля.</p>
                <template v-else>
                    <form v-if="operation" class="profile-totp__form" @focusout.capture="syncFields($event.currentTarget)" @submit.prevent="submit">
                        <template v-if="setup">
                            <p>Отсканируйте QR-код приложением-аутентификатором или введите ключ вручную.</p>
                            <img v-if="qr" :src="qr" alt="QR-код настройки аутентификатора" width="180" height="180" />
                            <code class="profile-totp__code">{{ setup.secret }}</code>
                            <p>Для входа в нативный INPX Reader понадобится версия с полем одноразового кода. Для OPDS можно создать отдельный пароль после включения OTP.</p>
                        </template>
                        <q-input v-model="password" name="password" type="password" label="Текущий пароль профиля" autocomplete="current-password" outlined dense :disable="busy" />
                        <q-input v-if="operation !== 'start'" v-model="code" :label="operation === 'enable' ? 'Код из приложения' : 'Код из приложения или резервный код'"
                            name="otp" :inputmode="operation === 'enable' ? 'numeric' : undefined" autocomplete="one-time-code" autocapitalize="off" spellcheck="false"
                            maxlength="64" outlined dense :disable="busy" />
                        <div class="profile-totp__actions">
                            <q-btn color="primary" unelevated no-caps type="submit" :label="labels[operation]" :loading="busy" />
                            <q-btn flat no-caps label="Отмена" :disable="busy" @click="resetForm" />
                        </div>
                    </form>
                    <div v-else class="profile-totp__actions">
                        <q-btn v-if="!status.otpEnabled" color="primary" unelevated no-caps label="Настроить OTP" @click="choose('start')" />
                        <template v-else>
                            <q-btn outline no-caps label="Обновить резервные коды" @click="choose('regenerate-recovery')" />
                            <q-btn v-if="!status.otpRequired" outline no-caps color="negative" label="Отключить OTP" @click="choose('disable')" />
                            <q-btn v-if="status.trustedDeviceCount > 0" outline no-caps :label="`Отозвать доверие к устройствам (${status.trustedDeviceCount})`"
                                @click="choose('revoke-trusted-devices')" />
                            <q-btn v-if="config.currentUserProfile?.opdsEnabled" outline no-caps :label="status.opdsAppPasswordSet ? 'Заменить пароль OPDS' : 'Создать пароль OPDS'"
                                @click="choose('create-opds-password')" />
                            <q-btn v-if="status.opdsAppPasswordSet" flat no-caps label="Отозвать пароль OPDS" @click="choose('revoke-opds-password')" />
                        </template>
                    </div>
                    <div v-if="recoveryCodes.length" class="profile-totp__result" role="status">
                        <p>Сохраните резервные коды. Каждый можно использовать один раз. Эти коды показываются только сейчас.</p>
                        <ul><li v-for="entry in recoveryCodes" :key="entry"><code>{{ entry }}</code></li></ul>
                        <q-btn flat no-caps label="Коды сохранены" @click="recoveryCodes = []" />
                    </div>
                    <div v-if="opdsPassword" class="profile-totp__result" role="status">
                        <p>Вставьте этот пароль в клиент OPDS вместе с логином профиля. Пароль показывается один раз.</p>
                        <code class="profile-totp__code">{{ opdsPassword }}</code>
                        <q-btn flat no-caps label="Пароль сохранён" @click="opdsPassword = ''" />
                    </div>
                </template>
            </template>
        </div>
    </section>
</template>

<script setup>
import {computed, getCurrentInstance, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import {useStore} from 'vuex';

const root = getCurrentInstance().proxy.$root, store = useStore();
const config = computed(() => store.state.config);
const expanded = ref(false), busy = ref(false), error = ref(''), status = ref(null);
const operation = ref(''), password = ref(''), code = ref(''), setup = ref(null), qr = ref('');
const recoveryCodes = ref([]), opdsPassword = ref('');
const labels = {start: 'Получить QR-код', enable: 'Включить OTP', disable: 'Подтвердить отключение',
    'regenerate-recovery': 'Создать новые коды', 'create-opds-password': 'Создать пароль OPDS',
    'revoke-opds-password': 'Подтвердить отзыв', 'revoke-trusted-devices': 'Отозвать доверие ко всем устройствам'};
let revision = 0;

function resetForm() {
    operation.value = password.value = code.value = qr.value = '';
    setup.value = null;
}

function clear() {
    revision++;
    resetForm();
    busy.value = false;
    status.value = null;
    error.value = opdsPassword.value = '';
    recoveryCodes.value = [];
}

function choose(action) {
    error.value = '';
    recoveryCodes.value = [];
    opdsPassword.value = '';
    operation.value = action;
}

function syncFields(form) {
    if (busy.value) return;
    const fields = new FormData(form);
    password.value = String(fields.get('password') || '');
    code.value = String(fields.get('otp') || '');
}

async function submit(event) {
    syncFields(event.currentTarget);
    if (!password.value || (operation.value !== 'start' && !code.value.trim())) {
        error.value = operation.value === 'start' ? 'Введите пароль профиля.' : 'Введите пароль и код.';
        return;
    }
    await run(operation.value, {password: password.value, code: code.value.trim()});
}

async function run(action, payload) {
    if (busy.value) return;
    const request = revision;
    busy.value = true;
    error.value = '';
    try {
        const result = await root.api.profileTotp(action, payload);
        if (request !== revision) return;
        if (action === 'start') {
            setup.value = {secret: result.secret};
            operation.value = 'enable';
            try {
                const module = await import('qrcode');
                const image = await (module.default || module).toDataURL(result.otpAuthUri, {width: 180, margin: 4});
                if (request === revision) qr.value = image;
            } catch { /* The setup key can be entered manually. */ }
            return;
        }
        status.value = {
            otpEnabled: result.otpEnabled ?? status.value?.otpEnabled,
            otpRequired: result.otpRequired ?? status.value?.otpRequired,
            recoveryCodesRemaining: result.recoveryCodesRemaining ?? result.recoveryCodes?.length ?? status.value?.recoveryCodesRemaining,
            opdsAppPasswordSet: result.opdsAppPasswordSet ?? status.value?.opdsAppPasswordSet,
            trustedDeviceCount: result.trustedDeviceCount ?? status.value?.trustedDeviceCount,
        };
        recoveryCodes.value = result.recoveryCodes || [];
        opdsPassword.value = result.opdsAppPassword || '';
        resetForm();
    } catch (failure) {
        if (request === revision) error.value = failure.code === 'INPX_INVALID_PROFILE_CREDENTIALS' && action !== 'start'
            ? 'Проверьте пароль и код. Если код уже использован, дождитесь следующего.' : failure.message;
    } finally {
        if (request === revision) {
            password.value = code.value = '';
            busy.value = false;
        }
    }
}

watch([expanded, () => config.value.currentUserId, () => config.value.profileAuthorized, () => store.state.settings.profileAccessToken], () => {
    clear();
    if (expanded.value && config.value.profileAuthorized) run('status');
});
onActivated(() => {if (expanded.value) run('status');});
onDeactivated(clear);
onBeforeUnmount(clear);
</script>

<style scoped>
.profile-totp {grid-column: 1 / -1; border: 1px solid var(--app-border); border-radius: 16px; overflow: hidden; background: var(--app-surface);}
.profile-totp__heading {display: flex; gap: 14px; align-items: center; width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 18px; cursor: pointer; font: inherit; font-weight: 550;}
.profile-totp__heading span {flex: 1;}
.profile-totp__body {padding: 0 18px 18px; font-size: 14px;}
.profile-totp__form {display: grid; gap: 12px; max-width: 420px;}
.profile-totp__form p {margin: 0;}
.profile-totp__actions {display: flex; flex-wrap: wrap; gap: 8px;}
.profile-totp__result {margin-top: 16px; padding: 12px; border-radius: 12px; background: var(--app-surface-2);}
.profile-totp__result ul {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 8px; list-style: none; margin: 0 0 8px; padding: 0;}
.profile-totp__code {display: block; overflow-wrap: anywhere; user-select: all;}
</style>
