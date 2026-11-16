const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const sessionLifetime = require('./SessionLifetime');
const rustAuthState = require('./RustAuthState');
const RustBrowserSessions = require('./RustBrowserSessions');
const {acceptAccess} = require('./RustHttpServer');

const sessionCookieName = 'inpx_web_session';
const secretFileName = 'session-secret';
const defaultLoginWindowMs = 15*60*1000;
const defaultLoginMaxAttempts = 8;
const proxyAuthCookieName = 'inpx_web_proxy_auth';

function parseIpv4(value = '') {
    const normalized = String(value || '').trim()
        .replace(/^::ffff:/i, '')
        .replace(/^::1$/, '127.0.0.1');
    const parts = normalized.split('.');
    if (parts.length !== 4)
        return null;

    let result = 0;
    for (const part of parts) {
        if (!/^\d+$/.test(part))
            return null;

        const n = Number(part);
        if (n < 0 || n > 255)
            return null;

        result = (result << 8) + n;
    }

    return result >>> 0;
}

function parseCidr(value = '') {
    const raw = String(value || '').trim();
    if (!raw)
        return null;

    const [ip, bitsRaw] = raw.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    const base = parseIpv4(ip);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
        return null;

    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return {base: (base & mask) >>> 0, mask};
}

function timingSafeStringEqual(a = '', b = '') {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function logSecurityWarning(message = '') {
    try {
        new (require('./AppLogger'))().log(LM_WARN, message);
    } catch (e) {
        // Security checks must keep working even before the app logger is initialized.
    }
}

function loginLimitError(retryAfter) {
    return Object.assign(new Error('Too many login attempts. Try again later.'), {
        code: 'INPX_LOGIN_RATE_LIMIT', retryAfter,
    });
}

class Security {
    constructor(config) {
        this.config = config;
        this.expressTrustProxy = !!config.trustProxy;
        this.nativeAuth = rustAuthState.open();
        this.sessions = this.nativeAuth ? new RustBrowserSessions(this.nativeAuth) : new Map();
        this.loginAttempts = new Map();
        this.activeLoginAttempts = new Map();
        this.lastLoginAttemptSweep = 0;
        this.loginAttemptTotals = new Map();
        this.secret = '';
        this.trustedProxyRanges = (config.trustedProxyCidrs || []).map(parseCidr).filter(Boolean);
    }

    get trustedProxyRanges() {
        const configured = this.config.trustedProxyCidrs;
        if (this.proxyRangesSource !== configured) {
            this.trustedProxyRanges = (configured || []).map(parseCidr).filter(Boolean);
        }
        return this.proxyRanges;
    }

    set trustedProxyRanges(ranges) {
        this.proxyRangesSource = this.config.trustedProxyCidrs;
        this.proxyRanges = ranges;
    }

    async init() {
        const secretFile = path.join(this.config.dataDir, secretFileName);
        if (await fs.pathExists(secretFile)) {
            this.secret = String(await fs.readFile(secretFile, 'utf8')).trim();
        }

        if (!this.secret) {
            this.secret = crypto.randomBytes(48).toString('hex');
            await fs.outputFile(secretFile, this.secret, {encoding: 'utf8', mode: 0o600});
        }
    }

    sign(value) {
        if (this.nativeAuth) return this.sessions.sign(value);
        return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
    }

    get secret() {
        return this.sessionSecret;
    }

    set secret(value) {
        if (this.sessionSecret === value) return;
        this.sessionSecret = value;
        if (this.nativeAuth) this.sessions.setKey(value);
    }

    randomToken(bytes = 32) {
        return crypto.randomBytes(bytes).toString('hex');
    }

    cookieOptions(req) {
        const root = this.config.rootPathStatic || '/';
        const secure = this.isSecureRequest(req);
        return [
            'HttpOnly',
            'SameSite=Lax',
            `Path=${root || '/'}`,
            'Max-Age=2592000',
            ...(secure ? ['Secure'] : []),
        ].join('; ');
    }

    parseCookies(header = '') {
        const result = {};
        for (const part of String(header || '').split(';')) {
            const idx = part.indexOf('=');
            if (idx < 0)
                continue;

            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (key) {
                try {
                    result[key] = decodeURIComponent(value);
                } catch (e) {
                    // Ignore malformed cookies instead of failing the request.
                }
            }
        }
        return result;
    }

    packSessionId(sessionId) {
        return `${sessionId}.${this.sign(sessionId)}`;
    }

    unpackSessionId(raw = '') {
        const [sessionId, signature] = String(raw || '').split('.');
        if (!sessionId || !signature)
            return '';

        return this.verifyCookieSignature(sessionId,signature) ? sessionId : '';
    }

    verifyCookieSignature(value, signature) {
        return this.nativeAuth ? this.sessions.verifySignature(value,signature)
            : timingSafeStringEqual(signature,this.sign(value));
    }

    getSession(req) {
        if (this.nativeAuth) {
            const current = req.securitySession;
            const session = current ? this.sessions.load(current.id,Date.now(),current)
                : this.sessions.fromCookie(this.parseCookies(req.headers.cookie)[sessionCookieName] || '',Date.now());
            if (session) req.securitySession = session;
            else delete req.securitySession;
            return session;
        }
        const cookies = this.parseCookies(req.headers.cookie || '');
        const sessionId = req.securitySession ? req.securitySession.id
            : this.unpackSessionId(cookies[sessionCookieName] || '');
        const session = this.sessions.get(sessionId);
        if (sessionLifetime.expired(session)) {
            this.sessions.delete(sessionId);
            delete req.securitySession;
            return null;
        }
        session.updatedAt = Date.now();
        req.securitySession = session;
        return session;
    }

    ensureSession(req, res = null) {
        let session = this.getSession(req);

        if (!session) {
            const sessionId = this.randomToken(24);
            const csrfToken = this.randomToken(32);
            const now = Date.now();
            if (this.nativeAuth) session = this.sessions.create(sessionId,csrfToken,now);
            else {
                sessionLifetime.makeRoom(this.sessions,now);
                session = {id:sessionId,csrfToken,createdAt:now,updatedAt:now};
                this.sessions.set(sessionId,session);
            }
        }

        req.securitySession = session;

        if (res) {
            res.setHeader(
                'Set-Cookie',
                `${sessionCookieName}=${encodeURIComponent(this.packSessionId(session.id))}; ${this.cookieOptions(req)}`
            );
        }

        return session;
    }

    isSecureRequest(req) {
        return !!(req.secure || this.requestProto(req) === 'https' || this.forwardedProto(req) === 'https');
    }

    secureBrowserSession(req) {
        if (!req || !this.isSecureRequest(req) || !this.normalizeOrigin(req.headers.origin).startsWith('https://')
            || !this.isSameOrigin(req)) return null;
        const cookies = this.parseCookies(req.headers.cookie);
        if (this.nativeAuth) {
            const session = this.sessions.fromCookie(cookies[sessionCookieName] || '',Date.now(),req.securitySession);
            if (session) req.securitySession = session;
            return session;
        }
        const id = this.unpackSessionId(cookies[sessionCookieName]);
        const session = id && this.getSession(req);
        return session && session.id === id ? session : null;
    }

    applySecurityHeaders(req, res) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        if (this.isSecureRequest(req)) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
        }
    }

    middleware() {
        return (req, res, next) => {
            this.applySecurityHeaders(req, res);
            // Only a document navigation needs a new browser session. Polling and
            // public assets must not allocate a session on every cookie-less hit.
            const pathname = String(req.path || '/');
            const root = String(this.config.rootPathStatic || '').replace(/\/$/, '');
            const documentRequest = pathname === `${root}/` || pathname === root
                || String(req.headers.accept || '').includes('text/html');
            if (!this.isHealthPath(req) && !this.isMetricsPath(req) && documentRequest)
                this.ensureSession(req, res);
            else
                this.getSession(req);
            next();
        };
    }

    requiredAuthMiddleware() {
        return (req, res, next) => {
            if (acceptAccess(req,'http')) return next();
            const result = this.verifyRequiredAuth(req);
            if (result.ok) {
                next();
                return;
            }

            res.status(result.status || 401).send(result.message || 'Authentication required');
        };
    }

    requestAccessPolicy() {
        const config = this.config;
        const root = String(config.rootPathStatic || '').replace(/\/$/,'');
        const metricsPath = String(config.metricsPath || '/metrics').replace(/\/+$/,'') || '/';
        return {
            requireProxy:String(config.authMode || 'local').trim().toLowerCase()==='proxy'
                && !!(config.requireAuth || config.proxyBindProfile),
            proxyHeader:String(config.proxyAuthHeader || 'Remote-User').trim().toLowerCase(),
            trustProxy:!!config.trustProxy,expressTrustProxy:this.expressTrustProxy,
            trustedRanges:this.trustedProxyRanges.map(({base,mask})=>({base,mask})),
            authExemptHealth:config.authExemptHealth!==false,root,
            metrics:{path:metricsPath,exempt:!!config.metricsEnabled && config.metricsExemptAuth===true,
                token:config.metricsEnabled ? String(config.metricsToken || '').trim() : ''},
            metadataService:config.absEnabled && config.absToken
                ? {path:require('./AudiobookshelfProvider').rootPath(config),token:config.absToken} : undefined,
        };
    }

    isHealthPath(req) {
        const pathname = String((req && req.path) || '').replace(/\/+$/, '') || '/';
        return ['/health', '/ready', '/api/index-status'].includes(pathname);
    }

    isMetricsPath(req) {
        const pathname = String((req && req.path) || '').replace(/\/+$/, '') || '/';
        const metricsPath = String(this.config.metricsPath || '/metrics').replace(/\/+$/, '') || '/metrics';
        return pathname === metricsPath;
    }

    isTrustedProxy(req) {
        if (!this.config.trustProxy)
            return false;

        const address = req && req.socket ? req.socket.remoteAddress : '';
        return this.isTrustedProxyAddress(address);
    }

    isTrustedProxyAddress(address = '') {
        const ip = parseIpv4(address);
        if (ip === null)
            return false;

        return this.trustedProxyRanges.some(range => (ip & range.mask) >>> 0 === range.base);
    }

    forwardedHeader(req, name = '') {
        if (!this.isTrustedProxy(req))
            return '';

        return this.headerFirstValue(req, name);
    }

    headerFirstValue(req, name = '') {
        return String(req.headers[String(name || '').toLowerCase()] || '').split(',')[0].trim();
    }

    forwardedProto(req) {
        return this.forwardedHeader(req, 'x-forwarded-proto');
    }

    forwardedHost(req) {
        return this.forwardedHeader(req, 'x-forwarded-host');
    }

    requestHost(req) {
        return this.headerFirstValue(req, 'host');
    }

    requestProto(req) {
        return (req.socket && req.socket.encrypted ? 'https' : 'http');
    }

    getProxyAuthUser(req) {
        if (!this.isTrustedProxy(req))
            return '';

        const headerName = String(this.config.proxyAuthHeader || 'Remote-User').trim().toLowerCase();
        return String(req.headers[headerName] || '').trim();
    }

    proxyAuthCookieValue(user = '') {
        const normalized = String(user || '').trim();
        const issuedAt = Date.now();
        return `${normalized}.${issuedAt}.${this.sign(`proxy:${normalized}:${issuedAt}`)}`;
    }

    unpackProxyAuthCookie(raw = '') {
        const value = String(raw || '');
        const splitAt = value.lastIndexOf('.');
        if (splitAt <= 0)
            return '';

        const payload = value.slice(0, splitAt);
        const timeAt = payload.lastIndexOf('.');
        if (timeAt <= 0)
            return '';
        const user = payload.slice(0, timeAt);
        const issuedAt = Number(payload.slice(timeAt + 1));
        if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt >= sessionLifetime.maxAgeMs)
            return '';
        const signature = value.slice(splitAt + 1);
        return this.verifyCookieSignature(`proxy:${user}:${issuedAt}`,signature) ? user : '';
    }

    setProxyAuthCookie(req, res, user = '') {
        const nextCookie = `${proxyAuthCookieName}=${encodeURIComponent(this.proxyAuthCookieValue(user))}; ${this.cookieOptions(req)}`;
        const current = res.getHeader('Set-Cookie');
        if (!current) {
            res.setHeader('Set-Cookie', nextCookie);
        } else if (Array.isArray(current)) {
            res.setHeader('Set-Cookie', current.concat(nextCookie));
        } else {
            res.setHeader('Set-Cookie', [current, nextCookie]);
        }
    }

    hasLocalProxyAuthCookie(req) {
        const cookies = this.parseCookies(req.headers.cookie || '');
        return !!this.unpackProxyAuthCookie(cookies[proxyAuthCookieName] || '');
    }

    bearerToken(req) {
        const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        return match ? match[1].trim() : '';
    }

    metricsRequestToken(req) {
        return this.bearerToken(req) || String((req.query && req.query.token) || '').trim();
    }

    hasValidMetricsToken(req) {
        const expected = String(this.config.metricsToken || '').trim();
        const supplied = this.metricsRequestToken(req);
        return !!(expected && supplied && timingSafeStringEqual(supplied, expected));
    }

    isMetricsAuthExempt(req) {
        return !!(
            this.config.metricsEnabled
            && this.isMetricsPath(req)
            && (this.config.metricsExemptAuth === true || this.hasValidMetricsToken(req))
        );
    }

    verifyRequiredAuth(req) {
        // A dedicated read-only service token/signed cover grants access only
        // to ABS routes, never the web catalog, OPDS or book downloads.
        if (require('./AudiobookshelfProvider').isAuthorizedRequest(req, this.config))
            return {ok: true};
        const mode = String(this.config.authMode || 'local').trim().toLowerCase();
        if (!this.config.requireAuth && !(mode === 'proxy' && this.config.proxyBindProfile))
            return {ok: true};

        if (this.config.authExemptHealth !== false && this.isHealthPath(req))
            return {ok: true};

        if (this.isMetricsAuthExempt(req))
            return {ok: true};

        if (mode === 'none')
            return {ok: true};

        if (mode === 'proxy') {
            const user = this.getProxyAuthUser(req);
            if (user)
                return {ok: true, user};

            return this.isTrustedProxy(req)
                ? {ok: false, status: 401, message: 'Proxy authentication required'}
                : {ok: false, status: 403, message: 'Direct access is forbidden'};
        }

        return {ok: true};
    }

    isSameOrigin(req) {
        return this.sameOriginCheck(req).ok;
    }

    normalizeOrigin(value = '') {
        try {
            return new URL(String(value || '').trim()).origin;
        } catch (e) {
            return '';
        }
    }

    sameOriginCheck(req) {
        const origin = String(req.headers.origin || '').trim();
        if (!origin)
            return {ok: true, origin: '', expectedOrigins: []};

        const normalizedOrigin = this.normalizeOrigin(origin);
        if (!normalizedOrigin)
            return {ok: false, origin, expectedOrigins: []};

        const host = this.requestHost(req), proto = this.requestProto(req);
        const direct = this.normalizeOrigin(`${proto}://${host}`);
        const forwardedProto = this.forwardedProto(req) || proto;
        const forwarded = this.isTrustedProxy(req) && /^https?$/i.test(forwardedProto)
            ? this.normalizeOrigin(`${forwardedProto}://${this.forwardedHost(req) || host}`) : '';
        const expectedOrigins = [...new Set([direct, forwarded].filter(Boolean))];

        return {
            ok: expectedOrigins.includes(normalizedOrigin),
            origin: normalizedOrigin,
            expectedOrigins,
        };
    }

    verifyWebSocket(req) {
        if (acceptAccess(req,'websocket')) {
            this.ensureSession(req);
            return true;
        }
        const auth = this.verifyRequiredAuth(req);
        if (!auth.ok) {
            logSecurityWarning(`WebSocket forbidden: auth failed, status=${auth.status || 401}, remote=${this.clientIp(req) || '-'}`);
            return false;
        }

        const sameOrigin = this.sameOriginCheck(req);
        if (!sameOrigin.ok) {
            logSecurityWarning(
                `WebSocket forbidden: origin mismatch, origin=${sameOrigin.origin || '-'}, expected=${sameOrigin.expectedOrigins.join(',') || '-'}, host=${this.requestHost(req) || '-'}, x-forwarded-host=${this.headerFirstValue(req, 'x-forwarded-host') || '-'}, x-forwarded-proto=${this.headerFirstValue(req, 'x-forwarded-proto') || '-'}, remote=${this.clientIp(req) || '-'}`
            );
            return false;
        }

        this.ensureSession(req);
        return true;
    }

    logNativeWebSocketRejection(reason,peer) {
        const detail = reason==='foreign-origin' ? 'origin mismatch'
            : `auth failed, status=${reason==='missing-proxy-user' ? 401 : 403}`;
        logSecurityWarning(`WebSocket forbidden: ${detail}, peer=${peer}`);
    }

    getCsrfToken(req) {
        const session = this.ensureSession(req);
        return session.csrfToken;
    }

    hasValidCsrf(req, token = '') {
        const session = this.ensureSession(req);
        const supplied = String(token || '').trim();
        if (!supplied || supplied.length !== session.csrfToken.length)
            return false;

        if (this.nativeAuth) return this.sessions.verifyCsrf(session.id,supplied);
        return timingSafeStringEqual(supplied, session.csrfToken);
    }

    clientIp(req) {
        // Proxies append the address they saw ($proxy_add_x_forwarded_for), so the first entries
        // are whatever the client sent. Take the rightmost one that is not a trusted proxy.
        const chain = (this.isTrustedProxy(req) ? String(req.headers['x-forwarded-for'] || '') : '')
            .split(',').map(item => item.trim()).filter(Boolean);
        while (chain.length > 1 && this.isTrustedProxyAddress(chain[chain.length - 1]))
            chain.pop();
        return chain.pop() || (req.socket && req.socket.remoteAddress) || '';
    }

    normalizeLoginKind(kind = 'access') {
        const normalized = String(kind || 'access').trim().toLowerCase();
        return ['profile', 'opds'].includes(normalized) ? normalized : 'access';
    }

    loginAttemptKey(req, kind) {
        // One counter per kind: a success of one kind must not clear the failures of another.
        return `${this.normalizeLoginKind(kind)}:${this.clientIp(req) || 'unknown'}`;
    }

    incrementLoginMetric(kind = 'access', result = 'failure') {
        const key = `${this.normalizeLoginKind(kind)}\t${String(result || 'failure').toLowerCase()}`;
        this.loginAttemptTotals.set(key, (this.loginAttemptTotals.get(key) || 0) + 1);
    }

    pruneLoginAttempts(now = Date.now()) {
        if (now - this.lastLoginAttemptSweep < 60000 && this.loginAttempts.size < 10000)
            return;
        for (const [key, rec] of this.loginAttempts) {
            if (now > rec.resetAt)
                this.loginAttempts.delete(key);
        }
        this.lastLoginAttemptSweep = now;
    }

    checkLoginRate(req, kind = 'access') {
        if (this.config.loginRateLimitEnabled === false)
            return;

        if (this.nativeAuth) {
            const retry = this.nativeAuth.check(this.normalizeLoginKind(kind),this.clientIp(req) || 'unknown',this.config);
            if (retry) throw loginLimitError(retry);
            return;
        }

        const ip = this.loginAttemptKey(req, kind);
        const now = Date.now();
        this.pruneLoginAttempts(now);
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const maxAttempts = Math.max(1, Number(this.config.loginRateLimitMaxAttempts || defaultLoginMaxAttempts));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};

        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }

        const exhausted = rec.count >= maxAttempts || (!this.loginAttempts.has(ip) && this.loginAttempts.size >= 10000);
        if (exhausted || rec.count + (this.activeLoginAttempts.get(ip) || 0) >= maxAttempts
            || (!this.activeLoginAttempts.has(ip) && this.activeLoginAttempts.size >= 10000)) {
            this.incrementLoginMetric(kind, 'blocked');
            throw loginLimitError(exhausted ? Math.max(1, Math.ceil((rec.resetAt - now)/1000)) : 1);
        }
    }

    async withLoginAttempt(req, kind, verify, isSuccess = Boolean) {
        if (this.nativeAuth) {
            const type = this.normalizeLoginKind(kind);
            const ip = this.clientIp(req) || 'unknown';
            const limited = this.config.loginRateLimitEnabled !== false;
            const retry = this.nativeAuth.check(type,ip,this.config,limited);
            if (retry) throw loginLimitError(retry);
            let success;
            try {
                const result = await verify();
                success = isSuccess(result);
                return result;
            } catch (error) {
                if (error.code === 'INPX_INVALID_PROFILE_CREDENTIALS') success = false;
                throw error;
            } finally {
                this.nativeAuth.finish(type,ip,this.config,limited,success);
            }
        }

        const key = this.loginAttemptKey(req, kind);
        this.checkLoginRate(req, kind);
        const limited = this.config.loginRateLimitEnabled !== false;
        if (limited) this.activeLoginAttempts.set(key, (this.activeLoginAttempts.get(key) || 0) + 1);
        try {
            const result = await verify();
            const success = isSuccess(result);
            if (success !== undefined) this.recordLoginAttempt(req, success, kind);
            return result;
        } catch (error) {
            if (error.code === 'INPX_INVALID_PROFILE_CREDENTIALS') this.recordLoginAttempt(req, false, kind);
            throw error;
        } finally {
            if (limited) {
                const active = this.activeLoginAttempts.get(key) - 1;
                if (active) this.activeLoginAttempts.set(key, active);
                else this.activeLoginAttempts.delete(key);
            }
        }
    }

    recordLoginAttempt(req, success = false, kind = 'access') {
        if (this.nativeAuth) {
            this.nativeAuth.finish(this.normalizeLoginKind(kind),this.clientIp(req) || 'unknown',this.config,false,success);
            return;
        }

        const ip = this.loginAttemptKey(req, kind);
        this.incrementLoginMetric(kind, success ? 'success' : 'failure');
        if (this.config.loginRateLimitEnabled === false)
            return;

        if (success) {
            // Only the shared access password is one secret. Logging in to a known profile must
            // not erase failures against other profiles (the admin's among them).
            if (this.normalizeLoginKind(kind) === 'access')
                this.loginAttempts.delete(ip);
            return;
        }

        const now = Date.now();
        this.pruneLoginAttempts(now);
        if (!this.loginAttempts.has(ip) && this.loginAttempts.size >= 10000)
            return;
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};
        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }
        rec.count++;
        this.loginAttempts.set(ip, rec);
    }

    getLoginMetrics() {
        if (this.nativeAuth) return this.nativeAuth.metrics(this.config);

        const now = Date.now();
        let activeFailedAttempts = 0;
        let rateLimitedIps = 0;
        const maxAttempts = Math.max(1, Number(this.config.loginRateLimitMaxAttempts || defaultLoginMaxAttempts));

        for (const [ip, rec] of this.loginAttempts.entries()) {
            if (!rec || now > rec.resetAt) {
                this.loginAttempts.delete(ip);
                continue;
            }

            activeFailedAttempts += rec.count || 0;
            if ((rec.count || 0) >= maxAttempts)
                rateLimitedIps++;
        }

        const attempts = [];
        for (const kind of ['access', 'profile', 'opds']) {
            for (const result of ['success', 'failure', 'blocked']) {
                attempts.push({
                    labels: {kind, result},
                    value: this.loginAttemptTotals.get(`${kind}\t${result}`) || 0,
                });
            }
        }

        return {
            enabled: this.config.loginRateLimitEnabled !== false,
            attempts,
            activeFailedAttempts,
            rateLimitedIps,
        };
    }
}

module.exports = Security;
