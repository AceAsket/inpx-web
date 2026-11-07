const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {pipeline} = require('stream/promises');
const {BookMetadata, epubMetadata} = require('../server/core/BookMetadata');
const {ReaderSpeech} = require('../server/core/ReaderSpeech');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-rc13-io-'));
    try {return await task(dir);} finally {await fs.remove(dir);}
}
function makeWorker() {return Object.create(require('../server/core/WebWorker').prototype);}

async function testBookInfoCacheWithRootReusesParsedCover() {
    await temporary(async dir => {
        const worker = makeWorker(), bookDir = path.join(dir, 'book');
        await fs.ensureDir(bookDir);
        worker.config = {publicFilesDir:dir, bookDir, bookPathStatic:'/shelf/book', branch:'production'};
        worker.checkMyState = () => {};
        worker.applyPreparedBookSize = () => {};
        worker.extractFb2Contents = () => []; worker.extractFb2AnnotationMeta = () => null;
        worker.applyMetadataOverrideToBook = () => {};
        worker.readingListStore = {getMetadataOverrides:async () => ({})};
        worker.getBookLink = async () => ({link:'/shelf/book/abcd', size:10});
        worker.db = {esc:JSON.stringify, select:async () => [{id:1, _uid:'test', ext:'fb2'}]};
        let parses = 0;
        worker.fb2Helper = {getDescAndCover:async () => {parses++; return {fb2:{rawNodes:[]}, cover:Buffer.from('cover'), coverExt:'.jpg'};}};
        const first = await worker.buildBookInfo('test', {readerOnly:true});
        const second = await worker.buildBookInfo('test', {readerOnly:true});
        assert.strictEqual(parses, 1, 'A URL prefix must not turn every reader request into an XML parse');
        assert.strictEqual(first.bookInfo.contentVersion, second.bookInfo.contentVersion);
        assert.match(first.bookInfo.contentVersion, /^abcd:/);
    });
}

async function testMetadataCacheBytesExpiryAndGeneration() {
    await temporary(async dir => {
        const fixture = path.join(dir, 'fixture.fb2');
        await fs.writeFile(fixture, '<FictionBook><description><title-info><annotation><p>' + 'я'.repeat(400000)
            + '</p></annotation></title-info></description><body><p>Текст.</p></body></FictionBook>');
        let copies = 0;
        const worker = {config:{tempDir:dir}, libraryAssetGeneration:1, extractBook:async () => {
            const file = path.join(dir, `copy-${copies++}`); await fs.copy(fixture, file); return file;
        }};
        const metadata = new BookMetadata(worker);
        try {
            for (let i = 0; i < 16; i++) await metadata.read({_uid:String(i), file:String(i), folder:'books.zip', ext:'fb2'});
            assert(metadata.cache.bytes <= 8 * 1024 ** 2);
            assert(metadata.cache.size < 16, 'Large annotations must be evicted before reaching the entry-count limit');
            const last = {_uid:'15', file:'15', folder:'books.zip', ext:'fb2'};
            const before = copies; await metadata.read(last); assert.strictEqual(copies, before);
            worker.libraryAssetGeneration++;
            await metadata.read(last); assert.strictEqual(copies, before + 1); assert.strictEqual(metadata.cache.size, 1);
            for (const item of metadata.cache.metadata.values()) item.at -= 16 * 60 * 1000;
            metadata.cache.prune(); assert.strictEqual(metadata.cache.size, 0); assert.strictEqual(metadata.cache.bytes, 0);
        } finally {metadata.cache.close();}
    });
}

async function testRepackedEpubMetadataLimitsByNameAndActualBytes() {
    const ZipReader = require('../server/core/ZipReader');
    const open = ZipReader.prototype.open, extract = ZipReader.prototype.extractToBuf;
    let containerSize = 80, packageSize = 5 * 1024 ** 2, actualPackageSize = packageSize, extractedPackage = false;
    ZipReader.prototype.open = async function() {
        this.archiveType = '7z'; this.archiveFile = 'fixture';
        this.zipEntries = {0:{name:'META-INF/container.xml', size:containerSize}, 1:{name:'package.opf', size:packageSize}};
    };
    ZipReader.prototype.extractToBuf = async function(name) {
        if (name === 'META-INF/container.xml') return Buffer.from('<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>');
        extractedPackage = true;
        return Buffer.from('<package><metadata><title>' + 'x'.repeat(actualPackageSize) + '</title></metadata></package>');
    };
    try {
        await assert.rejects(epubMetadata('fixture.epub', {}), /превышают лимит/);
        assert.strictEqual(extractedPackage, false, 'Reject the declared 7z size before allocating its contents');
        packageSize = 10;
        await assert.rejects(epubMetadata('fixture.epub', {}), /превышают лимит/);
        assert.strictEqual(extractedPackage, true, 'Also verify actual data when archive size metadata is wrong');
        containerSize = 2 * 1024 ** 2;
        await assert.rejects(epubMetadata('fixture.epub', {}), /превышают лимит/);
    } finally {ZipReader.prototype.open = open; ZipReader.prototype.extractToBuf = extract;}
    await temporary(async dir => {
        const file = path.join(dir, 'normal.epub'), zip = new (require('yazl').ZipFile)();
        const done = pipeline(zip.outputStream, fs.createWriteStream(file));
        zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>'), 'META-INF/container.xml');
        zip.addBuffer(Buffer.from('<package><metadata><dc:title>Valid</dc:title></metadata></package>'), 'package.opf');
        zip.end(); await done;
        assert.strictEqual((await epubMetadata(file, {})).title, 'Valid');
    });
}

async function testSpeechPartsReuseVersionAndKeepUsersOptionsSeparate() {
    await temporary(async dir => {
        const speech = new ReaderSpeech({dataDir:dir, ttsEnabled:true, ttsUrl:'unused'}, {});
        const fb2 = text => [[1,'FictionBook',[],[[1,'body',[],[[1,'section',[],[[1,'p',[],[[2,text]]]]]]]]]];
        try {
            const first = {fb2:fb2('Старая глава. '.repeat(300)), contentVersion:'hash-1:v1'};
            const nextEnvelope = {fb2:fb2('Старая глава. '.repeat(300)), contentVersion:'hash-1:v1'};
            const parts = speech.parts(first, 'online');
            assert.strictEqual(speech.parts(nextEnvelope, 'online'), parts, 'Reloading JSON for another fragment must reuse the parsed split');
            assert(Object.isFrozen(parts) && Object.isFrozen(parts[0]));
            assert.notStrictEqual(speech.parts(first, 'chapters'), parts);
            const changed = speech.parts({fb2:fb2('Новая глава.'), contentVersion:'hash-2:v1'}, 'online');
            assert.strictEqual(changed[0].text, 'Новая глава.');
            const calls = [];
            speech.prepareText = async (...args) => {calls.push(args); return {user:args[0]};};
            assert.deepStrictEqual(await speech.preparePart('alice', 'book', first, 'xenia', 'online', 0, {pitch:'low'}), {user:'alice'});
            assert.deepStrictEqual(await speech.preparePart('bob', 'book', nextEnvelope, 'xenia', 'online', 0, {pitch:'high'}), {user:'bob'});
            assert.strictEqual(calls[0][5].pitch, 'low'); assert.strictEqual(calls[1][5].pitch, 'high');
            const plan = await speech.plan(first, 'online'); plan.chapters[0].anchor.textSnippet = 'modified';
            assert.notStrictEqual((await speech.plan(nextEnvelope, 'online')).chapters[0].anchor.textSnippet, 'modified');
            assert(speech.partsCache.bytes + speech.planCache.bytes <= 16 * 1024 ** 2);
        } finally {speech.partsCache.close(); speech.planCache.close();}
    });
}

async function testDiscoveryCachesBoundBytesCoalesceAndInvalidate() {
    await temporary(async dir => {
        const worker = makeWorker(); worker.config = {dataDir:dir}; worker.libraryAssetGeneration = 1;
        const key = i => `discovery:current:external:${i}`;
        try {
            const loader = i => async () => ({items:[{title:String(i), description:'я'.repeat(400000)}]});
            for (let i = 0; i < 16; i++) await worker.rememberPersistedDiscovery(key(i), loader(i));
            assert(worker.discoveryCache.bytes <= 8 * 1024 ** 2);
            assert(Object.keys(worker.discoveryDiskCache).length < 16);
            assert((await fs.stat(path.join(dir, 'discovery-cache.json'))).size <= 8 * 1024 ** 2);
            let calls = 0, release;
            const load = () => {calls++; return new Promise(resolve => {release = resolve;});};
            const pending = worker.rememberPersistedDiscovery(key('shared'), load);
            while (!release) await new Promise(resolve => setImmediate(resolve));
            const second = worker.rememberPersistedDiscovery(key('shared'), load);
            await new Promise(resolve => setImmediate(resolve)); release({items:[]});
            await Promise.all([pending, second]); assert.strictEqual(calls, 1);
            worker.discoveryDiskCache['discovery:previous:external:0'] = {time:Date.now(), value:{items:['old']}};
            await worker.rememberPersistedDiscovery(key('new'), async () => ({items:['new']}));
            assert(!Object.keys(worker.discoveryDiskCache).some(item => item.startsWith('discovery:previous:')));
            let resolveOld;
            const old = worker.rememberDiscovery('old-job', () => new Promise(resolve => {resolveOld = resolve;}));
            while (!resolveOld) await new Promise(resolve => setImmediate(resolve));
            worker.resetLibraryAssetCaches(); resolveOld({items:['obsolete']}); await old;
            assert.strictEqual(worker.discoveryCache.size, 0);
            worker.discoveryDiskCache = {expired:{time:Date.now() - 10 * 24 * 3600000, ttl:1000, value:{items:['expired']}}};
            await assert.rejects(worker.rememberPersistedDiscovery('expired', async () => {throw new Error('offline');}, 1000), /offline/);
            assert.strictEqual(Object.keys(worker.discoveryDiskCache).length, 0);
        } finally {worker.discoveryCache?.close?.(); worker.authorInfoCache?.close?.();}
    });
}

async function testBatchExpiryCleanupAndTicketCountBudget() {
    await temporary(async dir => {
        const batch = require('../server/core/BatchDownload'), book = path.join(dir, 'book.fb2');
        await fs.writeFile(book, 'book');
        const worker = {checkMyState() {}, config:{tempDir:dir, bookPathStatic:'/book'},
            getPreparedBookFile:async () => ({rawFile:book, book:{ext:'fb2', title:'Book', author:'Author'}})};
        await batch.cleanup(Date.now() + 16 * 60 * 1000);
        for (let i = 0; i < 256; i++) await batch.create(worker, 'reader', {bookUids:['book']});
        await assert.rejects(batch.create(worker, 'reader', {bookUids:['book']}), /Кэш пакетных ZIP заполнен/);
        assert.strictEqual((await fs.readdir(dir)).filter(name => name.startsWith('batch-')).length, 256);
        await batch.cleanup(Date.now() + 16 * 60 * 1000);
        assert.strictEqual((await fs.readdir(dir)).filter(name => name.startsWith('batch-')).length, 0);
        assert((await batch.create(worker, 'reader', {bookUids:['book']})).url);
        await batch.cleanup(Date.now() + 16 * 60 * 1000);
    });
}

async function testCoverCacheInvalidatesStableUidAndRejectsObsoleteWork() {
    await temporary(async dir => {
        let calls=0, release;
        const worker={config:{publicFilesDir:dir},libraryAssetGeneration:1,
            getBookCover:async () => ({contentType:'image/png',data:Buffer.from(`version-${++calls}`)})};
        const metadata=new BookMetadata(worker);
        const book={_uid:'stable',sourceId:'source',folder:'books.zip',file:'1',ext:'fb2',_recordHash:'old',size:100};
        try {
            assert.equal((await metadata.cover(book)).data.toString(),'version-1');
            assert.equal((await metadata.cover(book)).data.toString(),'version-1');assert.equal(calls,1);
            const changed={...book,_recordHash:'new',size:200};
            assert.equal((await metadata.cover(changed)).data.toString(),'version-2');
            worker.libraryAssetGeneration++;
            assert.equal((await metadata.cover(changed)).data.toString(),'version-3','Reindex must also invalidate unchanged row metadata');
            const resetWorker=Object.assign(makeWorker(),worker,{getBookRecordByUid:async()=>changed,requireAdmin:async()=>{},checkMyState:()=>{},addAdminEvent:()=>{}});
            metadata.worker=resetWorker;
            const reset=await resetWorker.rebuildCoverCacheForBook('admin','token',changed._uid);
            assert(reset.removed>=1,'Manual cover cleanup must include ABS generation variants');
            assert.equal((await metadata.cover(changed)).data.toString(),'version-4','A manual reset must invalidate the pending/disk namespace');
            const before=await fs.readdir(path.join(dir,'cover'));
            resetWorker.getBookCover=async () => new Promise(resolve=>{release=resolve;});
            const obsolete=metadata.cover({...changed,_recordHash:'pending'});
            const rejected=assert.rejects(obsolete,{code:'INPX_LIBRARY_CHANGED'});
            while(!release) await new Promise(resolve=>setImmediate(resolve));
            resetWorker.libraryAssetGeneration++;release({contentType:'image/png',data:Buffer.from('obsolete')});
            await rejected;
            assert.deepEqual(await fs.readdir(path.join(dir,'cover')),before,'Obsolete preparation must not publish its cache file');
            const {coverCacheKey}=require('../server/core/BookAssets');
            assert.notEqual(coverCacheKey(book),coverCacheKey(changed),'Static and ABS caches both include the record revision');
            assert.equal(coverCacheKey(book),coverCacheKey({...book,size:999,inpxSize:book.size}),'Prepared size must not change a record-hash cache key');
            const legacy={...book};delete legacy._recordHash;
            assert.equal(coverCacheKey(legacy),coverCacheKey({...legacy,size:999,inpxSize:legacy.size}),'Legacy source-size fallback also ignores restored EPUB size');
        } finally {metadata.cache.close();}
    });
}

async function testBatchDiskFailureStopsPreparationAndClosesInputStreams() {
    await temporary(async dir => {
        const batch=require('../server/core/BatchDownload'), file=path.join(dir,'book.fb2');
        await fs.writeFile(file,require('crypto').randomBytes(1024**2));
        const write=fs.createWriteStream,read=fs.createReadStream;
        const inputs=[];let calls=0;
        const worker={checkMyState(){},config:{tempDir:dir,bookPathStatic:'/book'},getPreparedBookFile:async () => {
            calls++;await new Promise(resolve=>setTimeout(resolve,20));
            return {rawFile:file,book:{ext:'fb2',title:'Book',author:'Author'}};
        }};
        fs.createReadStream=function(candidate,...args){const stream=read.call(this,candidate,...args);if(candidate===file)inputs.push(stream);return stream;};
        fs.createWriteStream=function(candidate,...args){
            if(path.basename(candidate).startsWith('batch-'))return new (require('stream').Writable)({write(chunk,encoding,callback){callback(Object.assign(new Error('fixture disk full'),{code:'ENOSPC'}));}});
            return write.call(this,candidate,...args);
        };
        try {
            await assert.rejects(batch.create(worker,'reader',{bookUids:['1','2','3','4','5']}),{code:'ENOSPC'});
            assert(calls<=2,'Do not prepare the rest of a selection after output fails');
            assert(inputs.length>0);assert(inputs.every(stream=>stream.destroyed&&stream.closed),'Failure must close every active source descriptor before returning');
            assert.equal((await fs.readdir(dir)).filter(name=>name.startsWith('batch-')).length,0);
        } finally {fs.createWriteStream=write;fs.createReadStream=read;}
        assert((await batch.create(worker,'reader',{bookUids:['1']})).url,'Batch creation recovers after an output failure');
        await batch.cleanup(Date.now()+16*60*1000);
    });
}

async function testStaticCoversRejectChangedDatabaseGenerationAndManualReset() {
    await temporary(async dir => {
        const worker=makeWorker(), config={libDir:dir,publicDir:dir,publicFilesDir:dir,rootPathStatic:'',bookPathStatic:'/book',bookDir:path.join(dir,'book'),coverDir:path.join(dir,'cover')};
        const book={_uid:'stable',_recordHash:'record',ext:'fb2',folder:'books.zip',file:'1'};
        let phase='', calls=0;
        worker.db={};worker.libraryAssetGeneration=1;worker.coverCacheGeneration=0;
        worker.getBookRecordByUid=async()=>{if(phase==='lookup')worker.db={};return book;};
        worker.runBackground=async work=>{if(phase==='queue')worker.libraryAssetGeneration++;return work();};
        worker.getBookCover=async()=>{
            calls++;
            if(phase==='generation')worker.libraryAssetGeneration++;
            if(phase==='manual')worker.coverCacheGeneration++;
            return {contentType:'image/png',data:Buffer.from('cover')};
        };
        const app=require('express')();require('../server/static')(app,config,worker);
        const server=require('http').createServer(app);
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const url=`http://127.0.0.1:${server.address().port}/cover/by-uid?uid=stable`;
        const cache=path.join(config.coverDir,require('../server/core/BookAssets').coverCacheKey(book)+'.png');
        const write=fs.writeFile,utimes=fs.utimes;
        fs.writeFile=async function(candidate,...args){const value=await write.call(this,candidate,...args);if(phase==='publish'&&path.resolve(candidate)===path.resolve(cache))worker.coverCacheGeneration++;return value;};
        fs.utimes=async function(candidate,...args){const value=await utimes.call(this,candidate,...args);if(phase==='cached'&&path.resolve(candidate)===path.resolve(cache))worker.db={};return value;};
        try {
            for(const scenario of ['lookup','queue','generation','manual','publish','cached']){
                phase=scenario;calls=0;
                if(phase==='cached')await fs.outputFile(cache,'previously cached');
                const response=await fetch(url);
                assert.equal(response.status,503,scenario);
                assert.equal(response.headers.get('cache-control'),'no-store',scenario);
                assert.equal(response.headers.get('retry-after'),'1',scenario);
                await response.text();
                assert.equal(calls,['lookup','queue','cached'].includes(scenario)?0:1,scenario);
                if(scenario==='publish')assert.equal(await fs.pathExists(cache),false,'Remove a file published after the manual-reset generation changed');
            }
        } finally {
            fs.writeFile=write;fs.utimes=utimes;
            server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
        }
    });
}

async function galleryWorker(dir,xml,record={}) {
    const worker=makeWorker();
    worker.config={libDir:dir,bookDir:path.join(dir,'cache'),tempDir:dir};await fs.ensureDir(worker.config.bookDir);
    worker.checkMyState=()=>{};worker.libraryAssetGeneration=1;worker.fb2Helper=new (require('../server/core/fb2/Fb2Helper'))();
    worker.galleryRecord={id:1,_uid:'gallery',_recordHash:'v1',ext:'fb2',file:'123',folder:'books.7z',...record};
    worker.db={esc:JSON.stringify,select:async()=>[worker.galleryRecord]};worker.dbConfig=async()=>({inpxHash:'library-v1'});
    worker.scheduleCacheClean=()=>{};worker.getBookAssetArchives=async()=>[];worker.getFblibraryArchives=async()=>[];
    worker.getBookInfo=worker.getBookLink=async()=>assert.fail('Preview must not restore or load the complete reader document');
    worker.galleryExtractions=0;
    worker.extractBook=async(folder,file,source,options)=>{
        assert.equal(options.maxOutputBytes,32*1024**2);worker.galleryExtractions++;
        const fileName=path.join(dir,`raw-${worker.galleryExtractions}`);await fs.writeFile(fileName,xml);return fileName;
    };
    return worker;
}
const galleryXml=binaries=>`<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><coverpage><image l:href="#cover"/></coverpage></title-info></description><body><section><p>text</p></section></body>${binaries}</FictionBook>`;
const galleryBinary=(id,data,type='image/png')=>`<binary id="${id}" content-type="${type}">${data.toString('base64')}</binary>`;

async function testLazyGalleryBoundsSidecarsCoalescesAndReusesRevisionCache() {
    await temporary(async dir=>{
        const worker=await galleryWorker(dir,galleryXml(''));
        const archive=path.join(dir,'images.zip'),zip=new (require('yazl').ZipFile)();
        const complete=pipeline(zip.outputStream,fs.createWriteStream(archive));
        const image=Buffer.alloc(32768,42);Buffer.from('89504e470d0a1a0a','hex').copy(image);
        for(let i=0;i<40;i++)zip.addBuffer(image,`123/${i}`);zip.end();await complete;
        worker.getBookAssetArchives=async()=>[{file:archive}];
        const Reader=require('../server/core/ZipReader'),original=Reader.prototype.extractToBuf;
        let extracted=0;Reader.prototype.extractToBuf=async function(...args){extracted++;return original.apply(this,args);};
        try {
            const results=await Promise.all(Array.from({length:3},()=>worker.getBookGallery('gallery')));
            assert.equal(worker.galleryExtractions,1);assert.equal(extracted,18,'Only preview illustrations are extracted');
            assert.equal(results[0].images.length,18);assert.equal(results[0].limited,true);assert.equal(results[0].omitted,22);
            assert.equal(worker.bookGallery.pending.size,0);
            results[0].images[0].id='mutated';assert.notEqual(results[1].images[0].id,'mutated');
            const warm=await worker.getBookGallery('gallery');assert.equal(warm.images[0].id,'0');assert.equal(extracted,18);
            assert.equal((await fs.readdir(worker.config.bookDir)).filter(file=>file.endsWith('.gallery.json')).length,1);
            assert(!(await fs.readdir(worker.config.bookDir)).some(file=>file.endsWith('.i.json')),'No complete reader JSON is materialized');
            worker.galleryRecord._recordHash='v2';await worker.getBookGallery('gallery');assert.equal(worker.galleryExtractions,2);
        } finally {Reader.prototype.extractToBuf=original;}
    });
}

async function testLazyGallerySkipsWholeOversizeImagesAndBoundsAggregateBytes() {
    await temporary(async dir=>{
        const image=Buffer.alloc(2*1024**2,42);Buffer.from('89504e470d0a1a0a','hex').copy(image);
        const tooLarge=Buffer.concat([image,Buffer.from([0])]);
        const binaries=galleryBinary('cover',image)+galleryBinary('oversize',tooLarge)+galleryBinary('unsafe',Buffer.from('<svg/>'),'image/svg+xml')+
            Array.from({length:5},(_,i)=>galleryBinary(String(i),image)).join('')+galleryBinary('0',image);
        const worker=await galleryWorker(dir,galleryXml(binaries));
        const result=await worker.getBookGallery('gallery');
        assert.equal(result.images.length,4);assert(result.limited);assert(result.omitted>=3);
        assert.equal(result.images.reduce((sum,image)=>sum+Buffer.byteLength(image.data,'base64'),0),8*1024**2);
        assert(!result.images.some(image=>['cover','oversize','unsafe'].includes(image.id)));
        assert(result.images.every(image=>Buffer.byteLength(image.data,'base64')===2*1024**2),'Images are skipped, never truncated');
        assert((await fs.stat(path.join(worker.config.bookDir,(await fs.readdir(worker.config.bookDir))[0]))).size<12*1024**2);
        const remote=await galleryWorker(path.join(dir,'remote'),'',{});remote.remoteLib={};
        assert.deepEqual(await remote.getBookGallery('gallery'),{images:[],limited:true,omitted:1});assert.equal(remote.galleryExtractions,0);
    });
}

async function testLazyGalleryRejectsRawExpansionAndStalePublication() {
    await temporary(async dir=>{
        const raw=require('zlib').gzipSync(Buffer.alloc(33*1024**2,32));
        const worker=await galleryWorker(dir,raw);
        assert.deepEqual(await worker.getBookGallery('gallery'),{images:[],limited:true,omitted:1});
        assert(!(await fs.readdir(dir)).some(file=>file.startsWith('raw-')));
        const stale=await galleryWorker(path.join(dir,'stale'),galleryXml(''));
        const rename=fs.rename;
        fs.rename=async function(source,target,...args){const value=await rename.call(this,source,target,...args);if(String(target).endsWith('.gallery.json'))stale.libraryAssetGeneration++;return value;};
        try {await assert.rejects(stale.getBookGallery('gallery'),{code:'INPX_LIBRARY_CHANGED'});}
        finally {fs.rename=rename;}
        assert.equal((await fs.readdir(stale.config.bookDir)).filter(file=>file.endsWith('.gallery.json')).length,0);
        assert.equal(stale.bookGallery.pending.size,0);
    });
}

async function testLazyGallerySaxIgnoresCommentAndBodyMarkupAndReadsBinaryCdata() {
    await temporary(async dir=>{
        const image=Buffer.from('89504e470d0a1a0a','hex'),fake=galleryBinary('fake',image);
        const xml=galleryXml(galleryBinary('cover',image)+`<binary id="real" content-type="image/png"><![CDATA[${image.toString('base64')}]]></binary>`+
            galleryBinary('real',image)+`<!-- ${fake} -->`)
            .replace('<p>text</p>',`<p><![CDATA[${fake}]]></p>${galleryBinary('nested',image)}`);
        const worker=await galleryWorker(dir,xml);
        const result=await worker.getBookGallery('gallery');
        assert.deepEqual(result.images,[{id:'real',contentType:'image/png',data:image.toString('base64')}]);
        assert.equal(result.limited,false);assert.equal(result.omitted,0);
    });
}

async function testLazyGalleryLargeCdataAndTextStayChunkedInsideSax() {
    await temporary(async dir=>{
        const image=Buffer.alloc(384*1024,42);Buffer.from('89504e470d0a1a0a','hex').copy(image);
        const xml=galleryXml('<binary id="oversize" content-type="image/png"><![CDATA['+'A'.repeat(4*1024**2)+']]></binary>'+galleryBinary('good',image))
            .replace('<p>text</p>','<p>'+'x'.repeat(1024**2)+'</p><p><![CDATA['+'y'.repeat(1024**2)+']]></p>');
        const worker=await galleryWorker(dir,xml),sax=require('sax'),create=sax.parser;
        let maximumWrite=0,maximumTextEvent=0,maximumCdataEvent=0,maximumInternalBuffer=0,textEvents=0,cdataEvents=0;
        sax.parser=function(...args){
            const parser=create.apply(this,args),write=parser.write;
            for(const name of ['ontext','oncdata']){
                let callback;
                Object.defineProperty(parser,name,{configurable:true,get:()=>callback,set:handler=>{
                    callback=function(value){
                        if(name==='ontext'){textEvents++;maximumTextEvent=Math.max(maximumTextEvent,value.length);}
                        else {cdataEvents++;maximumCdataEvent=Math.max(maximumCdataEvent,value.length);}
                        return handler.call(this,value);
                    };
                }});
            }
            parser.write=function(chunk){
                maximumWrite=Math.max(maximumWrite,chunk?.length||0);
                const value=write.call(this,chunk);
                maximumInternalBuffer=Math.max(maximumInternalBuffer,this.textNode.length,this.cdata.length);
                return value;
            };
            return parser;
        };
        try {
            const result=await worker.getBookGallery('gallery');
            assert.deepEqual(result.images,[{id:'good',contentType:'image/png',data:image.toString('base64')}]);
            assert.equal(result.limited,true);assert.equal(result.omitted,1,'One oversize binary is skipped, the following image survives chunk boundaries');
            assert(textEvents>4&&cdataEvents>4,'Both large text and CDATA must be flushed repeatedly');
            assert(maximumWrite<=65536,'The parser must not receive the entire multi-megabyte XML in one write');
            assert(maximumTextEvent<=131072&&maximumCdataEvent<=131072,'Internal SAX buffers must flush before reaching the image collector limit');
            assert(maximumInternalBuffer<=65536,'SAX buffer checks must remain enabled after each write');
        } finally {sax.parser=create;}
    });
}

async function testZipPreviewLimitAndFolderExtractionLimitDoNotChangeFullReads() {
    await temporary(async dir=>{
        const archive=path.join(dir,'input.zip'),zip=new (require('yazl').ZipFile)();
        const complete=pipeline(zip.outputStream,fs.createWriteStream(archive));zip.addBuffer(Buffer.alloc(4096),'book.fb2');zip.end();await complete;
        const Reader=require('../server/core/ZipReader'),bounded=new Reader({resourceMaxOutputBytes:1024}),full=new Reader();
        try {
            await bounded.open(archive,false);await assert.rejects(bounded.extractToBuf('book.fb2'),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            const entry=bounded.zip.entry;bounded.zip.entry=async()=>({size:1});
            try {await assert.rejects(bounded.extractToBuf('book.fb2'),{code:'INPX_RESOURCE_OUTPUT_LIMIT'},'Actual streamed bytes must also be capped');}
            finally {bounded.zip.entry=entry;}
            await full.open(archive,false);assert.equal((await full.extractToBuf('book.fb2')).length,4096);
        } finally {await bounded.close();await full.close();}
        const worker=makeWorker();worker.config={libDir:dir,tempDir:path.join(dir,'tmp')};await fs.ensureDir(worker.config.tempDir);
        worker.resolveLibraryArchivePath=async folder=>folder;worker.resolveExistingPath=async file=>file;
        await fs.outputFile(path.join(dir,'folder','book.fb2'),Buffer.alloc(4096));
        await assert.rejects(worker.extractBook('folder','book.fb2','',{maxOutputBytes:1024}),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
        assert.deepEqual(await fs.readdir(worker.config.tempDir),[]);
        const extracted=await worker.extractBook('folder','book.fb2');assert.equal((await fs.stat(extracted)).size,4096);await fs.remove(extracted);
    });
}

module.exports = [testBookInfoCacheWithRootReusesParsedCover, testMetadataCacheBytesExpiryAndGeneration,
    testRepackedEpubMetadataLimitsByNameAndActualBytes, testSpeechPartsReuseVersionAndKeepUsersOptionsSeparate,
    testDiscoveryCachesBoundBytesCoalesceAndInvalidate, testBatchExpiryCleanupAndTicketCountBudget,
    testCoverCacheInvalidatesStableUidAndRejectsObsoleteWork,testBatchDiskFailureStopsPreparationAndClosesInputStreams,
    testStaticCoversRejectChangedDatabaseGenerationAndManualReset,
    testLazyGalleryBoundsSidecarsCoalescesAndReusesRevisionCache,testLazyGallerySkipsWholeOversizeImagesAndBoundsAggregateBytes,
    testLazyGalleryRejectsRawExpansionAndStalePublication,testLazyGallerySaxIgnoresCommentAndBodyMarkupAndReadsBinaryCdata,
    testLazyGalleryLargeCdataAndTextStayChunkedInsideSax,testZipPreviewLimitAndFolderExtractionLimitDoNotChangeFullReads];
