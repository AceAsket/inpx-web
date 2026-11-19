const tokenBytes = 64;
const loadBytes = tokenBytes+16;
const refreshBytes = tokenBytes+24;
const removalBytes = tokenBytes+8;
const restoreBatch = 2048;
const tokenPattern = /^[0-9a-f]{64}$/;

class RustWebAccessSessions {
    constructor(auth, timeout, write) {
        this.auth = auth;
        this.api = auth.api;
        this.write = write;
        this.grants = new Map();
        this.api.access_configure(timeout);
    }

    restore(rows) {
        for (let cursor=0;cursor<rows.length;cursor+=restoreBatch) {
            const end = Math.min(cursor+restoreBatch,rows.length);
            let offset = this.api.auth_input((end-cursor)*loadBytes);
            const memory = this.auth.memory();
            for (let index=cursor;index<end;index++) {
                const [token,{time,used}] = rows[index];
                if (!tokenPattern.test(token)) throw new Error('Некорректный токен в хранилище сеансов доступа');
                memory.write(token,offset,tokenBytes,'ascii');
                memory.writeDoubleLE(time,offset+tokenBytes);
                memory.writeDoubleLE(used,offset+tokenBytes+8);
                offset += loadBytes;
            }
            if (!this.api.access_restore()) throw new Error('Rust не принял сеансы из хранилища');
        }
    }

    restorePacked(block) {
        const offset = this.api.auth_input(block.length);
        this.auth.memory().set(block,offset);
        if (!this.api.access_restore()) throw new Error('Rust не принял сеансы из хранилища');
    }

    use(token, now) {
        if (typeof token !== 'string' || token.length !== tokenBytes) return false;
        const offset = this.api.auth_input(tokenBytes);
        if (this.auth.memory().write(token,offset,tokenBytes,'utf8') !== tokenBytes) return false;
        const version = this.api.access_use(now);
        if (version <= 1) return version === 1;
        return this.saveGrant(token,version);
    }

    saveGrant(token,version) {
        this.auth.input(token);
        let saved = this.grants.get(version);
        if (!saved) {
            const ptr = this.api.access_grant(version);
            const memory = this.auth.memory();
            const value = {time:memory.readDoubleLE(ptr),used:memory.readDoubleLE(ptr+8)};
            saved = this.write([[token,value]],[],success=>{
                if (!success) return;
                this.auth.input(token);
                this.api.access_finish_grant(version,value.used);
            }).finally(()=>{this.grants.delete(version);});
            this.grants.set(version,saved);
        }
        return {saved,current:()=>{
            this.auth.input(token);
            return this.api.access_grant(version) !== 0;
        }};
    }

    revoke(token) {
        if (typeof token !== 'string' || token.length !== tokenBytes) return;
        this.auth.input(token);
        const version = this.api.access_revoke();
        if (!version) return;
        return this.write([],[token],success=>{
            if (success) this.finishRevocation(token,version);
        });
    }

    finishRevocation(token,version) {
        this.auth.input(token);
        this.api.access_finish_revocation(version);
    }

    flush(now) {
        const ptr = this.api.access_collect(now);
        if (!ptr) return;
        const memory = this.auth.memory();
        const count = memory.readUInt32LE(ptr);
        const deleted = memory.readUInt32LE(ptr+4);
        if (this.writePacked && this.api.access_complete_batch) {
            const batch = Buffer.from(memory.subarray(ptr,ptr+this.api.auth_output_len()));
            return this.writePacked(batch,success=>{
                if (!(success ? deleted : count)) return;
                const offset = this.api.auth_input(batch.length);
                this.auth.memory().set(batch,offset);
                this.api.access_complete_batch(success);
            });
        }
        const updates = new Array(count);
        const versions = new Array(count);
        const removals = new Array(deleted);
        const revocations = new Array(deleted);
        let offset = ptr+8;
        for (let i=0;i<count;i++) {
            const token = memory.toString('ascii',offset,offset+tokenBytes);
            const version = memory.readDoubleLE(offset+tokenBytes);
            const time = memory.readDoubleLE(offset+tokenBytes+8);
            const used = memory.readDoubleLE(offset+tokenBytes+16);
            updates[i] = [token,{time,used}];
            versions[i] = version;
            offset += refreshBytes;
        }
        for (let i=0;i<deleted;i++) {
            removals[i] = memory.toString('ascii',offset,offset+tokenBytes);
            revocations[i] = memory.readDoubleLE(offset+tokenBytes);
            offset += removalBytes;
        }
        return this.write(updates,removals,success=>{
            if (success) {
                for (let i=0;i<deleted;i++) this.finishRevocation(removals[i],revocations[i]);
            } else {
                for (let i=0;i<count;i++) {
                    this.auth.input(updates[i][0]);
                    this.api.access_retry(versions[i]);
                }
            }
        });
    }

    get size() {return this.api.access_count();}
}

module.exports = RustWebAccessSessions;
