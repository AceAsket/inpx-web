const {parseBasicAuth, equal} = require('./opds/Auth');

const bootstrapActions = new Set(['test', 'get-config', 'get-worker-state', 'login-user-profile', 'logout-user-profile', 'logout']);

function denied(message = 'need_profile_login', status = 401) {
    const error = new Error(message);
    error.status = status;
    return error;
}

class ProfileAccess {
    constructor(config, worker, security) {
        this.config = config;
        this.worker = worker;
        this.security = security;
    }

    get loginRequired() {
        return this.config.allowAnonymousAccess === false;
    }

    get bindingEnabled() {
        return this.config.proxyBindProfile === true && String(this.config.authMode || '').trim().toLowerCase() === 'proxy';
    }

    clearBinding(session) {
        if (!session || !session.proxyProfileUserId)
            return;
        this.worker.closeProfileSession(session.profileAccessToken);
        delete session.profileAccessToken;
        delete session.proxyProfileUserId;
        delete session.proxyProfileLogin;
    }

    async resolve(req, token = '') {
        let session = this.security && this.security.getSession(req);
        if (this.bindingEnabled) {
            const auth = this.security.verifyRequiredAuth(req);
            if (!auth.ok)
                throw denied(auth.message, auth.status);
            const login = this.worker.readingListStore.normalizeLogin(this.security.getProxyAuthUser(req));
            const data = await this.worker.readingListStore.load();
            const user = data.users.find(item => item.login && item.login === login);
            if (user) {
                session = this.security.ensureSession(req);
                if (session.proxyProfileUserId !== user.id || session.proxyProfileLogin !== login)
                    this.clearBinding(session);
                if (this.worker.getProfileSessionUser(session.profileAccessToken) !== user.id) {
                    session.profileAccessToken = this.worker.createProfileSession(user.id);
                    session.proxyProfileUserId = user.id;
                    session.proxyProfileLogin = login;
                }
                return {user, token: session.profileAccessToken, bound: true};
            }
        }
        // A removed/renamed SSO profile must not leave an old authenticated token.
        this.clearBinding(session);
        const accessToken = token || (session && session.profileAccessToken) || '';
        const id = this.worker.getProfileSessionUser(accessToken);
        if (!id)
            return null;
        const data = await this.worker.readingListStore.load();
        const user = data.users.find(item => item.id === id);
        return user ? {user, token: accessToken, bound: false} : null;
    }

    assertProfile(identity, requested = '') {
        if (!requested || requested === identity.user.id || requested === identity.user.login)
            return;
        throw denied(identity.bound ? 'Профиль закреплён за пользователем proxy' : 'need_profile_login', identity.bound ? 403 : 401);
    }

    async prepareWebSocket(req, socketRequest) {
        delete req.profileBoundId;
        delete req.profileLoginRequired;
        if (!this.loginRequired && !this.bindingEnabled && !(socketRequest.securitySession && socketRequest.securitySession.proxyProfileUserId))
            return;
        const identity = await this.resolve(socketRequest, req.profileAccessToken);
        if (identity && (identity.bound || this.loginRequired)) {
            if (!['get-config', 'get-user-profiles', 'logout-user-profile'].includes(req.action))
                this.assertProfile(identity, String(req.userId || '').trim());
            if (identity.bound && req.action === 'login-user-profile')
                throw denied('Профиль закреплён за пользователем proxy', 403);
            if (identity.bound && req.action === 'update-user-profile' && req.targetUserId === identity.user.id
                && req.profile && Object.hasOwn(req.profile, 'login')
                && this.worker.readingListStore.normalizeLogin(req.profile.login) !== identity.user.login)
                throw denied('Логин профиля закреплён за пользователем proxy', 403);
            req.userId = identity.user.id;
            req.profileAccessToken = identity.token;
            req.profileBoundId = identity.bound ? identity.user.id : '';
        }
        if (this.loginRequired && !identity && !bootstrapActions.has(req.action))
            throw denied();
        req.profileLoginRequired = this.loginRequired && !identity;
    }

    filterProfiles(users, req) {
        if (req.profileBoundId) {
            const current = users.find(user => user.id === req.profileBoundId);
            return (current && current.isAdmin ? users : users.filter(user => user.id === req.profileBoundId))
                .map(user => user.id === req.profileBoundId ? {...user, requiresLogin: false} : user);
        }
        return users;
    }

    async basicIdentity(req) {
        const credentials = parseBasicAuth(req.headers.authorization);
        if (!credentials || !this.config.opds || !this.config.opds.enabled)
            return null;
        this.security.checkLoginRate(req, 'opds');
        let identity = null;
        if (this.config.opds.password) {
            if (this.config.opds.user && equal(credentials.user, this.config.opds.user) && equal(credentials.password, this.config.opds.password))
                identity = {opds: true};
        } else {
            const data = await this.worker.readingListStore.load();
            const login = this.worker.readingListStore.normalizeLogin(credentials.user);
            const user = data.users.find(item => item.login === login && item.opdsEnabled !== false && item.opdsAuthEnabled === true);
            if (user && await this.worker.readingListStore.verifyUserPassword(user.id, credentials.password))
                identity = {user, opds: true, bound: true};
        }
        this.security.checkLoginRate(req, 'opds');
        this.security.recordLoginAttempt(req, !!identity, 'opds');
        return identity;
    }

    httpGuard(opds = false) {
        return async(req, res, next) => {
            if (!this.loginRequired && !this.bindingEnabled)
                return next();
            try {
                let identity = await this.resolve(req);
                if (!identity && this.loginRequired)
                    identity = await this.basicIdentity(req);
                if (!identity && this.loginRequired) {
                    res.set('WWW-Authenticate', 'Basic realm="inpx-web OPDS", charset="UTF-8"');
                    throw denied('Authentication required');
                }
                if (identity && identity.user && (identity.bound || this.loginRequired)) {
                    this.assertProfile(identity, String((req.query && req.query.user) || '').trim());
                    req.profileAccessIdentity = identity;
                    if (opds) {
                        req.query.user = identity.user.id;
                        req.opdsAuthorized = true;
                    }
                } else if (identity && identity.opds) {
                    req.opdsAuthorized = true;
                }
                next();
            } catch (error) {
                res.set('Cache-Control', 'no-store');
                if (error.code === 'INPX_LOGIN_RATE_LIMIT') {
                    res.set('Retry-After', String(error.retryAfter));
                    return res.status(429).send('Too many login attempts. Try again later.');
                }
                if (error.status)
                    return res.status(error.status).send(error.message);
                next(error);
            }
        };
    }
}

module.exports = ProfileAccess;
