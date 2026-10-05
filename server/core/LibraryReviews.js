const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

function entryKey(folder, file) {
    // INPX can name a ZIP archive whose actual file has been repacked as 7z.
    return `${String(folder).replace(/\\/g, '/').replace(/\.(zip|7z)$/i, '.zip')}#${file}`;
}

function normalizeEntryKey(value) {
    const separator = value.lastIndexOf('#');
    return separator < 0 ? '' : entryKey(value.slice(0, separator), value.slice(separator + 1));
}

async function snapshot(dirs) {
    const archives = [];
    const seen = new Set();
    for (const dir of dirs) {
        let names;
        try {
            names = await fs.readdir(dir);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        for (const name of names.sort()) {
            if (!/\.(zip|7z)$/i.test(name)) continue;
            const file = path.resolve(dir, name);
            if (seen.has(file)) continue;
            let stat;
            try {
                stat = await fs.stat(file);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            if (!stat.isFile()) continue;
            seen.add(file);
            archives.push({id: path.basename(name, path.extname(name)), file,
                size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs});
        }
    }
    const signature = crypto.createHash('sha256').update(JSON.stringify({dirs, archives})).digest('hex');
    return {archives, signature};
}

module.exports = {entryKey, normalizeEntryKey, snapshot};
