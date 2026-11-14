const assert=require('assert/strict');
const {LibraryRepository}=require('../client/components/Library/libraryRepository');
const fs=require('fs-extra'),path=require('path'),os=require('os');
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
async function testPersonalRecommendationPreferencePersistsPerProfileAndBackup(){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-recommendation-preference-'));
    try{
        const Store=require('../server/core/ReadingListStore'),config={dataDir:dir,adminPassword:'recommendation-fixture',allowAnonymousAccess:true};
        const store=new Store(config),alice=await store.createUser({name:'Alice'}),bob=await store.createUser({name:'Bob'});
        assert.equal(alice.personalRecommendationsEnabled,true);
        await store.updateUser(alice.id,{personalRecommendationsEnabled:false});
        const reloaded=new Store(config);assert.equal((await reloaded.getUser(alice.id)).personalRecommendationsEnabled,false);
        assert.equal((await reloaded.getUser(bob.id)).personalRecommendationsEnabled,true);
        const backup=await reloaded.exportData(alice.id);assert.equal(backup.user.personalRecommendationsEnabled,false);
        await reloaded.updateUser(alice.id,{personalRecommendationsEnabled:true});
        await reloaded.importData(alice.id,backup);
        assert.equal((await new Store(config).getUser(alice.id)).personalRecommendationsEnabled,false);
    }finally{await fs.remove(dir);}
}
async function testDisabledPersonalRecommendationsSkipServerWorkAndKeepOtherShelves(){
    const Worker=require('../server/core/WebWorker'),worker=Object.create(Worker.prototype),user={id:'alice',personalRecommendationsEnabled:false};
    worker.checkMyState=()=>{};worker.getDiscoveryConfigForRequest=async()=>({enabled:true});worker.requireAuthorizedUser=async()=>user;
    worker.readingListStore={getLists:async()=>[]};worker.db={select:async()=>assert.fail('Disabled recommendations cannot query the catalogue')};
    const empty=await worker.buildSimilarBooksShelfV2(user);assert.deepEqual(empty.items,[]);
    worker.buildSimilarBooksShelfV2=async()=>assert.fail('The disabled profile must not enter recommendation generation');
    assert.deepEqual(await worker.getDiscoveryShelvesV2({recommendationsOnly:true}),{shelves:[]});
    worker.getEffectiveUser=async()=>user;worker.getPersonalReadBookSet=()=>new Set();
    for(const [method,id] of [['buildContinueReadingShelfV2','continue'],['buildFromReadingListsShelfV2','lists'],['buildUnfinishedSeriesShelfV2','series'],['buildHiddenDiscoveryShelfV2','hidden']])worker[method]=async()=>({id,items:[]});
    assert.deepEqual((await worker.getPersonalDiscoveryShelvesV2('alice')).map(s=>s.id),['continue','lists','series','hidden']);
}
async function testPersonalRecommendationToggleClearsCachedAndLateResults(){
    const {repository,api,config,settings,calls}=fixture(),slow=deferred();
    api.getDiscoveryShelves=async()=>slow.promise;
    const pending=repository.loadRecommendations();
    repository.patch({recommendations:[{_uid:'cached'}]});
    repository.setContext({...config,currentUserProfile:{personalRecommendationsEnabled:false}},settings);
    await repository.loadRecommendations(true);assert.deepEqual(repository.state.recommendations,[]);
    slow.resolve({shelves:[{id:'similar-books',items:[{_uid:'late'}]}]});await pending;
    assert.deepEqual(repository.state.recommendations,[]);assert.equal(repository.state.recommendationsLoading,false);
    api.getDiscoveryShelves=async options=>{calls.push(options);return {shelves:[{id:'similar-books',items:[{_uid:'enabled'}]}]};};
    repository.setContext({...config,currentUserProfile:{personalRecommendationsEnabled:true}},settings);
    await repository.loadRecommendations();assert.deepEqual(repository.state.recommendations.map(b=>b._uid),['enabled']);
}
async function testOverviewPublishesLocalShelvesBeforeExternalFeed() {
    const {repository, api, config, settings} = fixture();
    const external = deferred();
    const calls = [];
    api.getDiscoveryShelves = async options => {
        calls.push(options);
        if (options.externalOnly) return external.promise;
        if (options.recommendationsOnly) return {shelves: []};
        return {shelves: [{id:'newest-7d', items:[{_uid:'local'}]}]};
    };
    repository.setContext({...config, discovery:{enabled:true, externalSource:'web-page'},
        clientApi:{features:[...config.clientApi.features, 'separateExternalDiscovery']}}, settings);
    const pending = repository.loadHome();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(repository.state.shelves[0].books[0]._uid, 'local');
    assert.equal(repository.state.shelvesLoading, false);
    assert.equal(repository.state.externalShelvesLoading, true);
    assert(calls.some(options => options.includeExternal === false));
    assert(calls.some(options => options.externalOnly === true));
    repository.setContext({...config, currentUserId:'bob'}, {...settings, currentUserId:'bob'});
    external.resolve({shelves:[{id:'external-source', items:[{_uid:'late'}]}]});
    await pending;
    assert.deepEqual(repository.state.externalShelves, []);
}

async function testExternalOnlyDiscoveryReusesResolvedSourceAndSkipsLocalWork() {
    const Worker = require('../server/core/WebWorker');
    const worker = Object.create(Worker.prototype);
    worker.config = {discovery:{externalSource:'web-page', externalName:'shared', externalUrl:'https://books.example'}};
    worker.checkMyState = () => {};
    worker.getSharedDiscoveryConfig = async() => ({});
    worker.requireAdmin = async() => {throw new Error('not admin');};
    worker.dbConfig = async() => ({inpxHash:'catalog'});
    worker.selectDiscoveryBookWindows = () => assert.fail('External-only request scanned the local catalog');
    worker.getPersonalDiscoveryShelvesV2 = () => assert.fail('External-only request loaded personalized shelves');
    worker.rememberPersistedDiscovery = async(key, load) => {
        assert(key.includes('https://books.example'));
        return load();
    };
    worker.buildExternalDiscoveryShelfV2 = async(limit, discovery) => {
        assert.equal(discovery.externalUrl, 'https://books.example');
        return {id:'external-source', items:[]};
    };
    const result = await worker.getDiscoveryShelvesV2({externalOnly:true, externalUrl:'https://other.example'});
    assert.deepEqual(result.shelves.map(shelf => shelf.id), ['external-source']);
}

async function testExternalDiscoveryUsesConfiguredOriginAndBoundsResponses() {
    const Worker = require('../server/core/WebWorker');
    const worker = Object.create(Worker.prototype);
    worker.config = {discovery:{externalUrl:'https://books.example.test'}};
    const getConfig = externalBrowseUrl => worker.getDiscoveryConfig({externalBrowseUrl});
    assert.equal(getConfig('/genre').externalBrowseUrl, 'https://books.example.test/genre');
    assert.equal(getConfig('https://books.example.test:8443/genre').externalBrowseUrl, '');
    assert.equal(getConfig('http://books.example.test/genre').externalBrowseUrl, '');
    assert.equal(getConfig('https://name:password@books.example.test/genre').externalBrowseUrl, '');

    const axios = require('axios'), original = axios.get;
    axios.get = async (url, options) => {
        assert.equal(url, 'https://books.example.test/');
        assert(options.maxContentLength > 0 && options.maxContentLength <= 10 * 1024 * 1024);
        assert(options.maxRedirects > 0 && options.maxRedirects <= 4);
        assert.doesNotThrow(() => options.beforeRedirect({href:'https://books.example.test/catalog'}));
        assert.throws(() => options.beforeRedirect({href:'https://other.example.test/catalog'}), /Переадресация/);
        return {data:'<html></html>'};
    };
    worker.parseExternalFeedItemsFromNextData = () => [{title:'Fixture', url:'https://books.example.test/book'}];
    try {
        await assert.rejects(worker.fetchExternalFeedItems(1, 'ftp://books.example.test/'), /Недопустимый URL/);
        assert.equal((await worker.fetchExternalFeedItems(1, 'https://books.example.test/')).items.length, 1);
    } finally {axios.get = original;}
}

module.exports=[testPersonalRecommendationPreferencePersistsPerProfileAndBackup,testDisabledPersonalRecommendationsSkipServerWorkAndKeepOtherShelves,testPersonalRecommendationToggleClearsCachedAndLateResults,
    testOverviewRecommendationsAreBoundedCachedAndSeparateFromNewest,testOverviewSlowRecommendationsDoNotDelayOtherShelvesAndRejectOldProfile,
    testOverviewRecommendationsHandleEmptyDisabledOldServerAndExpiredSession,testOverviewRecommendationEndpointDoesNotBuildGlobalShelves,
    testOverviewPublishesLocalShelvesBeforeExternalFeed,testExternalOnlyDiscoveryReusesResolvedSourceAndSkipsLocalWork,
    testExternalDiscoveryUsesConfiguredOriginAndBoundsResponses];
