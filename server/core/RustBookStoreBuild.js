const fs = require('fs-extra');
const {join} = require('node:path');
const RustTableBuilder = require('./RustTableBuilder');
const {encodeBook} = require('./BookSearchProjection');

const BASE = 'books.redb', PATCH = 'books-patch.redb', MARKER = 'books-store.json';

function writeStoreMarker(directory, generation) {return fs.writeJson(join(directory,MARKER),{generation});}

async function preparePatch(directory, previousPath) {
    if (!previousPath || !await fs.pathExists(join(previousPath,MARKER))) return null;
    const {generation} = await fs.readJson(join(previousPath,MARKER));
    if (typeof generation !== 'string' || !generation) throw new Error('Invalid previous book store generation');
    const base = join(previousPath,BASE), patch = join(previousPath,PATCH);
    const hasPatch = await fs.pathExists(patch);
    if (hasPatch && (await fs.stat(patch)).size > (await fs.stat(base)).size / 4) return null;
    try {await fs.link(base,join(directory,BASE));}
    catch (error) {
        if (!['EPERM','EXDEV','ENOTSUP','ENOSYS','EACCES'].includes(error.code)) throw error;
        await fs.copyFile(base,join(directory,BASE),fs.constants.COPYFILE_EXCL);
    }
    if (hasPatch) await fs.copyFile(patch,join(directory,PATCH),fs.constants.COPYFILE_EXCL);
    return generation;
}

class RustBookStoreBuild {
    static async openPatch(binary,directory,generation,previousPath) {
        const previous = await preparePatch(directory,previousPath);
        return previous ? this.open(binary,directory,generation,previous) : null;
    }

    static async open(binary,directory,generation,previous = null) {
        const writer = await RustTableBuilder.open(binary,directory,'build-store');
        try {
            await writer.append([JSON.stringify({generation,previous}) + '\n']);
            return new RustBookStoreBuild(writer,directory,generation);
        } catch (error) {
            await writer.close();
            throw error;
        }
    }

    constructor(writer,directory,generation) {
        Object.assign(this,{writer,directory,generation,count:0});
    }

    async add(rows) {
        await this.writer.append(rows.map(encodeBook));
        this.count += rows.length;
    }

    async remove(ids) {
        await this.writer.append(ids.map(id => `remove ${id}\n`));
        this.count += ids.length;
    }

    async finish() {
        await this.writer.finish(this.count);
        await writeStoreMarker(this.directory,this.generation);
    }

    close() {return this.writer.close();}
}

async function exportBooks(store,db) {
    const token = 'rust-store-export';
    try {
        for (;;) {
            const [{rawResult:rows}] = await db.select({table:'book', rawResult:true, where:`
                let cursor=@getItem('${token}');
                if (!cursor) {cursor=@all(); @setItem('${token}',cursor);}
                const rows=[];
                while (rows.length<2048) {
                    const next=cursor.next();
                    if (next.done) break;
                    rows.push(@unsafeRow(next.value));
                }
                return rows;
            `});
            if (!rows.length) break;
            await store.add(rows);
        }
    } finally {
        await db.select({table:'book',rawResult:true,where:`@delItem('${token}'); return true;`});
    }
}

module.exports = {RustBookStoreBuild, exportBooks, preparePatch, writeStoreMarker};
