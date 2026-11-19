const {resolve} = require('node:path');
const runtime = require('./ResourceRuntime');
const programs = require('./RustPrograms');
const RustWorkerPool = require('./RustWorkerPool');

const immediate = new RustWorkerPool('kosync',1);
const indexes = new RustWorkerPool('kosync');

const executable = ()=>programs.executable('catalog');

function start() {
    const binary = executable();
    if (!binary) return;
    const closeImmediate = immediate.start(binary,{lazy:true});
    const closeIndexes = indexes.start(binary,{lazy:true});
    return ()=>Promise.all([closeImmediate(),closeIndexes()]);
}

async function readResult(stdout) {
    const parts = [];
    let bytes = 0;
    for await (const chunk of stdout) {
        bytes += chunk.length;
        if (bytes > 64*1024) throw new Error('Ответ KOSync превышает лимит');
        parts.push(chunk);
    }
    return bytes ? JSON.parse(parts.length===1 ? parts[0] : Buffer.concat(parts,bytes)) : undefined;
}

function request(binary,command,worker = immediate) {
    return worker.run(binary,command,readResult,{signal:runtime.signal()});
}

function fingerprint(binary,source) {
    return request(binary,{op:'fingerprint',source:resolve(source)});
}

function link(binary,file,source,bookUid,ext,now) {
    return request(binary,{op:'link',file:resolve(file),source:resolve(source),bookUid,ext,now});
}

function lookup(binary,file,query) {
    return request(binary,{op:'lookup',file:resolve(file),query});
}

function build(binary,file,source,document) {
    return request(binary,{op:'build',file:resolve(file),source:resolve(source),document},indexes);
}

function pair(binary) {
    return request(binary,{op:'pair'});
}

function clientKey(binary,password) {
    return request(binary,{op:'clientKey',password:password.toWellFormed()});
}

function identity(user,expectedVerifier) {
    return {userId:user.id,passwordHash:user.passwordHash || undefined,expectedVerifier};
}

function account(binary,file,user,key,expectedVerifier) {
    return request(binary,{op:'account',file:resolve(file),...identity(user,expectedVerifier),key});
}

function setAccount(binary,file,userId,verifier,webPasswordHash) {
    return request(binary,{op:'setAccount',file:resolve(file),userId,verifier,webPasswordHash});
}

function disableAccount(binary,file,userId) {
    return request(binary,{op:'disableAccount',file:resolve(file),userId});
}

function progress(binary,file,user,expectedVerifier,document) {
    return request(binary,{op:'progress',file:resolve(file),...identity(user,expectedVerifier),document});
}

function saveProgress(binary,file,userId,document,stamp,record,prune) {
    return request(binary,{op:'saveProgress',file:resolve(file),userId,document,stamp,record:JSON.stringify(record),prune});
}

module.exports = {executable,start,fingerprint,link,lookup,build,pair,clientKey,account,setAccount,disableAccount,progress,saveProgress};
