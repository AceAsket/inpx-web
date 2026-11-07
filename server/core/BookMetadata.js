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
const {MemoryCache} = require('./MemoryCache');

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
    const reader = new ZipReader({...config, resourceMaxOutputBytes:4 * 1024 * 1024});
    try {
        await reader.open(file);
        const entries = new Map(Object.values(reader.entries).filter(entry => !entry.isDirectory && !entry.isLink).map(entry => [entry.name, entry]));
        const names = [...entries.keys()];
        const read = async(name, maximum) => {
            if (Number(entries.get(name)?.size) > maximum) throw new Error('Метаданные EPUB превышают лимит');
            if (reader.archiveType === '7z') {
                reader.maxOutputBytes = maximum;
                const data = await reader.extractToBuf(name);
                if (data.length > maximum) throw new Error('Метаданные EPUB превышают лимит');
                return data;
            }
            const stream = await reader.zip.stream(name), chunks = [];
            let bytes = 0;
            try {
                for await (const chunk of stream) {
                    bytes += chunk.length;
                    if (bytes > maximum) throw new Error('Метаданные EPUB превышают лимит');
                    chunks.push(chunk);
                }
            } finally {stream.destroy();}
            return Buffer.concat(chunks);
        };
        const containerName = names.find(name => /(^|\/)META-INF\/container\.xml$/i.test(name));
        if (!containerName)
            return {};
        const container = new XmlParser();
        container.fromString((await read(containerName, 1024 * 1024)).toString('utf8'), {lowerCase: true});
        const rootfile = container.$$('/rootfiles/rootfile');
        const packagePath = rootfile && (rootfile.attrs() || {})['full-path'];
        if (!packagePath)
            return {};
        const prefix = containerName.slice(0, -'META-INF/container.xml'.length);
        const name = path.posix.normalize(`${prefix}${packagePath}`);
        if (!names.includes(name))
            return {};
        const parser = new XmlParser();
        parser.fromString((await read(name, 4 * 1024 * 1024)).toString('utf8'), {lowerCase: true});
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
            title: plainText(values('title')[0]),
            authors: values('creator').map(value => plainText(value)),
            description: plainText(values('description').join('\n\n')),
            publisher: plainText(values('publisher')[0]),
            publishedYear: year ? year[0] : '',
            isbn: isbn ? plainText(isbn.text()).replace(/^urn:isbn:/i, '') : '',
            isbns: [...new Set(identifiers.flatMap(node => require('../../shared/Isbn').extract(plainText(node.text()))))],
            language: plainText(values('language')[0]),
            tags: values('subject').map(value => plainText(value)),
        };
    } finally {
        await reader.close();
    }
}

async function isbnFromData(data, ext, config, maxBytes) {
    const {extract} = require('../../shared/Isbn');
    if (String(ext).toLowerCase() === 'fb2') {
        if (data[0] === 0x1f && data[1] === 0x8b) data = require('zlib').gunzipSync(data,{maxOutputLength:maxBytes});
        return extract(fb2Metadata(data).isbn);
    }
    const file = path.join(config.tempDir, `isbn-${require('crypto').randomBytes(12).toString('hex')}.epub`);
    try {
        await fs.outputFile(file,data);
        const info = await epubMetadata(file,{...config,resourceMaxOutputBytes:Math.min(maxBytes,4 * 1024 * 1024)});
        return info.isbns || extract(info.isbn);
    } finally {await fs.remove(file);}
}

class BookMetadata {
    constructor(worker) {
        this.worker = worker;
        this.cache = new MemoryCache({bytes:8 * 1024 ** 2, entries:200, ttl:15 * 60 * 1000});
        this.generation = worker.libraryAssetGeneration || 0;
        this.coverEpoch = require('crypto').randomBytes(12).toString('hex');
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
        const generation = this.worker.libraryAssetGeneration || 0;
        if (generation !== this.generation) {this.generation = generation; this.cache.clear();}
        const key = `${generation}:${coverCacheKey(book)}`;
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
                if (generation === (this.worker.libraryAssetGeneration || 0))
                    this.cache.set(key, {time: Date.now(), value});
                return value;
            }).finally(() => this.pending.delete(key)));
        }
        return this.pending.get(key);
    }

    async cover(book) {
        const generation = this.worker.libraryAssetGeneration || 0;
        const coverGeneration = this.worker.coverCacheGeneration || 0;
        // Reindexing may change sidecar images without changing the INPX row.
        const key = `${coverCacheKey(book)}-abs-${this.coverEpoch}-${generation}-${coverGeneration}`;
        const obsolete = () => generation !== (this.worker.libraryAssetGeneration || 0)
            || coverGeneration !== (this.worker.coverCacheGeneration || 0);
        const checkGeneration = () => {
            if (obsolete())
                throw Object.assign(new Error('Библиотека обновлена. Повторите загрузку обложки.'), {code:'INPX_LIBRARY_CHANGED', status:503});
        };
        if (!this.pendingCovers.has(key)) {
            this.pendingCovers.set(key, this.run(async() => {
                checkGeneration();
                const config = this.worker.config;
                const dir = config.coverDir || path.join(config.publicFilesDir, 'cover');
                const formats = [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.gif', 'image/gif']];
                for (const [extension, contentType] of formats) {
                    const file = path.join(dir, key + extension);
                    if (await fs.pathExists(file)) {
                        await utils.touchFile(file);
                        const data = await fs.readFile(file);
                        checkGeneration();
                        return {contentType, data};
                    }
                }
                const cover = await this.worker.getBookCover(book);
                checkGeneration();
                if (cover) {
                    const format = formats.find(item => item[1] === cover.contentType);
                    if (format) {
                        await fs.ensureDir(dir);
                        const cachedFile = path.join(dir, key + format[0]);
                        try {
                            await utils.prepareCachedFile(cachedFile, async file => {
                                checkGeneration(); await fs.writeFile(file, cover.data); checkGeneration();
                            });
                            checkGeneration();
                        } catch (error) {
                            if (obsolete()) await fs.remove(cachedFile).catch(() => {});
                            throw error;
                        }
                    }
                }
                return cover;
            }).finally(() => this.pendingCovers.delete(key)));
        }
        return this.pendingCovers.get(key);
    }
}

module.exports = {BookMetadata, fb2Metadata, epubMetadata, plainText, isbnFromData};
