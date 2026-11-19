const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {setTimeout:sleep} = require('node:timers/promises');
const {lock} = require('../server/core/CatalogueLock');
const RustFramedProcess = require('../server/core/RustFramedProcess');

async function contenders(directory,binary) {
    const attempts = await Promise.allSettled(Array.from({length:6},()=>lock(directory,binary)));
    try {
        assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
        for (const result of attempts.filter(item=>item.status==='rejected')) {
            assert.equal(result.reason.code,'INPX_CATALOGUE_LOCKED');
        }
    } finally {
        await Promise.all(attempts.flatMap(item=>item.status==='fulfilled' ? [item.value()] : []));
    }
    await assert.rejects(fs.stat(join(directory,'__softlock')),{code:'ENOENT'});
    const release = await lock(directory,binary);
    const first = release();
    assert.equal(release(),first);
    await first;
}

async function oldLock(directory,binary) {
    const {getFileLock,releaseFileLock} = require('jembadb/src/utils');
    const old = await getFileLock(directory,true);
    try {
        await assert.rejects(lock(directory,binary),{code:'INPX_CATALOGUE_LOCKED'});
    } finally {await releaseFileLock(directory,old);}
    const release = await lock(directory,binary);
    try {
        await assert.rejects(getFileLock(directory,true),/Path locked/);
    } finally {await release();}
    await fs.writeFile(join(directory,'__softlock'),'old crashed lock');
    const recovered = await lock(directory,binary);
    await recovered();
    const hard = join(directory,'__lock');
    await fs.writeFile(hard,'old hard lock');
    await assert.rejects(lock(directory,binary),{code:'INPX_CATALOGUE_LOCKED'});
    assert.equal(await fs.readFile(hard,'utf8'),'old hard lock');
    await fs.unlink(hard);
}

async function crash(directory,binary) {
    const process = new RustFramedProcess(binary,'catalogue-lock');
    try {
        const accepted = await process.request({op:'acquire',directory},[],async stream=>{
            let body = '';
            for await (const data of stream) body += data.toString('ascii');
            return JSON.parse(body);
        },{timeoutMs:5000});
        assert.equal(accepted,true);
        await assert.rejects(lock(directory,binary),{code:'INPX_CATALOGUE_LOCKED'});
    } finally {
        process.child.kill('SIGKILL');
        await process.closed;
    }
    await fs.access(join(directory,'__softlock'));
    const taken = await lock(directory,binary);
    await taken();
    const moved = directory+'-moved';
    await fs.rename(directory,moved);
    await fs.rename(moved,directory);
}

async function multiple(directory,binary) {
    const second = join(directory,'second');
    await fs.mkdir(second);
    const first = await lock(directory,binary);
    try {
        await sleep(900);
        const other = await lock(second,binary);
        await other();
        await assert.rejects(lock(directory,binary),{code:'INPX_CATALOGUE_LOCKED'});
        await fs.access(join(directory,'__softlock'));
    } finally {await first();}
}

async function lost(directory,binary) {
    const notification = Promise.withResolvers();
    const release = await lock(directory,binary,notification.resolve);
    const marker = join(directory,'__softlock');
    try {
        await fs.unlink(marker);
        await fs.writeFile(marker,'different owner');
        const error = await Promise.race([notification.promise,sleep(2500,null,{ref:false})]);
        assert.match(error?.message || '',/marker was replaced/);
        assert.equal(await fs.readFile(marker,'utf8'),'different owner');
    } finally {
        await release();
        await fs.rm(marker,{force:true});
    }
}

async function main() {
    const binary = resolve(process.argv[2]);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-native-lock-'));
    try {
        for (const [name,exercise] of Object.entries({contenders,oldLock,crash,multiple,lost})) {
            const directory = join(root,name);
            await fs.mkdir(directory);
            await exercise(directory,binary);
        }
        console.log('ok Rust catalogue lock contention, old owners, crash recovery and lost ownership');
    } finally {await fs.rm(root,{recursive:true,force:true});}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
