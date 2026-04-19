const fs = require('fs-extra');
const {spawn} = require('child_process');

const utils = require('./utils');

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

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']});
        let stderr = '';

        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('error', reject);
        child.on('close', code => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim()}`));
        });
    });
}

async function jxlToPng(buf, tempDir) {
    const id = utils.randomHexString(30);
    const inputFile = `${tempDir}/${id}.jxl`;
    const outputFile = `${tempDir}/${id}.png`;

    try {
        await fs.writeFile(inputFile, buf);
        await run('djxl', [inputFile, outputFile]);
        return await fs.readFile(outputFile);
    } finally {
        await fs.remove(inputFile);
        await fs.remove(outputFile);
    }
}

async function normalizeForFb2(buf, tempDir) {
    const type = contentType(buf);
    if (type === 'image/jxl')
        return {data: await jxlToPng(buf, tempDir), contentType: 'image/png'};

    return {data: buf, contentType: type};
}

module.exports = {
    contentType,
    jxlToPng,
    normalizeForFb2,
};
