const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

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

class Security {
    constructor(config) {
        this.config = config;
        this.sessions = new Map();
        this.loginAttempts = new Map();
        this.secret = '';
        this.trustedProxyRanges = (config.trustedProxyCidrs || [])
            .map(parseCidr)
            .filter(Boolean);
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
        return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
    }

    randomToken(bytes = 32) {
        return crypto.randomBytes(bytes).toString('hex');
    }

    cookieOptions(req) {
        const root = this.config.rootPathStatic || '/';
        const secure = req.secure || this.forwardedProto(req) === 'https';
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
            if (key)
                result[key] = decodeURIComponent(value);
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

        const expected = this.sign(sessionId);
        if (
            signature.length !== expected.length
            || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        ) {
            return '';
        }

        return sessionId;
    }

    ensureSession(req, res = null) {
        if (req.securitySession)
            return req.securitySession;

        const cookies = this.parseCookies(req.headers.cookie || '');
        let sessionId = this.unpackSessionId(cookies[sessionCookieName] || '');
        let session = sessionId ? this.sessions.get(sessionId) : null;

        if (!session) {
            sessionId = this.randomToken(24);
            session = {
                id: sessionId,
                csrfToken: this.randomToken(32),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.sessions.set(sessionId, session);
        } else {
            session.updatedAt = Date.now();
        }

        req.securitySession = session;

        if (res) {
            res.setHeader(
                'Set-Cookie',
                `${sessionCookieName}=${encodeURIComponent(this.packSessionId(sessionId))}; ${this.cookieOptions(req)}`
            );
        }

        return session;
    }

    middleware() {
        return (req, res, next) => {
            this.ensureSession(req, res);
            next();
        };
    }

    requiredAuthMiddleware() {
        return (req, res, next) => {
            const result = this.verifyRequiredAuth(req);
            if (result.ok) {
                if (result.user)
                    this.setProxyAuthCookie(req, res, result.user);
                next();
                return;
            }

            res.status(result.status || 401).send(result.message || 'Authentication required');
        };
    }

    isHealthPath(req) {
        const pathname = String((req && req.path) || '').replace(/\/+$/, '') || '/';
        return ['/health', '/ready', '/api/index-status'].includes(pathname);
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

        return String(req.headers[String(name || '').toLowerCase()] || '').split(',')[0].trim();
    }

    forwardedProto(req) {
        return this.forwardedHeader(req, 'x-forwarded-proto');
    }

    forwardedHost(req) {
        return this.forwardedHeader(req, 'x-forwarded-host');
    }

    getProxyAuthUser(req) {
        if (!this.isTrustedProxy(req))
            return '';

        const headerName = String(this.config.proxyAuthHeader || 'Remote-User').trim().toLowerCase();
        return String(req.headers[headerName] || '').trim();
    }

    proxyAuthCookieValue(user = '') {
        const normalized = String(user || '').trim();
        return `${normalized}.${this.sign(`proxy:${normalized}`)}`;
    }

    unpackProxyAuthCookie(raw = '') {
        const value = String(raw || '');
        const splitAt = value.lastIndexOf('.');
        if (splitAt <= 0)
            return '';

        const user = value.slice(0, splitAt);
        const signature = value.slice(splitAt + 1);
        const expected = this.sign(`proxy:${user}`);
        return timingSafeStringEqual(signature, expected) ? user : '';
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

    verifyRequiredAuth(req) {
        if (!this.config.requireAuth)
            return {ok: true};

        if (this.config.authExemptHealth !== false && this.isHealthPath(req))
            return {ok: true};

        const mode = String(this.config.authMode || 'local').trim().toLowerCase();
        if (mode === 'none')
            return {ok: true};

        if (mode === 'proxy') {
            const user = this.getProxyAuthUser(req);
            if (user)
                return {ok: true, user};

            if (this.isTrustedProxy(req) && this.hasLocalProxyAuthCookie(req))
                return {ok: true};

            return this.isTrustedProxy(req)
                ? {ok: false, status: 401, message: 'Proxy authentication required'}
                : {ok: false, status: 403, message: 'Direct access is forbidden'};
        }

        return {ok: true};
    }

    isSameOrigin(req) {
        const origin = String(req.headers.origin || '').trim();
        if (!origin)
            return true;

        try {
            const originUrl = new URL(origin);
            const host = this.forwardedHost(req) || String(req.headers.host || '').split(',')[0].trim();
            const proto = this.forwardedProto(req)
                || (req.socket && req.socket.encrypted ? 'https' : 'http');
            return originUrl.host === host && originUrl.protocol === `${proto}:`;
        } catch (e) {
            return false;
        }
    }

    verifyWebSocket(req) {
        if (!this.verifyRequiredAuth(req).ok)
            return false;

        if (!this.isSameOrigin(req))
            return false;

        this.ensureSession(req);
        return true;
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

        return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken));
    }

    clientIp(req) {
        return this.forwardedHeader(req, 'x-forwarded-for')
            || (req.socket && req.socket.remoteAddress)
            || '';
    }

    checkLoginRate(req) {
        const ip = this.clientIp(req) || 'unknown';
        const now = Date.now();
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const maxAttempts = Math.max(1, Number(this.config.loginRateLimitMaxAttempts || defaultLoginMaxAttempts));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};

        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }

        if (rec.count >= maxAttempts)
            throw new Error('Too many login attempts. Try again later.');
    }

    recordLoginAttempt(req, success = false) {
        const ip = this.clientIp(req) || 'unknown';
        if (success) {
            this.loginAttempts.delete(ip);
            return;
        }

        const now = Date.now();
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};
        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }
        rec.count++;
        this.loginAttempts.set(ip, rec);
    }
}

module.exports = Security;
