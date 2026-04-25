const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const sessionCookieName = 'inpx_web_session';
const secretFileName = 'session-secret';
const defaultLoginWindowMs = 15*60*1000;
const defaultLoginMaxAttempts = 8;

class Security {
    constructor(config) {
        this.config = config;
        this.sessions = new Map();
        this.loginAttempts = new Map();
        this.secret = '';
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
        const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
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

    isSameOrigin(req) {
        const origin = String(req.headers.origin || '').trim();
        if (!origin)
            return true;

        try {
            const originUrl = new URL(origin);
            const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
                || (req.socket && req.socket.encrypted ? 'https' : 'http');
            return originUrl.host === host && originUrl.protocol === `${proto}:`;
        } catch (e) {
            return false;
        }
    }

    verifyWebSocket(req) {
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
        return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
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
