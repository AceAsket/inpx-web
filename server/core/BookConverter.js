const fs = require('fs-extra');
const path = require('path');
const {spawn} = require('child_process');

const pending = new Map();
const targetFormats = new Set(['epub', 'mobi', 'pdf']);
const commands = [
    'ebook-convert',
    '/usr/bin/ebook-convert',
    '/usr/local/bin/ebook-convert',
    'C:\\Program Files\\Calibre2\\ebook-convert.exe',
];

function canConvertTo(format) {
    return targetFormats.has((format || '').toLowerCase());
}

async function buildConvertEnv() {
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

async function run(command, args) {
    const env = await buildConvertEnv();

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env,
        });
        let stderr = '';

        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('error', err => {
            if (err && err.code === 'ENOENT') {
                reject(new Error('ebook-convert not found'));
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

async function runCommand(args) {
    let lastError = null;

    for (const command of commands) {
        try {
            await run(command, args);
            return;
        } catch(e) {
            lastError = e;
            if (!/not found/i.test(e.message))
                throw e;
        }
    }

    throw (lastError || new Error('ebook-convert not found'));
}

async function convert({inputFile, outputFile, format, sourceFileName = ''}) {
    if (!canConvertTo(format))
        throw new Error(`Unsupported convert format: ${format}`);

    const key = `${inputFile}=>${outputFile}`;
    if (pending.has(key))
        return await pending.get(key);

    const job = (async() => {
        await fs.ensureDir(path.dirname(outputFile));
        let convertInput = inputFile;
        let tempInput = '';
        let tempIntermediate = '';
        const sourceExt = path.extname(sourceFileName || '').toLowerCase();

        if (sourceExt && sourceExt !== path.extname(inputFile).toLowerCase()) {
            tempInput = `${inputFile}${sourceExt}`;
            if (!await fs.pathExists(tempInput))
                await fs.copyFile(inputFile, tempInput);
            convertInput = tempInput;
        }

        try {
            if (format === 'pdf' && path.extname(convertInput).toLowerCase() !== '.epub') {
                tempIntermediate = `${outputFile}.intermediate.epub`;
                await runCommand([convertInput, tempIntermediate]);
                await runCommand([tempIntermediate, outputFile]);
            } else {
                await runCommand([convertInput, outputFile]);
            }
        } finally {
            if (tempInput)
                await fs.remove(tempInput);
            if (tempIntermediate)
                await fs.remove(tempIntermediate);
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
    convert,
};
