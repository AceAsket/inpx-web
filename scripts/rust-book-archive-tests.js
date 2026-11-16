const assert = require('node:assert/strict');
const {execFile,spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {basename,dirname,join,resolve} = require('node:path');
const {pipeline} = require('node:stream/promises');
const {promisify} = require('node:util');
const {ZipFile} = require('yazl');

const BookArchive = require('../server/core/RustBookArchive');
const {sevenZipCommandCandidates} = require('../server/core/ExternalTools');
const exec = promisify(execFile);
const legacyName = require('iconv-lite');

function engine(binary) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
}

async function writeZip(file, entries, options = {}) {
    const zip = new ZipFile();
    const done = pipeline(zip.outputStream,require('node:fs').createWriteStream(file));
    for (const [name, bytes, metadata] of entries) zip.addBuffer(bytes,name,metadata);
    zip.end(options);
    await done;
}

function book(number, lines) {
    const body = Array.from({length:lines},(_,i)=>`<p>Глава ${number}: строка ${i}. Текст книги ${3*i+number}.</p>\n`).join('');
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><FictionBook><body><section>${body}</section></body></FictionBook>`);
}

async function createSevenZip(root, command, names, payloads, solid, destination = `books-${solid ? 'solid' : 'separate'}.7z`) {
    const source = join(root,'inputs');
    await fs.mkdir(source,{recursive:true});
    await Promise.all(names.map((name,index)=>fs.writeFile(join(source,name),payloads[index])));
    const output = join(root,destination);
    await exec(command,['a','-t7z','-mx=1','-md=1m','-mmt=1',`-ms=${solid ? 'on' : 'off'}`,output,...names],{cwd:source,windowsHide:true});
    return output;
}

async function extract(worker, archive, name, options) {
    const file = await worker.extractBook(archive,name,worker.config.libDir,options);
    try {return await fs.readFile(file);}
    finally {await fs.unlink(file);}
}

async function verify(worker,root,sevenZip) {
    const payload = book(42,8000);
    const zip = join(root,'books.zip');
    await writeZip(zip,[['stored.fb2',payload,{compress:false}],['deflated.fb2',payload],['empty.fb2',Buffer.alloc(0)],
        ['nested/книга.fb2',payload],['link.fb2',Buffer.from('stored.fb2'),{mode:0o120777}]],{forceZip64Format:true});
    const nativeOutput = join(worker.config.tempDir,'native');
    for (const name of ['stored.fb2','deflated.fb2','nested/книга.fb2']) {
        assert.equal(await BookArchive.extract(zip,name,nativeOutput),true);
        assert.deepEqual(await fs.readFile(nativeOutput),payload);
        await fs.unlink(nativeOutput);
        assert.deepEqual(await extract(worker,'books.zip',name,{prefixBytes:257,maxOutputBytes:2048}),payload.subarray(0,257));
    }
    assert.deepEqual(await extract(worker,'books.zip','empty.fb2'),Buffer.alloc(0));
    await assert.rejects(extract(worker,'books.zip','deflated.fb2',{maxOutputBytes:1000}),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
    await assert.rejects(extract(worker,'books.zip','link.fb2'),{code:'INPX_ARCHIVE_ENTRY_TYPE'});
    await assert.rejects(extract(worker,'books.zip','missing.fb2'),/file not found in archive/);
    await assert.rejects(extract(worker,'books.zip','../deflated.fb2'),{code:'INPX_LIBRARY_PATH'});

    const cp866 = join(root,'cp866.zip');
    await writeZip(cp866,[['ABCDE.fb2',payload]]);
    const encoded = await fs.readFile(cp866);
    for (const [flagOffset,nameOffset] of [[6,30],[8,46]]) {
        const signature = flagOffset === 6 ? 0x04034b50 : 0x02014b50;
        const at = encoded.indexOf(Buffer.from('ABCDE.fb2')) - nameOffset;
        assert.equal(encoded.readUInt32LE(at),signature);
        encoded.writeUInt16LE(encoded.readUInt16LE(at+flagOffset) & ~0x800,at+flagOffset);
        legacyName.encode('Книга.fb2','cp866').copy(encoded,at+nameOffset);
    }
    await fs.writeFile(cp866,encoded);
    assert.equal(await BookArchive.extract(cp866,'Книга.fb2',nativeOutput),true);
    assert.deepEqual(await fs.readFile(nativeOutput),payload);
    await fs.unlink(nativeOutput);

    const corrupt = join(root,'corrupt.zip');
    const marker = Buffer.from('book with a broken CRC');
    await writeZip(corrupt,[['bad.fb2',marker,{compress:false}]]);
    const damaged = await fs.readFile(corrupt);
    damaged[damaged.indexOf(marker)] ^= 1;
    await fs.writeFile(corrupt,damaged);
    await assert.rejects(extract(worker,'corrupt.zip','bad.fb2'),{code:'INPX_ARCHIVE_READ'});
    assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);

    const changing = join(root,'changing.zip');
    const replacement = join(root,'replacement.zip');
    const old = Buffer.from('old'), current = Buffer.from('new');
    for (const [file,bytes] of [[changing,old],[replacement,current]]) {
        await writeZip(file,[['book.fb2',bytes,{compress:false}]]);
        await fs.utimes(file,1_700_000_000,1_700_000_000);
    }
    assert.deepEqual(await extract(worker,'changing.zip','book.fb2'),old);
    await fs.rename(replacement,changing);
    assert.deepEqual(await extract(worker,'changing.zip','book.fb2'),current);
    const raw = join(root,'raw.fb2');
    await fs.writeFile(raw,payload);
    assert.deepEqual(await extract(worker,'raw.fb2',''),payload);
    assert.deepEqual(await extract(worker,'raw.fb2','',{prefixBytes:101}),payload.subarray(0,101));
    const signal = AbortSignal.abort(new Error('cancel fixture'));
    await assert.rejects(extract(worker,'books.zip','deflated.fb2',{signal}));
    assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);

    const names = ['a.fb2','b.fb2','книга.fb2'];
    const entries = [book(1,10_000),Buffer.alloc(0),payload];
    for (const solid of [false,true]) {
        const archive = await createSevenZip(root,sevenZip,names,entries,solid,`books-${solid}.zip`);
        for (let index = 0; index < names.length; index++) {
            const name = names[index];
            assert.equal(await BookArchive.extract(archive,name,nativeOutput),true);
            assert.deepEqual(await fs.readFile(nativeOutput),entries[index]);
            await fs.unlink(nativeOutput);
            assert.deepEqual(await extract(worker,basename(archive),name,{prefixBytes:113}),entries[index].subarray(0,113));
        }
        await assert.rejects(extract(worker,basename(archive),names[2],{maxOutputBytes:1000}),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
    }
    assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);
    console.log('ok Rust book archive: ZIP64, stored/deflate, UTF-8/CP866, CRC, limits, cache replacement, direct files and solid/non-solid 7z');
}

async function benchmark(worker,root,sevenZip,binary) {
    const small = Buffer.from('<FictionBook/>');
    const stub = Array.from({length:6000},(_,i)=>[`stub${i}.fb2`,small,{compress:false}]);
    const names = Array.from({length:80},(_,i)=>`${1000+i}.fb2`);
    const payloads = names.map((_,i)=>book(i,1000+i*10));
    const zip = 'books.zip';
    await writeZip(join(root,zip),[...stub,...names.map((name,i)=>[name,payloads[i]])]);
    const solid = basename(await createSevenZip(root,sevenZip,names,payloads,true));
    const separate = basename(await createSevenZip(root,sevenZip,names,payloads,false));
    const raw = 'raw.fb2';
    await fs.writeFile(join(root,raw),payloads.at(-1));
    const measure = async(stage, archive, prefixBytes, rounds, start=0) => {
        const samples = [[],[]];
        for (let round = -8; round < rounds; round++) {
            const index = start + Math.abs(round*37) % (names.length-start);
            const name = stage==='raw-file' ? '' : names[index];
            const expected = stage==='raw-file' ? payloads.at(-1) : payloads[index];
            for (const mode of round % 2 ? [1,0] : [0,1]) {
                engine(mode ? binary : null);
                const begin = performance.now();
                const output = await worker.extractBook(archive,name,root,{prefixBytes});
                const elapsed = performance.now() - begin;
                try {assert.deepEqual(await fs.readFile(output),prefixBytes ? expected.subarray(0,prefixBytes) : expected);}
                finally {await fs.unlink(output);}
                if (round>=0) samples[mode].push(elapsed);
            }
        }
        const stats = values => {
            values.sort((a,b)=>a-b);
            return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};
        };
        console.log(JSON.stringify({stage,before:stats(samples[0]),after:stats(samples[1])}));
    };
    await measure('zip-6080-entries',zip,0,80);
    await measure('zip-64k-prefix',zip,65536,80);
    await measure('7z-non-solid',separate,0,40);
    await measure('7z-solid',solid,0,40);
    await measure('7z-solid-late-64k-prefix',solid,65536,40,60);
    await measure('raw-file',raw,0,80);
}

async function benchmarkLibrary(worker,binary,items) {
    assert(items.length,'Pass archive:entry pairs for the library measurement');
    const digests = new Map();
    const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
    for (const item of items) {
        const [archive,name] = item.split(':');
        assert(archive && name);
        const output = join(worker.config.tempDir,'probe');
        assert.equal(await BookArchive.extract(join(worker.config.libDir,archive),name,output),true,`Native decoder required for ${item}`);
        const book = await fs.readFile(output);
        await fs.unlink(output);
        digests.set(item,{full:hash(book),prefix:hash(book.subarray(0,65536)),size:book.length});
    }
    for (const [stage,prefixBytes] of [['full',0],['prefix-64k',65536]]) {
        const samples = [[],[]];
        for (let round=-1;round<4;round++) {
            for (const [index,item] of items.entries()) {
                const [archive,name] = item.split(':');
                for (const mode of (round+index)%2 ? [1,0] : [0,1]) {
                    engine(mode ? binary : null);
                    const begin = performance.now();
                    const output = await worker.extractBook(archive,name,worker.config.libDir,{prefixBytes});
                    const duration = performance.now()-begin;
                    try {assert.equal(hash(await fs.readFile(output)),digests.get(item)[prefixBytes ? 'prefix' : 'full']);}
                    finally {await fs.unlink(output);}
                    if (round>=0) samples[mode].push(duration);
                }
            }
        }
        const stats = values => {
            values.sort((a,b)=>a-b);
            return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};
        };
        console.log(JSON.stringify({stage,pairedSamples:samples[0].length,bookSizes:items.map(item=>digests.get(item).size),before:stats(samples[0]),after:stats(samples[1])}));
    }
}

async function main(file,mode,library,...items) {
    assert(file,'Usage: node scripts/rust-book-archive-tests.js <inpx-catalog> [benchmark | library-benchmark <dir> <archive:entry> ...]');
    require('../server/core/Logger');
    await new (require('../server/core/AppLogger'))().init({loggingEnabled:false,name:'rust-book-archive'});
    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const sevenZip = sevenZipCommandCandidates({}).find(command=>spawnSync(command,['i'],{windowsHide:true,stdio:'ignore'}).status===0);
    assert(sevenZip,'7-Zip is required to build the compatibility test fixtures');
    const binary = resolve(file);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-book-archive-'));
    const tempDir = join(root,'output');
    await fs.mkdir(tempDir);
    worker.config = {libDir:library ? resolve(library) : root,tempDir,converterPaths:{sevenZip}};
    engine(binary);
    const close = BookArchive.start();
    try {
        if (mode==='benchmark') await benchmark(worker,root,sevenZip,binary);
        else if (mode==='library-benchmark') await benchmarkLibrary(worker,binary,items);
        else await verify(worker,root,sevenZip);
    } finally {
        await close();
        assert.equal(dirname(root),resolve(tmpdir()));
        await fs.rm(root,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
