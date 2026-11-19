const {resolve} = require('node:path');
const {executable} = require('./RustLookupIndex');
const RustFramedProcess = require('./RustFramedProcess');

const brokers = new Map();

function locked(directory) {
    return Object.assign(new Error('Database locked: '+directory),{code:'INPX_CATALOGUE_LOCKED'});
}

async function readResult(stdout) {
    let reply = '';
    for await (const bytes of stdout) {
        reply += bytes.toString('ascii');
        if (reply.length>5) throw new Error('Invalid catalogue lock response');
    }
    if (reply==='true') return true;
    if (reply==='false' || !reply) return false;
    throw new Error('Invalid catalogue lock response');
}

class LockBroker {
    constructor(binary) {
        this.process = new RustFramedProcess(binary,'catalogue-lock');
        this.active = new Map();
        this.pending = 0;
        this.queue = Promise.resolve();
        this.process.closed.then(()=>{
            clearTimeout(this.idle);
            if (brokers.get(binary)===this) brokers.delete(binary);
            for (const notify of this.active.values()) notify?.(this.process.failure);
            this.active.clear();
        });
    }

    request(op,directory) {
        clearTimeout(this.idle);
        this.pending++;
        const operation = this.queue.then(()=>{
            if (this.process.failure) throw this.process.failure;
            return this.process.request({op,directory},[],readResult,{timeoutMs:5000});
        });
        this.queue = operation.catch(()=>{});
        return operation.finally(()=>{
            this.pending--;
            if (!this.pending && !this.active.size && !this.process.failure)
                this.idle = setTimeout(()=>{
                    if (!this.pending && !this.active.size) this.closing = this.process.stop();
                },750);
        });
    }

    async acquire(directory,onLost) {
        if (!await this.request('acquire',directory)) throw locked(directory);
        if (this.process.failure) throw this.process.failure;
        clearTimeout(this.idle);
        this.active.set(directory,onLost);
        let releasing;
        return ()=>releasing ||= (async()=>{
            this.active.delete(directory);
            if (!this.process.failure && !await this.request('release',directory))
                throw new Error('Catalogue lock was already released');
        })();
    }
}

async function lock(directory,binary = executable(),onLost) {
    if (!binary) {
        const {getFileLock,releaseFileLock} = require('jembadb/src/utils');
        const watcher = await getFileLock(directory,true).catch(error=>{
            if (error.message.startsWith('Path locked:')) throw locked(directory);
            throw error;
        });
        return ()=>releaseFileLock(directory,watcher);
    }
    let broker = brokers.get(binary);
    if (!broker || broker.closing || broker.process.failure) {
        broker = new LockBroker(binary);
        brokers.set(binary,broker);
    }
    return broker.acquire(resolve(directory),onLost);
}

module.exports = {lock};
