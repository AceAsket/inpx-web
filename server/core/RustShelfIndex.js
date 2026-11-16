const {execFile} = require('node:child_process');
const {createHash} = require('node:crypto');
const {access} = require('node:fs/promises');
const {join} = require('node:path');
const runtime = require('./ResourceRuntime');
const {buildShelfIndex} = require('./RustShelfBuild');
const programs = require('./RustPrograms');

function catalogGeneration(config) {
    if (!config?.inpxHash || !config.indexUpdate?.updatedAt)
        return '';
    return createHash('sha256').update(JSON.stringify([
        config.inpxHash, config.indexUpdate.updatedAt, config.dbVersion,
        process.versions.icu, process.versions.tz,
        new Intl.Collator().resolvedOptions().locale, new Intl.DateTimeFormat().resolvedOptions().timeZone,
    ])).digest('hex');
}

function query(executable, indexPath, request, signal) {
    const input = JSON.stringify(request);
    return new Promise((resolve, reject) => {
        const child = execFile(executable, ['shelves', indexPath], {
            windowsHide:true, signal, timeout:runtime.settings.taskTimeoutMs,
        }, (error, stdout) => {
            if (error) {reject(error);return;}
            try {resolve(JSON.parse(stdout));}
            catch (parseError) {reject(parseError);}
        });
        // A process that fails before reading the request is reported by execFile.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

function shelfIndexPath(directory,generation) {return join(directory,`shelves-${generation}.redb`);}

class RustShelfIndex {
    constructor(db,binary,path,generation,managed) {
        Object.assign(this,{db,binary,path,generation,managed,retryAt:0,controller:new AbortController()});
    }

    async select(request) {
        if (this.controller.signal.aborted) return null;
        if (!this.process) {
            try {await access(this.path);}
            catch (error) {
                if (!this.managed || error.code !== 'ENOENT') throw error;
                this.ensureBuild();
                return null;
            }
            if (this.controller.signal.aborted) return null;
            const {RustLookupIndex} = require('./RustLookupIndex');
            this.process ||= new RustLookupIndex(null,null,{binary:this.binary,file:this.path,generation:this.generation,command:'serve-shelves'});
        }
        return this.process.run(process => process.query(request),
            () => query(this.binary,this.path,{...request,generation:this.generation},runtime.signal()));
    }

    ensureBuild() {
        if (this.building || this.controller.signal.aborted || Date.now() < this.retryAt) return;
        const signal = this.controller.signal;
        this.building = runtime.withBackground(() => runtime.run(
            () => buildShelfIndex(this.binary,this.path,this.db,this.generation,signal),{kind:'catalog',signal})).catch(error => {
                this.buildError = error.message;
                this.retryAt = Date.now()+60000;
            }).finally(() => {this.building = null;});
    }

    async close() {
        this.controller.abort();
        await this.process?.close();
        await this.building;
    }
}

async function selectShelfBooks(db,config,request,{directory,executable = programs.executable('catalog'),
    indexPath = process.env.INPX_RUST_CATALOG_INDEX} = {}) {
    if (!executable || (!indexPath && !directory)) return null;
    const generation = catalogGeneration(config);
    if (!generation) return null;
    const target = indexPath || shelfIndexPath(directory,generation);
    let index = db.rustShelfIndex;
    if (!index || index.binary !== executable || index.path !== target || index.generation !== generation) {
        const previous = index;
        index = db.rustShelfIndex = new RustShelfIndex(db,executable,target,generation,!indexPath);
        if (previous) await previous.close();
    }
    const windows = await index.select(request);
    if (windows === null) return null;
    const limits = request.daysWindows.map(() => request.newestLimit);
    if (request.popularLimit > 0) limits.push(request.popularLimit);
    if (!Array.isArray(windows) || windows.length !== limits.length || windows.some((ids, index) =>
        !Array.isArray(ids) || ids.length > limits[index] || ids.some(uid => typeof uid !== 'string' || !uid)))
        throw new Error('Некорректный ответ Rust-индекса полок');

    const ids = [...new Set(windows.flat())];
    if (!ids.length) return windows;
    const rows = db.booksByUids ? await db.booksByUids(ids) : await db.select({table:'book', where:`@@hash('_uid', ${db.esc(ids)})`});
    const books = new Map(rows.map(row => [row._uid,row]));
    if (ids.some(uid => !books.has(uid)))
        throw new Error('Rust-индекс ссылается на книги, которых нет в текущем каталоге');
    return windows.map(shelf => shelf.map(uid => books.get(uid)));
}

module.exports = {catalogGeneration, selectShelfBooks, shelfIndexPath};
