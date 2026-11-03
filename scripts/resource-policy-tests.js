const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {AsyncLocalStorage} = require('async_hooks');
const policy = require('../server/core/ResourcePolicy');
const globalRuntime = require('../server/core/ResourceRuntime');
const {ResourceRuntime} = globalRuntime;
const {runProcess} = require('../server/core/ConversionRuntime');
const {ResourceBenchmark, recommend} = require('../server/core/ResourceBenchmark');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const GiB = 1024 * 1024 * 1024;
const machine = () => ({cpu:4, memoryLimit:8 * GiB, memoryUsed:GiB, memoryAvailable:7 * GiB,
    memoryScope:'container', platform:'test', architecture:'test'});

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-resource-policy-'));
    try {await task(dir);} finally {await fs.remove(dir);}
}

async function testLaunchResourceProfilesAndOverrides() {
    const small = policy.resolve({}, {...machine(), cpu:0.5, memoryLimit:512 * 1024 * 1024});
    assert.strictEqual(small.selected, 'economy');
    assert.strictEqual(small.hardMax, 1);
    const settings = policy.resolve({INPX_RESOURCE_PROFILE:'performance', INPX_RESOURCE_MAX_PROCESSES:'3',
        INPX_RESOURCE_IMAGES:'1', INPX_RESOURCE_REVIEWS:'8', INPX_RESOURCE_BENCH_ENABLED:'false',
        SECRET_OTHER_VARIABLE:'do not export'}, machine());
    assert.deepStrictEqual(settings.limits, {total:3, images:1, reviews:3, conversions:3, background:2});
    assert.strictEqual(settings.benchmarkEnabled, false);
    assert(!JSON.stringify(settings).includes('do not export'));
    assert.strictEqual(settings.launchEnv.INPX_RESOURCE_REVIEWS, '8');
    assert.throws(() => policy.resolve({INPX_RESOURCE_PROFILE:'invalid'}, machine()), /INPX_RESOURCE_PROFILE/);
    assert.throws(() => policy.resolve({INPX_RESOURCE_MAX_PROCESSES:'1.5'}, machine()), /integer/);
    assert.throws(() => policy.resolve({INPX_RESOURCE_TASK_TIMEOUT_MS:'-1'}, machine()), /integer/);
}

async function testCgroupV2InheritedCpuAndMemoryLimits() {
    const files = {
        '/proc/self/cgroup':'0::/service/worker',
        '/proc/self/mountinfo':'1 0 0:1 / /cg rw - cgroup2 cgroup rw',
        '/cg/service/worker/memory.current':String(64 * 1024 * 1024),
        '/cg/service/worker/memory.max':String(GiB),
        '/cg/service/memory.current':String(128 * 1024 * 1024),
        '/cg/service/memory.max':String(512 * 1024 * 1024),
        '/cg/memory.current':String(200 * 1024 * 1024),
        '/cg/memory.max':String(256 * 1024 * 1024),
        '/cg/service/worker/cpu.max':'300000 100000',
        '/cg/service/cpu.max':'100000 100000',
        '/cg/cpu.max':'50000 100000',
        '/cg/service/worker/cpu.stat':'usage_usec 1000\nthrottled_usec 20',
    };
    const actual = policy.hardware({platform:'linux', read:file => files[file] || '', exists:() => false});
    assert.strictEqual(actual.cpu, 0.5);
    assert.strictEqual(actual.memoryLimit, 256 * 1024 * 1024);
    assert(actual.memoryAvailable <= 56 * 1024 * 1024);
    assert.strictEqual(actual.cpuUsageUs, 1000);
    assert.strictEqual(actual.memoryScope, 'cgroup');
    assert.strictEqual(actual.cgroupVersion, 'v2');
}

async function testCgroupV1QuotasAndEscapedMountPaths() {
    const files = {
        '/proc/self/cgroup':'5:cpu,cpuacct:/docker/test\n4:memory:/docker/test',
        '/proc/self/mountinfo':'1 0 0:1 /docker/test /cg\\040cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 /docker/test /cg/memory rw - cgroup cgroup rw,memory',
        '/cg cpu/cpu.cfs_period_us':'100000', '/cg cpu/cpu.cfs_quota_us':'50000',
        '/cg cpu/cpuacct.usage':'1000000', '/cg cpu/cpu.stat':'throttled_time 20000',
        '/cg/memory/memory.usage_in_bytes':String(64 * 1024 * 1024),
        '/cg/memory/memory.limit_in_bytes':String(512 * 1024 * 1024),
    };
    const actual = policy.hardware({platform:'linux', read:file => files[file] || '', exists:() => true});
    assert.strictEqual(actual.cpu, 0.5);
    assert.strictEqual(actual.memoryLimit, 512 * 1024 * 1024);
    assert.strictEqual(actual.cpuUsageUs, 1000);
    assert.strictEqual(actual.throttledUs, 20);
    assert.strictEqual(actual.cgroupVersion, 'v1');
}

async function testGlobalResourceAdmissionAndForegroundPriority() {
    const settings = policy.resolve({INPX_RESOURCE_MAX_PROCESSES:'2', INPX_RESOURCE_BACKGROUND:'1'}, machine());
    const runtime = new ResourceRuntime(settings), order = [];
    let releaseFirst, releaseBackground;
    const first = runtime.run(() => new Promise(resolve => {releaseFirst = resolve;}), {kind:'images'});
    const background = runtime.withBackground(() => runtime.run(() => new Promise(resolve => {releaseBackground = resolve;}), {kind:'reviews'}));
    const queuedBackground = runtime.withBackground(() => runtime.run(() => {order.push('background');}, {kind:'reviews'}));
    const foreground = runtime.run(() => {order.push('foreground');}, {kind:'conversions'});
    assert.strictEqual(runtime.active, 2);
    releaseBackground(); await background; await foreground;
    assert.strictEqual(order[0], 'foreground', 'A reader must overtake queued warmup');
    releaseFirst(); await Promise.all([first, queuedBackground]);
    assert.deepStrictEqual(order, ['foreground','background']);
    assert.strictEqual(runtime.active, 0); assert.strictEqual(runtime.queue.length, 0);
    let active = 0, peak = 0;
    await Promise.all(Array.from({length:12}, (_, i) => runtime.run(async() => {
        peak = Math.max(peak, ++active); await pause(3); active--;
    }, {kind:['images','reviews','conversions'][i % 3]})));
    assert.strictEqual(peak, 2, 'Different native workloads must share the total budget');
}

async function testResourceQueueCancellationAndCallerContext() {
    const runtime = new ResourceRuntime(policy.resolve({INPX_RESOURCE_MAX_PROCESSES:'1'}, machine()));
    const context = new AsyncLocalStorage();
    let release;
    const first = runtime.run(() => new Promise(resolve => {release = resolve;}));
    const controller = new AbortController();
    const cancelled = runtime.run(() => assert.fail('Cancelled work must not start'), {signal:controller.signal});
    controller.abort(); await assert.rejects(cancelled, {code:'ABORT_ERR'});
    const second = context.run('caller', () => runtime.run(() => context.getStore()));
    release(); await first; assert.strictEqual(await second, 'caller');
    assert.strictEqual(runtime.active, 0); assert.strictEqual(runtime.queue.length, 0);
    await assert.rejects(runtime.run(() => {throw new Error('fixture failure');}), /fixture failure/);
    assert.strictEqual(await runtime.run(() => 42), 42);
}

async function testNativeOutputCaptureLimitsAndAbortTree() {
    await temporary(async dir => {
        const output = path.join(dir, 'output');
        assert.strictEqual((await runProcess(process.execPath, ['-e', "process.stdout.write('fixture')"], {captureStdout:true})).toString(), 'fixture');
        await runProcess(process.execPath, ['-e', "process.stdout.write('file fixture')"], {outputFile:output});
        assert.strictEqual(await fs.readFile(output, 'utf8'), 'file fixture');
        await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(1000000))"],
            {captureStdout:true, maxOutputBytes:1000}), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
        const ready = path.join(dir, 'ready'), marker = path.join(dir, 'descendant-alive');
        const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),1200);`;
        const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setTimeout(()=>{},5000);`;
        const controller = new AbortController();
        const child = runProcess(process.execPath, ['-e', script], {signal:controller.signal, resourceKind:'reviews'});
        const rejection = assert.rejects(child, {code:'ABORT_ERR'});
        for (let i = 0; i < 80 && !await fs.pathExists(ready); i++) await pause(25);
        assert(await fs.pathExists(ready)); controller.abort(); await rejection;
        await pause(1400); assert.strictEqual(await fs.pathExists(marker), false, 'Cancelling must terminate descendants');
        assert.strictEqual(globalRuntime.active, 0);
    });
}

async function testRecommendationPrefersSmallestSafeNearBestProfile() {
    const row = (profile, elapsedMs, extra = {}) => ({profile, elapsedMs, completed:true, probeSamples:10,
        probeP95Ms:5, timerLagP95Ms:2, memoryRatio:0.4, ...extra});
    assert.strictEqual(recommend([row('economy', 200), row('balanced', 105), row('performance', 100)], 'economy').profile, 'balanced');
    assert.strictEqual(recommend([row('economy', 200), row('balanced', 150), row('performance', 100, {memoryRatio:0.95})], 'economy').profile, 'balanced');
    assert.strictEqual(recommend([row('performance', 10, {probeP95Ms:500})], 'economy').measured, false);
}

async function testBenchmarkPersistsResultsAndDetectsChangedEnvironment() {
    await temporary(async dir => {
        const config = {dataDir:dir, tempDir:path.join(dir, 'tmp'), version:'test',
            libDir:dir, librarySources:[{id:'source', name:'Fixture source', libDir:dir}]};
        const settings = policy.resolve({INPX_RESOURCE_MAX_PROCESSES:'4'}, machine());
        const runtime = new ResourceRuntime(settings);
        let hardware = machine();
        const options = {runtime, hardware:() => hardware, probe:async() => {}, prepare:async directory => {
            await fs.writeFile(path.join(directory, 'fixture'), 'temporary only');
            return {coverage:['Изображения','Архивы','Хранилище'], warnings:[], stages:[
                {name:'fixture', task:id => runtime.run(() => {
                    if (id.startsWith('performance')) throw new Error('Fixture: high concurrency fails');
                    return pause(10);
                }, {kind:'images'})},
            ]};
        }};
        const service = new ResourceBenchmark(config, options);
        await fs.writeFile(path.join(dir, 'user-data'), 'must stay unchanged');
        const before = JSON.stringify(settings);
        await service.start({sourceId:'source', profile:'performance', limits:{total:1000}});
        await assert.rejects(service.start({sourceId:'source'}), /уже выполняется/);
        await service.completion;
        assert.strictEqual(service.job.state, 'completed');
        assert.strictEqual(service.last.rows.find(row => row.profile === 'performance').completed, false);
        assert.notStrictEqual(service.last.recommendation.profile, 'performance');
        assert.strictEqual(JSON.stringify(settings), before, 'A benchmark must not apply its recommended limits');
        assert.strictEqual(await fs.readFile(path.join(dir, 'user-data'), 'utf8'), 'must stay unchanged');
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
        const restored = new ResourceBenchmark(config, options);
        assert.strictEqual((await restored.snapshot()).report.stale, false);
        hardware = {...machine(), cpu:2};
        assert.strictEqual((await restored.snapshot()).report.stale, true);
        await assert.rejects(restored.start({sourceId:'../../arbitrary-path'}), /источник/);
        runtime.settings.benchmarkEnabled = false;
        await assert.rejects(restored.start(), /отключена/);
    });
}

async function testBenchmarkCancellationDrainsProcessesBeforeCleanup() {
    await temporary(async dir => {
        const config = {dataDir:dir, tempDir:path.join(dir, 'tmp'), libDir:dir, version:'test',
            librarySources:[{id:'source', libDir:dir}]};
        let entered;
        const started = new Promise(resolve => {entered = resolve;});
        const service = new ResourceBenchmark(config, {hardware:machine, prepare:async() => ({
            coverage:['fixture'], warnings:[], stages:[{name:'fixture', task:async() => {
                entered(); await runProcess(process.execPath, ['-e','setTimeout(()=>{},5000)']);
            }}],
        })});
        await service.start(); await started; service.cancel(); await service.completion;
        assert.strictEqual(service.job.state, 'cancelled');
        assert.strictEqual(globalRuntime.active, 0); assert.strictEqual(globalRuntime.queue.length, 0);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
        assert.strictEqual(await fs.pathExists(service.resultFile), false, 'Do not replace results after cancellation');
    });
}

async function testPerformanceEndpointsRequireAdministratorAndCsrf() {
    const Worker = require('../server/core/WebWorker'), Controller = require('../server/controllers/WebSocketController');
    const worker = Object.create(Worker.prototype);
    worker.requireAdmin = async() => {throw new Error('denied');};
    worker.getResourceBenchmark = () => assert.fail('Unauthenticated access reached the benchmark');
    for (const method of ['getAdminPerformance','startAdminBenchmark','cancelAdminBenchmark'])
        await assert.rejects(worker[method]('forged-admin-id', 'invalid-token'), /denied/);
    for (const action of ['start-admin-benchmark','cancel-admin-benchmark'])
        assert.strictEqual(Controller.prototype.isCsrfProtectedAction(action), true);
}

async function testRealBenchmarkFixturesReadSelectedStorage() {
    await temporary(async dir => {
        const source = {id:'source', libDir:path.join(dir, 'library')};
        await fs.ensureDir(source.libDir);
        const file = path.join(source.libDir, 'book.fb2'), content = '<FictionBook>Fixture</FictionBook>';
        await fs.writeFile(file, content);
        const fixtures = path.join(dir, 'fixtures'); await fs.ensureDir(fixtures);
        const service = new ResourceBenchmark({dataDir:dir, conversionEnabled:false,
            converterPaths:{djxl:path.join(dir, 'missing-djxl')} });
        const result = await globalRuntime.withBenchmark(globalRuntime.settings.profiles[0].limits, null,
            () => service.prepareFixtures(fixtures, source));
        assert(result.coverage.includes('Архивы'));
        const storage = result.stages.find(stage => stage.name === 'Хранилище');
        assert(storage, 'Read-only storage measurements must be part of the real pipeline');
        await globalRuntime.withBenchmark(globalRuntime.settings.profiles[0].limits, null, () => storage.task());
        assert.strictEqual(await fs.readFile(file, 'utf8'), content);
        assert.strictEqual(globalRuntime.active, 0);
    });
}

async function testReviewBackgroundCannotOccupyAllForegroundSlots() {
    const pool = new (require('../server/core/ReviewRuntime').ReviewRuntime)(2);
    let release;
    const first = globalRuntime.withBackground(() => pool.run(() => new Promise(resolve => {release = resolve;})));
    let secondStarted = false;
    const second = globalRuntime.withBackground(() => pool.run(() => {secondStarted = true;}));
    assert.strictEqual(secondStarted, false, 'Queued warmup must leave a slot for a book request');
    assert.strictEqual(await pool.run(() => 'book request'), 'book request');
    release(); await Promise.all([first, second]);
    assert.strictEqual(pool.active, 0);
}

async function testSavedConfigurationCannotOverrideLaunchResourcePolicy() {
    const Manager = require('../server/config');
    const manager = Object.create(Manager.prototype);
    manager.inited = true;
    manager._config = {conversionConcurrency:999, conversionTimeoutMs:1, conversionQueueTimeoutMs:1};
    const actual = manager.config;
    assert.strictEqual(actual.conversionConcurrency, globalRuntime.settings.limits.conversions);
    assert.strictEqual(actual.conversionTimeoutMs, globalRuntime.settings.taskTimeoutMs);
    assert.strictEqual(actual.conversionQueueTimeoutMs, globalRuntime.settings.taskTimeoutMs);
}

async function testBenchmarkTimeoutKeepsPreviousResultAndCleansFiles() {
    await temporary(async dir => {
        const settings = policy.resolve({}, machine()); settings.benchmarkTimeoutMs = 80;
        const service = new ResourceBenchmark({dataDir:dir, tempDir:path.join(dir, 'tmp'), libDir:dir,
            librarySources:[{id:'source', libDir:dir}]}, {runtime:new ResourceRuntime(settings), hardware:machine,
            prepare:async directory => {
                await fs.writeFile(path.join(directory, 'fixture'), 'temporary');
                return {coverage:[], warnings:[], stages:[{name:'slow fixture', task:() => pause(150)}]};
            }});
        await fs.writeFile(service.resultFile, 'previous result');
        await service.start(); await service.completion;
        assert.strictEqual(service.job.state, 'timed-out');
        assert.strictEqual(await fs.readFile(service.resultFile, 'utf8'), 'previous result');
        assert.deepStrictEqual(await fs.readdir(service.config.tempDir), []);
    });
}

async function testResourceErrorsCannotBecomeCachedEmptyReviews() {
    const Worker = require('../server/core/WebWorker'), Zip = require('../server/core/ZipReader');
    const original = Zip.prototype.open;
    const error = Object.assign(new Error('resource queue fixture'), {code:'INPX_RESOURCE_QUEUE_TIMEOUT'});
    const worker = Object.create(Worker.prototype); worker.config = {};
    Zip.prototype.open = async() => {throw error;};
    try {
        const state = {archives:[{id:'202610', file:'/fixture'}]};
        await assert.rejects(worker.ensureReviewIndex('', state), {code:error.code});
        assert.strictEqual(state.indexPromise, null, 'A failed index must be retried');
        state.archives = [{id:'additional', file:'/fixture'}];
        await assert.rejects(worker.ensureLibraryRatings(state), {code:error.code});
        assert.strictEqual(state.ratingsPromise, null, 'Failed ratings must be retried');
        worker.ensureReviewIndex = async() => new Map([['collection.zip#123.fb2', [{archive:'/fixture', entryName:'review'}]]]);
        await assert.rejects(worker.getBookReviews({folder:'collection.zip', file:'123', ext:'fb2'}), {code:error.code});
    } finally {Zip.prototype.open = original;}
}

module.exports = [testLaunchResourceProfilesAndOverrides, testCgroupV2InheritedCpuAndMemoryLimits, testCgroupV1QuotasAndEscapedMountPaths,
    testGlobalResourceAdmissionAndForegroundPriority,
    testResourceQueueCancellationAndCallerContext, testNativeOutputCaptureLimitsAndAbortTree,
    testRecommendationPrefersSmallestSafeNearBestProfile, testBenchmarkPersistsResultsAndDetectsChangedEnvironment,
    testBenchmarkCancellationDrainsProcessesBeforeCleanup, testPerformanceEndpointsRequireAdministratorAndCsrf,
    testRealBenchmarkFixturesReadSelectedStorage, testReviewBackgroundCannotOccupyAllForegroundSlots,
    testSavedConfigurationCannotOverrideLaunchResourcePolicy, testBenchmarkTimeoutKeepsPreviousResultAndCleansFiles,
    testResourceErrorsCannotBecomeCachedEmptyReviews];
