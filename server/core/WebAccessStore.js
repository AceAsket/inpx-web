const fs = require('node:fs/promises');
const {join} = require('node:path');
const {RustLookupIndex,executable} = require('./RustLookupIndex');
const {lock} = require('./CatalogueLock');
const runtime = require('./ResourceRuntime');

const storeFile = 'sessions.redb';
const batchSize = 2048;

async function exists(path) {
    try {await fs.access(path);return true;}
    catch (error) {if (error.code==='ENOENT') return false;throw error;}
}

async function archiveLegacySessions(directory) {
    const legacy = join(directory,'access');
    if (!await exists(legacy)) return;
    const backup = await fs.mkdtemp(`${directory}.legacy-`);
    try {await fs.rename(legacy,join(backup,'access'));}
    catch (error) {await fs.rmdir(backup);throw error;}
}

class JembaAccessStore {
    static async open(directory,cacheSize) {
        const db = new (require('jembadb').JembaDbThread)();
        await db.lock({dbPath:directory,create:true,softLock:true,tableDefaults:{cacheSize}});
        try {
            try {await db.openAll();}
            catch (error) {
                if (!/corrupted|Unexpected token|invalid stored block lengths/.test(error.message)) throw error;
                await db.openAll({autoRepair:true});
            }
            return new JembaAccessStore(db);
        } catch (error) {
            await db.unlock();
            throw error;
        }
    }

    constructor(db) {this.db = db;}

    async init(fingerprint) {
        const db = this.db;
        await db.create({table:'access',quietIfExists:true});
        await db.create({table:'config',quietIfExists:true});
        const [previous] = await db.select({table:'config',where:"@@id('pass')"});
        if (previous?.value!==fingerprint) {
            await db.truncate({table:'access'});
            await db.insert({table:'config',replace:true,rows:[{id:'pass',value:fingerprint}]});
        }
        return (await db.select({table:'access'})).map(row=>[row.id,row.value]);
    }

    async apply(updates,removals) {
        if (updates.length) await this.db.insert({table:'access',replace:true,rows:updates.map(([id,value])=>({id,value}))});
        if (removals.length) await this.db.delete({table:'access',where:`@@id(${this.db.esc(removals)})`});
    }

    close() {return this.db.unlock();}
}

class RustAccessStore {
    constructor(binary,directory) {
        this.reader = new RustLookupIndex(directory,null,{binary,file:join(directory,storeFile),
            generation:'access-v1',command:'access-store'});
    }

    query(request) {
        if (this.lockFailure)
            throw Object.assign(new Error('Хранилище сеансов доступа недоступно',{cause:this.lockFailure}),{code:'INPX_ACCESS_STORE_UNAVAILABLE'});
        return runtime.withSignal(undefined,()=>this.reader.run(process=>process.query(request),()=>{
            throw Object.assign(new Error('Хранилище сеансов доступа недоступно'),{code:'INPX_ACCESS_STORE_UNAVAILABLE'});
        }));
    }

    async apply(updates,removals) {
        for (let offset=0;offset<Math.max(updates.length,removals.length);offset+=batchSize) {
            const result = await this.query({op:'apply',updates:updates.slice(offset,offset+batchSize),
                removals:removals.slice(offset,offset+batchSize)});
            if (result?.state!=='applied') throw new Error('Хранилище сеансов не подтвердило запись');
        }
    }

    async close() {
        try {await this.reader.close();}
        finally {await this.release?.();}
    }
}

async function openWebAccessStore(directory,fingerprint,cacheSize,binary=executable(),onLockLost) {
    if (!binary) {
        if (await exists(join(directory,storeFile)))
            throw new Error('Для открытия хранилища сеансов доступа нужен Rust-бинарник каталога');
        const store = await JembaAccessStore.open(directory,cacheSize);
        try {return {store,sessions:await store.init(fingerprint)};}
        catch (error) {await store.close();throw error;}
    }
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const store = new RustAccessStore(binary,directory);
    const hold = ()=>lock(directory,binary,error=>{
        store.lockFailure = error;
        void store.reader.close();
        onLockLost?.(error);
    });
    try {
        store.release = await hold();
        const file = await fs.open(join(directory,storeFile),'a',0o600);
        await file.close();
        let result = await store.query({op:'init',fingerprint});
        if (result?.state==='repairLegacy') {
            await store.release();
            store.release = null;
            const legacy = await JembaAccessStore.open(directory,cacheSize);
            await legacy.close();
            store.release = await hold();
            result = await store.query({op:'init',fingerprint});
        }
        if (result?.state!=='ready' || !Array.isArray(result.sessions))
            throw new Error('Не удалось перенести прежние сеансы доступа');
        await archiveLegacySessions(directory);
        return {store,sessions:result.sessions};
    } catch (error) {
        await store.close();
        throw error;
    }
}

module.exports = {openWebAccessStore};
