const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createServer, request: httpRequest} = require('node:http');
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, dirname, resolve} = require('node:path');
const {pipeline} = require('node:stream/promises');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {setTimeout:sleep} = require('node:timers/promises');
const {WebSocket, WebSocketServer} = require('ws');

const execute = promisify(execFile);
const upstream = '/upstream';
const password = 'test-remote-library-password';
const admin = 'test-remote-admin-password';

function proxy() {
    const websocket = new WebSocketServer({noServer:true});
    const sessions = new Set();
    const state = {connections:0,inpx:[],metadata:[],books:[],downloads:[]};
    let offline = false;
    let truncate = false;
    const server = createServer((request,response) => {
        if (request.url === '/state') {
            response.setHeader('content-type','application/json');
            return response.end(JSON.stringify(state));
        }
        if (request.url === '/offline' || request.url === '/online') {
            offline = request.url === '/offline';
            if (offline) for (const socket of sessions) socket.terminate();
            return response.end();
        }
        if (request.url === '/truncate') {
            truncate = true;
            return response.end();
        }
        if (offline) return response.writeHead(503).end();
        state.downloads.push(request.url);
        if (truncate) {
            truncate = false;
            response.writeHead(200,{'content-length':500});
            response.write('incomplete book');
            setTimeout(()=>response.destroy(),30);
            return;
        }
        const outgoing = httpRequest('http://provider:12380'+request.url,{
            method:request.method,headers:{...request.headers,host:'provider:12380'},
        }, answer => {
            response.writeHead(answer.statusCode,answer.headers);
            answer.pipe(response);
        });
        outgoing.on('error',()=>response.writeHead(502).end());
        request.pipe(outgoing);
    });
    server.on('upgrade',(request,socket,head) => {
        if (offline) return socket.destroy();
        assert.equal(request.url,upstream+'/ws');
        const target = new WebSocket('ws://provider:12380'+request.url);
        target.on('error',()=>socket.destroy());
        socket.on('close',()=>target.terminate());
        target.once('open',()=>websocket.handleUpgrade(request,socket,head,client=>{
            state.connections++;
            sessions.add(client);
            sessions.add(target);
            const close = (source,destination) => {
                sessions.delete(source);
                destination.terminate();
            };
            client.on('close',()=>close(client,target));
            target.on('close',()=>close(target,client));
            client.on('error',()=>target.terminate());
            const requests = new Map();
            client.on('message',data=>{
                const message = JSON.parse(data);
                if (message.action==='get-inpx-file') {
                    const trace = {hash:message.inpxFileHash};
                    state.inpx.push(trace);
                    requests.set(message.requestId,trace);
                }
                if (message.action==='get-library-metadata')
                    state.metadata.push({kind:message.kind,cursor:message.cursor,revision:message.revision});
                if (message.action==='get-book-link') state.books.push(message.bookUid);
                if (target.readyState === WebSocket.OPEN) target.send(data.toString());
            });
            target.on('message',data=>{
                const message = JSON.parse(data);
                const trace = requests.get(message.requestId);
                if (trace && !message._rok) {
                    trace.result = message.data === false ? 'unchanged' : typeof message.data === 'string' ? 'archive' : 'error';
                    requests.delete(message.requestId);
                }
                if (client.readyState === WebSocket.OPEN) client.send(data.toString());
            });
        }));
    });
    server.listen(8080,'0.0.0.0');
}

async function zip(file, entries) {
    const archive = new (require('yazl').ZipFile)();
    await fs.mkdir(dirname(file),{recursive:true});
    const pending = pipeline(archive.outputStream,createWriteStream(file));
    for (const [name,data] of entries) archive.addBuffer(Buffer.from(data),name);
    archive.end();
    await pending;
}

async function fixture(library, changed = false) {
    const fb2 = '<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Remote FB2</book-title><lang>en</lang></title-info></description><body><section><p>Remote FB2 text</p></section></body></FictionBook>';
    const books = Array.from({length:1002},(_,idx)=>{
        const id = idx+1, epub = id===1002;
        const title = id===1 ? changed ? 'Remote FB2 refreshed' : 'Remote FB2' : epub ? 'Remote EPUB' : 'Other remote book '+id;
        const ext = epub ? 'epub' : 'fb2';
        const row = ['Tester,Smoke:','sf:',title,'','0',id,400,id,0,ext,'2026-11-17','en',0,''].join('\x04');
        const count = epub ? 1500 : id===1 ? changed ? 8 : 4 : 1;
        return {row,file:id+'.'+ext,count};
    });
    if (!changed) {
        const epub = join(library,'input.epub');
        await fs.mkdir(library,{recursive:true});
        await require('./epub-fb2-tests').fixture(epub);
        await zip(join(library,'fixture.zip'),[['1.fb2',fb2],['1002.epub',await fs.readFile(epub)]]);
    }
    await zip(join(library,'fixture.next'),[
        ['collection.info','Remote library fixture\n'],['version.info',changed?'20261118':'20261117'],
        ['fixture.inp',books.map(book=>book.row).join('\n')+'\n'],
    ]);
    await fs.rename(join(library,'fixture.next'),join(library,'fixture.inpx'));
    const reviews = Array.from({length:12},(_,i)=>({
        name:'Reader '+i,time:'17 November',text:(changed?'Updated review ':'Review ')+i,
    }));
    await zip(join(library,'reviews','001.zip'),[['fixture.zip#1.fb2',JSON.stringify(reviews)]]);
    await zip(join(library,'reviews','additional.zip'),[['books.json',JSON.stringify(
        books.map(({file,count})=>({folder:'fixture.zip',file,count,sum:count*4})),
    )]]);
    const key = createHash('md5').update('tester smoke').digest('hex');
    await zip(join(library,'etc','authors','1.zip'),[
        [key+'.html','<p onclick="throw 1">'+(changed?'Updated biography':'Remote biography')+'</p>'],
    ]);
    return createHash('sha256').update(await fs.readFile(join(library,'fixture.inpx'))).digest('hex');
}

async function docker(...args) {
    return (await execute('docker',args,{windowsHide:true,timeout:40000})).stdout.trim();
}

async function wait(read,accept,message) {
    const until = Date.now()+45000;
    while (Date.now()<until) {
        const value = await read();
        if (accept(value)) return value;
        await sleep(200);
    }
    assert.fail(message);
}

async function listen(name, port, ready = '/ready') {
    const base = 'http://'+await docker('port',name,port+'/tcp');
    await wait(async()=>{
        try {
            const response = await fetch(base+ready,{signal:AbortSignal.timeout(1500)});
            await response.body.cancel();
            return response.ok;
        } catch { return false; }
    },Boolean,name+' did not become ready');
    return base;
}

async function pair(label, image, providerImage, directory) {
    const {connect} = require('./rust-events-tests');
    const folder = await fs.mkdtemp(join(directory,label+'-'));
    const library = join(folder,'library');
    const prefix = 'inpx-remote-'+label+'-'+process.pid;
    const provider = prefix+'-provider', client = prefix+'-client', bridge = prefix+'-proxy';
    const containers = [];
    let browser;
    const mount = (source,target,readonly = false) => ['--mount','type=bind,source='+source+',target='+target+(readonly?',readonly':'')];
    async function run(name, options, target, ...args) {
        containers.push(name);
        await docker('run','-d','--name',name,'--network',prefix,...options,target,...args);
    }
    const common = ['-p','127.0.0.1::12380','-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false',
        '-e','INPX_ALLOW_ANONYMOUS_ACCESS=true','-e','INPX_AUTH_EXEMPT_HEALTH=true','-e','INPX_ENABLE_CONVERSION=false'];
    const app = ['--host=0.0.0.0','--port=12380','--data-dir=/data','--admin-password='+admin];
    try {
        const firstHash = await fixture(library);
        await docker('network','create',prefix);
        const providerData = join(folder,'provider');
        await fs.mkdir(providerData);
        const providerConfig = {
            allowRemoteLib:true,accessPassword:password,server:{host:'0.0.0.0',port:'12380',root:upstream},
            librarySources:[{id:'backend-source',name:'Supplier',inpx:'/library/fixture.inpx',libDir:'/library'}],
            inpxCheckInterval:0.03,loggingEnabled:false,
        };
        await fs.writeFile(join(providerData,'config.json'),JSON.stringify(providerConfig));
        await run(provider,[...common,'--network-alias','provider',...mount(library,'/library',true),
            ...mount(providerData,'/data')],providerImage,...app,'--lib-dir=/library','--inpx=/library/fixture.inpx');
        await listen(provider,12380);
        const ws = dirname(require.resolve('ws/package.json'));
        await run(bridge,['-p','127.0.0.1::8080','--network-alias','bridge',
            ...mount(resolve(__filename),'/test/remote.js',true),...mount(ws,'/test/node_modules/ws',true)],
        'node:24-bookworm-slim','node','/test/remote.js','proxy');
        const proxyBase = await listen(bridge,8080,'/state');
        const trace = async()=>await (await fetch(proxyBase+'/state')).json();
        const control = async operation=>{ assert((await fetch(proxyBase+'/'+operation)).ok); };
        const clientData = join(folder,'client');
        await fs.mkdir(clientData);
        await fs.writeFile(join(clientData,'config.json'),JSON.stringify({
            remoteLib:{url:'ws://bridge:8080'+upstream+'/ws',accessPassword:password},
            inpxCheckInterval:0.033,
        }));
        await run(client,[...common,...mount(clientData,'/data')],image,...app,
            '--lib-dir=/ignored','--inpx=/ignored.inpx');
        const base = await listen(client,12380);
        browser = await connect(base);
        const send = async (action,fields={}) => {
            const result = await browser.send(action,fields);
            assert.equal(result.error || '','',action+': '+result.error);
            return result;
        };
        const search = (title, extra={}) => send('bookSearch',{query:{title:'='+title,...extra}});
        const a = (await search('Remote FB2')).found[0]._uid;
        const b = (await search('Remote EPUB')).found[0]._uid;
        const inpx = join(clientData,'remote.inpx');
        const original = await fs.stat(inpx);
        const unchanged = await wait(trace, state=>state.inpx.some(row=>row.hash===firstHash && row.result==='unchanged'),
            label+' did not skip INPX with the same hash');
        assert.equal(unchanged.inpx.filter(row=>row.result==='archive').length,1);
        assert.equal((await fs.stat(inpx)).mtimeMs,original.mtimeMs);
        assert.deepEqual(await fs.readFile(inpx),await fs.readFile(join(library,'fixture.inpx')));
        const download = uid => fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'original'}),
            {signal:AbortSignal.timeout(10000)});
        await control('truncate');
        assert.equal((await download(a)).status,502);
        const fb2 = await download(a);
        assert.equal(fb2.status,200);
        assert.match(await fb2.text(),/Remote FB2 text/);
        const epub = await download(b);
        assert.equal(epub.status,200);
        assert.equal(epub.headers.get('content-type'),'application/epub+zip');
        assert.equal(Buffer.from(await epub.arrayBuffer()).subarray(0,4).toString('hex'),'504b0304');
        const seen = await trace();
        assert(seen.books.some(uid=>uid!==a && uid!==b),'UIDs must use the provider source');
        assert(seen.downloads.every(path=>path.startsWith(upstream+'/book/')));
        const metadata = await send('get-book-reviews',{bookUid:a});
        assert.equal(metadata.reviews.length,12);
        assert(metadata.reviews.some(review=>review.text==='Review 11'));
        assert.deepEqual(metadata.libraryRating,{value:4,count:4});
        const bio = await send('get-author-info',{author:'Tester Smoke'});
        assert.equal(bio.authorInfo.html,'<p>Remote biography</p>');
        assert.equal((await search('Remote EPUB',{ratingCount:'1500'})).found[0]._uid,b);
        const paged = await trace();
        assert(paged.metadata.some(request=>request.kind==='reviews' && request.cursor===10));
        assert(paged.metadata.some(request=>request.kind==='ratings' && request.cursor===1000 && request.revision));
        console.log(label+' initial INPX, matching hash, FB2/EPUB, interrupted download, reviews and paged ratings');

        await control('offline');
        assert((await browser.send('get-book-reviews',{bookUid:a})).error);
        assert.equal((await search('Remote FB2')).found[0]._uid,a);
        assert.equal((await fs.stat(inpx)).mtimeMs,original.mtimeMs);
        const changedHash = await fixture(library,true);
        await control('online');
        await wait(()=>search('Remote FB2 refreshed'),result=>result.found?.length===1,
            label+' did not refresh the catalogue after reconnect');
        const updated = await trace();
        assert(updated.connections>paged.connections);
        await wait(trace,state=>state.inpx.some(row=>row.hash===changedHash && row.result==='unchanged'),
            label+' did not acknowledge the updated INPX hash');
        assert.deepEqual(await fs.readFile(inpx),await fs.readFile(join(library,'fixture.inpx')));
        const after = await send('get-book-reviews',{bookUid:a});
        assert(after.reviews.some(review=>review.text==='Updated review 11'));
        assert.deepEqual(after.libraryRating,{value:4,count:8});
        assert.equal((await search('Remote FB2 refreshed',{ratingCount:'8'})).found[0]._uid,a);
        assert.equal((await send('get-author-info',{author:'Tester Smoke'})).authorInfo.text,'Updated biography');
        assert.match(await (await download(a)).text(),/Remote FB2 text/);
        console.log(label+' outage, live local search, reconnect, changed INPX and refreshed metadata/ratings');
    } catch (error) {
        for (const name of containers) {
            const logs = await execute('docker',['logs','--tail','30',name],{timeout:6000}).catch(()=>null);
            if (logs) console.error(name,logs.stdout,logs.stderr);
        }
        throw error;
    } finally {
        browser?.close();
        for (const name of containers.reverse()) await docker('rm','-f',name).catch(()=>{});
        await docker('network','rm',prefix).catch(()=>{});
    }
}

async function main(image, rc15) {
    assert(image && rc15,'Usage: node scripts/rust-remote-tests.js <rust-image> <rc15-image>');
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-remote-'));
    try {
        await pair('rust-rust',image,image,directory);
        await pair('rust-rc15',image,rc15,directory);
    } finally { await fs.rm(directory,{recursive:true,force:true}); }
}

if (process.argv[2]==='proxy') proxy();
else if (require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{
    console.error(error);
    process.exitCode=1;
});
