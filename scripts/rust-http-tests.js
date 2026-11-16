const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {once} = require('node:events');
const {mkdir,mkdtemp,readFile,rm,writeFile} = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const {tmpdir} = require('node:os');
const {dirname,join,resolve} = require('node:path');
const WebSocket = require('ws');
const express = require('express');
const Security = require('../server/core/Security');
const initHealthRoutes = require('../server/core/HealthRoutes');
const audiobookshelf = require('../server/core/AudiobookshelfProvider');
const {start,pauseDirectRoutes,assetProbe,wasServiceAuthorized} = require('../server/core/RustHttpServer');
const {attach} = require('../server/core/WebSocketListener');
const {ProfileTotpAttempts,attemptLimit} = require('../server/core/ProfileTotpAttempts');
const requestLimits = require('../server/core/RequestLimits');
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

async function fixture(binary,folder,protectedRoutes = false,rootPathStatic = '',{
    serveAssets = true,nativeWebSocket = true,textOnly = false,maxPayload = 6*1024*1024,
    websocketRequests = false,nativeAccess = true,onRequest,libraryAccess,bindProfileSessions,...overlap
} = {}) {
    const publicDir = join(folder,'public');
    const config = {
        server:{host:'127.0.0.1',port:0,ready:true},version:'http-fixture',
        requireAuth:protectedRoutes,authMode:'proxy',trustProxy:protectedRoutes,
        trustedProxyCidrs:['192.0.2.0/24'],authExemptHealth:true,
        publicDir,rootPathStatic,tempDir:join(folder,'install'),...overlap,
    };
    const security=new Security(config);
    security.secret='http-security-fixture';
    let authChecks=0;
    const serviceApprovals={metrics:0,metadata:0,cover:0};
    const verifyRequiredAuth=security.verifyRequiredAuth.bind(security);
    security.verifyRequiredAuth=req=>{authChecks++;return verifyRequiredAuth(req);};
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
    const worker={config,getIndexStatus:async()=>({ready:true,progress:1}),getBookRecordByUid:async()=>null};
    if (config.metricsEnabled || config.absEnabled) app.use((req,_res,next)=>{
        for (const service of Object.keys(serviceApprovals)) {
            if (wasServiceAuthorized(req,service)) serviceApprovals[service]++;
        }
        next();
    });
    if (config.absEnabled) audiobookshelf.init(app,config,worker,security);
    initHealthRoutes(app,config,worker,security);
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
    const wss=attach(server,{maxPayload,verify:req=>security.verifyWebSocket(req)});
    let nativeConnections=0;
    wss.on('connection',(socket,req)=>{
        if (req.headers.upgrade==='inpx-websocket') nativeConnections++;
        socket.on('message',(message,isBinary,admission)=>{
            if (onRequest) {
                Promise.resolve().then(()=>onRequest(socket,message,admission,config)).finally(()=>admission?.complete())
                    .catch(error=>errors.push(error));
            } else if (!isBinary && message.toString()==='server-close') socket.close(1013,'Too many active requests');
            else socket.send(message,{binary:isBinary});
        });
    });
    const errors=[];
    let transport,port;
    try {
        if (binary) {
            process.env.INPX_RUST_SERVER_BINARY=binary;
            const websocket=nativeWebSocket ? {maxPayload,textOnly} : undefined;
            transport=await start(server,config,{health:true,assets:serveAssets,websocket,websocketRequests,libraryAccess,bindProfileSessions,
                requestAccess:nativeAccess ? ()=>security.requestAccessPolicy() : undefined,
                onWebSocketRejected:(reason,peer)=>security.logNativeWebSocketRejection(reason,peer),onFailure:error=>errors.push(error)});
            port=transport.port;
        } else port=await listen(server);
        return {
            config,security,transport,port,finish,streamEntered,errors,bytes,requestCount:()=>requests,
            authChecks:()=>authChecks,serviceApprovals,
            nativeConnections:()=>nativeConnections,
            sendToClients(payload) {for (const socket of wss.clients) socket.send(payload);},
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

async function openSocket(site,{protocols=[],...options}={}) {
    const socket=new WebSocket(site.url.replace('http:','ws:')+'/',protocols,{handshakeTimeout:4000,...options});
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
        await site.transport.applyDirectRoutes();
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

        await assert.rejects(openSocket(site,{headers:{...proxyHeaders,Origin:'https://foreign.fixture',Cookie:cookie}}),/403/);
        const socket=await openSocket(site,{headers:{...proxyHeaders,Origin:'https://proxy.fixture',Cookie:cookie},
            protocolVersion:8,protocols:['inpx-v1','other']});
        assert.equal(site.nativeConnections(),1);
        assert.equal(socket.protocol,'inpx-v1');
        await echo(socket,'привет WebSocket');
        await echo(socket,site.bytes,true);
        const fragmented=Buffer.from('разбитое сообщение\nследующая строка');
        const combined=once(socket,'message',{signal:AbortSignal.timeout(5000)});
        socket.send(fragmented.subarray(0,1),{binary:false,fin:false});
        const pong=once(socket,'pong',{signal:AbortSignal.timeout(5000)});
        socket.ping('ping');
        assert.equal((await pong)[0].toString(),'ping');
        socket.send(fragmented.subarray(1),{binary:false});
        assert.deepEqual(await combined,[fragmented,false]);
        const pushed=once(socket,'message',{signal:AbortSignal.timeout(5000)});
        site.sendToClients('event while idle');
        assert.deepEqual(await pushed,[Buffer.from('event while idle'),false]);
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

async function verifyWebSocketLimits(binary,folder) {
    const site=await fixture(binary,folder,false,'',{maxPayload:1024,textOnly:true});
    try {
        const codes=async (send,expected) => {
            const socket=await openSocket(site);
            const ended=once(socket,'close',{signal:AbortSignal.timeout(5000)});
            send(socket);
            assert.equal((await ended)[0],expected);
        };
        await codes(socket=>socket.send(Buffer.from('only text')),1003);
        await codes(socket=>socket.send(Buffer.from([0xc3,0x28]),{binary:false}),1007);
        await codes(socket=>{
            socket.send('a'.repeat(700),{fin:false});
            socket.send('b'.repeat(700));
        },1009);
        const socket=await openSocket(site);
        await echo(socket,' '.repeat(1024));
        await echo(socket,'');
        const ended=once(socket,'close',{signal:AbortSignal.timeout(5000)});
        socket.send('server-close');
        const [code,reason]=await ended;
        assert.equal(code,1013);
        assert.equal(reason.toString(),'Too many active requests');
        assert.equal(site.nativeConnections(),4);
        const forged=await request(site,'/',false,{upgrade:'inpx-websocket',connection:'upgrade'});
        assert.notEqual(forged.status,101);
        assert.equal(site.nativeConnections(),4);
    } finally {await site.close();}
    console.log('ok Rust WebSocket message bounds, UTF-8, application close and private upgrade isolation');
}

async function verifyAccess(binary,folder) {
    const settings={trustedProxyCidrs:['127.0.0.1/32'],metricsEnabled:true,metricsToken:'fixture-metrics',
        absEnabled:true,absToken:'fixture-abs'};
    const node=await fixture(binary,join(folder,'node'),true,'',{...settings,nativeAccess:false});
    let rust;
    const proxy={'Remote-User':'fixture','X-Forwarded-Host':'proxy.fixture','X-Forwarded-Proto':'https'};
    try {
        rust=await fixture(binary,join(folder,'rust'),true,'',settings);
        const denied=await request(node,'/small',false,{'X-Forwarded-Proto':'https'});
        const {status,body,headers}=await request(rust,'/small',false,{'X-Forwarded-Proto':'https',
            'x-inpx-request-access':`${rust.transport.approvedAccess}:http`});
        assert.equal(status,401);
        assert.deepEqual(body,denied.body);
        for (const key of ['content-type','content-length','etag','strict-transport-security','content-security-policy','x-robots-tag'])
            assert.equal(headers[key],denied.headers[key],key);
        assert.equal(rust.requestCount(),0,'Public approval header must not reach the application');
        const deniedHead=await request(rust,'/small',false,{},'HEAD');
        assert.equal(deniedHead.status,401);
        assert.equal(deniedHead.body.length,0);
        assert.equal(deniedHead.headers['content-length'],denied.headers['content-length']);

        const direct=await request(rust,chunkPath,false,proxy);
        assert.deepEqual(direct.body,assetBytes);
        assert.equal(direct.headers['strict-transport-security'],headers['strict-transport-security']);
        assert.equal(rust.requestCount(),0,'Authorized static asset should avoid the application probe');
        const session=await request(rust,'/',false,{...proxy,accept:'text/html'});
        const cookie=session.headers['set-cookie'][0].split(';')[0];
        assert.equal(rust.requestCount(),1,'A document must still go through session handling');
        const oldChecks=rust.authChecks();
        const ws=await openSocket(rust,{headers:{...proxy,cookie,Origin:'HTTPS://Proxy.Fixture:443'}});
        await echo(ws,'authorized');
        ws.terminate();
        assert.equal(rust.authChecks(),oldChecks,'An approved WebSocket retains the session without repeating the gate');
        await assert.rejects(openSocket(rust,{headers:{...proxy,Origin:'https://elsewhere.fixture'}}),/403/);
        assert.equal(rust.authChecks(),oldChecks);
        const legacyOrigin=await openSocket(rust,{headers:{...proxy,Origin:'blob:https://proxy.fixture/test'}});
        legacyOrigin.terminate();
        assert.equal(rust.authChecks(),oldChecks+1);

        const metrics=await request(rust,'/metrics',false,{Authorization:'Bearer fixture-metrics'});
        assert.equal(metrics.status,200);
        assert.match(metrics.body.toString(),/inpx_web_build_info/);
        assert.equal(rust.authChecks(),oldChecks+1,'Bearer token can be checked in Rust');
        assert.equal(rust.serviceApprovals.metrics,1);
        assert.equal((await request(rust,'/small',false,{Authorization:'Bearer fixture-metrics'})).status,401);
        assert.equal((await request(rust,'/small',false,{Authorization:'fixture-abs'})).status,401);
        await verifyServiceAccess(node,rust,proxy);

        assert.equal((await request(rust,'/small',false,{...proxy,Connection:'keep-alive, remote-user'})).status,401);
        const update={proxyAuthHeader:'X-New-Proxy-User'};
        const resume=await pauseDirectRoutes(rust.config,update);
        Object.assign(rust.config,update);
        assert.equal((await request(rust,'/small',false,proxy)).status,401);
        await resume();
        assert.equal((await request(rust,'/small',false,proxy)).status,401);
        assert.equal((await request(rust,'/small',false,{'X-New-Proxy-User':'fixture'})).status,200);
        const closeHeader={proxyAuthHeader:'Close'};
        const resumeClose=await pauseDirectRoutes(rust.config,closeHeader);
        Object.assign(rust.config,closeHeader);
        await resumeClose();
        assert.equal((await request(rust,'/small',false,{Close:'fixture',Connection:'close'})).status,401);
        const closeUser={Close:'fixture',Connection:'keep-alive'};
        assert.equal((await request(rust,'/small',false,closeUser)).status,200);
        const revoke={trustedProxyCidrs:['192.0.2.0/24']};
        const publish=await pauseDirectRoutes(rust.config,revoke);
        Object.assign(rust.config,revoke);
        assert.equal((await request(rust,'/small',false,closeUser)).status,403);
        await publish();
        assert.equal((await request(rust,'/small',false,closeUser)).status,403);
        assert.deepEqual(rust.errors,[]);
    } finally {await Promise.all([node.close(),rust?.close()]);}
    console.log('ok Rust access policy, protected assets, WebSocket origins, service credentials and live policy updates');
}

function coverPath(config,uid='fixture-book',expires=String(Date.now()+60000),signature) {
    const query = new URLSearchParams({uid,expires,signature:signature ?? audiobookshelf.coverSignature(config,uid,expires)});
    return `${audiobookshelf.rootPath(config)}/cover?${query}`;
}

async function verifyServiceAccess(node,rust,proxy) {
    const parity = async (path,status,headers,method,body) => {
        for (const site of [node,rust]) {
            const response=await request(site,path,false,headers,method);
            assert.equal(response.status,status,`${method || 'GET'} ${path.slice(0,130)}`);
            if (body !== undefined) assert.equal(response.body.toString(),body);
        }
    };
    const prior = rust.authChecks();
    const cover = coverPath(rust.config,'книга + [слово] / 📚');
    const notFound = '{"error":"Book not found"}';
    await parity('/metrics?t%6fken=+%EF%BB%BFfixture-metrics%09',200);
    await parity(cover,404,{},'GET',notFound);
    await parity(cover,404,{},'HEAD','');
    await parity('/api/audiobookshelf/cover?uid=fixture-book',404,{Authorization:'fixture-abs'},'GET',notFound);
    assert.equal(rust.authChecks(),prior,'Common service credentials must be verified by Rust');
    assert.deepEqual(rust.serviceApprovals,{metrics:2,metadata:1,cover:2});

    await parity('/metrics?token[]=fixture-metrics',200);
    await parity('/metrics?token=fixture-metrics&token=fixture-metrics',401);
    await parity('/metrics?token=fixture-metrics&token%5Bextra%5D=value',401);
    await parity('/metrics?token=fixture-metrics&extra=foo%5D=bar',200);
    await parity(coverPath(rust.config,'fixture-book',`+${Date.now()+60000}`),404,{},'GET',notFound);
    assert.equal(rust.authChecks(),prior+5,'Legacy query shapes retain Express parsing');
    await parity(`/metrics?${'x=&'.repeat(999)}token=fixture-metrics`,200);
    await parity(`/metrics?${'x=&'.repeat(1000)}token=fixture-metrics`,401);
    await parity('/metrics?token=%EF%BF',401);
    await parity('/metrics?token=%C2%85fixture-metrics',401);
    await parity('/metrics?token=fixture-metrics',401,{Authorization:'Bearer wrong'});
    await parity('/small?token=fixture-metrics',401);
    await parity(cover.replace('/cover?','/search?'),401);
    await parity(cover,401,{},'POST');
    await parity(`${cover}&uid=other`,401);
    await parity(cover.replace(/signature=.+$/,'signature='+'A'.repeat(64)),401);
    await parity(coverPath(rust.config,'📚'.repeat(129)),401);
    await parity(coverPath(rust.config,'fixture-book',String(Date.now()-60000)),401);
    await parity(coverPath(rust.config,'fixture-book',String(Date.now()+172800000)),401);
    const proof = `${rust.transport.approvedAccess}:http`;
    await parity('/metrics',401,{...proxy,'x-inpx-request-access':`${proof}:metrics`});
    await parity('/api/audiobookshelf/cover',401,{...proxy,'x-inpx-request-access':`${proof}:metadata`});
    await parity('/api/audiobookshelf/cover',401,{...proxy,'x-inpx-request-access':`${proof}:cover:${Date.now()+60000}`});

    const update = {metricsExemptAuth:true,metricsToken:'next-metrics',absToken:'next-abs'};
    const resume = await pauseDirectRoutes(rust.config,update);
    for (const site of [node,rust]) Object.assign(site.config,update);
    await parity(cover,401);
    await resume();
    await parity(cover,401);
    await parity(coverPath(rust.config),404,{},'GET',notFound);
    await parity('/metrics?token=fixture-metrics',401);
    await parity('/metrics?token=next-metrics',200);
}

async function verifyServiceRouteOverlap(binary,folder) {
    const config={metricsPath:'/api/audiobookshelf/cover',metricsEnabled:true,metricsToken:'fixture-metrics',
        absEnabled:true,absToken:'fixture-abs'};
    const site=await fixture(binary,folder,false,'',config);
    try {
        const metrics=await request(site,`${config.metricsPath}?token=${config.metricsToken}`,false);
        assert.equal(metrics.status,401);
        assert.equal(metrics.body.toString(),'{"error":"Invalid authorization token"}');
        const cover=await request(site,coverPath(config),false);
        assert.equal(cover.status,404);
        assert.equal(cover.body.toString(),'{"error":"Book not found"}');
        assert.deepEqual(site.serviceApprovals,{metrics:1,metadata:0,cover:1});
        assert.deepEqual(site.errors,[]);
    } finally {await site.close();}
    console.log('ok Rust service credential scopes remain separate with overlapping routes');
}

function readRequest(message,admission,config) {
    const text=message.toString();
    let request={};
    try {
        request=JSON.parse(text);
        requestLimits.checkRequest(request,admission?.validation ? 0 : Buffer.byteLength(text),config,admission?.validation);
        return {request,reply:{requestId:request.requestId,ok:true}};
    } catch (error) {
        return {request,reply:{requestId:request?.requestId,error:error.message}};
    }
}

async function jsonMessage(socket,payload) {
    const response=once(socket,'message',{signal:AbortSignal.timeout(10000)});
    socket.send(typeof payload==='string' ? payload : JSON.stringify(payload));
    return JSON.parse((await response)[0]);
}

async function verifyNativeLibraryAccess(binary,folder) {
    const password=' пароль теста 🙂 ';
    const libraryAccess={file:join(folder,'sessions.redb'),password,timeoutMs:60_000};
    const launch=()=>fixture(binary,folder,false,'',{libraryAccess,websocketRequests:true,
        onRequest(socket,_message,admission) {
            socket.send(JSON.stringify({authorized:admission.libraryAuthorized,validation:admission.validation}));
        },
    });
    let site=await launch();
    let socket;
    const command=request=>site.transport.libraryRequest(request);
    try {
        socket=await openSocket(site);
        const {salt,state}=await command({op:'issue',client:'fixture'});
        assert.equal(state,'challenge');
        const token=createHash('sha256').update(password+salt).digest('hex');
        const request={action:'test',accessToken:token,libraryAuthorized:true};
        const denied={authorized:false,validation:1};
        const approved={authorized:true,validation:1};
        assert.deepEqual(await jsonMessage(socket,request),denied);
        assert.equal((await command({op:'check',token})).state,'allowed');
        assert.deepEqual(await jsonMessage(socket,request),approved);
        assert.deepEqual(await jsonMessage(socket,{...request,action:null}),denied);
        assert.deepEqual(await jsonMessage(socket,`{"action":"test","accessToken":"${token}","accessToken":""}`),denied);
        assert.deepEqual(await jsonMessage(socket,{...request,data:'1'.repeat(65536)}),denied);
        const resume=await pauseDirectRoutes(site.config,{logQueries:true});
        site.config.logQueries=true;
        await resume();
        assert.deepEqual(await jsonMessage(socket,request),approved);
        await site.close();
        site=await launch();
        socket=await openSocket(site);
        assert.deepEqual(await jsonMessage(socket,request),approved);
        assert.equal((await command({op:'revoke',token})).state,'applied');
        assert.deepEqual(await jsonMessage(socket,request),denied);
        assert.equal((await command({op:'check',token})).state,'denied');
        assert.equal((await command({op:'login',client:'fixture',password:password.trim()})).state,'denied');
        const granted=await command({op:'login',client:'fixture',password});
        assert.equal(granted.state,'granted');
        assert.deepEqual(await jsonMessage(socket,{...request,accessToken:granted.token}),approved);
        assert.deepEqual(site.errors,[]);
    } finally {socket?.terminate();await site.close();}
    console.log('ok native WebAccess persistence, direct WebSocket approval, duplicate token rejection and revocation');
}

async function verifyNativeProfileSessions(binary,folder) {
    const launch = () => fixture(binary,folder,false,'',{
        websocketRequests:true,
        bindProfileSessions() {},
        onRequest(socket,_message,admission) {socket.send(JSON.stringify(admission.profile ?? null));},
    });
    const user = 'читатель';
    let site = await launch();
    let socket;
    try {
        const token = await site.transport.profileRequest('issue',{user});
        assert.match(token,/^[a-f0-9]{48}$/);
        socket = await openSocket(site);
        const payload = {action:'resume-user-profile',profileAccessToken:token};
        const proof = await jsonMessage(socket,payload);
        assert.equal(proof.user,user);
        assert.equal(site.transport.profileProofUser(token,{...proof,token}),user);
        assert.equal(await jsonMessage(socket,`{"action":"resume-user-profile","profileAccessToken":"${token}","profileAccessToken":""}`),null);

        const attempts = new ProfileTotpAttempts(null,site.transport);
        const now = Date.now();
        for (let index=0; index<attemptLimit; index++) await attempts.failed(user,now);
        assert.equal(await attempts.allows(user,now),false);
        assert.equal(await attempts.allows('another-reader',now),true);
        assert.equal(site.transport.profileProofUser(token,{...proof,token}),user);
        await attempts.delete(user);
        assert.equal(await attempts.allows(user,now),true);
        for (let index=0; index<attemptLimit; index++) await attempts.failed(user,now);
        assert.equal(await attempts.allows(user,now+5*60*1000),true);
        for (let index=0; index<attemptLimit; index++) await attempts.failed(user,now);
        await attempts.clear();
        assert.equal(await attempts.allows(user,now),true);

        await site.transport.profileRequest('close',{token});
        assert.equal(site.transport.profileProofUser(token,{...proof,token}),undefined);
        assert.equal((await jsonMessage(socket,payload)).user,'');

        const beforeRestart = await site.transport.profileRequest('issue',{user});
        await site.close();
        site = await launch();
        socket = await openSocket(site);
        assert.equal(await site.transport.profileRequest('check',{token:beforeRestart}),'');
        assert.equal((await jsonMessage(socket,{...payload,profileAccessToken:beforeRestart})).user,'');
        assert.deepEqual(site.errors,[]);
    } finally {
        socket?.terminate();
        await site.close();
    }
    console.log('ok native profile session proofs, revocation, restart and TOTP attempt limits');
}

async function verifyNativeProfileLogin(binary, folder) {
    const site = await fixture(binary, folder, false, '', {bindProfileSessions() {}});
    const WebWorker = require('../server/core/WebWorker');
    const ReadingListStore = require('../server/core/ReadingListStore');
    const ProfilePassword = require('../server/core/ProfilePassword');
    const ProfileTotp = require('../server/core/ProfileTotp');
    const SecretStore = require('../server/core/SecretStore');
    const {writeFileAtomic} = require('../server/core/FilePersistence');
    const config = {dataDir:folder,adminPassword:'local-http-test-fixture',adminEventLogEnabled:false};
    const store = new ReadingListStore(config);
    const worker = Object.assign(Object.create(WebWorker.prototype),{
        config,myState:'normal',readingListStore:store,profileTransport:site.transport,
    });
    const login = 'native-reader';
    const password = 'пароль 🤖 \0 test';
    const denied = {code:'INPX_INVALID_PROFILE_CREDENTIALS'};
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    try {
        const user = await store.createUser({name:'Native reader',login,passwordHash:ProfilePassword.legacy(login,password)});
        const getCredentials = store.getProfileCredentials;
        const saveCredentials = store.updateProfileCredentials;
        store.getProfileCredentials = () => assert.fail('Read a current profile through the compatibility path');
        store.updateProfileCredentials = () => assert.fail('Wrote a current profile through the compatibility path');
        try {
            await assert.rejects(worker.loginUserProfile(login,'wrong'),denied);
            assert.equal((await worker.loginUserProfile(login,password)).userId,user.id);
        } finally {
            store.getProfileCredentials = getCredentials;
            store.updateProfileCredentials = saveCredentials;
        }
        assert.match((await store.getProfileCredentials(user.id)).passwordHash,/^scrypt:v1:/);

        const admin = await worker.loginUserProfile('admin',config.adminPassword);
        await worker.setUserProfileTotpRequired(admin.userId,admin.profileAccessToken,user.id,true,config.adminPassword);
        await assert.rejects(worker.loginUserProfile(login,password),{code:'need_profile_otp_setup'});
        const {state,recoveryCodes} = await ProfileTotp.enable(new SecretStore(config),user.id,secret,-1);
        await store.updateProfileCredentials(user.id,{profileTotp:state});
        await assert.rejects(worker.loginUserProfile(login,password),{code:'need_profile_otp'});
        await store.updateReaderProgress(user.id,'fixture-book',{percent:0.4});
        const journal = await readFile(store.progressFile);
        const previous = JSON.parse(await readFile(store.file,'utf8'));
        previous.fixtureExtra = {unknown:['preserve',17]};
        await writeFileAtomic(store.file,JSON.stringify(previous));
        const signIn = () => worker.loginUserProfile(login,password,recoveryCodes[0],{rememberDevice:true});
        let concurrent;
        store.updateProfileCredentials = () => assert.fail('Wrote a recovery code through the compatibility path');
        try {
            concurrent = await Promise.allSettled([signIn(),signIn()]);
        } finally {
            store.updateProfileCredentials = saveCredentials;
        }
        const accepted = concurrent.filter(result=>result.status==='fulfilled');
        assert.equal(accepted.length,1);
        assert.equal(accepted[0].value.userId,user.id);
        assert.equal(accepted[0].value.trustedDeviceToken,undefined);
        assert.equal(concurrent.find(result=>result.status==='rejected').reason.code,denied.code);
        const committed = JSON.parse(await readFile(store.file,'utf8'));
        assert.equal(committed.readerProgressCheckpoint,previous.readerProgressCheckpoint);
        assert.deepEqual(committed.fixtureExtra,previous.fixtureExtra);
        assert.deepEqual(await readFile(store.progressFile),journal);
        assert.equal((await store.getUser(user.id)).readerProgress['fixture-book'].percent,0.4);

        const code = ProfileTotp.hotp(Buffer.from('12345678901234567890'),Math.floor(Date.now()/30000));
        const trusted = await worker.loginUserProfile(login,password,code,{rememberDevice:true});
        assert.match(trusted.trustedDeviceToken,/^[a-f0-9]{64}$/);
        assert.equal((await worker.loginUserProfile(login,password,'',trusted)).userId,user.id);
        await assert.rejects(worker.loginUserProfile(login,password,code),denied);

        const attempts = new ProfileTotpAttempts(null,site.transport);
        const now = Date.now();
        for (let index=1; index<attemptLimit; index++) await attempts.failed(user.id,now);
        assert.equal(await attempts.allows(user.id,now),false);
        await assert.rejects(worker.loginUserProfile(login,password,recoveryCodes[1]),denied);
        await worker.setUserProfileBlocked(admin.userId,admin.profileAccessToken,user.id,true);
        assert.equal(await attempts.allows(user.id,now),true);
        assert.equal(await worker.getProfileSessionUser(trusted.profileAccessToken),'');

        const oldLogin = 'legacy-reader';
        const old = await store.createUser({name:'Legacy reader',login:oldLogin,passwordHash:ProfilePassword.legacy(oldLogin,password)});
        const oldData = JSON.parse(await readFile(store.file,'utf8'));
        oldData.version = 4;
        delete oldData.readerProgressCheckpoint;
        delete oldData.profileAuthPolicy;
        const oldRow = oldData.users.find(user=>user.id===old.id);
        oldRow.id = ` ${old.id} `;
        oldRow.login = '  LEGACY-READER  ';
        oldRow.name = '  Legacy    reader  ';
        oldRow.blocked = 'true';
        oldData.users.splice(1,0,{id:'invalid-name',name:'\t ',login:oldLogin,passwordHash:oldRow.passwordHash});
        oldData.users.push({...oldRow,id:old.id,login:'duplicate-login',passwordHash:ProfilePassword.legacy('duplicate-login',password)});
        await writeFileAtomic(store.file,'\ufeff'+JSON.stringify(oldData));
        store.getProfileCredentials = () => assert.fail('Read a version 4 profile through the compatibility path');
        store.updateProfileCredentials = () => assert.fail('Wrote a version 4 profile through the compatibility path');
        try {
            await assert.rejects(worker.loginUserProfile('duplicate-login',password),denied);
            assert.equal((await worker.loginUserProfile(oldLogin,password)).userId,old.id);
            const persisted = JSON.parse(await readFile(store.file,'utf8'));
            const row = persisted.users.find(user=>user.id===oldRow.id);
            assert.match(row.passwordHash,/^scrypt:v1:/);
            assert.equal(row.login,oldRow.login);
            assert.equal(persisted.version,4);
            assert.equal(persisted.readerProgressCheckpoint,undefined);

            const recovery = 'ABCDE-FGHIJ-KLMNO-PQRST';
            const hash = createHash('sha256').update(old.id+'\0'+recovery.replaceAll('-','')).digest('hex');
            row.profileTotp = {secret:'damaged secret',lastStep:'invalid step',recoveryHashes:[hash,hash,null]};
            await writeFileAtomic(store.file,JSON.stringify(persisted));
            await assert.rejects(worker.loginUserProfile(oldLogin,password),{code:'need_profile_otp'});
            await assert.rejects(worker.loginUserProfile(oldLogin,password,'123456'),denied);
            assert.equal((await worker.loginUserProfile(oldLogin,password,recovery)).userId,old.id);
            await assert.rejects(worker.loginUserProfile(oldLogin,password,recovery),denied);
        } finally {
            store.getProfileCredentials = getCredentials;
            store.updateProfileCredentials = saveCredentials;
        }

        const fallbackLogin = 'fallback-reader';
        const fallback = await store.createUser({name:'Fallback reader',login:fallbackLogin,passwordHash:ProfilePassword.legacy(fallbackLogin,password)});
        const fallbackData = JSON.parse(await readFile(store.file,'utf8'));
        fallbackData.users.push({id:'', name:'Needs a generated ID', login:'unassigned'});
        await writeFileAtomic(store.file,JSON.stringify(fallbackData));
        const save = store.save;
        const issue = worker.createProfileSession;
        store.save = async () => {throw new Error('Fixture credentials write failed');};
        worker.createProfileSession = () => assert.fail('Issued a session before the credential write');
        try {
            await assert.rejects(worker.loginUserProfile(fallbackLogin,password),/Fixture credentials write failed/);
        } finally {
            store.save = save;
            worker.createProfileSession = issue;
        }
        assert.equal((await worker.loginUserProfile(fallbackLogin,password)).userId,fallback.id);
        assert.match((await store.getProfileCredentials(fallback.id)).passwordHash,/^scrypt:v1:/);
        assert.equal(JSON.parse(await readFile(store.file,'utf8')).version,5);
        assert.deepEqual(site.errors,[]);
    } finally {await site.close();}
    console.log('ok native profile registry, journal continuity, recovery replay protection, trusted browsers and legacy profile upgrade');
}

async function verifyRequestAdmission(binary,folder) {
    let work, disconnected;
    const held=(count)=>({count,seen:0,entered:Promise.withResolvers(),release:Promise.withResolvers()});
    const awaitEntered=() => Promise.race([work.entered.promise,
        require('node:timers/promises').setTimeout(10000,null,{ref:false}).then(()=>{throw new Error('Requests did not reach the handler');})]);
    const site=await fixture(binary,folder,false,'',{websocketRequests:true,textOnly:true,
        async onRequest(socket,message,admission,config) {
            assert(admission);
            const {request,reply}=readRequest(message,admission,config);
            if (request?.hold && reply.ok) {
                const current=work;
                if (++current.seen===current.count) current.entered.resolve();
                await current.release.promise;
            }
            socket.send(JSON.stringify({...reply,validation:admission.validation,forwarded:message.length}));
        },
    });
    try {
        const socket=await openSocket(site);
        const tooLarge={action:'test',requestId:{id:7},payload:'Ж'.repeat(530000)};
        const reduced=await jsonMessage(socket,tooLarge);
        assert.deepEqual(reduced.requestId,{id:7});
        assert.equal(reduced.error,'Превышен размер запроса');
        assert.equal(reduced.validation,2);
        assert(reduced.forwarded<128);
        const malformed=JSON.stringify(tooLarge).slice(0,-1);
        const rejected=await jsonMessage(socket,malformed);
        assert.equal(rejected.validation,0);
        assert.throws(()=>JSON.parse(malformed),error=>error.message===rejected.error);
        const invalid=await jsonMessage(socket,{payload:'invalid envelope'});
        assert.equal(invalid.error,'Некорректный запрос WebSocket');
        const allowed=await jsonMessage(socket,{...tooLarge,action:'update-reader-preferences'});
        assert.equal(allowed.ok,true);
        assert(allowed.forwarded>1024*1024);
        const update={wsMessageLimitMb:2};
        const resume=await pauseDirectRoutes(site.config,update);
        Object.assign(site.config,update);
        await resume();
        assert.equal((await jsonMessage(socket,tooLarge)).ok,true);

        const closedForCapacity=async (peer,send)=>{
            const closed=once(peer,'close',{signal:AbortSignal.timeout(10000)});
            send();
            assert.equal((await closed)[0],1013);
        };
        work=held(8);
        const sendBlock=peer=>{for (let n=0;n<8;n++) peer.send(JSON.stringify({action:'test',hold:true,requestId:n}));};
        const saturated=await openSocket(site);
        sendBlock(saturated);
        await awaitEntered();
        await closedForCapacity(saturated,()=>saturated.send('{"action":"test"}'));
        const remaining=await Promise.all(Array.from({length:7},()=>openSocket(site)));
        disconnected=work;
        work=held(56);
        remaining.forEach(sendBlock);
        await awaitEntered();
        const another=await openSocket(site);
        await closedForCapacity(another,()=>another.send('{"action":"test"}'));
        assert.equal(disconnected.seen+work.seen,64);
        disconnected.release.resolve();
        work.release.resolve();
    } finally {disconnected?.release.resolve();work?.release.resolve();await site.close();}

    const largeSite=await fixture(binary,join(folder,'large'),false,'',{websocketRequests:true,textOnly:true,
        async onRequest(socket,message,admission,config) {
            const {reply}=readRequest(message,admission,config);
            assert.equal(reply.ok,true);
            work.entered.resolve();
            await work.release.promise;
            socket.send(JSON.stringify(reply));
        },
    });
    try {
        work=held(1);
        const first=await openSocket(largeSite);
        const payload=JSON.stringify({action:'update-reader-preferences',payload:'z'.repeat(1024*1024)});
        first.send(payload);
        await awaitEntered();
        const second=await openSocket(largeSite);
        const closed=once(second,'close',{signal:AbortSignal.timeout(10000)});
        second.send(payload);
        assert.equal((await closed)[0],1013);
    } finally {work.release.resolve();await largeSite.close();}
    console.log('ok Rust WebSocket request envelopes, live limits, concurrency and disconnect accounting');
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

async function timed(stage,rounds,operation,warmup=500) {
    const samples=[[],[]];
    for (let round=0;round<rounds+warmup;round++) {
        for (const i of round%2 ? [1,0] : [0,1]) {
            const start=performance.now();
            const close=await operation(i);
            if (round>=warmup) samples[i].push((performance.now()-start)*1000);
            if (typeof close==='function') await close();
        }
    }
    const stats=values=>{
        values.sort((a,b)=>a-b);
        return {medianUs:values[Math.floor(values.length*0.5)],p95Us:values[Math.ceil(values.length*0.95)-1]};
    };
    console.log(JSON.stringify({stage,before:stats(samples[0]),after:stats(samples[1])}));
}

async function websocketBenchmark(binary,folder,control) {
    const before=await fixture(control,join(folder,'before'),false,'',{nativeWebSocket:false});
    let after;
    try {
        after=await fixture(binary,join(folder,'after'));
        const sites=[before,after];
        const connections=await Promise.all(sites.map(site=>openSocket(site)));
        assert.equal(before.nativeConnections(),0);
        assert.equal(after.nativeConnections(),1);
        await timed('websocket-handshake',180,async i=>{
            const socket=await openSocket(sites[i]);
            return async()=>{
                const ended=once(socket,'close',{signal:AbortSignal.timeout(5000)});
                socket.close();
                await ended;
            };
        },30);
        const small=JSON.stringify({action:'test',requestId:'r-12345',message:'тестовый запрос'});
        await timed('websocket-echo-small',1500,i=>echo(connections[i],small),300);
        const medium='a'.repeat(32*1024);
        await timed('websocket-echo-32k',500,i=>echo(connections[i],medium),80);
        const large='a'.repeat(1024*1024);
        await timed('websocket-echo-1m',120,i=>echo(connections[i],large),20);
    } finally {await Promise.all([before.close(),after?.close()]);}
}

async function requestBenchmark(binary,folder,control) {
    const onRequest=(socket,message,admission,config)=>socket.send(JSON.stringify(readRequest(message,admission,config).reply));
    const before=await fixture(control,join(folder,'before'),false,'',{onRequest,textOnly:true});
    let after;
    try {
        after=await fixture(binary,join(folder,'after'),false,'',{onRequest,textOnly:true,websocketRequests:true});
        const sockets=await Promise.all([before,after].map(site=>openSocket(site)));
        const run=(payload,expected)=>async i=>assert.deepEqual(await jsonMessage(sockets[i],payload),expected);
        const small={action:'test',requestId:'fixture',payload:'короткий запрос'};
        await timed('websocket-request-small',1200,run(JSON.stringify(small),{requestId:'fixture',ok:true}),100);
        const payload='я'.repeat(550000);
        await timed('websocket-request-oversized',90,run(JSON.stringify({...small,payload}),
            {requestId:'fixture',error:'Превышен размер запроса'}),15);
        await timed('websocket-request-allowed-large',90,run(JSON.stringify({...small,action:'update-reader-preferences',payload}),
            {requestId:'fixture',ok:true}),15);
    } finally {await Promise.all([before.close(),after?.close()]);}
}

async function accessBenchmark(binary,folder,control) {
    const config={trustedProxyCidrs:['127.0.0.1/32']};
    const before=await fixture(control,join(folder,'before'),true,'',{...config,nativeAccess:false});
    const agents=[new http.Agent({keepAlive:true,maxSockets:1}),new http.Agent({keepAlive:true,maxSockets:1})];
    let after;
    try {
        after=await fixture(binary,join(folder,'after'),true,'',config);
        const sites=[before,after];
        const headers={'Remote-User':'fixture','X-Forwarded-Host':'proxy.fixture','X-Forwarded-Proto':'https'};
        const get=(path,headers,status)=>async i=>assert.equal((await request(sites[i],path,agents[i],headers)).status,status);
        await timed('access-denied-http',1500,get('/small',{},401),250);
        await timed('access-authorized-http',1200,get('/small',headers,200),200);
        await timed('access-protected-bundle-180k',600,get(chunkPath,headers,200),100);
        await timed('access-websocket-wrong-origin',160,async i=>{
            await assert.rejects(openSocket(sites[i],{headers:{...headers,Origin:'https://another.fixture'}}),/403/);
        },30);
    } finally {
        for (const agent of agents) agent.destroy();
        await Promise.all([before.close(),after?.close()]);
    }
}

async function serviceAccessBenchmark(binary,folder,control) {
    const config={trustedProxyCidrs:['127.0.0.1/32'],metricsEnabled:true,metricsToken:'fixture-metrics',
        absEnabled:true,absToken:'fixture-abs'};
    const before=await fixture(control,join(folder,'before'),true,'',config);
    const agents=[new http.Agent({keepAlive:true,maxSockets:1}),new http.Agent({keepAlive:true,maxSockets:1})];
    let after;
    try {
        after=await fixture(binary,join(folder,'after'),true,'',config);
        const sites=[before,after];
        const get=(path,status,body)=>async i=>{
            const result=await request(sites[i],path,agents[i]);
            assert.equal(result.status,status);
            if (body) assert.equal(result.body.toString(),body);
        };
        const denied=coverPath(config,'fixture-book',undefined,'0'.repeat(64));
        await timed('metrics-query-valid',1200,get('/metrics?token=fixture-metrics',200),200);
        await timed('metrics-query-invalid',1200,get('/metrics?token=invalid',401),200);
        await timed('abs-cover-signature-valid',1200,get(coverPath(config),404,'{"error":"Book not found"}'),200);
        await timed('abs-cover-signature-invalid',1200,get(denied,401),200);
        assert.deepEqual(after.serviceApprovals,{metrics:1400,metadata:0,cover:1400});
        assert.deepEqual(before.serviceApprovals,{metrics:0,metadata:0,cover:0});
    } finally {
        for (const agent of agents) agent.destroy();
        await Promise.all([before.close(),after?.close()]);
    }
}

async function benchmark(binary,folder,assetsOnly) {
    const direct=await fixture(assetsOnly ? binary : null,folder,false,'',{serveAssets:false});
    let rust;
    const agents=[new http.Agent({keepAlive:true,maxSockets:1}),new http.Agent({keepAlive:true,maxSockets:1})];
    const parallel=[new http.Agent({keepAlive:true,maxSockets:16}),new http.Agent({keepAlive:true,maxSockets:16})];
    try {
        rust=await fixture(binary,folder);
        const sites=[direct,rust];
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

async function main(binary,mode,control) {
    const paired=['websocket-benchmark','requests-benchmark','access-benchmark','service-access-benchmark'];
    if(!binary || (paired.includes(mode) && !control))
        throw new Error(`Usage: node scripts/rust-http-tests.js <inpx-server> [benchmark | ${paired.join(' | ')} <old-inpx-server>]`);
    const root=resolve(tmpdir());
    const folder=await mkdtemp(join(root,'inpx-rust-http-'));
    try {
        await new (require('../server/core/AppLogger'))().init({dataDir:folder,loggingEnabled:false});
        if (mode==='service-access-benchmark') await serviceAccessBenchmark(resolve(binary),folder,resolve(control));
        else if (mode==='access-benchmark') await accessBenchmark(resolve(binary),folder,resolve(control));
        else if (mode==='requests-benchmark') await requestBenchmark(resolve(binary),folder,resolve(control));
        else if (mode==='websocket-benchmark') await websocketBenchmark(resolve(binary),folder,resolve(control));
        else if (mode==='benchmark' || mode==='assets-benchmark') await benchmark(resolve(binary),folder,mode==='assets-benchmark');
        else {
            await verify(resolve(binary),join(folder,'transport'));
            await verifyAccess(resolve(binary),join(folder,'access'));
            await verifyServiceRouteOverlap(resolve(binary),join(folder,'access-overlap'));
            await verifyWebSocketLimits(resolve(binary),join(folder,'websocket'));
            await verifyRequestAdmission(resolve(binary),join(folder,'requests'));
            await verifyNativeLibraryAccess(resolve(binary),join(folder,'library-access'));
            await verifyNativeProfileSessions(resolve(binary),join(folder,'profile-sessions'));
            await verifyNativeProfileLogin(resolve(binary),join(folder,'profile-login'));
            await verifyAssets(resolve(binary),join(folder,'assets'));
        }
    } finally {
        assert.equal(dirname(folder),root);
        await rm(folder,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
