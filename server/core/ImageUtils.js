const fs = require('fs-extra');
const {spawn} = require('child_process');

const utils = require('./utils');
const externalTools = require('./ExternalTools');

function contentType(buf) {
    if (buf.length >= 2 && buf[0] == 0xff && buf[1] == 0x0a)
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

function run(command, args, toolCode = '', helpMessage = '') {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']});
        let stderr = '';

        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('error', (err) => {
            err.command = command;
            if (err && err.code === 'ENOENT' && toolCode && helpMessage) {
                reject(externalTools.createMissingToolError(toolCode, helpMessage));
                return;
            }

            reject(err);
        });
        child.on('close', code => {
            if (code === 0)
                resolve();
            else {
                const err = new Error(`${command} failed with exit code ${code}: ${stderr.trim()}`);
                err.command = command;
                err.stderr = stderr;
                reject(err);
            }
        });
    });
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

async function jxlToPng(buf, tempDir, toolDirs = [], converterPaths = null) {
    const id = utils.randomHexString(30);
    const inputFile = `${tempDir}/${id}.jxl`;
    const outputFile = `${tempDir}/${id}.png`;

    try {
        await fs.writeFile(inputFile, buf);
        const commands = externalTools.djxlCommandCandidates(toolDirs, converterPaths);
        let lastError = null;

        for (const command of commands) {
            try {
                if (shouldSkipToolError(null, command))
                    continue;

                await run(command, [inputFile, outputFile], 'INPX_MISSING_DJXL', externalTools.missingDjxlMessage());
                return await fs.readFile(outputFile);
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

async function webpToPng(buf, tempDir, toolDirs = [], converterPaths = null) {
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
                return await fs.readFile(outputFile);
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

async function normalizeForFb2(buf, tempDir, toolDirs = [], converterPaths = null) {
    const type = contentType(buf);
    if (type === 'image/jxl')
        return {data: await jxlToPng(buf, tempDir, toolDirs, converterPaths), contentType: 'image/png'};
    if (type === 'image/webp')
        return {data: await webpToPng(buf, tempDir, toolDirs, converterPaths), contentType: 'image/png'};

    return {data: buf, contentType: type};
}

module.exports = {
    contentType,
    jxlToPng,
    webpToPng,
    normalizeForFb2,
};
