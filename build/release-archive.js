const fs = require('fs-extra');
const path = require('path');
const {randomUUID} = require('crypto');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');

function executableNames(target, converters = true) {
    if (!['linux', 'linux-arm64', 'macos', 'win'].includes(target))
        throw new Error(`Unknown release target: ${target}`);
    const suffix = target === 'win' ? '.exe' : '';
    return ['inpx-web' + suffix, ...(converters ? ['bin/fbc' + suffix, 'bin/kindling' + suffix] : [])];
}

async function createReleaseArchive(sourceDir, archiveFile, target) {
    const executables = new Set(executableNames(target));
    await fs.access(path.join(sourceDir, executableNames(target, false)[0]));
    const entries = [];
    async function visit(relative = '') {
        const children = await fs.readdir(path.join(sourceDir, relative), {withFileTypes:true});
        for (const child of children.sort((a,b) => a.name.localeCompare(b.name))) {
            const name = relative ? `${relative}/${child.name}` : child.name;
            const file = path.join(sourceDir, name);
            if (child.isDirectory()) {
                entries.push({name:name + '/', directory:true});
                await visit(name);
            } else if (child.isFile()) {
                const stat = await fs.stat(file);
                // Explicit Unix modes also work when a ZIP is built on Windows
                // or the input was copied through a filesystem without +x.
                const executable = target !== 'win' && (executables.has(name) || (stat.mode & 0o111));
                entries.push({name, file, mode:executable ? 0o100755 : 0o100644});
            } else throw new Error(`Unsupported release entry: ${name}`);
        }
    }
    await visit();
    await fs.ensureDir(path.dirname(archiveFile));
    const temporary = `${archiveFile}.${randomUUID()}.tmp`;
    const zip = new ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    try {
        const writing = pipeline(zip.outputStream, fs.createWriteStream(temporary));
        for (const entry of entries) {
            if (entry.directory) zip.addEmptyDirectory(entry.name, {mode:0o40755});
            else zip.addFile(entry.file, entry.name, {mode:entry.mode});
        }
        zip.end();
        await writing;
        await fs.move(temporary, archiveFile, {overwrite:true});
    } finally {
        await fs.remove(temporary);
    }
    return archiveFile;
}

module.exports = {createReleaseArchive, executableNames};
