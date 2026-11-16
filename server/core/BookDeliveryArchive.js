const path = require('path');
const crypto = require('crypto');
const utils = require('./utils');

async function prepare(prepared) {
    const name = path.posix.basename(String(prepared.downFileName || 'book').replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '') || 'book'; // eslint-disable-line no-control-regex
    const key = crypto.createHash('sha256').update(name).digest('hex').slice(0, 24);
    const file = `${prepared.rawFile}.delivery-v1-${key}.zip`;
    await utils.ensureBookZipFile(prepared.rawFile,file,name);
    await utils.touchFile(file);
    return {...prepared, rawFile:file, downFileName:`${name}.zip`};
}

module.exports = {prepare};
