const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');

const express = require('express');
const utils = require('./core/utils');
const ZipReader = require('./core/ZipReader');
const imageUtils = require('./core/ImageUtils');
const bookConverter = require('./core/BookConverter');
const webAppDir = require('../build/appdir');
const externalTools = require('./core/ExternalTools');
const {getEnabledLibrarySources} = require('./core/LibrarySources');
const Fb2Helper = require('./core/fb2/Fb2Helper');

const log = new (require('./core/AppLogger'))().log;//singleton
let coverArchives = null;
let bookArchives = null;
const runtimeWarnings = new Set();
const fb2Helper = new Fb2Helper();

function logRuntimeWarningOnce(message) {
    if (!message || runtimeWarnings.has(message))
        return;

    runtimeWarnings.add(message);
    log(LM_ERR, message);
}

function generateZip(zipFile, dataFile, dataFileInZip) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        zip.addFile(dataFile, dataFileInZip);
        zip.outputStream
            .pipe(fs.createWriteStream(zipFile)).on('error', reject)
            .on('finish', (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
        zip.end();
    });
}

function convertedFileName(downFileName, format) {
    const ext = path.extname(downFileName);
    const base = (ext ? downFileName.slice(0, -ext.length) : downFileName);
    return `${base}.${format}`;
}

function normalizedRawFileName(downFileName, fileType) {
    if (fileType === 'raw' || fileType === undefined)
        return downFileName;

    return downFileName;
}

function normalizeLibraryDir(dir = '') {
    return String(dir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function resolveLibraryAssetDirs(subDir, sourceLibDir, config) {
    const libDir = normalizeLibraryDir(sourceLibDir || config.libDir);
    return Array.from(new Set([
        `${libDir}/${subDir}`,
        `${path.dirname(libDir)}/${subDir}`,
    ]));
}

function libraryToolDirs(sourceLibDir = '', config) {
    const libDir = normalizeLibraryDir(sourceLibDir || config.libDir);
    return Array.from(new Set([
        `${libDir}/bin`,
        `${path.dirname(libDir)}/bin`,
    ]));
}

async function getCoverArchives(config) {
    if (coverArchives && coverArchives.length)
        return coverArchives;

    coverArchives = [];
    for (const source of getEnabledLibrarySources(config)) {
        const coverDirs = resolveLibraryAssetDirs('covers', source.libDir, config);
        for (const coverDir of coverDirs) {
            if (!await fs.pathExists(coverDir))
                continue;

            const files = await fs.readdir(coverDir);
            for (const file of files) {
                const match = file.match(/(\d{4,})-(\d{4,})\.(zip|7z)$/i);
                if (!match)
                    continue;

                coverArchives.push({
                    file: `${coverDir}/${file}`,
                    from: parseInt(match[1], 10),
                    to: parseInt(match[2], 10),
                    sourceId: source.id,
                    sourceLibDir: source.libDir || config.libDir,
                });
            }
        }
    }

    coverArchives.sort((a, b) => a.from - b.from);
    return coverArchives;
}

async function addBookArchivesFromDir(result, dir, source, config) {
    if (!dir || !await fs.pathExists(dir))
        return;

    const files = await fs.readdir(dir);
    for (const file of files) {
        const match = file.match(/(\d{4,})-(\d{4,})\.(zip|7z)$/i);
        if (!match)
            continue;

        result.push({
            file: `${dir}/${file}`,
            from: parseInt(match[1], 10),
            to: parseInt(match[2], 10),
            sourceId: source.id,
            sourceLibDir: source.libDir || config.libDir,
        });
    }
}

async function getBookArchives(config) {
    if (bookArchives && bookArchives.length)
        return bookArchives;

    bookArchives = [];
    for (const source of getEnabledLibrarySources(config)) {
        const libDir = normalizeLibraryDir(source.libDir || config.libDir);
        if (!await fs.pathExists(libDir))
            continue;

        const scanned = new Set();
        const scanDir = async(dir) => {
            const key = path.resolve(dir);
            if (scanned.has(key))
                return;

            scanned.add(key);
            await addBookArchivesFromDir(bookArchives, dir, source, config);
        };

        for (const dir of [libDir, `${libDir}/fb2`, `${libDir}/books`, `${libDir}/archives`])
            await scanDir(dir);

        const entries = await fs.readdir(libDir, {withFileTypes: true});
        for (const entry of entries) {
            if (entry.isDirectory())
                await scanDir(path.join(libDir, entry.name));
        }
    }

    bookArchives.sort((a, b) => a.from - b.from);
    return bookArchives;
}

function coverCacheKey(libid, sourceId = '') {
    const sourceKey = String(sourceId || '').trim().replace(/[^a-z0-9._-]+/gi, '_');
    return sourceKey ? `${sourceKey}-${libid}` : String(libid);
}

function matchingArchivesBySpecificity(archives, libid, sourceId = '') {
    const expectedSourceId = String(sourceId || '').trim();
    return archives
        .filter(item => libid >= item.from && libid <= item.to)
        .filter(item => !expectedSourceId || String(item.sourceId || '').trim() === expectedSourceId)
        .sort((a, b) => {
            const aspan = a.to - a.from;
            const bspan = b.to - b.from;
            if (aspan !== bspan)
                return aspan - bspan;

            return a.from - b.from;
        });
}

function imageCacheExt(contentType = '') {
    if (contentType === 'image/png')
        return '.png';
    if (contentType === 'image/jpeg')
        return '.jpg';
    if (contentType === 'image/gif')
        return '.gif';
    return '';
}

async function sendCachedCover(res, cacheDir, libid, sourceId = '') {
    const cacheKey = coverCacheKey(libid, sourceId);
    for (const item of [
        {ext: '.png', type: 'image/png'},
        {ext: '.jpg', type: 'image/jpeg'},
        {ext: '.gif', type: 'image/gif'},
    ]) {
        const cacheFile = `${cacheDir}/${cacheKey}${item.ext}`;
        if (!await fs.pathExists(cacheFile))
            continue;

        await fs.utimes(cacheFile, new Date(), new Date());
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(item.type);
        res.sendFile(cacheFile);
        return true;
    }

    return false;
}

async function writeCachedCover(cacheDir, libid, cover, sourceId = '') {
    const ext = imageCacheExt(cover.contentType);
    if (!ext)
        return;

    await fs.ensureDir(cacheDir);
    await fs.writeFile(`${cacheDir}/${coverCacheKey(libid, sourceId)}${ext}`, cover.data);
}

function fb2EntryCandidates(zipReader, libid) {
    const id = String(libid);
    return Object.values(zipReader.entries || {})
        .map(entry => Object.assign({}, entry, {name: String(entry.name || '').replace(/\\/g, '/')}))
        .filter(entry => !entry.isDirectory)
        .map(entry => entry.name)
        .filter(name => {
            const base = path.basename(name).toLowerCase();
            return base === `${id}.fb2`
                || base === `${id}.fb2.gz`
                || base === `${id}.fb2.zip`;
        })
        .sort((a, b) => a.length - b.length);
}

async function extractCoverFromFb2Buffer(data, config, sourceLibDir) {
    const tempFile = `${config.tempDir}/${utils.randomHexString(30)}.fb2`;
    try {
        await fs.writeFile(tempFile, data);
        const {cover} = await fb2Helper.getDescAndCover(tempFile);
        if (!cover)
            return null;

        return await imageUtils.normalizeForFb2(cover, config.tempDir, libraryToolDirs(sourceLibDir, config));
    } finally {
        await fs.remove(tempFile);
    }
}

async function extractCoverFromNestedZip(data, config, sourceLibDir, libid) {
    const tempZip = `${config.tempDir}/${utils.randomHexString(30)}.zip`;
    const zipReader = new ZipReader();
    try {
        await fs.writeFile(tempZip, data);
        await zipReader.open(tempZip, true);
        for (const entryName of fb2EntryCandidates(zipReader, libid)) {
            try {
                const nestedData = await zipReader.extractToBuf(entryName);
                const cover = await extractCoverFromFb2Buffer(nestedData, config, sourceLibDir);
                if (cover)
                    return cover;
            } catch(e) {
                // try next matching entry
            }
        }
    } finally {
        await zipReader.close();
        await fs.remove(tempZip);
    }

    return null;
}

async function extractBookCover(libid, config, sourceId = '') {
    const archives = matchingArchivesBySpecificity(await getBookArchives(config), libid, sourceId);
    for (const archive of archives) {
        const zipReader = new ZipReader();
        try {
            await zipReader.open(archive.file, true);
            for (const entryName of fb2EntryCandidates(zipReader, libid)) {
                try {
                    const data = await zipReader.extractToBuf(entryName);
                    const cover = entryName.toLowerCase().endsWith('.zip')
                        ? await extractCoverFromNestedZip(data, config, archive.sourceLibDir, libid)
                        : await extractCoverFromFb2Buffer(data, config, archive.sourceLibDir);

                    if (cover)
                        return cover;
                } catch(e) {
                    // try next matching entry
                }
            }
        } catch(e) {
            if (externalTools.isMissingToolError(e))
                throw e;

            log(LM_WARN, `book cover archive ${archive.file}: ${e.message}`);
        } finally {
            await zipReader.close();
        }
    }

    return null;
}

module.exports = (app, config) => {
    /*
    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;
    */
    app.get(`${config.rootPathStatic || ''}/reader-lab-source/:fileName`, async(req, res) => {
        try {
            const safeFileName = path.basename(String(req.params.fileName || '').trim());
            if (!safeFileName || path.extname(safeFileName).toLowerCase() !== '.fb2') {
                res.sendStatus(404);
                return;
            }

            const sourceFile = path.join(config.libDir, safeFileName);
            if (!await fs.pathExists(sourceFile)) {
                res.sendStatus(404);
                return;
            }

            res.set('Cache-Control', 'no-store');
            res.type('application/xml; charset=utf-8');
            res.sendFile(sourceFile);
        } catch (e) {
            res.sendStatus(404);
        }
    });

    const sendCover = async(req, res, sourceId = '', rawLibid = '') => {
        const libid = parseInt(rawLibid, 10);
        const normalizedSourceId = String(sourceId || '').trim();
        if (!libid) {
            res.sendStatus(404);
            return;
        }

        try {
            const cacheDir = config.coverDir || `${config.publicFilesDir}/cover`;
            if (await sendCachedCover(res, cacheDir, libid, normalizedSourceId))
                return;

            const archives = matchingArchivesBySpecificity(await getCoverArchives(config), libid, normalizedSourceId);
            for (const archive of archives) {
                const zipReader = new ZipReader();
                await zipReader.open(archive.file, false);

                try {
                    let cover = await zipReader.extractToBuf(String(libid));
                    const normalized = await imageUtils.normalizeForFb2(cover, config.tempDir, libraryToolDirs(archive.sourceLibDir, config));
                    cover = normalized.data;
                    let type = normalized.contentType;

                    await writeCachedCover(cacheDir, libid, {data: cover, contentType: type}, archive.sourceId);

                    res.set('Cache-Control', 'public, max-age=2592000, immutable');
                    res.type(type);
                    res.send(cover);
                    return;
                } catch(e) {
                    if (externalTools.isMissingToolError(e)) {
                        throw e;
                    }

                    // try next matching archive
                } finally {
                    await zipReader.close();
                }
            }

            const embeddedCover = await extractBookCover(libid, config, normalizedSourceId);
            if (embeddedCover) {
                await writeCachedCover(cacheDir, libid, embeddedCover, normalizedSourceId);

                res.set('Cache-Control', 'public, max-age=2592000, immutable');
                res.type(embeddedCover.contentType);
                res.send(embeddedCover.data);
                return;
            }

            res.sendStatus(404);
        } catch(e) {
            if (externalTools.isMissingToolError(e)) {
                logRuntimeWarningOnce(e.message);
                res.status(503).type('text/plain; charset=utf-8').send(e.message);
                return;
            }

            res.sendStatus(404);
        }
    };

    app.get(`${config.rootPathStatic || ''}/cover/:sourceId/:libid`, async(req, res) => {
        await sendCover(req, res, req.params.sourceId, req.params.libid);
    });

    app.get(`${config.rootPathStatic || ''}/cover/:libid`, async(req, res) => {
        const libid = parseInt(req.params.libid, 10);
        if (!libid) {
            res.sendStatus(404);
            return;
        }

        await sendCover(req, res, '', req.params.libid);
    });

    //загрузка или восстановление файлов в /public-files, при необходимости
    app.use([`${config.bookPathStatic}/:fileName/:fileType/:downloadName`, `${config.bookPathStatic}/:fileName/:fileType`, `${config.bookPathStatic}/:fileName`], async(req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
        }

        try {
            const fileName = req.params.fileName;
            const fileType = req.params.fileType;

            if (path.extname(fileName) === '') {//восстановление файлов {hash}.raw, {hash}.zip
                let bookFile = `${config.bookDir}/${fileName}`;
                const bookFileDesc = `${bookFile}.d.json`;

                //восстановим из json-файла описания
                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    await utils.touchFile(bookFile);
                    await utils.touchFile(bookFileDesc);

                    let desc = await fs.readFile(bookFileDesc, 'utf8');
                    let downFileName = (JSON.parse(desc)).downFileName;
                    let gzipped = true;

                    if (!req.acceptsEncodings('gzip') || fileType) {
                        const rawFile = `${bookFile}.raw`;
                        //не принимает gzip, тогда распакуем
                        if (!await fs.pathExists(rawFile))
                            await utils.gunzipFile(bookFile, rawFile);

                        gzipped = false;

                        if (fileType === undefined || fileType === 'raw') {
                            bookFile = rawFile;
                            downFileName = normalizedRawFileName(downFileName, fileType);
                        } else if (fileType === 'zip') {
                            //создаем zip-файл
                            bookFile += '.zip';
                            if (!await fs.pathExists(bookFile))
                                await generateZip(bookFile, rawFile, downFileName);
                            downFileName += '.zip';
                        } else if (bookConverter.canConvertTo(fileType)) {
                            if (!bookConverter.canConvertSourceTo(path.extname(downFileName), fileType))
                                throw new Error(`Unsupported convert format: ${path.extname(downFileName) || 'unknown'} -> ${fileType}`);

                            if (!config.conversionEnabled)
                                throw new Error('Book conversion is disabled in this image');

                            bookFile += `.${fileType}`;
                            if (!await fs.pathExists(bookFile))
                                await bookConverter.convert({inputFile: rawFile, outputFile: bookFile, format: fileType, sourceFileName: downFileName});
                            downFileName = convertedFileName(downFileName, fileType);
                        } else {
                            throw new Error(`Unsupported file type: ${fileType}`);
                        }
                    }

                    //отдача файла
                    if (gzipped)
                        res.set('Content-Encoding', 'gzip');
                    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downFileName)}`);
                    res.sendFile(bookFile);
                    return;
                } else {
                    await fs.remove(bookFile);
                    await fs.remove(bookFileDesc);
                }
            }
        } catch(e) {
            log(LM_ERR, e.message);
            if (bookConverter.canConvertTo(req.params.fileType)) {
                res.status(500).send(e.message);
                return;
            }
        }

        return next();
    });

    //иначе просто отдаем запрошенный файл из /public-files
    app.use(config.bookPathStatic, express.static(config.bookDir));

    if (config.rootPathStatic) {
        //подмена rootPath в файлах статики WebApp при необходимости
        app.use(config.rootPathStatic, async(req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                return next();
            }

            try {
                const reqPath = (req.path == '/' ? '/index.html' : req.path);
                const ext = path.extname(reqPath);
                if (ext == '.html' || ext == '.js' || ext == '.css') {
                    const reqFile = `${config.publicDir}${reqPath}`;
                    const flagFile = `${reqFile}.replaced`;

                    if (!await fs.pathExists(flagFile) && await fs.pathExists(reqFile)) {
                        const content = await fs.readFile(reqFile, 'utf8');
                        const re = new RegExp(`/${webAppDir}`, 'g');
                        await fs.writeFile(reqFile, content.replace(re, `${config.rootPathStatic}/${webAppDir}`));
                        await fs.writeFile(flagFile, '');
                    }
                }
            } catch(e) {
                log(LM_ERR, e.message);
            }

            return next();
        });
    }

    //статика файлов WebApp
    const webAppStaticOptions = {
        setHeaders(res, filePath) {
            const fileName = path.basename(filePath).toLowerCase();
            if (['index.html', 'sw.js', 'manifest.webmanifest', 'reader.webmanifest', 'version.txt'].includes(fileName)) {
                res.set('Cache-Control', 'no-store');
                return;
            }

            if (/\.[a-f0-9]{8,}\.(js|css)$/i.test(fileName))
                res.set('Cache-Control', 'public, max-age=2592000, immutable');
        },
    };

    app.use(config.rootPathStatic, express.static(config.publicDir, webAppStaticOptions));
};
