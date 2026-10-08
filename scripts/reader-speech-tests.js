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
const {ReaderSpeech, extractSpeechText, extractSpeechChapters, splitSpeechText, registerSpeechRoute} = require('../server/core/ReaderSpeech');
const {normalizeSpeechOptions, defaultSpeechOptions} = require('../shared/speechOptions');

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
    const nested = new Fb2Parser().fromString(`<FictionBook><body><title><p>Книга</p></title><section>
        <title><p>Часть первая</p></title><section><title><p>Первая глава</p></title><p>Первый текст.</p></section>
        <section><title><p>Вторая глава</p></title><p>Второй текст.</p></section><p>Послесловие части.</p>
        </section><p>Конец книги.</p></body><body name="notes"><p>НЕ ЧИТАТЬ</p></body></FictionBook>`).rawNodes;
    const nestedParts = extractSpeechChapters(nested);
    assert.equal(nestedParts.map(part => part.text).join('\n\n'), extractSpeechText(nested), 'Nested chapters preserve order and all text without duplicates');
    assert.equal(nestedParts[0].title, 'Первая глава');
    assert.ok(nestedParts.every((part, index) => part.index === index));
    const longText = 'Русский текст. Очень длинная глава! '.repeat(600);
    const bounded = extractSpeechChapters(fb2(longText));
    assert.ok(bounded.length > 1 && bounded.every(part => part.text.length <= 6000));
    assert.equal(bounded.map(part => part.text).join(' '), longText.trim());
    const online = extractSpeechChapters(fb2(longText), 700);
    assert.ok(online.length > bounded.length && online.every(part => part.text.length <= 700));
    assert.equal(online.map(part => part.text).join(' '), longText.trim());
    assert.equal(splitSpeechText('я'.repeat(1401), 700).join(''), 'я'.repeat(1401));
    assert.equal(bounded.filter(part => part.chapterEnd).length, 1, 'Split fragments must not invent chapter boundaries');
    assert.deepEqual(normalizeSpeechOptions(), defaultSpeechOptions());
    for (const options of [{pitch: 'evil'}, {sentencePauseMs: -1}, {chapterPauseMs: 10001}, {paragraphPauseMs: '100'},
        {dictionary: 'слово = <break/>'}, {dictionary: 'слово = +слово'}, {dictionary: 'Имя = имя\nимя = имя'}])
        assert.throws(() => normalizeSpeechOptions(options));

    const audio = Buffer.from('ID3test-audio-range-payload');
    let calls = 0, mode = 'ok', release, lastPayload, engineId = '';
    let gate = new Promise(resolve => { release = resolve; });
    const mock = express();
    mock.use(express.json());
    mock.get('/health', (req, res) => res.json({cacheIdentity: engineId}));
    mock.post('/synthesize', async(req, res) => {
        calls++;
        lastPayload = req.body;
        assert.equal(req.headers.authorization, 'Bearer test-key');
        assert.equal(req.body.model, 'v5_5_ru');
        assert.equal(Object.hasOwn(req.body, 'rate'), false, 'Playback speed must not become a synthesis parameter');
        await gate;
        if (mode === 'error') return res.status(503).json({error: 'busy'});
        if (mode !== 'old-service') res.set('X-INPX-Speech-Options', '1');
        res.set('X-INPX-Speech-Engine', mode === 'wrong-engine' ? 'other-engine' : engineId || 'builtin');
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
        engineId = 'silero-stress-1.5-pipeline-v1';
        const stressed = await speech.prepare('a', 'book-1', {fb2: sample});
        assert.notEqual(stressed.id, id, 'External accentuation must not reuse the built-in audio cache');
        assert.equal((await settled(speech, 'a', stressed.id)).state, 'ready');
        assert.equal(speech.status('a', stressed.id).engineId, engineId);
        engineId = '';
        assert.equal((await speech.prepare('a', 'book-1', {fb2: sample})).id, id, 'Disabling stress returns to the original audio cache');
        mode = 'wrong-engine';
        const incompatible = await speech.prepare('a', 'wrong-engine-book', {fb2: sample});
        assert.match((await settled(speech, 'a', incompatible.id)).error, /расстановки ударений изменился/);
        mode = 'ok';
        const beforeRegeneration = calls;
        await fs.remove(path.join(speech.directory, `${id}.mp3`));
        const regenerated = await speech.prepare('a', 'book-1', {fb2: sample});
        assert.equal((await settled(speech, 'a', regenerated.id)).state, 'ready');
        assert.equal(calls, beforeRegeneration + 1, 'An evicted file must regenerate');
        const plan = await speech.plan({fb2: nested}, 'chapters');
        assert.equal(plan.chapters.length, nestedParts.length);
        assert.ok(plan.chapters.every(part => part.characters > 0 && !Object.hasOwn(part, 'text')), 'Plans must not expose book text');
        const chapter = await speech.preparePart('a', 'chapter-book', {fb2: nested}, 'aidar', 'chapters', 1);
        assert.equal((await settled(speech, 'a', chapter.id)).state, 'ready');
        await assert.rejects(speech.preparePart('a', 'chapter-book', {fb2: nested}, 'aidar', 'chapters', -1), /не найдена/);
        await assert.rejects(speech.preparePart('a', 'chapter-book', {fb2: nested}, 'aidar', 'chapters', '1'), /не найдена/);
        const preview = await speech.preview('a', 'baya');
        assert.equal((await settled(speech, 'a', preview.id)).state, 'ready');
        const beforePreview = calls;
        assert.equal((await speech.preview('b', 'baya')).state, 'ready');
        assert.equal(calls, beforePreview, 'A voice preview is cached across profiles');
        const options = {pitch: 'low', sentencePauseMs: 300, paragraphPauseMs: 1000, chapterPauseMs: 2000, dictionary: 'Гермиона = Герми+она'};
        const custom = await speech.preview('a', 'baya', options, 'Гермиона открыла книгу.\n\nКонец пробы.');
        assert.notEqual(custom.id, preview.id);
        assert.equal((await settled(speech, 'a', custom.id)).state, 'ready');
        assert.deepEqual(lastPayload.options, normalizeSpeechOptions(options));
        assert.equal(lastPayload.segments[0].chapterEnd, true);
        const reused = await speech.preview('b', 'baya', {...options, dictionary: ' Гермиона=Герми+она '}, 'Гермиона открыла книгу.\n\nКонец пробы.');
        assert.equal(reused.id, custom.id, 'Whitespace differences in the dictionary must reuse audio');
        const changed = await speech.preview('a', 'baya', {...options, pitch: 'high'}, 'Гермиона открыла книгу.');
        assert.notEqual(changed.id, custom.id);
        assert.equal((await settled(speech, 'a', changed.id)).state, 'ready');
        const whole = await speech.preparePart('a', 'tuned-book', {fb2: nested}, 'xenia', 'book', 0, options);
        assert.equal((await settled(speech, 'a', whole.id)).state, 'ready');
        assert.equal(lastPayload.segments.map(segment => segment.text).join('\n\n'), extractSpeechText(nested));
        assert.equal(lastPayload.segments.length, nestedParts.length, 'Whole-book synthesis retains chapter boundaries');
        await assert.rejects(speech.preview('a', 'baya', options, 'a'.repeat(501)), /500/);
        mode = 'old-service';
        const unsupported = await speech.preview('a', 'aidar', options);
        assert.match((await settled(speech, 'a', unsupported.id)).error, /Обновите контейнер Silero/);
        mode = 'ok';
        const progressSpeech = new ReaderSpeech({...config, dataDir: path.join(directory, 'progress')}, {
            post: async() => { await pause(1300); return {headers: {'content-type': 'audio/mpeg'}, data: Readable.from(audio)}; },
            get: async url => ({data: url.endsWith('/estimate') ? {charactersPerSecond: 10, measured: true, warmupSeconds: 0} : {progress: 0.5, remainingSeconds: 12}}),
        });
        const estimate = await progressSpeech.plan({fb2: sample}, 'book');
        assert.equal(estimate.estimate.totalSeconds, Math.ceil(extractSpeechText(sample).length / 10));
        const progressJob = await progressSpeech.preparePart('a', 'progress', {fb2: sample}, 'xenia', 'book', 0);
        await pause(1150);
        const progressing = progressSpeech.status('a', progressJob.id);
        assert.ok(progressing.progress > 0.4 && progressing.progress <= 0.5);
        assert.equal(progressing.remainingSeconds, 12);
        const done = await settled(progressSpeech, 'a', progressJob.id);
        assert.equal(done.progress, 1);
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
    const sampleText = 'Гермиона открыла книгу. Сегодня хорошая погода.\n\nСледующая глава.';
    const samples = [];
    for (const options of [
        {sentencePauseMs: 0, paragraphPauseMs: 0, chapterPauseMs: 0},
        {sentencePauseMs: 1000, paragraphPauseMs: 2000, chapterPauseMs: 3000},
        {pitch: 'low', dictionary: 'Гермиона = Герми+она'},
    ]) {
        const preview = await speech.preview('test', 'xenia', options, sampleText);
        const result = await settled(speech, 'test', preview.id, 600000);
        assert.equal(result.state, 'ready', result.error);
        samples.push((await fs.stat(path.join(speech.directory, `${preview.id}.mp3`))).size);
    }
    assert.ok(samples[1] > samples[0] + 40000, 'Six seconds of explicit pauses must be present in the actual 64 kbps MP3');
    console.log('Real Silero: speech options, trailing silence, pitch and stressed pronunciation passed');
    console.log(`Real Silero: ${((Date.now() - start) / 1000).toFixed(1)}s; sample: ${file}`);
}

(async() => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-speech-tests-'));
    try { await testCore(directory); } finally { await fs.remove(directory); }
    await require('./reader-audio-player-tests')();
    const index = process.argv.indexOf('--silero-url');
    if (index >= 0) await testRealService(process.argv[index + 1]);
})().catch(error => { console.error(error); process.exitCode = 1; });
