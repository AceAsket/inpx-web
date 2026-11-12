const fs = require('fs-extra');
const {pipeline} = require('stream/promises');
const {Transform} = require('stream');
const zlib = require('zlib');
const iconv = require('iconv-lite');
const sax = require('sax');
const {MemoryCache} = require('./MemoryCache');
const Budget = require('./ClientRequestBudget');
const {coverCacheKey} = require('./BookAssets');
const formats = require('../../shared/BookFormats');

const limits = Object.freeze({fileBytes:32*1024**2, characters:2*1024**2, pageChars:3000, cacheBytes:16*1024**2});
const pageSizes = Object.freeze([1000, 1600, limits.pageChars]);
const tooLarge = () => Object.assign(new Error('Для текстового режима книга слишком велика. Скачайте файл для чтения на устройстве.'), {status:413});

function pageOffsets(text, maximum = limits.pageChars) {
    if (!Number.isInteger(maximum) || maximum < 2) throw new Error('Invalid page size');
    const offsets = [0];
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + maximum);
        if (end < text.length) {
            const middle = start + Math.floor(maximum / 2) + 1;
            const tail = text.slice(middle, end + 1);
            const paragraph = tail.lastIndexOf('\n');
            const boundary = paragraph >= 0 ? paragraph : tail.lastIndexOf(' ');
            if (boundary >= 0) end = middle + boundary + 1;
            if (/[\ud800-\udbff]/.test(text[end - 1])) end--;
        }
        offsets.push(end);
        start = end;
    }
    return offsets;
}

async function readText(file, signal) {
    const handle=await fs.open(file,'r');let head;
    try {head=Buffer.alloc(64*1024);const read=await fs.read(handle,head,0,head.length,0);head=head.subarray(0,read.bytesRead);}
    finally {await fs.close(handle);}
    const compressed=head[0]===0x1f&&head[1]===0x8b;
    const encodingHead=compressed ? null:head;
    let inputBytes=0,decodedBytes=0,characters=0,encoding='',decoder=null,parts=[];
    const route=[],parser=sax.parser(false,{lowercase:true}),block=new Set(['p','v','subtitle','title','empty-line','stanza','section']);
    const append=value=>{characters+=value.length;if(characters>limits.characters)throw tooLarge();parts.push(value);};
    const body=()=>route[0]==='fictionbook'&&route[1]==='body';
    parser.onopentag=node=>{const name=node.name.split(':').at(-1);route.push(name);if(route.length>128)throw tooLarge();if(body()&&block.has(name))append('\n\n');};
    const text=value=>{if(body())append(value.replace(/[\t\r\n ]+/g,' '));};
    parser.ontext=text;parser.oncdata=text;
    parser.onclosetag=name=>{if(body()&&block.has(name.split(':').at(-1)))append('\n\n');route.pop();};
    const cap=maximum=>new Transform({transform(chunk,_,done){
        if(maximum==='input')inputBytes+=chunk.length;else decodedBytes+=chunk.length;
        done((maximum==='input'?inputBytes:decodedBytes)>limits.fileBytes ? tooLarge():null,chunk);
    }});
    const parse=new Transform({transform(chunk,_,done){
        try {
            if(!decoder){
                const sample=encodingHead || chunk;
                if((sample[0]===0xff&&sample[1]===0xfe)||(sample[0]===60&&sample[1]===0))encoding='utf-16le';
                else if((sample[0]===0xfe&&sample[1]===0xff)||(sample[0]===0&&sample[1]===60))encoding='utf-16be';
                else encoding=sample.toString('latin1').match(/encoding\s*=\s*["']([^"']+)["']/i)?.[1] || 'utf-8';
                if(!iconv.encodingExists(encoding))throw new Error('Неподдерживаемая кодировка');
                // Honour a legacy declaration, except when the real file is UTF-8.
                if(!/^utf/i.test(encoding)&&sample.some(byte=>byte>=128)
                    &&[0,1,2,3].some(cut=>require('buffer').isUtf8(sample.subarray(0,sample.length-cut))))encoding='utf-8';
                decoder=iconv.getDecoder(encoding);
            }
            parser.write(decoder.write(chunk));done();
        }catch(error){done(error);}
    },flush(done){try{if(decoder)parser.write(decoder.end()||'');parser.close();done();}catch(error){done(error);}}});
    await pipeline(fs.createReadStream(file),cap('input'),...(compressed?[zlib.createGunzip()]:[]),cap('decoded'),parse,{signal});
    return parts.join('').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

class EbookReader {
    constructor(worker) {
        this.worker=worker;this.cache=new MemoryCache({bytes:limits.cacheBytes,entries:8,ttl:300000});
        this.budget=new Budget({parallel:1,perUser:1,queued:3,waitMs:10000});this.pending=new Set();this.controllers=new Set();
    }
    async close(){this.closed=true;for(const controller of this.controllers)controller.abort();await Promise.allSettled([...this.pending]);this.cache.close();}
    async read(uid) {
        const worker=this.worker,db=worker.db,generation=worker.libraryAssetGeneration;
        const guard=()=>{worker.checkLibraryAssetState(generation,db);if(this.closed)throw new Error('Reader closed');};
        guard();const book=await worker.getBookRecordByUid(uid);guard();
        if(!book)throw Object.assign(new Error('Книга не найдена'),{status:404});
        if(!formats.canRead(book.ext,worker.config)||worker.remoteLib)throw Object.assign(new Error('Скачайте книгу для чтения на устройстве.'),{status:415});
        const key=JSON.stringify([generation,coverCacheKey(book)]);
        const cached=this.cache.get(key);if(cached)return {book,...cached};
        const controller=new AbortController();this.controllers.add(controller);
        const timer=setTimeout(()=>controller.abort(),30000);timer.unref?.();
        const task=this.budget.run('ebook',key,async()=>{
            let file,temporary=false;
            try {
                guard();controller.signal.throwIfAborted();
                if(String(book.ext).toLowerCase()==='epub')file=(await worker.getPreparedBookFile(uid,'fb2')).rawFile;
                else {file=await worker.extractBook(book.folder,`${book.file}.${book.ext}`,book.sourceLibDir,
                    {maxOutputBytes:limits.fileBytes,signal:controller.signal,timeoutMs:30000});temporary=true;}
                guard();controller.signal.throwIfAborted();
                if((await fs.stat(file)).size>limits.fileBytes)throw tooLarge();
                const text=await readText(file,controller.signal);guard();
                if(!text)throw Object.assign(new Error('Текст книги не найден. Скачайте оригинал.'),{status:415});
                const offsets = Object.fromEntries(pageSizes.map(size => [size, pageOffsets(text, size)]));
                const result = {text, offsets};
                this.cache.set(key, result);
                return result;
            }catch(error){
                if(error.code==='INPX_RESOURCE_OUTPUT_LIMIT')throw tooLarge();
                if(controller.signal.aborted)throw Object.assign(new Error('Подготовка текста прервана. Скачайте оригинал для чтения на устройстве.'),{status:503});
                throw error;
            }finally {if(temporary&&file)await fs.remove(file);}
        },()=>!controller.signal.aborted).finally(()=>{clearTimeout(timer);this.controllers.delete(controller);this.pending.delete(task);});
        this.pending.add(task);const result=await task;guard();return {book,...result};
    }
}
module.exports={EbookReader,readText,pageOffsets,pageSizes,limits};
