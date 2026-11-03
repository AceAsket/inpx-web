const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {Readable} = require('stream');
const {ReaderSpeech} = require('../server/core/ReaderSpeech');
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));

async function testAudioCancellationRemovesQueuedWorkAndPreservesOtherConsumers() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-audio-cancel-'));
    const gate = deferred(); const started = deferred(); const calls = []; const cancelled = [];
    const transport = {post:async(url,data) => {
        if (url.endsWith('/cancel')) {cancelled.push(url);gate.resolve();return {};}
        calls.push(data.text);started.resolve();
        if (data.text === 'running') await gate.promise;
        return {headers:{'content-type':'audio/mpeg'},data:Readable.from(['ID3fixture'])};
    }};
    const speech = new ReaderSpeech({dataDir,ttsEnabled:true,ttsUrl:'http://fixture'},transport);
    const prepare = (user,text,claim) => speech.prepareText(user,text,text,'xenia',false,undefined,undefined,claim);
    try {
        const first=await prepare('a','running','first-request-0001');await started.promise;
        const queued=await prepare('a','queued','queued-request-0001');
        assert.strictEqual(queued.state,'queued');
        speech.cancel('a','queued-request-0001');
        assert.strictEqual(speech.status('a',queued.id).state,'cancelled');
        assert.strictEqual(speech.queue.length,0);
        await prepare('b','running','first-request-0001');
        await prepare('a','running','second-request-0001');
        speech.cancel('outsider','first-request-0001');
        speech.cancel('a','first-request-0001');
        assert.strictEqual(cancelled.length,0,'Same-profile and other-profile waiters preserve shared synthesis');
        speech.cancel('a','second-request-0001');assert.strictEqual(cancelled.length,0);
        speech.cancel('b','first-request-0001');
        assert.strictEqual(cancelled.length,1);
        while(speech.running) await tick();
        assert.deepStrictEqual(calls,['running'],'Cancelled queued work never reaches Silero');
        assert.strictEqual(speech.status('a',first.id).state,'cancelled');
        assert.strictEqual(await fs.pathExists(path.join(speech.directory,`${first.id}.mp3`)),false,'Late completed stream cannot publish a cancelled MP3');
        assert.strictEqual((await prepare('a','queued','queued-request-0001')).state,'cancelled','A delayed/retried cancelled request cannot recreate a job');
        const retry=await prepare('a','running','new-request-00001');
        while(speech.running) await tick();
        assert.strictEqual(speech.status('a',retry.id).state,'ready','An explicit new attempt can run after cancellation');
        speech.cancel('a','new-request-00001');
        assert.strictEqual(speech.status('a',retry.id).state,'ready','Cancellation preserves completed cache files');
        const legacy=await prepare('legacy','legacy',undefined);
        await prepare('a','legacy','modern-request-0001');speech.cancel('a','modern-request-0001');
        while(speech.running) await tick();
        assert.strictEqual(speech.status('legacy',legacy.id).state,'ready','Old web/Android clients keep their own interest');
    } finally {gate.resolve();while(speech.running) await tick();await fs.remove(dataDir);}
}

async function testAudioCancellationBeforeMetadataAndControllerCsrf() {
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-audio-cancel-race-'));
    const gate=deferred();const calls=[];
    const speech=new ReaderSpeech({dataDir,ttsEnabled:true,ttsUrl:'http://fixture'}, {
        get:async()=>{await gate.promise;return {data:{}};},post:async()=>{calls.push(true);throw new Error('unexpected synthesis');},
    });
    try {
        const pending=speech.prepareText('a','book','Русский текст','aidar',false,undefined,undefined,'metadata-request-001');
        speech.cancel('a','metadata-request-001');gate.resolve();
        assert.strictEqual((await pending).state,'cancelled');assert.strictEqual(calls.length,0);
        assert.throws(()=>speech.cancel('a','bad'),/идентификатор/);
        const Controller=require('../server/controllers/WebSocketController');
        assert.strictEqual(Controller.prototype.isCsrfProtectedAction('cancel-reader-audio'),true);
    } finally {gate.resolve();await fs.remove(dataDir);}
}
async function testAudioCancellationDuringAtomicPublishNeverBecomesReady() {
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-audio-cancel-publish-'));
    const entered=deferred(), release=deferred(), move=fs.move;
    const speech=new ReaderSpeech({dataDir,ttsEnabled:true,ttsUrl:'http://fixture'}, {
        post:async()=>({headers:{'content-type':'audio/mpeg'},data:Readable.from(['ID3fixture'])}),
    });
    fs.move=async(...args)=>{entered.resolve();await release.promise;return move(...args);};
    try {
        const job=await speech.prepareText('a','book','Русский текст','aidar',false,undefined,undefined,'publish-request-0001');
        await entered.promise;speech.cancel('a','publish-request-0001');release.resolve();
        while(speech.running) await tick();
        assert.strictEqual(speech.status('a',job.id).state,'cancelled');
        assert.strictEqual(await fs.pathExists(path.join(speech.directory,`${job.id}.mp3`)),false);
    } finally {release.resolve();while(speech.running) await tick();fs.move=move;await fs.remove(dataDir);}
}
module.exports=[testAudioCancellationRemovesQueuedWorkAndPreservesOtherConsumers,testAudioCancellationBeforeMetadataAndControllerCsrf,
    testAudioCancellationDuringAtomicPublishNeverBecomesReady];
