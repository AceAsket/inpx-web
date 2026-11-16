const {join} = require('node:path');
const utils = require('../core/utils');
const log = new (require('../core/AppLogger'))().log;//singleton
const asyncExit = new (require('./AsyncExit'))();
const {openWebAccessStore} = require('./WebAccessStore');
const {WebAccessChallenges} = require('./WebAccessChallenges');
const LegacyWebAccessSessions = require('./LegacyWebAccessSessions');
const RustWebAccessSessions = require('./RustWebAccessSessions');

const cleanPeriod = 1*60*1000;//1 минута

class WebAccess {
    constructor(config) {
        this.config = config;

        this.freeAccess = (config.accessPassword === '');
        this.accessTimeout = config.accessTimeout*60*1000;
        this.pendingChallenges = new WebAccessChallenges();
        const write = this.writeChanges.bind(this);
        this.sessions = this.pendingChallenges.native
            ? new RustWebAccessSessions(this.pendingChallenges.native,this.accessTimeout,write)
            : new LegacyWebAccessSessions(this.pendingChallenges,this.accessTimeout,write);

        this.onExit = this.closeDb.bind(this);
        asyncExit.add(this.onExit);
    }

    async init() {
        const config = this.config;
        const fingerprint = utils.getBufHash(config.accessPassword,'sha256','hex');
        const {store,sessions} = await openWebAccessStore(join(config.dataDir,'web-access'),fingerprint,config.dbCacheSize,undefined,error=>{
            this.closed = true;
            log(LM_FATAL,error.message);
            asyncExit.exit(1);
        });
        try {
            this.sessions.restore(sessions);
        } catch (error) {
            await store.close();
            throw error;
        }
        this.store = store;
        this.scheduleClean();
    }

    closeDb() {
        this.closed = true;
        clearTimeout(this.cleanTimer);
        asyncExit.remove(this.onExit);
        this.closing ||= (async()=>{
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
        await this.sessions.flush(now);
    }

    writeChanges(updates,removals,complete) {
        if (!updates.length && !removals.length) return Promise.resolve();
        const writing = (this.writeQueue || Promise.resolve()).catch(()=>{})
            .then(()=>this.store.apply(updates,removals))
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

        const result = this.sessions.use(accessToken,Date.now());
        if (typeof result === 'boolean') return result;
        await result.saved;
        return !this.closed && result.current();
    }

    async deleteAccess(accessToken) {
        if (this.closed) return;
        await this.sessions.revoke(accessToken);
    }

    newToken(client = '') {
        return this.pendingChallenges.issue(String(client),this.config.accessPassword,Date.now(),this.accessTimeout);
    }
}

module.exports = WebAccess;
