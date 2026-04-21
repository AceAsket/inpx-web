<template>
    <div>
        <q-dialog v-model="busyDialogVisible" no-route-dismiss no-esc-dismiss no-backdrop-dismiss>
            <div class="q-pa-lg bg-white column" style="width: 400px">
                <div style="font-weight: bold; font-size: 120%;">
                    {{ mainMessage }}
                </div>

                <div v-show="jobMessage" class="q-mt-sm" style="width: 350px; white-space: nowrap; overflow: hidden">
                    {{ jobMessage }}
                </div>
                <div v-show="jobMessage">
                    <q-linear-progress stripe rounded size="30px" :value="progress" color="green">
                        <div class="absolute-full flex flex-center">
                            <div class="text-black bg-white" style="font-size: 10px; padding: 1px 4px 1px 4px; border-radius: 4px">
                                {{ (progress*100).toFixed(2) }}%
                            </div>
                        </div>
                    </q-linear-progress>
                </div>
                <!--div class="q-ml-sm">
                    {{ jsonMessage }}
                </div-->                
            </div>
        </q-dialog>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//import _ from 'lodash';

import wsc from './webSocketConnection';
import * as utils from '../../share/utils';
import * as cryptoUtils from '../../share/cryptoUtils';
import LockQueue from '../../../server/core/LockQueue';
import packageJson from '../../../package.json';

const rotor = '|/-\\';
const stepBound = [
    0,
    0,// jobStep = 1
    40,// jobStep = 2
    50,// jobStep = 3
    54,// jobStep = 4
    58,// jobStep = 5
    69,// jobStep = 6
    69,// jobStep = 7
    70,// jobStep = 8
    95,// jobStep = 9
    100,// jobStep = 10
];

const componentOptions = {
    components: {
    },
    watch: {
        settings() {
            this.loadSettings();
        },
        modelValue(newValue) {
            this.accessGranted = newValue;
        },
        accessGranted(newValue) {
            this.$emit('update:modelValue', newValue);
        }
    },
};
class Api {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };
    accessGranted = false;

    busyDialogVisible = false;
    mainMessage = '';
    jobMessage = '';
    //jsonMessage = '';
    progress = 0;
    accessToken = '';
    currentUserId = '';
    profileAccessToken = '';

    created() {
        this.commit = this.$store.commit;
        this.lock = new LockQueue();

        this.loadSettings();
    }

    mounted() {
        this.updateConfig();//no await
    }

    loadSettings() {
        const settings = this.settings;

        this.accessToken = settings.accessToken;
        this.currentUserId = settings.currentUserId;
        this.profileAccessToken = settings.profileAccessToken;
    }

    async updateConfig() {
        try {
            this.loadSettings();
            const config = await this.getConfig();
            config.webAppVersion = packageJson.version;
            this.commit('setConfig', config);
            if (config.currentUserId && this.settings.currentUserId !== config.currentUserId)
                this.commit('setSettings', {currentUserId: config.currentUserId});
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    get settings() {
        return this.$store.state.settings;
    }

    async showPasswordDialog() {
        try {
            await this.lock.get();//заход только один раз, остальные ждут закрытия диалога
        } catch (e) {
            return;
        }

        try {
            const result = await this.$root.stdDialog.password('Введите пароль:', 'Доступ ограничен', {
                inputValidator: (str) => (str ? true : 'Пароль не должен быть пустым'),
                userName: 'access',
                noEscDismiss: true,
                noBackdropDismiss: true,
                noCancel: true,
            });

            if (result && result.value) {
                //получим свежую соль
                const response = await wsc.message(await wsc.send({}), 10);
                let salt = '';
                if (response && response.error == 'need_access_token' && response.salt)
                    salt = response.salt;

                const accessToken = utils.toHex(cryptoUtils.sha256(result.value + salt));
                this.commit('setSettings', {accessToken});
            }
        } finally {
            this.lock.errAll();
            this.lock.ret();
        }
    }

    async showBusyDialog() {
        try {
            await this.lock.get();//заход только один раз, остальные ждут закрытия диалога
        } catch (e) {
            return;
        }

        this.mainMessage = '';
        this.jobMessage = '';
        this.busyDialogVisible = true;
        try {
            let ri = 0;
            while (1) {// eslint-disable-line
                const params = {action: 'get-worker-state', workerId: 'server_state'};
                if (this.accessToken)
                    params.accessToken = this.accessToken;
                if (this.currentUserId)
                    params.userId = this.currentUserId;
                if (this.profileAccessToken)
                    params.profileAccessToken = this.profileAccessToken;

                const server = await wsc.message(await wsc.send(params));

                if (server.state != 'normal') {
                    this.mainMessage = `${server.serverMessage} ${rotor[ri]}`;
                    if (server.job == 'load inpx') {
                        this.jobMessage = `${server.jobMessage} (${server.recsLoaded}): ${server.fileName}`;
                    } else {
                        this.jobMessage = server.jobMessage;
                    }

                    //this.jsonMessage = server;

                    const jStep = server.jobStep;

                    if (jStep && stepBound[jStep] !== undefined) {
                        const sp = server.progress || 0;
                        const delta = stepBound[jStep + 1] - stepBound[jStep];
                        this.progress = (stepBound[jStep] + sp*delta)/100;
                    }
                } else {
                    break;
                }

                await utils.sleep(300);
                ri = (ri < rotor.length - 1 ? ri + 1 : 0);
            }
        } finally {
            this.busyDialogVisible = false;
            this.lock.errAll();
            this.lock.ret();
        }
    }

    async request(params, timeoutSecs = 10) {
        let errCount = 0;
        while (1) {// eslint-disable-line
            try {
                const settings = this.settings;
                const accessToken = settings.accessToken || this.accessToken;
                const currentUserId = settings.currentUserId || this.currentUserId;
                const profileAccessToken = settings.profileAccessToken || this.profileAccessToken;

                if (accessToken)
                    params.accessToken = accessToken;
                if (currentUserId)
                    params.userId = currentUserId;
                if (profileAccessToken)
                    params.profileAccessToken = profileAccessToken;

                const response = await wsc.message(await wsc.send(params), timeoutSecs);

                if (response && response.error == 'need_access_token') {
                    this.accessGranted = false;
                    await this.showPasswordDialog();
                } else if (response && response.error == 'need_profile_login') {
                    await this.showProfileLoginDialog();
                } else if (response && response.error == 'server_busy') {
                    this.accessGranted = true;
                    await this.showBusyDialog();
                } else {
                    this.accessGranted = true;
                    if (response.error) {
                        throw new Error(response.error);
                    }

                    return response;
                }

                errCount = 0;
            } catch(e) {
                errCount++;
                if (e.message !== 'WebSocket не отвечает' || errCount > 10) {
                    errCount = 0;
                    throw e;
                }
                await utils.sleep(100);
            }
        }
    }

    async search(from, query) {
        return await this.request({action: 'search', from, query}, 30);
    }

    async bookSearch(query) {
        return await this.request({action: 'bookSearch', query}, 30);
    }

    async getAuthorBookList(authorId) {
        return await this.request({action: 'get-author-book-list', authorId});
    }

    async getAuthorSeriesList(authorId) {
        return await this.request({action: 'get-author-series-list', authorId});
    }

    async getAuthorInfo(authorId, author) {
        return await this.request({action: 'get-author-info', authorId, author}, 120);
    }

    async getSeriesBookList(series) {
        return await this.request({action: 'get-series-book-list', series});
    }

    async getGenreTree() {
        return await this.request({action: 'get-genre-tree'});
    }    

    async getBookLink(bookUid) {
        return await this.request({action: 'get-book-link', bookUid}, 120);
    }

    async getBookInfo(bookUid) {
        return await this.request({action: 'get-book-info', bookUid}, 120);
    }

    async getReaderState(bookUid) {
        return await this.request({action: 'get-reader-state', bookUid}, 120);
    }

    async updateReaderProgress(bookUid, progress = {}) {
        return await this.request({action: 'update-reader-progress', bookUid, progress}, 120);
    }

    async updateReaderPreferences(preferences = {}) {
        return await this.request({action: 'update-reader-preferences', preferences}, 120);
    }

    async getReadingLists(bookUid = '') {
        return await this.request({action: 'get-reading-lists', bookUid}, 120);
    }

    async getUserProfiles() {
        return await this.request({action: 'get-user-profiles'}, 120);
    }

    async loginUserProfile(login, password) {
        return await this.request({action: 'login-user-profile', login, password}, 120);
    }

    async logoutUserProfile() {
        return await this.request({action: 'logout-user-profile'}, 120);
    }

    async createUserProfile(profile) {
        return await this.request({action: 'create-user-profile', profile}, 120);
    }

    async updateUserProfile(targetUserId, profile) {
        return await this.request({action: 'update-user-profile', targetUserId, profile}, 120);
    }

    async deleteUserProfile(targetUserId) {
        return await this.request({action: 'delete-user-profile', targetUserId}, 120);
    }

    async getReadingList(listId) {
        return await this.request({action: 'get-reading-list', listId}, 120);
    }

    async createReadingList(name) {
        return await this.request({action: 'create-reading-list', name}, 120);
    }

    async createReadingListWithVisibility(name, visibility = 'private') {
        return await this.request({action: 'create-reading-list', name, visibility}, 120);
    }

    async renameReadingList(listId, name) {
        return await this.request({action: 'rename-reading-list', listId, name}, 120);
    }

    async setReadingListVisibility(listId, visibility) {
        return await this.request({action: 'set-reading-list-visibility', listId, visibility}, 120);
    }

    async deleteReadingList(listId) {
        return await this.request({action: 'delete-reading-list', listId}, 120);
    }

    async exportReadingLists() {
        return await this.request({action: 'export-reading-lists'}, 120);
    }

    async importReadingLists(data) {
        return await this.request({action: 'import-reading-lists', data}, 120);
    }

    async updateReadingListBook(listId, bookUid, enabled) {
        return await this.request({action: 'update-reading-list-book', listId, bookUid, enabled}, 120);
    }

    async setReadingListBookRead(listId, bookUid, read) {
        return await this.request({action: 'set-reading-list-book-read', listId, bookUid, read}, 120);
    }

    async addSeriesToReadingList(listId, series) {
        return await this.request({action: 'add-series-to-reading-list', listId, series}, 120);
    }

    async sendBookTelegram(bookUid, format = '') {
        return await this.request({action: 'send-book-telegram', bookUid, format}, 300);
    }

    async sendBookEmail(bookUid, format = '') {
        return await this.request({action: 'send-book-email', bookUid, format}, 300);
    }

    async getConfig() {
        return await this.request({action: 'get-config'});
    }

    async logout() {
        if (this.profileAccessToken) {
            try {
                await this.logoutUserProfile();
            } catch (e) {
                // Ignore profile session cleanup errors during global logout.
            }
        }
        await this.request({action: 'logout'});
        this.commit('setSettings', {
            currentUserId: '',
            profileAccessToken: '',
        });
        this.accessGranted = false;
        await this.request({action: 'test'});
    }

    async showProfileLoginDialog(prefillLogin = '') {
        const current = this.$store.state.config.currentUserProfile || {};
        const loginPrompt = await this.$root.stdDialog.prompt(
            'Введите логин профиля:',
            'Вход в профиль',
            {
                inputValue: prefillLogin || current.login || '',
                inputValidator: (value) => (String(value || '').trim() ? true : 'Логин не должен быть пустым'),
            },
        );
        if (!loginPrompt || loginPrompt === false)
            throw new Error('Вход в профиль отменён');

        const passwordPrompt = await this.$root.stdDialog.password(
            'Введите пароль профиля:',
            'Вход в профиль',
            {
                inputValidator: (value) => (String(value || '') ? true : 'Пароль не должен быть пустым'),
            },
        );
        if (!passwordPrompt || passwordPrompt === false)
            throw new Error('Вход в профиль отменён');

        const result = await this.loginUserProfile(String(loginPrompt.value || '').trim(), String(passwordPrompt.value || ''));
        this.commit('setSettings', {
            currentUserId: result.userId,
            profileAccessToken: result.profileAccessToken,
        });
        this.currentUserId = result.userId;
        this.profileAccessToken = result.profileAccessToken;
        await this.updateConfig();
        return result;
    }
}

export default vueComponent(Api);
//-----------------------------------------------------------------------------
</script>

<style scoped>
</style>
