const {randomBytes} = require('node:crypto');
const fs = require('node:fs/promises');
const {dirname,extname,join,resolve} = require('node:path');
const RustWorkerPool = require('./RustWorkerPool');
const runtime = require('./ResourceRuntime');
const programs = require('./RustPrograms');

const codecs = new RustWorkerPool('book-cache');
const metadata = new RustWorkerPool('book-cache',1);
const executable = ()=>programs.executable('catalog');

async function readJson(stream,maximum = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > maximum) throw new Error('Слишком большой ответ обработки книги');
        chunks.push(chunk);
    }
    // Errors carry a completion status and can end the stream before the first frame.
    if (!size) return undefined;
    return JSON.parse(chunks.length===1 ? chunks[0] : Buffer.concat(chunks,size));
}

function start() {
    const binary = executable();
    if (!binary) return;
    const stopCodecs = codecs.start(binary);
    const stopMetadata = metadata.start(binary);
    return ()=>Promise.all([stopCodecs(),stopMetadata()]);
}

function inspect(binary,directory,hash,assetVersion,touch,probeRaw) {
    const signal = runtime.signal();
    return metadata.run(binary,{op:'inspect',directory:resolve(directory),hash,assetVersion,touch,probeRaw},readJson,{signal});
}

function stage(binary,command,directory,pool=codecs) {
    const token = randomBytes(16).toString('hex');
    const signal = runtime.signal();
    const onFailure = ()=>Promise.all(['gzip','raw','json','zip'].map(file=>fs.rm(join(directory,`.book-cache-${token}-${file}`),{force:true})));
    const send = ()=>pool.run(binary,{...command,token},readJson,{signal,onFailure});
    return pool===codecs ? runtime.run(send,{kind:'reviews',signal}) : send();
}

function publish(binary,directory,source,descriptor,raw) {
    const target = resolve(directory);
    return stage(binary,{op:'publish',directory:target,source:resolve(source),descriptor,raw},target);
}

function registerRemote(binary,directory,hash,descriptor) {
    const target = resolve(directory);
    return stage(binary,{op:'registerRemote',directory:target,hash,descriptor},target,metadata);
}

async function materialize(binary,operation,source,output,details = {}) {
    const target = resolve(output);
    const signal = runtime.signal();
    if (await metadata.run(binary,{op:'rawReady',output:target,expectedSize:details.expectedSize || 0},readJson,{signal})) return false;
    return stage(binary,{op:operation,source:resolve(source),output:target,...details},dirname(target));
}

async function normalizeFb2(source) {
    const binary = executable();
    if (!binary) return null;
    return prepareBook(binary,'normalizeFb2',source,{});
}

async function bufferedInput(source) {
    const file = await fs.open(source,'r');
    try {
        if ((await file.stat()).size > 8 * 1024 * 1024) return null;
        const bytes = await file.readFile();
        return bytes.length <= 8 * 1024 * 1024 ? bytes : null;
    } finally {await file.close();}
}

function prepareBook(binary,op,source,options,maximum) {
    const signal = runtime.signal();
    const file = resolve(source);
    return runtime.run(async()=>{
        // Small scratch files on Windows are cheaper to read in Node and send over the existing pipe.
        const bytes = process.platform==='win32' && (op!=='repackEpub' || extname(file).toLowerCase()!=='.7z')
            ? await bufferedInput(file) : null;
        const request = bytes ? {op:`${op}Bytes`,source:file,size:bytes.length,...options} : {op,source:file,...options};
        return codecs.run(binary,request,stream=>readJson(stream,maximum),{signal,buffers:bytes ? [bytes] : []});
    },{kind:'reviews',signal});
}

function prepareEpub(binary,source,output) {
    return prepareBook(binary,'repackEpub',source,{output:resolve(output)},8 * 1024 * 1024);
}

function appendEpubImages(binary,output,manifest,remaining) {
    const signal = runtime.signal();
    return runtime.run(()=>codecs.run(binary,{op:'appendEpubImages',output:resolve(output),manifest:resolve(manifest),remaining},
        readJson,{signal}),{kind:'reviews',signal});
}

async function convertEpub(binary,input,output,options = {}) {
    const file = resolve(input);
    const target = resolve(output);
    const token = randomBytes(16).toString('hex');
    const deadline = Math.min(options.deadline || Infinity, Date.now() + (options.timeoutMs || 120000));
    const maxOutput = 256 * 1024 * 1024;
    const maximum = Math.max(0,Math.floor(Math.min(maxOutput, Number(options.maxOutputBytes) || maxOutput)));
    const cancelled = () => Object.assign(new Error('Конвертация отменена'),{code:'ABORT_ERR'});
    const timedOut = () => Object.assign(new Error('Превышено время конвертации EPUB'),{code:'INPX_CONVERSION_TIMEOUT'});
    if (options.signal?.aborted) throw cancelled();
    if (deadline < Date.now()) throw timedOut();
    const timeout = AbortSignal.timeout(Math.ceil(Math.min(2147483647,Math.max(1,deadline-Date.now()))));
    const signal = options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
    const onFailure = ()=>fs.rm(join(dirname(target),`.book-cache-${token}-convert`),{force:true});
    const details = {output:target,token,maximum};
    try {
        const bytes = process.platform === 'win32' ? await bufferedInput(file) : null;
        signal.throwIfAborted();
        const request = bytes ? {op:'convertEpubBytes',size:bytes.length,...details} : {op:'convertEpub',source:file,...details};
        await codecs.run(binary,request,readJson,{signal,buffers:bytes ? [bytes] : [],onFailure,timeoutMs:2147483647});
    } catch (error) {
        if (options.signal?.aborted) throw cancelled();
        if (timeout.aborted) throw timedOut();
        throw error;
    }
}

module.exports = {executable,inspect,publish,registerRemote,materialize,normalizeFb2,prepareEpub,appendEpubImages,convertEpub,start};
