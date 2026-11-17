const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {once} = require('node:events');
const {join} = require('node:path');
const {setTimeout:sleep} = require('node:timers/promises');
const {ZipFile} = require('yazl');
const {connect, signIn, waitFor} = require('./rust-events-tests');
const {defaultSpeechOptions} = require('../shared/speechOptions');

const password = 'rust-reader-audio-test';
const title = 'Книга для проверки Rust и Silero';
const cancelTitle = 'Длинная книга для проверки остановки';

async function zip(path, files) {
    const archive = new ZipFile();
    const chunks = [];
    archive.outputStream.on('data', chunk => chunks.push(chunk));
    const complete = once(archive.outputStream, 'end');
    for (const [name, contents] of files) archive.addBuffer(Buffer.from(contents), name);
    archive.end();
    await complete;
    await fs.writeFile(path, Buffer.concat(chunks));
}

async function fixture(library) {
    await fs.mkdir(library, {recursive:true});
    const first = 'В тихой библиотеке читатели открыли книгу и приготовились слушать. За широкими окнами шелестели деревья.';
    const second = 'Наступило солнечное утро. Путешественники вышли из дома и увидели на песке цепочку маленьких следов.';
    const book = (name, repeats) => `<FictionBook><description><title-info><book-title>${name}</book-title>
        <lang>ru</lang></title-info></description><body>
        <section><title><p>Первая глава</p></title>
        <p>${(first + ' ').repeat(repeats)}<a type="note">СНОСКА</a></p></section>
        <section><title><p>Вторая глава</p></title><p>${(second + ' ').repeat(repeats)}</p></section>
        </body><body name="notes"><section><p>Пояснения из сносок.</p></section></body></FictionBook>`;
    const samples = [[title, book(title, 16)], [cancelTitle, book(cancelTitle, 125)]];
    const rows = samples.map(([name, contents], i) => [
        'Тестов,Автор:', 'sf:', name, '', 0, i+1, Buffer.byteLength(contents), i+1, 0,
        'fb2', '2026-11-17', 'ru', 0, '',
    ].join('\x04'));
    await zip(join(library, 'speech.inpx'), [['collection.info', 'Озвучка\n'], ['speech.inp', rows.join('\n') + '\n']]);
    await zip(join(library, 'speech.zip'), samples.map(([, contents], i) => [`${i+1}.fb2`, contents]));
}

async function signedInPage(browser, base, errors) {
    const context = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, serviceWorkers:'block'});
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/profile');
    await page.getByRole('region', {name:'Текущий профиль'}).getByRole('button', {name:'Войти', exact:true}).click();
    await page.getByRole('textbox', {name:'Логин', exact:true}).fill('admin');
    await page.getByRole('textbox', {name:'Пароль', exact:true}).fill(password);
    await page.getByRole('button', {name:'OK', exact:true}).click();
    await page.locator('.profile-bottom .profile-logout').waitFor();
    return page;
}

async function openPlayer(page, base, bookUid) {
    await page.goto(base + '/#/reader?bookUid=' + encodeURIComponent(bookUid));
    await page.getByRole('button', {name:'Озвучка книги', exact:true}).click({timeout:60000});
    return page.getByRole('complementary', {name:'Озвучка книги'});
}

async function checkMp3(base, url) {
    const response = await fetch(base + url, {method:'HEAD'});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert(Number(response.headers.get('content-length')) > 1024);
    const range = await fetch(base + url, {headers:{range:'bytes=0-1023'}});
    assert.equal(range.status, 206);
    assert.match(range.headers.get('content-range'), /^bytes 0-1023\/\d+$/);
    assert.equal((await range.arrayBuffer()).byteLength, 1024);
    for (const invalid of [url.split('?')[0], url.replace(/access=./, 'access=0')]) {
        const denied = await fetch(base + invalid);
        assert.equal(denied.status, 404);
        await denied.body.cancel();
    }
}

async function verify(base) {
    const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
    const api = await connect(base);
    let browser, observer;
    try {
        assert.equal(api.config.ttsEnabled, true);
        assert(api.config.clientApi.features.includes('cancelAudio'));
        const identity = await signIn(api, 'admin', password);
        const send = async (action, fields) => {
            const result = await api.send(action, {...identity, ...fields});
            assert.equal(result.error || '', '', `${action}: ${result.error}`);
            return result;
        };
        const find = async name => (await send('bookSearch', {query:{title:'='+name}})).found[0]._uid;
        const bookUid = await find(title), longUid = await find(cancelTitle);
        const chapters = await send('get-reader-audio-plan', {bookUid, mode:'chapters'});
        assert.deepEqual(chapters.chapters.map(chapter => chapter.title), ['Первая глава', 'Вторая глава']);
        assert(!JSON.stringify(chapters.chapters).includes('СНОСКА'));
        assert(chapters.estimate.charactersPerSecond > 0);
        const anchored = await send('get-reader-audio-plan', {bookUid, mode:'chapters', anchor:chapters.chapters[1].anchor});
        assert.equal(anchored.startChapter, 1);
        const online = await send('get-reader-audio-plan', {bookUid, mode:'online'});
        assert(online.chapters.every(chapter => chapter.characters <= 700));
        const invalid = await api.send('preview-reader-voice', {...identity, csrfToken:'invalid'});
        assert.equal(invalid.error, 'bad_csrf_token');
        console.log('ok plan, FB2 chapters, online segment limit, text anchor, estimate and audio CSRF');

        browser = await chromium.launch({headless:true, executablePath:process.env.INPX_CHROMIUM_PATH || undefined,
            args:['--autoplay-policy=no-user-gesture-required']});
        const errors = [];
        const page = await signedInPage(browser, base, errors);
        const player = await openPlayer(page, base, bookUid);
        const audio = player.locator('audio').first();
        await player.getByRole('button', {name:'Послушать пробу', exact:true}).click();
        await player.getByText('Проба голоса', {exact:true}).waitFor({timeout:90000});
        await page.waitForFunction(() => {
            const audio = document.querySelector('.reader-audio audio');
            return audio?.currentTime > 0 && Number.isFinite(audio.duration) && !audio.paused;
        }, null, {timeout:30000});
        const preview = new URL(await audio.getAttribute('src'), base);
        await checkMp3(base, preview.pathname + preview.search);
        console.log('ok real Silero voice preview, Chromium audio decoding and signed MP3 ranges');

        await player.getByRole('combobox', {name:'Озвучка', exact:true}).selectOption('book');
        await player.getByRole('button', {name:'Создать аудиокнигу', exact:true}).click();
        const active = await waitFor(
            () => send('get-background-tasks'),
            result => result.tasks.some(job => job.kind==='speech' && job.state==='generating'),
            'Speech task did not appear during generation', 250,
        );
        const activeJob = active.tasks.find(job => job.kind==='speech' && job.state==='generating');
        const during = performance.now();
        assert.equal(await find(title), bookUid);
        assert(performance.now() - during < 2000, 'Catalogue search waited for synthesis');
        assert.equal((await send('get-reader-audio-status', {jobId:activeJob.id})).state, 'generating');
        await page.waitForFunction(() => {
            const bar = document.querySelector('.reader-audio progress');
            return bar && bar.value > 0 && bar.value < 1 && bar.getClientRects().length;
        }, null, {timeout:90000});
        await page.waitForFunction(() => document.querySelector('.reader-audio audio')?.duration > 10,
            null, {timeout:240000});
        assert.equal((await send('get-reader-audio-status', {jobId:activeJob.id})).state, 'ready');
        console.log('ok real book synthesis, visible percentage, background task and concurrent catalogue search');

        observer = await connect(base, '', api.cookie);
        await observer.send('subscribe-client-events', identity);
        await player.getByRole('combobox', {name:'Скорость', exact:true}).selectOption('1.5');
        await audio.evaluate(async element => {
            element.currentTime = 8.25;
            await element.play();
        });
        await sleep(200);
        await audio.evaluate(element => element.pause());
        const played = await audio.evaluate(element => ({time:element.currentTime, rate:element.playbackRate}));
        assert(played.time >= 8.25);
        assert.equal(played.rate, 1.5);
        await player.getByRole('button', {name:'Закрыть и остановить озвучку', exact:true}).click();
        const variant = JSON.stringify([chapters.engineId, 'xenia', 'book', defaultSpeechOptions()]);
        const position = async () => (await send('get-audio-position', {bookUid, variant})).progress;
        const saved = await waitFor(position, row => row.time >= 8.25 && row.rate === 1.5, 'Position was not saved by the browser');
        await waitFor(() => observer.events, events => events.some(event => event.kind==='audio' && event.bookUid===bookUid),
            'Audio event did not reach the subscribed profile');
        const stale = await send('update-audio-position', {bookUid, variant, progress:{baseRevision:0, time:0}});
        assert.equal(stale.progress.conflict, true);
        assert(stale.progress.revision >= saved.revision);
        assert(stale.progress.time >= 8.25);
        assert.equal(stale.progress.rate, 1.5);
        await page.context().close();

        const reopened = await signedInPage(browser, base, errors);
        const resumed = await openPlayer(reopened, base, bookUid);
        await resumed.getByRole('combobox', {name:'Озвучка', exact:true}).selectOption('book');
        await resumed.getByRole('button', {name:'Создать аудиокнигу', exact:true}).click();
        await reopened.waitForFunction(time => {
            const audio = document.querySelector('.reader-audio audio');
            return audio?.currentTime >= time && audio.playbackRate === 1.5;
        }, saved.time - 0.1, {timeout:30000});
        await resumed.locator('audio').first().evaluate(element => element.play());
        await reopened.waitForFunction(time => document.querySelector('.reader-audio audio')?.currentTime > time, saved.time + 0.2);
        console.log(`ok fresh browser profile resumes from server at ${saved.time.toFixed(2)} s with 1.5× speed`);

        const cancellation = await openPlayer(reopened, base, longUid);
        await cancellation.getByRole('combobox', {name:'Озвучка', exact:true}).selectOption('book');
        await cancellation.getByRole('button', {name:'Создать аудиокнигу', exact:true}).click();
        await cancellation.getByRole('progressbar', {name:'Прогресс создания аудио'}).waitFor();
        const tasks = await waitFor(
            () => send('get-background-tasks'),
            result => result.tasks.some(job => job.kind==='speech' && job.state==='generating'),
            'Long synthesis was not started',
        );
        const job = tasks.tasks.find(job => job.kind==='speech' && job.state==='generating');
        const consumerId = 'audio-second-test-consumer';
        const shared = await send('prepare-reader-audio', {bookUid:longUid, mode:'book', chapterIndex:0, consumerId});
        assert.equal(shared.id, job.id, 'Identical preparation was queued twice');
        await waitFor(
            () => send('get-reader-audio-status', {jobId:job.id}),
            result => result.state==='generating' && result.progress > 0,
            'Silero did not report active synthesis before cancellation', 450,
        );
        assert.equal((await send('cancel-reader-audio', {consumerId})).state, 'cancelled');
        assert.equal((await send('get-reader-audio-status', {jobId:job.id})).state, 'generating');
        await cancellation.getByRole('button', {name:'Закрыть и остановить озвучку', exact:true}).click();
        const stopped = await waitFor(
            () => send('get-reader-audio-status', {jobId:job.id}),
            result => result.state==='cancelled',
            'Closing the player did not cancel the last request for synthesis',
        );
        assert.equal(stopped.url, undefined);
        const next = await send('preview-reader-voice', {speaker:'baya', sampleText:'Короткая проба после отмены записи.',
            options:{pitch:'low', sentencePauseMs:150}});
        await waitFor(
            () => send('get-reader-audio-status', {jobId:next.id}),
            result => result.state==='ready',
            'Silero did not accept the next job after cancellation', 1100,
        );
        assert.deepEqual(errors, []);
        console.log('ok shared job cancellation, last consumer stops synthesis, and tuned voice preview runs next');
    } finally {
        observer?.close();
        api.close();
        await browser?.close();
    }
}

const [target, library] = process.argv.slice(2);
(target==='fixture' ? fixture(library) : verify(target)).catch(error => {console.error(error); process.exitCode=1;});
