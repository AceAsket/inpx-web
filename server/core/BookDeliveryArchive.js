const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');
const utils = require('./utils');

async function prepare(prepared) {
    const name = path.posix.basename(String(prepared.downFileName || 'book').replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '') || 'book'; // eslint-disable-line no-control-regex
    const key = crypto.createHash('sha256').update(name).digest('hex').slice(0, 24);
    const file = `${prepared.rawFile}.delivery-v1-${key}.zip`;
    await utils.prepareCachedFile(file, async output => {
        const zip = new yazl.ZipFile();
        const complete = pipeline(zip.outputStream, fs.createWriteStream(output));
        complete.catch(() => {});
        zip.on('error', error => zip.outputStream.destroy(error));
        try {
            zip.addFile(prepared.rawFile, name);
            zip.end();
            await complete;
        } catch (error) {
            zip.outputStream.destroy(error);
            await complete.catch(() => {});
            throw error;
        }
    });
    await utils.touchFile(file);
    return {...prepared, rawFile:file, downFileName:`${name}.zip`};
}

module.exports = {prepare};
