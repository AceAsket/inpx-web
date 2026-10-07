const fs = require('fs-extra');
const path = require('path');
const he = require('he');
const {isUtf8} = require('buffer');
const utils = require('./utils');
const Fb2Helper = require('./fb2/Fb2Helper');
const Fb2Parser = require('./fb2/Fb2Parser');
const XmlParser = require('./xml/XmlParser');
const ZipReader = require('./ZipReader');
const {coverCacheKey} = require('./BookAssets');

function plainText(value = '') {
    return he.decode(String(value ?? '')).replace(/<\s*(?:\/p|br\s*\/?)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

function fb2Metadata(data) {
    const text = new Fb2Helper().checkEncoding(data).toString('utf8');
    const description = text.match(/<description\b[^>]*>[\s\S]*?<\/description>/i);
    if (!description)
        return {};
    const parser = new Fb2Parser();
    parser.fromString(`<FictionBook>${description[0]}</FictionBook>`, {lowerCase: true});
    const info = parser.bookInfo();
    const title = info.titleInfo || {};
    const publication = info.publishInfo || {};
    return {
        description: plainText(title.annotationHtml),
        publisher: plainText(publication.publisher),
        publishedYear: plainText(publication.year),
        isbn: plainText(publication.isbn),
        language: plainText(title.lang),
        tags: plainText(title.keywords).split(/[,;]/).map(value => value.trim()).filter(Boolean),
    };
}

async function epubMetadata(file, config) {
    const reader = new ZipReader(config);
    try {
        await reader.open(file);
        const names = Object.values(reader.entries).filter(entry => !entry.isDirectory).map(entry => entry.name);
        const containerName = names.find(name => /(^|\/)META-INF\/container\.xml$/i.test(name));
        if (!containerName)
            return {};
        const container = new XmlParser();
        container.fromString((await reader.extractToBuf(containerName)).toString('utf8'), {lowerCase: true});
        const rootfile = container.$$('/rootfiles/rootfile');
        const packagePath = rootfile && (rootfile.attrs() || {})['full-path'];
        if (!packagePath)
            return {};
        const prefix = containerName.slice(0, -'META-INF/container.xml'.length);
        const name = path.posix.normalize(`${prefix}${packagePath}`);
        if (!names.includes(name))
            return {};
        const parser = new XmlParser();
        parser.fromString((await reader.extractToBuf(name)).toString('utf8'), {lowerCase: true});
        const metadata = parser.$$('/metadata/');
        if (!metadata)
            return {};
        const children = metadata.$$array('*NODE');
        const localName = node => node.selectFirstSelf().name.split(':').pop();
        const values = key => children.filter(node => localName(node) === key)
            .map(node => node.text()).filter(Boolean);
        const identifiers = children.filter(node => localName(node) === 'identifier');
        const isbn = identifiers.find(node => /isbn/i.test((node.attrs() || {})['opf:scheme'] || '') || /^urn:isbn:/i.test(node.text()));
        const year = (values('date')[0] || '').match(/\b\d{4}\b/);
        return {
            description: plainText(values('description').join('\n\n')),
            publisher: plainText(values('publisher')[0]),
            publishedYear: year ? year[0] : '',
            isbn: isbn ? plainText(isbn.text()).replace(/^urn:isbn:/i, '') : '',
            language: plainText(values('language')[0]),
            tags: values('subject').map(value => plainText(value)),
        };
    } finally {
        await reader.close();
    }
}

class BookMetadata {
    constructor(worker) {
        this.worker = worker;
        this.cache = new Map();
        this.pending = new Map();
        this.pendingCovers = new Map();
        this.active = 0;
        this.queue = [];
    }

    async run(task) {
        if (this.active >= 2) {
            if (this.queue.length >= 16)
                throw Object.assign(new Error('Metadata queue is full'), {status: 429});
            await new Promise(resolve => this.queue.push(resolve));
        } else {
            this.active++;
        }
        try {
            return await task();
        } finally {
            const next = this.queue.shift();
            if (next) next();
            else this.active--;
        }
    }

    async read(book) {
        const key = `${this.worker.libraryAssetGeneration || 0}:${coverCacheKey(book)}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.time < 15 * 60 * 1000)
            return cached.value;
        if (!this.pending.has(key)) {
            this.pending.set(key, this.run(async() => {
                let file;
                let value = {};
                try {
                    if (!['fb2', 'epub'].includes(String(book.ext).toLowerCase()) || this.worker.remoteLib)
                        return value;
                    file = await this.worker.extractBook(book.folder, `${book.file}.${book.ext}`, book.sourceLibDir);
                    if (String(book.ext).toLowerCase() === 'fb2') {
                        // Description precedes the body and binary images. Do not
                        // parse or restore the entire book for a metadata search.
                        const handle = await fs.open(file, 'r');
                        try {
                            const buffer = Buffer.alloc(2 * 1024 * 1024);
                            const {bytesRead} = await fs.read(handle, buffer, 0, buffer.length, 0);
                            let data = buffer.subarray(0, bytesRead);
                            // A bounded prefix may end inside a UTF-8 character.
                            for (let cut = 0; cut <= 3; cut++) {
                                if (isUtf8(data.subarray(0, data.length - cut))) {
                                    data = data.subarray(0, data.length - cut);
                                    break;
                                }
                            }
                            value = fb2Metadata(data);
                        } finally {
                            await fs.close(handle);
                        }
                    } else {
                        value = await epubMetadata(file, this.worker.config);
                    }
                } catch (error) {
                    // A missing/corrupt book must not hide valid index matches.
                    value = {};
                } finally {
                    if (file) await fs.remove(file);
                }
                if (this.cache.size >= 200)
                    this.cache.delete(this.cache.keys().next().value);
                this.cache.set(key, {time: Date.now(), value});
                return value;
            }).finally(() => this.pending.delete(key)));
        }
        return this.pending.get(key);
    }

    async cover(book) {
        const key = coverCacheKey(book);
        if (!this.pendingCovers.has(key)) {
            this.pendingCovers.set(key, this.run(async() => {
                const config = this.worker.config;
                const dir = config.coverDir || path.join(config.publicFilesDir, 'cover');
                const formats = [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.gif', 'image/gif']];
                for (const [extension, contentType] of formats) {
                    const file = path.join(dir, key + extension);
                    if (await fs.pathExists(file)) {
                        await utils.touchFile(file);
                        return {contentType, data: await fs.readFile(file)};
                    }
                }
                const cover = await this.worker.getBookCover(book);
                if (cover) {
                    const format = formats.find(item => item[1] === cover.contentType);
                    if (format) {
                        await fs.ensureDir(dir);
                        await utils.prepareCachedFile(path.join(dir, key + format[0]), file => fs.writeFile(file, cover.data));
                    }
                }
                return cover;
            }).finally(() => this.pendingCovers.delete(key)));
        }
        return this.pendingCovers.get(key);
    }
}

module.exports = {BookMetadata, fb2Metadata, epubMetadata, plainText};
