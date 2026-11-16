const fs = require('fs-extra');
const {join} = require('node:path');
const {writeFileAtomic} = require('./FilePersistence');
const utils = require('./utils');
const native = require('./RustBookCache');

async function inspect(directory,hash,{assetVersion,touch = false,probeRaw = false} = {}) {
    if (typeof hash!=='string' || !/^[a-f0-9]{1,128}$/i.test(hash)) return null;
    const binary = native.executable();
    if (binary) return native.inspect(binary,directory,hash,assetVersion,touch,probeRaw);
    const file = join(directory,hash), description = `${file}.d.json`;
    if (!await fs.pathExists(file) || !await fs.pathExists(description)) return null;
    let descriptor;
    try {descriptor = await fs.readJson(description);}
    catch (error) {
        if (assetVersion!==undefined || error.code==='ENOENT') return null;
        throw error;
    }
    if (!descriptor || assetVersion!==undefined && descriptor.assetVersion!==assetVersion) return null;
    if (touch) {
        await utils.touchFile(file);
        await utils.touchFile(description);
    }
    if (probeRaw) descriptor.rawReady = await utils.validCachedFile(`${file}.raw`,descriptor.size);
    return descriptor;
}

async function publish(directory,tempDir,source,descriptor,raw) {
    const binary = native.executable();
    if (binary) return native.publish(binary,directory,source,descriptor,raw);
    const hash = await utils.getFileHash(source,'sha256','hex');
    const size = (await fs.stat(source)).size;
    const file = join(directory,hash);
    const description = `${file}.d.json`;
    if (!await fs.pathExists(file)) {
        const temporary = join(tempDir,utils.randomHexString(30));
        try {
            await utils.gzipFile(source,temporary,4);
            await fs.move(temporary,file,{overwrite:true});
        } finally {await fs.remove(temporary);}
    } else {
        await utils.touchFile(file);
        if (await fs.pathExists(description)) await utils.touchFile(description);
    }
    if (raw && size) await utils.prepareCachedFile(`${file}.raw`,temporary=>fs.move(source,temporary),size);
    await writeFileAtomic(description,JSON.stringify({...descriptor,size}));
    return {hash,size};
}

async function registerRemote(directory,hash,descriptor) {
    const binary = native.executable();
    if (binary) return native.registerRemote(binary,directory,hash,{...descriptor,size:0});
    const file = join(directory,hash);
    await utils.touchFile(file);
    await writeFileAtomic(`${file}.d.json`,JSON.stringify({...descriptor,size:0}));
}

module.exports = {inspect,publish,registerRemote};
