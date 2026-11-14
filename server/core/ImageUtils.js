const fs = require('fs-extra');
const path = require('path');
const {runProcess, deadline: conversionDeadline} = require('./ConversionRuntime');
const imageRuntime = require('./ImageRuntime');
const resourceRuntime = require('./ResourceRuntime');
const {isResourceError} = require('./ResourcePolicy');

const utils = require('./utils');
const externalTools = require('./ExternalTools');
const jxlContainer = Buffer.from('0000000c4a584c200d0a870a', 'hex');
let nativeImage;

function contentType(buf) {
    if ((buf.length >= 2 && buf[0] == 0xff && buf[1] == 0x0a)
        || buf.subarray(0, jxlContainer.length).equals(jxlContainer))
        return 'image/jxl';

    if (buf.length >= 8 && buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4e && buf[3] == 0x47)
        return 'image/png';

    if (buf.length >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff)
        return 'image/jpeg';

    if (buf.length >= 6 && buf.slice(0, 6).toString() == 'GIF89a')
        return 'image/gif';

    if (buf.length >= 6 && buf.slice(0, 6).toString() == 'GIF87a')
        return 'image/gif';

    if (buf.length >= 12 && buf.slice(0, 4).toString() == 'RIFF' && buf.slice(8, 12).toString() == 'WEBP')
        return 'image/webp';

    return 'application/octet-stream';
}

async function run(command, args, toolCode = '', helpMessage = '') {
    try {
        // Reuse bounded stderr, process-tree termination and the conversion
        // deadline so a stuck native decoder cannot hold a shared slot forever.
        await runProcess(command, args, {resourceKind:'images'});
    } catch (error) {
        error.command = command;
        if (error.code === 'ENOENT' && toolCode && helpMessage)
            throw externalTools.createMissingToolError(toolCode, helpMessage);
        throw error;
    }
}

function shouldSkipToolError(err, command) {
    if (externalTools.isMissingToolError(err))
        return true;

    if (process.platform === 'win32')
        return false;

    const commandText = String(command || (err && err.command) || '');
    const stderr = String((err && (err.stderr || err.message)) || '');
    if (/\.exe$/i.test(commandText))
        return true;

    return /MZ[\s\S]*(?:not found|Syntax error)/i.test(stderr);
}

async function jxlToImage(buf, tempDir, toolDirs = [], converterPaths = null, extension = 'png', maxOutputBytes = 0) {
    return await imageRuntime.run(async() => {
        // The preview path checks the output size on disk before allocating a Buffer.
        if (process.env.INPX_JXL_DECODER === 'native' && !maxOutputBytes) {
            const data = await tryNativeJxl(buf, extension);
            if (data) return data;
        }
        return decodeJxlWithDjxl(buf, tempDir, toolDirs, converterPaths, extension, maxOutputBytes);
    });
}

function loadNativeImage() {
    if (nativeImage === undefined) {
        try {
            nativeImage = process.pkg
                ? module.require(path.join(path.dirname(process.execPath), 'bin', 'inpx-jxl.node'))
                : module.require('@napi-rs/image');
        } catch (_) {
            nativeImage = null;
        }
    }
    return nativeImage;
}

// Preserve byte-for-byte JPEG recovery when the source contains jbrd. Walk
// top-level boxes rather than matching bytes inside the compressed codestream.
function canEncodeJpegNatively(buf) {
    if (!buf.subarray(0, jxlContainer.length).equals(jxlContainer)) return true;
    for (let offset = jxlContainer.length; offset < buf.length;) {
        if (buf.length - offset < 8) return false;
        if (buf.toString('ascii', offset + 4, offset + 8) === 'jbrd') return false;
        let size = buf.readUInt32BE(offset);
        if (size === 0) break;
        if (size === 1) {
            if (buf.length - offset < 16 || buf.readUInt32BE(offset + 8) !== 0) return false;
            size = buf.readUInt32BE(offset + 12);
            if (size < 16) return false;
        }
        if (size < 8 || size > buf.length - offset) return false;
        offset += size;
    }
    return true;
}

async function tryNativeJxl(buf, extension) {
    const png = extension === 'png';
    if (!png && !canEncodeJpegNatively(buf)) return null;
    const image = loadNativeImage();
    if (!image) return null;

    const signal = resourceRuntime.signal();
    const deadline = Math.min(conversionDeadline?.() ?? Infinity, Date.now() + resourceRuntime.settings.taskTimeoutMs);
    const checkDeadline = () => {
        if (signal?.aborted)
            throw Object.assign(new Error('Проверка отменена'), {code:'ABORT_ERR'});
        if (Date.now() >= deadline)
            throw Object.assign(new Error('Превышено время декодирования JXL'), {code:'INPX_CONVERSION_TIMEOUT'});
    };
    try {
        return await resourceRuntime.run(async() => {
            checkDeadline();
            const transformer = new image.Transformer(buf);
            // Keep the slot until native work actually finishes, including when
            // the caller cancels after the decoder has started.
            const data = png
                ? await transformer.png({compressionType:image.CompressionType.Fast, filterType:image.FilterType.Adaptive})
                : await transformer.jpeg(95);
            checkDeadline();
            return contentType(data) === (png ? 'image/png' : 'image/jpeg') ? data : null;
        }, {kind:'images', signal, deadline});
    } catch (error) {
        checkDeadline();
        if (isResourceError(error)) throw error;
        return null;
    }
}

async function readDecodedImage(file, maximum) {
    if (maximum > 0 && (await fs.stat(file)).size > maximum)
        throw Object.assign(new Error('Размер изображения превышает лимит превью'), {code:'INPX_RESOURCE_IMAGE_OUTPUT_LIMIT'});
    return await fs.readFile(file);
}

async function decodeJxlWithDjxl(buf, tempDir, toolDirs, converterPaths, extension, maxOutputBytes) {
    const id = utils.randomHexString(30);
    const inputFile = `${tempDir}/${id}.jxl`;
    const outputFile = `${tempDir}/${id}.${extension}`;

    try {
        await fs.writeFile(inputFile, buf);
        const commands = externalTools.djxlCommandCandidates(toolDirs, converterPaths);
        let lastError = null;

        for (const command of commands) {
            try {
                if (shouldSkipToolError(null, command))
                    continue;

                await run(command, [inputFile, outputFile, '--num_threads=1'], 'INPX_MISSING_DJXL', externalTools.missingDjxlMessage());
                return await readDecodedImage(outputFile, maxOutputBytes);
            } catch (err) {
                lastError = err;
                if (shouldSkipToolError(err, command))
                    continue;

                throw err;
            }
        }

        throw (lastError || externalTools.createMissingToolError('INPX_MISSING_DJXL', externalTools.missingDjxlMessage()));
    } finally {
        await fs.remove(inputFile);
        await fs.remove(outputFile);
    }
}

async function jxlToPng(buf, tempDir, toolDirs = [], converterPaths = null) {
    return await jxlToImage(buf, tempDir, toolDirs, converterPaths);
}

async function normalizeForEpub(buf, fileName, tempDir, toolDirs = [], converterPaths = null) {
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const type = contentType(buf);
    if (type === 'image/jxl') {
        if (!['png', 'jpg', 'jpeg'].includes(extension))
            throw new Error(`Неподдерживаемый формат изображения EPUB: ${fileName}`);
        return await jxlToImage(buf, tempDir, toolDirs, converterPaths, extension);
    }
    if (type === 'image/webp' && extension === 'png')
        return await webpToPng(buf, tempDir, toolDirs, converterPaths);
    return buf;
}

async function webpToPng(buf, tempDir, toolDirs = [], converterPaths = null, maxOutputBytes = 0) {
    return await imageRuntime.run(() => decodeWebp(buf, tempDir, toolDirs, converterPaths, maxOutputBytes));
}

async function decodeWebp(buf, tempDir, toolDirs, converterPaths, maxOutputBytes) {
    const id = utils.randomHexString(30);
    const inputFile = `${tempDir}/${id}.webp`;
    const outputFile = `${tempDir}/${id}.png`;

    try {
        await fs.writeFile(inputFile, buf);
        const commands = externalTools.dwebpCommandCandidates(toolDirs, converterPaths);
        let lastError = null;

        for (const command of commands) {
            try {
                if (shouldSkipToolError(null, command))
                    continue;

                await run(command, [inputFile, '-o', outputFile], 'INPX_MISSING_DWEBP', externalTools.missingDwebpMessage());
                return await readDecodedImage(outputFile, maxOutputBytes);
            } catch (err) {
                lastError = err;
                if (shouldSkipToolError(err, command))
                    continue;

                throw err;
            }
        }

        throw (lastError || externalTools.createMissingToolError('INPX_MISSING_DWEBP', externalTools.missingDwebpMessage()));
    } finally {
        await fs.remove(inputFile);
        await fs.remove(outputFile);
    }
}

async function normalizeForFb2(buf, tempDir, toolDirs = [], converterPaths = null, maxOutputBytes = 0) {
    const type = contentType(buf);
    if (type === 'image/jxl')
        return {data: await jxlToImage(buf, tempDir, toolDirs, converterPaths, 'png', maxOutputBytes), contentType: 'image/png'};
    if (type === 'image/webp')
        return {data: await webpToPng(buf, tempDir, toolDirs, converterPaths, maxOutputBytes), contentType: 'image/png'};

    return {data: buf, contentType: type};
}

module.exports = {
    contentType,
    jxlToPng,
    webpToPng,
    normalizeForFb2,
    normalizeForEpub,
};
