const fs = require('fs-extra');
const path = require('path');
const ZipReader = require('./ZipReader');
const runtime = require('./ResourceRuntime');
const rustArchive = require('./RustBookArchive');

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
    }
    if (content === 'isbn' && rustArchive.executable()) {
        const numbers = await rustArchive.metadata(file || state.resolved,file ? null : name,String(book.ext).toLowerCase(),
            {limit:maxBytes,isbnOnly:true,signal});
        if (numbers !== null) return numbers;
    }
    if (!state.directory) {
        if (!state.reader) {
            const reader = new ZipReader({...worker.config,resourceMaxOutputBytes:maxBytes,resourceSignal:signal});
            try {await reader.open(state.resolved); state.reader = reader;}
            catch (error) {await reader.close().catch(() => {}); state.error = error; throw error;}
        }
        entry = state.reader.entries[name] || Object.values(state.reader.entries).find(row => row.name === name);
        if (!entry) throw Object.assign(new Error('Файл отсутствует в архиве'),{code:'ENOENT'});
        if (entry.isDirectory || entry.isLink) throw new Error('Недопустимый тип записи архива');
    }
    if (!content) return null;
    if (Number(entry.size) > maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки содержимого'),{code:'AUDIT_LIMIT'});
    const read = async() => {
        if (state.reader?.uses7z) return state.reader.extractToBuf(name);
        const stream = file ? fs.createReadStream(file) : await state.reader.zip.stream(name);
        const chunks = []; let size = 0;
        try {for await (const chunk of stream) {signal.throwIfAborted(); size += chunk.length;
            if (size > maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки'),{code:'AUDIT_LIMIT'});
            chunks.push(chunk);}
        } finally {stream.destroy();}
        return Buffer.concat(chunks);
    };
    const data = state.reader?.uses7z ? await read() : await runtime.run(read,{kind:'reviews',signal:signal});
    return data;
}

module.exports = {read};
