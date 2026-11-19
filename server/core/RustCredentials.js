const {resolve} = require('node:path');
const RustFramedProcess = require('./RustFramedProcess');
const {executable} = require('./RustLookupIndex');

const pools = new Map();

function pool(binary) {
    if (!pools.has(binary)) {
        const slot = () => ({queue:Promise.resolve(), pending:0});
        pools.set(binary,{binary,secrets:[slot()], passwords:Array.from({length:4},slot)});
    }
    return pools.get(binary);
}

function processFor(entry, slot) {
    if (!slot.process || slot.process.failure) slot.process = new RustFramedProcess(entry.binary,'credentials');
    return slot.process;
}

async function stopSlot(slot) {
    clearTimeout(slot.idle);
    const process = slot.process;
    slot.process = null;
    await slot.queue;
    await process?.stop();
}

function start() {
    const binary = executable();
    if (!binary) return;
    const entry = pool(binary);
    for (const slot of [entry.secrets[0],entry.passwords[0]]) {
        slot.held = true;
        clearTimeout(slot.idle);
        processFor(entry,slot);
    }
    return async () => {
        if (pools.get(binary) === entry) pools.delete(binary);
        await Promise.all([...entry.secrets,...entry.passwords].map(async slot => {
            slot.held = false;
            await slot.queue;
            await stopSlot(slot);
        }));
    };
}

async function request(header, buffers, passwordWork = false) {
    const entry = pool(executable());
    const choices = passwordWork ? entry.passwords : entry.secrets;
    const slot = choices.find(slot=>!slot.pending && slot.process)
        || choices.find(slot=>!slot.pending) || choices[0];
    clearTimeout(slot.idle);
    slot.pending++;
    const operation = slot.queue.then(() => processFor(entry,slot).request(header,buffers,async stream => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        if (chunks.length === 1) return chunks[0];
        const result = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        return result;
    }));
    slot.queue = operation.catch(()=>{});
    try {return await operation;}
    finally {
        for (const buffer of buffers) buffer.fill(0);
        if (--slot.pending === 0 && !slot.held)
            slot.idle = setTimeout(() => {void stopSlot(slot);},1000);
    }
}

async function key(file, create) {
    const bytes = await request({op:'key',file:resolve(file),create:!!create},[]);
    if(bytes.length === 32) return bytes;
    bytes.fill(0);
    throw new Error('Invalid secret key length');
}

async function secrets(file, values, encrypt) {
    if (!values.length) return [];
    const buffers = values.map(value=>Buffer.from(value,'utf8'));
    const data = await request({op:'secrets',file:resolve(file),encrypt,sizes:buffers.map(buffer=>buffer.length)},buffers);
    try {
        let offset = 0;
        const results = [];
        for (const _ of values) {
            if (offset+4 > data.length) throw new Error('Некорректный ответ хранилища секретов');
            const size = data.readUInt32LE(offset);
            offset += 4;
            if (offset+size > data.length) throw new Error('Некорректный ответ хранилища секретов');
            results.push(data.toString('utf8',offset,offset+size));
            offset += size;
        }
        if (offset !== data.length) throw new Error('Некорректный ответ хранилища секретов');
        return results;
    } finally {data.fill(0);}
}

async function hash(password) {
    const bytes = Buffer.from(password,'utf8');
    const value = await request({op:'hash',passwordBytes:bytes.length},[bytes],true);
    try {return value.toString('ascii');}
    finally {value.fill(0);}
}

async function verify(stored, login, password, legacy) {
    const username = Buffer.from(login,'utf8'), bytes = Buffer.from(password,'utf8');
    const value = await request({op:'verify',stored,loginBytes:username.length,passwordBytes:bytes.length},[username,bytes],!legacy);
    try {return value.length === 1 && value[0] === 1;}
    finally {value.fill(0);}
}

async function secondFactor(payload) {
    const body = Buffer.from(JSON.stringify(payload),'utf8');
    const value = await request({op:'secondFactor',bytes:body.length},[body]);
    try {return JSON.parse(value.toString('utf8'));}
    finally {value.fill(0);}
}

const opdsPasswordBytes = 37;
const opdsHashBytes = 64;

async function issueOpdsPassword() {
    const value = await request({op:'opdsIssue'},[]);
    try {
        if (value.length !== opdsPasswordBytes + opdsHashBytes)
            throw new Error('Некорректный ответ при создании пароля OPDS');
        return {password:value.toString('ascii',0,opdsPasswordBytes),hash:value.toString('ascii',opdsPasswordBytes)};
    } finally {value.fill(0);}
}

async function verifyOpdsPassword(stored, password) {
    const value = await request({op:'opdsVerify',stored},[Buffer.from(password,'ascii')]);
    try {return value.length === 1 && value[0] === 1;}
    finally {value.fill(0);}
}

module.exports = {start, key, secrets, hash, verify, secondFactor, issueOpdsPassword, verifyOpdsPassword, executable};
