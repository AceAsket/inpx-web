const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {parse}=require('@vue/compiler-sfc');
const {loadClient}=require('./catalog-list-filter-tests');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function preview(uid='one',annotation='Текст',status='ready') {return {bookPreview:{bookUid:uid,annotation,annotationStatus:status,annotationLimited:status==='limited'}};}
function card(api={getBookPreview:async uid=>preview(uid)}) {
    const Type=loadClient(path.resolve(__dirname,'../client/components/Library/BookActionsDialog.vue')).default,value=new Type();
    value.$store={state:{settings:{defaultsSet:true,langDefault:'ru',currentUserId:'reader'},config:{currentUserId:'reader',profileAuthorized:true,
        currentUserProfile:{id:'reader'},onlineReaderEnabled:true,conversionEnabled:false,dbConfig:{inpxHash:'one'}}}};
    value.$route={query:{sourceId:'own',ext:'fb2'}};value.book={_uid:'one',ext:'fb2',author:'Первый Автор, Второй Автор',series:'Цикл, продолжение',_recordHash:'one'};
    value.api=api;value.dialogVisible=true;value.$emit=()=>{};return value;
}

async function testBookPreviewAuthorSeriesAndFullCardRetainScopeAndWholeNames() {
    const value=card();
    assert.equal(value.authorLinks.map(author=>author.label).join(','),value.book.author,'Visible author text preserves all names and separators');
    assert.deepEqual(value.authorLinks.map(author=>author.target),[
        {path:'/author-details',query:{lang:'ru',ext:'fb2',sourceId:'own',name:'Первый Автор'}},
        {path:'/author-details',query:{lang:'ru',ext:'fb2',sourceId:'own',name:'Второй Автор'}},
    ]);
    assert.equal(value.seriesTarget.query.name,'Цикл, продолжение');assert.equal(value.seriesTarget.query.sourceId,'own');
    assert.equal(value.fullCardTarget.query.lang,'ru');
    value.$route.query.lang='en';assert.equal(value.authorLinks[0].target.query.lang,'en');
    value.$store.state.settings.defaultsSet=false;value.$route.query={};value.config.uiDefaults={langDefault:'de'};
    assert.equal(value.seriesTarget.query.lang,'de','First-visit default language matches the catalog');
}

async function testBookPreviewLoadsOnlyBoundedAnnotationAndPreservesStatuses() {
    const calls=[],value=card({getBookPreview:async(uid,options)=>{calls.push({uid,options});return preview(uid,'<img src=x onerror=alert(1)>\nОбычный текст');},
        getBookInfo:()=>assert.fail('Preview must not request full reader data'),getBookCard:()=>assert.fail('Preview must not request a full card')});
    await value.loadAnnotation();assert.equal(calls.length,1);assert(value.annotationText.includes('<img'));assert.equal(value.annotationStatus,'ready');
    await value.loadAnnotation();assert.equal(calls.length,1,'One visible book reuses the completed annotation');
    for(const status of ['empty','limited','unsupported','unavailable']) {
        value.invalidateAnnotation();value.api.getBookPreview=async uid=>preview(uid,'',status);await value.loadAnnotation();
        assert.equal(value.annotationStatus,status);assert.equal(value.annotationLoading,false);
    }
    value.api.getBookPreview=async uid=>preview(uid,'Повтор успешен');await value.retryAnnotation();assert.equal(value.annotationText,'Повтор успешен');
    value.invalidateAnnotation();value.api.getBookPreview=async()=>{throw new Error('network');};await value.loadAnnotation();assert.equal(value.annotationStatus,'unavailable');
    value.invalidateAnnotation();value.embedded=true;value.api.getBookPreview=()=>assert.fail('Embedded full card already has its annotation');await value.loadAnnotation();
    value.embedded=false;value.book.discoveryMissingLocal=true;await value.loadAnnotation();
}

async function testBookPreviewChangingBookProfileAndClosingRejectsLateAnnotations() {
    const pending=[],value=card({getBookPreview:(uid,options)=>{const operation=deferred();pending.push({uid,options,...operation});return operation.promise;}});
    const first=value.loadAnnotation();await value.loadAnnotation();assert.equal(pending.length,1);
    value.book={...value.book,_uid:'two'};value._options.watch.annotationIdentity.call(value);assert.equal(pending.length,2);assert(pending[0].options.signal.aborted);
    pending[0].resolve(preview('one','Obsolete'));await first;assert.equal(value.annotationText,'');assert(value.annotationLoading);
    pending[1].resolve(preview('two','New book'));await tick();assert.equal(value.annotationText,'New book');
    value.invalidateAnnotation();const oldProfile=value.loadAnnotation();value.config.currentUserId='another';value.settings.currentUserId='another';
    value._options.watch.annotationIdentity.call(value);pending[2].resolve(preview('two','Old profile'));await oldProfile;assert.equal(value.annotationText,'');
    value.beforeUnmount();assert(pending[3].options.signal.aborted);pending[3].resolve(preview('two','After close'));await tick();
    assert.equal(value.annotationText,'');assert.equal(value.annotationLoading,false);assert(value.searchDisposed,'Inherited list cleanup is preserved');
}

async function testBookPreviewApiAbortsWithoutLateAuthenticationDialogsOrRetry() {
    const file=path.resolve(__dirname,'../client/components/Api/Api.vue'),source=parse(fs.readFileSync(file,'utf8')).descriptor.script.content;
    const body=source.slice(source.indexOf('class Api {'),source.indexOf('export default'));
    const response=deferred();let sent=0,prompts=0;
    const Type=new Function('require','componentOptions','wsc','utils',body+';return Api;')(require('module').createRequire(file),{},
        {send:async()=>++sent,message:()=>response.promise},{});
    const api=new Type();api.$store={state:{settings:{},config:{}}};api.showPasswordDialog=()=>{prompts++;};
    const controller=new AbortController(),request=api.getBookPreview('one',{signal:controller.signal});
    controller.abort(new Error('closed view'));await assert.rejects(request,/closed view/);
    response.resolve({error:'need_access_token'});await tick();assert.equal(prompts,0);assert.equal(sent,1);
    assert.equal(require('events').getEventListeners(controller.signal,'abort').length,0);
    await assert.rejects(api.getBookPreview('two',{signal:controller.signal}),/closed view/);assert.equal(sent,1,'An already cancelled view sends no request');
}
async function testBookPreviewMetadataShowsGenresPublicationYearAndSafeKeywords(){
    const value=card({getBookPreview:async uid=>({bookPreview:{...preview(uid).bookPreview,publishedYear:'2003',genres:['sf'],keywords:'север, сказка'}})});
    value.book.genre='sf,detective';value.book.date='2026-11-07';value.genreMap=new Map([['sf','Фантастика'],['detective','Детектив']]);
    assert.deepEqual(value.genreLabels,['Фантастика','Детектив']);assert.equal(value.publicationYear,'');
    await value.loadAnnotation();assert.equal(value.publicationYear,'2003');assert.deepEqual(value.keywordLabels,['север','сказка']);
    value.invalidateAnnotation();assert.equal(value.publicationYear,'');assert.deepEqual(value.keywordLabels,[]);
    value.book.keywords='<img src=x>, ещё';assert.equal(value.keywordLabels[0],'<img src=x>');
    value.book.keywords='';value.book.year='0';value.book.publishedYear='2024-03-01';assert.equal(value.publicationYear,'2024');
}

module.exports=[testBookPreviewAuthorSeriesAndFullCardRetainScopeAndWholeNames,testBookPreviewLoadsOnlyBoundedAnnotationAndPreservesStatuses,
    testBookPreviewChangingBookProfileAndClosingRejectsLateAnnotations,testBookPreviewApiAbortsWithoutLateAuthenticationDialogsOrRetry,
    testBookPreviewMetadataShowsGenresPublicationYearAndSafeKeywords];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
