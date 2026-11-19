const {Worker} = require('worker_threads');
const {RustLookupIndex} = require('./RustLookupIndex');

const actions = [
    'create','drop','truncate','clone','open','openAll','close','closeAll',
    'tableExists','getDbInfo','getDbSize','setMonitoring','select','insert','update','delete',
    'markCorrupted','freeMemory',
];

async function readBookBatches(process, request, key, values, batchSize) {
    const rows = [];
    for (let offset=0; offset<values.length; offset+=batchSize) {
        const batch = await process.query({...request,[key]:values.slice(offset,offset+batchSize)});
        if (!Array.isArray(batch)) throw new Error('Invalid Rust book store response');
        rows.push(...batch);
    }
    return rows;
}

class DatabaseThread {
    constructor(config,onLockLost) {
        this.cachePolicy = require('./DatabaseCache').policy(config);
        this.onLockLost = onLockLost;
        this.worker = null;
        this.listeners = new Map();
        this.requestId = 0;
        this.available = false; this.failure = null; this.termination = Promise.resolve();
        for (const action of actions) this[action] = async query=>this._action(action,query);
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
        if (this.nativeCatalogue && action==='tableExists')
            return ['book','config','author','series','title','word','genre','lang','del','date','librate','ext','source'].includes(query.table);
        if (this.legacyBookOptions && action === 'select' && (query?.table === 'book'
            || query?.joinById && [query.joinById].flat().some(join => join?.table === 'book')))
            await this.openLegacyBooks();
        if (this.legacyNameTables && (action === 'select' || action === 'getDbInfo')) {
            await this.openLegacyNameTable(query?.table);
            if (query?.joinById) for (const join of [query.joinById].flat()) await this.openLegacyNameTable(join?.table);
        }
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
        if (this.worker) throw new Error('Worker has been created already');
        this._runWoker();
        try {await this._action('lock',query);}
        catch (error) {this._terminate();throw error;}
    }

    esc(value) {
        if (this.nativeCatalogue) return JSON.stringify(value).replace(/@/g,'\\x40');
        return require('jembadb/src/utils').esc(value);
    }

    async openNative(directory,config,cacheSize) {
        this.nativeCatalogue = config;
        this.releaseCatalogue = await require('./CatalogueLock').lock(directory,undefined,error=>{
            this.available = false;
            this.failure = {code:'INPX_CATALOGUE_LOCK_LOST',message:error.message,at:new Date().toISOString()};
            this.onLockLost?.(error);
        });
        await this.configureBookStore(directory,config.rustBookStoreGeneration,cacheSize);
        this.available = true;
    }


    async unlock() {
        try {
            await this.serviceCache?.close();
            await this.rustShelfIndex?.close();
            await this.rustWideOrder?.close();
            await this.rustWideStore?.close();
            await this.bookStore?.close();
            if (this.worker) await this._action('unlock');
        }
        finally {
            const release = this.releaseCatalogue;
            this.releaseCatalogue = undefined;
            this.nativeCatalogue = this.serviceCache = undefined;
            this.rustShelfIndex = this.rustWideOrder = this.rustWideStore = this.bookStore = undefined;
            this.bookStoreAdvanced = this.bookStoreScan = this.bookStoreFacets = this.bookStoreWide = undefined;
            this.bookStoreFacetSelection = undefined;
            this.bookStoreCatalogueEntities = undefined;
            this.legacyBookOptions = this.legacyBookOpen = undefined;
            this.legacyNameTables = this.legacyNameOpen = undefined;
            this._terminate();
            try {await release?.();}
            finally {await this.termination;}
        }
    }

    deferNameTables(tables,cacheSize) {
        this.legacyNameTables = new Map(tables.map(table=>[table,{table,cacheSize}]));
        this.legacyNameOpen = new Map();
    }

    async openLegacyNameTable(table) {
        const options=this.legacyNameTables.get(table);
        if (!options) return;
        if (!this.legacyNameOpen.has(table)) {
            const pending=this.open(options).catch(error=>{this.legacyNameOpen.delete(table);throw error;});
            this.legacyNameOpen.set(table,pending);
        }
        await this.legacyNameOpen.get(table);
    }

    async configureBookStore(directory, generation, cacheSize) {
        this.legacyBookOptions = {table:'book',cacheSize};
        if (generation) {
            const store = new RustLookupIndex(directory,null,{file:directory,generation,command:'store'});
            const available = await store.run(process => process.query({op:'probe',capabilities:true}),() => false);
            if (available === true || available?.advancedSearch === true) {
                this.bookStore = store;
                this.bookStoreAdvanced = available?.advancedSearch === true;
                this.bookStoreScan = available?.catalogScan === true;
                this.bookStoreFacets = available?.facets === true;
                this.bookStoreFacetSelection = available?.facetSelection === true;
                this.bookStoreCatalogueEntities = available?.catalogueEntities === true;
                this.bookStoreWide = available?.wideSearch === true;
                if (this.bookStoreWide) this.rustWideStore = new RustLookupIndex(directory,null,{file:directory,generation,command:'store'});
                return;
            }
            await store.close();
        }
        await this.openLegacyBooks();
    }

    async openLegacyBooks() {
        if (this.nativeCatalogue) throw new Error('Rust catalogue book store is unavailable');
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
        const keys = [...new Set(this.nativeCatalogue
            ? Array.from(ids,Number).filter(id=>Number.isInteger(id) && id>0 && id<=0xffffffff) : ids)];
        const fallback = () => this.select({table:'book',where:`@@id(${this.esc(keys)})`,
            ...(fields ? {map:`row => Object.fromEntries(${this.esc(fields)}.filter(key => row[key] !== undefined).map(key => [key,row[key]]))`} : {})});
        if (!keys.length) return [];
        if (!this.bookStore) return fallback();
        return this.bookStore.run(process => readBookBatches(process,{op:'rows',fields},'ids',keys,fields ? 2048 : 512),fallback);
    }

    async booksByUids(uids) {
        const keys = [...new Set(this.nativeCatalogue
            ? uids.filter(uid=>typeof uid==='string' && uid.length>0 && uid.length<=100) : uids)];
        const fallback = () => this.select({table:'book',where:`@@hash('_uid',${this.esc(keys)})`});
        if (!keys.length) return [];
        if (!this.bookStore || keys.some(uid => typeof uid !== 'string' || uid.length > 100)) return fallback();
        return this.bookStore.run(process => readBookBatches(process,{op:'uids'},'uids',keys,512),fallback);
    }

    async catalogueBookIds() {
        if (this.bookStoreScan) {
            const ids = await this.bookStore.run(process=>process.query({op:'bookOrder'}),()=>null);
            if (Array.isArray(ids)) return ids;
        }
        return (await this.select({table:'book',rawResult:true,where:'return Array.from(@all());'}))[0].rawResult;
    }

    _runWoker() {
        const worker = new Worker(`require(${JSON.stringify(require.resolve('./DatabaseWorker'))})`, {eval:true, workerData:this.cachePolicy});
        this.worker = worker; this.available = true; this.failure = null;
        worker.on('message', message => {if (this.worker === worker) this.listeners.get(message.requestId)?.(message);});
        worker.on('error', error => this.failed(worker,error));
        worker.on('exit', code => this.failed(worker,null,code));
    }
    cacheStats() {return this.nativeCatalogue ? {engine:'rust',available:this.available} : this._action('cacheStats');}
}
module.exports = DatabaseThread;
