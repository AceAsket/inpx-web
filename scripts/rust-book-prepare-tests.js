const assert = require('node:assert/strict');
const {execFile,spawnSync} = require('node:child_process');
const fs = require('node:fs/promises');
const {join,dirname,resolve} = require('node:path');
const {tmpdir} = require('node:os');
const {pipeline} = require('node:stream/promises');
const {promisify} = require('node:util');
const {gzipSync} = require('node:zlib');
const {isUtf8} = require('node:buffer');
const iconv = require('iconv-lite');
const {ZipFile} = require('yazl');
const StreamZip = require('node-stream-zip');

const fb2 = new (require('../server/core/fb2/Fb2Helper'))();
const native = require('../server/core/RustBookCache');
const archive = require('../server/core/RustBookArchive');
const epub = require('../server/core/EpubRestorer');
const {sevenZipCommandCandidates} = require('../server/core/ExternalTools');
const exec = promisify(execFile);

function engine(binary) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
}

function document(encoding,withBinary = false) {
    return `  <?XmL version="1.0" Encoding = '${encoding}'?><FictionBook><body><p>Книга и иллюстрации. Ёжик</p></body>${withBinary ? '<BINARY id="p">eA==</BINARY>' : ''}</FictionBook>`;
}

async function verifyFb2(directory) {
    const file = join(directory,'book.fb2');
    for (const encoding of ['utf-8','windows-1251','koi8-r','cp866','utf-16le','utf-16be','iso-8859-5','maccyrillic']) {
        for (const zipped of [false,true]) {
            const raw = iconv.encode(document(encoding,zipped),encoding,{addBOM:encoding.startsWith('utf-')});
            const input = zipped ? gzipSync(raw) : raw;
            const expected = fb2.checkEncoding(raw);
            await fs.writeFile(file,input);
            assert.deepEqual(await native.normalizeFb2(file),{hasBinary:zipped},encoding);
            assert.deepEqual(await fs.readFile(file),expected,encoding);
            assert.deepEqual(await native.normalizeFb2(file),{hasBinary:zipped});
            assert.deepEqual(await fs.readFile(file),expected);
        }
    }
    const mislabeled = Buffer.from(document('windows-1251'));
    await fs.writeFile(file,mislabeled);
    assert.deepEqual(await native.normalizeFb2(file),{hasBinary:false});
    assert.deepEqual(await fs.readFile(file),fb2.checkEncoding(mislabeled));
    const unknown = Buffer.concat([Buffer.from('<?xml encoding="invalid-cp"?><FictionBook>'),Buffer.from([0xfe]),Buffer.from('</FictionBook>')]);
    await fs.writeFile(file,unknown);
    assert.equal(await native.normalizeFb2(file),null);
    assert.deepEqual(await fs.readFile(file),unknown);
    const invalid = gzipSync(mislabeled);
    invalid[invalid.length-8] ^= 1;
    await fs.writeFile(file,invalid);
    await assert.rejects(native.normalizeFb2(file));
    assert.deepEqual(await fs.readFile(file),invalid);
    assert(!(await fs.readdir(directory)).some(name=>name.startsWith('.book-cache-')));
    console.log('ok Rust FB2 preparation: UTF-8, Cyrillic code pages, UTF-16 BOM, gzip, idempotence, fallback and failed-write isolation');
}

const mime = 'application/epub+zip';
const indexKey = 'FLibraryImageIndex.json';
const image = Buffer.from('unchanged external image payload');

function contents(count,withIndex) {
    const prefix = withIndex ? '1234/' : '';
    const entries = {
        [prefix+'mimetype']:mime,
        [prefix+'META-INF/container.xml']:'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
        [prefix+'OPS/book.opf']:'<package><metadata><title>Test</title></metadata></package>',
        [prefix+'OPS/empty.css']:'',
    };
    for (let i=0;i<count;i++) entries[`${prefix}OPS/chapter-${i}.xhtml`] = `<html><p>${i}. ${'Текст главы '.repeat(1024)}</p></html>`;
    if (withIndex) {
        entries[prefix+'OPS/illustration-4.png'] = image;
        entries[prefix+'OPS/illustration-0.png'] = '';
        entries[indexKey] = JSON.stringify(Array.from({length:5},(_,num)=>({num,id:`${prefix}OPS/illustration-${num}.png`})))
            .replace('"num":0','"num":0.0');
    }
    return entries;
}

async function writeZip(file,entries) {
    const zip = new ZipFile();
    const done = pipeline(zip.outputStream,require('node:fs').createWriteStream(file));
    for (const [name,data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data),name,{compress:name!=='mimetype'});
    zip.end();
    await done;
}

async function writeSeven(directory,file,entries,command,container) {
    const stage = await fs.mkdtemp(join(directory,'archive-input-'));
    for (const [name,data] of Object.entries(entries)) {
        const destination = join(stage,name);
        await fs.mkdir(dirname(destination),{recursive:true});
        await fs.writeFile(destination,data);
    }
    await exec(command,['a',...(container==='zip-pm' ? ['-tzip','-mm=PPMd'] : ['-t7z','-m0=LZMA2','-ms=on']),
        '-mx=3','-mmt=1',file,'.'],{cwd:stage,windowsHide:true});
}

async function extractEntries(file) {
    const opened = new StreamZip.async({file});
    try {
        const entries = Object.values(await opened.entries());
        assert.equal(entries[0].name,'mimetype');
        assert.equal(entries[0].method,0);
        return Object.fromEntries(await Promise.all(entries.map(async entry=>[entry.name,await opened.entryData(entry.name)])));
    } finally {await opened.close();}
}

async function verifyEpub(directory,binary,sevenZip) {
    const plain = join(directory,'standard.epub');
    await writeZip(plain,contents(4,false));
    const before = await fs.readFile(plain);
    assert.equal(await epub.restore(plain,{tempDir:directory}),false);
    assert.deepEqual(await fs.readFile(plain),before);

    const canonical = contents(6,true);
    for (const container of ['zip','7z','zip-pm']) {
        const first = join(directory,`${container}-first.epub`);
        const second = join(directory,`${container}-second.epub`);
        if (container==='zip') await writeZip(first,canonical);
        else await writeSeven(directory,first,canonical,sevenZip,container);
        await fs.copyFile(first,second);
        const probe = join(directory,'native-probe');
        const plan = await native.prepareEpub(binary,first,probe);
        assert.equal(plan.kind,'repacked',container);
        assert.deepEqual(plan.images.map(item=>item.num),[0,1,2,3]);
        await fs.unlink(probe);
        let batch = 0;
        const options = {tempDir:directory,converterPaths:{sevenZip}};
        async function run(file) {
            return await epub.restore(file,options,async()=>image, async missing=>{
                batch++;
                assert.deepEqual(missing.map(item=>item.num),[0,1,2,3]);
            });
        }
        engine();
        assert(await run(first));
        engine(binary);
        assert(await run(second));
        assert.equal(batch,2);
        assert.deepEqual(await extractEntries(second),await extractEntries(first));
    }

    const broken = join(directory,'invalid-image-path.epub');
    await writeZip(broken,{...canonical,[indexKey]:'[{"id":"../library.png","num":1}]'});
    const intact = await fs.readFile(broken);
    await assert.rejects(epub.restore(broken,{tempDir:directory}),/Некорректный путь/);
    assert.deepEqual(await fs.readFile(broken),intact);
    await writeZip(broken,{...canonical,[indexKey]:' '.repeat(4 * 1024 * 1024 + 1)});
    await assert.rejects(epub.restore(broken,{tempDir:directory}),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
    await writeZip(broken,canonical);
    const missing = await fs.readFile(broken);
    await assert.rejects(epub.restore(broken,{tempDir:directory}),/Не найдено изображение EPUB/);
    assert.deepEqual(await fs.readFile(broken),missing);
    assert(!(await fs.readdir(directory)).some(name=>name.startsWith('.epub-') || name.startsWith('epub-images-')));
    console.log('ok Rust EPUB preparation: intact standard EPUB, ZIP/PPMd and solid 7z repack, external images, bounded metadata and transactional errors');
}

async function benchmark(directory,binary,sevenZip,library,items) {
    const originals = [];
    for (const [index,item] of items.entries()) {
        const [container,name] = item.split(':');
        const path = join(directory,`fb2-${index}`);
        assert(await archive.extract(join(library,container),name,path));
        originals.push(await fs.readFile(path));
    }
    const sample = join(directory,'sample');
    async function compare(stage,rounds,inputs,run,verify) {
        const samples = [[],[]];
        for (let round=-2;round<rounds;round++) {
            for (const [index,input] of inputs.entries()) {
                for (const mode of (round+index)%2 ? [1,0] : [0,1]) {
                    await fs.writeFile(sample,input);
                    engine(mode ? binary : null);
                    const start=performance.now();
                    const result = await run(sample,mode);
                    const duration = performance.now()-start;
                    await verify(sample,index,result);
                    if (round>=0) samples[mode].push(duration);
                }
            }
        }
        const stats = values => {values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};};
        console.log(JSON.stringify({stage,pairedSamples:samples[0].length,before:stats(samples[0]),after:stats(samples[1])}));
    }
    if (originals.length) {
        const expected = await Promise.all(originals.map(async data=>fb2.checkEncoding(await fb2.decompressIfNeeded(data))));
        console.log(JSON.stringify({stage:'fb2-fixtures',sizes:originals.map(data=>data.length),
            utf8:originals.map(data=>isUtf8(data)),rewritten:originals.map((data,i)=>!data.equals(expected[i]))}));
        let fallback = 0;
        await compare('fb2-normalize',10,originals,async(path,mode)=>{
            if (await native.normalizeFb2(path)) return;
            if (mode) fallback++;
            const bytes = await fs.readFile(path);
            const output = fb2.checkEncoding(await fb2.decompressIfNeeded(bytes));
            if (!output.equals(bytes)) await fs.writeFile(path,output);
        },async(path,index)=>assert.deepEqual(await fs.readFile(path),expected[index]));
        console.log(JSON.stringify({stage:'fb2-fallback-count-including-warmup',fallback}));
    }
    const standard = join(directory,'plain.epub');
    const indexed = join(directory,'indexed.epub');
    const solid = join(directory,'solid.epub');
    await writeZip(standard,contents(128,false));
    await writeZip(indexed,contents(128,true));
    await writeSeven(directory,solid,contents(128,true),sevenZip,'7z');
    for (const [stage,path] of [['epub-ordinary',standard],['epub-indexed',indexed],['epub-solid',solid]]) {
        const input = await fs.readFile(path);
        const options = {tempDir:directory,converterPaths:{sevenZip}};
        engine();
        await fs.writeFile(sample,input);
        const changed = await epub.restore(sample,options,async()=>image);
        const expected = changed ? await extractEntries(sample) : input;
        await compare(stage,stage==='epub-ordinary' ? 40 : 12,[input],
            file=>epub.restore(file,options,async()=>image),async(file,_index,result)=>{
                assert.equal(result,changed);
                assert.deepEqual(changed ? await extractEntries(file) : await fs.readFile(file),expected);
            });
    }
}

async function main(file,mode,library,...items) {
    assert(file,'Usage: node scripts/rust-book-prepare-tests.js <catalog-binary> [benchmark [<library-dir> <archive:entry> ...]]');
    const binary = resolve(file);
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-prepare-book-'));
    const sevenZip = sevenZipCommandCandidates({}).find(command=>spawnSync(command,['i'],{windowsHide:true,stdio:'ignore'}).status===0);
    assert(sevenZip,'7-Zip is required to build the EPUB fixtures');
    engine(binary);
    const stop = native.start();
    const stopArchive = library ? archive.start() : null;
    try {
        if (mode==='benchmark') await benchmark(root,binary,sevenZip,library,items);
        else {
            await verifyFb2(root);
            await verifyEpub(root,binary,sevenZip);
        }
    } finally {
        await Promise.all([stop(),stopArchive?.()]);
        assert.equal(dirname(root),resolve(tmpdir()));
        await fs.rm(root,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
