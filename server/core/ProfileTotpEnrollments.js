const {attemptLimit} = require('./ProfileTotpAttempts');

const lifetime = 5*60*1000;
const maxPending = 128;

class ProfileTotpEnrollments {
    constructor(sessions, required, transport) {
        this.sessions = sessions;
        this.required = required;
        this.transport = transport;
        this.native = sessions.native;
        if (!this.native && !transport) this.pending = new Map();
    }

    request(operation, params) {
        return this.transport.profileRequest('enrollment',{required:this.required,request:{operation,...params}});
    }

    prepare(key, now) {
        if (this.transport) return this.request('prepare',{key});
        if (this.native) {
            this.native.input(key);
            return this.native.api.enrollment_prepare(this.required,now) !== 0;
        }
        for (const [token,row] of this.pending) {
            if (row.expiresAt <= now || (this.required ? row.user === key : !this.sessions.has(token)))
                this.pending.delete(token);
        }
        return this.pending.size < maxPending || (!this.required && this.pending.has(key));
    }

    create(key, user, secret, now) {
        if (this.transport) return this.request('create',{key,user,secret});
        if (this.native) {
            const length = this.native.input(key,user+secret);
            if (!this.native.api.enrollment_create(this.required,length,Buffer.byteLength(user),now))
                throw new Error('Повторите настройку позже');
            return;
        }
        this.pending.set(key,{user,secret,expiresAt:now+lifetime,attempts:0});
    }

    secret(key, user, now) {
        if (this.transport) return this.request('secret',{key,user});
        if (this.native) {
            const length = this.native.input(key,user);
            return this.native.output(this.native.api.enrollment_secret(this.required,length,now));
        }
        const row = this.pending.get(key);
        if (row?.user !== user) return;
        if (row.expiresAt <= now || row.attempts >= attemptLimit) this.pending.delete(key);
        else return row.secret;
    }

    failed(key, user) {
        if (this.transport) return this.request('failed',{key,user});
        if (this.native) {
            const length = this.native.input(key,user);
            return this.native.api.enrollment_failed(this.required,length);
        }
        const row = this.pending.get(key);
        if (row?.user === user) row.attempts++;
    }

    delete(key) {
        if (this.transport) return this.request('remove',{key});
        if (this.native) {
            if (typeof key !== 'string' || key.length > 48) return;
            this.native.input(key);
            return this.native.api.enrollment_delete(this.required);
        }
        this.pending.delete(key);
    }

    has(key) {
        if (this.native) {
            this.native.input(key);
            return this.native.api.enrollment_has(this.required) !== 0;
        }
        return this.pending.has(key);
    }

    revoke(user, keep = '') {
        if (this.transport) return this.request('revoke',{user});
        if (this.native) {
            const length = this.native.input(user,keep);
            return this.native.api.enrollment_revoke(this.required,length);
        }
        for (const [key,row] of this.pending) {
            if (row.user === user && key !== keep) this.pending.delete(key);
        }
    }

    clear(keep = '') {
        if (this.transport) return this.request('clear');
        if (this.native) {
            this.native.input(keep);
            return this.native.api.enrollment_clear(this.required);
        }
        const row = this.pending.get(keep);
        this.pending.clear();
        if (row) this.pending.set(keep,row);
    }
}

module.exports = ProfileTotpEnrollments;
