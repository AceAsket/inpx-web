const path = require('path');
const fs = require('fs-extra');
const {Transform} = require('node:stream');
const {pipeline} = require('stream/promises');
const {crc32} = require('node:zlib');
const yazl = require('yazl');
const ZipReader = require('./ZipReader');

const imageIndexName = 'FLibraryImageIndex.json';
const mimetype = 'application/epub+zip';
const MiB = 1024 ** 2;
const archiveLimit = 512 * MiB;
const entryLimit = 128 * MiB;
const imageLimit = 64 * MiB;
const metadataLimit = 4 * MiB;
const entryCountLimit = 20000;

function sizeError() {
    return Object.assign(new Error('Превышен лимит распаковки EPUB'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
}

function safeEntryName(value) {
    const name = String(value || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!name || name.startsWith('/') || /[:\x00-\x1f]/.test(name)
        || name.split('/').some(part => part === '..'))
        throw new Error(`Некорректный путь в EPUB: ${name}`);
    const normalized = path.posix.normalize(name);
    if (normalized === '.' || normalized.endsWith('/'))
        throw new Error(`Некорректный путь в EPUB: ${name}`);
    return normalized;
}

function safeArchiveEntry(entry) {
    if (entry.isLink)
        throw new Error(`Ссылка внутри EPUB: ${entry.name}`);
    const rawName = entry.isDirectory ? entry.name.replace(/[\\/]+$/, '') : entry.name;
    return {...entry, sourceName: entry.name, name: safeEntryName(rawName)};
}

// 7-Zip emits solid archives in listing order. Write the bounded concatenated
// stream to a private file, split by size, and verify CRCs before publication.
async function unpackSolid(reader, entries, directory, bytes) {
    const streamFile = path.join(directory, 'stream');
    const files = new Map();
    await reader.extractArchiveStream(streamFile, Math.max(1, bytes));
    if ((await fs.stat(streamFile)).size !== bytes) throw new Error('Неверный размер распакованного EPUB');
    let offset = 0;
    for (const entry of entries) {
        const file = path.join(directory, `solid-${files.size}`);
        if (entry.size) {
            let checksum = 0;
            await pipeline(fs.createReadStream(streamFile, {start:offset, end:offset + entry.size - 1}),
                new Transform({transform(chunk, encoding, callback) {
                    checksum = crc32(chunk, checksum);
                    callback(null, chunk);
                }}), fs.createWriteStream(file));
            if (!/^[\da-f]{8}$/i.test(entry.crc || '') || checksum !== parseInt(entry.crc, 16))
                throw new Error('Неверный CRC файла EPUB');
        } else {
            await fs.writeFile(file, '');
        }
        offset += entry.size;
        files.set(entry.sourceName, file);
    }
    await fs.remove(streamFile);
    return files;
}

async function restore(bookFile, config = {}, loadImage = async() => null, prepareImages = null) {
    const reader = new ZipReader({...config, resourceMaxListingBytes:16 * MiB, resourceMaxOutputBytes:entryLimit});
    let stagingDir = '';
    try {
        await reader.open(bookFile);
        const listed = Object.values(reader.uses7z && reader.archiveType === 'zip' ? await reader.listWith7z() : reader.entries);
        if (listed.length > entryCountLimit) throw sizeError();
        const validated = listed.map(safeArchiveEntry);
        const entries = validated.filter(entry => !entry.isDirectory);
        const entriesBySource = new Map(entries.map(entry => [entry.sourceName, entry]));
        const containers = entries.filter(entry => entry.name === 'META-INF/container.xml'
            || entry.name.endsWith('/META-INF/container.xml'));
        if (containers.length !== 1)
            throw new Error('EPUB должен содержать один META-INF/container.xml');
        const prefix = containers[0].name.slice(0, -'META-INF/container.xml'.length);
        const files = new Map();
        for (const entry of entries) {
            if (!entry.name.startsWith(prefix))
                continue;
            const name = entry.name.slice(prefix.length);
            if (files.has(name))
                throw new Error(`Повторяющийся файл в EPUB: ${name}`);
            files.set(name, entry.sourceName);
        }
        // Heimdall stores this sidecar at the archive root while EPUB files
        // live under a book-id directory. Search the whole container.
        const indexes = entries.filter(entry => path.posix.basename(entry.name).toLowerCase() === imageIndexName.toLowerCase());
        const indexSources = new Set(indexes.map(entry => entry.sourceName));
        const indexNames = indexes.map(entry => entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name);
        if (reader.archiveType === 'zip' && !reader.uses7z && !indexes.length)
            return false;
        if (indexes.length > 1)
            throw new Error('Несколько индексов изображений EPUB');

        let bytes = 0;
        for (const entry of entries) {
            const limit = indexSources.has(entry.sourceName) || entry.name === containers[0].name || entry.name === prefix + 'mimetype'
                ? metadataLimit : entryLimit;
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limit || (bytes += entry.size) > archiveLimit) throw sizeError();
        }
        stagingDir = await fs.mkdtemp(path.join(config.tempDir || path.dirname(bookFile), 'epub-'));
        let extracted = null;
        if (reader.uses7z) {
            const seen = new Set();
            for (const entry of validated) {
                const key = entry.name.toLowerCase();
                if (seen.has(key))
                    throw new Error(`Повторяющийся путь в EPUB: ${entry.name}`);
                seen.add(key);
            }
            extracted = await unpackSolid(reader, entries, stagingDir, bytes);
        }
        const readEntry = async(name) => {
            if (extracted) return await fs.readFile(extracted.get(name));
            // Use counted file extraction and a small bound for parseable metadata.
            const file = path.join(stagingDir, 'metadata');
            try {await reader.extractToFile(name, file, metadataLimit); return await fs.readFile(file);}
            finally {await fs.remove(file);}
        };
        if (!files.has('mimetype') || (await readEntry(files.get('mimetype'))).toString().trim() !== mimetype)
            throw new Error('Некорректный mimetype EPUB');

        let imageIndex = [];
        if (indexes.length) {
            try {
                imageIndex = JSON.parse((await readEntry(indexes[0].sourceName)).toString());
            } catch (error) {
                throw new Error(`Некорректный индекс изображений EPUB: ${error.message}`);
            }
            if (!Array.isArray(imageIndex))
                throw new Error('Индекс изображений EPUB должен быть массивом');
            if (imageIndex.length + entries.length > entryCountLimit) throw sizeError();
        }
        const imageNames = new Set();
        const images = imageIndex.map(item => {
            if (!item || typeof item.id !== 'string' || !Number.isInteger(item.num) || item.num < -1)
                throw new Error('Некорректная запись индекса изображений EPUB');
            let name = safeEntryName(item.id);
            if (prefix && name.startsWith(prefix))
                name = name.slice(prefix.length);
            if (imageNames.has(name) || ['mimetype', 'META-INF/container.xml', ...indexNames].includes(name))
                throw new Error(`Некорректное имя изображения EPUB: ${name}`);
            imageNames.add(name);
            return {name, num: item.num};
        });

        const staged = new Map();
        for (const [name, sourceName] of files) {
            if (name === 'mimetype' || indexSources.has(sourceName))
                continue;
            const file = extracted ? extracted.get(sourceName) : path.join(stagingDir, `entry-${staged.size}`);
            if (!extracted)
                await reader.extractToFile(sourceName, file, entriesBySource.get(sourceName).size || 1);
            staged.set(name, file);
        }
        const missingImages = [];
        for (const image of images) {
            const existing = staged.get(image.name);
            if (!existing || !(await fs.stat(existing)).size)
                missingImages.push(image);
        }
        if (prepareImages && missingImages.length >= 3)
            await prepareImages(missingImages);
        for (const image of missingImages) {
            const data = await loadImage(image.num, image.name);
            if (!data || !data.length)
                throw new Error(`Не найдено изображение EPUB: ${image.name} (номер ${image.num})`);
            if (data.length > imageLimit || (bytes += data.length) > archiveLimit) throw sizeError();
            const file = staged.get(image.name) || path.join(stagingDir, `entry-${staged.size}`);
            await fs.writeFile(file, data);
            staged.set(image.name, file);
        }

        const outputFile = path.join(stagingDir, 'restored.epub');
        const zip = new yazl.ZipFile();
        zip.on('error', error => zip.outputStream.destroy(error));
        const complete = pipeline(zip.outputStream, fs.createWriteStream(outputFile));
        const options = {mtime: new Date('2000-01-01T00:00:00Z')};
        zip.addBuffer(Buffer.from(mimetype), 'mimetype', {...options, compress: false});
        for (const name of [...staged.keys()].sort())
            zip.addFile(staged.get(name), name, options);
        zip.end();
        await complete;
        await reader.close();
        await fs.move(outputFile, bookFile, {overwrite: true});
        return true;
    } finally {
        await reader.close();
        if (stagingDir)
            await fs.remove(stagingDir);
    }
}

module.exports = {restore};
