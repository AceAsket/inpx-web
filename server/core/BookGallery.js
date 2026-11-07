const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {promisify} = require('util');
const gunzip = promisify(require('zlib').gunzip);
const sax = require('sax');
const ZipReader = require('./ZipReader');
const imageUtils = require('./ImageUtils');
const imageRuntime = require('./ImageRuntime');
const {writeFileAtomic} = require('./FilePersistence');

const limits = {images:18, imageBytes:2 * 1024 ** 2, totalBytes:8 * 1024 ** 2,
    xmlBytes:32 * 1024 ** 2, cacheBytes:12 * 1024 ** 2};
const mimeTypes = new Set(['image/png','image/jpeg','image/gif','image/webp','image/jxl']);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u0020\u007f<>"'&\\]/.test(id);
const outputLimit = () => Object.assign(new Error('Превью иллюстраций превышает лимит'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
const isSizeLimit = error => ['INPX_RESOURCE_OUTPUT_LIMIT','INPX_RESOURCE_IMAGE_OUTPUT_LIMIT','ERR_BUFFER_TOO_LARGE'].includes(error?.code);

async function readLimited(file, maximum) {
    if ((await fs.stat(file)).size > maximum) throw outputLimit();
    const stream = fs.createReadStream(file), chunks = [];
    let bytes = 0;
    try {
        for await (const chunk of stream) {
            bytes += chunk.length;
            if (bytes > maximum) throw outputLimit();
            chunks.push(chunk);
        }
    } finally {stream.destroy();}
    return Buffer.concat(chunks, bytes);
}

function embeddedImages(xml) {
    const result={cover:'',seen:new Set(),slots:0,candidates:[],omitted:0};
    const parser=sax.parser(false,{lowercase:true}),route=[],stop={};
    const maximumChars=Math.ceil(limits.imageBytes/3)*4+65536;
    let current=null,retainedBytes=0;
    parser.onopentag=node=>{
        route.push(node.name);
        if(route.length>128)throw outputLimit();
        if(current){current.invalid=true;return;}
        const attrs=node.attributes;
        if(route.join('/')==='fictionbook/description/title-info/coverpage/image') {
            const name=Object.keys(attrs).find(key=>key==='href'||key.endsWith(':href'));
            result.cover=String(attrs[name]||'').replace(/^#/,'');
        }
        if(route.length!==2||route[0]!=='fictionbook'||node.name!=='binary')return;
        const id=String(attrs.id||''),type=String(attrs['content-type']||'').toLowerCase();
        if(!validId(id)||id===result.cover||result.seen.has(id)||!type.startsWith('image/')&&type!=='application/octet-stream')return;
        if(result.slots>=limits.images){result.omitted++;throw stop;}
        result.slots++;result.seen.add(id);
        current={id,text:[],chars:0,invalid:!mimeTypes.has(type)&&!['image/jpg','application/octet-stream'].includes(type)};
    };
    const text=value=>{
        if(!current||current.invalid)return;
        current.chars+=value.length;
        if(current.chars>maximumChars){current.invalid=true;current.text=[];}
        else current.text.push(value);
    };
    parser.ontext=text;parser.oncdata=text;
    parser.onclosetag=name=>{
        if(route.length===2&&name==='binary'&&current){
            const candidate=current;current=null;
            if(candidate.invalid){result.omitted++;}
            else {
                const data=candidate.text.join('').replace(/\s/g,'');
                const bytes=Buffer.byteLength(data,'base64');
                if(!data||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||bytes>limits.imageBytes||retainedBytes+bytes>limits.totalBytes)
                    result.omitted++;
                else {retainedBytes+=bytes;result.candidates.push({id:candidate.id,data});}
            }
        }
        route.pop();
    };
    // sax checks and flushes its own text buffers between writes. Bounded
    // writes keep an oversized binary from accumulating inside the parser
    // before our image collector can reject it.
    try {
        for(let offset=0;offset<xml.length;offset+=65536)parser.write(xml.slice(offset,offset+65536));
        parser.close();
    } catch(error){if(error!==stop)throw error;}
    return result;
}

function cachedResult(value) {
    if (value?.version !== 1 || !Array.isArray(value.images) || value.images.length > limits.images) return null;
    let bytes = 0; const ids = new Set();
    for (const image of value.images) {
        if (!validId(image.id) || ids.has(image.id) || !mimeTypes.has(image.contentType) || typeof image.data !== 'string'
            || image.data.length > Math.ceil(limits.imageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null;
        const size = Buffer.byteLength(image.data, 'base64');
        if (size > limits.imageBytes || (bytes += size) > limits.totalBytes) return null;
        ids.add(image.id);
    }
    return {images:value.images, limited:!!value.limited, omitted:Math.max(0, Math.min(1000000, Number(value.omitted) || 0))};
}

class BookGallery {
    constructor(worker) {this.worker=worker; this.pending=new Map(); this.active=0; this.queue=[];}

    async run(work) {
        if (this.active >= 2) await new Promise(resolve=>this.queue.push(resolve));
        else this.active++;
        try {return await work();}
        finally {const next=this.queue.shift(); if(next)next();else this.active--;}
    }

    async read(uid) {
        const worker=this.worker;worker.checkMyState();
        const generation=worker.libraryAssetGeneration, db=worker.db;
        const key=JSON.stringify([generation,uid]);
        if (!this.pending.has(key)) {
            if (this.pending.size >= 18) throw Object.assign(new Error('Очередь галереи заполнена. Повторите позже.'), {code:'INPX_RESOURCE_IO_QUEUE_FULL'});
            const work=()=>this.run(()=>this.build(uid,db,generation));
            const pending=Promise.resolve().then(()=>worker.runForeground(work)).finally(()=>this.pending.delete(key));
            this.pending.set(key,pending);
        }
        const result=await this.pending.get(key);
        worker.checkLibraryAssetState(generation,db);
        return {...result, images:result.images.map(image=>({...image}))};
    }

    async build(uid, db, generation) {
        const worker=this.worker, guard=()=>worker.checkLibraryAssetState(generation,db);
        guard();
        const rows=await db.select({table:'book',where:`@@hash('_uid', ${db.esc(uid)})`});
        guard();
        if (!rows.length) throw new Error('404 Файл не найден');
        const book=rows[0];
        if (worker.remoteLib || String(book.ext).toLowerCase() !== 'fb2') return {images:[],limited:true,omitted:1};
        const config=await worker.dbConfig();guard();
        const revision=crypto.createHash('sha256').update(JSON.stringify(['gallery-v1',uid,generation,config.inpxHash || '',
            book._recordHash || [book.inpxSize ?? book.size,book.date],book.sourceId,book.sourceLibDir || worker.config.libDir,
            book.folder,book.file,book.ext])).digest('hex');
        const cache=path.join(worker.config.bookDir,`${revision}.gallery.json`);
        let cached;
        try {cached=cachedResult(JSON.parse((await readLimited(cache,limits.cacheBytes)).toString('utf8')));} catch (_) { /* Regenerable bounded preview. */ }
        guard();
        if (cached) {await require('./utils').touchFile(cache);guard();return cached;}
        let extracted;
        const result={images:[],limited:false,omitted:0};
        try {
            try {
                extracted=await worker.extractBook(book.folder,`${book.file}.${book.ext}`,book.sourceLibDir,{maxOutputBytes:limits.xmlBytes});
                guard();
                let data=await readLimited(extracted,limits.xmlBytes);
                if (data[0] === 0x1f && data[1] === 0x8b) data=await gunzip(data,{maxOutputLength:limits.xmlBytes});
                data=worker.fb2Helper.checkEncoding(data);
                if (data.length > limits.xmlBytes) throw outputLimit();
                const embedded=embeddedImages(data.toString('utf8')),cover=embedded.cover,seen=embedded.seen;
                let slots=embedded.slots,totalBytes=0;
                result.omitted+=embedded.omitted;result.limited=embedded.omitted>0;
                const omit=()=>{result.limited=true;result.omitted++;};
                const add=async(id,data)=>{
                    const available=Math.min(limits.imageBytes,limits.totalBytes-totalBytes);
                    if (!available || data.length > available) {omit();return;}
                    const type=imageUtils.contentType(data);
                    if (!mimeTypes.has(type)) {omit();return;}
                    try {
                        const image=await imageRuntime.run(()=>imageUtils.normalizeForFb2(data,worker.config.tempDir,
                            worker.libraryToolDirs(book.sourceLibDir),worker.config.converterPaths,available));
                        guard();
                        if (!mimeTypes.has(image.contentType) || image.data.length > available) {omit();return;}
                        totalBytes+=image.data.length;
                        result.images.push({id,contentType:image.contentType,data:image.data.toString('base64')});
                    } catch(error) {if (error.code === 'INPX_LIBRARY_CHANGED') throw error;omit();}
                };
                for(const candidate of embedded.candidates)await add(candidate.id,Buffer.from(candidate.data,'base64'));
                if (slots < limits.images) {
                    const libid=parseInt(path.basename(String(book.file),path.extname(String(book.file))),10);
                    if (libid > 0) {
                        const archives=book.folder ? await worker.getBookAssetArchives('images',book.folder,book.sourceLibDir)
                            : await worker.getFblibraryArchives('images',libid,book.sourceLibDir);
                        guard();
                        if (archives.length > 4) omit();
                        for (const archive of archives.slice(0,4)) {
                            if (slots >= limits.images) break;
                            const reader=new ZipReader({...worker.config,resourceMaxOutputBytes:limits.imageBytes});
                            try {
                                await reader.open(archive.file);guard();
                                const prefix=`${libid}/`,candidates=[],remaining=limits.images-slots;
                                let count=0;
                                for (const key in reader.entries) {
                                    const entry=reader.entries[key],name=String(entry.name||'').replace(/\\/g,'/');
                                    if (entry.isDirectory || entry.isLink || !name.startsWith(prefix)) continue;
                                    const id=name.slice(prefix.length);
                                    if (!validId(id) || id===cover || seen.has(id)) continue;
                                    count++;candidates.push({id,name,size:entry.size});
                                    candidates.sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
                                    if (candidates.length > remaining) candidates.pop();
                                }
                                if (count > candidates.length) {result.limited=true;result.omitted+=count-candidates.length;}
                                for (const candidate of candidates) {
                                    slots++;seen.add(candidate.id);
                                    if (candidate.size > limits.imageBytes || totalBytes >= limits.totalBytes) {omit();continue;}
                                    try {await imageRuntime.run(async()=>add(candidate.id,await reader.extractToBuf(candidate.name)));}
                                    catch(error) {if(error.code==='INPX_LIBRARY_CHANGED')throw error;omit();}
                                }
                            } catch(error) {if(error.code==='INPX_LIBRARY_CHANGED')throw error;omit();}
                            finally {await reader.close();}
                        }
                    }
                }
            } catch(error) {
                if (!isSizeLimit(error)) throw error;
                result.limited=true;result.omitted++;
            }
            guard();
            const serialized=JSON.stringify({version:1,...result});
            if (Buffer.byteLength(serialized) > limits.cacheBytes) throw outputLimit();
            await writeFileAtomic(cache,serialized);
            try {guard();} catch(error) {await fs.remove(cache);throw error;}
            worker.scheduleCacheClean('после подготовки галереи');
            return result;
        } finally {if(extracted)await fs.remove(extracted);}
    }
}

module.exports=BookGallery;
module.exports.limits=limits;
