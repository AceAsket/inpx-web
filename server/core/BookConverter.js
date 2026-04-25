const fs = require('fs-extra');
const path = require('path');
const {spawn} = require('child_process');

const pending = new Map();
const targetFormats = new Set(['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf']);
const fb2cngFormats = new Map([
    ['epub', 'epub2'],
    ['epub3', 'epub3'],
    ['kepub', 'kepub'],
    ['kfx', 'kfx'],
    ['azw8', 'azw8'],
]);
const fb2cngOutputExtensions = new Map([
    ['epub', ['.epub']],
    ['epub3', ['.epub']],
    ['kepub', ['.kepub.epub', '.epub']],
    ['kfx', ['.kfx']],
    ['azw8', ['.azw8']],
]);
const fb2cngCommands = [
    'fbc',
    '/usr/local/bin/fbc',
    '/usr/bin/fbc',
    path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'fbc.exe' : 'fbc'),
];
const mutoolCommands = [
    'mutool',
    '/usr/bin/mutool',
    '/usr/local/bin/mutool',
    path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'mutool.exe' : 'mutool'),
];
const calibreCommands = [
    'ebook-convert',
    '/usr/bin/ebook-convert',
    '/usr/local/bin/ebook-convert',
    'C:\\Program Files\\Calibre2\\ebook-convert.exe',
];

function canConvertTo(format) {
    return targetFormats.has((format || '').toLowerCase());
}

function canConvertSourceTo(sourceExt, format) {
    sourceExt = String(sourceExt || '').toLowerCase().replace(/^\./, '');
    format = String(format || '').toLowerCase();

    if (!canConvertTo(format))
        return false;
    if (sourceExt === 'fb2')
        return true;

    return sourceExt === 'epub' && format === 'pdf';
}

async function buildCalibreEnv() {
    const runtimeDir = path.join(require('os').tmpdir(), 'ebook-convert-runtime');
    await fs.ensureDir(runtimeDir);
    await fs.chmod(runtimeDir, 0o700);

    const chromiumFlags = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
    ].join(' ');

    return {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        QTWEBENGINE_DISABLE_SANDBOX: '1',
        QTWEBENGINE_CHROMIUM_FLAGS: chromiumFlags,
        QT_QPA_PLATFORM: (process.env.QT_QPA_PLATFORM || 'offscreen'),
    };
}

async function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: (options.env || process.env),
            cwd: options.cwd,
        });
        let stderr = '';

        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('error', err => {
            if (err && err.code === 'ENOENT') {
                reject(new Error(`${command} not found`));
                return;
            }

            reject(err);
        });

        child.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim()}`));
            }
        });
    });
}

async function runFirst(commands, args, options = {}) {
    let lastError = null;

    for (const command of commands) {
        try {
            await run(command, args, options);
            return;
        } catch(e) {
            lastError = e;
            if (!/not found/i.test(e.message))
                throw e;
        }
    }

    throw (lastError || new Error('converter not found'));
}

async function runCalibre(args) {
    await runFirst(calibreCommands, args, {env: await buildCalibreEnv()});
}

async function convertWithFb2cng(inputFile, outputFile, format) {
    const outputDir = `${outputFile}.fb2cng`;
    const fb2cngFormat = fb2cngFormats.get(format);

    await fs.remove(outputDir);
    await fs.ensureDir(outputDir);
    await runFirst(fb2cngCommands, ['convert', '--to', fb2cngFormat, '--overwrite', inputFile, outputDir]);

    const outputExtensions = fb2cngOutputExtensions.get(format) || [`.${format}`];
    const converted = (await fs.readdir(outputDir))
        .filter(file => outputExtensions.some(ext => file.toLowerCase().endsWith(ext)))
        .map(file => path.join(outputDir, file))[0];

    if (!converted)
        throw new Error(`fb2cng did not produce ${format}`);

    await fs.move(converted, outputFile, {overwrite: true});
    await fs.remove(outputDir);
}

async function convertWithMutool(inputFile, outputFile) {
    await runFirst(mutoolCommands, ['convert', '-o', outputFile, inputFile]);
}

async function convertWithCalibre(inputFile, outputFile, format) {
    let tempIntermediate = '';

    try {
        if (format === 'pdf' && path.extname(inputFile).toLowerCase() !== '.epub') {
            tempIntermediate = `${outputFile}.intermediate.epub`;
            await runCalibre([inputFile, tempIntermediate]);
            await runCalibre([tempIntermediate, outputFile]);
        } else {
            await runCalibre([inputFile, outputFile]);
        }
    } finally {
        if (tempIntermediate)
            await fs.remove(tempIntermediate);
    }
}

async function convertPrepared(convertInput, outputFile, format) {
    if (fb2cngFormats.has(format) && path.extname(convertInput).toLowerCase() === '.fb2') {
        await convertWithFb2cng(convertInput, outputFile, format);
        return;
    }

    if (format === 'pdf' && ['.fb2', '.epub'].includes(path.extname(convertInput).toLowerCase())) {
        await convertWithMutool(convertInput, outputFile);
        return;
    }

    await convertWithCalibre(convertInput, outputFile, format);
}

async function convert({inputFile, outputFile, format, sourceFileName = ''}) {
    format = String(format || '').toLowerCase();
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!canConvertSourceTo(sourceExt, format))
        throw new Error(`Unsupported convert format: ${sourceExt || 'unknown'} -> ${format}`);

    const key = `${inputFile}=>${outputFile}`;
    if (pending.has(key))
        return await pending.get(key);

    const job = (async() => {
        await fs.ensureDir(path.dirname(outputFile));
        let convertInput = inputFile;
        let tempInput = '';
        const sourceExt = path.extname(sourceFileName || '').toLowerCase();

        if (sourceExt && sourceExt !== path.extname(inputFile).toLowerCase()) {
            tempInput = `${inputFile}${sourceExt}`;
            if (!await fs.pathExists(tempInput))
                await fs.copyFile(inputFile, tempInput);
            convertInput = tempInput;
        }

        try {
            await convertPrepared(convertInput, outputFile, format);
        } finally {
            if (tempInput)
                await fs.remove(tempInput);
        }
    })();

    pending.set(key, job);
    try {
        await job;
    } finally {
        pending.delete(key);
    }
}

module.exports = {
    canConvertTo,
    canConvertSourceTo,
    convert,
};
