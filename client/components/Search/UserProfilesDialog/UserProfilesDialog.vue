<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center full-width dialog-header">
                <div style="font-size: 110%">
                    Профили пользователей
                </div>
            </div>
        </template>

        <div class="dialog-box">
            <template v-if="canManageProfiles">
                <div class="section-title">
                    Создать профиль
                </div>

                <div class="profile-grid create-grid">
                    <q-input v-model="newProfile.name" outlined dense clearable label="Имя профиля" />
                    <q-input v-model="newProfile.login" outlined dense clearable label="Логин" />
                    <q-input v-model="newProfile.password" outlined dense clearable type="password" label="Пароль" />
                    <q-input v-model="newProfile.emailTo" outlined dense clearable label="Email для отправки" />
                    <q-input v-model="newProfile.telegramChatId" outlined dense clearable label="Telegram chat id" />
                    <q-toggle class="profile-toggle" v-model="newProfile.opdsEnabled" label="Показывать профиль в OPDS" />
                    <q-btn class="profile-submit" color="primary" dense no-caps @click="createProfile">
                        Создать
                    </q-btn>
                </div>
            </template>

            <div v-else class="admin-note">
                Создавать и удалять профили может только администратор.
            </div>

            <div class="section-title">
                Доступные профили
            </div>

            <div v-if="!profiles.length" class="state-box text-grey-7">
                Профилей пока нет
            </div>

            <div v-else class="profiles-box">
                <div v-for="item in profiles" :key="item.id" class="profile-card">
                    <div class="profile-head">
                        <div class="profile-name">
                            {{ item.name }}
                            <span v-if="item.id === currentUserId" class="current-badge">Текущий</span>
                            <span v-if="item.id === currentUserId && item.requiresLogin && !config.profileAuthorized" class="pending-badge">Вход не выполнен</span>
                            <span v-if="item.isAdmin" class="admin-badge">Admin</span>
                            <span v-if="item.requiresLogin && !item.isAdmin" class="lock-badge">Логин</span>
                        </div>
                        <div class="profile-actions">
                            <q-btn flat dense no-caps color="primary" @click="selectProfile(item)">
                                Выбрать
                            </q-btn>
                            <q-btn
                                v-if="canManageProfiles && !item.isAdmin"
                                flat dense round icon="la la-key" color="warning"
                                @click="resetPassword(item)"
                            />
                            <q-btn
                                v-if="item.id === currentUserId && config.profileAuthorized"
                                flat dense round icon="la la-save" color="primary"
                                @click="saveCurrentProfile"
                            />
                            <q-btn
                                v-if="canManageProfiles && !item.isAdmin"
                                flat dense round icon="la la-trash" color="negative"
                                @click="deleteProfile(item)"
                            />
                        </div>
                    </div>

                    <div v-if="item.id === currentUserId" class="profile-body">
                        <div v-if="!config.profileAuthorized && item.requiresLogin" class="profile-locked">
                            <div>Для редактирования этого профиля войдите по логину и паролю.</div>
                            <q-btn class="q-mt-sm" color="primary" dense no-caps @click="loginCurrentProfile(item)">
                                Войти
                            </q-btn>
                        </div>

                        <div v-else class="profile-grid profile-edit-grid">
                            <q-input v-model="editableProfile.name" outlined dense label="Имя" />
                            <q-input v-model="editableProfile.login" outlined dense clearable label="Логин" />
                            <q-input v-model="editableProfile.password" outlined dense clearable type="password" label="Новый пароль" />
                            <q-input v-model="editableProfile.emailTo" outlined dense clearable label="Email" />
                            <q-input v-model="editableProfile.telegramChatId" outlined dense clearable label="Telegram chat id" />
                            <q-toggle class="profile-toggle" v-model="editableProfile.opdsEnabled" label="Показывать профиль в OPDS" />
                        </div>
                    </div>

                    <div v-if="item.id === currentUserId" class="opds-link">
                        OPDS: <code>{{ opdsUrl(item.publicId || item.id) }}</code>
                    </div>
                </div>
            </div>
        </div>

        <template #footer>
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="dialogVisible = false">
                Закрыть
            </q-btn>
        </template>
    </Dialog>
</template>

<script>
import vueComponent from '../../vueComponent.js';
import Dialog from '../../share/Dialog.vue';

const componentOptions = {
    components: {
        Dialog,
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
            if (newValue)
                this.loadProfiles();// no await
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },
    },
};

class UserProfilesDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };

    dialogVisible = false;
    profiles = [];
    editableProfile = this.makeEmptyEditable();
    newProfile = this.makeEmptyNew();

    created() {
        this.api = this.$root.api;
        this.commit = this.$store.commit;
    }

    get config() {
        return this.$store.state.config;
    }

    get currentUserId() {
        return this.$store.state.settings.currentUserId || this.config.currentUserId || '';
    }

    get currentProfile() {
        return this.config.currentUserProfile || {};
    }

    get canManageProfiles() {
        return !!(this.config.profileAuthorized && this.currentProfile.isAdmin);
    }

    makeEmptyNew() {
        return {
            name: '',
            login: '',
            password: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: true,
        };
    }

    makeEmptyEditable() {
        return {
            name: '',
            login: '',
            password: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: true,
        };
    }

    async refreshConfig() {
        await this.api.updateConfig();
    }

    syncEditableProfile() {
        const current = this.config.currentUserProfile || {};
        this.editableProfile = {
            name: current.name || '',
            login: current.login || '',
            password: '',
            emailTo: current.emailTo || '',
            telegramChatId: current.telegramChatId || '',
            opdsEnabled: current.opdsEnabled !== false,
        };
    }

    async loadProfiles() {
        await this.refreshConfig();
        this.profiles = (this.config.userProfiles || []).map((item) => ({
            id: item.id,
            name: item.name || '',
            login: item.login || '',
            publicId: item.login || item.id,
            requiresLogin: !!item.requiresLogin,
            isAdmin: !!item.isAdmin,
        }));
        this.syncEditableProfile();
    }

    async createProfile() {
        try {
            await this.api.createUserProfile(this.newProfile);
            this.newProfile = this.makeEmptyNew();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async saveCurrentProfile() {
        try {
            await this.api.updateUserProfile(this.currentUserId, this.editableProfile);
            this.editableProfile.password = '';
            await this.loadProfiles();
            this.$root.notify.success('Профиль сохранён');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async deleteProfile(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            `Удалить профиль «${item.name || ''}» вместе со всеми его списками?`,
            'Удаление профиля',
        );
        if (!confirmed)
            return;

        try {
            const result = await this.api.deleteUserProfile(item.id);
            if (item.id === this.currentUserId) {
                this.commit('setSettings', {
                    currentUserId: result.nextUserId || '',
                    profileAccessToken: '',
                });
            }
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async resetPassword(item) {
        const prompt = await this.$root.stdDialog.password(
            `Введите новый пароль для профиля «${item.name || ''}»:`,
            'Сброс пароля',
            {
                inputValidator: (value) => (String(value || '') ? true : 'Пароль не должен быть пустым'),
            },
        );
        if (!prompt || prompt === false)
            return;

        try {
            await this.api.updateUserProfile(item.id, {
                password: String(prompt.value || ''),
            });
            this.$root.notify.success(`Пароль профиля «${item.name || ''}» обновлён`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async selectProfile(item) {
        const currentToken = this.$store.state.settings.profileAccessToken;
        if (currentToken) {
            try {
                await this.api.logoutUserProfile();
            } catch (e) {
                // Ignore stale profile session cleanup errors while switching profiles.
            }
        }

        this.commit('setSettings', {
            currentUserId: item.id,
            profileAccessToken: '',
        });
        await this.refreshConfig();

        if (item.requiresLogin) {
            try {
                await this.api.showProfileLoginDialog(item.login || '');
            } catch (e) {
                this.$root.stdDialog.alert(e.message, 'Ошибка');
            }
        }

        await this.loadProfiles();
    }

    async loginCurrentProfile(item) {
        try {
            await this.api.showProfileLoginDialog(item.login || '');
            await this.loadProfiles();
        } catch (e) {
            if (e.message !== 'Вход в профиль отменён')
                this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    opdsUrl(userId) {
        const root = this.config.opdsRoot || '/opds';
        return `${window.location.origin}${root}?user=${encodeURIComponent(userId)}`;
    }
}

export default vueComponent(UserProfilesDialog);
</script>

<style scoped>
.dialog-box {
    width: min(760px, 92vw);
    max-height: min(82vh, 860px);
    padding: 10px 12px 12px;
    overflow-y: auto;
    overflow-x: hidden;
}

.dialog-header {
    justify-content: space-between;
}

.section-title {
    margin: 4px 0 10px;
    font-size: 15px;
    font-weight: 700;
}

.create-grid,
.profile-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    align-items: center;
    min-width: 0;
}

.create-grid :deep(.q-toggle),
.profile-grid :deep(.q-toggle),
.profile-submit {
    grid-column: span 2;
}

.profile-edit-grid {
    margin-top: 6px;
}

.profile-toggle {
    padding-top: 2px;
}

.profiles-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.profile-card {
    border: 1px solid var(--app-border);
    border-radius: 14px;
    background: var(--app-surface);
    padding: 14px;
}

.profile-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    margin-bottom: 10px;
    min-width: 0;
}

.profile-name {
    font-weight: 700;
    min-width: 0;
    overflow-wrap: anywhere;
}

.profile-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: flex-end;
    flex-shrink: 0;
}

.current-badge,
.pending-badge,
.lock-badge,
.admin-badge {
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
}

.current-badge {
    background: rgba(15, 159, 143, 0.1);
    color: var(--app-link);
}

.admin-badge {
    background: rgba(201, 140, 0, 0.14);
    color: #c98c00;
}

.pending-badge {
    background: rgba(201, 140, 0, 0.14);
    color: #c98c00;
}

.lock-badge {
    background: rgba(31, 111, 191, 0.1);
    color: #1f6fbf;
}

.profile-body {
    margin-bottom: 8px;
}

.profile-locked {
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(31, 111, 191, 0.08);
    color: var(--app-text);
}

.admin-note {
    margin-bottom: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(201, 140, 0, 0.12);
    color: var(--app-text);
}

.opds-link {
    margin-top: 10px;
    font-size: 12px;
    color: var(--app-muted);
    word-break: break-all;
}

.state-box {
    padding: 18px 8px;
}

@media (max-width: 820px) {
    .create-grid,
    .profile-grid {
        grid-template-columns: 1fr;
    }

    .create-grid :deep(.q-toggle),
    .profile-grid :deep(.q-toggle),
    .profile-submit {
        grid-column: span 1;
    }

    .profile-head {
        flex-direction: column;
        align-items: flex-start;
    }

    .profile-actions {
        width: 100%;
        justify-content: flex-start;
    }
}
</style>
