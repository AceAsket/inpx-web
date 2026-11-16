const browserIdLength = 48;
const signatureLength = 64;
const fields = {profileToken:0,proxyUser:1,proxyLogin:2,ebookToken:3};

class BrowserSession {
    #store;

    constructor(store, id, csrfToken) {
        this.#store = store;
        this.id = id;
        this.csrfToken = csrfToken;
    }

    get profileAccessToken() {return this.#store.field(this.id,fields.profileToken);}
    set profileAccessToken(value) {this.#store.setField(this.id,fields.profileToken,value);}
    get proxyProfileUserId() {return this.#store.field(this.id,fields.proxyUser);}
    set proxyProfileUserId(value) {this.#store.setField(this.id,fields.proxyUser,value);}
    get proxyProfileLogin() {return this.#store.field(this.id,fields.proxyLogin);}
    set proxyProfileLogin(value) {this.#store.setField(this.id,fields.proxyLogin,value);}
    get ebookAccessToken() {return this.#store.field(this.id,fields.ebookToken);}
    set ebookAccessToken(value) {this.#store.setField(this.id,fields.ebookToken,value);}
}

class RustBrowserSessions {
    constructor(auth) {
        this.auth = auth;
        this.api = auth.api;
    }

    setKey(value) {
        this.auth.input(value);
        this.api.browser_key();
    }

    sign(value) {
        this.auth.input(value);
        return this.auth.output(this.api.browser_sign());
    }

    verifySignature(value, signature) {
        if (signature.length !== signatureLength) return false;
        const length = this.auth.input(value,signature);
        return this.api.browser_signature_valid(length) !== 0;
    }

    create(id, csrf, now) {
        const length = this.auth.input(id,csrf);
        this.api.browser_create(length,now);
        return new BrowserSession(this,id,csrf);
    }

    load(id, now, existing = null, signature = '') {
        if (typeof id !== 'string' || id.length !== browserIdLength) return null;
        const length = this.auth.input(id,signature);
        const ptr = this.api.browser_load(length,Boolean(signature),now);
        if (!ptr) return null;
        return existing || new BrowserSession(this,id,this.auth.output(ptr));
    }

    fromCookie(raw, now, existing = null) {
        if (raw.charCodeAt(browserIdLength) !== 46) return null;
        const end = raw.indexOf('.',browserIdLength+1);
        const signature = raw.slice(browserIdLength+1,end < 0 ? undefined : end);
        if (signature.length !== signatureLength) return null;
        const id = raw.slice(0,browserIdLength);
        if (existing && existing.id !== id) return null;
        return this.load(id,now,existing,signature);
    }

    verifyCsrf(id, supplied) {
        const length = this.auth.input(id,supplied);
        return this.api.browser_csrf(length) !== 0;
    }

    field(id, index) {
        this.auth.input(id);
        return this.auth.output(this.api.browser_field(index));
    }

    setField(id, index, value) {
        const present = typeof value === 'string';
        const length = this.auth.input(id,present ? value : '');
        this.api.browser_put(length,index,present);
    }

    get size() {
        return this.api.browser_count();
    }
}

module.exports = RustBrowserSessions;
