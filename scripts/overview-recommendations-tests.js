const assert=require('assert/strict');
const {LibraryRepository}=require('../client/components/Library/libraryRepository');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){const calls=[];let now=0;const config={profileAuthorized:true,currentUserId:'alice',clientApi:{features:['mobileHome','overviewRecommendations']}};
    const settings={currentUserId:'alice',profileAccessToken:'alice-token'},api={getMobileHome:async()=>({reading:{items:[]},lists:[]}),
        getDiscoveryShelves:async options=>{calls.push(options);return options.recommendationsOnly?{shelves:[{id:'similar-books',items:[{_uid:'one',title:'Рекомендация'},{_uid:'hidden',hidden:true}]}]}:{shelves:[{id:'newest',items:[{_uid:'new'}]}]};}};
    const repository=new LibraryRepository(api,()=>{},()=>now);repository.setContext(config,settings);return {repository,api,calls,config,settings,advance:value=>{now+=value;}};}

async function testOverviewRecommendationsAreBoundedCachedAndSeparateFromNewest(){
    const {repository,calls,advance}=fixture();await repository.loadHome();
    assert.deepEqual(repository.state.recommendations.map(book=>book._uid),['one']);assert.equal(repository.state.shelves[0].id,'newest');
    assert.deepEqual(calls.find(options=>options.recommendationsOnly),{recommendationsOnly:true,personalLimit:12});
    await repository.loadHome({freshReading:true});assert.equal(calls.filter(options=>options.recommendationsOnly).length,1);
    advance(15*60000);await repository.loadRecommendations();assert.equal(calls.filter(options=>options.recommendationsOnly).length,2);
}
async function testOverviewSlowRecommendationsDoNotDelayOtherShelvesAndRejectOldProfile(){
    const {repository,api,config}=fixture(),slow=deferred();api.getDiscoveryShelves=async options=>options.recommendationsOnly?slow.promise:{shelves:[{id:'newest',items:[{_uid:'new'}]}]};
    const pending=repository.loadHome();await new Promise(resolve=>setImmediate(resolve));
    assert(repository.state.readingLoaded);assert(repository.state.shelvesLoaded);assert(repository.state.recommendationsLoading);
    repository.setContext({...config,currentUserId:'bob'},{currentUserId:'bob',profileAccessToken:'bob-token'});
    slow.resolve({shelves:[{id:'similar-books',items:[{_uid:'alice-secret'}]}]});await pending;
    assert.deepEqual(repository.state.recommendations,[]);assert.equal(repository.state.recommendationsLoading,false);
}
async function testOverviewRecommendationsHandleEmptyDisabledOldServerAndExpiredSession(){
    const {repository,api,config,settings}=fixture();let requests=0;api.getDiscoveryShelves=async()=>{requests++;return {shelves:[]};};await repository.loadRecommendations();assert.deepEqual(repository.state.recommendations,[]);
    repository.setContext(config,{...settings,showDiscoverySimilar:false});await repository.loadRecommendations(true);assert.equal(requests,1);
    repository.setContext({...config,clientApi:{features:[]}},settings);await repository.loadRecommendations(true);assert.equal(requests,1);
    repository.setContext({...config,profileAuthorized:false},settings);await repository.loadRecommendations(true);assert.equal(requests,1);
    repository.setContext(config,settings);repository.patch({shelves:[{id:'newest',books:[{_uid:'public'}]}],recommendations:[{_uid:'private'}]});
    api.getDiscoveryShelves=async()=>{throw Object.assign(new Error('Expired'),{code:'need_profile_login'});};await repository.loadRecommendations(true);
    assert.deepEqual(repository.state.recommendations,[]);assert.equal(repository.state.shelves[0].id,'newest');assert(repository.state.recommendationsLoginRequired);
}
async function testOverviewRecommendationEndpointDoesNotBuildGlobalShelves(){
    const Worker=require('../server/core/WebWorker'),worker=Object.create(Worker.prototype),user={id:'alice'};let received;
    worker.checkMyState=()=>{};worker.getDiscoveryConfigForRequest=async()=>({enabled:true});
    worker.requireAuthorizedUser=async(id,token)=>{assert.equal(id,'alice');assert.equal(token,'session');return user;};
    worker.dbConfig=async()=>assert.fail('Recommendations must not rebuild global shelves');
    worker.buildSimilarBooksShelfV2=async(profile,limit)=>{assert.equal(profile,user);received=limit;return {id:'similar-books',items:[{_uid:'one'}]};};
    const result=await worker.getDiscoveryShelvesV2({recommendationsOnly:true,userId:'alice',profileAccessToken:'session',personalLimit:1000});
    assert.equal(received,24);assert.equal(result.shelves[0].items[0]._uid,'one');
    worker.buildSimilarBooksShelfV2=async()=>({items:[]});assert.deepEqual(await worker.getDiscoveryShelvesV2({recommendationsOnly:true,userId:'alice',profileAccessToken:'session'}),{shelves:[]});
    worker.requireAuthorizedUser=async()=>{throw new Error('need_profile_login');};await assert.rejects(worker.getDiscoveryShelvesV2({recommendationsOnly:true}),/need_profile_login/);
}
module.exports=[testOverviewRecommendationsAreBoundedCachedAndSeparateFromNewest,testOverviewSlowRecommendationsDoNotDelayOtherShelvesAndRejectOldProfile,
    testOverviewRecommendationsHandleEmptyDisabledOldServerAndExpiredSession,testOverviewRecommendationEndpointDoesNotBuildGlobalShelves];
