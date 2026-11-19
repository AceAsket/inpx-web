const fs = require('fs-extra');
const path = require('path');
const {pipeline} = require('node:stream/promises');
const StreamZip = require('node-stream-zip');
const {limits} = require('./RequestLimits');
const {executable} = require('./RustLookupIndex');
const nativeZip = require('./RustBackupZip');
const encryption = require('./BackupCrypto');

const names = new Set(['backup-info.json', 'config.json', 'secret.key', 'reading-lists.json', 'discovery-cache.json', 'backup-vault.json']);
const inspection = Symbol('backupInspection');
const savedBackup = Symbol('savedBackup');

async function read(payload, config, folder) {
    const maximum = limits(config);
    const archive = payload && Object.hasOwn(payload,savedBackup)
        ? await nativeZip.unpackSaved(config.dataDir,payload[savedBackup],folder,maximum,payload.password,payload.fingerprint)
        : await readUpload(payload,folder,maximum);
    if (!archive) throw new Error('Повреждён ZIP резервной копии');
    const result = {...archive.data};
    if (!result['backup-info.json'] || (!result['config.json'] && !result['reading-lists.json']))
        throw new Error('Файл не похож на полный бэкап inpx-web');
    for (const [name, data] of Object.entries(result)) {
        if (!name.endsWith('.json'))
            continue;
        const parsed = JSON.parse(data.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error(`Неверный формат ${name}`);
        result[name] = parsed;
    }
    const lists = result['reading-lists.json'];
    if (lists && (!Array.isArray(lists.users) || !Array.isArray(lists.lists)))
        throw new Error('Неверный формат reading-lists.json');
    const key = result['secret.key'];
    if (key && (!result['config.json'] || !/^[A-Za-z0-9+/]{43}=\s*$/.test(key.toString('utf8'))))
        throw new Error('Ключ бэкапа повреждён или отсутствует config.json');
    if (result['backup-vault.json'] && (result['backup-vault.json'].version !== 1 || !key))
        throw new Error('Настройки резервных копий повреждены');
    const {fingerprint,encrypted,files} = archive;
    result[inspection] = {fingerprint, encrypted, files};
    return result;
}

async function readUpload(payload, folder, maximum) {
    const raw = payload && (payload.contentBase64 || payload.data);
    if (typeof raw !== 'string' || raw.length > Math.ceil(maximum.backup/3)*4 + 1024)
        throw new Error('Превышен размер бэкапа или неверный формат');
    const base64 = raw.replace(/^data:[^,]{0,200},/, '').trim();
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
        throw new Error('Некорректный base64 бэкапа');
    let buffer = Buffer.from(base64, 'base64');
    if (buffer.length > maximum.backup)
        throw new Error('Превышен размер бэкапа');
    const fingerprint = require('crypto').createHash('sha256').update(buffer).digest('hex');
    if (payload.fingerprint && payload.fingerprint !== fingerprint) throw new Error('Файл резервной копии изменился после проверки');
    const encrypted = encryption.isEncrypted(buffer);
    let archive;
    if (encrypted && executable()) {
        encryption.validateEnvelope(buffer,payload.password);
        archive = await nativeZip.unpackEncrypted(buffer, folder, maximum.expanded, payload.password);
    } else {
        if (encrypted) buffer = await encryption.decrypt(buffer, payload.password);
        archive = await unpack(buffer, folder, maximum.expanded);
    }
    return archive && {...archive,fingerprint,encrypted};
}

async function unpack(buffer, folder, limit) {
    const native = !!executable();
    if (native && buffer.length <= nativeZip.inlineZipLimit)
        return nativeZip.unpack(buffer, limit);
    const file = path.join(folder, 'backup.zip');
    await fs.writeFile(file, buffer, {mode:0o600});
    return native ? nativeZip.unpack(file, limit) : unpackLegacy(file, limit);
}

async function unpackLegacy(file, limit) {
    const zip = new StreamZip.async({file});
    try {
        const entries = Object.values(await zip.entries());
        if (entries.length > names.size || await zip.entriesCount !== entries.length)
            throw new Error('Слишком много файлов в бэкапе');
        let declared = 0;
        for (const entry of entries) {
            if (!names.has(entry.name) || entry.isDirectory)
                throw new Error('Неизвестный файл в бэкапе');
            declared += entry.size;
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || declared > limit)
                throw new Error('Превышен распакованный размер бэкапа');
        }
        const result = {};
        let total = 0;
        for (const entry of entries) {
            const stream = await zip.stream(entry.name);
            const chunks = [];
            for await (const chunk of stream) {
                total += chunk.length;
                if (total > limit) {
                    stream.destroy();
                    throw new Error('Превышен распакованный размер бэкапа');
                }
                chunks.push(chunk);
            }
            result[entry.name] = Buffer.concat(chunks);
        }
        return {data:result, files:entries.map(({name,size}) => ({name,size}))};
    } finally {
        await zip.close();
    }
}

async function write(file, files, createdAt, secret) {
    const entries = files.filter(source => source.data || source.path);
    if (executable()) {
        try {await nativeZip.pack(file, entries, createdAt, secret);}
        finally {if (Buffer.isBuffer(secret?.key)) secret.key.fill(0);}
        return;
    }
    const temporary = file + '.tmp';
    const consume = stream => secret
        ? encryption.encryptStream(stream, temporary, secret.key, secret.salt)
        : pipeline(stream, fs.createWriteStream(temporary, {flags:'wx', mode:0o600}));
    try {
        await packLegacy(entries, consume);
        await fs.rename(temporary, file);
    } finally {
        await fs.remove(temporary).catch(() => {});
    }
}

async function packLegacy(files, consume) {
    const zip = new (require('yazl').ZipFile)();
    const done = consume(zip.outputStream);
    done.catch(() => {});
    zip.on('error', error => zip.outputStream.destroy(error));
    try {
        for (const source of files) {
            if (source.data) zip.addBuffer(source.data,source.name);
            else {
                try {
                    if (!(await fs.stat(source.path)).isFile()) throw new Error(`Некорректный источник резервной копии ${source.name}`);
                } catch (error) {
                    if (error.code === 'ENOENT') continue;
                    throw error;
                }
                zip.addFile(source.path,source.name);
            }
        }
        zip.end();
        await done;
    } catch (error) {
        zip.outputStream.destroy(error);
        await done.catch(() => {});
        throw error;
    }
}

module.exports = {read, write, inspection, savedBackup};
