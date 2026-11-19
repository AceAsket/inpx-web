const fs = require('node:fs');
const path = require('node:path');
const {randomFillSync} = require('node:crypto');

const fileName = 'inpx_auth_state.wasm';
const kinds = ['access','profile','opds'];
const results = ['success','failure','blocked'];
const metricLabels = kinds.flatMap(kind=>results.map(result=>Object.freeze({kind,result})));
const modules = new Map();
const entropyPool = Buffer.alloc(1024);
let entropyOffset = entropyPool.length;

function open() {
    const configured = process.env.INPX_RUST_AUTH_WASM;
    if (!configured && !process.pkg) return null;
    const file = configured ? path.resolve(configured) : path.join(path.dirname(process.execPath),'bin',fileName);
    if (!modules.has(file))
        modules.set(file,new WebAssembly.Module(fs.readFileSync(file)));
    let auth;
    const imports = {inpx:{random_fill(offset,length) {
        try {
            const memory = auth.memory();
            if (length > entropyPool.length) {
                randomFillSync(memory,offset,length);
            } else {
                if (entropyOffset+length > entropyPool.length) {
                    randomFillSync(entropyPool);
                    entropyOffset = 0;
                }
                const end = entropyOffset+length;
                entropyPool.copy(memory,offset,entropyOffset,end);
                entropyPool.fill(0,entropyOffset,end);
                entropyOffset = end;
            }
            return 1;
        } catch {
            return 0;
        }
    }}};
    auth = new RustAuthState(new WebAssembly.Instance(modules.get(file),imports).exports);
    return auth;
}

class RustAuthState {
    constructor(api) {
        this.api = api;
    }

    memory() {
        const bytes = this.api.memory.buffer;
        if (this.view?.buffer !== bytes) this.view = Buffer.from(bytes);
        return this.view;
    }

    input(value, trailing = '') {
        const first = Buffer.byteLength(value);
        const size = trailing ? first + Buffer.byteLength(trailing) : first;
        const offset = this.api.auth_input(size);
        const buffer = this.memory();
        buffer.write(value,offset,first,'utf8');
        if (trailing) buffer.write(trailing,offset+first,size-first,'utf8');
        return first;
    }

    output(ptr) {
        return ptr ? this.memory().toString('utf8',ptr,ptr+this.api.auth_output_len()) : undefined;
    }

    static policy(config) {
        const maxAttempts = Math.min(0xffffffff,Math.max(1,Math.ceil(config.loginRateLimitMaxAttempts || 8)));
        const window = Math.max(60_000,Number(config.loginRateLimitWindowMs || 15*60_000));
        return {enabled:config.loginRateLimitEnabled !== false,maxAttempts,window};
    }

    check(kind, ip, config, reserve = false) {
        this.input(ip);
        const {enabled,window,maxAttempts} = RustAuthState.policy(config);
        return this.api.login_check(kinds.indexOf(kind),Date.now(),enabled,window,maxAttempts,reserve) >>> 0;
    }

    finish(kind, ip, config, reserved, success) {
        this.input(ip);
        const {enabled,window,maxAttempts} = RustAuthState.policy(config);
        const outcome = success === undefined ? -1 : Number(Boolean(success));
        this.api.login_finish(kinds.indexOf(kind),Date.now(),enabled,window,maxAttempts,reserved,outcome);
    }

    metrics(config) {
        const {enabled,maxAttempts} = RustAuthState.policy(config);
        const ptr = this.api.login_metrics(Date.now(),maxAttempts);
        const samples = new Float64Array(this.api.memory.buffer,ptr,metricLabels.length+2);
        return {
            enabled,
            attempts:metricLabels.map((labels,index)=>({labels,value:samples[index]})),
            activeFailedAttempts:samples[metricLabels.length],
            rateLimitedIps:samples[metricLabels.length+1],
        };
    }

    createProfileSession(token, user, now) {
        const tokenLength = this.input(token,user);
        this.api.profile_create(tokenLength,now);
    }

    sessionUser(token, now) {
        this.input(token);
        return this.output(this.api.profile_user(now)) || '';
    }

    hasProfileSession(token) {
        this.input(token);
        return this.api.profile_has() !== 0;
    }

    deleteProfileSession(token) {
        this.input(token);
        this.api.profile_delete();
    }

    revokeProfileSessions(user, keep) {
        const userLength = this.input(user,keep);
        this.api.profile_revoke(userLength);
    }

    clearProfileSessions(keep) {
        this.input(keep);
        this.api.profile_clear();
    }

    get profileSessionCount() {
        return this.api.profile_count();
    }
}

module.exports = {open,fileName};
