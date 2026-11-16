const {join} = require('node:path');
const utils = require('../core/utils');
const log = new (require('../core/AppLogger'))().log;//singleton
const asyncExit = new (require('./AsyncExit'))();
const {openWebAccessStore,prepareNativeWebAccess} = require('./WebAccessStore');
const {WebAccessChallenges,challengeLimitError} = require('./WebAccessChallenges');
const {loginLimitError} = require('./Security');
const {equal} = require('./opds/Auth');
const LegacyWebAccessSessions = require('./LegacyWebAccessSessions');
const RustWebAccessSessions = require('./RustWebAccessSessions');

const cleanPeriod = 1*60*1000;//1 минута

class WebAccess {
    constructor(config, auth, native = false) {
        this.config = config;

        this.freeAccess = (config.accessPassword === '');
        this.accessTimeout = config.accessTimeout*60*1000;
        if (native) {
            this.nativeReady=Promise.withResolvers();
            this.nativeReady.promise.catch(()=>{});
        } else {
            this.pendingChallenges = new WebAccessChallenges(auth);
            this.pendingChallenges.configurePassword(String(config.accessPassword));
            const write = this.writeChanges.bind(this);
            this.sessions = this.pendingChallenges.native
                ? new RustWebAccessSessions(this.pendingChallenges.native,this.accessTimeout,write)
                : new LegacyWebAccessSessions(this.pendingChallenges,this.accessTimeout,write);
        }

        this.onExit = this.closeDb.bind(this);
        asyncExit.add(this.onExit);
    }

    async init() {
        const config = this.config;
        const directory = join(config.dataDir,'web-access');
        const fingerprint = this.pendingChallenges?.configurePassword(String(config.accessPassword))
            ?? utils.getBufHash(config.accessPassword,'sha256','hex');
        const lost=error=>{
            this.closed = true;
            log(LM_FATAL,error.message);
            asyncExit.exit(1);
        };
        if (this.nativeReady) {
            this.lease=await prepareNativeWebAccess(directory,fingerprint,config.dbCacheSize,lost);
            const timeoutMs = Number.isNaN(this.accessTimeout) ? -1 : this.accessTimeout===0 ? null
                : Math.min(Number.MAX_SAFE_INTEGER,Math.max(-Number.MAX_SAFE_INTEGER,Math.ceil(this.accessTimeout)));
            return {file:this.lease.file,password:String(config.accessPassword),timeoutMs};
        }
        const restorePacked = this.sessions.restorePacked?.bind(this.sessions);
        const {store,sessions} = await openWebAccessStore(directory,fingerprint,config.dbCacheSize,undefined,lost,restorePacked);
        try {
            this.sessions.restore(sessions);
        } catch (error) {
            await store.close();
            throw error;
        }
        this.store = store;
        if (restorePacked && store.applyPacked) this.sessions.writePacked = this.writePacked.bind(this);
        this.scheduleClean();
    }

    bindNative(transport) {
        this.nativeTransport=transport;
        this.nativeReady.resolve(transport);
    }

    async nativeRequest(request) {
        const transport=await this.nativeReady.promise;
        return transport.libraryRequest(request);
    }

    closeDb() {
        this.closed = true;
        clearTimeout(this.cleanTimer);
        asyncExit.remove(this.onExit);
        this.closing ||= (async()=>{
            if (this.nativeReady) {
                this.nativeReady.reject(new Error('Хранилище сеансов доступа недоступно'));
                try {await this.nativeTransport?.stop();}
                finally {await this.lease?.release();}
                return;
            }
            await this.writeQueue?.catch(()=>{});
            try {if (this.store && !this.freeAccess) await this.cleanAccess();}
            finally {
                await this.store?.close();
                this.store = null;
            }
        })();
        return this.closing;
    }

    scheduleClean() {
        if (this.closed || this.freeAccess) return;
        this.cleanTimer = setTimeout(async()=>{
            try {await this.cleanAccess();}
            catch (error) {log(LM_ERR,`WebAccess.periodicClean error: ${error.message}`);}
            finally {this.scheduleClean();}
        },cleanPeriod);
        this.cleanTimer.unref();
    }

    async cleanAccess(now = Date.now()) {
        if (this.nativeReady) {
            await this.nativeRequest({op:'flush'});
            return;
        }
        await this.sessions.flush(now);
    }

    writeChanges(updates,removals,complete) {
        if (!updates.length && !removals.length) return Promise.resolve();
        return this.enqueueChanges(()=>this.store.apply(updates,removals),complete);
    }

    writePacked(batch,complete) {
        return this.enqueueChanges(()=>this.store.applyPacked(batch),complete);
    }

    enqueueChanges(write,complete) {
        const writing = (this.writeQueue || Promise.resolve()).catch(()=>{})
            .then(write)
            .then(()=>complete(true),error=>{
                complete(false);
                throw error;
            });
        this.writeQueue = writing;
        return writing;
    }

    async hasAccess(accessToken) {
        if (this.freeAccess)
            return true;
        if (this.closed) return false;
        if (this.nativeReady) {
            if (typeof accessToken !== 'string' || accessToken.length!==64) return false;
            return (await this.nativeRequest({op:'check',token:accessToken})).state==='allowed';
        }

        const result = this.sessions.use(accessToken,Date.now());
        if (typeof result === 'boolean') return result;
        await result.saved;
        return !this.closed && result.current();
    }

    async deleteAccess(accessToken) {
        if (this.closed) return;
        if (this.nativeReady) {
            if (typeof accessToken === 'string' && accessToken.length===64)
                await this.nativeRequest({op:'revoke',token:accessToken});
            return;
        }
        await this.sessions.revoke(accessToken);
    }

    newToken(client = '') {
        if (this.nativeReady) return this.nativeRequest({op:'issue',client:String(client)}).then(reply=>{
            if (reply.state==='challenge') return reply.salt;
            if (reply.state==='challengeLimit') throw challengeLimitError();
            throw new Error('Не удалось получить случайные данные для токена доступа');
        });
        return this.pendingChallenges.issue(String(client),String(this.config.accessPassword),Date.now(),this.accessTimeout);
    }

    async loginPassword(password, req, security) {
        if (this.closed) return null;
        if (this.nativeReady) {
            const client=security.clientIp(req);
            const reply=await security.withLoginAttempt(req,'access',()=>this.nativeRequest({op:'login',client,password}),
                result=>result.state!=='denied');
            if (reply.state==='granted') return this.closed ? null : reply.token;
            if (reply.state==='denied') return null;
            if (reply.state==='challengeLimit') throw challengeLimitError();
            throw new Error('Не удалось создать токен доступа');
        }
        const auth = this.pendingChallenges.native;
        if (!this.freeAccess && auth && auth===security.nativeAuth && auth.api.library_password_login) {
            this.pendingChallenges.configurePassword(String(this.config.accessPassword));
            const client = auth.input(security.clientIp(req),password);
            const {enabled,window,maxAttempts} = auth.constructor.policy(security.config);
            const ptr = auth.api.library_password_login(client,Date.now(),enabled,window,maxAttempts);
            const memory = auth.memory();
            const outcome = memory.readUInt32LE(ptr);
            if (outcome===0) return null;
            if (outcome===2) throw loginLimitError(memory.readUInt32LE(ptr+4));
            if (outcome===4) throw challengeLimitError();
            if (outcome!==1) throw new Error('Не удалось создать токен доступа');
            const version = memory.readDoubleLE(ptr+8);
            const token = memory.toString('ascii',ptr+16,ptr+80);
            const grant = this.sessions.saveGrant(token,version);
            return this.completePasswordGrant(token,grant.saved.then(()=>!this.closed && grant.current()));
        }
        if (!await security.withLoginAttempt(req,'access',()=>equal(password,this.config.accessPassword))) return null;
        const token = utils.getBufHash(password+this.newToken(security.clientIp(req)),'sha256','hex');
        return this.completePasswordGrant(token,this.hasAccess(token));
    }

    async completePasswordGrant(token, allowed) {
        try {return await allowed ? token : null;}
        catch (error) {
            // A form token is still private. Revoke it rather than retaining a
            // retryable grant, even if the store acknowledged the write too late.
            await this.deleteAccess(token).catch(()=>{});
            throw error;
        }
    }
}

module.exports = WebAccess;
