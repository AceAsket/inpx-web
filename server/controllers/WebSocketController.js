const _ = require('lodash');
const WebSocket = require ('ws');

const WorkerState = require('../core/WorkerState');//singleton
const WebWorker = require('../core/WebWorker');//singleton
const log = new (require('../core/AppLogger'))().log;//singleton
const utils = require('../core/utils');
const runtimeMetrics = require('../core/RuntimeMetrics');
const {getReaderSpeech} = require('../core/ReaderSpeech');
const {withFileTransaction} = require('../core/FilePersistence');
const clientProtocol = require('../core/ClientProtocol');
const requestLimits = require('../core/RequestLimits');
const ProfileAccess = require('../core/ProfileAccess');
const {admission:profileAdmission} = require('../core/ProfileSessions');

const cleanPeriod = 1*60*1000;//1 минута
const closeSocketOnIdle = 5*60*1000;//5 минут

class WebSocketController {
    constructor(wss, webAccess, config, security = null, readingListStore) {
        this.config = config;
        this.isDevelopment = (config.branch == 'development');
        this.security = security;

        this.webAccess = webAccess;

        this.workerState = new WorkerState();
        this.webWorker = new WebWorker(config, readingListStore);
        this.profileAccess = security ? new ProfileAccess(config, this.webWorker, security) : null;

        this.wss = wss;
        this.activeRequests = 0;
        const onReaderChange = ({userId, bookUid}) =>
            this.publishUserChange(userId, 'reader', bookUid).catch(error=>log(LM_ERR,error));
        require('../core/ReaderEvents').on('change', onReaderChange);
        wss.once?.('close', () => require('../core/ReaderEvents').off('change', onReaderChange));

        wss.on('connection', (ws, req) => {
            ws.req = req;
            ws.on('message', (message, isBinary, admission) => {
                if (isBinary) {
                    ws.close(1003, 'Text JSON required');
                    return;
                }
                const handled = this.onMessage(ws, message.toString(), admission);
                if (admission) handled.finally(admission.complete).catch(error=>log(LM_ERR,error));
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

    async onMessage(ws, message, admission) {
        const messageBytes = admission?.validation ? 0 : Buffer.byteLength(message);
        const large = !admission && messageBytes > requestLimits.limits(this.config).message;
        if (!admission) {
            if ((ws.activeRequests || 0) >= 8 || (this.activeRequests || 0) >= 64 || (large && this.largeRequestActive)) {
                ws.close(1013, 'Too many active requests');
                return;
            }
            ws.activeRequests = (ws.activeRequests || 0) + 1;
            this.activeRequests = (this.activeRequests || 0) + 1;
            if (large) this.largeRequestActive = true;
        }
        let req = {};
        let metricToken = null;
        let metricOk = false;
        try {
            if (this.isDevelopment || this.config.logQueries) {
                log(`WebSocket-IN:  ${utils.cutString(JSON.stringify(require('../core/SensitiveLog').redact(JSON.parse(message))))}`);
            }

            req = JSON.parse(message);
            requestLimits.checkRequest(req, messageBytes, this.config, admission?.validation);
            if (admission?.profile) req[profileAdmission] = {...admission.profile,token:req.profileAccessToken};
            req.__startTime = Date.now();
            metricToken = runtimeMetrics.beginAction(req.action, clientProtocol.client(req.client));
            if (!req.profileAccessToken && this.security && ws.req && ws.req.securitySession && ws.req.securitySession.profileAccessToken)
                req.profileAccessToken = ws.req.securitySession.profileAccessToken;

            ws.lastActivity = Date.now();
            
            //pong for WebSocketConnection
            this.send({_rok: 1}, req, ws);

            //access
            const access = (!this.webAccess.closed && admission?.libraryAuthorized) || await this.webAccess.hasAccess(req.accessToken);
            if (this.security && req.accessToken) this.security.recordSocketAccess(ws.req,access);
            if (!access) {
                await utils.sleep(500);
                const salt = await this.webAccess.newToken(this.security?.clientIp(ws.req) || ws.req?.socket?.remoteAddress);
                this.send({error: 'need_access_token', salt}, req, ws);
                return;
            }

            if (this.security && this.isCsrfProtectedAction(req.action) && !this.security.hasValidCsrf(ws.req, req.csrfToken)) {
                this.send({error: 'bad_csrf_token'}, req, ws);
                return;
            }

            if (this.profileAccess)
                await this.profileAccess.prepareWebSocket(req, ws.req);

            //api
            switch (req.action) {
                case 'kosync-settings': {
                    const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    if (user.anonymousProfile) throw new Error('Войдите в личный профиль');
                    const service = this.webWorker.koSync || (this.webWorker.koSync = new (require('../core/KoSync').KoSync)(this.config, this.webWorker));
                    const update = () => service.settings(user, req.operation, req.password);
                    const result = this.security && req.operation === 'use-web-password'
                        ? await this.security.withLoginAttempt(ws.req, 'profile', update) : await update();
                    this.send(result, req, ws); break;
                }
                case 'test':
                    await this.test(req, ws); break;
                case 'logout':
                    await this.logout(req, ws); break;
                case 'get-config':
                    await this.getConfig(req, ws); break;
                case 'resume-user-profile':
                    await this.resumeUserProfile(req, ws); break;
                case 'subscribe-client-events':
                    await this.subscribeClientEvents(req, ws); break;
                case 'get-mobile-home':
                    await this.getMobileHome(req, ws); break;
                case 'get-rating-index-status':
                    this.send(this.webWorker.dbSearcher?.ratingIndex ? await this.webWorker.dbSearcher.ratingIndex.status()
                        : {state:'error',error:'Библиотека ещё не готова'},req,ws); break;
                case 'get-background-tasks':
                    this.send(await this.webWorker.getBackgroundTasks(req.userId,req.profileAccessToken),req,ws); break;
                case 'get-library-follows': {
                    const user = await this.webWorker.personalLibraryUser(req.userId,req.profileAccessToken);
                    const result = await this.readWithBudget({...req,userId:user.id},ws,
                        () => this.webWorker.libraryFollowAction(user.id,req.profileAccessToken,'list',req.options), {backgroundLane:'discovery'});
                    await this.webWorker.personalLibraryUser(user.id,req.profileAccessToken);
                    this.send(result,req,ws); break;
                }
                case 'change-library-follow':
                    this.send(await this.webWorker.libraryFollowAction(req.userId,req.profileAccessToken,req.operation,req.payload),req,ws); break;
                case 'start-library-audit':
                    this.send({audit:await this.webWorker.auditLibrary(req.userId,req.profileAccessToken,'start',req.options)},req,ws); break;
                case 'start-isbn-index':
                    this.send(await this.webWorker.manageIsbnIndex(req.userId,req.profileAccessToken,'start',req.options),req,ws); break;
                case 'cancel-isbn-index':
                    this.send(await this.webWorker.manageIsbnIndex(req.userId,req.profileAccessToken,'cancel'),req,ws); break;
                case 'cancel-library-audit':
                    this.send({audit:await this.webWorker.auditLibrary(req.userId,req.profileAccessToken,'cancel')},req,ws); break;
                case 'get-library-metadata':
                    this.send(await require('../core/LibraryExchange').respond(this.webWorker, req), req, ws); break;
                case 'get-worker-state':
                    await this.getWorkerState(req, ws); break;
                case 'catalog-suggest':
                    this.send(await this.readWithBudget(req, ws, () => this.webWorker.getCatalogDiscovery().suggest(req.options)), req, ws); break;
                case 'telegram-bot-account':
                    this.send(await this.webWorker.telegramBotAccount(req.userId, req.profileAccessToken, req.operation, req.options), req, ws); break;
                case 'admin-telegram-bot-status':
                    await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
                    this.send({telegramBotStatus:this.webWorker.getTelegramBot().status()}, req, ws); break;
                case 'catalog-browse':
                    this.send(await this.readWithBudget(req, ws, () => this.webWorker.getCatalogDiscovery().browse(req.options)), req, ws); break;
                case 'catalog-entity': {
                    const id = await this.webWorker.getProfileSessionUser(req.profileAccessToken,req[profileAdmission]);
                    const user = id ? await this.webWorker.requireAuthorizedUser(id, req.profileAccessToken, {profileProof:req[profileAdmission]}) : null;
                    this.send(await this.readWithBudget(req, ws, () => this.webWorker.getCatalogDiscovery().entity(req.options, user)), req, ws); break;
                }
                case 'mark-series-until': {
                    const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    this.send(await this.webWorker.getCatalogDiscovery().markSeriesUntil(user.id, req.options || {}), req, ws); break;
                }
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
                case 'record-discovery-events':
                    await this.recordDiscoveryEvents(req, ws); break;
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
                case 'get-admin-dashboard-metrics':
                    await this.getAdminDashboardMetrics(req, ws); break;
                case 'get-admin-performance':
                    this.send(await this.webWorker.getAdminPerformance(req.userId, req.profileAccessToken), req, ws); break;
                case 'set-admin-resource-profile':
                    this.send(await this.webWorker.setAdminResourceProfile(req.userId, req.profileAccessToken, req.profile), req, ws); break;
                case 'start-admin-benchmark':
                    this.send(await this.webWorker.startAdminBenchmark(req.userId, req.profileAccessToken, req.options || {}), req, ws); break;
                case 'cancel-admin-benchmark':
                    this.send(await this.webWorker.cancelAdminBenchmark(req.userId, req.profileAccessToken), req, ws); break;
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
                case 'update-admin-cache':
                    await this.updateAdminCache(req, ws); break;
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
                case 'import-admin-settings':
                    await this.importAdminSettings(req, ws); break;
                case 'create-admin-backup':
                    await this.createAdminBackup(req, ws); break;
                case 'import-admin-backup':
                    await this.importAdminBackup(req, ws); break;
                case 'preview-admin-backup':
                    this.send(await this.webWorker.importAdminBackup(req.userId, req.profileAccessToken, {...req.data, preview: true}), req, ws); break;
                case 'admin-backup-vault':
                    this.send(await this.webWorker.adminBackupVault(req.userId, req.profileAccessToken, req.operation, req.options), req, ws); break;
                case 'update-book-metadata':
                    await this.updateBookMetadata(req, ws); break;
                case 'get-book-link':
                    await this.getBookLink(req, ws); break;
                case 'get-book-info':
                    await this.getBookInfo(req, ws); break;
                case 'get-book-preview':
                    if(typeof req.bookUid!=='string'||!req.bookUid||req.bookUid.length>1024)throw new Error('Invalid book UID');
                    this.send(await this.readWithBudget(req,ws,()=>this.webWorker.getBookPreview(req.bookUid)),req,ws);break;
                case 'get-book-reviews':
                    if (!req.bookUid) throw new Error('bookUid is empty');
                    this.send(await this.webWorker.getBookReviewDetails(req.bookUid, req.wantProgress === true
                        ? progress => this.send({_progress:true,progress},req,ws) : null), req, ws); break;
                case 'get-book-gallery':
                    await this.getBookGallery(req, ws); break;
                case 'get-reader-state':
                    await this.getReaderState(req, ws); break;
                case 'prepare-reader-audio':
                    await this.prepareReaderAudio(req, ws); break;
                case 'get-reader-audio-status':
                    await this.getReaderAudioStatus(req, ws); break;
                case 'cancel-reader-audio': {
                    const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    this.send(getReaderSpeech(this.config).cancel(user.id, req.consumerId), req, ws); break;
                }
                case 'get-reader-audio-plan':
                    await this.getReaderAudioPlan(req, ws); break;
                case 'preview-reader-voice':
                    await this.previewReaderVoice(req, ws); break;
                case 'get-user-reading-library':
                    await this.getUserReadingLibrary(req, ws); break;
                case 'search-reader-replacement': {
                    await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    const title = String(req.title || '').trim().slice(0, 200);
                    const author = String(req.author || '').trim().slice(0, 200);
                    if (!title && !author) throw new Error('Укажите название или автора');
                    this.send(await this.webWorker.bookSearch({title, author, ext: 'fb2', del: '0', limit: 20, offset: 0}), req, ws);
                    break;
                }
                case 'update-reader-progress':
                    await this.updateReaderProgress(req, ws); break;
                case 'relink-reader-book': {
                    await this.withAuthorizedReaderProgress(req, ws, id =>
                        this.webWorker.relinkReaderBook(id, req.bookUid, req.replacementBookUid, req.baseRevision));
                    break;
                }
                case 'get-audio-position':
                case 'update-audio-position': {
                    const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    const progress = await this.webWorker.readingListStore.audioPosition(user.id, req.bookUid, req.variant,
                        req.action === 'update-audio-position' ? req.progress || {} : null);
                    this.send({progress}, req, ws);
                    break;
                }
                case 'prepare-batch-download': {
                    const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
                    const progress = req.wantProgress === true ? value => this.send({_progress:true, progress:value},req,ws) : null;
                    this.send(await require('../core/BatchDownload').create(this.webWorker, user.id, req.selection || {}, progress), req, ws);
                    break;
                }
                case 'delete-reader-progress':
                    await this.deleteReaderProgress(req, ws); break;
                case 'clear-reader-progress':
                    await this.clearReaderProgress(req, ws); break;
                case 'update-reader-preferences':
                    await this.updateReaderPreferences(req, ws); break;
                case 'add-reader-bookmark':
                    await this.addReaderBookmark(req, ws); break;
                case 'delete-reader-bookmark':
                    await this.deleteReaderBookmark(req, ws); break;
                case 'get-reading-lists':
                    await this.getReadingLists(req, ws); break;
                case 'get-overview-pinned-shelves': {
                    const user = await this.webWorker.overviewShelvesUser(req.userId, req.profileAccessToken);
                    const result = await this.readWithBudget({...req, userId:user.id}, ws,
                        () => this.webWorker.getOverviewPinnedShelves(user.id, req.profileAccessToken),
                        {backgroundLane:'overview-pinned-shelves'});
                    await this.webWorker.overviewShelvesUser(user.id, req.profileAccessToken);
                    this.send(result, req, ws); break;
                }
                case 'set-overview-pinned-shelves':
                    this.send(await this.webWorker.setOverviewPinnedShelves(req.userId, req.profileAccessToken, req.shelfIds), req, ws); break;
                case 'get-user-profiles':
                    await this.getUserProfiles(req, ws); break;
                case 'login-user-profile':
                    await this.loginUserProfile(req, ws); break;
                case 'profile-totp-enrollment': {
                    if (this.profileAccess?.bindingEnabled)
                        throw new Error('Настройте второй фактор у провайдера SSO');
                    const enroll = () => this.webWorker.enrollRequiredProfileTotp(req.operation, req.payload || {});
                    const result = this.security ? await this.security.withLoginAttempt(ws.req, 'profile', enroll,
                        value => value.profileAccessToken ? true : undefined) : await enroll();
                    if (result.profileAccessToken) this.establishProfileLogin(result, req, ws);
                    else this.send(result, req, ws);
                    break;
                }
                case 'profile-totp': {
                    if (req.profileBoundId && req.operation !== 'status')
                        throw new Error('Настройте второй фактор у провайдера SSO');
                    const update = () => this.webWorker.profileTotpAction(req.userId, req.profileAccessToken, req.operation, req.payload);
                    const result = this.security && req.operation !== 'status'
                        ? await this.security.withLoginAttempt(ws.req, 'profile', update) : await update();
                    this.send(result, req, ws); break;
                }
                case 'reset-user-profile-totp': {
                    const reset = () => this.webWorker.resetUserProfileTotp(req.userId, req.profileAccessToken,
                        req.targetUserId, req.password, req.otp);
                    this.send(this.security ? await this.security.withLoginAttempt(ws.req, 'profile', reset) : await reset(), req, ws); break;
                }
                case 'set-user-profile-totp-required': {
                    if (this.profileAccess?.bindingEnabled)
                        throw new Error('Настройте второй фактор у провайдера SSO');
                    const setRequired = () => this.webWorker.setUserProfileTotpRequired(req.userId, req.profileAccessToken,
                        req.targetUserId, req.required, req.password, req.otp);
                    this.send(this.security ? await this.security.withLoginAttempt(ws.req, 'profile', setRequired) : await setRequired(), req, ws); break;
                }
                case 'set-profile-auth-policy': {
                    if (this.profileAccess?.bindingEnabled)
                        throw new Error('Настройте защиту входа у провайдера SSO');
                    const policy = _.pick(req, ['otpRequired', 'trustedBrowsersEnabled', 'trustedBrowserDays']);
                    const setPolicy = () => this.webWorker.setProfileAuthPolicy(req.userId, req.profileAccessToken, policy, req.password, req.otp);
                    this.send(this.security ? await this.security.withLoginAttempt(ws.req, 'profile', setPolicy) : await setPolicy(), req, ws); break;
                }
                case 'logout-user-profile':
                    await this.logoutUserProfile(req, ws); break;
                case 'create-user-profile':
                    await this.createUserProfile(req, ws); break;
                case 'update-user-profile':
                    await this.updateUserProfile(req, ws); break;
                case 'set-user-profile-blocked':
                    this.send(await this.webWorker.setUserProfileBlocked(req.userId, req.profileAccessToken, req.targetUserId, req.blocked), req, ws); break;
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
            metricOk = true;
            await this.publishClientChanges(req,ws).catch(error=>log(LM_ERR,error));
        } catch (e) {
            this.send({error: e.message, errorCode:e.code || e.message,
                ...((e.retryAfterMs || e.retryAfter) ? {retryAfterMs:e.retryAfterMs || e.retryAfter * 1000} : {})}, req || {}, ws);
        } finally {
            if (!admission) {
                ws.activeRequests--;
                this.activeRequests--;
                if (large) this.largeRequestActive = false;
            }
            runtimeMetrics.endAction(metricToken, metricOk);
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
                const loggedMessage = JSON.stringify(require('../core/SensitiveLog').redact(r));
                log(`WebSocket-OUT: ${utils.cutString(loggedMessage)}`);
                log(`${Date.now() - req.__startTime}ms`);
            }

        }
    }

    isCsrfProtectedAction(action = '') {
        return new Set([
            'kosync-settings',
            'logout',
            'change-library-follow',
            'get-library-follows',
            'start-library-audit',
            'start-isbn-index',
            'cancel-isbn-index',
            'cancel-library-audit',
            'login-user-profile',
            'profile-totp',
            'profile-totp-enrollment',
            'reset-user-profile-totp',
            'set-user-profile-totp-required',
            'set-profile-auth-policy',
            'resume-user-profile',
            'subscribe-client-events',
            'logout-user-profile',
            'create-user-profile',
            'update-user-profile',
            'set-user-profile-blocked',
            'delete-user-profile',
            'update-discovery-preferences',
            'record-discovery-events',
            'update-shared-discovery-config',
            'update-admin-integrations',
            'update-admin-opds',
            'set-admin-resource-profile',
            'start-admin-benchmark',
            'cancel-admin-benchmark',
            'update-admin-event-log',
            'add-admin-test-event',
            'update-admin-library-sources',
            'admin-diagnose-library-source',
            'update-admin-cache',
            'admin-clean-cache',
            'admin-clean-broken-covers',
            'admin-rebuild-cover',
            'admin-reindex',
            'import-admin-settings',
            'import-admin-backup',
            'preview-admin-backup',
            'admin-backup-vault',
            'telegram-bot-account',
            'update-reader-progress',
            'relink-reader-book',
            'update-audio-position',
            'prepare-batch-download',
            'prepare-reader-audio',
            'cancel-reader-audio',
            'preview-reader-voice',
            'delete-reader-progress',
            'clear-reader-progress',
            'update-reader-preferences',
            'add-reader-bookmark',
            'delete-reader-bookmark',
            'create-reading-list',
            'rename-reading-list',
            'set-reading-list-visibility',
            'set-overview-pinned-shelves',
            'delete-reading-list',
            'import-reading-lists',
            'update-reading-list-book',
            'set-reading-list-book-read',
            'mark-reader-books-read',
            'mark-series-read',
            'mark-series-until',
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
        const clientApi = this.profileAccess?.bindingEnabled ? {...clientProtocol.info,
            features:clientProtocol.info.features.filter(feature => !['adminProfileTotpPolicy','profileAuthPolicy'].includes(feature))} : clientProtocol.info;
        const trustPolicy = this.webWorker.readingListStore?.profileAuthPolicy;
        const canRememberProfileDevice = require('../core/ProfileTrustedDevices').available(trustPolicy)
            && req.client?.type !== 'android' && !this.profileAccess?.bindingEnabled
            && !!this.security?.secureBrowserSession(ws.req);
        const trustedBrowserDays = canRememberProfileDevice ? trustPolicy?.trustedBrowserDays : undefined;
        if (req.profileLoginRequired) {
            const config = _.pick(this.config, ['name', 'version', 'branch', 'dbVersion', 'rootPathStatic']);
            Object.assign(config, {clientApi,profileLoginRequired: true, profileAuthorized: false, userProfiles: [],
                currentUserId: '', currentUserProfile: null, freeAccess: this.webAccess.freeAccess, canRememberProfileDevice, trustedBrowserDays});
            if (this.security)
                config.csrfToken = this.security.getCsrfToken(ws.req);
            this.send(config, req, ws);
            return;
        }
        const config = _.pick(this.config, this.config.webConfigParams);
        config.conversionFormats = require('../core/BookConverter').formatSettings(this.config).conversionFormats;
        config.clientApi = clientApi;
        config.libraryProtocol = require('../core/LibraryExchange').protocol;
        config.ttsEnabled = Boolean(this.config.ttsEnabled && this.config.ttsUrl);
        config.ebookReaderEnabled = !this.webWorker.remoteLib;
        config.profileLoginRequired = this.profileAccess?.loginRequired ?? ProfileAccess.localLoginRequired(this.config);
        config.profileBoundId = req.profileBoundId || '';
        config.canRememberProfileDevice = canRememberProfileDevice;
        config.trustedBrowserDays = trustedBrowserDays;
        config.librarySources = (Array.isArray(this.config.librarySources) ? this.config.librarySources : []).map(source => ({
            id: source.id || '',
            name: source.name || source.id || '',
            enabled: source.enabled !== false,
        }));
        if (this.security)
            config.csrfToken = this.security.getCsrfToken(ws.req);
        config.discovery = Object.assign(
            {},
            config.discovery || {},
            await this.webWorker.getSharedDiscoveryConfig(),
        );
        config.dbConfig = await this.webWorker.dbConfig();
        config.freeAccess = this.webAccess.freeAccess;
        const currentProfile = await this.webWorker.getCurrentUserProfile(req.userId, req.profileAccessToken,req[profileAdmission]);
        const profiles = await this.webWorker.getUserProfiles(req.userId,
            {includeTotpStatus: currentProfile.profileAuthorized && currentProfile.currentUserProfile?.isAdmin === true});
        config.userProfiles = this.profileAccess ? this.profileAccess.filterProfiles(profiles.users, req) : profiles.users;
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
            && currentUser
            && currentUser.telegramChatId
        );
        config.emailShareEnabled = !!(
            this.config.emailShareEnabled
            && this.config.smtpHost
            && currentUser
            && (currentUser.emailTo || this.config.emailTo)
        );
        if (currentUser && currentUser.isAdmin && config.profileAuthorized) {
            if (!this.profileAccess?.bindingEnabled) config.profileAuthPolicy = this.webWorker.readingListStore?.profileAuthPolicy;
            config.adminIntegrations = this.webWorker.getAdminIntegrationConfig();
            config.adminOpds = this.webWorker.getAdminOpdsConfig();
        }

        this.send(config, req, ws);
    }

    async getWorkerState(req, ws) {
        if (req.profileLoginRequired) {
            const state = this.workerState.getState('server_state') || {};
            this.send({state: state.state || 'normal', serverMessage: state.state === 'normal' ? '' : 'Подготовка библиотеки'}, req, ws);
            return;
        }
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

        const result = await this.readWithBudget(req,ws,()=>this.webWorker.search(req.from, req.query));

        this.send(result, req, ws);
    }

    async bookSearch(req, ws) {
        if (!this.config.extendedSearch)
            throw new Error('config.extendedSearch disabled');
        if (!req.query)
            throw new Error(`query is empty`);

        const result = await this.readWithBudget(req,ws,()=>this.webWorker.bookSearch(req.query));

        this.send(result, req, ws);
    }

    async getAuthorBookList(req, ws) {
        const result = await this.readWithBudget(req,ws,()=>this.webWorker.getAuthorBookList(req.authorId, undefined, req.query));

        this.send(result, req, ws);
    }

    async getAuthorSeriesList(req, ws) {
        const result = await this.readWithBudget(req,ws,()=>this.webWorker.getAuthorSeriesList(req.authorId, req.query));

        this.send(result, req, ws);
    }

    async getAuthorInfo(req, ws) {
        const result = await this.webWorker.getAuthorInfo(req.authorId, req.author);

        this.send(result, req, ws);
    }

    async getSeriesBookList(req, ws) {
        const result = await this.readWithBudget(req,ws,()=>this.webWorker.getSeriesBookList(req.series, req.query));

        this.send(result, req, ws);
    }

    async getGenreTree(req, ws) {
        const result = await this.webWorker.getGenreTree();

        this.send(result, req, ws);
    }

    async getDiscoveryShelves(req, ws) {
        const externalOnly = req.externalOnly === true && req.recommendationsOnly !== true;
        const result = await this.readWithBudget(req,ws,()=>this.webWorker.getDiscoveryShelvesV2({
            userId: req.userId,
            profileAccessToken: req.profileAccessToken,
            forceRefresh: req.forceRefresh === true,
            personalSimilarEnabled: req.personalSimilarEnabled,
            recommendationsOnly: req.recommendationsOnly === true,
            externalOnly,
            includeExternal: req.includeExternal !== false,
            personalLimit: req.personalLimit,
            newestLimit: req.newestLimit,
            popularLimit: req.popularLimit,
            externalLimit: req.externalLimit,
            externalSource: req.externalSource,
            externalName: req.externalName,
            externalUrl: req.externalUrl,
            externalTtlMinutes: req.externalTtlMinutes,
            externalBrowseUrl: req.externalBrowseUrl,
            externalBrowseName: req.externalBrowseName,
        }), {backgroundLane:externalOnly ? 'external-discovery' : 'discovery'});

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

    async recordDiscoveryEvents(req, ws) {
        const result = await this.webWorker.recordDiscoveryEvents(
            req.userId,
            req.profileAccessToken,
            req.events || [],
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

    async getAdminDashboardMetrics(req, ws) {
        const result = await this.webWorker.getAdminDashboardMetrics(req.userId, req.profileAccessToken);
        result.clientRequests = this.clientRequests?.snapshot() || {active:0,queued:0};
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
        const result = await this.webWorker.runAdminCacheCleanKind(req.userId, req.profileAccessToken, req.kind || 'all');
        this.send(result, req, ws);
    }

    async updateAdminCache(req, ws) {
        const result = await this.webWorker.updateAdminCacheConfig(req.userId, req.profileAccessToken, req.cache || {});
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

        const result = (req.card === true ? await this.webWorker.getBookCardInfo(req.bookUid, {lazyExtras:req.lazyExtras === true})
            : await this.webWorker.getBookInfo(req.bookUid, {readerOnly: req.readerOnly === true}));

        this.send(result, req, ws);
    }

    async getBookGallery(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        this.send(await this.readWithBudget(req, ws, () => this.webWorker.getBookGallery(req.bookUid)), req, ws);
    }

    async getReadingLists(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken, {profileProof:req[profileAdmission]});
        const result = await this.webWorker.getReadingLists(user.id, req.bookUid, req.options || {});
        this.send(result, req, ws);
    }

    async getReaderState(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        await this.withAuthorizedReaderProgress(req, ws, id => this.webWorker.getReaderState(id, req.bookUid));
    }

    async prepareReaderAudio(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const speech = getReaderSpeech(this.config);
        const consumer = speech.consumer(user.id, req.consumerId);
        if (consumer?.cancelled) return this.send({state:'cancelled'}, req, ws);
        if (!speech.enabled) throw new Error('Серверная озвучка не настроена.');
        if (!req.bookUid) throw new Error('bookUid is empty');
        const {bookInfo} = await this.webWorker.getBookInfo(req.bookUid, {readerOnly:true});
        if (consumer?.cancelled) return this.send({state:'cancelled'}, req, ws);
        const result = req.mode ? await speech.preparePart(user.id, req.bookUid, bookInfo, req.speaker || 'xenia', req.mode, req.chapterIndex, req.options, req.consumerId)
            : await speech.prepare(user.id, req.bookUid, bookInfo, req.speaker || 'xenia', req.options, req.consumerId);
        this.send(result, req, ws);
    }

    async getReaderAudioPlan(req, ws) {
        await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        if (!req.bookUid) throw new Error('bookUid is empty');
        const {bookInfo} = await this.webWorker.getBookInfo(req.bookUid, {readerOnly:true});
        this.send(await getReaderSpeech(this.config).plan(bookInfo, req.mode || 'online', req.anchor || null), req, ws);
    }

    async previewReaderVoice(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        this.send(await getReaderSpeech(this.config).preview(user.id, req.speaker || 'xenia', req.options, req.sampleText, req.consumerId), req, ws);
    }

    async getReaderAudioStatus(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        this.send(getReaderSpeech(this.config).status(user.id, req.jobId), req, ws);
    }

    async getUserReadingLibrary(req, ws) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getUserReadingLibrary(user, req.options || {});
        this.send(result, req, ws);
    }

    async updateReaderProgress(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        await this.withAuthorizedReaderProgress(req, ws, id => this.webWorker.updateReaderProgress(id, req.bookUid, req.progress || {}));
    }

    async deleteReaderProgress(req, ws) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        await this.withAuthorizedReaderProgress(req, ws, id => this.webWorker.deleteReaderProgress(id, req.bookUid));
    }

    async clearReaderProgress(req, ws) {
        await this.withAuthorizedReaderProgress(req, ws, id => this.webWorker.clearReaderProgress(id));
    }

    async withAuthorizedReaderProgress(req, ws, work) {
        const result = await withFileTransaction(this.webWorker.readingListStore.file, async() => {
            // Recheck after an earlier credential change, removal, or restore.
            const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken, {identityOnly: true, exactId: true});
            return await work(user.id);
        });
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
        const result = await this.webWorker.getUserProfiles(req.userId, {profileAccessToken:req.profileAccessToken,profileProof:req[profileAdmission]});
        if (this.profileAccess)
            result.users = this.profileAccess.filterProfiles(result.users, req);
        this.send(result, req, ws);
    }

    async loginUserProfile(req, ws) {
        const verify = () => this.webWorker.loginUserProfile(req.login, req.password, req.otp);
        const result = this.security ? await this.security.withLoginAttempt(ws.req, 'profile', verify) : await verify();
        this.establishProfileLogin(result, req, ws);
    }

    establishProfileLogin(result, req, ws) {
        if (this.security && ws.req && ws.req.securitySession)
            ws.req.securitySession.profileAccessToken = result.profileAccessToken;
        ws.userId = String(result.userId || '').trim();
        ws.userLastActivity = Date.now();
        this.send(result, req, ws);
    }

    async resumeUserProfile(req,ws) {
        const id=await this.webWorker.getProfileSessionUser(req.profileAccessToken,req[profileAdmission]);
        if(!id)throw Object.assign(new Error('need_profile_login'),{code:'need_profile_login'});
        const user=await this.webWorker.requireAuthorizedUser(id,req.profileAccessToken,{profileProof:req[profileAdmission]});
        if(req.userId&&req.userId!==user.id)throw new Error('need_profile_login');
        if(this.security&&ws.req?.securitySession)ws.req.securitySession.profileAccessToken=req.profileAccessToken;
        ws.userId=user.id;ws.userLastActivity=Date.now();
        this.send({userId:user.id,profileAccessToken:req.profileAccessToken},req,ws);
    }

    async subscribeClientEvents(req,ws) {
        const user=await this.webWorker.requireAuthorizedUser(req.userId,req.profileAccessToken,{profileProof:req[profileAdmission]});
        const enabled=await this.webWorker.getProfileSessionUser(req.profileAccessToken,req[profileAdmission])===user.id;
        ws.clientEvents=enabled?{userId:user.id,token:req.profileAccessToken}:null;
        this.send({enabled},req,ws);
    }

    async publishClientChanges(req,origin) {
        const audio=req.action==='update-audio-position';
        if(!audio&&!clientProtocol.readerChanges.has(req.action))return;
        const id=await this.webWorker.getProfileSessionUser?.(req.profileAccessToken);
        if(!id)return;
        await this.publishUserChange(id, audio ? 'audio' : 'reader', req.bookUid, origin);
    }

    async publishUserChange(id, kind, bookUid, origin) {
        for(const socket of this.wss?.clients||[]) {
            if(socket===origin)continue;
            const subscription=socket.clientEvents;
            if(!subscription||subscription.userId!==id||socket.readyState!==WebSocket.OPEN)continue;
            const owner = await this.webWorker.getProfileSessionUser(subscription.token);
            if (socket.clientEvents !== subscription || socket.readyState !== WebSocket.OPEN) continue;
            if(owner!==id){socket.close(1008,'Session expired');continue;}
            socket.lastActivity=Date.now();
            socket.send(JSON.stringify({type:'client-event',kind,bookUid:String(bookUid||'').slice(0,1024)}));
        }
    }

    async getMobileHome(req,ws) {
        const user=await this.webWorker.requireAuthorizedUser(req.userId,req.profileAccessToken);
        const [reading,lists]=await Promise.all([
            this.webWorker.getUserReadingLibrary(user,{state:'all',sort:'updatedDesc',limit:Math.max(1,Math.min(300,Number(req.limit)||100))}),
            this.webWorker.getReadingLists(user.id,'',{}),
        ]);
        this.send({profile:_.pick(user,['id','name','login','createdAt','isAdmin']),reading,lists:lists.lists||[],
            indexGeneration:this.webWorker.libraryAssetGeneration||0},req,ws);
    }

    async readWithBudget(req,ws,work,options) {
        if(!this.clientRequests)this.clientRequests=new (require('../core/ClientRequestBudget'))({background:2});
        const user=await this.webWorker.getProfileSessionUser?.(req.profileAccessToken,req[profileAdmission]);
        const identity=user?`profile:${user}`:`guest:${this.security?.clientIp(ws.req)||ws.req?.socket?.remoteAddress||'local'}`;
        const payload=_.omit(req,['requestId','accessToken','csrfToken','profileAccessToken','client','__startTime']);
        const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
            ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
        return this.clientRequests.run(identity,JSON.stringify(canonical(payload)),work,()=>ws.readyState===WebSocket.OPEN,options);
    }

    async logoutUserProfile(req, ws) {
        const session = this.security && ws.req && ws.req.securitySession;
        const tokens = new Set([req.profileAccessToken, session && session.profileAccessToken].filter(Boolean));
        for (const token of tokens) await this.webWorker.closeProfileSession(token);
        if (session) session.profileAccessToken = undefined;
        delete ws.userId;
        delete ws.userLastActivity;
        delete ws.clientEvents;
        this.send({success: true}, req, ws);
    }

    async createUserProfile(req, ws) {
        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        const profile = Object.assign({}, req.profile || {});
        delete profile.passwordHash;
        if (profile.password && !String(profile.login || '').trim())
            throw new Error('Для пароля нужно указать логин');
        if (profile.password)
            profile.passwordHash = await this.webWorker.hashProfilePassword(profile.login, profile.password);
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
        delete profile.passwordHash;
        const passwordLogin = String(profile.login || target.login || '').trim();
        if (profile.password && !passwordLogin)
            throw new Error('Для пароля нужно указать логин');
        if (profile.password)
            profile.passwordHash = await this.webWorker.hashProfilePassword(passwordLogin, profile.password);
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
        const result = await this.webWorker.createReadingList(user.id, req.name, req.visibility, req.filters);
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
        const result = await this.webWorker.setReadingListVisibility(user.id, req.listId, req.visibility, req.opds);
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

    async importAdminSettings(req, ws) {
        const result = await this.webWorker.importAdminSettings(req.userId, req.profileAccessToken, req.data);
        this.send(result, req, ws);
    }

    async createAdminBackup(req, ws) {
        const result = await this.webWorker.createAdminBackup(req.userId, req.profileAccessToken);
        this.send(result, req, ws);
    }

    async importAdminBackup(req, ws) {
        const result = await this.webWorker.importAdminBackup(req.userId, req.profileAccessToken, req.data);
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
