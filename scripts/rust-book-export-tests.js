const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {randomBytes} = require('node:crypto');
const {tmpdir} = require('node:os');
const {basename,join,resolve} = require('node:path');
const Zip = require('node-stream-zip');
const batch = require('../server/core/BatchDownload');
const nativeBatch = require('../server/core/RustBatchArchive');
const epub = require('../server/core/EpubToFb2');
const epubTests = require('./epub-fb2-tests');
const ioTests = require('./rc13-io-tests');
const libraryTests = require('./library-improvements-tests');

async function withEngine(binary, run) {
    const previous = process.env.INPX_RUST_CATALOG_BINARY;
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
    try {return await run();}
    finally {
        if (previous === undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY = previous;
    }
}

async function packageBooks(binary, directory, books) {
    const worker = {checkMyState() {}, config:{tempDir:directory,bookPathStatic:'/book',bookFilenameTemplate:'${AUTHOR} ${TITLE}'},
        getPreparedBookFile:async uid => books[uid]};
    return withEngine(binary,async()=>{
        const {url,count} = await batch.create(worker,'reader',{bookUids:['second','first','second']});
        assert.equal(count,2);
        const zip = new Zip.async({file:join(directory,`batch-${basename(url)}.zip`)});
        try {
            const entries = Object.values(await zip.entries());
            return await Promise.all(entries.map(async({name,attr,time})=>({name,attr,time,text:(await zip.entryData(name)).toString()})));
        } finally {await zip.close(); await batch.cleanup(Date.now()+16*60*1000);}
    });
}

async function checkBatch(binary,directory) {
    const book = {ext:'fb2',author:'Автор',title:'Одна книга',series:'Серия'};
    const a = join(directory,'a.fb2'), b = join(directory,'b.fb2');
    await Promise.all([fs.writeFile(a,'first'),fs.writeFile(b,'second')]);
    const books = {first:{book,rawFile:a},second:{book,rawFile:b}};
    const baseline = await packageBooks(null,directory,books);
    const actual = await packageBooks(binary,directory,books);
    assert.deepEqual(actual,baseline);
    assert.deepEqual(actual.map(item=>[item.name,item.text]),[['Серия/Автор Одна книга.fb2','second'],['Серия/Автор Одна книга_2.fb2','first']]);

    const file = join(directory,'random.fb2'), output = join(directory,'batch-failure.zip');
    await fs.writeFile(file,randomBytes(256*1024));
    const stat = await fs.stat(file);
    let calls = 0;
    async function* entries(source) {
        for (const name of ['a.fb2','b.fb2','c.fb2']) {
            calls++;
            yield {name,source,stat};
        }
    }
    await assert.rejects(nativeBatch.write(binary,output,512,entries(file)),/Кэш пакетных ZIP заполнен/);
    assert.equal(calls,1,'Output failure stops preparation before the next book');
    await assert.rejects(fs.access(output),{code:'ENOENT'});
    await assert.rejects(nativeBatch.write(binary,output,1024*1024,entries(join(directory,'missing.fb2'))),{code:'ENOENT'});
    await assert.rejects(fs.access(output),{code:'ENOENT'});
    async function* interrupted() {
        yield {name:'a.fb2',source:a,stat:await fs.stat(a)};
        throw new Error('book preparation failed');
    }
    await assert.rejects(nativeBatch.write(binary,output,1024*1024,interrupted()),/book preparation failed/);
    await assert.rejects(fs.access(output),{code:'ENOENT'});
    assert.equal(await nativeBatch.write(binary,output,1024*1024,entries(file)),(await fs.stat(output)).size);
    await withEngine(binary,async()=>{
        await ioTests.find(test=>test.name==='testBatchExpiryCleanupAndTicketCountBudget')();
        await libraryTests.find(test=>test.name==='testBatchDownloadScopeAndArchive')();
    });
}

async function checkEpub(binary,directory) {
    await withEngine(binary,async()=>{for (const test of epubTests) await test();});
    const input = join(directory,'book.epub'), actual = join(directory,'native.fb2'), baseline = join(directory,'legacy.fb2');
    const encoded = Buffer.from('\uFEFF<?xml version="1.0" encoding="UTF-16"?><html><body>\n<h1>Глава</h1><p>Слово<!-- comment --> и <![CDATA[сноска]]> &NotEqualTilde;</p><ol start="3"><li>Номер<p>Абзац</p></li></ol><blockquote><blockquote><pre>Строка\n  Строка</pre></blockquote></blockquote></body></html>','utf16le');
    for (const replacement of [{},{'OPS/chapter2.xhtml':encoded}]) {
        await epubTests.fixture(input,[],replacement);
        await withEngine(null,()=>epub.convert(input,baseline));
        await withEngine(binary,()=>epub.convert(input,actual));
        assert.deepEqual(await fs.readFile(actual),await fs.readFile(baseline),'Rust preserves EPUB content and reader positions');
        await Promise.all([fs.rm(actual),fs.rm(baseline)]);
    }
    assert.deepEqual((await fs.readdir(directory)).filter(name=>name.startsWith('.book-cache-')),[]);
}

async function main() {
    const binary = resolve(process.argv[2]);
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-book-export-'));
    try {
        await checkBatch(binary,directory);
        await checkEpub(binary,directory);
        console.log('Rust book export tests passed');
    } finally {await fs.rm(directory,{force:true,recursive:true});}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
