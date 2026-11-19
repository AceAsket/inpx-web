const utils = require('./utils');
const {open} = require('./RustAuthState');

const lifetime = 5*60*1000;
const maxPending = 4096;
const maxPerClient = 16;

function challengeLimitError() {
    return Object.assign(new Error('Too many pending access challenges. Try again later.'), {
        code:'INPX_LOGIN_RATE_LIMIT',retryAfter:lifetime/1000,
    });
}

class WebAccessChallenges {
    constructor(native = open()) {
        this.native = native;
        if (!this.native) {
            this.pending = new Map();
            this.clients = new Map();
        }
    }

    configurePassword(password) {
        if (!this.native?.api.library_password_configure) return;
        if (this.fingerprint === undefined || this.password !== password) {
            this.native.input(password);
            this.fingerprint = this.native.output(this.native.api.library_password_configure());
            this.password = password;
        }
        return this.fingerprint;
    }

    issue(client, password, now, timeout) {
        if (this.native) {
            let ptr;
            if (this.fingerprint !== undefined) {
                this.configurePassword(password);
                this.native.input(client);
                ptr = this.native.api.library_challenge_issue(now,timeout);
            } else {
                const length = this.native.input(client,String(password));
                ptr = this.native.api.challenge_issue(length,now,timeout);
            }
            if (!ptr) throw challengeLimitError();
            if (ptr < 0) throw new Error('Не удалось получить случайные данные для токена доступа');
            return this.native.output(ptr);
        }
        this.prune(now);
        const count = this.clients.get(client) || 0;
        if (this.pending.size >= maxPending || count >= maxPerClient) throw challengeLimitError();
        const salt = utils.randomHexString(32);
        const digest = utils.getBufHash(password+salt,'sha256','hex');
        const expiresAt = now + (timeout > 0 ? Math.min(timeout,lifetime) : lifetime);
        this.pending.set(digest,{client,expiresAt});
        this.clients.set(client,count+1);
        return salt;
    }

    take(token, now) {
        if (this.native) {
            if (typeof token !== 'string' || token.length !== 64) return false;
            this.native.input(token);
            return this.native.api.challenge_take(now) !== 0;
        }
        const pending = this.pending.get(token);
        if (pending) this.remove(token);
        return !!pending && pending.expiresAt > now;
    }

    remove(token) {
        if (this.native) {
            if (typeof token !== 'string' || token.length !== 64) return;
            this.native.input(token);
            return this.native.api.challenge_remove();
        }
        const pending = this.pending.get(token);
        if (!pending) return;
        this.pending.delete(token);
        const count = this.clients.get(pending.client) - 1;
        if (count) this.clients.set(pending.client,count);
        else this.clients.delete(pending.client);
    }

    prune(now) {
        if (this.native) return this.native.api.challenge_prune(now);
        for (const [token,pending] of this.pending) {
            if (pending.expiresAt > now) break;
            this.remove(token);
        }
    }

    get size() {
        return this.native ? this.native.api.challenge_count() : this.pending.size;
    }
}

module.exports = {WebAccessChallenges,lifetime,challengeLimitError};
