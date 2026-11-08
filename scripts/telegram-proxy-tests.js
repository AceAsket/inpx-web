const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const http=require('http');
const https=require('https');
const net=require('net');
const axios=require('axios');
const network=require('../shared/TelegramNetwork');
const transport=require('../server/core/TelegramTransport');

async function temporary(work) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-telegram-proxy-'));
    try {return await work(directory);} finally {await fs.remove(directory);}
}
async function logger() {require('../server/core/Logger');const log=new(require('../server/core/AppLogger'))();if(!log.inited)await log.init({loggingEnabled:false,name:'telegram-proxy-tests'});}
async function listen(server,host='127.0.0.1') {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});
    return server.address().port;
}
function track(server) {
    const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    return async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));};
}
async function proxyFixture(protocol,work,{auth=true,host='127.0.0.1'}={}) {
    const certificate=await fs.readFile(path.join(__dirname,'fixtures/tls/localhost-cert.pem'));
    const key=await fs.readFile(path.join(__dirname,'fixtures/tls/localhost-key.pem'));
    const requests=[],connections=[],upstreams=new Set();
    const target=https.createServer({key,cert:certificate},(req,res)=>{
        const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
            requests.push({method:req.method,path:req.url,body:Buffer.concat(chunks).toString()});
            res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result:{username:'local_fixture',updates:[]}}));
        });
    });
    const closeTarget=track(target),targetPort=await listen(target,host);
    const username='proxy@user',password='local:p@ss';
    const connect=(socket,port,address,ready)=>{
        const upstream=net.connect({host:address,port});upstreams.add(upstream);
        upstream.on('error',()=>socket.destroy());upstream.on('close',()=>upstreams.delete(upstream));
        socket.on('close',()=>upstream.destroy());
        upstream.on('connect',()=>{ready();socket.pipe(upstream).pipe(socket);});
    };
    let proxy;
    if(protocol.startsWith('socks')) {
        proxy=net.createServer(socket=>{
            let buffer=Buffer.alloc(0),state='greeting';
            const onData=data=>{
                buffer=Buffer.concat([buffer,data]);
                for(;;) {
                    if(state==='greeting') {
                        if(buffer.length<2 || buffer.length<2+buffer[1])return;
                        buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,auth ? 2:0]));state=auth ? 'auth':'request';
                    } else if(state==='auth') {
                        if(buffer.length<2 || buffer.length<3+buffer[1])return;
                        const size=3+buffer[1]+buffer[2+buffer[1]];if(buffer.length<size)return;
                        const user=buffer.subarray(2,2+buffer[1]).toString(),pass=buffer.subarray(3+buffer[1],size).toString();
                        buffer=buffer.subarray(size);
                        if(user!==username || pass!==password){socket.end(Buffer.from([1,1]));return;}
                        socket.write(Buffer.from([1,0]));state='request';
                    } else if(state==='request') {
                        if(buffer.length<5)return;
                        const type=buffer[3],size=type===1 ? 4:type===4 ? 16:buffer[4];
                        const offset=type===3 ? 5:4;if(buffer.length<offset+size+2)return;
                        const address=type===3 ? buffer.subarray(offset,offset+size).toString():type===1 ? [...buffer.subarray(offset,offset+size)].join('.'):'::1';
                        const port=buffer.readUInt16BE(offset+size);connections.push({type,address,port});
                        socket.removeListener('data',onData);state='tunnel';
                        // A fake proxy resolves localhost itself, demonstrating remote DNS.
                        connect(socket,port,type===3 ? host:address,()=>socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0])));
                        return;
                    } else return;
                }
            };
            socket.on('data',onData);socket.on('error',()=>{});
        });
    } else {
        proxy=protocol==='https' ? https.createServer({key,cert:certificate}):http.createServer();
        proxy.on('connect',(req,socket,head)=>{
            const authorization=req.headers['proxy-authorization'];
            if(auth && authorization!=='Basic '+Buffer.from(username+':'+password).toString('base64')) {
                socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');return;
            }
            const port=Number(req.url.slice(req.url.lastIndexOf(':')+1));connections.push({address:req.url,auth:!!authorization});
            connect(socket,port,host,()=>socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
            if(head.length)socket.unshift(head);
        });
    }
    const closeProxy=track(proxy),proxyPort=await listen(proxy,host);
    const config={telegramProxyMode:'custom',telegramProxyProtocol:protocol,telegramProxyHost:host,telegramProxyPort:proxyPort,
        telegramProxyUsername:auth ? username:'',telegramProxyPassword:auth ? password:'',telegramIpFamily:host==='::1' ? '6':'4'};
    const options=(value=config)=>{
        const result=transport.requestOptions(value,{ca:certificate,timeout:5000},`https://localhost:${targetPort}`);
        if(!result.httpsAgent)result.httpsAgent=new https.Agent({ca:certificate});
        result.httpsAgent.options.ca=certificate;
        return {...result,timeout:5000};
    };
    try {await work({config,options,url:`https://localhost:${targetPort}`,requests,connections,certificate});}
    finally {for(const socket of upstreams)socket.destroy();await closeProxy();await closeTarget();}
}

async function testTelegramProxyValidationSecretsBackupAndEnvironment() {
    await logger();
    assert.equal(network.normalizeProxyConfig().telegramProxyMode,'system');
    for(const value of [{telegramProxyMode:'wrong'},{telegramProxyMode:'custom'},{telegramProxyHost:'http://user:pass@host'},
        {telegramProxyHost:'host/path'},{telegramProxyPort:65536},{telegramProxyPort:true},{telegramProxyPassword:'x\nsecret'},
        {telegramProxyUsername:'я'.repeat(200)}])assert.throws(()=>network.normalizeProxyConfig(value));
    assert.equal(network.normalizeProxyConfig({telegramProxyHost:'[::1]'}).telegramProxyHost,'::1');
    const Worker=require('../server/core/WebWorker'),worker=Object.create(Worker.prototype);
    worker.config={telegramProxyMode:'custom',telegramProxyHost:'localhost',telegramProxyPort:1080,telegramProxyPassword:'private-password'};
    worker.checkMyState=()=>{};worker.requireAdmin=async()=>{};
    const info=worker.getAdminIntegrationConfig();assert.equal(info.telegramProxyPassword,'__KEEP__');assert(info.telegramProxyPasswordSet);
    assert.deepEqual(worker.normalizeIntegrationPatch({telegramProxyPassword:'__KEEP__'}),{});
    assert.equal(worker.normalizeIntegrationPatch({telegramProxyPassword:null}).telegramProxyPassword,'');
    assert.throws(()=>worker.normalizeIntegrationPatch({telegramProxyMode:'custom',telegramProxyHost:''}));
    const exported=await worker.exportAdminSettings();assert.equal(exported.settings.telegramProxyPassword,undefined);
    const imported=worker.normalizeImportedAdminSettings({settings:{telegramProxyMode:'system',telegramProxyPassword:'untrusted backup secret'}});
    assert.equal(imported.telegramProxyPassword,undefined);
    assert.equal(transport.effectiveConfig(worker.config,{TELEGRAM_PROXY_MODE:'direct'}).telegramProxyMode,'direct');
    await temporary(async directory=>{
        const store=new(require('../server/core/SecretStore'))({dataDir:directory});
        const protectedConfig=await store.protectConfig(worker.config);
        assert(protectedConfig.telegramProxyPassword.startsWith('enc:v1:'));assert(!JSON.stringify(protectedConfig).includes('private-password'));
        assert.equal((await store.unprotectConfig(protectedConfig)).config.telegramProxyPassword,'private-password');
    });
}

async function testTelegramRealConnectAndSocksAuthenticationDnsAndNoFallback() {
    for(const protocol of ['http','https','socks5','socks5h'])await proxyFixture(protocol,async fixture=>{
        const response=await axios.get(fixture.url+'/botlocal-token/getMe?private=query',fixture.options());
        assert(response.data.ok);assert.equal(fixture.requests.length,1);assert.equal(fixture.connections.length,1);
        if(protocol==='socks5')assert.equal(fixture.connections[0].type,1,'SOCKS5 resolves the target locally');
        if(protocol==='socks5h')assert.equal(fixture.connections[0].type,3,'SOCKS5h delegates target DNS to the proxy');
        await assert.rejects(axios.get(fixture.url+'/must-not-arrive',fixture.options({...fixture.config,telegramProxyPassword:'wrong'})));
        assert.equal(fixture.requests.length,1,'Authentication failure must never fall back to direct');
    });
    await proxyFixture('socks5h',async fixture=>{
        await axios.get(fixture.url+'/ipv6',fixture.options());assert.equal(fixture.requests.length,1);
    },{host:'::1',auth:false});
}

async function testTelegramAllApiPathsUseTransportAndErrorsHideSecrets() {
    await logger();
    await temporary(async directory=>proxyFixture('http',async fixture=>{
        const Worker=require('../server/core/WebWorker'),worker=Object.create(Worker.prototype),token='local-bot-token';
        worker.config={...fixture.config,telegramBotToken:token,telegramShareEnabled:true};
        worker.checkMyState=()=>{};worker.requireAdmin=async()=>{};worker.addAdminEvent=()=>{};
        const rawFile=path.join(directory,'book.fb2');await fs.writeFile(rawFile,'local document fixture');
        worker.readingListStore={getUsers:async()=>({currentUser:{telegramChatId:'local'}}),load:async()=>({users:[{id:'reader',telegramChatId:'local'}]})};
        worker.getDeliveryBookFile=async()=>({book:{title:'Local'},rawFile,downFileName:'book.fb2'});
        const get=axios.get,post=axios.post,agents=[];
        const options=value=>{value.httpsAgent.options.ca=fixture.certificate;agents.push(value.httpsAgent);return value;};
        axios.get=(url,value)=>get(fixture.url+new URL(url).pathname,options(value));
        axios.post=(url,body,value)=>post(fixture.url+new URL(url).pathname,body,options(value));
        try {
            assert((await worker.testAdminIntegrationConfig('admin','local','telegram')).success);
            assert((await worker.sendBookToTelegram('book','','reader')).success);
            const api=new(require('../server/core/TelegramBotApi'))(worker.config,token);
            await api.call('getUpdates',{timeout:1});await api.call('sendMessage',{chat_id:'local',text:'fixture'});
            assert.equal(fixture.requests.length,4);assert.equal(fixture.connections.length,4);
            assert(agents.every(agent=>agent.proxyController.signal.aborted),'Every completed API call disposes its owned agent');
            assert(fixture.requests[1].body.includes('local document fixture'));
            assert.deepEqual(fixture.requests.map(row=>row.path.split('/').at(-1)),['getMe','sendDocument','getUpdates','sendMessage']);
            const cause={response:{status:407,data:{description:`https://name:private@proxy/?token=${token} ${fixture.config.telegramProxyPassword} ${token}`}}};
            const error=transport.safeError(cause,worker.config,token),serialized=JSON.stringify({message:error.message,...error});
            for(const secret of [token,fixture.config.telegramProxyPassword,'name:private','?token='])assert(!serialized.includes(secret));
            assert.equal(error.status,407);assert.equal(error.cause,undefined);assert.equal(error.config,undefined);
            const basic=Buffer.from(fixture.config.telegramProxyUsername+':'+fixture.config.telegramProxyPassword).toString('base64');
            assert(!transport.safeError({response:{data:{description:'Basic '+basic}}},worker.config,token).message.includes(basic));
            const redacted=require('../server/core/SensitiveLog').redact({telegramProxyHost:'http://private:secret@host/?token=other-secret',telegramProxyUsername:'private'});
            assert(!JSON.stringify(redacted).includes('private:secret'));assert(!JSON.stringify(redacted).includes('other-secret'));
            const redirectedPost=axios.post;let rejectedAgent;
            axios.post=async(_url,_body,value)=>{rejectedAgent=value.httpsAgent;throw cause;};
            try {await assert.rejects(api.call('sendMessage'),error=>!error.message.includes(token));assert(rejectedAgent.proxyController.signal.aborted);}
            finally {axios.post=redirectedPost;}
            const createStream=fs.createReadStream;let document;
            fs.createReadStream=(...args)=>(document=createStream(...args));
            worker.config.telegramProxyHost='invalid/path';
            try {await assert.rejects(worker.sendBookToTelegram('book','','reader'));assert(document.destroyed,'A network-options error must close the upload stream');}
            finally {fs.createReadStream=createStream;worker.config.telegramProxyHost=fixture.config.telegramProxyHost;}
        } finally {axios.get=get;axios.post=post;for(const agent of agents)agent.destroy();}
    }));
}

async function testTelegramSystemProxyNoProxyAndDirectBypassNativeEnvironment() {
    const keys=['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy',
        'npm_config_https_proxy','npm_config_proxy','npm_config_no_proxy',...network.proxyFields.map(field=>'TELEGRAM_PROXY_'+field.slice(13).toUpperCase())];
    const previous=new Map(keys.map(key=>[key,process.env[key]]));
    try {
        for(const key of keys)delete process.env[key];
        for(const protocol of ['https','socks5h'])await proxyFixture(protocol,async fixture=>{
            const proxy=new URL(`${protocol}://localhost:${fixture.config.telegramProxyPort}`);
            proxy.username=fixture.config.telegramProxyUsername;proxy.password=fixture.config.telegramProxyPassword;
            process.env.HTTPS_PROXY=protocol==='https' ? proxy.href:'';
            process.env.ALL_PROXY=protocol==='socks5h' ? proxy.href:'';process.env.NO_PROXY='';
            await axios.get(fixture.url+'/system',fixture.options({...fixture.config,telegramProxyMode:'system'}));
            assert.equal(fixture.connections.length,1);assert.equal(fixture.requests.length,1);
            process.env.NO_PROXY='localhost';
            await axios.get(fixture.url+'/no-proxy',fixture.options({...fixture.config,telegramProxyMode:'system'}));
            assert.equal(fixture.connections.length,1);assert.equal(fixture.requests.length,2);
            process.env.NO_PROXY='';
            await axios.get(fixture.url+'/direct',fixture.options({...fixture.config,telegramProxyMode:'direct'}));
            assert.equal(fixture.connections.length,1);assert.equal(fixture.requests.length,3);
            const execFile=require('util').promisify(require('child_process').execFile);
            const script=`const axios=require('axios'),t=require('./server/core/TelegramTransport');(async()=>{const response=await axios.get(${JSON.stringify(fixture.url+'/native-global-direct')},{...t.requestOptions({telegramProxyMode:'direct',telegramIpFamily:'4'}),timeout:5000});console.log(response.data.ok)})().catch(()=>{process.exitCode=1});`;
            const result=await execFile(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),windowsHide:true,timeout:10000,
                env:{...process.env,NODE_USE_ENV_PROXY:'1',NODE_EXTRA_CA_CERTS:path.join(__dirname,'fixtures/tls/localhost-cert.pem'),HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1',NO_PROXY:''}});
            assert.equal(result.stdout.trim(),'true');assert.equal(fixture.connections.length,1);assert.equal(fixture.requests.length,4);
        });
    } finally {for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

async function testTelegramProxyPersistsEncryptedAcrossRestartAndEnvironmentWins() {
    await temporary(async directory=>{
        const file=path.join(directory,'config.json');
        await fs.writeJson(file,{dataDir:directory,telegramProxyMode:'custom',telegramProxyProtocol:'socks5h',telegramProxyHost:'localhost',
            telegramProxyPort:1080,telegramProxyUsername:'local-user',telegramProxyPassword:'local-private-password'});
        const execFile=require('util').promisify(require('child_process').execFile);
        const script=`const Config=require('./server/config');(async()=>{const manager=new Config();await manager.init(${JSON.stringify(directory)},${JSON.stringify(file)});await manager.load();await manager.save();const c=manager.config;console.log(JSON.stringify({mode:c.telegramProxyMode,storedSecret:manager._config.telegramProxyPassword==='local-private-password',environmentSecret:c.telegramProxyPassword==='environment-secret'}))})().catch(e=>{console.error(e);process.exitCode=1});`;
        const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('TELEGRAM_PROXY_'))delete env[name];
        const initial=await execFile(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),windowsHide:true,env});
        assert.equal(JSON.parse(initial.stdout.trim().split(/\r?\n/).at(-1)).storedSecret,true);
        const saved=await fs.readJson(file);assert(saved.telegramProxyPassword.startsWith('enc:v1:'));assert(!JSON.stringify(saved).includes('local-private-password'));
        const restarted=await execFile(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),windowsHide:true,
            env:{...env,TELEGRAM_PROXY_MODE:'direct',TELEGRAM_PROXY_PASSWORD:'environment-secret'}});
        const result=JSON.parse(restarted.stdout.trim().split(/\r?\n/).at(-1));
        assert.deepEqual(result,{mode:'direct',storedSecret:true,environmentSecret:true});
        assert.equal((await fs.readJson(file)).telegramProxyMode,'custom','Environment overrides must not rewrite the saved draft');
    });
}

async function testTelegramStalledProxyHandshakeClosesOnTimeoutAbortAndDestroy() {
    for(const protocol of ['http','https','socks5','socks5h'])for(const reason of ['timeout','abort','destroy']) {
        const sockets=new Set();
        const server=net.createServer(socket=>{sockets.add(socket);socket.on('data',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
        const port=await listen(server),close=track(server);
        const options=transport.requestOptions({telegramProxyMode:'custom',telegramProxyProtocol:protocol,telegramProxyHost:'127.0.0.1',telegramProxyPort:port,telegramIpFamily:'4'},{timeout:5000});
        const controller=new AbortController();let timer;
        try {
            const request=axios.get('https://localhost:443/not-sent',{...options,timeout:reason==='timeout' ? 100:5000,signal:controller.signal});
            if(reason!=='timeout')timer=setTimeout(()=>reason==='abort' ? controller.abort():options.httpsAgent.destroy(),100);
            await assert.rejects(request);
            for(let i=0;i<50 && sockets.size;i++)await new Promise(resolve=>setTimeout(resolve,10));
            assert.equal(sockets.size,0,`${protocol} private handshake socket must close after ${reason}`);
        } finally {clearTimeout(timer);options.httpsAgent.destroy();await close();}
    }
}

module.exports=[testTelegramProxyValidationSecretsBackupAndEnvironment,testTelegramRealConnectAndSocksAuthenticationDnsAndNoFallback,
    testTelegramAllApiPathsUseTransportAndErrorsHideSecrets,testTelegramSystemProxyNoProxyAndDirectBypassNativeEnvironment,
    testTelegramProxyPersistsEncryptedAcrossRestartAndEnvironmentWins,testTelegramStalledProxyHandshakeClosesOnTimeoutAbortAndDestroy];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
