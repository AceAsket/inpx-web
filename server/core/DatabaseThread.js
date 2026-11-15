const {Worker} = require('worker_threads');
const {JembaDbThread} = require('jembadb');
const {RustLookupIndex} = require('./RustLookupIndex');

async function readBookBatches(process, request, key, values, batchSize) {
    const rows = [];
    for (let offset=0; offset<values.length; offset+=batchSize) {
        const batch = await process.query({...request,[key]:values.slice(offset,offset+batchSize)});
        if (!Array.isArray(batch)) throw new Error('Invalid Rust book store response');
        rows.push(...batch);
    }
    return rows;
}

class DatabaseThread extends JembaDbThread {
    constructor(config) {
        super(); this.cachePolicy = require('./DatabaseCache').policy(config);
        this.available = false; this.failure = null; this.termination = Promise.resolve();
    }

    unavailableError() {
        const detail = this.failure?.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'поток завершился из-за нехватки памяти'
            : this.failure ? 'поток базы данных неожиданно завершился' : 'база данных закрыта';
        return Object.assign(new Error(`Поисковая база недоступна: ${detail}. Перезапустите сервер для восстановления.`),
            {code:'INPX_DATABASE_UNAVAILABLE', causeCode:this.failure?.code});
    }

    rejectPending(error) {
        for (const listener of [...this.listeners.values()])
            listener({error:error.message, errorCode:error.code, causeCode:error.causeCode});
        this.listeners.clear();
    }

    stopWorker(worker) {
        try {this.termination = Promise.resolve(worker.terminate()).catch(() => {});}
        catch (_) {this.termination = Promise.resolve();}
    }

    failed(worker, error, exitCode) {
        if (this.worker !== worker) return;
        this.failure = {code:error?.code || 'INPX_DATABASE_WORKER_EXIT',
            message:String(error?.message || `Database worker exited with code ${exitCode}`).slice(0,500),
            at:new Date().toISOString(), ...(exitCode === undefined ? {} : {exitCode})};
        this.worker = null; this.available = false;
        this.rejectPending(this.unavailableError());
        this.stopWorker(worker);
    }

    _terminate() {
        const worker = this.worker;
        this.worker = null; this.available = false;
        this.rejectPending(this.unavailableError());
        if (worker) this.stopWorker(worker);
    }

    async _action(action, query) {
        if (this.legacyBookOptions && action === 'select' && (query?.table === 'book'
            || query?.joinById && [query.joinById].flat().some(join => join?.table === 'book')))
            await this.openLegacyBooks();
        const worker = this.worker;
        if (!worker || !this.available) throw this.unavailableError();
        return new Promise((resolve,reject) => {
            const requestId = ++this.requestId;
            this.listeners.set(requestId, message => {
                this.listeners.delete(requestId);
                if (message.error) reject(Object.assign(new Error(message.error),
                    {code:message.errorCode, causeCode:message.causeCode}));
                else resolve(message.result);
            });
            try {worker.postMessage({requestId, action, query});}
            catch (error) {
                this.listeners.delete(requestId);
                if (error.code === 'ERR_WORKER_NOT_RUNNING') this.failed(worker,error);
                reject(error);
            }
        });
    }

    async lock(query) {
        await this.termination;
        return super.lock(query);
    }

    async unlock() {
        try {
            await this.bookStore?.close();
            if (this.worker) await this._action('unlock');
        }
        finally {
            this.bookStore = this.legacyBookOptions = this.legacyBookOpen = undefined;
            this._terminate();
            await this.termination;
        }
    }

    async configureBookStore(directory, generation, cacheSize) {
        this.legacyBookOptions = {table:'book',cacheSize};
        if (generation) {
            const store = new RustLookupIndex(directory,null,{directory,generation});
            const available = await store.run(process => process.query({op:'probe'}),() => false);
            if (available === true) {
                this.bookStore = store;
                return;
            }
            await store.close();
        }
        await this.openLegacyBooks();
    }

    async openLegacyBooks() {
        if (!this.legacyBookOptions) return;
        if (!this.legacyBookOpen) {
            this.legacyBookOpen = this.open(this.legacyBookOptions).catch(error => {
                this.legacyBookOpen = null;
                throw error;
            });
        }
        await this.legacyBookOpen;
    }

    async booksByIds(ids, fields) {
        const keys = [...new Set(ids)];
        const fallback = () => this.select({table:'book',where:`@@id(${this.esc(keys)})`,
            ...(fields ? {map:`row => Object.fromEntries(${this.esc(fields)}.filter(key => row[key] !== undefined).map(key => [key,row[key]]))`} : {})});
        if (!keys.length) return [];
        if (!this.bookStore) return fallback();
        return this.bookStore.run(process => readBookBatches(process,{op:'rows',fields},'ids',keys,fields ? 2048 : 512),fallback);
    }

    async booksByUids(uids) {
        const keys = [...new Set(uids)];
        const fallback = () => this.select({table:'book',where:`@@hash('_uid',${this.esc(keys)})`});
        if (!keys.length) return [];
        if (!this.bookStore || keys.some(uid => typeof uid !== 'string' || uid.length > 100)) return fallback();
        return this.bookStore.run(process => readBookBatches(process,{op:'uids'},'uids',keys,512),fallback);
    }

    _runWoker() {
        const worker = new Worker(`require(${JSON.stringify(require.resolve('./DatabaseWorker'))})`, {eval:true, workerData:this.cachePolicy});
        this.worker = worker; this.available = true; this.failure = null;
        worker.on('message', message => {if (this.worker === worker) this.listeners.get(message.requestId)?.(message);});
        worker.on('error', error => this.failed(worker,error));
        worker.on('exit', code => this.failed(worker,null,code));
    }
    cacheStats() {return this._action('cacheStats');}
}
module.exports = DatabaseThread;
