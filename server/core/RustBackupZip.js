const {resolve} = require('node:path');
const {executable} = require('./RustLookupIndex');
const RustFramedProcess = require('./RustFramedProcess');

const inlineZipLimit = 1024*1024;
const workers = new Map();

function worker(binary) {
    if (!workers.has(binary)) workers.set(binary, {binary, queue:Promise.resolve(), pending:0});
    return workers.get(binary);
}

function stop(entry) {
    clearTimeout(entry.idle);
    if (workers.get(entry.binary) === entry) workers.delete(entry.binary);
    return entry.queue.then(() => entry.process?.stop());
}

function start() {
    const binary = executable();
    if (!binary) return;
    const entry = worker(binary);
    entry.held = true;
    clearTimeout(entry.idle);
    entry.process ||= new RustFramedProcess(binary,'backup-zip');
    return () => stop(entry);
}

async function run(header, buffers, consume) {
    const entry = worker(executable());
    clearTimeout(entry.idle);
    entry.pending++;
    const operation = entry.queue.then(() => {
        if (!entry.process || entry.process.failure) entry.process = new RustFramedProcess(entry.binary,'backup-zip');
        return entry.process.request(header,buffers,consume);
    });
    entry.queue = operation.catch(() => {});
    try {return await operation;}
    finally {
        if (--entry.pending === 0 && !entry.held && workers.get(entry.binary) === entry)
            entry.idle = setTimeout(() => {void stop(entry);},1000);
    }
}

function pack(destination, files, createdAt, secret) {
    const filesHeader = files.map(({name, data, path}) => data ? {name, size:data.length} : {name, path});
    const timestamp = [createdAt.getFullYear(), createdAt.getMonth()+1, createdAt.getDate(),
        createdAt.getHours(), createdAt.getMinutes(), createdAt.getSeconds()];
    const buffers = files.flatMap(({data}) => data ? [data] : []);
    if (secret) {
        if (!Buffer.isBuffer(secret.key) || secret.key.length !== 32 || !Buffer.isBuffer(secret.salt) || secret.salt.length !== 16)
            throw new Error('Повреждены параметры шифрования резервной копии');
        buffers.unshift(secret.key, secret.salt);
    }
    return run({op:'pack', destination:resolve(destination), encrypted:!!secret, timestamp, files:filesHeader}, buffers,
        async stdout => {for await (const _ of stdout) throw new Error('Неожиданный ответ при записи резервной копии');});
}

function unpack(source, limit) {
    const input = Buffer.isBuffer(source) ? {size:source.length} : {path:source};
    return run({op:'unpack', limit, ...input}, Buffer.isBuffer(source) ? [source] : [], stdout => collect(stdout, limit));
}

async function unpackEncrypted(source, folder, limit, password) {
    const bytes = Buffer.from(password, 'utf8');
    try {
        return await run({op:'unpackEncrypted', size:source.length, passwordBytes:bytes.length, folder, limit},
            [bytes,source], stdout => collect(stdout, limit));
    } finally {bytes.fill(0);}
}

async function unpackSaved(dataDir, name, folder, limits, password, fingerprint) {
    const bytes = typeof password === 'string' && password.length <= 1024
        ? Buffer.from(password,'utf8') : Buffer.alloc(0);
    try {
        const expected = fingerprint ? (typeof fingerprint === 'string' ? fingerprint : '') : null;
        return await run({op:'saved',dataDir:resolve(dataDir),name:typeof name === 'string' ? name : '',
            folder,limit:limits.expanded,uploadLimit:limits.backup,passwordBytes:bytes.length,fingerprint:expected},
        [bytes],stdout=>collect(stdout,limits.expanded));
    } finally {bytes.fill(0);}
}

async function deriveKey(password, salt) {
    const bytes = Buffer.from(password,'utf8');
    const key = Buffer.alloc(32);
    try {
        const size = await run({op:'derive', passwordBytes:bytes.length}, [salt,bytes], async stdout => {
            let offset = 0;
            for await (const chunk of stdout) {
                const count = chunk.copy(key,offset);
                chunk.fill(0);
                if (offset + count > key.length || count !== chunk.length)
                    throw new Error('Некорректный ключ резервной копии');
                offset += count;
            }
            return offset;
        });
        if (size !== key.length) throw new Error('Некорректный ключ резервной копии');
        return key;
    } catch (error) {
        key.fill(0);
        throw error;
    } finally {bytes.fill(0);}
}

async function collect(stdout, limit) {
    const data = Object.create(null);
    let header = Buffer.alloc(0), files, inspection, index = 0, bytes = 0;
    for await (let chunk of stdout) {
        if (!files) {
            const newline = chunk.indexOf(10);
            const prefix = newline < 0 ? chunk : chunk.subarray(0,newline);
            if (header.length + prefix.length > 4096) throw new Error('Некорректное оглавление резервной копии');
            header = Buffer.concat([header,prefix]);
            if (newline < 0) continue;
            const manifest = JSON.parse(header.toString('utf8'));
            if (Array.isArray(manifest)) files = manifest;
            else {
                if (!/^[a-f0-9]{64}$/.test(manifest?.fingerprint) || typeof manifest?.encrypted !== 'boolean')
                    throw new Error('Некорректное оглавление резервной копии');
                ({files,...inspection} = manifest);
            }
            let remaining = limit;
            const names = new Set();
            if (!Array.isArray(files) || files.length > 6 || files.some(({name,size}) => {
                remaining -= size;
                if (typeof name !== 'string' || !Number.isSafeInteger(size) || size < 0 || remaining < 0 || names.has(name)) return true;
                names.add(name);
                return false;
            })) throw new Error('Некорректное оглавление резервной копии');
            chunk = chunk.subarray(newline+1);
        }
        while (index < files.length && (chunk.length || files[index].size === 0)) {
            const {name, size} = files[index];
            const output = data[name] ??= Buffer.allocUnsafe(size);
            const consumed = Math.min(size-bytes,chunk.length);
            chunk.copy(output,bytes,0,consumed);
            chunk = chunk.subarray(consumed);
            bytes += consumed;
            if (bytes === size) {
                index++;
                bytes = 0;
            }
        }
        if (chunk.length) throw new Error('Распакованный размер бэкапа отличается от оглавления');
    }
    // The native exit status carries the reason when decoding stopped early.
    return files && index === files.length ? {files, data, ...inspection} : null;
}

module.exports = {pack, unpack, unpackEncrypted, unpackSaved, deriveKey, start, inlineZipLimit};
