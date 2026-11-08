const assert=require('assert');
const Budget=require('../server/core/ClientRequestBudget');
const {selectDiverseBest}=require('../server/core/DiscoverySelection');
const WebSocket=require('ws');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

async function testNativeBudgetSharesOnlySameProfileAndBoundsParallelWork(){
    const budget=new Budget({parallel:2,perUser:1}),first=deferred(),calls=[];
    const a=budget.run('a','same',()=>{calls.push('a');return first.promise;});
    const duplicate=budget.run('a','same',()=>{throw new Error('Duplicate executed');});
    const next=budget.run('a','next',()=>{calls.push('next');return 2;});
    const other=budget.run('b','same',()=>{calls.push('b');return 3;});
    await tick();assert.deepStrictEqual(calls,['a','b']);assert.strictEqual(await other,3);
    first.resolve(1);assert.deepStrictEqual(await Promise.all([a,duplicate,next]),[1,1,2]);
    await tick();assert.deepStrictEqual(calls,['a','b','next']);assert.strictEqual(budget.active,0);assert.strictEqual(budget.queue.length,0);
}

async function testNativeBudgetDropsDisconnectedQueueAndAllowsLiveCoalescedWaiter(){
    const budget=new Budget({parallel:1}),gate=deferred();
    const running=budget.run('a','gate',()=>gate.promise);
    let alive=true,executions=0;
    const gone=budget.run('b','gone',()=>++executions,()=>alive).catch(error=>error.code);
    const shared=budget.run('c','shared',()=>++executions,()=>alive);
    const live=budget.run('c','shared',()=>{throw new Error('Duplicate');},()=>true);
    alive=false;gate.resolve();await running;
    assert.strictEqual(await gone,'request_cancelled');assert.strictEqual(await shared,1);assert.strictEqual(await live,1);
    await tick();assert.strictEqual(budget.shared.size,0);
}

async function testNativeBudgetReturnsCompatibleRetryInformationAndRecovers(){
    const budget=new Budget({parallel:1,queued:1,waitMs:15}),gate=deferred();
    const first=budget.run('a','one',()=>gate.promise);
    const queued=budget.run('a','two',()=>2).catch(error=>error);
    await assert.rejects(budget.run('b','three',()=>3),error=>error.code==='server_busy'&&error.retryAfterMs>0);
    const keepAlive=setTimeout(()=>{},100);
    const expired=await queued;clearTimeout(keepAlive);assert.strictEqual(expired.code,'server_busy');
    gate.resolve(1);await first;await tick();assert.strictEqual(await budget.run('a','two',()=>2),2);
}

function fullSort(rows,compare,limit){
    const selected=[],authors=new Map(),series=new Map();
    for(const row of [...rows.values()].sort(compare)){
        const author=String(row.author||'').trim().toLowerCase(),name=String(row.series||'').trim().toLowerCase();
        if(author&&(authors.get(author)||0)>=2||name&&(series.get(name)||0)>=2)continue;
        selected.push(row);if(author)authors.set(author,(authors.get(author)||0)+1);if(name)series.set(name,(series.get(name)||0)+1);
        if(selected.length>=limit)break;
    }return selected;
}
async function testDiscoveryBoundedRankingMatchesFullSortIncludingDiversity(){
    let seed=731;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
    const compare=(a,b)=>b.rank-a.rank||a.id-b.id;
    for(const count of [0,1,30,1000])for(const kind of ['varied','one-author','tied']){
        const rows=new Map(Array.from({length:count},(_,id)=>[id,{id,rank:kind==='tied'?0:random()%1000,
            author:kind==='one-author'?'Author':`Author ${random()%45}`,series:`Series ${random()%20}`} ]));
        for(const limit of [1,8,24])assert.deepStrictEqual(selectDiverseBest(rows,compare,limit),fullSort(rows,compare,limit),`${count}/${kind}/${limit}`);
    }
    const workerFunction=new Function('return ('+selectDiverseBest.toString()+')')();
    const rows=new Map(Array.from({length:100000},(_,id)=>[id,{id,rank:random(),author:`Author ${id}`,series:''}]));
    let comparisons=0;
    const result=workerFunction(rows,(a,b)=>{comparisons++;return compare(a,b);},8);
    assert.deepStrictEqual(result,fullSort(rows,compare,8));assert(comparisons<300000,'Ranking a small shelf must not sort the full catalog');
}

function controller(){return Object.create(require('../server/controllers/WebSocketController').prototype);}
async function testNativeResumeBindsOnlyValidatedOwnSessionWithoutPassword(){
    const value=controller(),sent=[];value.send=result=>sent.push(result);value.security={};
    value.webWorker={getProfileSessionUser:token=>token==='valid'?'owner':'',
        requireAuthorizedUser:async(id,token)=>{assert.strictEqual(token,'valid');return {id};}};
    const socket={req:{securitySession:{}}};
    await value.resumeUserProfile({userId:'owner',profileAccessToken:'valid'},socket);
    assert.strictEqual(socket.req.securitySession.profileAccessToken,'valid');assert.strictEqual(sent[0].userId,'owner');
    await assert.rejects(value.resumeUserProfile({userId:'other',profileAccessToken:'valid'},socket),/need_profile_login/);
    await assert.rejects(value.resumeUserProfile({profileAccessToken:'expired'},socket),/need_profile_login/);
    assert(value.isCsrfProtectedAction('resume-user-profile'));assert(value.isCsrfProtectedAction('subscribe-client-events'));
}

async function testReaderEventsAreOptInProfileScopedAndExcludeTheWriter(){
    const value=controller(),received=[];
    const socket=(name,user,token)=>({readyState:WebSocket.OPEN,clientEvents:user?{userId:user,token}:null,
        send:raw=>received.push({name,...JSON.parse(raw)}),close:()=>received.push({name,closed:true})});
    const origin=socket('origin','owner','valid'),other=socket('other','owner','valid'),legacy=socket('web'),
        foreign=socket('foreign','foreign','foreign'),expired=socket('expired','owner','expired');
    value.wss={clients:new Set([origin,other,legacy,foreign,expired])};
    value.webWorker={getProfileSessionUser:token=>token==='valid'?'owner':token==='foreign'?'foreign':''};
    value.publishClientChanges({action:'update-reader-progress',profileAccessToken:'valid',bookUid:'book'},origin);
    assert.deepStrictEqual(received,[{name:'other',type:'client-event',kind:'reader',bookUid:'book'},{name:'expired',closed:true}]);
    assert(!JSON.stringify(received).includes('valid'),'Events never include authorization tokens');
}

async function testMobileHomeOmitsSecretsAndNeverBuildsDiscovery(){
    const value=controller();let result;
    value.send=data=>{result=data;};
    value.webWorker={requireAuthorizedUser:async()=>({id:'owner',name:'Reader',passwordHash:'secret',smtpPass:'secret'}),
        getUserReadingLibrary:async(user,options)=>{assert(options.limit<=300);return {items:[]};},
        getReadingLists:async()=>({lists:[{id:'one'}]}),getDiscoveryShelvesV2:()=>{throw new Error('Expensive discovery called');}};
    await value.getMobileHome({userId:'owner',limit:90000},{});
    assert.deepStrictEqual(result.profile,{id:'owner',name:'Reader'});assert.deepStrictEqual(result.lists,[{id:'one'}]);
    assert(!JSON.stringify(result).includes('secret'));
}

async function testDiscoveryConcurrentLoadsShareWorkAndReturnIndependentValues(){
    const worker=Object.create(require('../server/core/WebWorker').prototype);worker.discoveryCache=new Map();
    const gate=deferred();let calls=0;
    const loader=()=>{calls++;return gate.promise;};
    const a=worker.rememberDiscovery('same',loader),b=worker.rememberDiscovery('same',loader);
    await tick();assert.strictEqual(calls,1);gate.resolve({items:[{title:'Book'}]});
    const [first,second]=await Promise.all([a,b]);first.items[0].title='Changed';assert.strictEqual(second.items[0].title,'Book');
    assert.strictEqual((await worker.rememberDiscovery('same',loader)).items[0].title,'Book');
    await assert.rejects(worker.rememberDiscovery('bad',async()=>{throw new Error('temporary');}),/temporary/);
    assert.deepStrictEqual(await worker.rememberDiscovery('bad',async()=>[]),[]);
}

async function testConnectionQrPreservesHttpHttpsAndRootWithoutCredentials(){
    const {serverUrl,qrPayload,downloadUrl}=require('../shared/AppConnection');
    const downloadSvg=await require('qrcode').toString(downloadUrl,{type:'svg',width:288,margin:4,errorCorrectionLevel:'M'});
    assert.equal(await require('fs-extra').readFile(require('path').join(__dirname,'../client/assets/inpx-reader-download-qr.svg'),'utf8'),downloadSvg,
        'The static download QR must encode the current download URL');
    for(const origin of ['http://192.168.50.50:12380','https://books.example']){
        const address=serverUrl(origin,'/library/');assert.strictEqual(address,origin+'/library/');
        const payload=new URL(qrPayload(address));assert.strictEqual(payload.protocol,'inpx-reader:');
        assert.strictEqual(payload.searchParams.get('server'),address);assert.strictEqual(payload.searchParams.get('v'),'1');
        assert.strictEqual(payload.searchParams.size,2);
        const png=await require('qrcode').toDataURL(payload.href,{width:240});assert(png.startsWith('data:image/png;base64,'));
    }
    for(const value of ['https://user:password@books.example/','https://books.example/?token=secret','file:///etc/passwd'])
        assert.throws(()=>qrPayload(value));
}

module.exports=[testNativeBudgetSharesOnlySameProfileAndBoundsParallelWork,testNativeBudgetDropsDisconnectedQueueAndAllowsLiveCoalescedWaiter,
    testNativeBudgetReturnsCompatibleRetryInformationAndRecovers,testDiscoveryBoundedRankingMatchesFullSortIncludingDiversity,
    testNativeResumeBindsOnlyValidatedOwnSessionWithoutPassword,testReaderEventsAreOptInProfileScopedAndExcludeTheWriter,
    testMobileHomeOmitsSecretsAndNeverBuildsDiscovery,testDiscoveryConcurrentLoadsShareWorkAndReturnIndependentValues,
    testConnectionQrPreservesHttpHttpsAndRootWithoutCredentials,...require('./reader-audio-cancel-tests')];
