const assert=require('assert/strict');
const {summarizeReport}=require('../shared/ResourceBenchmarkSummary');
const criteria={probeP95Ms:100,timerLagP95Ms:100,memoryRatio:0.85,minProbeSamples:5,probeTimeoutMs:250};
const row=extra=>({profile:'custom',completed:true,probeSamples:8,probeSuccessfulSamples:8,probeTimeouts:0,probeFailures:0,
    probeP95Ms:6,timerLagP95Ms:2,memoryRatio:0.1,otherWork:false,...extra});
const report=extra=>({schema:2,mode:'custom',criteria,machine:{memoryScope:'cgroup'},confidence:'measured',rows:[row()],...extra});

async function testBenchmarkCustomScreenshotExplainsResponseThresholdWithoutSelectingBest() {
    const value=summarizeReport(report({rows:[row({limits:{total:8},firstPassMs:1096,repeatPassMs:1079,elapsedMs:1079,
        totalDurationMs:2186,cpuTimeMs:3061,cpuPercent:140,peakMemory:1825*1024**2,memoryDelta:21*1024**2,
        probeP95Ms:168,tasksPerStage:8,tasksPerPass:32})]}));
    assert.equal(value.status,'attention');assert.equal(value.rows[0].status,'attention');
    assert.match(value.title,/Свои значения: отклик выше порога/);
    assert(value.rows[0].notes.some(note=>/168 мс.*меньше 100 мс/.test(note)));
    assert(value.notes.some(note=>/Сравнение профилей не выполнялось/.test(note)));
    assert(value.notes.some(note=>/32 тестовых операций, по 8/.test(note)));
    assert(!/устойчив|ухудш|улучш|лучши|сбалансирован/i.test(JSON.stringify(value)));
    assert.equal(value.recommendation,undefined,'One custom result must not choose a different profile');
}

async function testBenchmarkSummaryChecksStrictLimitsTimeoutsAndSuccessfulSamples() {
    for(const extra of [{probeP95Ms:100},{timerLagP95Ms:100},{memoryRatio:0.85},{probeTimeouts:1},{probeFailures:1}])
        assert.equal(summarizeReport(report({rows:[row(extra)]})).rows[0].status,'attention');
    const clean=summarizeReport(report({mode:'profile',rows:[row({profile:'balanced',probeP95Ms:99.9,timerLagP95Ms:99.9,memoryRatio:.849})]}));
    assert.equal(clean.status,'pass');assert.match(clean.title,/Выбранный профиль/);
    assert(clean.notes.some(note=>/один выбранный профиль/.test(note)));
    assert.equal(summarizeReport(report({rows:[row({probeSamples:50,probeSuccessfulSamples:4})]})).status,'insufficient');
    const derived=row({probeSamples:6,probeSuccessfulSamples:undefined,probeTimeouts:2});
    assert.equal(summarizeReport(report({rows:[derived]})).rows[0].checks.probes.successful,4);
    assert.equal(summarizeReport(report({rows:[row({probeP95Ms:null})]})).status,'insufficient','Missing measurements are not zero');
    for(const memoryRatio of [null,undefined,NaN,Infinity,-1]){
        const unavailable=summarizeReport(report({rows:[row({memoryBefore:null,peakMemory:null,memoryDelta:null,memoryRatio})]}));
        assert.equal(unavailable.status,'insufficient','Unavailable memory cannot certify a test as passing');
        assert.equal(unavailable.rows[0].checks.memory.status,'unknown');
    }
    assert.equal(summarizeReport(report({rows:[row({probeP95Ms:-1})]})).status,'insufficient');
}

async function testBenchmarkLegacyStaleAndPartialReportsRemainVisibleWithoutCertification() {
    const legacy=summarizeReport(report({schema:1,legacy:true,criteria:undefined,rows:[row({probeTimeouts:undefined,probeFailures:undefined})]}));
    assert.equal(legacy.status,'insufficient');assert.equal(legacy.rows.length,1);
    assert(legacy.notes.some(note=>/прежнего формата/.test(note)));assert.equal(legacy.rows[0].checks.probe,undefined);
    const stale=summarizeReport(report({stale:true}));assert.equal(stale.status,'insufficient');assert.match(stale.title,/прежним условиям/);
    assert.equal(summarizeReport(report({confidence:'partial'})).status,'insufficient');
    assert.equal(summarizeReport(report({rows:[row({otherWork:true})]})).status,'insufficient');
    assert.equal(summarizeReport(null).status,'insufficient');
}

async function testBenchmarkComparisonKeepsPerProfileFailuresAndSavedCriteria() {
    const value=summarizeReport(report({mode:'compare',criteria:{...criteria,probeP95Ms:200},rows:[
        row({profile:'economy',probeP95Ms:168}),row({profile:'balanced',completed:false}),row({profile:'performance',memoryRatio:.9})]}));
    assert.deepEqual(value.rows.map(row=>row.status),['pass','failed','attention']);assert.equal(value.status,'attention');
    assert.equal(value.rows[0].checks.probe.maximum,200,'Use the report criteria rather than current hardcoded thresholds');
    assert(value.notes.some(note=>/медиану повторных проходов/.test(note)));
    assert.equal(summarizeReport(report({mode:'compare',rows:[row()]})).status,'insufficient');
    assert.equal(summarizeReport(report({rows:[row({completed:false})]})).status,'failed');
}

async function testBenchmarkSummaryDoesNotMixMemoryScopesOrMutateReport() {
    const input=report({machine:{memoryScope:'cgroup',memoryUsed:2358*1024**2},processMemory:{rss:1164*1024**2},
        rows:[row({peakMemory:1825*1024**2,memoryDelta:21*1024**2,rss:1164*1024**2,cpuScope:'cgroup'})]});
    const before=JSON.stringify(input),first=summarizeReport(input);
    assert.equal(first.status,'pass','Cgroup and Node RSS are distinct scopes, not conflicting measurements');
    assert.equal(JSON.stringify(input),before);first.rows[0].notes.push('modified');first.rows[0].checks.probe.maximum=1;
    const second=summarizeReport(input);assert.equal(second.rows[0].checks.probe.maximum,100);assert(!second.rows[0].notes.includes('modified'));
    assert(summarizeReport(report({machine:{memoryScope:'process'}})).notes.some(note=>/не охватывают отдельные процессы/.test(note)));
}

module.exports=[testBenchmarkCustomScreenshotExplainsResponseThresholdWithoutSelectingBest,
    testBenchmarkSummaryChecksStrictLimitsTimeoutsAndSuccessfulSamples,testBenchmarkLegacyStaleAndPartialReportsRemainVisibleWithoutCertification,
    testBenchmarkComparisonKeepsPerProfileFailuresAndSavedCriteria,testBenchmarkSummaryDoesNotMixMemoryScopesOrMutateReport];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
