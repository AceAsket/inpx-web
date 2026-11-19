const fs = require('node:fs/promises');
const iconv = require('iconv-lite');
const {executable} = require('./RustLookupIndex');
const RustWorkerPool = require('./RustWorkerPool');
const runtime = require('./ResourceRuntime');

const workers = new RustWorkerPool('book-archive');

function start() {
    const binary = executable();
    if (binary) return workers.start(binary);
}

function legacyZipName(name) {
    if (!name || /^[\x00-\x7f]*$/.test(name)) return;
    const bytes = iconv.encode(name,'cp866');
    if (iconv.decode(bytes,'cp866') === name) return iconv.decode(bytes,'cp437');
}

async function consume(stdout) {
    for await (const _ of stdout) throw new Error('Неожиданный вывод при распаковке книги');
}

async function extract(source, name, destination, {maxOutputBytes = 0,prefixBytes = 0,signal,timeoutMs} = {}) {
    const binary = executable();
    if (!binary) return false;
    signal ||= runtime.signal();
    try {
        await runtime.run(()=>workers.run(binary,{
            source,name,destination,legacyZipName:legacyZipName(name),limit:maxOutputBytes,prefix:prefixBytes,
        },consume,{signal,timeoutMs,onFailure:()=>fs.rm(destination,{force:true})}),{kind:'reviews',signal});
        if (signal?.aborted) {
            await fs.rm(destination,{force:true});
            signal.throwIfAborted();
        }
        return true;
    } catch (error) {
        if (name && ['INPX_ARCHIVE_UNSUPPORTED','ENOENT'].includes(error?.code)) return false;
        throw error;
    }
}

async function metadata(source,name,format,{limit = 64 * 1024 * 1024,isbnOnly = false,signal = runtime.signal(),timeoutMs} = {}) {
    const binary = executable();
    if (!binary) return null;
    const consume = async stdout => {
        const chunks = [];
        let count = 0;
        for await (const chunk of stdout) {
            count += chunk.length;
            if (count > 16 * 1024 * 1024) throw new Error('Слишком большой ответ с метаданными книги');
            chunks.push(chunk);
        }
        return count ? JSON.parse(Buffer.concat(chunks,count)) : null;
    };
    try {
        const result = await runtime.run(()=>workers.run(binary,{
            source,name,legacyZipName:legacyZipName(name),metadata:format,limit,isbnOnly,
        },consume,{signal,timeoutMs}),{kind:'reviews',signal});
        signal?.throwIfAborted();
        return result;
    } catch (error) {
        if (['INPX_ARCHIVE_UNSUPPORTED','INPX_ARCHIVE_READ','ENOENT'].includes(error?.code)) return null;
        throw error;
    }
}

module.exports = {extract,metadata,executable,start};
