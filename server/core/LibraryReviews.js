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

async function ratingRows(reader, consume, tempDir) {
    const {pipeline} = require('stream/promises');
    const {Transform} = require('stream');
    const iconv = require('iconv-lite');
    let temporary;
    try {
        if (reader.archiveType === '7z') {
            temporary = path.join(tempDir || require('os').tmpdir(),`ratings-${crypto.randomBytes(12).toString('hex')}.json`);
            await fs.ensureDir(path.dirname(temporary));
            await reader.extractToFile('books.json',temporary);
        }
        for (const encoding of ['utf8','win1251']) {
            const source = temporary ? fs.createReadStream(temporary) : await reader.zip.stream('books.json');
            const decoded = iconv.decodeStream(encoding);
            const verify = new Transform({decodeStrings:false, transform(chunk, unused, callback) {
                if (encoding === 'utf8' && String(chunk).includes('\uFFFD')) return callback(Object.assign(new Error('Invalid UTF-8'),{code:'INVALID_RATING_ENCODING'}));
                callback(null,chunk);
            }});
            try {
                const parser = new (require('@streamparser/json-node').JSONParser)({paths:['$.*'],keepStack:false,stringBufferSize:64 * 1024});
                await pipeline(source,decoded,verify,parser,async rows => {
                    for await (const row of rows) consume(row.value);
                });
                return;
            } catch (error) {if (error.code !== 'INVALID_RATING_ENCODING' || encoding !== 'utf8') throw error;}
        }
    } finally {if (temporary) await fs.remove(temporary);}
}

module.exports = {entryKey, normalizeEntryKey, snapshot, ratingRows};
