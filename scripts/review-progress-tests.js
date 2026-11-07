const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const {pipeline} = require('stream/promises');
const {LoadProgress,sharedLoad} = require('../server/core/LoadProgress');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

async function temporary(work) {
    const root = path.resolve(__dirname,'../tmp'); await fs.ensureDir(root);
    const dir = await fs.mkdtemp(path.join(root,'reviews-progress-'));
    try {return await work(dir);} finally {await fs.remove(dir);}
}
async function logger() {
    require('../server/core/Logger');
    const log = new (require('../server/core/AppLogger'))();
    if (!log.inited) await log.init({loggingEnabled:false,name:'reviews-progress-tests'});
}

async function testReviewProgressTransportKeepsFinalReplyAndRequestIsolation() {
    const Connection = require('../server/core/WebSocketConnection');
    const connection = Object.assign(Object.create(Connection.prototype),{listeners:[],messageQueue:[]});
    const first = [], second = [];
    // Progress can arrive after the acknowledgement but before the API starts
    // waiting for its final response. It must be delivered once, not retained.
    connection.messageQueue.push({mes:{requestId:1,_progress:true,progress:{done:1,total:4}}});
    const one = connection.message(1,120,value=>first.push(value));
    const two = connection.message(2,120,value=>second.push(value));
    assert.equal(connection.listeners.length,2); assert.equal(connection.messageQueue.length,0);
    connection.emit({requestId:2,_progress:true,progress:{done:2,total:4}});
    connection.emit({requestId:1,_progress:true,progress:{done:3,total:4}});
    assert.deepEqual(first.map(value=>value.done),[1,3]); assert.deepEqual(second.map(value=>value.done),[2]);
    connection.emit({requestId:1,reviews:['one']}); connection.emit({requestId:2,reviews:['two']});
    assert.deepEqual((await one).reviews,['one']); assert.deepEqual((await two).reviews,['two']);
    assert.equal(connection.listeners.length,0);
    const legacy = connection.message(3); connection.emit({requestId:3,reviews:[]}); assert.deepEqual((await legacy).reviews,[]);
    const failing = connection.message(4,120,()=>{throw new Error('View already gone');});
    connection.emit({requestId:4,_progress:true,progress:{done:1,total:2}});
    connection.emit({requestId:4,error:'offline'}); assert.equal((await failing).error,'offline');
    const disconnect = connection.message(5), rejected = assert.rejects(disconnect,/disconnected/);
    connection.emit('disconnected',true); await rejected; assert.equal(connection.listeners.length,0);
}

async function testReviewProgressIsThrottledAndSharedObserversDetach() {
    const progress = new LoadProgress(1000), observed = [];
    const unsubscribe = progress.subscribe(value=>observed.push(value));
    for (let done=0;done<=100;done++) progress.update('reviews',{phase:'Проверка архивов',done,total:100,unit:'archives'});
    assert.equal(observed.length,1,'A tight archive/byte loop must not send one frame per counter update');
    progress.flush(); assert.equal(observed.length,2); assert.equal(observed[1].steps[0].done,100);
    unsubscribe(); progress.close(); assert.equal(progress.listeners.size,0); assert.equal(progress.timer,null);
    const state = {}, left = [], right = [];
    let release, calls=0;
    const work = async update => {calls++;update({phase:'Чтение',done:5,total:10});await new Promise(resolve=>{release=resolve;});return 'ready';};
    const one = sharedLoad(state,'promise',{phase:'Подготовка',total:null},work,value=>left.push(value));
    while (!release) await new Promise(resolve=>setImmediate(resolve));
    const two = sharedLoad(state,'promise',{},work,value=>right.push(value));
    release(); assert.deepEqual(await Promise.all([one,two]),['ready','ready']); assert.equal(calls,1);
    assert(left.length && right.length); assert.equal(state.promiseProgress.listeners.size,0);
    await assert.rejects(sharedLoad({},'promise',{},async()=>{throw new Error('offline');}),/offline/);
}

async function testReviewProgressUsesActualJsonBytesAndUnknownRemoteTotals() {
    await temporary(async dir => {
        const json = JSON.stringify(Array.from({length:1000},(_,i)=>({folder:'books.zip',file:i+'.fb2',sum:4,count:1,padding:'я'.repeat(80)})));
        const file = path.join(dir,'ratings.zip'), zip = new (require('yazl').ZipFile)();
        const done = pipeline(zip.outputStream,fs.createWriteStream(file)); zip.addBuffer(Buffer.from(json),'books.json'); zip.end(); await done;
        const reader = new (require('../server/core/ZipReader'))(); await reader.open(file,false);
        const progress = []; let rows=0;
        try {await require('../server/core/LibraryReviews').ratingRows(reader,()=>rows++,dir,value=>progress.push(value));}
        finally {await reader.close();}
        assert.equal(rows,1000); assert(progress.length>2);
        assert(progress.every(value=>value.total===Buffer.byteLength(json)));
        assert.equal(progress[0].done,0); assert.equal(progress.at(-1).done,Buffer.byteLength(json));
        for (let i=1;i<progress.length;i++) assert(progress[i].done>=progress[i-1].done);
        const Remote = require('../server/core/RemoteMetadata'), remote = new Remote({});
        remote.supported = async()=>true;
        remote.request = async(_kind,{cursor})=>({items:Array.from({length:cursor ? 5:10},(_,i)=>({text:'Review '+i})),next:cursor ? null:10});
        const external = [], reviews = await remote.reviews('book',value=>external.push(value));
        assert.equal(reviews.length,15); assert(external.every(value=>value.total===null));
        assert.equal(external.at(-1).done,15,'Remote pages expose an actual count, never an invented denominator');
    });
}

async function testReviewProgressOnlyGoesToTheOptedInRequester() {
    await logger();
    const Controller = require('../server/controllers/WebSocketController');
    const controller = Object.assign(Object.create(Controller.prototype),{config:{},webAccess:{hasAccess:async()=>true},activeRequests:0,
        webWorker:{getBookReviewDetails:async(_uid,onProgress)=>{onProgress?.({steps:[{id:'reviews',done:1,total:2}]});return {reviews:[]};}}});
    const received = [], other = [], socket = {readyState:1,send:raw=>received.push(JSON.parse(raw))}, unrelated = {readyState:1,send:raw=>other.push(JSON.parse(raw))};
    controller.wss = {clients:new Set([socket,unrelated])};
    await controller.onMessage(socket,JSON.stringify({action:'get-book-reviews',bookUid:'book',wantProgress:true,requestId:'one'}));
    assert.equal(received.filter(value=>value._progress).length,1); assert.equal(other.length,0);
    assert(received.every(value=>value.requestId==='one')); assert.deepEqual(received.at(-1).reviews,[]);
    received.length=0;
    await controller.onMessage(socket,JSON.stringify({action:'get-book-reviews',bookUid:'book',requestId:'legacy'}));
    assert.equal(received.filter(value=>value._progress).length,0); assert.deepEqual(received.at(-1).reviews,[]);
}

async function testRemoteRatingProgressSharesRealPageCountsAndDetaches() {
    const Remote = require('../server/core/RemoteMetadata'), remote = new Remote({});
    remote.supported = async()=>true;
    let release, pages=0;
    remote.request = async(_kind,{cursor})=>{
        pages++;
        if (!cursor) await new Promise(resolve=>{release=resolve;});
        return {revision:'one',items:cursor ? [['three',3]]:[['one',1],['two',2]],next:cursor ? null:2};
    };
    const left=[],right=[], one=remote.ratingIndex(value=>left.push(value));
    while (!release) await new Promise(resolve=>setImmediate(resolve));
    const two=remote.ratingIndex(value=>right.push(value));
    release(); const results=await Promise.all([one,two]);
    assert.equal(pages,2,'Concurrent consumers must read each remote page once');
    assert.equal(results[0],results[1]); assert.equal(results[0].counts.size,3);
    for (const frames of [left,right]) {
        assert(frames.every(value=>value.total===null),'Cursor paging does not establish a percentage denominator');
        assert.equal(frames.at(-1).done,3);
    }
    assert.equal(remote.pendingRatingsProgress.listeners.size,0);
    remote.ratings=null; remote.request=async()=>{throw new Error('remote offline');};
    await assert.rejects(remote.ratingIndex(()=>{}),/remote offline/);
    assert.equal(remote.pendingRatings,null); assert.equal(remote.pendingRatingsProgress.listeners.size,0);
}

async function testReviewDetailsCoalesceProgressCleanListenersAndPreserveCache() {
    await logger();
    await temporary(async dir => {
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        const book = {_uid:'book',folder:'books.zip',file:'1',ext:'fb2'}, state = {signature:'one'};
        Object.assign(worker,{config:{bookDir:dir},libraryAssetGeneration:1,checkMyState:()=>{},
            db:{esc:JSON.stringify,select:async()=>[book]},getReviewArchiveState:async()=>state,dbConfig:async()=>({inpxHash:'one'})});
        let release, report, builds=0;
        worker.getBookReviews = async(_book,_state,onProgress)=>{builds++;report=onProgress;await new Promise(resolve=>{release=resolve;});return [{text:'Review'}];};
        worker.getBookLibraryRating = async(_book,_state,onProgress)=>{onProgress({phase:'Чтение оценок',done:20,total:100,unit:'bytes'});return {value:4,count:1};};
        const first=[],second=[];
        const one = worker.getBookReviewDetails('book',value=>first.push(value));
        while (!release) await new Promise(resolve=>setImmediate(resolve));
        const two = worker.getBookReviewDetails('book',value=>second.push(value));
        report({phase:'Чтение отзывов',done:2,total:4,unit:'files'});
        await pause(230); release();
        const results = await Promise.all([one,two]); assert.equal(builds,1); assert.deepEqual(results[0],results[1]);
        assert(first.some(value=>value.steps.some(step=>step.id==='reviews' && step.done===2)));
        assert(second.some(value=>value.steps.some(step=>step.id==='reviews' && step.done===2)));
        assert.equal(worker.bookReviewLoads.size,0);
        await worker.getBookReviewDetails('book'); assert.equal(builds,1,'The completed disk cache remains reusable');
        worker.getBookReviews = async()=>{throw new Error('archive unavailable');};
        await assert.rejects(worker.getBookReviewDetails('other',()=>{}),/archive unavailable/);
        assert.equal(worker.bookReviewLoads.size,0,'Failures must detach request observers too');
    });
}

async function testReviewViewRejectsLateProgressErrorsAndSupportsOldServer() {
    const source = await fs.readFile(path.resolve(__dirname,'../client/components/Search/BookInfoDialog/BookInfoDialog.vue'),'utf8');
    const methods = source.slice(source.indexOf('    invalidateExtras()'),source.indexOf('    extractContents('));
    const View = new Function(`return class {${methods}}`)(), view = new View();
    Object.assign(view,{extrasActive:true,dialogVisible:true,extrasGeneration:0,bookUid:'old'});
    const pending=[];
    view.api = {getBookReviews:(_uid,options)=>new Promise((resolve,reject)=>pending.push({resolve,reject,progress:options.onProgress}))};
    view.invalidateExtras(); const old = view.loadReviews();
    pending[0].progress({steps:[{id:'reviews',phase:'Чтение',done:1,total:4,unit:'files'}]});
    assert.equal(view.reviewStepPercent(view.reviewsProgress[0]),25);
    view.invalidateExtras(); view.bookUid='new'; const current = view.loadReviews();
    pending[0].progress({steps:[{id:'reviews',done:4,total:4}]}); assert.deepEqual(view.reviewsProgress,[]);
    pending[1].progress({steps:[{id:'ratings',phase:'Ожидание',done:2,total:null}]});
    assert.equal(view.reviewStepPercent(view.reviewsProgress[0]),null);
    pending[1].reject(new Error('offline')); await current; assert.match(view.reviewsError,/offline/); assert.deepEqual(view.reviewsProgress,[]);
    view.api.getBookReviews = async()=>({reviews:[{text:'Old server, no progress frames'}]});
    await view.loadReviews(); assert(view.reviewsLoaded); assert.deepEqual(view.reviewsProgress,[]);
    pending[0].resolve({reviews:[{text:'Obsolete'}]}); await old;
    assert.equal(view.reviews[0].text,'Old server, no progress frames');
}

module.exports = [testReviewProgressTransportKeepsFinalReplyAndRequestIsolation,
    testReviewProgressIsThrottledAndSharedObserversDetach,
    testReviewProgressUsesActualJsonBytesAndUnknownRemoteTotals,
    testReviewProgressOnlyGoesToTheOptedInRequester,
    testRemoteRatingProgressSharesRealPageCountsAndDetaches,
    testReviewDetailsCoalesceProgressCleanListenersAndPreserveCache,
    testReviewViewRejectsLateProgressErrorsAndSupportsOldServer];
if (require.main === module) (async()=>{for (const test of module.exports) {await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
