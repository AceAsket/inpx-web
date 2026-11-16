const {resolve} = require('node:path');
const {readFile} = require('node:fs/promises');
const RustFramedProcess = require('./RustFramedProcess');
const runtime = require('./ResourceRuntime');
const programs = require('./RustPrograms');

const workers = new Map();

function executable() {return programs.executable('catalog');}

function entry(binary) {
    if (!workers.has(binary)) workers.set(binary,{binary});
    return workers.get(binary);
}

function processFor(state) {
    if (!state.process || state.process.failure) state.process = new RustFramedProcess(state.binary,'book-batch');
    return state.process;
}

async function close(state) {
    clearTimeout(state.idle);
    if (workers.get(state.binary)===state) workers.delete(state.binary);
    await state.operation?.catch(()=>{});
    await state.process?.stop();
}

function start() {
    const binary = executable();
    if (!binary) return;
    const state = entry(binary);
    clearTimeout(state.idle);
    processFor(state);
    state.held = true;
    return ()=>close(state);
}

async function completion(stream) {
    let result;
    for await (const frame of stream) {
        if (result!==undefined || frame.length>32) throw new Error('Некорректный ответ пакетного ZIP');
        result = JSON.parse(frame);
    }
    return result;
}

async function write(binary,output,limit,entries) {
    const state = entry(binary);
    clearTimeout(state.idle);
    if (state.operation) throw new Error('Другой ZIP уже готовится. Повторите позже.');
    const child = processFor(state);
    const signal = runtime.signal();
    state.operation = (async()=>{
        const send = (request,buffers=[])=>child.request(request,buffers,completion,{signal});
        await send({op:'begin',output:resolve(output),limit});
        let finished = false;
        try {
            for await (const {source,name,stat} of entries) {
                const time = stat.mtime;
                const mtime = [time.getFullYear(),time.getMonth()+1,time.getDate(),time.getHours(),time.getMinutes(),time.getSeconds()];
                const inline = process.platform==='win32' && stat.size<=8*1024*1024;
                const bytes = inline ? await readFile(source) : null;
                if (bytes && bytes.length!==stat.size) throw new Error('Размер книги изменился при создании ZIP');
                await send({op:'add',entry:{source:resolve(source),name,size:stat.size,mode:stat.mode,mtime},inline},bytes ? [bytes] : []);
            }
            const bytes = await send({op:'finish'});
            if (!Number.isSafeInteger(bytes) || bytes<1 || bytes>limit) throw new Error('Некорректный размер пакетного ZIP');
            finished = true;
            return bytes;
        } finally {
            if (!finished && !child.failure) await child.request({op:'abort'},[],completion).catch(()=>{});
        }
    })();
    try {return await state.operation;}
    finally {
        state.operation = null;
        if (!state.held && workers.get(binary)===state) state.idle = setTimeout(()=>{void close(state);},1000);
    }
}

module.exports = {executable,start,write};
