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
            <div class="create-row">
                <q-input
                    v-model="newProfile.name"
                    class="col"
                    outlined
                    dense
                    clearable
                    label="Имя профиля"
                />
                <q-input
                    v-model="newProfile.emailTo"
                    class="col"
                    outlined
                    dense
                    clearable
                    label="Email для отправки"
                />
                <q-input
                    v-model="newProfile.telegramChatId"
                    class="col"
                    outlined
                    dense
                    clearable
                    label="Telegram chat id"
                />
                <q-toggle v-model="newProfile.opdsEnabled" label="В OPDS" />
                <q-btn color="primary" dense no-caps @click="createProfile">
                    Создать
                </q-btn>
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
                        </div>
                        <div class="profile-actions">
                            <q-btn flat dense no-caps color="primary" @click="selectProfile(item.id)">
                                Выбрать
                            </q-btn>
                            <q-btn flat dense round icon="la la-save" color="primary" @click="saveProfile(item)" />
                            <q-btn flat dense round icon="la la-trash" color="negative" @click="deleteProfile(item)" />
                        </div>
                    </div>

                    <div class="profile-fields">
                        <q-input v-model="item.name" outlined dense label="Имя" />
                        <q-input v-model="item.emailTo" outlined dense label="Email" />
                        <q-input v-model="item.telegramChatId" outlined dense label="Telegram chat id" />
                        <q-toggle v-model="item.opdsEnabled" label="Показывать в OPDS" />
                    </div>

                    <div class="opds-link">
                        OPDS: <code>{{ opdsUrl(item.id) }}</code>
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
    newProfile = {
        name: '',
        emailTo: '',
        telegramChatId: '',
        opdsEnabled: true,
    };

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

    resetNewProfile() {
        this.newProfile = {
            name: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: true,
        };
    }

    async refreshConfig() {
        await this.api.updateConfig();
    }

    async loadProfiles() {
        await this.refreshConfig();
        this.profiles = (this.config.userProfiles || []).map((item) => ({
            id: item.id,
            name: item.name || '',
            emailTo: item.emailTo || '',
            telegramChatId: item.telegramChatId || '',
            opdsEnabled: item.opdsEnabled !== false,
        }));
    }

    async createProfile() {
        try {
            await this.api.createUserProfile(this.newProfile);
            this.resetNewProfile();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async saveProfile(item) {
        try {
            await this.api.updateUserProfile(item.id, {
                name: item.name,
                emailTo: item.emailTo,
                telegramChatId: item.telegramChatId,
                opdsEnabled: item.opdsEnabled,
            });
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async deleteProfile(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            `Удалить профиль «${item.name}» вместе со всеми его списками?`,
            'Удаление профиля',
        );
        if (!confirmed)
            return;

        try {
            const result = await this.api.deleteUserProfile(item.id);
            if (this.currentUserId === item.id && result.nextUserId)
                this.commit('setSettings', {currentUserId: result.nextUserId});
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async selectProfile(userId) {
        this.commit('setSettings', {currentUserId: userId});
        await this.refreshConfig();
        this.$root.notify.success('Профиль переключен');
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
    width: min(820px, 94vw);
    max-height: min(76vh, 820px);
    padding: 8px 10px 10px;
    overflow: auto;
}

.dialog-header {
    justify-content: space-between;
}

.create-row,
.profile-fields {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
    align-items: center;
}

.state-box {
    padding: 18px 8px;
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
    padding: 12px;
}

.profile-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    margin-bottom: 10px;
}

.profile-name {
    font-weight: 700;
}

.profile-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.current-badge {
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.1);
    color: var(--app-link);
    font-size: 11px;
    font-weight: 700;
}

.opds-link {
    margin-top: 10px;
    font-size: 12px;
    color: var(--app-muted);
    word-break: break-all;
}

@media (max-width: 900px) {
    .create-row,
    .profile-fields {
        grid-template-columns: 1fr;
    }
}
</style>
