const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {mkdtemp,mkdir,rm,stat,utimes,writeFile} = require('node:fs/promises');
const http = require('node:http');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const express = require('express');
const {start,deliverFile} = require('../server/core/RustHttpServer');
const batchDownload = require('../server/core/BatchDownload');

const marker = 'x-inpx-file';
const credentials = 'Bearer download-fixture';

async function fixture(directories, enabled) {
    const app = express();
    const failures = [];
    const receipts = new Map();
    const stalled = {entered:Promise.withResolvers(),release:Promise.withResolvers()};
    const recordedBatch = Promise.withResolvers();
    let next = 0;
    app.get('/outside',(req,res)=>res.json({marker:req.headers[marker] || null}));
    app.get('/unsolicited',(_req,res)=>res.set(marker,'1').end('private descriptor'));
    app.use(['/library/book','/library/cover'],(req,res,proceed)=>{
        if (req.headers.authorization!==credentials) return res.set('Cache-Control','no-store').sendStatus(403);
        const id = req.headers['x-test-profile'];
        if (id) req.profileAccessIdentity = {user:{id}};
        proceed();
    });
    batchDownload.register(app,{bookPathStatic:'/library/book'},(req,count)=>()=>{
        recordedBatch.resolve({profile:req.profileAccessIdentity?.user?.id,count});
    });
    app.get('/library/book/a123/malformed',(_req,res)=>res.set(marker,'1').end('private descriptor'));
    app.get('/library/book/a123/escaped',(_req,res)=>{
        res.set(marker,'1').end(JSON.stringify({kind:'book',name:'../fixture'}));
    });
    function mount(route,kind,name,type,headers,beforeSend) {
        app.get(route,async(req,res,next)=>{
            if (beforeSend) {
                try {await beforeSend();}
                catch (error) {return next(error);}
            }
            const file = join(directories[kind],name);
            res.set(headers).type(type);
            const id = req.headers['x-test-receipt'];
            const deliver = id && (qualifies=>receipts.get(id)?.resolve(qualifies));
            if (!deliverFile(req,res,kind,file,deliver)) {
                res.sendFile(file,error=>{if (error && !res.headersSent) res.sendStatus(error.status || 500);});
            }
        });
    }
    mount('/library/book/a123/fixture','book','a123.raw','application/fb2+xml',{
        'Content-Disposition':'attachment; filename="fixture.fb2"',
    });
    mount('/library/book/a123/gzip','book','a123','application/fb2+xml',{'Content-Encoding':'gzip'});
    mount('/library/book/a124/abort','book','a124.raw','application/fb2+xml',{});
    mount('/library/book/a124/abort-before-headers','book','a123.raw','application/fb2+xml',{},()=>{
        stalled.entered.resolve();
        return stalled.release.promise;
    });
    mount('/library/book/a125/empty','book','a125.raw','application/fb2+xml',{});
    mount('/library/book/a126/missing','book','a126.raw','application/fb2+xml',{});
    mount('/library/book/batch','batch','batch-'+'a'.repeat(64)+'.zip','application/zip',{
        'Content-Disposition':'attachment; filename="books.zip"','Cache-Control':'private, no-store',
    });
    mount('/library/cover/fixture','cover','source-1.jpg','image/jpeg',{'Cache-Control':'public, max-age=300'});
    const transport = await start(http.createServer(app),{
        server:{host:'127.0.0.1',port:0},rootPathStatic:'/library',
        ...(enabled && {bookPathStatic:'/library/book',bookDir:directories.book,coverDir:directories.cover,tempDir:directories.batch}),
    },{onFailure:error=>failures.push(error)});
    const agent = new http.Agent({keepAlive:true});
    function request(path,options = {}) {
        return new Promise((resolve,reject)=>{
            const {method,headers,abort,unauthorized,signal,inspect} = options;
            const req = http.request({
                hostname:'127.0.0.1',port:transport.port,path,agent,method,signal,
                headers:{...(!unauthorized && {authorization:credentials}),...headers},
            },res=>{
                const chunks = [];
                res.on('error',reject);
                if (inspect) res.once('data',()=>{
                    res.pause();
                    Promise.resolve().then(inspect).then(()=>res.resume(),error=>req.destroy(error));
                });
                res.on('data',chunk=>{
                    if (abort) {
                        resolve({status:res.statusCode});
                        req.destroy();
                    } else chunks.push(chunk);
                });
                res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
            });
            req.on('error',reject).setTimeout(5000,()=>req.destroy(new Error('HTTP fixture timed out')));
            req.end();
        });
    }
    function withReceipt(path,options = {}) {
        const id = String(++next);
        const pending = Promise.withResolvers();
        const timer = setTimeout(()=>pending.reject(new Error(`No Rust receipt for ${path}`)),5000);
        receipts.set(id,pending);
        const response = request(path,{...options,headers:{...options.headers,'x-test-receipt':id}}).catch(error=>{
            if (options.signal?.aborted && error.code==='ABORT_ERR') return;
            throw error;
        });
        return Promise.all([response,pending.promise])
            .finally(()=>{clearTimeout(timer);receipts.delete(id);});
    }
    return {request,withReceipt,failures,stalled,recordedBatch,stop:()=>{agent.destroy();return transport.stop();}};
}

async function verify(before,after,book,cover) {
    const route = '/library/book/a123/fixture';
    const initial = await before.request(route);
    assert.equal(initial.status,200);
    assert(initial.headers['x-powered-by']);
    const {etag,'last-modified':modified} = initial.headers;
    for (const [method,headers,status] of [
        ['GET',{},200],['HEAD',{},200],
        ['GET',{Range:'bytes=5-200'},206],['HEAD',{Range:'bytes=5-200'},206],
        ['GET',{Range:'bytes=-8'},206],['GET',{Range:'bytes=0-'},206],
        ['GET',{Range:'bytes=5-200,201-300'},206],['GET',{Range:'bytes=5-200,400-500'},200],
        ['GET',{Range:'bytes=5-200','If-Range':etag},206],
        ['GET',{Range:'bytes=5-200','If-Range':modified},206],
        ['GET',{Range:'bytes=5-200','If-Range':'"stale"'},200],
        ['GET',{'If-None-Match':etag},304],['HEAD',{'If-Modified-Since':modified},304],
        ['GET',{'If-None-Match':etag,'Cache-Control':'no-cache'},200],
        ['GET',{'If-Match':'"stale"'},412],['GET',{Range:'bytes=9999999-'},416],
    ]) {
        const [reference,actual] = await Promise.all([before,after].map(site=>site.request(route,{method,headers})));
        assert.equal(reference.status,status,JSON.stringify({method,headers}));
        assert.equal(actual.status,status,JSON.stringify({method,headers}));
        assert.equal(actual.headers[marker],undefined);
        assert.equal(actual.headers['x-powered-by'],undefined);
        if (status < 400) {
            assert.deepEqual(actual.body,reference.body);
            for (const key of ['content-length','content-type','content-disposition','cache-control','etag','last-modified','accept-ranges','content-range']) {
                assert.equal(actual.headers[key],reference.headers[key],`${status} ${method} ${key}`);
            }
        } else if (status===416) assert.equal(actual.headers['content-range'],`bytes */${book.length}`);
    }
    const compressed = await after.request('/library/book/a123/gzip');
    assert.deepEqual(compressed.body,book);
    assert.equal(compressed.headers['content-encoding'],'gzip');
    assert.equal(compressed.headers['x-powered-by'],undefined);
    const picture = await after.request('/library/cover/fixture');
    assert.deepEqual(picture.body,cover);
    assert.equal(picture.headers['content-type'],'image/jpeg');
    assert.equal(picture.headers['cache-control'],'public, max-age=300');
    assert.equal(picture.headers['x-powered-by'],undefined);
    const batch = await after.request('/library/book/batch');
    assert.deepEqual(batch.body,book);
    assert.equal(batch.headers['content-disposition'],'attachment; filename="books.zip"');
    assert.equal(batch.headers['cache-control'],'private, no-store');
    for (const [path,options,expected] of [
        [route,{},true],[route,{headers:{Range:'bytes=0-'}},true],
        [route,{headers:{Range:'bytes=5-20'}},false],[route,{method:'HEAD'},false],
        [route,{headers:{'If-None-Match':etag}},false],
        ['/library/book/a125/empty',{},true],['/library/book/a126/missing',{},false],
        ['/library/book/batch',{},true],['/library/book/a124/abort',{abort:true},false],
    ]) {
        const [,count] = await after.withReceipt(path,options);
        assert.equal(count,expected,JSON.stringify({path,options}));
    }
    const controller = new AbortController();
    const early = after.withReceipt('/library/book/a124/abort-before-headers',{signal:controller.signal});
    await after.stalled.entered.promise;
    controller.abort();
    after.stalled.release.resolve();
    const [response,qualifies] = await early;
    assert.equal(response,undefined);
    assert.equal(qualifies,false);
    assert.equal((await after.request(route,{unauthorized:true,headers:{[marker]:'1'}})).status,403);
    assert.deepEqual(JSON.parse((await after.request('/outside',{headers:{[marker]:'1'}})).body),{marker:null});
    for (const path of ['/unsolicited','/library/book/a123/malformed','/library/book/a123/escaped']) {
        const response = await after.request(path);
        assert.equal(response.status,502);
        assert.equal(response.headers[marker],undefined);
        assert.equal(response.body.toString(),'Bad Gateway');
    }
    assert.deepEqual([...before.failures,...after.failures],[]);
}

async function verifyBatch(after,directories) {
    const worker = {
        checkMyState(){},
        config:{tempDir:directories.batch,bookPathStatic:'/library/book'},
        async getPreparedBookFile(){
            return {rawFile:join(directories.book,'a124.raw'),book:{ext:'fb2',title:'Book',author:'Author'}};
        },
    };
    const {url} = await batchDownload.create(worker,'reader',{bookUids:['fixture']});
    const archive = join(directories.batch,`batch-${url.split('/').pop()}.zip`);
    const {size} = await stat(archive);
    const expiry = Date.now()+16*60*1000;
    assert.equal((await after.request(url,{headers:{'x-test-profile':'another'}})).status,403);
    const response = await after.request(url,{
        headers:{'x-test-profile':'reader'},
        async inspect(){assert.equal(await batchDownload.cleanup(expiry),size,'An active transfer keeps the ticket');},
    });
    assert.equal(response.status,200);
    assert.equal(response.body.length,size);
    assert.deepEqual(await Promise.race([
        after.recordedBatch.promise,
        require('node:timers/promises').setTimeout(5000,null,{ref:false}),
    ]),{profile:'reader',count:1});
    assert.equal(await batchDownload.cleanup(expiry),0);
    await assert.rejects(stat(archive),{code:'ENOENT'});
}

async function main() {
    process.env.INPX_RUST_SERVER_BINARY = resolve(process.argv[2]);
    const temporary = await mkdtemp(join(tmpdir(),'inpx-file-http-'));
    const directories = Object.fromEntries(['book','cover','batch'].map(kind=>[kind,join(temporary,kind)]));
    const book = randomBytes(400_123);
    const cover = randomBytes(3000);
    const mtime = new Date('2026-09-14T13:02:01.123Z');
    let before, after;
    try {
        await Promise.all(Object.values(directories).map(path=>mkdir(path)));
        await Promise.all([
            ['book','a123.raw',book],['book','a123',book],['book','a124.raw',randomBytes(24*1024*1024)],
            ['book','a125.raw',Buffer.alloc(0)],['cover','source-1.jpg',cover],['batch','batch-'+'a'.repeat(64)+'.zip',book],
        ].map(async([kind,name,bytes])=>{
            const file = join(directories[kind],name);
            await writeFile(file,bytes);
            await utimes(file,mtime,mtime);
        }));
        before = await fixture(directories,false);
        after = await fixture(directories,true);
        await verify(before,after,book,cover);
        await verifyBatch(after,directories);
        console.log('ok Rust file HTTP transport, conditional requests, access, and download receipts');
    } finally {
        await Promise.all([before?.stop(),after?.stop()]);
        await rm(temporary,{recursive:true,force:true});
    }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
