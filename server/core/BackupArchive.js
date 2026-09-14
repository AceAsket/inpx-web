const fs = require('fs-extra');
const path = require('path');
const StreamZip = require('node-stream-zip');
const {limits} = require('./RequestLimits');

const names = new Set(['backup-info.json', 'config.json', 'secret.key', 'reading-lists.json', 'discovery-cache.json']);

async function read(payload, config, folder) {
    const maximum = limits(config);
    const raw = payload && (payload.contentBase64 || payload.data);
    if (typeof raw !== 'string' || raw.length > Math.ceil(maximum.backup/3)*4 + 1024)
        throw new Error('Превышен размер бэкапа или неверный формат');
    const base64 = raw.replace(/^data:[^,]{0,200},/, '').trim();
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
        throw new Error('Некорректный base64 бэкапа');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > maximum.backup)
        throw new Error('Превышен размер бэкапа');
    const file = path.join(folder, 'backup.zip');
    await fs.writeFile(file, buffer, {mode: 0o600});
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
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || declared > maximum.expanded)
                throw new Error('Превышен распакованный размер бэкапа');
        }
        const result = {};
        let total = 0;
        for (const entry of entries) {
            const stream = await zip.stream(entry.name);
            const chunks = [];
            for await (const chunk of stream) {
                total += chunk.length;
                if (total > maximum.expanded) {
                    stream.destroy();
                    throw new Error('Превышен распакованный размер бэкапа');
                }
                chunks.push(chunk);
            }
            result[entry.name] = Buffer.concat(chunks);
        }
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
        return result;
    } finally {
        await zip.close();
    }
}

module.exports = {read};
