const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const model=require('../client/components/Search/SettingsDialog/performancePreferences');
const {summarizeReport}=require('../shared/ResourceBenchmarkSummary');

function storage() {const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),values};}
function config(id='admin') {return {profileAuthorized:true,currentUserId:id,currentUserProfile:{id,isAdmin:true},rootPathStatic:'/library'};}
function snapshot(extra={}) {
    const limits={total:4,images:2,reviews:4,conversions:2,background:1};
    return {settings:{selected:'balanced',hardMax:8,limits,launchEnv:{},benchmarkEnabled:true,benchmarkTimeoutMs:60000,
        profiles:[{id:'economy',name:'Бережный',limits:{...limits,total:2}},{id:'balanced',name:'Сбалансированный',limits},
            {id:'performance',name:'Производительный',limits:{...limits,total:6}}]},sources:[{id:'one',name:'One'},{id:'two',name:'Two'}],
        recommendation:{profile:'economy',measured:false,reason:'Fixture'},machine:{memoryScope:'process',cpuUsageUs:null},processCpu:{user:1,system:1},runtime:{},...extra};
}
function component({memory=storage(),id='admin',read=async()=>snapshot(),start=async()=>{},cancel=async()=>{}}={}) {
    const timers=new Map();let sequence=0;
    const file=path.resolve(__dirname,'../client/components/Search/SettingsDialog/PerformancePanel.vue');
    const script=require('@vue/compiler-sfc').parse(fs.readFileSync(file,'utf8')).descriptor.script.content
        .replace(/^import .*;\r?\n/gm,'').replace('export default','return');
    const options=new Function('preferencesModel','summarizeReport','copyToClipboard','setTimeout','clearTimeout',script)(model,summarizeReport,()=>{},
        callback=>{timers.set(++sequence,callback);return sequence;},timer=>timers.delete(timer));
    const view={...options.data(),...options.methods,$store:{state:{config:config(id),settings:{currentUserId:id}}},
        $root:{api:{getAdminPerformance:read,startAdminBenchmark:start,cancelAdminBenchmark:cancel}}};
    view.preferences=new model.PerformancePreferences(()=>memory);
    for(const [key,get] of Object.entries(options.computed))Object.defineProperty(view,key,{get:()=>get.call(view)});
    return {view,options,timers,memory};
}

async function testPerformancePreferencesAreBoundedWhitelistedAndProfileScoped() {
    const memory=storage(),preferences=new model.PerformancePreferences(()=>memory);
    const a=model.preferenceScope(config('a'),{currentUserId:'a'}),b=model.preferenceScope(config('b'),{currentUserId:'b'});
    const draft={selected:'custom',sourceId:'two',customLimits:{total:6,images:2,reviews:3,conversions:2},
        config:{telegramProxyPassword:'must-not-persist'},profileAccessToken:'must-not-persist'};
    assert(preferences.write(a,draft));assert.equal(preferences.read(b),null);
    assert.equal(preferences.read(a).selected,'custom');assert(!memory.getItem(model.KEY).includes('must-not-persist'));
    assert.equal(model.preferenceScope({...config('a'),profileAuthorized:false},{currentUserId:'a'}),'');
    assert.equal(model.preferenceScope(config('a'),{currentUserId:'b'}),'');
    assert.notEqual(model.preferenceScope({...config('a'),rootPathStatic:'/other'},{}),a);
    const original=preferences.read(a);original.customLimits.total=100;assert.equal(preferences.read(a).customLimits.total,6);
    const dirty=JSON.parse(memory.getItem(model.KEY));dirty.entries[0].draft.secret='must-not-persist';dirty.entries[0].config={secret:'must-not-persist'};
    memory.setItem(model.KEY,JSON.stringify(dirty));preferences.write(b,{...draft,selected:'economy'});
    assert(!memory.getItem(model.KEY).includes('must-not-persist'),'Existing stored entries must be sanitized too');
    for(let i=0;i<30;i++)preferences.write('profile-'+i,draft);
    assert.equal(JSON.parse(memory.getItem(model.KEY)).entries.length,20);assert(memory.getItem(model.KEY).length<32768);
    const denied=new model.PerformancePreferences(()=>({getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('quota');}}));
    assert.equal(denied.read(a),null);assert.equal(denied.write(a,draft),false);assert.equal(denied.available,false);
}

async function testPerformanceDraftReopensAndInvalidLimitsRemainVisible() {
    const memory=storage(),first=component({memory});first.view.restorePreferences();await first.view.refresh();
    assert.equal(first.view.selected,'balanced','Initial test choice follows active server profile, not a recommendation');
    Object.assign(first.view,{selected:'custom',sourceId:'two',customLimits:{total:6,images:1.5,reviews:-1,conversions:''}});
    first.view.savePreferences();assert.match(first.view.preferenceStatus,/Сохранено/);
    const restored=component({memory,read:async()=>{const value=snapshot();value.settings.hardMax=4;return value;}});
    restored.view.restorePreferences();await restored.view.refresh();
    assert.equal(restored.view.selected,'custom');assert.equal(restored.view.sourceId,'two');
    assert.deepEqual(restored.view.customLimits,{total:6,images:1.5,reviews:-1,conversions:''});assert(restored.view.customError);
    assert.equal(restored.view.info.settings.selected,'balanced','Local draft never applies the server profile');
    const missing=component({memory,read:async()=>snapshot({sources:[{id:'one',name:'One'}]})});
    missing.view.restorePreferences();await missing.view.refresh();assert.equal(missing.view.sourceId,'one');assert.match(missing.view.sourceNotice,/недоступно/);
}

async function testPerformancePresetCustomCompareSendExplicitPlansAndErrorsResumePolling() {
    const requests=[],page=component({start:async options=>{requests.push(options);}}),view=page.view;
    view.restorePreferences();await view.refresh();view.selected='economy';await view.start();
    assert.deepEqual(requests[0],{sourceId:'one',mode:'profile',profileId:'economy'});
    view.selected='compare';await view.start();assert.deepEqual(requests[1],{sourceId:'one',mode:'compare'});assert.deepEqual(view.environment,{});
    view.selected='custom';view.customLimits={total:3,images:2,reviews:3,conversions:1};await view.start();
    assert.deepEqual(requests[2],{sourceId:'one',mode:'custom',limits:{total:3,images:2,reviews:3,conversions:1}});
    assert.equal(view.info.settings.selected,'balanced');assert.equal(view.environment.INPX_RESOURCE_TOTAL,'3');
    view.$root.api.startAdminBenchmark=async()=>{throw new Error('temporary start failure');};await view.start();
    assert.match(view.error,/temporary start failure/);assert.equal(view.busy,false);assert.equal(page.timers.size,1);
    view.$root.api.cancelAdminBenchmark=async()=>{throw new Error('temporary cancel failure');};await view.cancel();
    assert.match(view.error,/temporary cancel failure/);assert.equal(page.timers.size,1);
}

async function testPerformanceProfileChangesIgnoreLateMetricsAndActions() {
    let release;
    const page=component({read:()=>new Promise(resolve=>{release=resolve;})}),view=page.view;
    view.restorePreferences();view.selected='economy';view.sourceId='one';view.customLimits={total:2,images:1,reviews:2,conversions:1};
    const old=view.refresh();
    const bScope=model.preferenceScope(config('b'),{currentUserId:'b'});
    view.preferences.write(bScope,{selected:'performance',sourceId:'two',customLimits:{total:5,images:2,reviews:5,conversions:2}});
    view.$store.state={config:config('b'),settings:{currentUserId:'b'}};view.restorePreferences();
    view.$root.api.getAdminPerformance=async()=>snapshot({marker:'new-profile'});await view.refresh();
    release(snapshot({marker:'old-profile'}));await old;
    assert.equal(view.info.marker,'new-profile');assert.equal(view.selected,'performance');assert.equal(view.sourceId,'two');
    const aScope=model.preferenceScope(config(),{currentUserId:'admin'});assert.equal(view.preferences.read(aScope).selected,'economy');
    let finishAction;view.$root.api.startAdminBenchmark=()=>new Promise(resolve=>{finishAction=resolve;});
    const action=view.start();page.options.beforeUnmount.call(view);finishAction();await action;
    assert.equal(page.timers.size,0,'A late action must not revive polling after closing the panel');
}

module.exports=[testPerformancePreferencesAreBoundedWhitelistedAndProfileScoped,testPerformanceDraftReopensAndInvalidLimitsRemainVisible,
    testPerformancePresetCustomCompareSendExplicitPlansAndErrorsResumePolling,testPerformanceProfileChangesIgnoreLateMetricsAndActions];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
