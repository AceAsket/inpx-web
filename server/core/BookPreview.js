const fs=require('fs-extra');
const {Readable}=require('stream');
const {isUtf8}=require('buffer');
const sax=require('sax');
const {limits,annotationText}=require('../../shared/BookPreview');
const {MemoryCache}=require('./MemoryCache');
const {coverCacheKey}=require('./BookAssets');
const {epubMetadata}=require('./BookMetadata');

const timeoutError=()=>Object.assign(new Error('Preview time limit'),{code:'INPX_PREVIEW_TIMEOUT'});
function annotationFromXml(xml) {
    const parser=sax.parser(false,{lowercase:true}),route=[],stop={};
    let text='',found=false,complete=false,root=false,limited=false,knownEmpty=false;
    const inAnnotation=()=>route.slice(0,4).join('/')==='fictionbook/description/title-info/annotation';
    const append=value=>{
        if(!text)value=value.trimStart();
        const remaining=limits.annotationChars+1-text.length;
        text+=value.slice(0,Math.max(0,remaining));
        if(text.length>limits.annotationChars){limited=true;throw stop;}
    };
    parser.onopentag=node=>{
        const name=node.name.split(':').at(-1);route.push(name);
        if(route.length>128){limited=true;throw stop;}
        if(route.length===1&&name==='fictionbook')root=true;
        if(route.join('/')==='fictionbook/description/title-info/annotation')found=true;
        else if(inAnnotation()&&['p','subtitle','empty-line','stanza'].includes(name))append('\n\n');
        if(route.length===2&&root&&['body','binary'].includes(name)){knownEmpty=!found;throw stop;}
    };
    const content=value=>{if(inAnnotation())append(value.replace(/[\t\r\n ]+/g,' '));};
    parser.ontext=content;parser.oncdata=content;
    parser.onclosetag=name=>{
        name=name.split(':').at(-1);
        if(inAnnotation()&&['p','subtitle','empty-line','stanza'].includes(name))append('\n\n');
        if(route.join('/')==='fictionbook/description/title-info/annotation'&&name==='annotation'){complete=true;throw stop;}
        if(root&&route.length===2&&name==='description'){knownEmpty=!found;throw stop;}
        route.pop();
    };
    try {for(let i=0;i<xml.length;i+=65536)parser.write(xml.slice(i,i+65536));parser.close();}
    catch(error){if(error!==stop)throw error;}
    const cleaned=annotationText(text);limited ||= cleaned.limited;
    if(complete&&!limited)return {annotation:cleaned.annotation,annotationStatus:cleaned.annotation?'ready':'empty',annotationLimited:false};
    if(knownEmpty)return {annotation:'',annotationStatus:'empty',annotationLimited:false};
    if(root||found||limited)return {annotation:cleaned.annotation,annotationStatus:'limited',annotationLimited:true};
    return {annotation:'',annotationStatus:'unavailable',annotationLimited:false};
}

async function decodedPrefix(data,signal) {
    if(data[0]!==0x1f||data[1]!==0x8b)return data;
    const input=Readable.from([data]),output=require('zlib').createGunzip(),chunks=[];
    const abort=()=>{input.destroy();output.destroy(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    let bytes=0;
    try {
        signal.throwIfAborted();input.pipe(output);
        for await(const chunk of output){
            const part=chunk.subarray(0,limits.prefixBytes-bytes);chunks.push(part);bytes+=part.length;
            if(bytes>=limits.prefixBytes)break;
        }
    } catch(error){if(signal.aborted||error.code!=='Z_BUF_ERROR'||data.length<limits.prefixBytes)throw error;}
    finally {signal.removeEventListener('abort',abort);input.destroy();output.destroy();}
    return Buffer.concat(chunks,bytes);
}

class BookPreview {
    constructor(worker,options={}) {
        this.worker=worker;this.timeoutMs=options.timeoutMs||limits.timeoutMs;this.ttl=options.ttl||limits.cacheTtlMs;
        this.cache=new MemoryCache({bytes:options.cacheBytes??limits.cacheBytes,entries:limits.cacheEntries,ttl:this.ttl});
        this.pending=new Map();this.controllers=new Set();this.active=0;this.queue=[];this.closed=false;
    }
    async close(){this.closed=true;for(const controller of this.controllers)controller.abort(timeoutError());
        this.cache.close();await Promise.allSettled([...this.pending.values()]);}
    async run(work,signal) {
        if(this.active>=2)await new Promise((resolve,reject)=>{
            const entry={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
            const abort=()=>{const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);reject(signal.reason);}};
            this.queue.push(entry);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });else this.active++;
        try{signal.throwIfAborted();return await work();}
        finally{const next=this.queue.shift();if(next)next.resolve();else this.active--;}
    }
    async read(uid) {
        const worker=this.worker;worker.checkMyState();
        if(typeof uid!=='string'||!uid||uid.length>1024)throw new Error('Invalid book UID');
        const db=worker.db,generation=worker.libraryAssetGeneration,key=JSON.stringify([generation,uid]);
        const guard=()=>{worker.checkLibraryAssetState(generation,db);if(this.closed)throw Object.assign(new Error('Library changed'),{code:'INPX_LIBRARY_CHANGED'});};
        guard();
        if(this.db!==db||this.generation!==generation){this.db=db;this.generation=generation;this.cache.clear();}
        if(!this.pending.has(key)){
            if(this.pending.size>=18)throw Object.assign(new Error('Preview queue is full'),{code:'INPX_RESOURCE_IO_QUEUE_FULL'});
            const controller=new AbortController();this.controllers.add(controller);
            const timer=setTimeout(()=>controller.abort(timeoutError()),this.timeoutMs);timer.unref?.();
            const work=async()=>{
                const signal=controller.signal;let file;
                const unavailable={bookUid:uid,annotation:'',annotationStatus:'unavailable',annotationLimited:false};
                try {
                    guard();signal.throwIfAborted();
                    const book=await worker.getBookRecordByUid(uid);guard();signal.throwIfAborted();
                    if(!book)throw new Error('Book not found');
                    const cacheKey=coverCacheKey(book),saved=this.cache.get(cacheKey);
                    if(saved&&Date.now()-saved.at<this.ttl)return {...saved.value};
                    const ext=String(book.ext).toLowerCase();let result;
                    if(worker.remoteLib||!['fb2','epub'].includes(ext))result={annotation:'',annotationStatus:'unsupported',annotationLimited:false};
                    else if(ext==='fb2'){
                        file=await worker.extractBook(book.folder,`${book.file}.${book.ext}`,book.sourceLibDir,
                            {prefixBytes:limits.prefixBytes,signal,timeoutMs:this.timeoutMs});
                        guard();signal.throwIfAborted();
                        let data=await decodedPrefix(await fs.readFile(file,{signal}),signal);
                        // A bounded prefix can end inside a UTF-8 code point.
                        for(let cut=0;cut<=3;cut++)if(isUtf8(data.subarray(0,data.length-cut))){data=data.subarray(0,data.length-cut);break;}
                        data=worker.fb2Helper.checkEncoding(data);
                        result=annotationFromXml(data.subarray(0,limits.prefixBytes).toString('utf8'));
                    }else{
                        file=await worker.extractBook(book.folder,`${book.file}.${book.ext}`,book.sourceLibDir,
                            {maxOutputBytes:limits.epubBytes,signal,timeoutMs:this.timeoutMs});
                        guard();signal.throwIfAborted();
                        const metadata=await epubMetadata(file,{...worker.config,resourceSignal:signal,resourceTimeoutMs:this.timeoutMs});
                        const cleaned=annotationText(metadata.description);
                        result={annotation:cleaned.annotation,annotationStatus:cleaned.limited?'limited':cleaned.annotation?'ready':'empty',annotationLimited:cleaned.limited};
                    }
                    signal.throwIfAborted();guard();
                    const value={bookUid:uid,...result};
                    if(value.annotationStatus!=='unavailable')this.cache.set(cacheKey,{at:Date.now(),value});
                    return value;
                }catch(error){guard();return ['INPX_RESOURCE_OUTPUT_LIMIT','ERR_BUFFER_TOO_LARGE'].includes(error.code)
                    ? {...unavailable,annotationStatus:'limited',annotationLimited:true}:unavailable;}
                finally{if(file)await fs.remove(file);}
            };
            const pending=Promise.resolve().then(()=>worker.runForeground(()=>this.run(work,controller.signal)))
                .catch(error=>{guard();if(controller.signal.aborted)return {bookUid:uid,annotation:'',annotationStatus:'unavailable',annotationLimited:false};throw error;})
                .finally(()=>{clearTimeout(timer);this.controllers.delete(controller);if(this.pending.get(key)===pending)this.pending.delete(key);});
            this.pending.set(key,pending);
        }
        const result=await this.pending.get(key);guard();return {bookPreview:{...result}};
    }
}
module.exports=BookPreview;
module.exports.annotationFromXml=annotationFromXml;
module.exports.decodedPrefix=decodedPrefix;
