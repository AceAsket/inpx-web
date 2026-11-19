const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {resolve,join} = require('node:path');
const {tmpdir} = require('node:os');
const {ZipFile} = require('yazl');
const archive = require('../server/core/BackupArchive');
const encryption = require('../server/core/BackupCrypto');

const timestamp = new Date('2026-11-16T00:00:00.000Z');
const configText = '{ "opds": { "enabled": true } }';
const infoText = '{"version":"test","createdAt":"2026-11-16T00:00:00.000Z"}';
const key = Buffer.from(Buffer.alloc(32, 2).toString('base64'));
const password = 'Пароль 🔐\u0000 переносимой копии';
const salt = Buffer.from('0123456789abcdef');

function engine(binary) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
}

async function createFixture(directory, userNotes = 'Глава 📚') {
    const configFile = join(directory, 'config.json');
    await fs.writeFile(configFile, configText);
    return [
        {name:'backup-info.json', data:Buffer.from(infoText)},
        {name:'config.json', path:configFile},
        {name:'reading-lists.json', data:Buffer.from(JSON.stringify({users:[{id:'reader',notes:userNotes}],lists:[]}))},
        {name:'secret.key', data:key},
    ];
}

async function read(file, folder, config = {}) {
    return archive.read({contentBase64:(await fs.readFile(file)).toString('base64')}, config, folder);
}

async function zip(entries, forceZip64Format = false) {
    const writer = new ZipFile();
    const output = (async () => {
        const buffers = [];
        for await (const chunk of writer.outputStream) buffers.push(chunk);
        return Buffer.concat(buffers);
    })();
    for (const [name, content] of entries) writer.addBuffer(Buffer.from(content),name);
    writer.end({forceZip64Format});
    return output;
}

async function verify(binary, directory) {
    const files = await createFixture(directory);
    const jsZip = join(directory,'legacy.zip'), rustZip = join(directory,'native.zip');
    engine();
    await archive.write(jsZip, files, timestamp);
    const expected = await read(jsZip, directory);
    engine(binary);
    assert.deepEqual(await read(jsZip,directory), expected);
    await archive.write(rustZip,files,timestamp);
    const result = await read(rustZip,directory);
    engine();
    assert.deepEqual(result, await read(rustZip,directory));
    assert.deepEqual(result['reading-lists.json'], expected['reading-lists.json']);
    assert.deepEqual(result['secret.key'], key);
    assert.deepEqual(result[archive.inspection].files, expected[archive.inspection].files);

    engine(binary);
    const base = [['backup-info.json',infoText], ['config.json',configText]];
    const inspect = (bytes, config) => archive.read({contentBase64:bytes.toString('base64')}, config, directory);
    assert.deepEqual((await inspect(await zip(base,true)))['config.json'], expected['config.json']);
    await assert.rejects(inspect(await zip([...base,base[1]])), /много файлов/);
    const understated = await zip([...base,base[1]]);
    understated.writeUInt16LE(2, understated.length-14);
    understated.writeUInt16LE(2, understated.length-12);
    await assert.rejects(inspect(understated), /много файлов/);
    await assert.rejects(inspect(await zip([...base,['unknown.txt','unknown']])), /Неизвестный файл/);
    await assert.rejects(inspect(await zip([...base,['discovery-cache.json','{"x":"'+'x'.repeat(1024*1024)+'"}']]),
        {backupExpandedLimitMb:1}), /распакованный размер/);
    const intact = await zip(base);
    await assert.rejects(inspect(intact.subarray(0,-12)), /Повреждён ZIP/);
    await fs.rm(join(directory,'backup.zip'), {force:true});
    assert.deepEqual((await inspect(intact))['config.json'], expected['config.json']);
    await assert.rejects(fs.stat(join(directory,'backup.zip')), {code:'ENOENT'});
    const failed = join(directory,'failed.zip');
    await assert.rejects(archive.write(failed,[...files,files[1]],timestamp), /много файлов/);
    await assert.rejects(fs.stat(failed), {code:'ENOENT'});
    await assert.rejects(fs.stat(failed+'.tmp'), {code:'ENOENT'});
    await verifyCrypto(binary, directory);
    const vault = require('./backup-vault-tests');
    await vault.testVaultStoreParity(binary,directory);
    await vault.testEncryptedBackupPreviewRestoreAndRotation();
    console.log('ok native ZIP exports, legacy ZIP and ZIP64 imports, failed publication, encrypted vault');
}

async function verifyCrypto(binary, directory) {
    const files = await createFixture(directory,notes(2*1024*1024));
    engine();
    const legacyKey = await encryption.derive(password,salt);
    engine(binary);
    const rustKey = await encryption.derive(password,salt);
    assert.deepEqual(rustKey,legacyKey);
    const output = [join(directory,'old.zip.enc'),join(directory,'new.zip.enc')];
    const config = {backupExpandedLimitMb:4};
    const readEncrypted = bytes => archive.read({password,contentBase64:bytes.toString('base64')},config,directory);
    try {
        engine();
        await archive.write(output[0],files,timestamp,{key:Buffer.from(legacyKey),salt});
        engine(binary);
        const workingKey = Buffer.from(rustKey);
        await archive.write(output[1],files,timestamp,{key:workingKey,salt});
        assert(workingKey.every(byte=>byte===0));
        const [old, recent] = await Promise.all(output.map(file => fs.readFile(file)));
        for (const bytes of [old,recent]) assert(bytes.length>1024*1024);
        const legacyReadInRust = await readEncrypted(old);
        const rustReadInRust = await readEncrypted(recent);
        const changed = Buffer.from(recent);
        changed[changed.length-1] ^= 1;
        await assert.rejects(readEncrypted(changed),/Неверный пароль|повреждён/);
        assert.deepEqual(await readEncrypted(recent),rustReadInRust);
        const failed = join(directory,'failed.zip.enc');
        await assert.rejects(archive.write(failed,[...files,files[1]],timestamp,{key:Buffer.from(rustKey),salt}),/много файлов/);
        await assert.rejects(fs.stat(failed),{code:'ENOENT'});
        assert(!(await fs.readdir(directory)).some(name => name.startsWith('.backup-') || name.endsWith('.tmp')));
        engine();
        assert.deepEqual(await readEncrypted(old),legacyReadInRust);
        assert.deepEqual(await readEncrypted(recent),rustReadInRust);
    } finally {
        legacyKey.fill(0);
        rustKey.fill(0);
        engine(binary);
    }
}

function notes(size) {
    const chunks = [];
    let number = 9_153_087;
    for (let start = 0; start < size; start += 64*1024) {
        const bytes = Buffer.allocUnsafe(Math.min(64*1024,size-start));
        for(let index=0; index<bytes.length; index++) {
            number = (Math.imul(number,1_664_525)+1_013_904_223)>>>0;
            bytes[index] = 65+(number>>>16)%26;
        }
        chunks.push(bytes.toString('ascii'));
    }
    return chunks.join('');
}

const median = samples => Math.round(samples.toSorted((a,b) => a-b)[samples.length>>1]*100)/100;

async function benchmark(binary, directory) {
    const file = join(directory,'output.zip');
    const rounds = 11;
    for (const size of [16*1024, 3*1024*1024, 16*1024*1024]) {
        const files = await createFixture(directory,notes(size));
        engine();
        await archive.write(file,files,timestamp);
        const baseline = await read(file,directory);
        const archiveBytes = await fs.readFile(file);
        const payload = {contentBase64:archiveBytes.toString('base64')};
        const buffers = [[],[]].map(() => ({pack:[],unpack:[]}));
        const outputSizes = [];
        for(let round=0; round<=rounds; round++) {
            for (const index of round%2 ? [1,0] : [0,1]) {
                engine(index ? binary : '');
                const start = performance.now();
                await archive.write(file,files,timestamp);
                const packed = performance.now()-start;
                const unpackStarted = performance.now();
                const data = await archive.read(payload,{},directory);
                const unpacked = performance.now()-unpackStarted;
                assert.deepEqual(data,baseline);
                if (round) {
                    buffers[index].pack.push(packed);
                    buffers[index].unpack.push(unpacked);
                }
                outputSizes[index] = (await fs.stat(file)).size;
            }
        }
        for (const stage of ['pack','unpack'])
            console.log(JSON.stringify({stage, profileNotesBytes:size, inputZipBytes:archiveBytes.length,
                beforeMs:median(buffers[0][stage]), afterMs:median(buffers[1][stage]), outputSizes}));
    }
}

async function benchmarkCrypto(binary, directory) {
    const file = join(directory,'encrypted.zip.enc');
    const rounds = 9;
    const derivations = [[],[]];
    for(let round=0; round<=rounds; round++) {
        for (const index of round%2 ? [1,0] : [0,1]) {
            engine(index ? binary : '');
            const start=performance.now();
            const derived=await encryption.derive(password,salt);
            if (round) derivations[index].push(performance.now()-start);
            derived.fill(0);
        }
    }
    console.log(JSON.stringify({stage:'scrypt',beforeMs:median(derivations[0]),afterMs:median(derivations[1])}));
    engine();
    const derived = await encryption.derive(password,salt);
    try {
        for (const size of [16*1024, 3*1024*1024, 16*1024*1024]) {
            const files = await createFixture(directory,notes(size));
            engine();
            await archive.write(file,files,timestamp,{key:Buffer.from(derived),salt});
            const archiveBytes=await fs.readFile(file);
            const payload={password,contentBase64:archiveBytes.toString('base64')};
            const expected=await archive.read(payload,{},directory);
            const timings=[[],[]].map(()=>({seal:[],open:[]}));
            for(let round=0; round<=rounds; round++) {
                for (const index of round%2 ? [1,0] : [0,1]) {
                    engine(index ? binary : '');
                    let start=performance.now();
                    await archive.write(file,files,timestamp,{key:Buffer.from(derived),salt});
                    if(round) timings[index].seal.push(performance.now()-start);
                    start=performance.now();
                    const data=await archive.read(payload,{},directory);
                    if(round) timings[index].open.push(performance.now()-start);
                    assert.deepEqual(data,expected);
                }
            }
            for(const stage of ['seal','open']) {
                console.log(JSON.stringify({stage,profileNotesBytes:size,inputArchiveBytes:archiveBytes.length,
                    beforeMs:median(timings[0][stage]),afterMs:median(timings[1][stage])}));
            }
        }
    } finally {derived.fill(0);}
}

async function benchmarkSaved(binary, directory) {
    engine(binary);
    const dataDir=join(directory,'saved-backups'), backupDir=join(dataDir,'backups');
    const scratch=join(directory,'saved-restore');
    await Promise.all([fs.mkdir(backupDir,{recursive:true}),fs.mkdir(scratch)]);
    const Vault=require('../server/core/BackupVault');
    const config={dataDir,backupUploadLimitMb:64,backupExpandedLimitMb:64};
    const vault=new Vault({config});
    const derived=await encryption.derive(password,salt);
    try {
        const files=await createFixture(directory,notes(16*1024*1024));
        for (const encrypted of [false,true]) {
            const name=`inpx-web-backup-2026-11-16T07-00-00-000Z-12345678.zip${encrypted?'.enc':''}`;
            await archive.write(join(backupDir,name),files,timestamp,encrypted?{key:Buffer.from(derived),salt}:undefined);
            const actions=[()=>vault.payload(name,password),()=>vault.restoreSource(name,password)];
            const samples=[[],[]];
            const expected=await archive.read(await actions[0](),config,scratch);
            for(let i=0; i<12; i++) {
                for (const index of i%2 ? [1,0] : [0,1]) {
                    const start=performance.now();
                    const data=await archive.read(await actions[index](),config,scratch);
                    if(i) samples[index].push(performance.now()-start);
                    assert.deepEqual(data,expected);
                }
            }
            console.log(JSON.stringify({stage:'saved-preview',encrypted,profileNotesBytes:16*1024*1024,
                beforeMs:median(samples[0]),afterMs:median(samples[1])}));
        }
    } finally {derived.fill(0); await vault.stop();}
}

async function main(binary, mode) {
    if (!binary) throw new Error('Usage: node scripts/rust-backup-archive-tests.js <catalog-binary> [benchmark]');
    binary = resolve(binary);
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-backup-archive-'));
    engine(binary);
    const close = require('../server/core/RustBackupZip').start();
    try {
        if (mode === 'vault') {
            await require('./backup-vault-tests').benchmarkVaultStore(binary,directory);
            await benchmarkSaved(binary,directory);
        }
        else if (mode === 'crypto') await benchmarkCrypto(binary,directory);
        else await (mode === 'benchmark' ? benchmark : verify)(binary,directory);
    }
    finally {
        await close();
        await fs.rm(directory,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error => {console.error(error); process.exitCode = 1;});
