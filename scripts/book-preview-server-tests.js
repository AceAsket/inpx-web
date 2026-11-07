const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {pipeline}=require('stream/promises');
const BookPreview=require('../server/core/BookPreview');
const {limits}=require('../shared/BookPreview');
const Fb2Helper=require('../server/core/fb2/Fb2Helper');
const xml=annotation=>`<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>Book</book-title>${annotation}</title-info></description><body><section><p>body</p></section></body></FictionBook>`;
async function logger(){const value=new(require('../server/core/AppLogger'))();if(!value.inited)await value.init({loggingEnabled:false,name:'preview-server-tests'});}
async function temporary(work){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-book-preview-'));try{await work(dir);}finally{await fs.remove(dir);}}
async function workerAt(dir,content=xml('<annotation><p>First paragraph.</p><p>Second &amp; safe.</p></annotation>'),ext='fb2'){
    await logger();const worker=Object.create(require('../server/core/WebWorker').prototype);
    worker.config={libDir:dir,tempDir:path.join(dir,'tmp'),converterPaths:{}};await fs.ensureDir(worker.config.tempDir);
    worker.libraryAssetGeneration=1;worker.checkMyState=()=>{};worker.fb2Helper=new Fb2Helper();
    worker.record={_uid:'known',_recordHash:'v1',folder:'folder',file:'1',ext};
    worker.db={esc:JSON.stringify,select:async options=>{assert.equal(options.table,'book');assert.match(options.where,/@@hash\('_uid'/);return [worker.record];}};
    worker.resolveLibraryArchivePath=async value=>value;worker.resolveExistingPath=async value=>await fs.pathExists(value)?value:null;
    await fs.outputFile(path.join(dir,'folder','1.'+ext),content);
    worker.getBookInfo=worker.getBookLink=worker.restoreBook=worker.injectFblibraryImages=async()=>assert.fail('Preview may not restore a full document or images');
    return worker;
}
async function zipFile(file,items){const zip=new(require('yazl').ZipFile)(),done=pipeline(zip.outputStream,fs.createWriteStream(file));
    for(const [name,content]of items)zip.addBuffer(Buffer.from(content),name);zip.end();await done;}

async function testBookPreviewPlaintextBoundedInputAndOriginalSourceUnchanged(){
    await temporary(async dir=>{
        const original=xml('<annotation><p>First paragraph.</p><p>Second &amp; safe.</p><p>&lt;img src=x onerror=alert(1)&gt;</p></annotation>')+' '.repeat(3*1024**2);
        const worker=await workerAt(dir,original),extract=worker.extractBook.bind(worker);let size=0,calls=0;
        worker.extractBook=async(...args)=>{calls++;assert.equal(args[3].prefixBytes,limits.prefixBytes);const file=await extract(...args);size=(await fs.stat(file)).size;return file;};
        const result=(await worker.getBookPreview('known')).bookPreview;
        assert.equal(result.annotation,'First paragraph.\n\nSecond & safe.\n\n<img src=x onerror=alert(1)>');
        assert.equal(result.annotationStatus,'ready');assert.equal(result.annotationLimited,false);assert.equal(size,limits.prefixBytes);
        assert.equal(await fs.readFile(path.join(dir,'folder','1.fb2'),'utf8'),original);assert.equal(calls,1);
        assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);
        await worker.bookPreview.close();
    });
}

async function testBookPreviewZipAndGzipBombStayWithinPrefixLimits(){
    await temporary(async dir=>{
        const worker=await workerAt(dir),zip=path.join(dir,'books.zip');
        await zipFile(zip,[['1.fb2',xml('<annotation><p>From ZIP.</p></annotation>')+' '.repeat(4*1024**2)]]);
        worker.record.folder='books.zip';
        assert.equal((await worker.getBookPreview('known')).bookPreview.annotation,'From ZIP.');
        worker.record.folder='folder';worker.record._recordHash='gzip';
        const bomb=require('zlib').gzipSync(Buffer.from(xml('<annotation><p>'+'я'.repeat(3*1024**2)+'</p></annotation>')));
        await fs.writeFile(path.join(dir,'folder','1.fb2'),bomb);
        const result=(await worker.getBookPreview('known')).bookPreview;
        assert.equal(result.annotationStatus,'limited');assert(result.annotationLimited);assert.equal(result.annotation.length,6000);
        const decoded=await BookPreview.decodedPrefix(bomb,new AbortController().signal);assert.equal(decoded.length,limits.prefixBytes);
        assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);await worker.bookPreview.close();
    });
}

async function testBookPreviewXmlDepthMarkupAndEmptyAnnotationAreHonest(){
    const parse=BookPreview.annotationFromXml;
    assert.equal(parse(xml('<annotation><p><![CDATA[<script>literal text</script>]]></p></annotation>')).annotation,'<script>literal text</script>');
    assert.deepEqual(parse(xml('')),{annotation:'',annotationStatus:'empty',annotationLimited:false});
    assert.equal(parse(xml('<annotation><p>'+'a'.repeat(7000)+'</p></annotation>')).annotation.length,6000);
    assert.equal(parse(xml('<annotation>'+'<p>'.repeat(140)+'text'+'</p>'.repeat(140)+'</annotation>')).annotationStatus,'limited');
    assert.equal(parse('not an FB2 document').annotationStatus,'unavailable');
}

async function testBookPreviewArchiveReaderKeepsIndependentListingAndPrefixCaps(){
    await temporary(async dir=>{
        const worker=await workerAt(dir),Reader=require('../server/core/ZipReader');
        worker.record.folder='books.7z';await fs.writeFile(path.join(dir,'books.7z'),Buffer.from('377abcaf271c','hex'));
        const open=Reader.prototype.open,extract=Reader.prototype.extractPrefixToBuf,run=Reader.prototype.run7zCommand;
        let listingChecked=false,prefixChecked=false;
        Reader.prototype.open=async function(file,entries){
            assert.equal(entries,false,'A direct book prefix does not need an archive listing');
            this.archiveFile=file;this.archiveType='7z';
            await this.run7zStdout(['l','-slt',file]); // Verify a listing, if requested, still has a finite independent cap.
        };
        Reader.prototype.run7zCommand=async function(args,options){assert.equal(options.maxOutputBytes,32*1024**2);listingChecked=true;return Buffer.from('bounded listing');};
        Reader.prototype.extractPrefixToBuf=async function(file,maximum){assert.equal(maximum,limits.prefixBytes);prefixChecked=true;return Buffer.from(xml('<annotation><p>Archive prefix.</p></annotation>'));};
        try {assert.equal((await worker.getBookPreview('known')).bookPreview.annotation,'Archive prefix.');assert(listingChecked&&prefixChecked);}
        finally {Reader.prototype.open=open;Reader.prototype.extractPrefixToBuf=extract;Reader.prototype.run7zCommand=run;await worker.bookPreview?.close();}
        await assert.rejects(worker.extractBook('books.7z','1.fb2','',{prefixBytes:2048,maxOutputBytes:1024}),/exceeds/);
    });
}

async function testBookPreviewCacheCoalescesBoundsAndInvalidatesWithoutProfiles(){
    await temporary(async dir=>{
        const worker=await workerAt(dir),extract=worker.extractBook.bind(worker);let calls=0;
        worker.extractBook=async(...args)=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return extract(...args);};
        const service=worker.bookPreview=new BookPreview(worker,{cacheBytes:18000,ttl:25});
        const values=await Promise.all([worker.getBookPreview('known'),worker.getBookPreview('known'),worker.getBookPreview('known')]);
        assert.equal(calls,1);values[0].bookPreview.annotation='changed';assert.notEqual(values[1].bookPreview.annotation,'changed');
        await worker.getBookPreview('known');assert.equal(calls,1);
        worker.record._recordHash='v2';await worker.getBookPreview('known');assert.equal(calls,2);
        worker.libraryAssetGeneration++;await worker.getBookPreview('known');assert.equal(calls,3);
        await new Promise(resolve=>setTimeout(resolve,40));await worker.getBookPreview('known');assert.equal(calls,4);
        for(let i=0;i<20;i++){worker.record._recordHash='different-'+i;await worker.getBookPreview('known');assert(service.cache.bytes<=18000);}
        assert.equal(service.pending.size,0);assert(!JSON.stringify([...service.cache.values()]).includes('profileAccessToken'));
        await service.close();assert.equal(service.cache.bytes,0);
    });
}

async function testBookPreviewUnavailableRetriesAndQueueDeadlineDrains(){
    await temporary(async dir=>{
        const worker=await workerAt(dir);let calls=0;
        worker.extractBook=async()=>{calls++;throw new Error('PRIVATE_PATH must not be returned');};
        assert.equal((await worker.getBookPreview('known')).bookPreview.annotationStatus,'unavailable');
        assert.equal((await worker.getBookPreview('known')).bookPreview.annotationStatus,'unavailable');assert.equal(calls,2,'Retry must not reuse an unavailable result');
        await worker.bookPreview.close();worker.bookPreview=new BookPreview(worker,{timeoutMs:35});calls=0;
        worker.extractBook=async(folder,file,source,{signal})=>{calls++;await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>setTimeout(()=>reject(signal.reason),25),{once:true});});};
        const keepAlive=setTimeout(()=>{},1000);let results;const start=Date.now();
        try{results=await Promise.all(['a','b','c','d'].map(uid=>worker.getBookPreview(uid)));}finally{clearTimeout(keepAlive);}
        assert(results.every(result=>result.bookPreview.annotationStatus==='unavailable'));
        assert(Date.now()-start<400,'Queued work shares the original deadline instead of receiving another full timeout');
        assert(calls<=2,'Expired queued operations must not begin I/O');assert.equal(worker.bookPreview.active,0);assert.equal(worker.bookPreview.queue.length,0);
        assert.equal(worker.bookPreview.pending.size,0);await worker.bookPreview.close();
    });
}

async function testBookPreviewGenerationRemoteAndEpubMetadataStayControlled(){
    await temporary(async dir=>{
        const worker=await workerAt(dir),extract=worker.extractBook.bind(worker);
        worker.extractBook=async(...args)=>{const file=await extract(...args);worker.libraryAssetGeneration++;return file;};
        await assert.rejects(worker.getBookPreview('known'),{code:'INPX_LIBRARY_CHANGED'});assert.equal(worker.bookPreview.cache.size,0);assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);
        worker.remoteLib={downloadBook:()=>assert.fail('No remote download'),metadata:{request:()=>assert.fail('No unadvertised annotation API')}};
        assert.equal((await worker.getBookPreview('known')).bookPreview.annotationStatus,'unsupported');await worker.bookPreview.close();
        const epubWorker=await workerAt(path.join(dir,'epub'),'','epub');
        await zipFile(path.join(dir,'epub','folder','1.epub'),[
            ['META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'],
            ['book.opf','<package><metadata><dc:description><![CDATA[<p>EPUB &amp; metadata.</p><script>text only</script>]]></dc:description></metadata></package>'],
            ['picture.jxl','not read or decoded']]);
        const value=(await epubWorker.getBookPreview('known')).bookPreview;assert.equal(value.annotationStatus,'ready');assert.match(value.annotation,/EPUB & metadata/);assert(!value.annotation.includes('<p>'));
        assert.deepEqual(await fs.readdir(epubWorker.config.tempDir),[]);await epubWorker.bookPreview.close();
    });
}

async function testBookPreviewWebSocketChecksAccessBeforeReadBudgetAndCache(){
    await logger();const Controller=require('../server/controllers/WebSocketController'),ProfileAccess=require('../server/core/ProfileAccess');
    const controller=Object.create(Controller.prototype),sent=[];let reads=0,budgets=0,identity=null;
    const worker={getProfileSessionUser:()=>identity?.user.id||'',getBookPreview:async uid=>{reads++;return {bookPreview:{bookUid:uid,annotation:'cached library text',annotationStatus:'ready',annotationLimited:false}};}};
    const access=new ProfileAccess({allowAnonymousAccess:false},worker,{});access.resolve=async()=>identity;
    Object.assign(controller,{config:{},profileAccess:access,webWorker:worker,webAccess:{hasAccess:async()=>true},send:value=>sent.push(value)});
    const read=controller.readWithBudget.bind(controller);controller.readWithBudget=(...args)=>{budgets++;return read(...args);};
    const ws={readyState:1,req:{securitySession:{},socket:{remoteAddress:'127.0.0.1'}}};
    await controller.onMessage(ws,JSON.stringify({action:'get-book-preview',bookUid:'known'}));
    assert(sent.some(value=>value.error==='need_profile_login'));assert.equal(reads,0);assert.equal(budgets,0);
    identity={user:{id:'reader'},token:'session'};sent.length=0;
    await controller.onMessage(ws,JSON.stringify({action:'get-book-preview',bookUid:'known',userId:'reader'}));
    assert.equal(reads,1);assert.equal(budgets,1);assert(sent.some(value=>value.bookPreview?.annotation==='cached library text'));
    identity=null;sent.length=0;
    await controller.onMessage(ws,JSON.stringify({action:'get-book-preview',bookUid:'known'}));assert.equal(reads,1,'Warm cache cannot bypass revoked profile access');
}

module.exports=[testBookPreviewPlaintextBoundedInputAndOriginalSourceUnchanged,testBookPreviewZipAndGzipBombStayWithinPrefixLimits,
    testBookPreviewXmlDepthMarkupAndEmptyAnnotationAreHonest,testBookPreviewArchiveReaderKeepsIndependentListingAndPrefixCaps,
    testBookPreviewCacheCoalescesBoundsAndInvalidatesWithoutProfiles,
    testBookPreviewUnavailableRetriesAndQueueDeadlineDrains,testBookPreviewGenerationRemoteAndEpubMetadataStayControlled,
    testBookPreviewWebSocketChecksAccessBeforeReadBudgetAndCache];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})().catch(error=>{console.error(error);process.exitCode=1;});
