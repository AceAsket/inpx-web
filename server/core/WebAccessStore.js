const fs = require('node:fs/promises');
const {join,resolve} = require('node:path');
const programs = require('./RustPrograms');
const RustFramedProcess = require('./RustFramedProcess');
const {lock} = require('./CatalogueLock');

const storeFile = 'sessions.redb';
const tokenBytes = 64;
const loadBytes = tokenBytes+16;
const updateBytes = tokenBytes+24;
const removalBytes = tokenBytes+8;
const tokenPattern = /^[0-9a-f]{64}$/;

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
        this.binary = binary;
        this.file = resolve(directory,storeFile);
        this.queue = Promise.resolve();
    }

    request(request,buffers,consume) {
        const unavailable = ()=>Object.assign(new Error('Хранилище сеансов доступа недоступно',{cause:this.lockFailure}),
            {code:'INPX_ACCESS_STORE_UNAVAILABLE'});
        if (this.closing) return Promise.reject(unavailable());
        const result = this.queue.then(async()=>{
            if (this.process?.failure) {
                await this.process.closed;
                this.process = null;
            }
            if (this.lockFailure) throw unavailable();
            this.process ||= new RustFramedProcess(this.binary,'access-store',this.file);
            return this.process.request(request,buffers,consume);
        });
        this.queue = result.catch(()=>{});
        return result;
    }

    init(fingerprint,restore) {
        return this.request({op:'init',fingerprint,prepareOnly:restore===false},[],async stream=>{
            let state;
            const sessions = [];
            for await (const block of stream) {
                if (state === undefined) {
                    if (block.length !== 1 || ![1,2].includes(block[0])) throw new Error('Некорректный ответ хранилища сеансов');
                    state = block[0];
                } else {
                    if (state !== 1 || block.length%loadBytes) throw new Error('Некорректный блок сеансов доступа');
                    if (restore===false) continue;
                    if (restore) restore(block);
                    else for (let offset=0;offset<block.length;offset+=loadBytes) {
                        const token = block.toString('ascii',offset,offset+tokenBytes);
                        sessions.push([token,{time:block.readDoubleLE(offset+tokenBytes),used:block.readDoubleLE(offset+tokenBytes+8)}]);
                    }
                }
            }
            return {state:state===1 ? 'ready' : state===2 ? 'repairLegacy' : undefined,sessions};
        });
    }

    async apply(updates,removals) {
        if (!updates.length && !removals.length) return;
        const bytes = Buffer.allocUnsafe(8+updates.length*updateBytes+removals.length*removalBytes);
        bytes.writeUInt32LE(updates.length,0);
        bytes.writeUInt32LE(removals.length,4);
        let offset=8;
        for (const [token,{time,used}] of updates) {
            if (!tokenPattern.test(token)) throw new Error('invalid session key');
            bytes.write(token,offset,tokenBytes,'ascii');
            bytes.writeDoubleLE(0,offset+tokenBytes);
            bytes.writeDoubleLE(time,offset+tokenBytes+8);
            bytes.writeDoubleLE(used,offset+tokenBytes+16);
            offset += updateBytes;
        }
        for (const token of removals) {
            if (!tokenPattern.test(token)) throw new Error('invalid session key');
            bytes.write(token,offset,tokenBytes,'ascii');
            bytes.writeDoubleLE(0,offset+tokenBytes);
            offset += removalBytes;
        }
        return this.applyPacked(bytes);
    }

    applyPacked(bytes) {
        return this.request({op:'apply',bytes:bytes.length},[bytes],async stream=>{
            for await (const _ of stream) throw new Error('Некорректное подтверждение записи сеансов');
        });
    }

    close() {
        return this.closing ||= (async()=>{
            try {
                await this.queue;
                await this.process?.stop();
            } finally {await this.release?.();}
        })();
    }
}

async function openWebAccessStore(directory,fingerprint,cacheSize,binary=programs.executable('catalog'),onLockLost,restore) {
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
        store.process?.interrupt(error);
        onLockLost?.(error);
    });
    try {
        store.release = await hold();
        const file = await fs.open(join(directory,storeFile),'a',0o600);
        await file.close();
        let result = await store.init(fingerprint,restore);
        if (result?.state==='repairLegacy') {
            await store.release();
            store.release = null;
            const legacy = await JembaAccessStore.open(directory,cacheSize);
            await legacy.close();
            store.release = await hold();
            result = await store.init(fingerprint,restore);
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

async function prepareNativeWebAccess(directory,fingerprint,cacheSize,onLockLost) {
    const binary=programs.executable('catalog');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const file=resolve(directory,storeFile);
    if (await exists(join(directory,'access')) || await exists(join(directory,'config'))) {
        const {store}=await openWebAccessStore(directory,fingerprint,cacheSize,binary,onLockLost,false);
        await store.close();
    }
    const release=await lock(directory,binary,onLockLost);
    try {
        await (await fs.open(file,'a',0o600)).close();
        return {file,release};
    } catch (error) {await release();throw error;}
}

module.exports = {openWebAccessStore,prepareNativeWebAccess};
