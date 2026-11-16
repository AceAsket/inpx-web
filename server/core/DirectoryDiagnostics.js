const fs = require('fs-extra');
const {extname,join,resolve} = require('node:path');
const programs = require('./RustPrograms');
const RustWorkerPool = require('./RustWorkerPool');
const runtime = require('./ResourceRuntime');

const workers = new RustWorkerPool('directory-diagnostics');
const cleanup = new RustWorkerPool('directory-diagnostics',1);
const executable = () => programs.executable('catalog');
const absolute = path => path ? resolve(path) : '';

function start({lazy = true} = {}) {
    const binary = executable();
    if (!binary) return;
    const stopRead = workers.start(binary,{lazy});
    const stopCleanup = cleanup.start(binary,{lazy:true});
    return ()=>Promise.all([stopRead(),stopCleanup()]);
}

async function readReply(stream) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > 4*1024*1024) throw new Error('Слишком большой ответ диагностики каталогов');
        chunks.push(chunk);
    }
    if (size) return JSON.parse(chunks.length===1 ? chunks[0] : Buffer.concat(chunks,size));
}

function run(binary, request) {
    return workers.run(binary,request,readReply,{signal:runtime.signal()});
}

async function sizes(directories) {
    const binary = executable();
    if (binary) {
        const result = await run(binary,{op:'sizes',directories:directories.map(({path,maxFiles=20000})=>({path:absolute(path),maxFiles}))});
        return result.map((size,index)=>{
            const {path = ''} = directories[index];
            return {path,...size};
        });
    }
    const result = [];
    for (const directory of directories) result.push(await legacySize(directory));
    return result;
}

async function source(settings = {}) {
    const libDir = String(settings.libDir || '').trim();
    const inpx = String(settings.inpx || settings.inpxFile || '').trim();
    const binary = executable();
    if (!binary) return legacySource(libDir,inpx);
    const result = await run(binary,{op:'source',directory:absolute(libDir),inpx:absolute(inpx)});
    result.foundInpx = result.foundInpx.map(file=>join(libDir,file));
    return result;
}

async function rotateCache(directory,maxSize,targetSize,forceTarget) {
    const binary = executable();
    if (!binary) return null;
    return cleanup.run(binary,{op:'rotateCache',directory:absolute(directory),maxSize,targetSize,forceTarget},
        readReply,{timeoutMs:null});
}

async function purgeBrokenCovers(directory) {
    const binary = executable();
    if (!binary) return null;
    return cleanup.run(binary,{op:'purgeBrokenCovers',directory:absolute(directory)},readReply,{timeoutMs:null});
}

async function legacySize({path = '',maxFiles = 20000}) {
    const result = {path,exists:false,size:0,files:0,truncated:false};
    if (!path || !await fs.pathExists(path)) return result;
    result.exists = true;
    const stack = [path];
    while (stack.length) {
        const current = stack.pop();
        const names = await fs.readdir(current).catch(()=>[]);
        for (const name of names) {
            const file = join(current,name);
            const stat = await fs.stat(file).catch(()=>null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                stack.push(file);
            } else {
                result.files++;
                result.size += stat.size;
                if (result.files >= maxFiles) {
                    result.truncated = true;
                    return result;
                }
            }
        }
    }
    return result;
}

async function visitFiles(root,visit) {
    if (!root || !await fs.pathExists(root)) return;
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        const entries = await fs.readdir(current,{withFileTypes:true}).catch(()=>[]);
        for (const entry of entries) {
            const file = join(current,entry.name);
            if (entry.isDirectory()) stack.push(file);
            else if (visit(file,extname(entry.name).toLowerCase())) return;
        }
    }
}

async function legacySource(libDir,inpx) {
    const foundInpx = [];
    await visitFiles(libDir,(file,ext)=>ext === '.inpx' && foundInpx.push(file) === 20);
    let archiveCount = 0;
    await visitFiles(libDir,(_file,ext)=>['.zip','.7z','.fb2','.epub'].includes(ext) && ++archiveCount === 20000);
    const exists = async name=>!!(libDir && await fs.pathExists(join(libDir,name)));
    return {
        inpxExists:!!inpx && await fs.pathExists(inpx),
        libDirExists:!!libDir && await fs.pathExists(libDir),
        foundInpx,
        archiveCount,
        archiveCountTruncated:archiveCount === 20000,
        hasCovers:await exists('covers'),
        hasEtc:await exists('etc'),
        hasImages:await exists('images'),
        hasBin:await exists('bin'),
    };
}

module.exports = {start,sizes,source,rotateCache,purgeBrokenCovers};
