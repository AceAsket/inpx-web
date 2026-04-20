const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');

const express = require('express');
const utils = require('./core/utils');
const ZipReader = require('./core/ZipReader');
const imageUtils = require('./core/ImageUtils');
const bookConverter = require('./core/BookConverter');
const webAppDir = require('../build/appdir');

const log = new (require('./core/AppLogger'))().log;//singleton
let coverArchives = null;

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

async function getCoverArchives(config) {
    if (coverArchives && coverArchives.length)
        return coverArchives;

    const coverDir = `${config.libDir}/covers`;
    if (!await fs.pathExists(coverDir))
        return [];

    coverArchives = [];
    const files = await fs.readdir(coverDir);
    for (const file of files) {
        const match = file.match(/(\d+)-(\d+)\.(zip|7z)$/i);
        if (!match)
            continue;

        coverArchives.push({
            file: `${coverDir}/${file}`,
            from: parseInt(match[1], 10),
            to: parseInt(match[2], 10),
        });
    }

    coverArchives.sort((a, b) => a.from - b.from);
    return coverArchives;
}

function matchingArchivesBySpecificity(archives, libid) {
    return archives
        .filter(item => libid >= item.from && libid <= item.to)
        .sort((a, b) => {
            const aspan = a.to - a.from;
            const bspan = b.to - b.from;
            if (aspan !== bspan)
                return aspan - bspan;

            return a.from - b.from;
        });
}

module.exports = (app, config) => {
    /*
    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;
    */
    app.get(`${config.rootPathStatic || ''}/cover/:libid`, async(req, res) => {
        const libid = parseInt(req.params.libid, 10);
        if (!libid) {
            res.sendStatus(404);
            return;
        }

        try {
            const cacheDir = `${config.publicFilesDir}/cover`;
            const cacheFile = `${cacheDir}/${libid}.png`;
            if (await fs.pathExists(cacheFile)) {
                res.set('Cache-Control', 'public, max-age=2592000, immutable');
                res.type('image/png');
                res.sendFile(cacheFile);
                return;
            }

            const archives = matchingArchivesBySpecificity(await getCoverArchives(config), libid);
            if (!archives.length) {
                res.sendStatus(404);
                return;
            }

            for (const archive of archives) {
                const zipReader = new ZipReader();
                await zipReader.open(archive.file, false);

                try {
                    let cover = await zipReader.extractToBuf(String(libid));
                    let type = imageUtils.contentType(cover);
                    if (type === 'image/jxl') {
                        cover = await imageUtils.jxlToPng(cover, config.tempDir);
                        type = 'image/png';

                        await fs.ensureDir(cacheDir);
                        await fs.writeFile(cacheFile, cover);
                    }

                    res.set('Cache-Control', 'public, max-age=2592000, immutable');
                    res.type(type);
                    res.send(cover);
                    return;
                } catch(e) {
                    // try next matching archive
                } finally {
                    await zipReader.close();
                }
            }

            res.sendStatus(404);
        } catch(e) {
            res.sendStatus(404);
        }
    });

    //загрузка или восстановление файлов в /public-files, при необходимости
    app.use([`${config.bookPathStatic}/:fileName/:fileType`, `${config.bookPathStatic}/:fileName`], async(req, res, next) => {
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
                        } else if (fileType === 'zip') {
                            //создаем zip-файл
                            bookFile += '.zip';
                            if (!await fs.pathExists(bookFile))
                                await generateZip(bookFile, rawFile, downFileName);
                            downFileName += '.zip';
                        } else if (bookConverter.canConvertTo(fileType)) {
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
    app.use(config.rootPathStatic, express.static(config.publicDir));
};
