const {open} = require('./RustAuthState');
const lifetime = require('./SessionLifetime');

class ProfileSessions {
    static admission = Symbol('profile session admission');

    constructor() {
        this.native = open();
        if (!this.native) this.sessions = new Map();
    }

    create(token, user, now = Date.now()) {
        if (this.native) return this.native.createProfileSession(token,user,now);
        lifetime.makeRoom(this.sessions,now);
        this.sessions.set(token,{user,createdAt:now,updatedAt:now});
    }

    user(token, now = Date.now()) {
        if (!token) return '';
        if (this.native) return this.native.sessionUser(token,now);
        const session = this.sessions.get(token);
        if (lifetime.expired(session,now)) {
            this.sessions.delete(token);
            return '';
        }
        session.updatedAt = now;
        return session.user || '';
    }

    has(token) {
        return this.native ? this.native.hasProfileSession(token) : this.sessions.has(token);
    }

    delete(token) {
        if (this.native) return this.native.deleteProfileSession(token);
        this.sessions.delete(token);
    }

    revoke(user, keep = '') {
        if (this.native) return this.native.revokeProfileSessions(user,keep);
        for (const [token,session] of this.sessions) {
            if (session.user===user && token!==keep) this.sessions.delete(token);
        }
    }

    clear(keep = '') {
        if (this.native) return this.native.clearProfileSessions(keep);
        const session = this.sessions.get(keep);
        this.sessions.clear();
        if (session) this.sessions.set(keep,session);
    }

    get size() {
        return this.native ? this.native.profileSessionCount : this.sessions.size;
    }
}

module.exports = ProfileSessions;
