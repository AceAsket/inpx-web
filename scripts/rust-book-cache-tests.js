const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {dirname,join,resolve} = require('node:path');
const {gzipSync,gunzipSync} = require('node:zlib');
const StreamZip = require('node-stream-zip');

const cache = require('../server/core/BookFileCache');
const RustBookCache = require('../server/core/RustBookCache');
const RustBookArchive = require('../server/core/RustBookArchive');
const utils = require('../server/core/utils');

function engine(binary) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
}

function hash(bytes) {return createHash('sha256').update(bytes).digest('hex');}

const descriptor = {
    bookUid:'id-001', libFolder:'сборник.7z', libFile:'603.fb2', sourceLibDir:'импорт/флибусты',
    downFileName:'Автор_Книга & главы.fb2', assetVersion:'fixture-v1',
};
const book = Buffer.from(`<FictionBook><body>${'<p>Текст книги и теги</p>\n'.repeat(24000)}</body></FictionBook>`);

async function verify(root,temp,binary) {
    const source = join(temp,'book');
    await fs.writeFile(source,book);
    const expected = {hash:hash(book),size:book.length};
    const file = join(root,expected.hash);
    const raw = file+'.raw';
    engine();
    assert.deepEqual(await cache.publish(root,temp,source,descriptor,false),expected);
    const originalZip = await fs.readFile(file);
    engine(binary);

    assert.deepEqual(await cache.inspect(root,expected.hash,{assetVersion:'fixture-v1'}),{...descriptor,size:book.length});
    assert.equal(await cache.inspect(root,expected.hash,{assetVersion:'fixture-v2'}),null);
    await fs.utimes(file,1_700_000_000,1_700_000_000);
    await fs.utimes(file+'.d.json',1_700_000_000,1_700_000_000);
    assert.deepEqual(await cache.inspect(root,expected.hash,{touch:true}),{...descriptor,size:book.length});
    for (const name of [file,file+'.d.json']) assert((await fs.stat(name)).mtimeMs>1_700_000_000_000);
    assert(await utils.ensureGunzipFile(file,raw,book.length));
    assert.deepEqual(await fs.readFile(raw),book);
    assert.deepEqual(await cache.inspect(root,expected.hash,{touch:true,probeRaw:true}),{...descriptor,size:book.length,rawReady:true});
    assert.equal(await utils.ensureGunzipFile(file,raw,book.length),false);
    await fs.unlink(raw);
    assert.equal((await cache.inspect(root,expected.hash,{probeRaw:true})).rawReady,false);
    await fs.unlink(file+'.d.json');
    assert.equal(await cache.inspect(root,expected.hash),null);
    assert.deepEqual(await fs.readFile(file),originalZip);

    const changed = {...descriptor,assetVersion:'fixture-v2'};
    const second = join(temp,'second');
    await fs.writeFile(second,book);
    assert.deepEqual(await Promise.all([cache.publish(root,temp,source,changed,false),cache.publish(root,temp,second,changed,true)]),[expected,expected]);
    assert.deepEqual(await fs.readFile(file),originalZip);
    assert.deepEqual(await fs.readFile(raw),book);
    assert.deepEqual(await cache.inspect(root,expected.hash),{...changed,size:book.length});
    await fs.unlink(file);
    await fs.unlink(file+'.d.json');
    await fs.unlink(raw);

    assert.deepEqual(await cache.publish(root,temp,source,descriptor,false),expected);
    assert.deepEqual(gunzipSync(await fs.readFile(file)),book);
    engine();
    assert.deepEqual(await cache.inspect(root,expected.hash),{...descriptor,size:book.length});
    assert(await utils.ensureGunzipFile(file,raw,book.length));
    assert.deepEqual(await fs.readFile(raw),book);
    engine(binary);

    const output = join(root,'legacy.raw');
    const input = join(temp,'legacy-gz');
    const pieces = Buffer.concat([gzipSync(book.subarray(0,1000)),gzipSync(book.subarray(1000))]);
    await fs.writeFile(input,Buffer.concat([pieces,Buffer.from([0,0,255])]));
    assert(await utils.ensureGunzipFile(input,output,book.length));
    assert.deepEqual(await fs.readFile(output),book);
    await fs.writeFile(output,'preserve previous file');
    const bad = Buffer.from(pieces);
    bad[bad.length-8] ^= 1;
    await fs.writeFile(input,bad);
    await assert.rejects(utils.ensureGunzipFile(input,output,book.length));
    assert.equal(await fs.readFile(output,'utf8'),'preserve previous file');
    await fs.writeFile(input,pieces);
    await assert.rejects(utils.ensureGunzipFile(input,output,128),/неверный размер/);
    assert.equal(await fs.readFile(output,'utf8'),'preserve previous file');
    const first = utils.ensureGunzipFile(input,output,book.length);
    const next = utils.ensureGunzipFile(input,output,book.length);
    assert.strictEqual(first,next);
    assert(await first);
    assert.deepEqual(await fs.readFile(output),book);

    const remoteHash = '123abc';
    await fs.writeFile(join(root,remoteHash),pieces);
    await cache.registerRemote(root,remoteHash,descriptor);
    assert.deepEqual(await cache.inspect(root,remoteHash),{...descriptor,size:0});
    const zipPath = join(root,'book-download.zip');
    assert(await utils.ensureBookZipFile(source,zipPath,descriptor.downFileName));
    assert.equal(await utils.ensureBookZipFile(source,zipPath,descriptor.downFileName),false);
    const zip = new StreamZip.async({file:zipPath});
    try {
        assert.deepEqual(Object.keys(await zip.entries()),[descriptor.downFileName]);
        assert.deepEqual(await zip.entryData(descriptor.downFileName),book);
    } finally {await zip.close();}
    await assert.rejects(utils.ensureBookZipFile(source,join(root,'invalid.zip'),'../book.fb2'),/Недопустимое имя/);
    await assert.rejects(utils.ensureBookZipFile(join(temp,'missing'),join(root,'missing.zip'),'missing.fb2'),{code:'ENOENT'});
    const longDirectory = join(root,...Array.from({length:4},()=>`library-cache-${'n'.repeat(38)}`));
    await fs.mkdir(longDirectory,{recursive:true});
    assert.deepEqual(await cache.publish(longDirectory,temp,source,descriptor,false),expected);
    const longName = join(longDirectory,expected.hash);
    const longZip = `${longName}.download-v3-0123456789abcdef.zip`;
    assert(longZip.length>260);
    assert(await utils.ensureGunzipFile(longName,`${longName}.raw`,book.length));
    assert(await utils.ensureBookZipFile(`${longName}.raw`,longZip,descriptor.downFileName));
    assert((await fs.stat(longZip)).size>0);
    assert((await fs.readdir(root)).every(name=>!name.startsWith('.book-cache-')));
    console.log('ok Rust book cache: legacy and native gzip, shared SHA-256, publication, descriptor refresh, raw substitution, concatenation, CRC and length bounds');
}

async function fixtures(temp,library,items) {
    if (!library) {
        const source = join(temp,'sample.fb2');
        await fs.writeFile(source,book);
        return [{source,hash:hash(book),size:book.length}];
    }
    const books = [];
    for (const [index,item] of items.entries()) {
        const [archive,name] = item.split(':');
        assert(archive && name);
        const source = join(temp,`sample-${index}.fb2`);
        assert(await RustBookArchive.extract(join(library,archive),name,source));
        const bytes = await fs.readFile(source);
        books.push({source,hash:hash(bytes),size:bytes.length});
    }
    assert(books.length);
    return books;
}

async function benchmark(root,temp,binary,library,items) {
    const books = await fixtures(temp,library,items);
    const directories = [join(root,'legacy'),join(root,'native')];
    await Promise.all(directories.map(directory=>fs.mkdir(directory)));
    const rounds = library ? 8 : 40;
    const expected = file=>({hash:file.hash,size:file.size});
    async function compare(stage,callback,complete) {
        const timings = [[],[]];
        for (let round=-2;round<rounds;round++) {
            for (const [index,file] of books.entries()) {
                for (const mode of (round+index)%2 ? [1,0] : [0,1]) {
                    const directory = directories[mode];
                    const cached = join(directory,file.hash);
                    engine(mode ? binary : null);
                    const start=performance.now();
                    const result=await callback(file,directory,cached);
                    const elapsed=performance.now()-start;
                    await complete?.(file,cached,result);
                    if (round>=0) timings[mode].push(elapsed);
                }
            }
        }
        const stats = values=>{
            values.sort((a,b)=>a-b);
            return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};
        };
        console.log(JSON.stringify({stage,pairedSamples:timings[0].length,before:stats(timings[0]),after:stats(timings[1])}));
    }
    const sizes = [0,0];
    await compare('cold-publish', (file,directory)=>cache.publish(directory,temp,file.source,descriptor,false), async (file,cached,result)=>{
        assert.deepEqual(result,expected(file));
        const compressed = await fs.readFile(cached);
        assert.equal(hash(gunzipSync(compressed)),file.hash);
        sizes[dirname(cached)===directories[0] ? 0 : 1] += compressed.length;
        await Promise.all([fs.unlink(cached),fs.unlink(cached+'.d.json')]);
    });
    console.log(JSON.stringify({stage:'gzip-bytes',before:sizes[0],after:sizes[1]}));
    for (const file of books) {
        engine();
        for (const directory of directories) await cache.publish(directory,temp,file.source,descriptor,false);
    }
    await compare('hot-descriptor', (file,directory)=>cache.inspect(directory,file.hash,{assetVersion:descriptor.assetVersion}));
    await compare('hot-download-descriptor', (file,directory)=>cache.inspect(directory,file.hash,{touch:true}));
    await compare('cold-raw', (file,_directory,cached)=>utils.ensureGunzipFile(cached,cached+'.raw',file.size), async (file,cached,result)=>{
        assert.equal(result,true);
        assert.equal(hash(await fs.readFile(cached+'.raw')),file.hash);
        await fs.unlink(cached+'.raw');
    });
    for (const file of books) for (const directory of directories) {
        const cached = join(directory,file.hash);
        await utils.ensureGunzipFile(cached,cached+'.raw',file.size);
    }
    await compare('hot-raw', (file,_directory,cached)=>utils.ensureGunzipFile(cached,cached+'.raw',file.size));
    await compare('hot-download-raw-ready', (file,directory)=>cache.inspect(directory,file.hash,{touch:true,probeRaw:true}),
        (_file,_cached,result)=>assert.equal(result?.rawReady,true));
    await compare('cold-download-zip', (file,_directory,cached)=>utils.ensureBookZipFile(file.source,cached+'.zip',descriptor.downFileName),
        async (file,cached,result)=>{
            assert.equal(result,true);
            const zip = new StreamZip.async({file:cached+'.zip'});
            try {assert.equal(hash(await zip.entryData(descriptor.downFileName)),file.hash);}
            finally {await zip.close();}
            await fs.unlink(cached+'.zip');
        });
}

async function main(file,mode,library,...items) {
    assert(file,'Usage: node scripts/rust-book-cache-tests.js <catalog-binary> [benchmark [<library> <archive:entry> ...]]');
    const binary = resolve(file);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-book-cache-'));
    const temp = join(root,'staging');
    await fs.mkdir(temp);
    engine(binary);
    const closeCache = RustBookCache.start();
    const closeArchive = library ? RustBookArchive.start() : null;
    try {
        if (mode==='benchmark') await benchmark(root,temp,binary,library,items);
        else await verify(root,temp,binary);
    } finally {
        await Promise.all([closeCache(),closeArchive?.()]);
        assert.equal(dirname(root),resolve(tmpdir()));
        await fs.rm(root,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
