const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {writeFileAtomic} = require('./FilePersistence');
const InpxParser = require('./InpxParser');
const Fb2Parser = require('./fb2/Fb2Parser');
const Fb2Helper = require('./fb2/Fb2Helper');
const {epubMetadata} = require('./BookMetadata');

// Never follow directory symlinks; a failed scan must not erase a source from the index.
async function inventory(root) {
    const files = [], directories = [root];
    while (directories.length) {
        const dir = directories.pop();
        const entries = await fs.readdir(dir, {withFileTypes: true});
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) directories.push(file);
            else if (entry.isFile() && /\.(fb2|epub)$/i.test(entry.name)) {
                const stat = await fs.stat(file);
                files.push({relative: path.relative(root, file).replace(/\\/g, '/'), size: stat.size, modified: stat.mtimeMs});
            }
        }
    }
    return files.sort((a, b) => a.relative.localeCompare(b.relative));
}
async function fingerprint(source) {
    const files = await inventory(source.libDir);
    return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
async function metadata(file, ext, config) {
    if (ext === 'epub') {
        const info = await epubMetadata(file, config);
        return {title: info.title, author: (info.authors || []).join(','), lang: info.language, keywords: (info.tags || []).join(',')};
    }
    const handle = await fs.open(file, 'r');
    let data;
    try {
        data = Buffer.alloc(2 * 1024 * 1024);
        const result = await fs.read(handle, data, 0, data.length, 0);
        data = new Fb2Helper().checkEncoding(data.subarray(0, result.bytesRead));
    } finally { await fs.close(handle); }
    const description = data.toString('utf8').match(/<description\b[^>]*>[\s\S]*?<\/description>/i);
    if (!description) throw new Error(`Не найдены метаданные FB2: ${file}`);
    const parser = new Fb2Parser();
    parser.fromString(`<FictionBook>${description[0]}</FictionBook>`, {lowerCase: true});
    const info = parser.bookInfo().titleInfo || {};
    return {title: info.bookTitle, author: (info.author || []).join(','), genre: (info.genre || []).join(','),
        lang: info.lang, keywords: info.keywords, series: (info.sequence || [])[0]?.name || '', serno: Number((info.sequence || [])[0]?.num) || 0};
}
class FolderIndexer {
    constructor(source, config) {
        this.source = source; this.config = config;
        const parser = new InpxParser();
        this.info = {collection: source.name, version: '', structure: 'folder', recStruct: parser.getRecStruct('AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS'.toLowerCase().split(';'))};
    }
    async parse(unused, onFile, onRecords) {
        const root = this.source.libDir;
        const cacheFile = path.join(this.config.dataDir, 'folder-index', `${this.source.id}.json`);
        let previous = {};
        try { previous = await fs.readJson(cacheFile); } catch { /* First scan. */ }
        const files = await inventory(root), next = {}, chunk = [];
        await onFile({totalFiles: files.length});
        let current = 0;
        for (const file of files) {
            const ext = path.extname(file.relative).slice(1).toLowerCase();
            const old = previous[file.relative];
            let record;
            if (old && old.size === file.size && old.modified === file.modified) record = old.record;
            else {
                const info = await metadata(path.join(root, file.relative), ext, this.config);
                record = {author: '', title: path.basename(file.relative, `.${ext}`), genre: '', series: '', serno: 0,
                    lang: '', keywords: '', librate: 0, del: 0, insno: 0, ...info,
                    folder: path.posix.dirname(file.relative), file: path.posix.basename(file.relative).slice(0, -(ext.length + 1)),
                    ext, size: file.size, libid: '', date: new Date(file.modified).toISOString().slice(0, 10),
                    _uid: crypto.createHash('sha256').update(`folder:${this.source.id}:${root}:${file.relative}`).digest('base64')};
                record.title = String(info.title || '').trim() || path.basename(file.relative).slice(0, -(ext.length + 1));
                for (const field of ['author', 'genre', 'series', 'lang', 'keywords']) record[field] = String(record[field] || '');
            }
            next[file.relative] = {...file, record: {...record}};
            chunk.push({...record});
            await onFile({fileName: file.relative, current: ++current});
            if (chunk.length >= 1000) { await onRecords(chunk.splice(0)); await new Promise(resolve => setImmediate(resolve)); }
        }
        if (chunk.length) await onRecords(chunk);
        await fs.ensureDir(path.dirname(cacheFile));
        await writeFileAtomic(cacheFile, JSON.stringify(next));
    }
}
module.exports = {FolderIndexer, inventory, fingerprint, metadata};
