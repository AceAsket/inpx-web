const fs = require('fs-extra');
const path = require('path');
const ZipReader = require('./ZipReader');
const runtime = require('./ResourceRuntime');

function contained(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function read(worker, book, cache, signal, maxBytes, content = true) {
    const source = path.resolve(book.sourceLibDir || worker.config.libDir);
    const folder = path.resolve(source, book.folder || '.');
    if (!contained(source, folder)) throw new Error('Путь архива выходит за пределы источника');
    const name = `${book.file}.${book.ext}`;
    if (path.isAbsolute(name) || name.replace(/\\/g,'/').split('/').includes('..')) throw new Error('Недопустимое имя файла');
    const key = source + '\0' + folder;
    if (!cache.has(key)) {
        // Bound open archives, including failed/missing archive lookups.
        if (cache.size >= 4) {const [oldKey, old] = cache.entries().next().value; await old.reader?.close(); cache.delete(oldKey);}
        try {
            await fs.access(source).catch(() => {throw Object.assign(new Error('Источник библиотеки недоступен. Повторите проверку после подключения'),{code:'AUDIT_SOURCE_UNAVAILABLE'});});
            const resolved = await worker.resolveLibraryArchivePath(folder, source);
            const sourceReal = await fs.realpath(source);
            if (!contained(sourceReal, await fs.realpath(resolved))) throw new Error('Ссылка ведёт за пределы источника');
            const stat = await fs.stat(resolved);
            const state = {resolved,sourceReal,directory:stat.isDirectory()};
            if (!state.directory) {state.reader = new ZipReader({...worker.config,resourceMaxOutputBytes:maxBytes});
                try {await state.reader.open(resolved);} catch (error) {await state.reader.close().catch(() => {}); throw error;}}
            cache.set(key,state);
        } catch (error) {cache.set(key,{error});}
    }
    const state = cache.get(key);
    if (state.error) throw state.error;
    let entry, file;
    if (state.directory) {
        file = path.resolve(state.resolved,name);
        if (!contained(state.sourceReal, await fs.realpath(file))) throw new Error('Ссылка ведёт за пределы источника');
        entry = await fs.stat(file);
        if (!entry.isFile()) throw new Error('Вместо книги найден каталог');
    } else {
        entry = state.reader.entries[name] || Object.values(state.reader.entries).find(row => row.name === name);
        if (!entry) throw Object.assign(new Error('Файл отсутствует в архиве'),{code:'ENOENT'});
        if (entry.isDirectory || entry.isLink) throw new Error('Недопустимый тип записи архива');
    }
    if (!content) return null;
    if (Number(entry.size) > maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки содержимого'),{code:'AUDIT_LIMIT'});
    const read = async() => {
        if (state.reader?.archiveType === '7z') return state.reader.extractToBuf(name);
        const stream = file ? fs.createReadStream(file) : await state.reader.zip.stream(name);
        const chunks = []; let size = 0;
        try {for await (const chunk of stream) {signal.throwIfAborted(); size += chunk.length;
            if (size > maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки'),{code:'AUDIT_LIMIT'});
            chunks.push(chunk);}
        } finally {stream.destroy();}
        return Buffer.concat(chunks);
    };
    const data = state.reader?.archiveType === '7z' ? await read() : await runtime.run(read,{kind:'reviews',signal:signal});
    return data;
}

module.exports = {read};
