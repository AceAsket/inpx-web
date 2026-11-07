const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {ConversionRuntime,runProcess}=require('../server/core/ConversionRuntime');
const resources=require('../server/core/ResourceRuntime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function idle(runtime) {
    assert.equal(runtime.active,0); assert.equal(runtime.queue.length,0);
    assert.equal(resources.active,0); assert.equal(resources.queue.length,0);
}
async function fixture(work) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-preview-process-'));
    const runtime=new ConversionRuntime({conversionConcurrency:1,conversionTimeoutMs:5000});
    try {await work({directory,runtime,run:(source,options={})=>runtime.run(()=>runProcess(process.execPath,['-e',source],options))});}
    finally {await fs.remove(directory);}
}
async function started(file) {
    for(let i=0;i<100 && !await fs.pathExists(file);i++)await pause(20);
    assert(await fs.pathExists(file),'The real child must start before cancellation');
}

async function testBookPreviewProcessReturnsExactBinaryPrefixAndShortEof() {
    await fixture(async({runtime,run})=>{
        const prefix=await run("process.stdout.write(Buffer.from([0,195]));setTimeout(()=>process.stdout.write(Buffer.from([169,255,17,18])),20);setInterval(()=>{},1000)",
            {captureStdout:true,capturePrefixBytes:4,timeoutMs:3000});
        assert.deepEqual(prefix,Buffer.from([0,195,169,255])); idle(runtime);
        const short=await run("process.stdout.write(Buffer.from([0,1,2]))",{captureStdout:true,capturePrefixBytes:8,timeoutMs:3000});
        assert.deepEqual(short,Buffer.from([0,1,2])); idle(runtime);
    });
}

async function testBookPreviewProcessPrefixKillsDescendantsBeforeTheyWrite() {
    await fixture(async({directory,runtime,run})=>{
        const ready=path.join(directory,'descendant-ready'),marker=path.join(directory,'descendant-survived'),pids=path.join(directory,'pids.json');
        const descendant=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'survived'),1100);setInterval(()=>{},1000);`;
        const parent=`const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.stdout.write(Buffer.alloc(65536,65));}},10);setInterval(()=>{},1000);`;
        try {
            const prefix=await run(parent,{captureStdout:true,capturePrefixBytes:32,timeoutMs:4000});
            assert.deepEqual(prefix,Buffer.alloc(32,65)); assert(await fs.pathExists(ready)); idle(runtime);
            await pause(1350);
            assert(!await fs.pathExists(marker),'The descendant is terminated with the prefix producer');
        } finally {
            // Test-owned PIDs only: prevent an orphan if the tree assertion fails.
            if(await fs.pathExists(pids))for(const pid of await fs.readJson(pids))if(Number.isInteger(pid))try {process.kill(pid,'SIGKILL');}catch { /* Already reaped. */ }
        }
    });
}

async function testBookPreviewProcessAbortAndTimeoutBeforePrefixReject() {
    await fixture(async({directory,runtime,run})=>{
        const ready=path.join(directory,'abort-started'),controller=new AbortController();
        const outcome=run(`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');process.stdout.write('x');setInterval(()=>{},1000);`,
            {captureStdout:true,capturePrefixBytes:8,timeoutMs:4000,signal:controller.signal}).then(value=>({value}),error=>({error}));
        try {await started(ready);controller.abort();const result=await outcome;assert.equal(result.error?.code,'ABORT_ERR');idle(runtime);}
        finally {controller.abort();await outcome;}
        const timed=path.join(directory,'timeout-started');
        await assert.rejects(run(`require('fs').writeFileSync(${JSON.stringify(timed)},'ready');process.stdout.write('x');setInterval(()=>{},1000);`,
            {captureStdout:true,capturePrefixBytes:8,timeoutMs:1200}),error=>error.code==='INPX_CONVERSION_TIMEOUT');
        assert(await fs.pathExists(timed)); idle(runtime);
    });
}

async function testBookPreviewProcessErrorsAndLegacyOutputCapRemainFailures() {
    await fixture(async({directory,runtime,run})=>{
        await assert.rejects(run("process.stdout.write('tiny',()=>process.exit(7))",{captureStdout:true,capturePrefixBytes:32,timeoutMs:3000}),/exit code 7/);
        idle(runtime);
        await assert.rejects(runtime.run(()=>runProcess(path.join(directory,'missing-executable'),[],{captureStdout:true,capturePrefixBytes:8,timeoutMs:3000})),error=>error.code==='ENOENT');
        idle(runtime);
        await assert.rejects(run("process.stdout.write('more than four bytes');setInterval(()=>{},1000)",{captureStdout:true,maxOutputBytes:4,timeoutMs:3000}),error=>error.code==='INPX_RESOURCE_OUTPUT_LIMIT');
        idle(runtime);
    });
}

async function testBookPreviewProcessInvalidPrefixOptionsCannotSpawnOrWrite() {
    await fixture(async({directory,runtime,run})=>{
        const marker=path.join(directory,'child-started'),outputFile=path.join(directory,'output.bin');
        const source=`require('fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write('payload');`;
        for(const options of [
            {capturePrefixBytes:8},
            ...[0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1].map(capturePrefixBytes=>({captureStdout:true,capturePrefixBytes})),
            {captureStdout:true,capturePrefixBytes:8,outputFile},
            {captureStdout:true,capturePrefixBytes:8,maxOutputBytes:4},
        ]) {await assert.rejects(run(source,options),/capturePrefixBytes/);idle(runtime);}
        await pause(500);
        assert(!await fs.pathExists(marker),'Invalid combinations are rejected before spawning');
        assert(!await fs.pathExists(outputFile),'Invalid prefix/file combinations never create output');
    });
}

module.exports=[testBookPreviewProcessReturnsExactBinaryPrefixAndShortEof,testBookPreviewProcessPrefixKillsDescendantsBeforeTheyWrite,
    testBookPreviewProcessAbortAndTimeoutBeforePrefixReject,testBookPreviewProcessErrorsAndLegacyOutputCapRemainFailures,
    testBookPreviewProcessInvalidPrefixOptionsCannotSpawnOrWrite];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
