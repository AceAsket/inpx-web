const {join,resolve,extname} = require('node:path');
const RustFramedProcess = require('./RustFramedProcess');
const runtime = require('./ResourceRuntime');

const batchSize = 512;

async function readJson(stdout) {
    const chunks = [];
    for await (const bytes of stdout) chunks.push(bytes);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

async function readFolderRecords(binary, source, cache, options, legacyMetadata, onInventory, emit, flush) {
    const process = new RustFramedProcess(binary,'folder-index');
    const request = (header,data,timeoutMs) => {
        const requestOptions = {...options,timeoutMs};
        if (data === undefined) return process.request(header,[],readJson,requestOptions);
        const body = Buffer.from(JSON.stringify(data));
        return process.request({...header,bytes:body.length},[body],readJson,requestOptions);
    };
    try {
        const files = await request({root:source.libDir,sourceId:source.id,cache:resolve(cache)},undefined,null);
        if (!Array.isArray(files)) throw new Error('Invalid Rust folder inventory');
        await onInventory(files);
        for (let offset=0; offset<files.length; offset+=batchSize) {
            const batch = files.slice(offset,offset+batchSize);
            const timeoutMs = Math.min(2_147_483_647,(options.timeoutMs ?? runtime.settings.taskTimeoutMs)*batch.length);
            const records = await request({op:'batch'},batch,timeoutMs);
            if (!Array.isArray(records) || records.length!==batch.length)
                throw new Error('Invalid Rust folder records batch');
            for (const [index,file] of batch.entries()) {
                options.signal?.throwIfAborted();
                let record = records[index];
                if (record === null) {
                    const ext = extname(file.relative).slice(1).toLowerCase();
                    const fallback = await legacyMetadata(join(source.libDir,file.relative),ext);
                    record = await request({op:'fill',index},fallback,options.timeoutMs);
                }
                if (!record || !Object.hasOwn(record,'_uid')) throw new Error('Invalid Rust folder record');
                await emit(file,record);
            }
        }
        await flush();
        await request({op:'commit'},undefined,null);
    } finally {await process.stop();}
}

module.exports = {readFolderRecords};
