const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {once} = require('node:events');
const {join} = require('node:path');
const {setTimeout:sleep} = require('node:timers/promises');
const {ZipFile} = require('yazl');
const WebSocket = require('ws');

const title = 'Книга проверки синхронизации';
const password = 'mobile-events-fixture-admin';

async function zip(path, files) {
    const archive = new ZipFile();
    const chunks = [];
    archive.outputStream.on('data',part=>chunks.push(part));
    const done = once(archive.outputStream,'end');
    for (const [name,data] of files) archive.addBuffer(Buffer.from(data),name);
    archive.end();
    await done;
    await fs.writeFile(path,Buffer.concat(chunks));
}

async function fixture(library, count = 3600) {
    await fs.mkdir(library,{recursive:true});
    const book = annotation=>'<FictionBook><description><title-info><book-title>'+title+'</book-title>'+
        '<annotation><p>'+annotation+'</p></annotation><lang>ru</lang></title-info>'+
        '<publish-info><isbn>0-306-40615-2</isbn></publish-info></description>'+
        '<body><section><title><p>Первая глава</p></title><p>Текст для проверки синхронизации.</p></section></body></FictionBook>';
    const small = book('Одна короткая аннотация.');
    const slow = book('а'.repeat(360*1024));
    const row = (name,member,size,id)=>['Тестов,Автор:','sf:',name,'',0,member,Buffer.byteLength(size),id,0,
        'fb2','2026-11-17','ru',0,''].join('\x04');
    const rows = [row(title,1,small,1),...Array.from({length:count},(_,i)=>row('Книга для ISBN '+(i+1),2,slow,i+2))];
    await zip(join(library,'events.inpx'),[['collection.info','Синхронизация\n'],['events.inp',rows.join('\n')+'\n']]);
    await zip(join(library,'events.zip'),[['1.fb2',small],['2.fb2',slow]]);
}

async function connect(base, root = '', cookie) {
    if (!cookie) {
        const page = await fetch(base+root+'/');
        assert.equal(page.status,200);
        cookie = page.headers.getSetCookie().find(value=>value.startsWith('inpx_web_session='))?.split(';')[0];
        await page.body.cancel();
    }
    assert(cookie,'Test requires a browser session');
    const socket = new WebSocket(base.replace(/^http/,'ws')+root+'/ws',{headers:{origin:base,cookie}});
    await once(socket,'open',{signal:AbortSignal.timeout(8000)});
    const pending = new Map(), events = [];
    let sequence = 0, csrfToken;
    socket.on('message',raw=>{
        const value = JSON.parse(raw);
        if (value.type==='client-event') events.push(value);
        else if (!value._rok) pending.get(value.requestId)?.(value);
    });
    const send = (action, fields = {})=>new Promise((resolve,reject)=>{
        const requestId = String(++sequence);
        const timer = setTimeout(()=>{pending.delete(requestId);reject(new Error('No reply to '+action));},10000);
        pending.set(requestId,value=>{clearTimeout(timer);pending.delete(requestId);resolve(value);});
        socket.send(JSON.stringify({action,requestId,csrfToken,...fields}));
    });
    const config = await send('get-config');
    csrfToken = config.csrfToken;
    assert(csrfToken,config.error);
    return {socket,cookie,send,config,events,close:()=>socket.terminate()};
}

async function waitFor(read, condition, message, attempts = 150) {
    for (let i=0;i<attempts;i++) {
        const value = await read();
        if (condition(value)) return value;
        await sleep(35);
    }
    assert.fail(message);
}

async function signIn(client, login = 'admin', secret = password) {
    const reply = await client.send('login-user-profile',{login,password:secret});
    assert(reply.profileAccessToken,reply.error);
    return {userId:reply.userId,profileAccessToken:reply.profileAccessToken};
}

async function verify(base, root = '') {
    const sockets = [];
    const open = async cookie=>{
        const client=await connect(base,root,cookie);
        sockets.push(client);
        return client;
    };
    try {
        const writer = await open();
        assert(writer.config.clientApi.features.includes('mobileHome'));
        assert(writer.config.clientApi.features.includes('readerEvents'));
        const owner = await signIn(writer);
        const send = (action,fields)=>writer.send(action,{...owner,...fields});
        const uid = (await send('bookSearch',{query:{title:'='+title,del:'0'}})).found[0]._uid;
        const observer = await open();
        const watching = await signIn(observer);
        const silent = await open();
        await signIn(silent);
        const created = await send('create-user-profile',{profile:{name:'Отдельный читатель',login:'other-reader',password:'events-other-fixture'}});
        assert(created.user?.id,created.error);
        const other = await open(), otherIdentity = await signIn(other,'other-reader','events-other-fixture');
        const anon = await open();
        assert.equal((await anon.send('subscribe-client-events',{userId:'admin'})).error,'need_profile_login');
        assert.equal((await observer.send('subscribe-client-events',{...watching,csrfToken:''})).error,'bad_csrf_token');
        assert.equal((await observer.send('subscribe-client-events',watching)).enabled,true);
        assert.equal((await other.send('subscribe-client-events',otherIdentity)).enabled,true);
        assert.equal((await send('subscribe-client-events')).enabled,true);
        const empty = await observer.send('get-mobile-home',watching);
        assert.deepEqual(Object.keys(empty.profile).sort(),['createdAt','id','isAdmin','login','name']);
        assert.equal(empty.profile.id,owner.userId);
        assert.equal(empty.reading.state,'all');
        assert.equal(empty.reading.items.length,0);
        assert.equal(empty.lists.length,0);
        assert(Number.isInteger(empty.indexGeneration));

        const update = (percent,baseRevision)=>send('update-reader-progress',{bookUid:uid,progress:{percent,baseRevision,generation:0}});
        const first = await update(0.25,0);
        assert.equal(first.progress?.percent,0.25,first.error);
        await waitFor(()=>observer.events,events=>events.length===1,'Observer did not receive first change');
        assert.deepEqual(observer.events.shift(),{type:'client-event',kind:'reader',bookUid:uid});
        const current = await observer.send('get-mobile-home',watching);
        assert.equal(current.reading.items[0].percent,0.25);
        assert.equal(current.reading.counters.reading,1);
        assert.equal((await update(0.99,0)).progress.conflict,true);
        await sleep(80);
        assert.equal(observer.events.length,0,'A conflict must not publish a change');
        assert.equal(other.events.length,0,'Events must stay in the matching profile');
        assert.equal(silent.events.length,0,'Unsubscribed client must not receive pushed events');
        assert.equal(writer.events.length,0,'Publisher should not be notified about its own writes');

        observer.close();
        assert.equal((await update(0.41,1)).progress.percent,0.41);
        const reconnect = await open(observer.cookie);
        assert.equal((await reconnect.send('resume-user-profile',watching)).userId,owner.userId);
        assert.equal((await reconnect.send('subscribe-client-events',watching)).enabled,true);
        assert.equal((await reconnect.send('get-mobile-home',watching)).reading.items[0].percent,0.41);
        const createdList = await send('create-reading-list',{name:'Синхронизация полки'});
        assert(createdList.list?.id,createdList.error);
        await waitFor(()=>reconnect.events,events=>events.length===1,'Reconnected observer did not receive a new change');
        assert.equal((await reconnect.send('get-mobile-home',watching)).lists[0].name,'Синхронизация полки');
        assert.equal((await reconnect.send('subscribe-client-events',{...watching,enabled:false})).enabled,false);
        reconnect.events.length = 0;
        assert.equal((await update(0.57,2)).progress.percent,0.57);
        await sleep(80);
        assert.equal(reconnect.events.length,0,'Explicit unsubscribe must stop pushes');
        assert.equal((await reconnect.send('subscribe-client-events',watching)).enabled,true);
        await observerRevoked(base,root,writer,reconnect,watching,update,sockets);

        const bulk = Object.fromEntries(Array.from({length:310},(_,i)=>['legacy-'+i,{percent:0.3,updatedAt:'2001-01-01T00:00:00.000Z'}]));
        assert.equal((await send('import-reading-lists',{data:{lists:[],user:{readerProgress:bulk}}})).importedProgress,310);
        const limited = await send('get-mobile-home',{limit:1000});
        assert.equal(limited.reading.count,311);
        assert.equal(limited.reading.items.length,300);
        assert.equal(limited.reading.items[0].bookUid,uid);
        assert.equal(limited.reading.items.at(-1).unavailable,true);
        const separate = await other.send('get-mobile-home',otherIdentity);
        assert.equal(separate.profile.id,otherIdentity.userId);
        assert.equal(separate.reading.count,0);
        assert.deepEqual(separate.lists,[]);

        const started = await send('start-isbn-index',{options:{force:true}});
        assert.equal(started.state,'running',started.error);
        const running = await waitFor(()=>send('get-background-tasks'),result=>{
            const row = result.tasks?.find(row=>row.kind==='isbn');
            return row && row.done>0 && row.done<row.total;
        },'Did not see live ISBN progress');
        const task = running.tasks.find(row=>row.kind==='isbn');
        assert.equal(task.state,'running');
        assert.equal(task.progress,task.done/task.total);
        assert(task.remainingSeconds>=1);
        assert.equal(running.isbnIndex.total,task.total);
        const nonAdmin = await other.send('get-background-tasks',otherIdentity);
        assert.equal(nonAdmin.isbnIndex,null);
        assert(!nonAdmin.tasks.some(row=>row.kind==='isbn'));
        await send('cancel-isbn-index');
        const stopped = await waitFor(()=>send('get-background-tasks'),result=>result.isbnIndex?.state==='paused','ISBN pause was not published');
        assert(stopped.isbnIndex.checked>=task.done);
        assert(!stopped.tasks.some(row=>row.kind==='isbn'));
        console.log('ok mobile home, profile-scoped live events and resubscribe, revocation, ISBN progress and permissions');
    } finally {
        sockets.forEach(client=>client.close());
    }
}

async function observerRevoked(base, root, writer, subscriber, identity, update, clients) {
    // A second socket carries the same profile token and can close that browser session.
    const revoker = await connect(base,root,subscriber.cookie);
    clients.push(revoker);
    assert.equal((await revoker.send('logout-user-profile',identity)).success,true);
    const closed = once(subscriber.socket,'close',{signal:AbortSignal.timeout(5000)});
    const change = await update(0.68,3);
    assert.equal(change.progress?.percent,0.68,change.error);
    assert.equal((await closed)[0],1008);
    assert.equal(subscriber.events.length,0);
    assert.equal(writer.events.length,0);
}

module.exports = {fixture,verify,connect,signIn,title,password,waitFor,zip};

if (require.main===module) {
    const [target,path] = process.argv.slice(2);
    (target==='fixture' ? fixture(path) : verify(target,path)).catch(error=>{console.error(error);process.exitCode=1;});
}
