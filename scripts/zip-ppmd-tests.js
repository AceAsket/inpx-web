const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {promisify} = require('util');
const {pipeline} = require('stream/promises');
const execFile = promisify(require('child_process').execFile);
const ZipReader = require('../server/core/ZipReader');
const resources = require('../server/core/ResourceRuntime');
const {runProcess} = require('../server/core/ConversionRuntime');

const xml = Buffer.from('<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><author><first-name>Test</first-name><last-name>Author</last-name></author><book-title>PPMd book</book-title><annotation><p>PPMd annotation.</p></annotation><lang>ru</lang></title-info></description><body><section><p>' + 'Тестовый текст. '.repeat(50000) + '</p></section></body></FictionBook>');
async function temporary(work) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-ppmd-test-'));
    try { await work(dir); } finally { await fs.remove(dir); }
}
async function ppmd(dir, entries) {
    const input = await fs.mkdtemp(path.join(dir, 'input-'));
    const file = input + '.zip';
    for (const [name, data] of Object.entries(entries)) await fs.outputFile(path.join(input, name), data);
    for (const bin of new ZipReader().sevenZipCommands) {
        try {
            await execFile(bin, ['a', '-tzip', '-mm=PPMd', '-y', '-bd', file, '.'], {cwd:input, windowsHide:true, timeout:15000});
            return {file, bin};
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new Error('7-Zip is required for ZIP PPMd regression tests');
}
async function ordinary(file, content, compress = true) {
    const zip = new (require('yazl').ZipFile)();
    const done = pipeline(zip.outputStream, fs.createWriteStream(file));
    zip.addBuffer(content, 'plain.fb2', {compress}); zip.end(); await done;
}

async function testZipPpmdBufferFilePrefixAndMixedArchive() {
    await temporary(async dir => {
        const {file, bin} = await ppmd(dir, {'book.fb2':xml, 'book[1].fb2':Buffer.from('literal square brackets')});
        await fs.writeFile(path.join(dir, 'plain.fb2'), 'stored plain entry');
        await execFile(bin, ['a', '-tzip', '-mm=Copy', '-y', '-bd', file, 'plain.fb2'], {cwd:dir, windowsHide:true});
        const reader = new ZipReader();
        try {
            await reader.open(file, false);
            assert.equal(reader.archiveType, 'zip'); assert.equal(reader.uses7z, true);
            assert.deepEqual(await reader.extractToBuf('book.fb2'), xml);
            assert.deepEqual(await reader.extractPrefixToBuf('book.fb2', 257), xml.subarray(0,257));
            assert.equal((await reader.extractPrefixToBuf('book[1].fb2',100)).toString(),'literal square brackets');
            const output = path.join(dir, 'download.fb2');
            await reader.extractToFile('book.fb2', output);
            assert.deepEqual(await fs.readFile(output),xml);
            await reader.extractAllToDir(path.join(dir,'all'));
            assert.deepEqual(await fs.readFile(path.join(dir,'all','book.fb2')),xml);
            reader.run7zCommand = async() => assert.fail('Stored entries retain the Node.js fast path');
            assert.equal((await reader.extractToBuf('plain.fb2')).toString(),'stored plain entry');
            await assert.rejects(reader.extractToBuf('absent.fb2'), /Entry not found/);
        } finally { await reader.close(); }
        assert.equal(reader.uses7z,false); assert.equal(reader.archiveFile,'');
    });
}

async function testZipPpmdLimitsBoundBufferFileAndAllowPrefix() {
    await temporary(async dir => {
        const {file} = await ppmd(dir, {'book.fb2':xml});
        const reader = new ZipReader({resourceMaxOutputBytes:4096});
        const output=path.join(dir,'limited.fb2');
        try {
            await reader.open(file);
            await assert.rejects(reader.extractToBuf('book.fb2'),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            await assert.rejects(reader.extractToFile('book.fb2',output),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            assert.equal(await fs.pathExists(output),false);
            assert.deepEqual(await reader.extractPrefixToBuf('book.fb2',512),xml.subarray(0,512));
            // Even if the metadata lies, native stdout must remain bounded.
            const original=reader.zip.entry.bind(reader.zip);
            reader.zip.entry=async name=>({...await original(name),size:1});
            await assert.rejects(reader.extractToBuf('book.fb2'),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            await assert.rejects(reader.extractToFile('book.fb2',output),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            assert.equal(await fs.pathExists(output),false,'A failed file extraction leaves no partial result');
        } finally {await reader.close();}
        assert.equal(resources.active,0); assert.equal(resources.queue.length,0);
    });
}

async function testZipPpmdMissingToolAndCorruptZipDoNotFallbackSilently() {
    await temporary(async dir => {
        const {file}=await ppmd(dir,{'book.fb2':xml});
        const reader=new ZipReader();
        Object.defineProperty(reader,'sevenZipCommands',{value:[path.join(dir,'missing-7z')]});
        try {await reader.open(file);await assert.rejects(reader.extractToBuf('book.fb2'),{code:'INPX_MISSING_7Z'});}
        finally {await reader.close();}
        const normal=path.join(dir,'normal.zip');await ordinary(normal,Buffer.from('normal original'),false);
        const data=await fs.readFile(normal),offset=30+data.readUInt16LE(26)+data.readUInt16LE(28);
        data[offset]^=1;await fs.writeFile(normal,data);
        reader.run7zCommand=async()=>assert.fail('A CRC failure is not an unsupported compression method');
        try {await reader.open(normal);assert.equal(reader.uses7z,false);await assert.rejects(reader.extractToBuf('plain.fb2'),/CRC/);}
        finally {await reader.close();}
        const broken=path.join(dir,'broken.zip');await fs.writeFile(broken,'not a zip');
        await assert.rejects(reader.open(broken),/archive/i);
        assert.equal(reader.zip,null);assert.equal(reader.archiveFile,'');
        await ordinary(normal,Buffer.from('recovered'),true);
        try {await reader.open(normal);assert.equal((await reader.extractToBuf('plain.fb2')).toString(),'recovered');}
        finally {await reader.close();}
    });
}

async function testZipPpmdCorruptionDoesNotPublishPartialFile() {
    await temporary(async dir => {
        const {file}=await ppmd(dir,{'book.fb2':xml});
        const reader=new ZipReader({resourceTimeoutMs:5000});
        const bytes=await fs.readFile(file),begin=30+bytes.readUInt16LE(26)+bytes.readUInt16LE(28);
        bytes[begin+Math.floor((bytes.length-begin)/4)]^=32;
        await fs.writeFile(file,bytes);
        const output=path.join(dir,'bad.fb2');
        try {await reader.open(file);await assert.rejects(reader.extractToFile('book.fb2',output));assert.equal(await fs.pathExists(output),false);}
        finally {await reader.close();}
        assert.equal(resources.active,0);
    });
}

async function testZipPpmdCancellationAndTimeoutKeepSharedBudget() {
    await temporary(async dir => {
        const {file}=await ppmd(dir,{'book.fb2':xml});
        for(const cancel of [true,false]) {
            const control=new AbortController(),ready=path.join(dir,cancel?'cancel-ready':'timeout-ready');
            const reader=new ZipReader({resourceSignal:control.signal,resourceTimeoutMs:cancel?5000:300});
            const native=reader.run7zCommand.bind(reader);
            Object.defineProperty(reader,'sevenZipCommands',{value:[process.execPath]});
            reader.extractArgs=()=>['-e',`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`];
            try {
                await reader.open(file);
                const pending=reader.extractToBuf('book.fb2');
                const rejected=assert.rejects(pending,{code:cancel?'ABORT_ERR':'INPX_CONVERSION_TIMEOUT'});
                if(cancel){for(let i=0;i<100&&!await fs.pathExists(ready);i++)await new Promise(resolve=>setTimeout(resolve,10));assert(await fs.pathExists(ready));control.abort();}
                await rejected;
                assert.equal(resources.active,0);assert.equal(resources.queue.length,0);
            } finally {reader.run7zCommand=native;await reader.close();}
        }
    });
}

async function testZipPpmdParallelReadsShareGlobalProcessLimit() {
    await temporary(async dir => {
        const {file}=await ppmd(dir,{'book.fb2':xml});
        const previous=resources.settings;
        resources.settings={...previous,limits:{...previous.limits,total:1,reviews:1}};
        let peak=0;const timer=setInterval(()=>{peak=Math.max(peak,resources.active);},1);
        const readers=Array.from({length:3},()=>new ZipReader());
        try {
            await Promise.all(readers.map(async reader=>{await reader.open(file);assert.deepEqual(await reader.extractToBuf('book.fb2'),xml);}));
            assert.equal(peak,1);assert.equal(resources.active,0);assert.equal(resources.queue.length,0);
        } finally {clearInterval(timer);resources.settings=previous;await Promise.all(readers.map(reader=>reader.close()));}
    });
}

async function testZipPpmdRatingsAndLibraryAuditUseBoundedReader() {
    await temporary(async dir => {
        const rating={folder:'collection.zip',file:'book.fb2',count:5,sum:22};
        const {file}=await ppmd(dir,{'book.fb2':xml,'books.json':JSON.stringify([rating])});
        const reader=new ZipReader();
        try {await reader.open(file);const rows=[];await require('../server/core/LibraryReviews').ratingRows(reader,value=>rows.push(value),dir);assert.deepEqual(rows,[rating]);}
        finally {await reader.close();}
        const cache=new Map(),control=new AbortController();
        const worker={config:{libDir:dir},resolveLibraryArchivePath:async()=>file};
        try {
            const data=await require('../server/core/LibraryBookData').read(worker,{folder:path.basename(file),file:'book',ext:'fb2'},cache,control.signal,2*1024**2);
            assert.deepEqual(data,xml);
        } finally {await Promise.all([...cache.values()].map(s=>s.reader?.close()));}
        assert.equal(resources.active,0);
    });
}

async function testZipPpmdEpubMetadataAndStandardRepack() {
    await temporary(async dir => {
        const entries={mimetype:'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
            'OPS/book.opf':'<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>PPMd EPUB</dc:title><dc:creator>Author</dc:creator></metadata></package>',
            'OPS/chapter.xhtml':'<html><body>Text</body></html>'};
        const {file}=await ppmd(dir,entries);
        assert.equal((await require('../server/core/BookMetadata').epubMetadata(file)).title,'PPMd EPUB');
        assert.equal(await require('../server/core/EpubRestorer').restore(file,{tempDir:dir}),true);
        const reader=new ZipReader();
        try {await reader.open(file);assert.equal(reader.uses7z,false);for(const [name,text]of Object.entries(entries))assert.equal((await reader.extractToBuf(name)).toString(),text);}
        finally {await reader.close();}
    });
}

async function testZipPpmdPreviewPreparationAndHttpDownload() {
    await temporary(async dir => {
        const {file}=await ppmd(dir,{'1.fb2':xml});
        const worker=Object.create(require('../server/core/WebWorker').prototype);
        worker.config={libDir:dir,tempDir:path.join(dir,'tmp'),bookDir:path.join(dir,'books'),publicFilesDir:dir,publicDir:dir,rootPathStatic:'',bookPathStatic:'/book',converterPaths:{}};
        await Promise.all([worker.config.tempDir,worker.config.bookDir].map(p=>fs.ensureDir(p)));
        worker.libraryAssetGeneration=1;worker.checkMyState=()=>true;worker.scheduleCacheClean=()=>{};
        worker.fb2Helper=new (require('../server/core/fb2/Fb2Helper'))();
        const record={_uid:'ppmd',_recordHash:'v1',file:'1',folder:path.basename(file),ext:'fb2',title:'PPMd book',author:'Test Author',sourceLibDir:dir};let hash;
        worker.db={esc:JSON.stringify,select:async({table})=>table==='book'?[record]:hash?[hash]:[],insert:async({rows})=>{hash=rows[0];}};
        const app=require('express')();require('../server/static')(app,worker.config,worker);
        const server=require('http').createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        try {
            const preview=(await worker.getBookPreview('ppmd')).bookPreview;
            assert.equal(preview.annotation,'PPMd annotation.');
            const response=await fetch(`http://127.0.0.1:${server.address().port}/book/by-uid?uid=ppmd&format=raw`);
            assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),xml);
            const prepared=await worker.getPreparedBookFile('ppmd','fb2');assert.deepEqual(await fs.readFile(prepared.rawFile),xml);
            assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);
        } finally {await worker.bookPreview?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    });
}

module.exports=[testZipPpmdBufferFilePrefixAndMixedArchive,testZipPpmdLimitsBoundBufferFileAndAllowPrefix,
    testZipPpmdMissingToolAndCorruptZipDoNotFallbackSilently,testZipPpmdCorruptionDoesNotPublishPartialFile,
    testZipPpmdCancellationAndTimeoutKeepSharedBudget,testZipPpmdParallelReadsShareGlobalProcessLimit,testZipPpmdRatingsAndLibraryAuditUseBoundedReader,
    testZipPpmdEpubMetadataAndStandardRepack,testZipPpmdPreviewPreparationAndHttpDownload];
