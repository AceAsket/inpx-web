const assert = require('node:assert/strict');
const {createHash,randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {Worker,isMainThread,parentPort,workerData} = require('node:worker_threads');
const {RustLookupIndex} = require('./RustLookupIndex');

function intern(labels,value) {
    if (!labels.has(value)) labels.set(value,labels.size);
    return labels.get(value);
}

function ranks(labels,compare) {
    const values = [...labels.keys()].sort(compare), ranked = new Uint32Array(labels.size);
    let rank = 0;
    for (const [position,value] of values.entries()) {
        if (position>0 && compare(values[position-1],value)!==0) rank++;
        ranked[labels.get(value)] = rank;
    }
    return ranked;
}

async function buildOrder(store,path,signal) {
    const run = request => {
        signal.throwIfAborted();
        return store.run(reader=>reader.query(request),()=>{throw new Error(store.lastError || 'Rust catalogue order is unavailable');});
    };
    const bookIds = await run({op:'bookOrder'});
    const ordinals = new Map(bookIds.map((id,index)=>[id,index]));
    assert.equal(ordinals.size,bookIds.length,'Invalid catalogue order IDs');
    const header = Buffer.from('INPXORD1'+store.generation);
    const buffer = Buffer.allocUnsafe(header.length + 36*bookIds.length);
    header.copy(buffer);
    const labels = [new Map(),new Map(),new Map()];
    let cursor = null, offset = header.length;
    do {
        const page = await run({op:'scan',after:cursor,limit:4096,fields:['id','author','series','title','serno','del']});
        assert(Array.isArray(page?.rows) && (page.after===null || Number.isSafeInteger(page.after) && page.after>(cursor ?? -1)),
            'Invalid catalogue page while building order');
        for (const {id,author,series,title,serno,del} of page.rows) {
            const ordinal = ordinals.get(id);
            assert(ordinal!==undefined && typeof author==='string' && typeof series==='string' && typeof title==='string'
                && Number.isFinite(serno) && Number.isFinite(del),'Unsupported catalogue sort fields');
            ordinals.delete(id);
            buffer.writeUInt32LE(id,offset);
            buffer.writeUInt32LE(intern(labels[0],author),offset+4);
            buffer.writeUInt32LE(intern(labels[1],series),offset+8);
            buffer.writeUInt32LE(intern(labels[2],title),offset+12);
            buffer.writeUInt32LE(ordinal,offset+16);
            buffer.writeDoubleLE(serno,offset+20);
            buffer.writeDoubleLE(del,offset+28);
            offset+=36;
        }
        cursor=page.after;
    } while (cursor!==null);
    assert.equal(ordinals.size,0,'Catalogue order describes a different set of books');
    assert.equal(offset,buffer.length);
    const compare = new Intl.Collator().compare;
    const [authors,series,titles] = labels.map((values,index)=>ranks(values,index===1
        ? (a,b)=>a && b ? compare(a,b) : Number(!a)-Number(!b) : compare));
    for (offset=header.length;offset<buffer.length;offset+=36) {
        buffer.writeUInt32LE(authors[buffer.readUInt32LE(offset+4)],offset+4);
        buffer.writeUInt32LE(series[buffer.readUInt32LE(offset+8)],offset+8);
        buffer.writeUInt32LE(titles[buffer.readUInt32LE(offset+12)],offset+12);
    }
    signal.throwIfAborted();
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
        await fs.writeFile(temporary,buffer,{flag:'wx',signal});
        signal.throwIfAborted();
        await fs.rename(temporary,path);
    } finally {await fs.rm(temporary,{force:true});}
    return bookIds.length;
}

class RustWideOrder {
    constructor(directory,store) {
        this.directory = directory;
        this.store = store;
        this.key = createHash('sha256').update(JSON.stringify([store.generation,process.versions.icu,new Intl.Collator().resolvedOptions().locale])).digest('hex');
        this.path = join(directory,`book-order-${this.key}.bin`);
        this.nextBuild = 0;
    }

    async available() {
        if (this.closed) return null;
        if (!this.ready) {
            try {await fs.access(this.path); this.ready=true;}
            catch (error) {
                if (error.code==='ENOENT') void this.prepare().catch(()=>{});
                return null;
            }
        }
        return this.key;
    }

    prepare() {
        if (this.building) return this.building;
        if (this.closed || Date.now()<this.nextBuild) return Promise.resolve(null);
        const worker = this.worker = new Worker(__filename,{workerData:{wideOrder:{directory:this.directory,path:this.path,
            generation:this.store.generation,binary:this.store.binary}}});
        this.building = new Promise((resolve,reject)=>{
            let result, failure;
            worker.on('message',message=>{result=message.rows; if (message.error) failure=new Error(message.error);});
            worker.on('error',error=>{failure=error;});
            worker.once('exit',code=>{
                if (code!==0 || result===undefined) reject(failure || new Error(`Rust catalogue order worker exited (${code})`));
                else {this.ready=true;resolve(result);}
            });
        }).catch(error=>{this.nextBuild=Date.now()+60000;throw error;}).finally(()=>{this.worker=this.building=null;});
        return this.building;
    }

    async close() {
        this.closed=true;
        this.worker?.postMessage('abort');
        await this.building?.catch(()=>{});
    }
}

if (!isMainThread && workerData?.wideOrder) {
    const {directory,path,generation,binary} = workerData.wideOrder;
    const store = new RustLookupIndex(directory,null,{file:directory,generation,binary,command:'store'});
    const controller = new AbortController();
    parentPort.on('message',()=>{controller.abort();void store.close();});
    buildOrder(store,path,controller.signal).then(rows=>parentPort.postMessage({rows}),error=>parentPort.postMessage({error:error.message}))
        .finally(async()=>{await store.close();parentPort.close();});
}

module.exports = RustWideOrder;
