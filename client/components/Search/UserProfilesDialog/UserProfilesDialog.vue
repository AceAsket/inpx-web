<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center full-width dialog-header">
                <div style="font-size: 110%">
                    {{ uiText.dialogTitle }}
                </div>
            </div>
        </template>

        <div class="dialog-box">
            <template v-if="canManageProfiles">
                <div class="section-title">
                    {{ uiText.createProfile }}
                </div>

                <div class="profile-grid create-grid">
                    <q-input v-model="newProfile.name" outlined dense clearable :label="uiText.profileName" />
                    <q-input v-model="newProfile.login" outlined dense clearable :label="uiText.login" />
                    <q-input v-model="newProfile.password" outlined dense clearable type="password" :label="uiText.password" />
                    <q-input v-model="newProfile.emailTo" outlined dense clearable :label="uiText.emailTo" />
                    <q-input v-model="newProfile.telegramChatId" outlined dense clearable label="Telegram chat id" />
                    <q-toggle class="profile-toggle" v-model="newProfile.opdsEnabled" :label="uiText.showProfileInOpds" />
                    <q-btn class="profile-submit" color="primary" dense no-caps @click="createProfile">
                        {{ uiText.create }}
                    </q-btn>
                </div>
            </template>

            <div v-else class="admin-note">
                {{ uiText.adminOnly }}
            </div>

            <div class="section-title">
                {{ uiText.availableProfiles }}
            </div>

            <div v-if="!canViewAllProfiles" class="profile-session-actions">
                <q-btn flat dense no-caps color="primary" icon="la la-sign-in-alt" @click="loginOtherProfile">
                    {{ uiText.loginOtherProfile }}
                </q-btn>
                <q-btn
                    v-if="config.profileAuthorized"
                    flat
                    dense
                    no-caps
                    color="warning"
                    icon="la la-sign-out-alt"
                    @click="logoutCurrentProfile"
                >
                    {{ uiText.logout }}
                </q-btn>
            </div>

            <div v-if="!profiles.length" class="state-box text-grey-7">
                {{ uiText.noProfiles }}
            </div>

            <div v-else class="profiles-box">
                <div v-for="item in profiles" :key="item.id" class="profile-card">
                    <div class="profile-head">
                        <div class="profile-name">
                            {{ item.name }}
                            <span v-if="item.id === currentUserId" class="current-badge">{{ uiText.current }}</span>
                            <span v-if="item.id === currentUserId && item.requiresLogin && !config.profileAuthorized" class="pending-badge">{{ uiText.loginNotCompleted }}</span>
                            <span v-if="item.isAdmin" class="admin-badge">Admin</span>
                            <span v-if="item.requiresLogin && !item.isAdmin" class="lock-badge">{{ uiText.login }}</span>
                        </div>
                        <div class="profile-actions">
                            <q-btn v-if="profiles.length > 1" flat dense no-caps color="primary" @click="selectProfile(item)">
                                {{ uiText.select }}
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
                        <div v-if="config.profileAuthorized || !item.requiresLogin" class="profile-tabs">
                            <button
                                type="button"
                                class="profile-tab-btn"
                                :class="{'is-active': currentProfileTab === 'reading'}"
                                @click="currentProfileTab = 'reading'"
                            >
                                {{ uiText.reading }} <span v-if="currentReadingItems.length">{{ currentReadingItems.length }}</span>
                            </button>
                            <button
                                type="button"
                                class="profile-tab-btn"
                                :class="{'is-active': currentProfileTab === 'lists'}"
                                @click="currentProfileTab = 'lists'"
                            >
                                {{ uiText.lists }} <span v-if="currentReadingLists.length">{{ currentReadingLists.length }}</span>
                            </button>
                            <button
                                type="button"
                                class="profile-tab-btn"
                                :class="{'is-active': currentProfileTab === 'settings'}"
                                @click="currentProfileTab = 'settings'"
                            >
                                {{ uiText.settings }}
                            </button>
                        </div>

                        <div v-if="!config.profileAuthorized && item.requiresLogin" class="profile-locked">
                            <div>{{ uiText.loginToEdit }}</div>
                            <q-btn class="q-mt-sm" color="primary" dense no-caps @click="loginCurrentProfile(item)">
                                {{ uiText.loginAction }}
                            </q-btn>
                        </div>

                        <div v-else-if="currentProfileTab === 'reading'" class="reading-progress-box">
                            <div v-if="currentReadingItems.length" class="reading-progress-list">
                                <div v-for="book in currentReadingItems" :key="book.bookUid" class="reading-progress-item">
                                    <div class="reading-progress-head">
                                        <div class="reading-progress-book">
                                            {{ book.title }}
                                        </div>
                                        <div class="reading-progress-percent">
                                            {{ formatPercent(book.percent) }}%
                                        </div>
                                    </div>
                                    <div v-if="book.author" class="reading-progress-meta">
                                        {{ book.author }}
                                    </div>
                                    <div v-if="book.series" class="reading-progress-meta">
                                        {{ uiText.series }}: {{ book.series }}<span v-if="book.serno"> #{{ book.serno }}</span>
                                    </div>
                                    <div class="reading-progress-bar">
                                        <div class="reading-progress-bar-fill" :style="{width: `${formatPercent(book.percent)}%`}"></div>
                                    </div>
                                    <div class="reading-progress-actions">
                                        <q-btn
                                            flat
                                            dense
                                            no-caps
                                            color="primary"
                                            icon="la la-book-open"
                                            @click="openReader(book)"
                                        >
                                            Читать
                                        </q-btn>
                                        <q-btn
                                            flat
                                            dense
                                            no-caps
                                            color="negative"
                                            icon="la la-times"
                                            @click="removeReadingBook(book)"
                                        >
                                            Убрать
                                        </q-btn>
                                    </div>
                                </div>
                            </div>
                            <div v-else class="reading-empty">
                                {{ uiText.noReadingProgress }}
                            </div>
                        </div>

                        <div v-else-if="currentProfileTab === 'lists'" class="reading-progress-box">
                            <div class="reading-progress-actions reading-progress-actions--header">
                                <q-btn
                                    flat
                                    dense
                                    no-caps
                                    color="primary"
                                    icon="la la-list"
                                    @click="readingListsDialogVisible = true"
                                >
                                    {{ uiText.manageLists }}
                                </q-btn>
                            </div>
                            <div v-if="currentReadingLists.length" class="reading-progress-list">
                                <div v-for="list in currentReadingLists" :key="list.id" class="reading-progress-item">
                                    <div class="reading-progress-head">
                                        <div class="reading-progress-book">
                                            {{ list.name }}
                                        </div>
                                        <div class="reading-progress-percent">
                                            {{ list.readCount }}/{{ list.bookCount }}
                                        </div>
                                    </div>
                                    <div class="reading-progress-meta">
                                        {{ list.visibility === 'opds' ? 'OPDS' : uiText.private }}
                                    </div>
                                    <div class="reading-progress-actions">
                                        <q-btn
                                            flat
                                            dense
                                            no-caps
                                            color="primary"
                                            icon="la la-pen"
                                            @click="renameList(list)"
                                        >
                                            Переименовать
                                        </q-btn>
                                        <q-btn
                                            flat
                                            dense
                                            no-caps
                                            color="negative"
                                            icon="la la-trash"
                                            @click="deleteListEntry(list)"
                                        >
                                            Удалить
                                        </q-btn>
                                    </div>
                                </div>
                            </div>
                            <div v-else class="reading-empty">
                                {{ uiText.noReadingLists }}
                            </div>
                        </div>

                        <div v-else class="profile-grid profile-edit-grid">
                            <q-input v-model="editableProfile.name" outlined dense :label="uiText.name" />
                            <q-input v-model="editableProfile.login" outlined dense clearable :label="uiText.login" />
                            <q-input v-model="editableProfile.password" outlined dense clearable type="password" :label="uiText.newPassword" />
                            <q-input v-model="editableProfile.emailTo" outlined dense clearable label="Email" />
                            <q-input v-model="editableProfile.telegramChatId" outlined dense clearable label="Telegram chat id" />
                            <q-toggle class="profile-toggle" v-model="editableProfile.opdsEnabled" :label="uiText.showProfileInOpds" />
                        </div>
                    </div>

                    <div v-if="item.id === currentUserId" class="opds-link">
                        OPDS: <code>{{ opdsUrl(item.publicId || item.id) }}</code>
                    </div>
                </div>
            </div>
        </div>

        <ReadingListsDialog
            v-model="readingListsDialogVisible"
            @update:modelValue="onReadingListsDialogToggle"
        />

        <template #footer>
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="dialogVisible = false">
                {{ uiText.close }}
            </q-btn>
        </template>
    </Dialog>
</template>

<script>
import vueComponent from '../../vueComponent.js';
import Dialog from '../../share/Dialog.vue';
import ReadingListsDialog from '../ReadingListsDialog/ReadingListsDialog.vue';

const componentOptions = {
    components: {
        Dialog,
        ReadingListsDialog,
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
    currentProfileTab = 'reading';
    currentReadingLists = [];
    readingListsDialogVisible = false;
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

    get canViewAllProfiles() {
        return !!(this.config.profileAuthorized && this.currentProfile.isAdmin);
    }

    get currentReadingItems() {
        const rows = this.currentProfile.currentReading;
        return (Array.isArray(rows) ? rows : []);
    }

    get uiText() {
        return {
            dialogTitle: '\u041f\u0440\u043e\u0444\u0438\u043b\u0438 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439',
            createProfile: '\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c',
            profileName: '\u0418\u043c\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f',
            name: '\u0418\u043c\u044f',
            login: '\u041b\u043e\u0433\u0438\u043d',
            password: '\u041f\u0430\u0440\u043e\u043b\u044c',
            newPassword: '\u041d\u043e\u0432\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c',
            emailTo: 'Email \u0434\u043b\u044f \u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0438',
            showProfileInOpds: '\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u0432 OPDS',
            create: '\u0421\u043e\u0437\u0434\u0430\u0442\u044c',
            adminOnly: '\u0421\u043e\u0437\u0434\u0430\u0432\u0430\u0442\u044c \u0438 \u0443\u0434\u0430\u043b\u044f\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u0438 \u043c\u043e\u0436\u0435\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440.',
            availableProfiles: '\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u044b\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u0438',
            loginOtherProfile: '\u0412\u043e\u0439\u0442\u0438 \u0432 \u0434\u0440\u0443\u0433\u043e\u0439 \u043f\u0440\u043e\u0444\u0438\u043b\u044c',
            logout: '\u0412\u044b\u0439\u0442\u0438 \u0438\u0437 \u043f\u0440\u043e\u0444\u0438\u043b\u044f',
            noProfiles: '\u041f\u0440\u043e\u0444\u0438\u043b\u0435\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442',
            current: '\u0422\u0435\u043a\u0443\u0449\u0438\u0439',
            loginNotCompleted: '\u0412\u0445\u043e\u0434 \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d',
            select: '\u0412\u044b\u0431\u0440\u0430\u0442\u044c',
            reading: '\u0427\u0442\u0435\u043d\u0438\u0435',
            lists: '\u0421\u043f\u0438\u0441\u043a\u0438',
            settings: '\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',
            loginToEdit: '\u0414\u043b\u044f \u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u044f \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0444\u0438\u043b\u044f \u0432\u043e\u0439\u0434\u0438\u0442\u0435 \u043f\u043e \u043b\u043e\u0433\u0438\u043d\u0443 \u0438 \u043f\u0430\u0440\u043e\u043b\u044e.',
            loginAction: '\u0412\u043e\u0439\u0442\u0438',
            series: '\u0421\u0435\u0440\u0438\u044f',
            noReadingProgress: '\u0414\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0444\u0438\u043b\u044f \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u043e\u0433\u043e \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430 \u0447\u0442\u0435\u043d\u0438\u044f.',
            read: '\u0427\u0438\u0442\u0430\u0442\u044c',
            remove: '\u0423\u0431\u0440\u0430\u0442\u044c',
            manageLists: '\u0423\u043f\u0440\u0430\u0432\u043b\u044f\u0442\u044c \u0441\u043f\u0438\u0441\u043a\u0430\u043c\u0438',
            rename: '\u041f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u0442\u044c',
            delete: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c',
            private: '\u041b\u0438\u0447\u043d\u044b\u0439',
            noReadingLists: '\u0414\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0444\u0438\u043b\u044f \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0441\u043f\u0438\u0441\u043a\u043e\u0432 \u0447\u0442\u0435\u043d\u0438\u044f.',
            close: '\u0417\u0430\u043a\u0440\u044b\u0442\u044c',
        };
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
        const sourceProfiles = (this.canViewAllProfiles
            ? (this.config.userProfiles || [])
            : [this.currentProfile].filter(Boolean));

        this.profiles = sourceProfiles.map((item) => ({
            id: item.id,
            name: item.name || '',
            login: item.login || '',
            publicId: item.login || item.id,
            requiresLogin: !!item.requiresLogin,
            isAdmin: !!item.isAdmin,
            currentReadingCount: Number(item.currentReadingCount || 0) || 0,
        }));
        this.currentProfileTab = 'reading';
        this.syncEditableProfile();
        await this.loadCurrentReadingLists();
    }

    async loadCurrentReadingLists() {
        this.currentReadingLists = [];
        if (!(this.config.profileAuthorized || !this.currentProfile.hasPassword))
            return;

        try {
            const result = await this.api.getReadingLists('');
            this.currentReadingLists = (result && Array.isArray(result.lists) ? result.lists : []);
        } catch (e) {
            this.currentReadingLists = [];
        }
    }

    formatPercent(value) {
        return Math.max(0, Math.min(100, Math.round((Number(value || 0) || 0) * 100)));
    }

    openReader(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        this.dialogVisible = false;
        this.$router.push({path: '/reader', query: {bookUid}});
    }

    async removeReadingBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            `РЈР±СЂР°С‚СЊ РєРЅРёРіСѓ В«${book.title || ''}В» РёР· С‚РµРєСѓС‰РµРіРѕ С‡С‚РµРЅРёСЏ?`,
            'РўРµРєСѓС‰РµРµ С‡С‚РµРЅРёРµ',
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteReaderProgress(bookUid);
            await this.loadProfiles();
            this.$root.notify.success('РљРЅРёРіР° СѓР±СЂР°РЅР° РёР· С‚РµРєСѓС‰РµРіРѕ С‡С‚РµРЅРёСЏ');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async renameList(item) {
        const response = await this.$root.stdDialog.prompt('Р’РІРµРґРёС‚Рµ РЅРѕРІРѕРµ РЅР°Р·РІР°РЅРёРµ СЃРїРёСЃРєР°:', 'РџРµСЂРµРёРјРµРЅРѕРІР°С‚СЊ СЃРїРёСЃРѕРє', {
            inputValue: item.name,
            inputValidator: (value) => (String(value || '').trim() ? true : 'РќР°Р·РІР°РЅРёРµ РЅРµ РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ РїСѓСЃС‚С‹Рј'),
        });
        if (!response || response === false)
            return;

        try {
            await this.api.renameReadingList(item.id, response.value);
            await this.loadCurrentReadingLists();
            this.$root.notify.success('РЎРїРёСЃРѕРє РїРµСЂРµРёРјРµРЅРѕРІР°РЅ');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async deleteListEntry(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            `РЈРґР°Р»РёС‚СЊ СЃРїРёСЃРѕРє В«${item.name || ''}В»?`,
            'РЈРґР°Р»РµРЅРёРµ СЃРїРёСЃРєР°',
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteReadingList(item.id);
            await this.loadCurrentReadingLists();
            this.$root.notify.success('РЎРїРёСЃРѕРє СѓРґР°Р»С‘РЅ');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async onReadingListsDialogToggle(newValue) {
        this.readingListsDialogVisible = newValue;
        if (!newValue)
            await this.loadCurrentReadingLists();
    }

    async createProfile() {
        try {
            await this.api.createUserProfile(this.newProfile);
            this.newProfile = this.makeEmptyNew();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async saveCurrentProfile() {
        try {
            await this.api.updateUserProfile(this.currentUserId, this.editableProfile);
            this.editableProfile.password = '';
            await this.loadProfiles();
            this.$root.notify.success('РџСЂРѕС„РёР»СЊ СЃРѕС…СЂР°РЅС‘РЅ');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async deleteProfile(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            `РЈРґР°Р»РёС‚СЊ РїСЂРѕС„РёР»СЊ В«${item.name || ''}В» РІРјРµСЃС‚Рµ СЃРѕ РІСЃРµРјРё РµРіРѕ СЃРїРёСЃРєР°РјРё?`,
            'РЈРґР°Р»РµРЅРёРµ РїСЂРѕС„РёР»СЏ',
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
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async resetPassword(item) {
        const prompt = await this.$root.stdDialog.password(
            `Р’РІРµРґРёС‚Рµ РЅРѕРІС‹Р№ РїР°СЂРѕР»СЊ РґР»СЏ РїСЂРѕС„РёР»СЏ В«${item.name || ''}В»:`,
            'РЎР±СЂРѕСЃ РїР°СЂРѕР»СЏ',
            {
                inputValidator: (value) => (String(value || '') ? true : 'РџР°СЂРѕР»СЊ РЅРµ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РїСѓСЃС‚С‹Рј'),
            },
        );
        if (!prompt || prompt === false)
            return;

        try {
            await this.api.updateUserProfile(item.id, {
                password: String(prompt.value || ''),
            });
            this.$root.notify.success(`РџР°СЂРѕР»СЊ РїСЂРѕС„РёР»СЏ В«${item.name || ''}В» РѕР±РЅРѕРІР»С‘РЅ`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
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
                this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
            }
        }

        await this.loadProfiles();
    }

    async loginCurrentProfile(item) {
        try {
            await this.api.showProfileLoginDialog(item.login || '');
            await this.loadProfiles();
        } catch (e) {
            if (e.message !== 'Р’С…РѕРґ РІ РїСЂРѕС„РёР»СЊ РѕС‚РјРµРЅС‘РЅ')
                this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    async loginOtherProfile() {
        try {
            await this.api.showProfileLoginDialog('');
            await this.loadProfiles();
        } catch (e) {
            if (e.message !== 'Р вЂ™РЎвЂ¦Р С•Р Т‘ Р Р† Р С—РЎР‚Р С•РЎвЂћР С‘Р В»РЎРЉ Р С•РЎвЂљР СР ВµР Р…РЎвЂР Р…')
                this.$root.stdDialog.alert(e.message, 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В°');
        }
    }

    async logoutCurrentProfile() {
        try {
            await this.api.logoutUserProfile();
        } catch (e) {
            // Ignore stale profile session cleanup errors during profile logout.
        }

        this.commit('setSettings', {
            currentUserId: '',
            profileAccessToken: '',
        });
        await this.loadProfiles();
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
.admin-badge,
.reading-badge {
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

.reading-badge {
    background: rgba(15, 159, 143, 0.12);
    color: var(--app-link);
}

.profile-body {
    margin-bottom: 8px;
}

.profile-tabs {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
}

.profile-tab-btn {
    padding: 8px 12px;
    border: 1px solid var(--app-border);
    border-radius: 999px;
    background: var(--app-surface);
    color: var(--app-text);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
}

.profile-tab-btn.is-active {
    background: rgba(15, 159, 143, 0.10);
    border-color: rgba(15, 159, 143, 0.32);
    color: var(--app-link);
}

.reading-progress-box {
    padding: 12px;
    border: 1px solid var(--app-border);
    border-radius: 14px;
    background: rgba(15, 159, 143, 0.04);
}

.reading-progress-title {
    margin-bottom: 10px;
    font-size: 14px;
    font-weight: 700;
}

.reading-progress-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.reading-progress-item {
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--app-surface);
    border: 1px solid var(--app-border);
}

.reading-progress-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
}

.reading-progress-book {
    font-weight: 700;
    overflow-wrap: anywhere;
}

.reading-progress-percent {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--app-link);
}

.reading-progress-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--app-muted);
}

.reading-progress-bar {
    height: 6px;
    margin-top: 8px;
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.12);
    overflow: hidden;
}

.reading-progress-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #0f9f8f, #53d8c6);
}

.reading-progress-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
}

.reading-empty {
    font-size: 13px;
    color: var(--app-muted);
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

.profile-session-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
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
