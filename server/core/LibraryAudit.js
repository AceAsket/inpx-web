const fs = require('fs-extra');
const path = require('path');
const tasks = require('./BackgroundTasks');
const runtime = require('./ResourceRuntime');
const ZipReader = require('./ZipReader');

function contained(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function validateXml(buffer, root) {
    const text = new (require('./fb2/Fb2Helper'))().checkEncoding(buffer).toString('utf8');
    const parser = require('sax').parser(true, {strictEntities:true});
    parser.onerror = error => {throw error;};
    let first = '';
    parser.onopentag = node => {if (!first) first = node.name.split(':').pop();};
    parser.write(text).close();
    if (first !== root) throw new Error('Некорректный корневой элемент документа');
    return text;
}

class LibraryAudit {
    constructor(worker) { this.worker = worker; this.job = null; }
    describe() {
        if (!this.job) return null;
        const {controller, ...result} = this.job;
        return {...result, running:!controller.signal.aborted && !result.finishedAt};
    }
    start(options = {}) {
        if (this.job && !this.job.finishedAt) throw new Error('Проверка библиотеки уже выполняется');
        if (this.worker.remoteLib) throw new Error('Проверка запускается на сервере, где хранятся исходные книги');
        const id = tasks.start('audit', 'Проверка библиотеки');
        this.job = {id, deep:options.deep === true, checked:0, total:0, missing:0, damaged:0, skipped:0,
            issues:[], issuesTruncated:false, startedAt:Date.now(), controller:new AbortController()};
        const job = this.job;
        this.pending = runtime.withSignal(job.controller.signal, () => runtime.withTask(id, () => this.run(job))).catch(error => {
            job.error = job.controller.signal.aborted ? 'Проверка отменена' : error.message;
            tasks.finish(id, error);
        }).finally(() => {
            job.finishedAt = Date.now();
            if (job.controller.signal.aborted) tasks.update(id, {state:'cancelled', phase:'Проверка отменена'});
            else if (!job.error) tasks.finish(id);
        });
        return this.describe();
    }
    cancel() { this.job?.controller.abort(); return this.describe(); }
    issue(job, book, kind, message) {
        job[kind]++;
        if (job.issues.length < 500) job.issues.push({bookUid:String(book._uid || '').slice(0,512), title:String(book.title || '').slice(0,500),
            folder:String(book.folder || '').slice(0,500), kind, message:String(message || '').slice(0,2000)});
        else job.issuesTruncated = true;
    }
    async run(job) {
        const worker = this.worker, db = worker.db, generation = worker.libraryAssetGeneration;
        const [{rawResult:ids}] = await db.select({table:'book',rawResult:true,where:'return Array.from(@all());'});
        job.total = ids.length;
        tasks.update(job.id, {total:ids.length, phase:job.deep ? 'Файлы и содержимое' : 'Наличие файлов'});
        const cache = new Map();
        try {
            for (let offset = 0; offset < ids.length; offset += 250) {
                job.controller.signal.throwIfAborted();
                if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Запустите проверку заново');
                const books = await db.select({table:'book',where:`@@id(${db.esc(ids.slice(offset,offset + 250))})`});
                for (const book of books) {
                    job.controller.signal.throwIfAborted();
                    if (!book.del) {
                        try {await this.check(book, job, cache);}
                        catch (error) {
                            if (job.controller.signal.aborted || error.code === 'ABORT_ERR') throw error;
                            if (['AUDIT_SOURCE_UNAVAILABLE','INPX_RESOURCE_QUEUE_FULL','INPX_RESOURCE_QUEUE_TIMEOUT','INPX_CONVERSION_TIMEOUT'].includes(error.code)) throw error;
                            this.issue(job,book,['AUDIT_LIMIT','INPX_RESOURCE_OUTPUT_LIMIT','ERR_BUFFER_TOO_LARGE'].includes(error.code) ? 'skipped' : error.code === 'ENOENT' ? 'missing' : 'damaged',
                                error.code === 'ENOENT' ? 'Архив или файл отсутствует' : error.message);
                        }
                    } else job.skipped++;
                    job.controller.signal.throwIfAborted();
                    if (worker.db !== db || worker.libraryAssetGeneration !== generation) throw new Error('Библиотека обновилась. Запустите проверку заново');
                    job.checked++;
                }
                tasks.update(job.id, {done:job.checked});
                await require('./utils').processLoop();
            }
        } finally {for (const state of cache.values()) if (state.reader) await state.reader.close().catch(() => {});}
    }
    async check(book, job, cache) {
        const source = path.resolve(book.sourceLibDir || this.worker.config.libDir);
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
                const resolved = await this.worker.resolveLibraryArchivePath(folder, source);
                const sourceReal = await fs.realpath(source);
                if (!contained(sourceReal, await fs.realpath(resolved))) throw new Error('Ссылка ведёт за пределы источника');
                const stat = await fs.stat(resolved);
                const state = {resolved,sourceReal,directory:stat.isDirectory()};
                if (!state.directory) {state.reader = new ZipReader({...this.worker.config,resourceMaxOutputBytes:this.maxBytes});
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
        if (!job.deep) return;
        if (!['fb2','epub'].includes(String(book.ext).toLowerCase())) return this.issue(job,book,'skipped','Проверка содержимого доступна для FB2 и EPUB');
        if (Number(entry.size) > this.maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки содержимого'),{code:'AUDIT_LIMIT'});
        const read = async() => {
            if (state.reader?.archiveType === '7z') return state.reader.extractToBuf(name);
            const stream = file ? fs.createReadStream(file) : await state.reader.zip.stream(name);
            const chunks = []; let size = 0;
            try {for await (const chunk of stream) {job.controller.signal.throwIfAborted(); size += chunk.length;
                if (size > this.maxBytes) throw Object.assign(new Error('Файл превышает лимит проверки'),{code:'AUDIT_LIMIT'});
                chunks.push(chunk);}
            } finally {stream.destroy();}
            return Buffer.concat(chunks);
        };
        const data = state.reader?.archiveType === '7z' ? await read() : await runtime.run(read,{kind:'reviews',signal:job.controller.signal});
        if (String(book.ext).toLowerCase() === 'fb2') {
            let xml = data;
            if (data[0] === 0x1f && data[1] === 0x8b) xml = require('zlib').gunzipSync(data,{maxOutputLength:this.maxBytes});
            await runtime.run(() => validateXml(xml,'FictionBook'),{kind:'reviews',signal:job.controller.signal});
        } else {
            const temporary = path.join(this.worker.config.tempDir, `audit-${require('crypto').randomBytes(12).toString('hex')}.epub`);
            const reader = new ZipReader({...this.worker.config,resourceMaxOutputBytes:this.maxBytes});
            try {
                await fs.outputFile(temporary,data); await reader.open(temporary);
                const container = reader.entries['META-INF/container.xml'];
                if (!container || Number(container.size) > 1024 * 1024) throw new Error('Нет корректного META-INF/container.xml');
                const containerData = await reader.extractToBuf('META-INF/container.xml');
                if (containerData.length > 1024 * 1024) throw Object.assign(new Error('Контейнер EPUB превышает лимит проверки'),{code:'AUDIT_LIMIT'});
                const containerXml = validateXml(containerData,'container');
                let packagePath = '';
                const parser = require('sax').parser(true);
                parser.onerror = error => {throw error;};
                parser.onopentag = node => {if (node.name.split(':').pop() === 'rootfile' && !packagePath) packagePath = node.attributes['full-path'] || '';};
                parser.write(containerXml).close();
                if (!packagePath || path.isAbsolute(packagePath) || packagePath.split('/').includes('..') || !reader.entries[packagePath]) throw new Error('Пакет EPUB отсутствует');
                if (Number(reader.entries[packagePath].size) > 4 * 1024 * 1024) throw Object.assign(new Error('Пакет EPUB превышает лимит проверки'),{code:'AUDIT_LIMIT'});
                const packageData = await reader.extractToBuf(packagePath);
                if (packageData.length > 4 * 1024 * 1024) throw Object.assign(new Error('Пакет EPUB превышает лимит проверки'),{code:'AUDIT_LIMIT'});
                validateXml(packageData,'package');
            } finally {await reader.close().catch(() => {}); await fs.remove(temporary);}
        }
    }
    get maxBytes() {return Math.max(1024 * 1024, Number(this.worker.config.auditMaxBookBytes) || 64 * 1024 * 1024);}
}

module.exports = LibraryAudit;
module.exports.validateXml = validateXml;
