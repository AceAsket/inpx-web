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
                <div class="section-title section-title--actions">
                    <span>{{ uiText.createProfile }}</span>
                    <q-btn
                        flat
                        dense
                        no-caps
                        color="primary"
                        icon="la la-user-plus"
                        @click="showCreateProfileForm = !showCreateProfileForm"
                    >
                        {{ showCreateProfileForm ? uiText.hideCreateForm : uiText.showCreateForm }}
                    </q-btn>
                </div>

                <div v-if="showCreateProfileForm" class="profile-grid create-grid">
                    <q-input v-model="newProfile.name" outlined dense clearable :label="uiText.profileName" />
                    <q-input v-model="newProfile.login" outlined dense clearable :label="uiText.login" />
                    <q-input
                        v-model="newProfile.password"
                        outlined
                        dense
                        clearable
                        :type="newProfilePasswordVisible ? 'text' : 'password'"
                        :label="uiText.password"
                    >
                        <template #append>
                            <q-icon
                                :name="newProfilePasswordVisible ? 'la la-eye-slash' : 'la la-eye'"
                                class="password-visibility-toggle"
                                @click="newProfilePasswordVisible = !newProfilePasswordVisible"
                            />
                        </template>
                    </q-input>
                    <q-input v-model="newProfile.emailTo" outlined dense clearable :label="uiText.emailTo" />
                    <q-input v-model="newProfile.telegramChatId" outlined dense clearable label="Личный Telegram chat id" />
                    <q-toggle class="profile-toggle" v-model="newProfile.opdsEnabled" :label="uiText.showProfileInOpds" />
                    <q-toggle class="profile-toggle" v-model="newProfile.opdsAuthEnabled" :disable="!newProfile.login || !newProfile.password" :label="uiText.requireOpdsAuth" />
                    <div class="profile-submit-row">
                        <q-btn flat dense no-caps @click="showCreateProfileForm = false">
                            {{ uiText.cancel }}
                        </q-btn>
                        <q-btn class="profile-submit" color="primary" dense no-caps @click="createProfile">
                            {{ uiText.create }}
                        </q-btn>
                    </div>
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
                                v-if="canManageProfiles && !item.isAdmin && !item.anonymousProfile"
                                flat dense round icon="la la-key" color="warning"
                                @click="resetPassword(item)"
                            />
                            <q-btn
                                v-if="item.id === currentUserId && config.profileAuthorized && !item.anonymousProfile"
                                flat dense round icon="la la-save" color="primary"
                                @click="saveCurrentProfile"
                            />
                            <q-btn
                                v-if="canManageProfiles && !item.isAdmin && !item.anonymousProfile"
                                flat dense round icon="la la-trash" color="negative"
                                @click="deleteProfile(item)"
                            />
                        </div>
                    </div>

                    <div v-if="item.id === currentUserId && !item.anonymousProfile" class="profile-body">
                        <div v-if="config.profileAuthorized || !item.requiresLogin" class="profile-tabs">
                            <button
                                type="button"
                                class="profile-tab-btn"
                                :class="{'is-active': currentProfileTab === 'reading'}"
                                @click="currentProfileTab = 'reading'"
                            >
                                {{ uiText.reading }}
                            </button>
                            <button
                                type="button"
                                class="profile-tab-btn"
                                :class="{'is-active': currentProfileTab === 'lists'}"
                                @click="currentProfileTab = 'lists'"
                            >
                                {{ uiText.lists }}
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
                            <div v-if="currentReadingItems.length">
                                <div class="reading-progress-header">
                                    <div class="reading-progress-summary">
                                        <span class="reading-progress-summary-badge">{{ currentReadingItems.length }}</span>
                                        <span class="reading-progress-summary-text">книг в чтении</span>
                                    </div>
                                    <q-btn
                                        flat
                                        dense
                                        no-caps
                                        color="primary"
                                        class="reading-progress-toggle-btn"
                                        :icon="expandedReadingSection ? 'la la-angle-up' : 'la la-angle-down'"
                                        @click="toggleReadingSectionExpanded"
                                    >
                                        {{ expandedReadingSection ? uiText.collapseList : uiText.expandList }}
                                    </q-btn>
                                </div>
                                <div v-if="expandedReadingSection" class="reading-progress-list">
                                    <div v-for="book in currentReadingItems" :key="book.bookUid" class="reading-progress-item">
                                        <div class="reading-progress-head">
                                            <div class="reading-progress-book">
                                                {{ book.title }}
                                            </div>
                                            <div class="reading-progress-percent">
                                                {{ formatPercent(book.percent) }}%
                                            </div>
                                        </div>
                                        <div class="reading-progress-bar">
                                            <div class="reading-progress-bar-fill" :style="{width: `${formatPercent(book.percent)}%`}"></div>
                                        </div>
                                        <div v-if="book.author" class="reading-progress-meta">
                                            {{ book.author }}
                                        </div>
                                        <div v-if="book.series" class="reading-progress-meta">
                                            {{ uiText.series }}: {{ book.series }}<span v-if="book.serno"> #{{ book.serno }}</span>
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
                                            {{ formatBookCountLabel(list.bookCount) }}
                                        </div>
                                    </div>
                                    <div class="reading-progress-meta">
                                        {{ list.visibility === 'opds' ? 'OPDS' : uiText.private }}
                                        <template v-if="Number(list.readCount || 0) > 0">
                                            · {{ list.readCount }}/{{ list.bookCount }}
                                        </template>
                                    </div>
                                    <div class="reading-progress-actions reading-progress-actions--list">
                                        <q-btn
                                            flat
                                            dense
                                            no-caps
                                            color="primary"
                                            :icon="isReadingListExpanded(list.id) ? 'la la-angle-up' : 'la la-angle-down'"
                                            @click="toggleReadingListExpanded(list.id)"
                                        >
                                            {{ isReadingListExpanded(list.id) ? uiText.collapseList : uiText.expandList }}
                                        </q-btn>
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
                                    <div
                                        v-if="isReadingListExpanded(list.id) && list.books && list.books.length"
                                        class="profile-list-preview"
                                    >
                                        <div
                                            v-for="book in list.books"
                                            :key="`${list.id}-${book.bookUid}`"
                                            class="profile-list-preview-item profile-list-preview-item--row"
                                        >
                                            <div class="profile-list-preview-main">
                                                <div class="profile-list-preview-title">
                                                    {{ book.title || uiText.untitledBook }}
                                                </div>
                                                <div v-if="book.author" class="profile-list-preview-meta">
                                                    {{ book.author }}
                                                </div>
                                            </div>
                                            <q-checkbox
                                                :model-value="book.read"
                                                dense
                                                :label="uiText.readStatus"
                                                @update:model-value="toggleListBookRead(list, book, $event)"
                                            />
                                            <q-btn
                                                flat
                                                dense
                                                round
                                                color="negative"
                                                icon="la la-times"
                                                @click="removeBookFromList(list, book)"
                                            />
                                        </div>
                                    </div>
                                    <div v-else-if="isReadingListExpanded(list.id)" class="reading-progress-meta">
                                        {{ uiText.listIsEmpty }}
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
                            <q-input
                                v-model="editableProfile.password"
                                outlined
                                dense
                                clearable
                                :type="editableProfilePasswordVisible ? 'text' : 'password'"
                                :label="uiText.newPassword"
                            >
                                <template #append>
                                    <q-icon
                                        :name="editableProfilePasswordVisible ? 'la la-eye-slash' : 'la la-eye'"
                                        class="password-visibility-toggle"
                                        @click="editableProfilePasswordVisible = !editableProfilePasswordVisible"
                                    />
                                </template>
                            </q-input>
                            <q-input v-model="editableProfile.emailTo" outlined dense clearable label="Email" />
                            <q-input v-model="editableProfile.telegramChatId" outlined dense clearable label="Личный Telegram chat id" />
                            <q-toggle class="profile-toggle" v-model="editableProfile.opdsEnabled" :label="uiText.showProfileInOpds" />
                            <q-toggle class="profile-toggle" v-model="editableProfile.opdsAuthEnabled" :disable="!editableProfile.login || (!currentProfile.hasPassword && !editableProfile.password)" :label="uiText.requireOpdsAuth" />
                        </div>
                    </div>

                    <div v-if="item.id === currentUserId" class="opds-link">
                        OPDS: <code>{{ opdsUrl(item.publicId || item.id) }}</code>
                        <div v-if="item.opdsAuthEnabled" class="opds-link-hint">
                            {{ uiText.opdsAuthHint }}
                        </div>
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
    expandedReadingSection = false;
    expandedReadingLists = {};
    readingListsDialogVisible = false;
    showCreateProfileForm = false;
    newProfilePasswordVisible = false;
    editableProfilePasswordVisible = false;
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

    get currentAnonymousProfile() {
        return !!this.currentProfile.anonymousProfile;
    }

    get currentReadingItems() {
        const rows = this.currentProfile.currentReading;
        return (Array.isArray(rows) ? rows : []);
    }

    get uiText() {
        return {
            dialogTitle: '\u041f\u0440\u043e\u0444\u0438\u043b\u0438 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439',
            createProfile: '\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c',
            showCreateForm: '\u041d\u043e\u0432\u044b\u0439 \u043f\u0440\u043e\u0444\u0438\u043b\u044c',
            hideCreateForm: '\u0421\u043a\u0440\u044b\u0442\u044c \u0444\u043e\u0440\u043c\u0443',
            profileName: '\u0418\u043c\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f',
            name: '\u0418\u043c\u044f',
            login: '\u041b\u043e\u0433\u0438\u043d',
            password: '\u041f\u0430\u0440\u043e\u043b\u044c',
            newPassword: '\u041d\u043e\u0432\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c',
            emailTo: 'Email \u0434\u043b\u044f \u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0438',
            showProfileInOpds: '\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u0432 OPDS',
            requireOpdsAuth: '\u0422\u0440\u0435\u0431\u043e\u0432\u0430\u0442\u044c \u043f\u0430\u0440\u043e\u043b\u044c \u0434\u043b\u044f OPDS',
            opdsAuthHint: '\u0412 OPDS-\u0447\u0438\u0442\u0430\u043b\u043a\u0435 \u0443\u043a\u0430\u0436\u0438\u0442\u0435 \u043b\u043e\u0433\u0438\u043d \u0438 \u043f\u0430\u0440\u043e\u043b\u044c \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0444\u0438\u043b\u044f.',
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
            listIsEmpty: '\u0412 \u044d\u0442\u043e\u043c \u0441\u043f\u0438\u0441\u043a\u0435 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u043a\u043d\u0438\u0433.',
            moreBooks: '\u0415\u0449\u0451 {count} \u043a\u043d\u0438\u0433',
            expandList: '\u0420\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c',
            collapseList: '\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c',
            listCollapsedHint: '\u0421\u043f\u0438\u0441\u043e\u043a \u0441\u0432\u0435\u0440\u043d\u0443\u0442, \u0432\u043d\u0443\u0442\u0440\u0438 {count} \u043a\u043d\u0438\u0433',
            untitledBook: '\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f',
            errorTitle: '\u041e\u0448\u0438\u0431\u043a\u0430',
            currentReadingTitle: '\u0422\u0435\u043a\u0443\u0449\u0435\u0435 \u0447\u0442\u0435\u043d\u0438\u0435',
            removeReadingConfirm: '\u0423\u0431\u0440\u0430\u0442\u044c \u043a\u043d\u0438\u0433\u0443 \u00ab{title}\u00bb \u0438\u0437 \u0442\u0435\u043a\u0443\u0449\u0435\u0433\u043e \u0447\u0442\u0435\u043d\u0438\u044f?',
            removeReadingSuccess: '\u041a\u043d\u0438\u0433\u0430 \u0443\u0431\u0440\u0430\u043d\u0430 \u0438\u0437 \u0442\u0435\u043a\u0443\u0449\u0435\u0433\u043e \u0447\u0442\u0435\u043d\u0438\u044f',
            removeBookFromListConfirm: '\u0423\u0431\u0440\u0430\u0442\u044c \u043a\u043d\u0438\u0433\u0443 \u00ab{title}\u00bb \u0438\u0437 \u0441\u043f\u0438\u0441\u043a\u0430 \u00ab{list}\u00bb?',
            removeBookFromListSuccess: '\u041a\u043d\u0438\u0433\u0430 \u0443\u0431\u0440\u0430\u043d\u0430 \u0438\u0437 \u0441\u043f\u0438\u0441\u043a\u0430',
            readStatus: '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e',
            renameListPrompt: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u043e\u0432\u043e\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0441\u043f\u0438\u0441\u043a\u0430:',
            renameListTitle: '\u041f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a',
            nameRequired: '\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043d\u0435 \u0434\u043e\u043b\u0436\u043d\u043e \u0431\u044b\u0442\u044c \u043f\u0443\u0441\u0442\u044b\u043c',
            renameListSuccess: '\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d',
            deleteListConfirm: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a \u00ab{name}\u00bb?',
            deleteListTitle: '\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435 \u0441\u043f\u0438\u0441\u043a\u0430',
            deleteListSuccess: '\u0421\u043f\u0438\u0441\u043e\u043a \u0443\u0434\u0430\u043b\u0451\u043d',
            profileSaved: '\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d',
            deleteProfileConfirm: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u00ab{name}\u00bb \u0432\u043c\u0435\u0441\u0442\u0435 \u0441\u043e \u0432\u0441\u0435\u043c\u0438 \u0435\u0433\u043e \u0441\u043f\u0438\u0441\u043a\u0430\u043c\u0438?',
            deleteProfileTitle: '\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u044f',
            resetPasswordPrompt: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u043e\u0432\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c \u0434\u043b\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f \u00ab{name}\u00bb:',
            resetPasswordTitle: '\u0421\u0431\u0440\u043e\u0441 \u043f\u0430\u0440\u043e\u043b\u044f',
            passwordRequired: '\u041f\u0430\u0440\u043e\u043b\u044c \u043d\u0435 \u0434\u043e\u043b\u0436\u0435\u043d \u0431\u044b\u0442\u044c \u043f\u0443\u0441\u0442\u044b\u043c',
            resetPasswordSuccess: '\u041f\u0430\u0440\u043e\u043b\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044f \u00ab{name}\u00bb \u043e\u0431\u043d\u043e\u0432\u043b\u0451\u043d',
            cancel: '\u041e\u0442\u043c\u0435\u043d\u0430',
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
            opdsAuthEnabled: false,
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
            opdsAuthEnabled: false,
        };
    }

    async refreshConfig() {
        await this.api.updateConfig();
    }

    syncEditableProfile() {
        const current = this.config.currentUserProfile || {};
        this.editableProfilePasswordVisible = false;
        this.editableProfile = {
            name: current.name || '',
            login: current.login || '',
            password: '',
            emailTo: current.emailTo || '',
            telegramChatId: current.telegramChatId || '',
            opdsEnabled: current.opdsEnabled !== false,
            opdsAuthEnabled: current.opdsAuthEnabled === true,
        };
    }

    async loadProfiles(options = {}) {
        const preserveState = (options && options.preserveState === true);
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
            opdsAuthEnabled: item.opdsAuthEnabled === true,
            anonymousProfile: !!item.anonymousProfile,
            currentReadingCount: Number(item.currentReadingCount || 0) || 0,
        }));
        if (!preserveState) {
            this.currentProfileTab = 'reading';
            this.expandedReadingSection = false;
        }
        this.newProfilePasswordVisible = false;
        this.syncEditableProfile();
        await this.loadCurrentReadingLists();
    }

    async loadCurrentReadingLists() {
        this.currentReadingLists = [];
        if (this.currentAnonymousProfile)
            return;
        if (!(this.config.profileAuthorized || !this.currentProfile.hasPassword))
            return;

        try {
            const expandedState = {...this.expandedReadingLists};
            const result = await this.api.getReadingLists('');
            const lists = (result && Array.isArray(result.lists) ? result.lists : []);
            const detailedLists = await Promise.all(lists.map(async(list) => {
                const normalized = Object.assign({}, list, {
                    previewBooks: [],
                    hiddenBookCount: 0,
                    books: [],
                });

                try {
                    const detail = await this.api.getReadingList(list.id);
                    const books = (detail && Array.isArray(detail.books) ? detail.books : []);
                    normalized.books = books.map((book) => ({
                        bookUid: String(book.bookUid || book._uid || '').trim(),
                        title: String(book.title || '').trim(),
                        author: String(book.author || '').trim(),
                        read: !!(book._readingListRead || book.read),
                    }));
                    normalized.previewBooks = books.slice(0, 4).map((book) => ({
                        bookUid: String(book.bookUid || book._uid || '').trim(),
                        title: String(book.title || '').trim(),
                        author: String(book.author || '').trim(),
                    }));
                    normalized.hiddenBookCount = Math.max(0, books.length - normalized.previewBooks.length);
                } catch (e) {
                    normalized.previewBooks = [];
                    normalized.hiddenBookCount = 0;
                }

                return normalized;
            }));
            this.currentReadingLists = detailedLists;
            this.expandedReadingLists = detailedLists.reduce((acc, list) => {
                const key = String(list.id);
                acc[key] = !!expandedState[key];
                return acc;
            }, {});
        } catch (e) {
            this.currentReadingLists = [];
            this.expandedReadingLists = {};
        }
    }

    isReadingListExpanded(listId) {
        return !!this.expandedReadingLists[String(listId)];
    }

    toggleReadingListExpanded(listId) {
        const key = String(listId);
        this.expandedReadingLists = {
            ...this.expandedReadingLists,
            [key]: !this.expandedReadingLists[key],
        };
    }

    formatPercent(value) {
        return Math.max(0, Math.min(100, Math.round((Number(value || 0) || 0) * 100)));
    }

    formatBookCountLabel(value) {
        const count = Math.max(0, Math.round(Number(value || 0) || 0));
        const mod10 = count % 10;
        const mod100 = count % 100;
        let noun = 'книг';
        if (mod10 === 1 && mod100 !== 11)
            noun = 'книга';
        else if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14))
            noun = 'книги';

        return `${count} ${noun}`;
    }

    toggleReadingSectionExpanded() {
        this.expandedReadingSection = !this.expandedReadingSection;
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
            this.uiText.removeReadingConfirm.replace('{title}', String(book.title || '')),
            this.uiText.currentReadingTitle,
        );
        if (!confirmed)
            return;

        try {
            await this.api.updateReaderProgress(bookUid, {
                hidden: true,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
            });
            await this.loadProfiles({preserveState: true});
            this.$root.notify.success(this.uiText.removeReadingSuccess);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async renameList(item) {
        const response = await this.$root.stdDialog.prompt(this.uiText.renameListPrompt, this.uiText.renameListTitle, {
            inputValue: item.name,
            inputValidator: (value) => (String(value || '').trim() ? true : this.uiText.nameRequired),
        });
        if (!response || response === false)
            return;

        try {
            await this.api.renameReadingList(item.id, response.value);
            await this.loadCurrentReadingLists();
            this.$root.notify.success(this.uiText.renameListSuccess);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async deleteListEntry(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.deleteListConfirm.replace('{name}', String(item.name || '')),
            this.uiText.deleteListTitle,
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteReadingList(item.id);
            await this.loadCurrentReadingLists();
            this.$root.notify.success(this.uiText.deleteListSuccess);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async toggleListBookRead(list = {}, book = {}, read = false) {
        const listId = String(list.id || '').trim();
        const bookUid = String(book.bookUid || '').trim();
        if (!listId || !bookUid)
            return;

        try {
            await this.api.setReadingListBookRead(listId, bookUid, read);
            if (!!book.read !== !!read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) + (read ? 1 : -1));
            book.read = !!read;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
            await this.loadCurrentReadingLists();
            this.expandedReadingLists = {
                ...this.expandedReadingLists,
                [listId]: true,
            };
        }
    }

    async removeBookFromList(list = {}, book = {}) {
        const listId = String(list.id || '').trim();
        const bookUid = String(book.bookUid || '').trim();
        if (!listId || !bookUid)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.removeBookFromListConfirm
                .replace('{title}', String(book.title || this.uiText.untitledBook))
                .replace('{list}', String(list.name || '')),
            this.uiText.lists,
        );
        if (!confirmed)
            return;

        try {
            await this.api.updateReadingListBook(listId, bookUid, false);
            await this.loadCurrentReadingLists();
            this.expandedReadingLists = {
                ...this.expandedReadingLists,
                [listId]: true,
            };
            this.$root.notify.success(this.uiText.removeBookFromListSuccess);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
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
            this.newProfilePasswordVisible = false;
            this.showCreateProfileForm = false;
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async saveCurrentProfile() {
        try {
            await this.api.updateUserProfile(this.currentUserId, this.editableProfile);
            this.editableProfile.password = '';
            await this.loadProfiles();
            this.$root.notify.success(this.uiText.profileSaved);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async deleteProfile(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.deleteProfileConfirm.replace('{name}', String(item.name || '')),
            this.uiText.deleteProfileTitle,
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
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async resetPassword(item) {
        const prompt = await this.$root.stdDialog.password(
            this.uiText.resetPasswordPrompt.replace('{name}', String(item.name || '')),
            this.uiText.resetPasswordTitle,
            {
                inputValidator: (value) => (String(value || '') ? true : this.uiText.passwordRequired),
            },
        );
        if (!prompt || prompt === false)
            return;

        try {
            await this.api.updateUserProfile(item.id, {
                password: String(prompt.value || ''),
            });
            this.$root.notify.success(this.uiText.resetPasswordSuccess.replace('{name}', String(item.name || '')));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.errorTitle);
        }
    }

    async selectProfile(item) {
        if (this.config.profileAuthorized) {
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

    async loginOtherProfile() {
        try {
            await this.api.showProfileLoginDialog('');
            await this.loadProfiles();
        } catch (e) {
            if (e.message !== 'Вход в профиль отменён')
                this.$root.stdDialog.alert(e.message, 'Ошибка');
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

.section-title--actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
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

.profile-submit-row {
    grid-column: span 2;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.password-visibility-toggle {
    cursor: pointer;
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

.reading-progress-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
}

.reading-progress-summary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid rgba(15, 159, 143, 0.2);
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.08);
    color: var(--app-text);
}

.reading-progress-summary-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.18);
    color: var(--app-link);
    font-size: 12px;
    font-weight: 800;
}

.reading-progress-summary-text {
    font-size: 12px;
    font-weight: 700;
    color: var(--app-muted);
    white-space: nowrap;
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
    flex-wrap: wrap;
    gap: 6px;
}

.reading-progress-actions--list {
    justify-content: flex-start;
}

.reading-progress-toggle-btn {
    flex: 0 0 auto;
}

.profile-list-preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
}

.profile-list-preview-item {
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: rgba(15, 159, 143, 0.04);
}

.profile-list-preview-item--row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}

.profile-list-preview-main {
    min-width: 0;
    flex: 1 1 auto;
}

.profile-list-preview-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--app-text);
    overflow-wrap: anywhere;
}

.profile-list-preview-meta,
.profile-list-preview-more {
    font-size: 12px;
    color: var(--app-muted);
}

.profile-list-preview-more {
    padding: 0 2px;
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

.opds-link-hint {
    margin-top: 4px;
    color: var(--app-text);
    word-break: normal;
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
