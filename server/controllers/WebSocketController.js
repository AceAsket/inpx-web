const _ = require('lodash');
const WebSocket = require ('ws');

const WorkerState = require('../core/WorkerState');//singleton
const WebWorker = require('../core/WebWorker');//singleton
const log = new (require('../core/AppLogger'))().log;//singleton
const utils = require('../core/utils');

const cleanPeriod = 1*60*1000;//1 минута
const closeSocketOnIdle = 5*60*1000;//5 минут

class WebSocketController {
    constructor(wss, webAccess, config, security = null) {
        this.config = config;
        this.isDevelopment = (config.branch == 'development');
        this.security = security;

        this.webAccess = webAccess;

        this.workerState = new WorkerState();
        this.webWorker = new WebWorker(config);

        this.wss = wss;

        wss.on('connection', (ws, req) => {
            ws.req = req;
            ws.on('message', (message) => {
                this.onMessage(ws, message.toString());
            });

            ws.on('error', (err) => {
                log(LM_ERR, err);
            });
        });

        this.periodicClean();//no await
    }

    async periodicClean() {
        while (1) {//eslint-disable-line no-constant-condition
            try {
                const now = Date.now();

                //почистим ws-клиентов
                this.wss.clients.forEach((ws) => {
                    if (!ws.lastActivity || now - ws.lastActivity > closeSocketOnIdle - 50) {
                        ws.terminate();
                    }
                });
            } catch(e) {
                log(LM_ERR, `WebSocketController.periodicClean error: ${e.message}`);
            }
            
            await utils.sleep(cleanPeriod);
        }
    }

    async onMessage(ws, message) {
        let req = {};
        try {
            if (this.isDevelopment || this.config.logQueries) {
                log(`WebSocket-IN:  ${utils.cutString(message)}`);
            }

            req = JSON.parse(message);
            req.__startTime = Date.now();
            if (!req.profileAccessToken && this.security && ws.req && ws.req.securitySession && ws.req.securitySession.profileAccessToken)
                req.profileAccessToken = ws.req.securitySession.profileAccessToken;

            ws.lastActivity = Date.now();
            
            //pong for WebSocketConnection
            this.send({_rok: 1}, req, ws);

            //access
            if (!await this.webAccess.hasAccess(req.accessToken)) {
                if (this.security && req.accessToken) {
                    this.security.checkLoginRate(ws.req);
                    this.security.recordLoginAttempt(ws.req, false);
                }
                await utils.sleep(500);
                const salt = this.webAccess.newToken();
                this.send({error: 'need_access_token', salt}, req, ws);
                return;
            } else if (this.security && req.accessToken) {
                this.security.recordLoginAttempt(ws.req, true);
            }

            if (this.security && this.isCsrfProtectedAction(req.action) && !this.security.hasValidCsrf(ws.req, req.csrfToken)) {
                this.send({error: 'bad_csrf_token'}, req, ws);
                return;
            }

            //api
            switch (req.action) {
                case 'test':
                    await this.test(req, ws); break;
                case 'logout':
                    await this.logout(req, ws); break;
                case 'get-config':
                    await this.getConfig(req, ws); break;
                case 'get-worker-state':
                    await this.getWorkerState(req, ws); break;
                case 'search':
                    await this.search(req, ws); break;
                case 'bookSearch':
                    await this.bookSearch(req, ws); break;
                case 'get-author-book-list':
                    await this.getAuthorBookList(req, ws); break;
                case 'get-author-series-list':
                    await this.getAuthorSeriesList(req, ws); break;
                case 'get-author-info':
                    await this.getAuthorInfo(req, ws); break;
                case 'get-series-book-list':
                    await this.getSeriesBookList(req, ws); break;
                case 'get-genre-tree':
                    await this.getGenreTree(req, ws); break;
                case 'get-discovery-shelves':
                    await this.getDiscoveryShelves(req, ws); break;
                case 'update-discovery-preferences':
                    await this.updateDiscoveryPreferences(req, ws); break;
                case 'update-shared-discovery-config':
                    await this.updateSharedDiscoveryConfig(req, ws); break;
                case 'update-admin-integrations':
                    await this.updateAdminIntegrations(req, ws); break;
                case 'test-admin-integration':
                    await this.testAdminIntegration(req, ws); break;
                case 'update-admin-opds':
                    await this.updateAdminOpds(req, ws); break;
                case 'get-admin-dashboard':
                    await this.getAdminDashboard(req, ws); break;
                case 'get-admin-events':
                    await this.getAdminEvents(req, ws); break;
                case 'update-admin-event-log':
                    await this.updateAdminEventLog(req, ws); break;
                case 'add-admin-test-event':
                    await this.addAdminTestEvent(req, ws); break;
                case 'update-admin-library-sources':
                    await this.updateAdminLibrarySources(req, ws); break;
                case 'admin-diagnose-library-source':
                    await this.adminDiagnoseLibrarySource(req, ws); break;
                case 'admin-clean-cache':
                    await this.adminCleanCache(req, ws); break;
                case 'admin-clean-broken-covers':
                    await this.adminCleanBrokenCovers(req, ws); break;
                case 'admin-rebuild-cover':
                    await this.adminRebuildCover(req, ws); break;
                case 'admin-reindex':
                    await this.adminReindex(req, ws); break;
                case 'export-admin-settings':
                    await this.exportAdminSettings(req, ws); break;
                case 'create-admin-backup':
                    await this.createAdminBackup(req, ws); break;
                case 'update-book-metadata':
                    await this.updateBookMetadata(req, ws); break;
                case 'get-book-link':
                    await this.getBookLink(req, ws); break;
                case 'get-book-info':
                    await this.getBookInfo(req, ws); break;
                case 'get-reader-state':
                    await this.getReaderState(req, ws); break;
                case 'get-user-reading-library':
                    await this.getUserReadingLibrary(req, ws); break;
                case 'update-reader-progress':
                    await this.updateReaderProgress(req, ws); break;
                case 'delete-reader-progress':
                    await this.deleteReaderProgress(req, ws); break;
                case 'update-reader-preferences':
                    await this.updateReaderPreferences(req, ws); break;
                case 'add-reader-bookmark':
                    await this.addReaderBookmark(req, ws); break;
                case 'delete-reader-bookmark':
                    await this.deleteReaderBookmark(req, ws); break;
                case 'get-reading-lists':
                    await this.getReadingLists(req, ws); break;
                case 'get-user-profiles':
                    await this.getUserProfiles(req, ws); break;
                case 'login-user-profile':
                    await this.loginUserProfile(req, ws); break;
                case 'logout-user-profile':
                    await this.logoutUserProfile(req, ws); break;
                case 'create-user-profile':
                    await this.createUserProfile(req, ws); break;
                case 'update-user-profile':
                    await this.updateUserProfile(req, ws); break;
                case 'delete-user-profile':
                    await this.deleteUserProfile(req, ws); break;
                case 'get-reading-list':
                    await this.getReadingList(req, ws); break;
                case 'create-reading-list':
                    await this.createReadingList(req, ws); break;
                case 'rename-reading-list':
                    await this.renameReadingList(req, ws); break;
                case 'set-reading-list-visibility':
                    await this.setReadingListVisibility(req, ws); break;
                case 'delete-reading-list':
                    await this.deleteReadingList(req, ws); break;
                case 'export-reading-lists':
                    await this.exportReadingLists(req, ws); break;
                case 'import-reading-lists':
                    await this.importReadingLists(req, ws); break;
                case 'update-reading-list-book':
                    await this.updateReadingListBook(req, ws); break;
                case 'set-reading-list-book-read':
                    await this.setReadingListBookRead(req, ws); break;
                case 'mark-reader-books-read':
                    await this.markReaderBooksRead(req, ws); break;
                case 'mark-series-read':
                    await this.markSeriesRead(req, ws); break;
                case 'add-series-to-reading-list':
                    await this.addSeriesToReadingList(req, ws); break;
                case 'send-book-telegram':
                    await this.sendBookTelegram(req, ws); break;
                case 'send-book-email':
                    await this.sendBookEmail(req, ws); break;

                case 'get-inpx-file':
                    await this.getInpxFile(req, ws); break;

                default:
                    throw new Error(`Action not found: ${req.action}`);
            }
        } catch (e) {
            this.send({error: e.message}, req, ws);
        }
    }

    send(res, req, ws) {
        if (ws.readyState == WebSocket.OPEN) {
            ws.lastActivity = Date.now();
            let r = res;
            if (req.requestId)
                r = Object.assign({requestId: req.requestId}, r);

            const message = JSON.stringify(r);
            ws.send(message);

            if (this.isDevelopment || this.config.logQueries) {
                log(`WebSocket-OUT: ${utils.cutString(message)}`);
                log(`${Date.now() - req.__startTime}ms`);
            }

        }
    }

    isCsrfProtectedAction(action = '') {
        return new Set([
            'logout',
            'login-user-profile',
            'logout-user-profile',
            'create-user-profile',
            'update-user-profile',
            'delete-user-profile',
            'update-discovery-preferences',
            'update-shared-discovery-config',
            'update-admin-integrations',
            'update-admin-opds',
            'update-admin-event-log',
            'add-admin-test-event',
            'update-admin-library-sources',
            'admin-diagnose-library-source',
            'admin-clean-cache',
            'admin-clean-broken-covers',
            'admin-rebuild-cover',
            'admin-reindex',
            'update-reader-progress',
            'delete-reader-progress',
            'update-reader-preferences',
            'add-reader-bookmark',
            'delete-reader-bookmark',
            'create-reading-list',
            'rename-reading-list',
            'set-reading-list-visibility',
            'delete-reading-list',
            'import-reading-lists',
            'update-reading-list-book',
            'set-reading-list-book-read',
            'mark-reader-books-read',
            'mark-series-read',
            'add-series-to-reading-list',
            'send-book-telegram',
            'send-book-email',
        ]).has(action);
    }

    getOnlineMetrics() {
        const now = Date.now();
        const users = new Set();
        let clients = 0;
        let anonymousClients = 0;

        this.wss.clients.forEach((ws) => {
            if (ws.readyState !== WebSocket.OPEN)
                return;

            const lastActivity = ws.lastActivity || 0;
            if (!lastActivity || now - lastActivity > closeSocketOnIdle)
                return;

            clients++;
            if (ws.userId) {
                users.add(ws.userId);
            } else {
                anonymousClients++;
            }
        });

        return {
            clients,
            users: users.size,
            anonymousClients,
        };
    }

    //Actions ------------------------------------------------------------------
    async test(req, ws) {
        this.send({message: `${this.config.name} project is awesome`}, req, ws);
    }

    async logout(req, ws) {
        await this.webAccess.deleteAccess(req.accessToken);
        this.send({success: true}, req, ws);
    }

    async getConfig(req, ws) {
        const config = _.pick(this.config, this.config.webConfigParams);
        if (this.security)
            config.csrfToken = this.security.getCsrfToken(ws.req);
        config.discovery = Object.assign(
            {},
            config.discovery || {},
            await this.webWorker.getSharedDiscoveryConfig(),
        );
        config.dbConfig = await this.webWorker.dbConfig();
        config.freeAccess = this.webAccess.freeAccess;
        const profiles = await this.webWorker.getUserProfiles(req.userId);
        const currentProfile = await this.webWorker.getCurrentUserProfile(req.userId, req.profileAccessToken);
        config.userProfiles = profiles.users;
        config.currentUserId = currentProfile.currentUserId || profiles.currentUserId;
        config.currentUserProfile = currentProfile.currentUserProfile;
        config.profileAuthorized = currentProfile.profileAuthorized;
        config.opdsRoot = this.config.opdsRoot || ((this.config.opds && this.config.opds.root) ? this.config.opds.root : '/opds');
        if (config.profileAuthorized && config.currentUserId) {
            ws.userId = String(config.currentUserId || '').trim();
            ws.userLastActivity = Date.now();
        } else {
            delete ws.userId;
            delete ws.userLastActivity;
        }

        const currentUser = currentProfile.currentUserProfile || null;
        config.telegramShareEnabled = !!(
            this.config.telegramShareEnabled
            && this.config.telegramBotToken
            && ((currentUser && currentUser.telegramChatId) || this.config.telegramChatId)
        );
        config.emailShareEnabled = !!(
            this.config.emailShareEnabled
            && this.config.smtpHost
            && ((currentUser && currentUser.emailTo) || this.config.emailTo)
        );
        if (currentUser && currentUser.isAdmin && config.profileAuthorized) {
            config.adminIntegrations = this.webWorker.getAdminIntegrationConfig();
            config.adminOpds = this.webWorker.getAdminOpdsConfig();
        }

        this.send(config, req, ws);
    }

    async getWorkerState(req, ws) {
        if (!req.workerId)
            throw new Error(`key 'workerId' is empty`);

        const state = this.workerState.getState(req.workerId);
        this.send((state ? state : {}), req, ws);
    }

    async search(req, ws) {
        if (!req.query)
            throw new Error(`query is empty`);
        if (!req.from)
            throw new Error(`from is empty`);

        const result = await this.webWorker.search(req.from, req.query);

        this.send(result, req, ws);
    }

    async bookSearch(req, ws) {
        if (!this.config.extendedSearch)
            throw new Error('config.extendedSearch disabled');
        if (!req.query)
            throw new Error(`query is empty`);

        const result = await this.webWorker.bookSearch(req.query);

        this.send(result, req, ws);
    }

    async getAuthorBookList(req, ws) {
        const result = await this.webWorker.getAuthorBookList(req.authorId);

        this.send(result, req, ws);
    }

    async getAuthorSeriesList(req, ws) {
        const result = await this.webWorker.getAuthorSeriesList(req.authorId);

        this.send(result, req, ws);
    }

    async getAuthorInfo(req, ws) {
        const result = await this.webWorker.getAuthorInfo(req.authorId, req.author);

        this.send(result, req, ws);
    }

    async getSeriesBookList(req, ws) {
        const result = await this.webWorker.getSeriesBookList(req.series);

        this.send(result, req, ws);
    }

    async getGenreTree(req, ws) {
        const result = await this.webWorker.getGenreTree();

        this.send(result, req, ws);
    }

    async getDiscoveryShelves(req, ws) {
        const result = await this.webWorker.getDiscoveryShelvesV2({
            userId: req.userId,
            profileAccessToken: req.profileAccessToken,
            forceRefresh: req.forceRefresh === true,
            personalSimilarEnabled: req.personalSimilarEnabled,
            newestLimit: req.newestLimit,
            popularLimit: req.popularLimit,
            externalLimit: req.externalLimit,
            externalSource: req.externalSource,
            externalName: req.externalName,
            externalUrl: req.externalUrl,
            externalTtlMinutes: req.externalTtlMinutes,
            externalBrowseUrl: req.externalBrowseUrl,
            externalBrowseName: req.externalBrowseName,
        });

        this.send(result, req, ws);
    }

    async updateDiscoveryPreferences(req, ws) {
        const result = await this.webWorker.updateDiscoveryPreferences(
            req.userId,
            req.profileAccessToken,
            req.preferences || {},
        );

        this.send(result, req, ws);
    }

    async updateSharedDiscoveryConfig(req, ws) {
        const result = await this.webWorker.updateSharedDiscoveryConfig(
            req.userId,
            req.profileAccessToken,
            req.discovery || {},
        );

        this.send(result, req, ws);
    }

    async updateAdminIntegrations(req, ws) {
        const result = await this.webWorker.updateAdminIntegrationConfig(
            req.userId,
            req.profileAccessToken,
            req.integrations || {},
        );

        this.send(result, req, ws);
    }

    async testAdminIntegration(req, ws) {
        const result = await this.webWorker.testAdminIntegrationConfig(
            req.userId,
            req.profileAccessToken,
            req.kind,
        );

        this.send(result, req, ws);
    }

    async updateAdminOpds(req, ws) {
        const result = await this.webWorker.updateAdminOpdsConfig(
            req.userId,
            req.profileAccessToken,
            req.opds || {},
        );
        this.send(result, req, ws);
    }

    async getAdminDashboard(req, ws) {
        const result = await this.webWorker.getAdminDashboard(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async getAdminEvents(req, ws) {
        const result = await this.webWorker.getAdminEvents(req.userId, req.profileAccessToken, req.options || {});
        this.send(result, req, ws);
    }

    async updateAdminEventLog(req, ws) {
        const result = await this.webWorker.updateAdminEventLog(req.userId, req.profileAccessToken, req.options || {});
        this.send(result, req, ws);
    }

    async addAdminTestEvent(req, ws) {
        const result = await this.webWorker.addAdminTestEvent(req.userId, req.profileAccessToken, req.level);
        this.send(result, req, ws);
    }

    async updateAdminLibrarySources(req, ws) {
        const result = await this.webWorker.updateAdminLibrarySources(
            req.userId,
            req.profileAccessToken,
            req.sources || [],
        );
        this.send(result, req, ws);
    }

    async adminDiagnoseLibrarySource(req, ws) {
        const result = await this.webWorker.diagnoseLibrarySource(req.userId, req.profileAccessToken, req.source || {});
        this.send(result, req, ws);
    }

    async adminCleanCache(req, ws) {
        const result = await this.webWorker.runAdminCacheClean(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async adminCleanBrokenCovers(req, ws) {
        const result = await this.webWorker.cleanBrokenCoverCache(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async adminRebuildCover(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.rebuildCoverCacheForBook(req.userId, req.profileAccessToken, req.bookUid);
        this.send(result, req, ws);
    }

    async adminReindex(req, ws) {
        const result = await this.webWorker.startAdminReindex(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async getBookLink(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.getBookLink(req.bookUid);

        this.send(result, req, ws);
    }

    async getBookInfo(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.getBookInfo(req.bookUid);

        this.send(result, req, ws);
    }

    async getReadingLists(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReadingLists(user.id, req.bookUid, req.options || {});
        this.send(result, req, ws);
    }

    async getReaderState(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReaderState(user.id, req.bookUid);
        this.send(result, req, ws);
    }

    async getUserReadingLibrary(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getUserReadingLibrary(user, req.options || {});
        this.send(result, req, ws);
    }

    async updateReaderProgress(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.updateReaderProgress(user.id, req.bookUid, req.progress || {});
        this.send(result, req, ws);
    }

    async deleteReaderProgress(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReaderProgress(user.id, req.bookUid);
        this.send(result, req, ws);
    }

    async updateReaderPreferences(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.updateReaderPreferences(user.id, req.preferences || {});
        this.send(result, req, ws);
    }

    async addReaderBookmark(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.addReaderBookmark(user.id, req.bookUid, req.bookmark || {});
        this.send(result, req, ws);
    }

    async deleteReaderBookmark(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');
        if (!utils.hasProp(req, 'bookmarkId'))
            throw new Error('bookmarkId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReaderBookmark(user.id, req.bookUid, req.bookmarkId);
        this.send(result, req, ws);
    }

    async getUserProfiles(req, ws) {
        const result = await this.webWorker.getUserProfiles(req.userId);
        this.send(result, req, ws);
    }

    async loginUserProfile(req, ws) {
        if (this.security)
            this.security.checkLoginRate(ws.req, 'profile');

        try {
            const result = await this.webWorker.loginUserProfile(req.login, req.password);
            if (this.security && ws.req && ws.req.securitySession)
                ws.req.securitySession.profileAccessToken = result.profileAccessToken;
            ws.userId = String(result.userId || '').trim();
            ws.userLastActivity = Date.now();
            if (this.security)
                this.security.recordLoginAttempt(ws.req, true, 'profile');
            this.send(result, req, ws);
        } catch (e) {
            if (this.security)
                this.security.recordLoginAttempt(ws.req, false, 'profile');
            throw e;
        }
    }

    async logoutUserProfile(req, ws) {
        const result = await this.webWorker.closeProfileSession(req.profileAccessToken);
        if (this.security && ws.req && ws.req.securitySession)
            delete ws.req.securitySession.profileAccessToken;
        delete ws.userId;
        delete ws.userLastActivity;
        this.send(result, req, ws);
    }

    async createUserProfile(req, ws) {
        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        const profile = Object.assign({}, req.profile || {});
        if (profile.password && !String(profile.login || '').trim())
            throw new Error('Для пароля нужно указать логин');
        if (profile.password)
            profile.passwordHash = this.webWorker.hashProfilePassword(profile.login, profile.password);
        delete profile.password;

        const result = await this.webWorker.createUserProfile(profile);
        this.send(result, req, ws);
    }

    async updateUserProfile(req, ws) {
        if (!utils.hasProp(req, 'targetUserId'))
            throw new Error('targetUserId is empty');

        const target = await this.webWorker.readingListStore.getUser(req.targetUserId);
        const current = await this.webWorker.getEffectiveUser(req.userId, req.profileAccessToken);
        const isOwnProfile = !!(current && current.id === target.id);
        if (isOwnProfile) {
            await this.webWorker.requireAuthorizedUser(req.targetUserId, req.profileAccessToken);
        } else {
            await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        }

        const profile = Object.assign({}, req.profile || {});
        const passwordLogin = String(profile.login || target.login || '').trim();
        if (profile.password && !passwordLogin)
            throw new Error('Для пароля нужно указать логин');
        if (profile.password)
            profile.passwordHash = this.webWorker.hashProfilePassword(passwordLogin, profile.password);
        delete profile.password;
        delete profile.isAdmin;

        const result = await this.webWorker.updateUserProfile(req.targetUserId, profile);
        this.send(result, req, ws);
    }

    async deleteUserProfile(req, ws) {
        if (!utils.hasProp(req, 'targetUserId'))
            throw new Error('targetUserId is empty');

        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);

        const result = await this.webWorker.deleteUserProfile(req.targetUserId);
        this.send(result, req, ws);
    }

    async getReadingList(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReadingList(user.id, req.listId, req.options || {});
        this.send(result, req, ws);
    }

    async createReadingList(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.createReadingList(user.id, req.name, req.visibility);
        this.send(result, req, ws);
    }

    async renameReadingList(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.renameReadingList(user.id, req.listId, req.name);
        this.send(result, req, ws);
    }

    async setReadingListVisibility(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.setReadingListVisibility(user.id, req.listId, req.visibility);
        this.send(result, req, ws);
    }

    async deleteReadingList(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReadingList(user.id, req.listId);
        this.send(result, req, ws);
    }

    async exportReadingLists(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.exportReadingLists(user.id);
        this.send(result, req, ws);
    }

    async exportAdminSettings(req, ws) {
        const result = await this.webWorker.exportAdminSettings(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async createAdminBackup(req, ws) {
        const result = await this.webWorker.createAdminBackup(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async updateBookMetadata(req, ws) {
        const result = await this.webWorker.updateBookMetadata(req.userId, req.profileAccessToken, req.bookUid, req.metadata);
        this.send(result, req, ws);
    }

    async importReadingLists(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.importReadingLists(user.id, req.data);
        this.send(result, req, ws);
    }

    async updateReadingListBook(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.updateReadingListBook(user.id, req.listId, req.bookUid, req.enabled);
        this.send(result, req, ws);
    }

    async setReadingListBookRead(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.setReadingListBookRead(user.id, req.listId, req.bookUid, req.read);
        this.send(result, req, ws);
    }

    async markReaderBooksRead(req, ws) {
        if (!utils.hasProp(req, 'bookUids'))
            throw new Error('bookUids is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.markReaderBooksRead(user.id, req.bookUids, req.read, req.options || {});
        this.send(result, req, ws);
    }

    async markSeriesRead(req, ws) {
        if (!utils.hasProp(req, 'series'))
            throw new Error('series is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.markSeriesRead(user.id, req.series, req.read);
        this.send(result, req, ws);
    }

    async addSeriesToReadingList(req, ws) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');
        if (!utils.hasProp(req, 'series'))
            throw new Error('series is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.addSeriesToReadingList(user.id, req.listId, req.series);
        this.send(result, req, ws);
    }

    async sendBookTelegram(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.sendBookToTelegram(req.bookUid, req.format, user.id);
        this.send(result, req, ws);
    }

    async sendBookEmail(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.sendBookToEmail(req.bookUid, req.format, user.id);
        this.send(result, req, ws);
    }

    async getInpxFile(req, ws) {
        if (!this.config.allowRemoteLib)
            throw new Error('Remote lib access disabled');

        const result = await this.webWorker.getInpxFile(req);

        this.send(result, req, ws);
    }

}

module.exports = WebSocketController;
