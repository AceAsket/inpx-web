const attemptLimit = 8;
const windowMs = 5*60*1000;
const maxProfiles = 4096;

class ProfileTotpAttempts {
    constructor(native, transport) {
        this.native = native;
        if (transport) this.request = (operation,params)=>transport.profileRequest('totpAttempt',{request:{operation,...params}});
        else if (!native) this.failures = new Map();
    }

    allows(user, now) {
        if (this.request) return this.request('allows',{user,now});
        if (this.native) {
            this.native.input(user);
            return this.native.api.totp_allows(now) !== 0;
        }
        const row = this.failures.get(user);
        if (row?.expiresAt > now) return row.count < attemptLimit;
        if (this.failures.size >= maxProfiles) {
            for (const [id, entry] of this.failures)
                if (entry.expiresAt <= now) this.failures.delete(id);
        }
        return this.failures.size < maxProfiles;
    }

    failed(user, now) {
        if (this.request) return this.request('failed',{user,now});
        if (this.native) {
            this.native.input(user);
            return this.native.api.totp_failed(now);
        }
        const row = this.failures.get(user);
        if (row?.expiresAt > now) row.count++;
        else this.failures.set(user,{count:1,expiresAt:now+windowMs});
    }

    delete(user) {
        if (this.request) return this.request('reset',{user});
        if (!this.native) return this.failures.delete(user);
        this.native.input(user);
        this.native.api.totp_reset();
    }

    clear() {
        if (this.request) return this.request('clear');
        if (this.native) return this.native.api.totp_clear();
        this.failures.clear();
    }
}

module.exports = {ProfileTotpAttempts, attemptLimit};
