const fs = require('node:fs/promises');
const path = require('node:path');

const maxInputBytes = 64 * 1024 ** 2;
const maxOutputBytes = 128 * 1024 ** 2;
const maxPixels = 32 * 1024 ** 2;
const maxDimension = 16384;
const workerFlag = '--inpx-native-jxl-worker';
const sizeExit = 42;

function sizeError() {
    return Object.assign(new Error('Изображение JXL превышает лимит размера'), {code:'INPX_RESOURCE_IMAGE_OUTPUT_LIMIT'});
}

async function decode(input, extension, image) {
    if (input.length > maxInputBytes) throw sizeError();
    const transformer = new image.Transformer(input);
    const {width, height} = await transformer.metadata(false);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || width > maxDimension || height > maxDimension || width * height > maxPixels) throw sizeError();
    const decoded = extension === 'png' ? await transformer.png({compressionType:image.CompressionType.Fast,
        filterType:image.FilterType.Adaptive}) : await transformer.jpeg(95);
    if (decoded.length > maxOutputBytes) throw sizeError();
    return decoded;
}

async function runWorker([inputFile, extension]) {
    try {
        if (!inputFile || !['png', 'jpg', 'jpeg'].includes(extension)) throw new Error('Invalid native decoder arguments');
        if ((await fs.stat(inputFile)).size > maxInputBytes) throw sizeError();
        const image = process.pkg ? module.require(path.join(path.dirname(process.execPath), 'bin', 'inpx-jxl.node'))
            : module.require('@napi-rs/image');
        const decoded = await decode(await fs.readFile(inputFile), extension, image);
        await new Promise((resolve, reject) => process.stdout.write(decoded, error => error ? reject(error) : resolve()));
    } catch (error) {
        process.exitCode = error.code === 'INPX_RESOURCE_IMAGE_OUTPUT_LIMIT' ? sizeExit : 1;
    }
}

if (require.main === module) void runWorker(process.argv.slice(2));
module.exports = {workerFlag, sizeExit, maxInputBytes, maxOutputBytes, sizeError, decode, runWorker};
