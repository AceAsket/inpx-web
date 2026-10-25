const fs = require('fs-extra');

// Kindling also runs its full internal self-check. Before publishing the cache,
// independently require a dual MOBI7/KF8 container, not an AZW3 renamed to .mobi.
async function validateMobi(filePath) {
    const invalid = () => Object.assign(new Error('Конвертер не создал корректный MOBI7/KF8 файл.'), {code: 'INPX_INVALID_MOBI'});
    const file = await fs.open(filePath, 'r');
    try {
        const {size} = await fs.fstat(file);
        const read = async(position, length) => {
            if (position < 0 || length < 0 || position + length > size) throw invalid();
            const data = Buffer.alloc(length);
            if ((await fs.read(file, data, 0, length, position)).bytesRead !== length) throw invalid();
            return data;
        };
        const header = await read(0, 78);
        if (header.toString('ascii', 60, 68) !== 'BOOKMOBI') throw invalid();
        const count = header.readUInt16BE(76);
        if (count < 4) throw invalid();
        const table = await read(78, count * 8);
        const offsets = Array.from({length: count}, (_, i) => table.readUInt32BE(i * 8));
        if (offsets.some((offset, i) => offset < 78 + table.length || offset >= size || (i && offset <= offsets[i - 1]))) throw invalid();
        const firstLength = offsets[1] - offsets[0];
        if (firstLength < 264 || firstLength > 1024 * 1024) throw invalid();
        const first = await read(offsets[0], firstLength);
        if (first.toString('ascii', 16, 20) !== 'MOBI' || first.readUInt32BE(36) !== 6 ||
            first.readUInt32BE(28) !== 65001 || first.readUInt32BE(4) === 0 || first.readUInt16BE(8) === 0) throw invalid();
        const exth = 16 + first.readUInt32BE(20);
        if (exth + 12 > first.length || first.toString('ascii', exth, exth + 4) !== 'EXTH') throw invalid();
        const end = exth + first.readUInt32BE(exth + 4);
        if (end > first.length || end < exth + 12) throw invalid();
        let cursor = exth + 12, kf8 = -1;
        const records = first.readUInt32BE(exth + 8);
        for (let i = 0; i < records; i++) {
            if (cursor + 8 > end) throw invalid();
            const type = first.readUInt32BE(cursor), length = first.readUInt32BE(cursor + 4);
            if (length < 8 || cursor + length > end) throw invalid();
            if (type === 121 && length === 12) kf8 = first.readUInt32BE(cursor + 8);
            cursor += length;
        }
        if (kf8 - 1 <= first.readUInt16BE(8) || kf8 >= count || offsets[kf8] - offsets[kf8 - 1] < 8) throw invalid();
        if ((await read(offsets[kf8 - 1], 8)).toString('ascii') !== 'BOUNDARY') throw invalid();
        if ((kf8 + 1 < count ? offsets[kf8 + 1] : size) - offsets[kf8] < 40) throw invalid();
        const second = await read(offsets[kf8], 40);
        if (second.toString('ascii', 16, 20) !== 'MOBI' || second.readUInt32BE(36) !== 8) throw invalid();
    } finally {
        await fs.close(file);
    }
}

module.exports = {validateMobi};
