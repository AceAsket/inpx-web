const assert = require('node:assert/strict');
const {once} = require('node:events');
const {mkdir,mkdtemp,rm,writeFile} = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const {tmpdir} = require('node:os');
const {dirname,join,resolve} = require('node:path');
const WebSocket = require('ws');
const express = require('express');
const Security = require('../server/core/Security');
const initHealthRoutes = require('../server/core/HealthRoutes');
const {start,pauseDirectRoutes,assetProbe} = require('../server/core/RustHttpServer');
const appDirectory = require('../build/appdir');
const chunkPath = `/${appDirectory}/fixture.1234abcd.js`;
const assetBytes = Buffer.from('// Fixture bundle\n'.repeat(10_000));

async function installWebApp(config) {
    const zip = new (require('yazl').ZipFile)();
    const chunks = [];
    zip.outputStream.on('data',chunk=>chunks.push(chunk));
    const end = once(zip.outputStream,'end');
    const options = {mtime:new Date('2026-01-01T00:00:00.000Z')};
    zip.addBuffer(Buffer.from(`<script src="${chunkPath}"></script>`),'index.html',options);
    zip.addBuffer(assetBytes,chunkPath.slice(1),options);
    zip.addBuffer(Buffer.from('self.fixture = true;'),'sw.js',options);
    zip.end();
    await end;
    await require('../server/createWebApp')(config,{bundle:{data:Buffer.concat(chunks).toString('base64')}});
}

async function listen(server) {
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',()=>{
            server.removeListener('error',reject);
            resolve();
        });
    });
    return server.address().port;
}

async function fixture(binary,folder,protectedRoutes = false,rootPathStatic = '',{serveAssets = true,...overlap} = {}) {
    const publicDir = join(folder,'public');
    const config = {
        server:{host:'127.0.0.1',port:0,ready:true},version:'http-fixture',
        requireAuth:protectedRoutes,authMode:'proxy',trustProxy:protectedRoutes,
        trustedProxyCidrs:['192.0.2.0/24'],authExemptHealth:true,
        publicDir,rootPathStatic,tempDir:join(folder,'install'),...overlap,
    };
    const security=new Security(config);
    security.secret='http-security-fixture';
    const app=express();
    let requests=0;
    const finish=Promise.withResolvers();
    const streamEntered=Promise.withResolvers();
    const bytes=Buffer.alloc(20_000,65);
    await mkdir(folder,{recursive:true});
    await installWebApp(config);
    await writeFile(join(folder,'book.fb2'),bytes);
    await writeFile(join(publicDir,'robots.txt'),'User-managed robots');
    app.use((_req,_res,next)=>{requests++;next();});
    if (config.trustProxy) app.set('trust proxy',address=>security.isTrustedProxyAddress(address));
    app.use(security.middleware(),security.requiredAuthMiddleware());
    initHealthRoutes(app,config,{getIndexStatus:async()=>({ready:true,progress:1})},security);
    app.get('/small',(_req,res)=>res.send('sample'));
    app.get('/peer',(req,res)=>res.json({
        ip:req.socket.remoteAddress,port:req.socket.remotePort,protocol:req.protocol,host:req.headers.host,
        forwarded:security.clientIp(req),note:req.headers['x-request-note'] || '',query:req.query,
    }));
    app.get('/session',(req,res)=>{
        const session=security.ensureSession(req,res);
        res.json({csrf:session.csrfToken});
    });
    app.post('/echo',async(req,res)=>{
        const chunks=[];
        for await (const chunk of req) chunks.push(chunk);
        res.type('application/octet-stream').send(Buffer.concat(chunks));
    });
    app.get('/chunks',async(_req,res)=>{
        res.type('application/octet-stream');
        res.write('first');
        streamEntered.resolve();
        await finish.promise;
        res.end('second');
    });
    app.use('/files',express.static(folder));
    if (config.opdsRoot) app.get(`${config.opdsRoot}/*`,(_req,res)=>res.send('OPDS route'));
    app.use(assetProbe);
    app.use(rootPathStatic,express.static(publicDir,{setHeaders(res,path) {
        if (path.endsWith('index.html')) res.set('Cache-Control','no-cache, must-revalidate');
        if (path.endsWith('sw.js') || path.endsWith('version.txt')) res.set('Cache-Control','no-store');
        if (path.endsWith('fixture.1234abcd.js')) res.set('Cache-Control','public, max-age=2592000, immutable');
    }}));
    const server=http.createServer(app);
    const wss=new WebSocket.Server({server,verifyClient:(info,done)=>done(security.verifyWebSocket(info.req),403,'Forbidden')});
    wss.on('connection',socket=>socket.on('message',(message,isBinary)=>socket.send(message,{binary:isBinary})));
    const errors=[];
    let transport,port;
    try {
        if (binary) {
            process.env.INPX_RUST_SERVER_BINARY=binary;
            transport=await start(server,config,{health:true,assets:serveAssets,onFailure:error=>errors.push(error)});
            port=transport.port;
        } else port=await listen(server);
        return {
            config,security,transport,port,finish,streamEntered,errors,bytes,requestCount:()=>requests,
            url:`http://127.0.0.1:${port}`,
            async close() {
                finish.resolve();
                for (const socket of wss.clients) socket.terminate();
                wss.close();
                if (transport) await transport.stop();
                else if (server.listening) {
                    server.closeAllConnections();
                    await new Promise(resolve=>server.close(resolve));
                }
            },
        };
    } catch (error) {
        wss.close();
        throw error;
    }
}

function request(site,path,agent,headers={},method='GET') {
    return new Promise((resolve,reject)=>{
        const req=http.get(site.url+path,{agent,headers,method,timeout:10_000},res=>{
            const chunks=[];
            res.on('data',chunk=>chunks.push(chunk));
            res.once('error',reject);
            res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),peerPort:req.socket.localPort}));
        });
        req.once('error',reject);
        req.once('timeout',()=>req.destroy(new Error('HTTP fixture timed out')));
    });
}

async function openSocket(site,options={}) {
    const socket=new WebSocket(site.url.replace('http:','ws:')+'/',{handshakeTimeout:4000,...options});
    await once(socket,'open');
    return socket;
}

async function echo(socket,payload,binary=false) {
    const message=once(socket,'message');
    socket.send(payload,{binary});
    const [data,isBinary]=await message;
    assert.equal(isBinary,binary);
    assert.deepEqual(data,Buffer.from(payload));
}

async function verify(binary,folder) {
    const site=await fixture(binary,folder,true);
    const agent=new http.Agent({keepAlive:true,maxSockets:1});
    try {
        const safe=path=>fetch(site.url+path,{signal:AbortSignal.timeout(5000)});
        const health=await safe('/health');
        assert.equal(health.headers.get('cache-control'),'no-store');
        assert.equal(health.headers.get('x-robots-tag'),'noindex, nofollow');
        assert.equal((await health.json()).ready,true);
        assert.equal(site.requestCount(),0);
        const head=await fetch(site.url+'/health',{method:'HEAD',signal:AbortSignal.timeout(5000)});
        assert(Number(head.headers.get('content-length'))>0);
        assert.equal(await head.text(),'');

        const update={authExemptHealth:false};
        const resume=await pauseDirectRoutes(site.config,update);
        Object.assign(site.config,update);
        await resume();
        assert.equal((await safe('/health')).status,403);
        const reopen=await pauseDirectRoutes(site.config,{authExemptHealth:true});
        site.config.authExemptHealth=true;
        await reopen();
        assert.equal((await safe('/health')).status,200);
        assert.equal((await safe('/ready')).status,200);
        assert.equal((await request(site,'/peer',agent,{'Remote-User':'fixture','X-Forwarded-For':'192.0.2.15'})).status,403);
        assert.equal((await request(site,chunkPath,agent,{'x-inpx-managed-asset':'1'})).status,403);

        const unauthorized=new WebSocket(site.url.replace('http:','ws:'),{
            headers:{'Remote-User':'fixture','Origin':'https://proxy.fixture','X-Forwarded-Proto':'https'},
            handshakeTimeout:5000,
        });
        await assert.rejects(once(unauthorized,'open'),/403/);
        site.security.trustedProxyRanges=new Security({trustedProxyCidrs:['127.0.0.1/32']}).trustedProxyRanges;
        const proxyHeaders={'Remote-User':'fixture','X-Forwarded-For':'192.0.2.15',
            'X-Forwarded-Host':'proxy.fixture','X-Forwarded-Proto':'https'};
        const peer=await request(site,'/peer?encoded=a%26b',agent,{
            ...proxyHeaders,connection:'keep-alive, x-request-note','x-request-note':'local to the first hop',
        });
        assert.equal(peer.status,200);
        assert.deepEqual(JSON.parse(peer.body),{
            ip:'127.0.0.1',port:peer.peerPort,protocol:'https',host:`127.0.0.1:${site.port}`,
            forwarded:'192.0.2.15',note:'',query:{encoded:'a&b'},
        });
        const forwardedHealth=await request(site,'/health',agent,proxyHeaders);
        assert.equal(forwardedHealth.status,200);
        assert.match(forwardedHealth.headers['strict-transport-security'],/max-age=/);
        const session=await request(site,'/session',agent,proxyHeaders);
        const cookie=session.headers['set-cookie'][0].split(';')[0];
        const resumed=await request(site,'/session',agent,{...proxyHeaders,cookie});
        assert.deepEqual(JSON.parse(session.body),JSON.parse(resumed.body));
        const range=await request(site,'/files/book.fb2',agent,{...proxyHeaders,range:'bytes=5-14'});
        assert.equal(range.status,206);
        assert.equal(range.headers['content-range'],'bytes 5-14/20000');
        assert.deepEqual(range.body,site.bytes.subarray(5,15));
        const protectedChunk=await request(site,chunkPath,agent,{...proxyHeaders,cookie});
        assert.deepEqual(protectedChunk.body,assetBytes);
        assert.match(protectedChunk.headers['strict-transport-security'],/max-age=/);
        assert.equal(protectedChunk.headers['x-inpx-managed-asset'],undefined);

        const upload=await fetch(site.url+'/echo',{
            method:'POST',headers:proxyHeaders,duplex:'half',signal:AbortSignal.timeout(5000),
            body:(async function*(){yield site.bytes;yield site.bytes;})(),
        });
        assert.deepEqual(Buffer.from(await upload.arrayBuffer()),Buffer.concat([site.bytes,site.bytes]));
        const stream=await fetch(site.url+'/chunks',{headers:proxyHeaders,signal:AbortSignal.timeout(5000)});
        await site.streamEntered.promise;
        const reader=stream.body.getReader();
        assert.equal(Buffer.from((await reader.read()).value).toString(),'first');
        site.finish.resolve();
        assert.equal(Buffer.from((await reader.read()).value).toString(),'second');
        assert((await reader.read()).done);

        const socket=await openSocket(site,{headers:{...proxyHeaders,Origin:'https://proxy.fixture',Cookie:cookie}});
        await echo(socket,'привет WebSocket');
        await echo(socket,site.bytes,true);
        const shutdown=once(socket,'close');
        socket.close(1000,'complete');
        assert.equal((await shutdown)[0],1000);

        const privateSocket=net.connect(site.transport.listener.address().port,'127.0.0.1');
        let bytesFromPrivate=0;
        privateSocket.on('data',chunk=>{bytesFromPrivate+=chunk.length;});
        privateSocket.setTimeout(3000,()=>privateSocket.destroy());
        // The private HTTP listener requires the inter-process preface before HTTP bytes.
        const closed=once(privateSocket,'close');
        privateSocket.on('connect',()=>privateSocket.end('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n'));
        await closed;
        assert.equal(bytesFromPrivate,0);
        assert.deepEqual(site.errors,[]);
        console.log('ok Rust HTTP authorization, live health policy, cookies, peer address, streaming and WebSocket');
    } finally {
        agent.destroy();
        await site.close();
    }
}

async function verifyAssets(binary,folder) {
    const prefix = '/library';
    const direct = await fixture(null,folder,false,prefix);
    const native = await fixture(binary,folder,false,prefix);
    const agent = new http.Agent({keepAlive:true,maxSockets:1});
    const asset = prefix + chunkPath;
    const assertSame = async(path,headers={},method='GET')=>{
        const expected = await request(direct,path,agent,headers,method);
        const actual = await request(native,path,agent,headers,method);
        assert.equal(actual.status,expected.status,path);
        assert.deepEqual(actual.body,expected.body,path);
        for (const field of ['content-type','content-length','accept-ranges','etag','last-modified','cache-control','content-range','x-robots-tag'])
            assert.equal(actual.headers[field],expected.headers[field],`${path} ${field}`);
        assert.equal(actual.headers['x-inpx-managed-asset'],undefined);
        return actual;
    };
    try {
        const full = await assertSame(asset);
        assert.equal(native.requestCount(),0);
        assert.equal(full.headers['cache-control'],'public, max-age=2592000, immutable');
        assert.deepEqual(full.body,assetBytes);
        for (const headers of [
            {'if-none-match':full.headers.etag},{'if-none-match':full.headers.etag.slice(2)},
            {'if-modified-since':full.headers['last-modified']},{'if-none-match':'*','cache-control':'no-cache'},
            {range:'bytes=17-41'},{range:'bytes=-19'},{range:'bytes=17-'},
        ]) await assertSame(asset,headers);
        await assertSame(asset,{},'HEAD');
        await assertSame(asset,{range:'bytes=7-13'},'HEAD');
        assert.equal(native.requestCount(),0);
        assert.equal((await assertSame(asset,{range:'bytes=9999999-'})).status,416);
        assert.equal((await assertSame(asset,{range:'bytes=0-10','if-range':full.headers.etag})).status,206);
        assert.equal((await assertSame(`${prefix}/sw.js`)).headers['cache-control'],'no-store');
        assert.equal((await assertSame(`${prefix}/version.txt`)).headers['cache-control'],'no-store');
        assert.equal((await assertSame(`${prefix}/robots.txt`)).body.toString(),'User-managed robots');
        for (const site of [direct,native]) {
            const home = await request(site,prefix+'/',agent,{accept:'text/html'});
            assert.equal(home.status,200);
            assert.equal(home.body.toString(),`<script src="${asset}"></script>`);
            assert.equal(home.headers['cache-control'],'no-cache, must-revalidate');
            assert.match(home.headers['set-cookie'][0],/^inpx/);
            assert.equal(home.headers['x-inpx-managed-asset'],undefined);
            const unavailable = await request(site,prefix+'/not-found',agent,{'x-inpx-managed-asset':'1'});
            assert.equal(unavailable.status,404);
        }
        const patch={requireAuth:true};
        const resume=await pauseDirectRoutes(native.config,patch);
        Object.assign(native.config,patch);
        assert.equal((await request(native,asset,agent)).status,403);
        await resume();
        assert.equal((await request(native,asset,agent)).status,403);
        const rollback=await pauseDirectRoutes(native.config,{requireAuth:false});
        native.config.requireAuth=false;
        await rollback();
        assert.equal((await request(native,asset,agent)).status,200);
        assert.deepEqual(native.errors,[]);
    } finally {
        agent.destroy();
        await Promise.all([direct.close(),native.close()]);
    }
    const overlapping = await fixture(binary,join(folder,'overlap'),false,prefix,{opdsRoot:prefix,metricsPath:prefix+'/sw.js'});
    try {
        const chunk = await request(overlapping,asset,false);
        assert.equal(chunk.body.toString(),'OPDS route');
    } finally {await overlapping.close();}
    console.log('ok Rust managed app assets, prefix, ETag and range parity, session, live policy, route precedence');
}

async function benchmark(binary,folder,assetsOnly) {
    const direct=await fixture(assetsOnly ? binary : null,folder,false,'',{serveAssets:false});
    let rust;
    const agents=[new http.Agent({keepAlive:true,maxSockets:1}),new http.Agent({keepAlive:true,maxSockets:1})];
    const parallel=[new http.Agent({keepAlive:true,maxSockets:16}),new http.Agent({keepAlive:true,maxSockets:16})];
    try {
        rust=await fixture(binary,folder);
        const sites=[direct,rust];
        async function timed(stage,rounds,operation,warmup=500) {
            const samples=[[],[]];
            for (let round=0;round<rounds+warmup;round++) {
                for (const i of round%2 ? [1,0] : [0,1]) {
                    const start=performance.now();
                    await operation(i);
                    if (round>=warmup) samples[i].push((performance.now()-start)*1000);
                }
            }
            const stats=values=>{
                values.sort((a,b)=>a-b);
                return {medianUs:values[Math.floor(values.length*0.5)],p95Us:values[Math.ceil(values.length*0.95)-1]};
            };
            console.log(JSON.stringify({stage,before:stats(samples[0]),after:stats(samples[1])}));
        }
        const get=path=>async index=>assert.equal((await request(sites[index],path,agents[index])).status,200);
        if (assetsOnly) {
            await timed('managed-bundle-180k',1000,get(chunkPath));
            const etags=await Promise.all(sites.map(async (site,i)=>(await request(site,chunkPath,agents[i])).headers.etag));
            await timed('managed-cache-304',1500,async i=>assert.equal((await request(sites[i],chunkPath,agents[i],{'if-none-match':etags[i]})).status,304));
            const cookies=await Promise.all(sites.map(async (site,i)=>(await request(site,'/',agents[i],{accept:'text/html'})).headers['set-cookie'][0].split(';')[0]));
            await timed('managed-bundle-cookie',1000,async i=>assert.equal((await request(sites[i],chunkPath,agents[i],{cookie:cookies[i]})).status,200));
            await timed('managed-home-cookie',1000,async i=>assert.equal((await request(sites[i],'/',agents[i],{cookie:cookies[i],accept:'text/html'})).status,200));
            await timed('managed-bundle-batch-16',300,i=>Promise.all(Array.from({length:16},async()=>{
                assert.equal((await request(sites[i],chunkPath,parallel[i])).status,200);
            })),100);
            return;
        }
        const sockets=await Promise.all(sites.map(site=>openSocket(site)));
        await timed('health-http',1500,get('/health'));
        await timed('delegated-http',1500,get('/small'));
        await timed('websocket-echo',1500,i=>echo(sockets[i],'message'));
        await timed('delegated-file-20k',1000,get('/files/book.fb2'));
        await timed('health-batch-16',300,i=>Promise.all(Array.from({length:16},async()=>{
            assert.equal((await request(sites[i],'/health',parallel[i])).status,200);
        })),100);
    } finally {
        for (const agent of [...agents,...parallel]) agent.destroy();
        await Promise.all([direct.close(),rust?.close()]);
    }
}

async function main(binary,mode) {
    if(!binary) throw new Error('Usage: node scripts/rust-http-tests.js <inpx-server> [benchmark]');
    const root=resolve(tmpdir());
    const folder=await mkdtemp(join(root,'inpx-rust-http-'));
    try {
        await new (require('../server/core/AppLogger'))().init({dataDir:folder,loggingEnabled:false});
        if (mode==='benchmark' || mode==='assets-benchmark') await benchmark(resolve(binary),folder,mode==='assets-benchmark');
        else {
            await verify(resolve(binary),join(folder,'transport'));
            await verifyAssets(resolve(binary),join(folder,'assets'));
        }
    } finally {
        assert.equal(dirname(folder),root);
        await rm(folder,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
