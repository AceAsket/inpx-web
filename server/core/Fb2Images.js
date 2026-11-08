const fs = require('fs-extra');
const images = require('./ImageUtils');

// Repacked collections can keep image/jpeg and a .jpg ID around WebP/JXL
// bytes. Preserve every binary ID/reference while making the payload usable
// by FB2 readers and converters that trust the declared type.
async function normalizeEmbeddedImages(file, config = {}, toolDirs = []) {
    const text = await fs.readFile(file, 'utf8');
    const chunks = [];
    let cursor = 0, changed = false;
    for (const match of text.matchAll(/<binary\b([^>]*)>([\s\S]*?)<\/binary\s*>/gi)) {
        if (!/^[a-z\d+/=\s]*$/i.test(match[2])) continue;
        const bytes = Buffer.from(match[2], 'base64');
        const type = images.contentType(bytes);
        if (!type.startsWith('image/')) continue;
        const declared = /\bcontent-type\s*=\s*(["'])(.*?)\1/i.exec(match[1]);
        if (type !== 'image/webp' && type !== 'image/jxl' && declared?.[2].toLowerCase() === type) continue;
        const normalized = await images.normalizeForFb2(bytes, config.tempDir, toolDirs, config.converterPaths);
        const attribute = `content-type="${normalized.contentType}"`;
        const attrs = declared ? match[1].replace(declared[0], attribute) : `${match[1]} ${attribute}`;
        chunks.push(text.slice(cursor, match.index), `<binary${attrs}>${normalized.data.toString('base64')}</binary>`);
        cursor = match.index + match[0].length;
        changed = true;
    }
    if (!changed) return false;
    chunks.push(text.slice(cursor));
    await fs.writeFile(file, chunks.join(''), 'utf8');
    return true;
}

module.exports = {normalizeEmbeddedImages};
