const {join} = require('node:path');
const {RustLookupIndex,executable} = require('./RustLookupIndex');

const fileName = 'service-cache.redb';
const wordsMarker = '$inpxUint32';

function stringify(value) {
    return JSON.stringify(value,(_,item)=>item instanceof Uint32Array
        ? {[wordsMarker]:Buffer.from(item.buffer,item.byteOffset,item.byteLength).toString('base64')} : item);
}

function restore(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof value[wordsMarker]==='string' && Object.keys(value).length===1) {
        const bytes=Buffer.from(value[wordsMarker],'base64');
        if (bytes.length%4!==0) throw new Error('Invalid catalogue cache ID array');
        return new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
    }
    for (const key of Object.keys(value)) value[key]=restore(value[key]);
    return value;
}

class CatalogueServiceCache {
    static attach(db,directory) {
        if (executable()) db.serviceCache = new CatalogueServiceCache(directory);
    }

    constructor(directory) {
        this.reader = new RustLookupIndex(directory,null,{file:join(directory,fileName),generation:'cache-v1',command:'service-cache'});
    }

    query(request,fallback=()=>null) {return this.reader.run(process=>process.query(request),fallback);}

    async get(key) {return restore(await this.query({op:'get',key}));}

    put(key,value,maxCount,maxBytes) {
        return this.query({op:'put',key,value:stringify(value),maxCount:Math.floor(maxCount),maxBytes:Math.floor(maxBytes)});
    }

    trim(maxCount,maxBytes) {return this.query({op:'trim',maxCount:Math.floor(maxCount),maxBytes:Math.floor(maxBytes)});}

    async close() {
        try {if (this.reader.process) await this.query({op:'flush'});}
        finally {await this.reader.close();}
    }
}

async function fileHashesByIds(db,ids) {
    ids = [...new Set(Array.isArray(ids) ? ids : [ids])];
    if (!ids.length) return [];
    const rows = db.serviceCache ? await db.serviceCache.query({op:'fileRows',ids}) : null;
    if (db.nativeCatalogue || rows?.length===ids.length) return rows || [];
    const found = new Set(rows?.map(row=>row.id));
    const missing = ids.filter(id=>!found.has(id));
    const legacy = await db.select({table:'file_hash',where:`@@id(${db.esc(missing.length===1 ? missing[0] : missing)})`});
    return [...(rows || []),...legacy];
}

async function fileHashesByHash(db,hash) {
    const rows = db.serviceCache ? await db.serviceCache.query({op:'findHash',hash}) : null;
    if (db.nativeCatalogue || rows?.length) return rows || [];
    return db.select({table:'file_hash',where:`for (const id of @all()) {
        if ((@unsafeRow(id)).hash === ${db.esc(hash)}) return [id];
    } return [];`});
}

async function saveFileHash(db,row) {
    if (db.serviceCache && await db.serviceCache.query({op:'putHash',row})) return;
    if (!db.nativeCatalogue) await db.insert({table:'file_hash',replace:true,rows:[row]});
}

module.exports = {CatalogueServiceCache,fileHashesByIds,fileHashesByHash,saveFileHash};
