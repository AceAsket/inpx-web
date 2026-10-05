const path = require('path');
const fs = require('fs-extra');
const {pipeline} = require('stream/promises');
const yazl = require('yazl');
const ZipReader = require('./ZipReader');

const imageIndexName = 'FLibraryImageIndex.json';
const mimetype = 'application/epub+zip';

function safeEntryName(value) {
    const name = String(value || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f]/.test(name)
        || name.split('/').some(part => part === '..'))
        throw new Error(`Некорректный путь в EPUB: ${name}`);
    const normalized = path.posix.normalize(name);
    if (normalized === '.' || normalized.endsWith('/'))
        throw new Error(`Некорректный путь в EPUB: ${name}`);
    return normalized;
}

async function restore(bookFile, config = {}, loadImage = async() => null) {
    const reader = new ZipReader(config);
    let stagingDir = '';
    try {
        await reader.open(bookFile);
        const entries = Object.values(reader.entries).filter(entry => !entry.isDirectory)
            .map(entry => ({sourceName: entry.name, name: safeEntryName(entry.name)}));
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
        if (reader.archiveType === 'zip' && !indexes.length)
            return false;
        if (indexes.length > 1)
            throw new Error('Несколько индексов изображений EPUB');
        if (!files.has('mimetype') || (await reader.extractToBuf(files.get('mimetype'))).toString().trim() !== mimetype)
            throw new Error('Некорректный mimetype EPUB');

        let imageIndex = [];
        if (indexes.length) {
            try {
                imageIndex = JSON.parse((await reader.extractToBuf(indexes[0].sourceName)).toString());
            } catch (error) {
                throw new Error(`Некорректный индекс изображений EPUB: ${error.message}`);
            }
            if (!Array.isArray(imageIndex))
                throw new Error('Индекс изображений EPUB должен быть массивом');
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

        stagingDir = await fs.mkdtemp(path.join(config.tempDir || path.dirname(bookFile), 'epub-'));
        const staged = new Map();
        for (const [name, sourceName] of files) {
            if (name === 'mimetype' || indexSources.has(sourceName))
                continue;
            const file = path.join(stagingDir, `entry-${staged.size}`);
            await reader.extractToFile(sourceName, file);
            staged.set(name, file);
        }
        for (const image of images) {
            const existing = staged.get(image.name);
            if (existing && (await fs.stat(existing)).size)
                continue;
            const data = await loadImage(image.num, image.name);
            if (!data || !data.length)
                throw new Error(`Не найдено изображение EPUB: ${image.name} (номер ${image.num})`);
            const file = existing || path.join(stagingDir, `entry-${staged.size}`);
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
