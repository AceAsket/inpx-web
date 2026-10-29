const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const ZipReader = require('./ZipReader');
const {writeFileAtomic} = require('./FilePersistence');

const marker = '.inpx-web-managed.json';
function safeName(value) {
    return typeof value === 'string' && value !== marker && value !== 'version.txt' && !/[\\:]/.test(value) && !value.includes(String.fromCharCode(0))
        && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

async function destination(root, name) {
    const parts = name.split('/');
    let current = path.resolve(root);
    for (const part of ['', ...parts]) {
        if (part) current = path.join(current, part);
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Символическая ссылка в каталоге веб-приложения');
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    return current;
}

async function install(config, bundle) {
    const version = [config.version, config.rootPathStatic || '', crypto.createHash('sha256').update(bundle.data).digest('hex')].join(':');
    const markerFile = path.join(config.publicDir, marker);
    let previous;
    try {previous = await fs.readJson(markerFile);} catch (error) {if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;}
    if (previous?.version === version && Array.isArray(previous.files)) return;
    await fs.ensureDir(config.tempDir);
    const stage = await fs.mkdtemp(path.join(config.tempDir, 'webapp-'));
    const archive = path.join(stage, 'bundle.zip'), extracted = path.join(stage, 'files');
    const reader = new ZipReader(config);
    let opened = false;
    try {
        await fs.writeFile(archive, bundle.data, 'base64');
        await reader.open(archive);
        opened = true;
        const files = Object.values(reader.entries).filter(entry => !entry.isDirectory).map(entry => entry.name);
        if (!files.length || files.some(name => !safeName(name))) throw new Error('Некорректный состав веб-приложения');
        await fs.ensureDir(extracted);
        await reader.extractAllToDir(extracted);
        await fs.ensureDir(config.publicDir);
        // Validate every target before replacing any managed file.
        for (const name of [...files, marker, 'version.txt']) await destination(config.publicDir, name);
        for (const name of files) {
            const target = await destination(config.publicDir, name);
            await fs.ensureDir(path.dirname(target));
            await writeFileAtomic(target, await fs.readFile(path.join(extracted, name)));
            await fs.remove(target + '.replaced');
        }
        for (const name of Array.isArray(previous?.files) ? previous.files : []) {
            if (!safeName(name) || files.includes(name)) continue;
            const target = await destination(config.publicDir, name);
            if (await fs.pathExists(target) && (await fs.lstat(target)).isFile()) await fs.remove(target);
            await fs.remove(target + '.replaced');
        }
        await writeFileAtomic(path.join(config.publicDir, 'version.txt'), version);
        await writeFileAtomic(markerFile, JSON.stringify({version, files}));
    } finally {
        try {
            if (opened) await reader.close();
            else await reader.close().catch(() => {});
        }
        finally {await fs.remove(stage);}
    }
}

module.exports = {install, safeName};
