const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {parse} = require('@vue/compiler-sfc');

module.exports = async function testReaderAudioPlayer() {
    const storage = new Map();
    const localStorage = {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)};
    const script = parse(fs.readFileSync(path.join(__dirname, '../client/components/Reader/ReaderAudio.vue'), 'utf8')).descriptor.script.content;
    const component = new Function('navigator', 'localStorage', 'MediaMetadata', 'require', script.replace('export default', 'return'))(
        {}, localStorage, undefined, require('module').createRequire(path.resolve(__dirname, '../client/components/Reader/ReaderAudio.vue')));
    const parts = [{index: 0, title: 'Первая', characters: 100}, {index: 1, title: 'Вторая', characters: 100}, {index: 2, title: 'Третья', characters: 100}];
    function player(api = {}) {
        const audio = {currentTime: 0, duration: 60, paused: true, playbackRate: 1,
            pause() { this.paused = true; }, load() {}, removeAttribute() {}, play() { this.paused = false; return Promise.resolve(); }};
        const instance = {...component.data(), bookUid: 'book-a',
            $store: {state: {settings: {currentUserId: 'profile-a'}, config: {rootPathStatic: '/books'}}},
            $refs: {audio, preloadAudio: {...audio}},
            $root: {api: {getReaderAudioPlan: async() => ({chapters: parts, estimate: null}),
                prepareReaderAudio: async() => ({id: 'chapter', state: 'ready', url: '/chapter.mp3'}),
                previewReaderVoice: async() => ({id: 'preview', state: 'ready', url: '/preview.mp3'}), ...api}},
        };
        for (const [name, method] of Object.entries(component.methods)) instance[name] = method.bind(instance);
        return instance;
    }
    const resume = player();
    const key = resume.positionKey();
    storage.set(key, JSON.stringify({chapter: 1, time: 12, rate: 0.75}));
    await resume.loadPlan();
    assert.equal(resume.chapterIndex, 1);
    assert.equal(resume.rate, 0.75);
    await resume.prepare();
    resume.rate = 2; // A user changes speed while metadata is still loading.
    resume.restorePosition();
    assert.equal(resume.$refs.audio.currentTime, 12);
    assert.equal(resume.$refs.audio.playbackRate, 2, 'Loading metadata must not undo a new player speed');
    resume.$refs.audio.currentTime = 13;
    await resume.prepare(true);
    resume.$refs.audio.currentTime = 4;
    resume.rate = 1.5;
    resume.applyRate();
    assert.deepEqual(JSON.parse(storage.get(key)), {chapter: 1, time: 13, rate: 2}, 'A voice preview must not overwrite the book position or rate');
    resume.close();

    const requested = [];
    const continuation = player({prepareReaderAudio: async(book, speaker, mode, chapter) => {
        requested.push(chapter); return {state: 'ready', url: '/third.mp3'};
    }});
    continuation.chapters = parts; continuation.storageKey = continuation.positionKey();
    continuation.src = '/first.mp3'; continuation.nextSrc = '/second.mp3';
    continuation.$refs.audio.currentTime = 60; continuation.rate = 1.25;
    continuation.onEnded();
    continuation.restorePosition();
    assert.equal(continuation.src, '/second.mp3');
    assert.equal(continuation.activeChapter, 1);
    assert.equal(continuation.$refs.audio.currentTime, 0, 'The next chapter must not inherit the previous chapter position');
    assert.equal(continuation.$refs.audio.paused, false);
    assert.equal(continuation.$refs.audio.playbackRate, 1.25);
    assert.deepEqual(requested, [2], 'Playback uses the prefetched second chapter and prepares only the third');
    continuation.close();

    let finish;
    const delayed = player({prepareReaderAudio: () => new Promise(resolve => { finish = resolve; })});
    const preparing = delayed.prepare();
    delayed.close();
    finish({state: 'ready', url: '/late.mp3'});
    await preparing;
    assert.equal(delayed.src, '', 'An old response must not resurrect a closed player');
    delayed.bookUid = 'book-b';
    assert.notEqual(delayed.positionKey(), key);
    delayed.bookUid = 'book-a'; delayed.$store.state.settings.currentUserId = 'profile-b';
    assert.notEqual(delayed.positionKey(), key);
    const tuningCalls = [];
    const tuning = player({previewReaderVoice: async(...args) => { tuningCalls.push(args); return {state: 'ready', url: '/custom-preview.mp3'}; },
        prepareReaderAudio: async(...args) => { tuningCalls.push(args); return {state: 'ready', url: '/custom.mp3'}; }});
    const plainKey = tuning.positionKey();
    tuning.draftOptions = {...tuning.draftOptions, pitch: 'low', chapterPauseMs: 2000, dictionary: 'Гермиона = Герми+она'};
    tuning.applyTuning();
    assert.notEqual(tuning.positionKey(), plainKey, 'Changed speech timing must not reuse a previous audio position');
    tuning.sampleText = 'Гермиона открыла книгу.';
    await tuning.prepare(true);
    assert.deepEqual(tuningCalls[0], ['xenia', tuning.speechOptions, tuning.sampleText]);
    await tuning.prepare();
    assert.deepEqual(tuningCalls[1].slice(0, 4), ['book-a', 'xenia', 'online', 0]);
    assert.deepEqual(tuningCalls[1][4], tuning.speechOptions);
    const other = player(); other.loadTuning();
    assert.deepEqual(other.speechOptions, tuning.speechOptions, 'Book speech preferences survive reopening');
    tuning.close(); other.close();
    tuning.resetTuning(); assert.equal(tuning.positionKey(), plainKey, 'Returning to defaults restores legacy positions');
    const stress = player({getReaderAudioPlan: async() => ({chapters: parts, engineId: 'stress-v1'})});
    const builtinKey = stress.positionKey();
    storage.set(builtinKey, JSON.stringify({chapter: 1, time: 40}));
    await stress.loadPlan();
    assert.notEqual(stress.positionKey(), builtinKey, 'A different accentuator must not inherit time in old audio');
    assert.equal(stress.chapterIndex, 0);
    stress.chapters = parts;
    stress.acceptNext({state: 'ready', engineId: 'stress-v2', url: '/wrong-engine.mp3'}, stress.generation);
    assert.equal(stress.nextSrc, '', 'A prefetched chapter with another accentuator must not play silently');
    assert.match(stress.nextError, /ударений изменился/);
    stress.src = '/old-engine.mp3'; stress.onEnded();
    assert.equal(stress.src, '');
    assert.equal(stress.state, 'error', 'A changed accentuator stops automatic continuation and requires fresh preparation');
    stress.close();
    console.log('TTS player: resume, playback speed, preview isolation, chapter continuation and stale responses passed');
};
