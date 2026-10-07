const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const axios = require('axios');
const {Readable} = require('stream');
const {execFileSync} = require('child_process');
const Fb2Parser = require('../server/core/fb2/Fb2Parser');
const {ReaderSpeech, extractSpeechText, registerSpeechRoute} = require('../server/core/ReaderSpeech');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fb2 = text => new Fb2Parser().fromString(`<FictionBook><body><section><p>${text}</p></section></body></FictionBook>`).rawNodes;
async function settled(speech, user, id, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const job = speech.status(user, id);
        if (job.state === 'ready' || job.state === 'error') return job;
        await pause(20);
    }
    throw new Error('Timed out waiting for synthesis');
}
async function listen(app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {server, url: `http://127.0.0.1:${server.address().port}`};
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }

async function testCore(directory) {
    for (const [flag, url, expected] of [
        ['', '', false], ['', 'http://silero:8000', false],
        ['false', 'http://silero:8000', false], ['true', '', false], ['true', 'http://silero:8000', true],
    ]) {
        const enabled = execFileSync(process.execPath, ['-e',
            'const c=require("./server/config/base"); process.stdout.write(String(Boolean(c.ttsEnabled && c.ttsUrl)))'],
        {cwd: path.resolve(__dirname, '..'), env: {...process.env, INPX_TTS_ENABLED: flag, INPX_TTS_URL: url}, encoding: 'utf8'});
        assert.equal(enabled, String(expected), `Container opt-in: ${flag} / ${url}`);
    }
    assert.ok(!require('../server/config').propsToSave.includes('ttsEnabled'), 'TTS must not become an admin setting');
    assert.ok(!require('../server/config').propsToSave.includes('ttsUrl'), 'TTS address must remain a startup setting');
    const sample = new Fb2Parser().fromString(`<FictionBook>
        <description><title-info><annotation><p>Не читаем аннотацию</p></annotation></title-info></description>
        <body><section><title><p>Глава первая</p></title>
        <p>Привет, <emphasis>мир</emphasis> &amp; книга<a type="note">[1]</a>!</p>
        <poem><stanza><v>Строка стиха</v></stanza></poem>
        <p><![CDATA[Текст <без разметки>]]></p><image/><empty-line/>
        </section></body><body name="notes"><section><p>Не читаем сноску</p></section></body>
        <binary>Не читаем двоичные данные</binary></FictionBook>`).rawNodes;
    assert.equal(extractSpeechText(sample), 'Глава первая\n\nПривет, мир & книга!\n\nСтрока стиха\n\nТекст <без разметки>');
    assert.throws(() => extractSpeechText(fb2('')), /нет текста/);
    assert.throws(() => extractSpeechText(fb2('a'.repeat(3000001))), /слишком большой/);

    const audio = Buffer.from('ID3test-audio-range-payload');
    let calls = 0, mode = 'ok', release;
    let gate = new Promise(resolve => { release = resolve; });
    const mock = express();
    mock.use(express.json());
    mock.post('/synthesize', async(req, res) => {
        calls++;
        assert.equal(req.headers.authorization, 'Bearer test-key');
        assert.equal(req.body.model, 'v5_5_ru');
        await gate;
        if (mode === 'error') return res.status(503).json({error: 'busy'});
        res.type(mode === 'wrong-type' ? 'text/plain' : 'audio/mpeg').send(mode === 'empty' ? Buffer.alloc(0) : audio);
    });
    const service = await listen(mock);
    const config = {dataDir: directory, rootPathStatic: '/books', ttsEnabled: true,
        ttsUrl: service.url, ttsApiKey: 'test-key', ttsCacheSizeMb: 64, ttsTimeoutMs: 1000};
    const speech = new ReaderSpeech(config);
    const app = express();
    registerSpeechRoute(app, config, speech);
    const media = await listen(app);
    try {
        await assert.rejects(new ReaderSpeech({...config, ttsEnabled: false}).prepare('a', 'b', {fb2: sample}), /не настроена/);
        await assert.rejects(speech.prepare('a', 'b', {fb2: sample}, 'other'), /Неизвестный/);
        await assert.rejects(speech.prepare('a', 'b', {}), /FB2/);
        const jobs = await Promise.all(Array.from({length: 20}, () => speech.prepare('a', 'book-1', {fb2: sample})));
        assert.equal(new Set(jobs.map(job => job.id)).size, 1);
        const id = jobs[0].id;
        assert.throws(() => speech.status('other', id), /не найдено/);
        release();
        const ready = await settled(speech, 'a', id);
        assert.equal(ready.state, 'ready', ready.error);
        assert.equal(calls, 1, 'Concurrent preparations must synthesize once');
        assert.deepEqual(await fs.readFile(path.join(speech.directory, `${id}.mp3`)), audio);
        const range = await axios.get(media.url + ready.url, {headers: {Range: 'bytes=3-8'}, responseType: 'arraybuffer'});
        assert.equal(range.status, 206);
        assert.deepEqual(Buffer.from(range.data), audio.subarray(3, 9));
        assert.equal(range.headers['accept-ranges'], 'bytes');
        assert.equal(range.headers['cache-control'], 'private, no-store');
        assert.equal((await axios.head(media.url + ready.url)).headers['content-length'], String(audio.length));
        const denied = url => axios.get(media.url + url, {validateStatus: () => true});
        assert.equal((await denied(`/books/reader-audio/${id}.mp3`)).status, 404);
        const access = new URL(ready.url, media.url).searchParams.get('access');
        assert.equal(await speech.authorizedFile(id, access.slice(0, -1) + (access.endsWith('a') ? 'b' : 'a')), null);
        const expires = Date.now() - 1;
        assert.equal(await speech.authorizedFile(id, `${expires}.${speech.signature(id, expires)}`), null);
        assert.equal(await speech.authorizedFile('../secret', access), null);
        const second = new ReaderSpeech(config);
        assert.equal((await second.prepare('b', 'book-1', {fb2: sample})).state, 'ready');
        assert.equal(calls, 1, 'Cache survives service restart');
        await fs.remove(path.join(speech.directory, `${id}.mp3`));
        const regenerated = await speech.prepare('a', 'book-1', {fb2: sample});
        assert.equal((await settled(speech, 'a', regenerated.id)).state, 'ready');
        assert.equal(calls, 2, 'An evicted file must regenerate');
        for (const failure of ['empty', 'wrong-type', 'error']) {
            mode = failure;
            const failed = await speech.prepare('a', failure, {fb2: sample});
            assert.equal((await settled(speech, 'a', failed.id)).state, 'error');
            assert.equal(await fs.pathExists(path.join(speech.directory, `${failed.id}.mp3`)), false);
            assert.equal(await fs.pathExists(path.join(speech.directory, `${failed.id}.mp3.partial`)), false);
            mode = 'ok';
            const retry = await speech.prepare('a', failure, {fb2: sample});
            assert.equal((await settled(speech, 'a', retry.id)).state, 'ready');
        }
        mode = 'ok';
        const old = path.join(speech.directory, `${'f'.repeat(64)}.mp3`);
        await fs.writeFile(old, 'old');
        await fs.utimes(old, new Date(0), new Date(0));
        await speech.cleanCache(0);
        assert.equal(await fs.pathExists(old), false);
        assert.equal(await fs.pathExists(path.join(speech.directory, `${id}.mp3`)), true, 'Recently served audio must survive cache cleaning');

        let unblock;
        const waiting = new Promise(resolve => { unblock = resolve; });
        const queue = new ReaderSpeech({...config, dataDir: path.join(directory, 'queue')}, {
            post: async() => { await waiting; return {headers: {'content-type': 'audio/mpeg'}, data: Readable.from(audio)}; },
        });
        const queued = await Promise.all(Array.from({length: 8}, (_, i) => queue.prepare('a', `queued-${i}`, {fb2: sample})));
        await assert.rejects(queue.prepare('a', 'queue-overflow', {fb2: sample}), /Очередь/);
        unblock();
        for (const job of queued) assert.equal((await settled(queue, 'a', job.id)).state, 'ready');
        console.log('TTS: extraction, deduplication, queue, cache, retries, access and HTTP Range passed');
    } finally { release(); await close(media.server); await close(service.server); }
}

async function testRealService(url) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-silero-real-'));
    const speech = new ReaderSpeech({dataDir: directory, ttsEnabled: true, ttsUrl: url, ttsTimeoutMs: 600000});
    const start = Date.now();
    const text = 'Здравствуйте! Это проверка озвучки книги. Silero читает текст на русском языке. Можно слушать и продолжать с сохранённого места.';
    const job = await speech.prepare('test', 'real-silero', {fb2: fb2(text)});
    const ready = await settled(speech, 'test', job.id, 600000);
    assert.equal(ready.state, 'ready', ready.error);
    const file = path.join(speech.directory, `${job.id}.mp3`);
    assert.ok((await fs.stat(file)).size > 10000, 'Real synthesized audio must be nonempty');
    console.log(`Real Silero: ${((Date.now() - start) / 1000).toFixed(1)}s; sample: ${file}`);
}

(async() => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-speech-tests-'));
    try { await testCore(directory); } finally { await fs.remove(directory); }
    const index = process.argv.indexOf('--silero-url');
    if (index >= 0) await testRealService(process.argv[index + 1]);
})().catch(error => { console.error(error); process.exitCode = 1; });
