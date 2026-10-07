<template>
    <aside v-show="visible" class="reader-audio" :class="{'reader-audio--minimized': minimized}" aria-label="Озвучка книги">
        <div v-show="!minimized" class="reader-audio-panel">
            <div class="reader-audio-header">
                <div class="reader-audio-title">
                    {{ title || 'Озвучка книги' }}
                </div>
                <q-btn flat dense round icon="la la-minus" aria-label="Свернуть плеер" @click="minimized = true" />
                <q-btn flat dense round icon="la la-times" aria-label="Закрыть и остановить озвучку" @click="close" />
            </div>
            <div class="reader-audio-options">
                <label>Голос
                    <select v-model="speaker" :disabled="busy">
                        <option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.name }}</option>
                    </select>
                </label>
                <label>Скорость
                    <select v-model.number="rate" @change="applyRate">
                        <option v-for="speed in [0.75, 1, 1.25, 1.5, 2]" :key="speed" :value="speed">{{ speed }}×</option>
                    </select>
                </label>
            </div>
            <div class="reader-audio-mode">
                <label>Озвучка
                    <select v-model="mode" :disabled="busy">
                        <option value="online">Слушать сразу</option>
                        <option value="chapters">По главам</option>
                        <option value="book">Вся книга в MP3</option>
                    </select>
                </label>
                <label v-if="mode !== 'book' && chapters.length">{{ mode === 'online' ? 'Фрагмент' : 'Глава' }}
                    <select v-model.number="chapterIndex" :disabled="busy" @change="changeChapter">
                        <option v-for="chapter in chapters" :key="chapter.index" :value="chapter.index">{{ chapter.index + 1 }}. {{ chapter.title }}</option>
                    </select>
                </label>
            </div>
            <q-btn v-if="!busy" class="reader-audio-preview" no-caps flat icon="la la-volume-up" label="Послушать голос · короткая проба" @click="prepare(true, true)" />
            <p v-if="!src && !busy && !error" class="reader-audio-hint">
                {{ mode === 'online' ? 'Подготовим небольшой фрагмент и продолжим озвучку по мере прослушивания.' : mode === 'chapters' ? 'Подготовим выбранную главу. Следующая начнёт готовиться заранее.' : 'Подготовим всю книгу в MP3; готовая запись сохранится в кэше.' }}
                Скорость меняется плеером, без повторной озвучки.
            </p>
            <p v-if="!busy && (!src || isPreview)" class="reader-audio-hint" role="status">
                {{ planLoading ? 'Оцениваем время подготовки…' : estimateText }}
            </p>
            <div v-if="busy" class="reader-audio-status" role="status">
                <q-spinner size="20px" /> {{ state === 'queued' ? `В очереди${queuePosition ? ' · место ' + queuePosition : ''}…` : phase === 'loading' ? 'Загружаем модель Silero…' : `Готовим ${isPreview ? 'пробу голоса' : mode === 'book' ? 'аудиокнигу' : 'фрагмент'} · ${Math.round(progress * 100)}%` }}
                <span v-if="remainingSeconds !== null">Осталось примерно {{ formatTime(remainingSeconds) }}</span>
            </div>
            <progress v-if="busy && state !== 'queued'" :value="progress" max="1" aria-label="Прогресс создания аудио" />
            <p v-if="error" class="reader-audio-error" role="alert">
                {{ error }}
            </p>
            <q-btn v-if="(!src || isPreview) && !busy" :disabled="planLoading" no-caps outline icon="la la-headphones" :label="error ? 'Повторить подготовку' : mode === 'book' ? 'Создать аудиокнигу' : 'Подготовить и слушать'" @click="prepare(false)" />
            <audio
                v-show="src" ref="audio" :src="src || undefined" controls preload="metadata"
                @loadedmetadata="restorePosition" @play="onPlay" @pause="onPause"
                @timeupdate="savePosition(false)" @seeked="savePosition(true)" @ended="onEnded" @error="onAudioError"
            />
            <audio ref="preloadAudio" class="reader-audio-preload" :src="nextSrc || undefined" preload="auto" aria-hidden="true" />
            <p v-if="src" class="reader-audio-hint">
                {{ isPreview ? 'Короткая проба выбранного голоса.' : mode === 'book' ? 'Вся книга.' : `${mode === 'online' ? 'Фрагмент' : 'Глава'} ${activeChapter + 1}/${chapters.length}. ${nextSrc ? 'Следующий готов.' : nextError || (activeChapter + 1 < chapters.length ? 'Следующий готовится…' : '')}` }}
                Нажмите ▶, чтобы слушать. Можно свернуть плеер.
            </p>
        </div>
        <q-btn v-show="minimized" no-caps icon="la la-headphones" :label="busy ? 'Готовим озвучку…' : 'Озвучка'" @click="minimized = false" />
    </aside>
</template>

<script>
let mediaOwner = null;
const mediaActions = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'stop'];

export default {
    name: 'ReaderAudio',
    props: {
        bookUid: {type: String, required: true},
        title: {type: String, default: ''},
        author: {type: String, default: ''},
        cover: {type: String, default: ''},
    },
    data() {
        return {
            visible: false, minimized: false, speaker: 'xenia', rate: 1, mode: 'online',
            state: '', src: '', error: '', jobId: '', generation: 0,
            pollTimer: null, storageKey: '', lastSaved: 0, pageHideHandler: null,
            chapters: [], chapterIndex: 0, activeChapter: 0, estimate: null, planLoading: false, planGeneration: 0,
            isPreview: false, autoPlay: false, nextSrc: '', nextJob: null, nextTimer: null, nextError: '',
            progress: 0, remainingSeconds: null, queuePosition: 0, phase: '',
            voices: [
                {id: 'xenia', name: 'Ксения (Xenia)'}, {id: 'kseniya', name: 'Ксения (Kseniya)'},
                {id: 'baya', name: 'Бая'}, {id: 'aidar', name: 'Айдар'}, {id: 'eugene', name: 'Евгений'},
            ],
        };
    },
    computed: {
        busy() { return this.state === 'queued' || this.state === 'generating' || this.state === 'requesting'; },
        estimateText() {
            if (!this.estimate) return 'Время подготовки пока неизвестно. Короткая проба поможет оценить скорость сервера.';
            const selected = this.chapters[this.chapterIndex];
            const first = this.mode === 'book' ? this.estimate.totalSeconds : Math.ceil((selected?.characters || 1) / this.estimate.charactersPerSecond + this.estimate.warmupSeconds);
            return `Подготовка: примерно ${this.formatTime(first)}${this.estimate.queueSeconds ? ' + очередь ' + this.formatTime(this.estimate.queueSeconds) : ''}. ${this.estimate.measured ? 'По скорости этого сервера.' : 'Предварительная оценка; после пробы станет точнее.'}`;
        },
        profileIdentity() {
            const config = this.$store.state.config || {};
            const settings = this.$store.state.settings || {};
            return [settings.currentUserId || config.currentUserId || '', config.profileAuthorized, settings.profileAccessToken || ''].join(':');
        },
    },
    watch: {
        bookUid() { this.reset(); },
        profileIdentity() { this.reset(); },
        speaker() { this.clearAudio(); this.loadPlan(); },
        mode() { this.clearAudio(); this.chapters = []; this.chapterIndex = 0; this.loadPlan(); },
    },
    mounted() {
        this.pageHideHandler = () => this.savePosition(true);
        window.addEventListener('pagehide', this.pageHideHandler);
    },
    beforeUnmount() {
        this.clearAudio();
        window.removeEventListener('pagehide', this.pageHideHandler);
    },
    deactivated() { this.close(); },
    methods: {
        open() { this.visible = true; this.minimized = false; if (!this.chapters.length) this.loadPlan(); },
        close() { this.clearAudio(); this.visible = false; },
        reset() { this.close(); this.planGeneration++; this.chapters = []; this.chapterIndex = 0; this.estimate = null; this.planLoading = false; },
        formatTime(seconds) {
            seconds = Math.max(1, Math.ceil(seconds));
            if (seconds < 60) return `${seconds} сек`;
            const minutes = Math.ceil(seconds / 60);
            if (minutes < 60) return `${minutes} мин`;
            return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
        },
        positionKey() {
            const settings = this.$store.state.settings || {}, config = this.$store.state.config || {};
            return `inpx.audio.v2:${config.rootPathStatic || '/'}:${settings.currentUserId || config.currentUserId}:${this.bookUid}:${this.speaker}:${this.mode}`;
        },
        async loadPlan() {
            const generation = ++this.planGeneration;
            this.planLoading = true;
            try {
                const result = await this.$root.api.getReaderAudioPlan(this.bookUid, this.mode);
                if (generation !== this.planGeneration) return;
                this.chapters = result.chapters; this.estimate = result.estimate;
                try {
                    const saved = JSON.parse(localStorage.getItem(this.positionKey()) || '{}');
                    if (!this.src && Number.isInteger(saved.chapter) && saved.chapter >= 0 && saved.chapter < this.chapters.length) this.chapterIndex = saved.chapter;
                    if (!this.src && [0.75, 1, 1.25, 1.5, 2].includes(saved.rate)) this.rate = saved.rate;
                } catch { /* Storage is optional. */ }
            } catch (error) { if (generation === this.planGeneration) this.fail(error); }
            finally { if (generation === this.planGeneration) this.planLoading = false; }
        },
        changeChapter() { this.clearAudio(); },
        clearAudio() {
            this.generation++;
            clearTimeout(this.pollTimer);
            clearTimeout(this.nextTimer);
            this.savePosition(true);
            const audio = this.$refs.audio;
            if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
            const preload = this.$refs.preloadAudio;
            if (preload) { preload.removeAttribute('src'); preload.load(); }
            this.releaseMediaSession();
            this.src = ''; this.state = ''; this.error = ''; this.jobId = ''; this.storageKey = '';
            this.nextSrc = ''; this.nextJob = null; this.nextError = ''; this.autoPlay = false;
            this.progress = 0; this.remainingSeconds = null; this.queuePosition = 0; this.phase = '';
        },
        async prepare(preview = false, autoPlay = false) {
            this.clearAudio();
            const generation = this.generation;
            this.isPreview = preview; this.autoPlay = autoPlay;
            this.activeChapter = this.chapterIndex;
            this.storageKey = preview ? '' : this.positionKey();
            this.state = 'requesting';
            try {
                const result = preview ? await this.$root.api.previewReaderVoice(this.speaker)
                    : await this.$root.api.prepareReaderAudio(this.bookUid, this.speaker, this.mode, this.activeChapter);
                if (generation === this.generation) this.acceptStatus(result, generation);
            } catch (error) { if (generation === this.generation) this.fail(error); }
        },
        acceptStatus(result, generation) {
            this.jobId = result.id;
            this.state = result.state;
            this.error = result.error || '';
            this.progress = result.progress || 0; this.remainingSeconds = result.remainingSeconds ?? null; this.queuePosition = result.queuePosition || 0;
            this.phase = result.phase || '';
            if (result.state === 'ready') { this.src = result.url; if (!this.isPreview) this.prefetchNext(generation); return; }
            if (result.state === 'error') return;
            this.pollTimer = setTimeout(() => this.poll(generation), 2000);
        },
        async poll(generation) {
            try {
                const result = await this.$root.api.getReaderAudioStatus(this.jobId);
                if (generation === this.generation) this.acceptStatus(result, generation);
            } catch (error) { if (generation === this.generation) this.fail(error); }
        },
        fail(error) { this.state = 'error'; this.error = error.message || String(error); },
        async prefetchNext(generation) {
            if (this.activeChapter + 1 >= this.chapters.length) return;
            try {
                const next = await this.$root.api.prepareReaderAudio(this.bookUid, this.speaker, this.mode, this.activeChapter + 1);
                if (generation !== this.generation) return;
                this.nextJob = next;
                this.acceptNext(next, generation);
            } catch (error) { if (generation === this.generation) this.nextError = `Следующий фрагмент: ${error.message || error}`; }
        },
        acceptNext(result, generation) {
            this.nextJob = result;
            if (result.state === 'ready') { this.nextSrc = result.url; return; }
            if (result.state === 'error') { this.nextError = `Следующий фрагмент: ${result.error}`; return; }
            this.nextTimer = setTimeout(async() => {
                try {
                    const next = await this.$root.api.getReaderAudioStatus(result.id);
                    if (generation === this.generation) this.acceptNext(next, generation);
                } catch (error) { if (generation === this.generation) this.nextError = `Следующий фрагмент: ${error.message || error}`; }
            }, 2000);
        },
        restorePosition() {
            const audio = this.$refs.audio;
            if (!this.src || !audio) return;
            try {
                const saved = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
                if (saved.chapter === this.activeChapter && !this.isPreview && Number.isFinite(saved.time) && saved.time >= 0 && saved.time < audio.duration)
                    audio.currentTime = saved.time;
            } catch { /* Storage is optional. */ }
            this.applyRate();
            if (this.autoPlay) {
                this.autoPlay = false;
                audio.play().catch(() => { this.error = 'Нажмите ▶ в плеере, чтобы начать воспроизведение.'; });
            }
        },
        savePosition(force) {
            const audio = this.$refs.audio;
            if (!this.storageKey || !this.src || !audio || !Number.isFinite(audio.currentTime)) return;
            if (!force && Date.now() - this.lastSaved < 3000) return;
            this.lastSaved = Date.now();
            try { localStorage.setItem(this.storageKey, JSON.stringify({chapter: this.activeChapter, time: audio.currentTime, rate: this.rate})); }
            catch { /* Storage is optional. */ }
            this.updateMediaPosition();
        },
        applyRate() {
            if (this.$refs.audio) this.$refs.audio.playbackRate = this.rate;
            this.savePosition(true);
        },
        onPlay() {
            if (!('mediaSession' in navigator)) return;
            mediaOwner = this;
            const session = navigator.mediaSession;
            if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({
                title: this.title, artist: this.author, album: 'Silero · INPX Web',
                artwork: this.cover ? [{src: new URL(this.cover, window.location.href).href}] : [],
            });
            const handlers = {
                play: () => this.$refs.audio.play().catch(error => this.fail(error)),
                pause: () => this.$refs.audio.pause(),
                seekbackward: details => this.seek(-Number(details.seekOffset || 15)),
                seekforward: details => this.seek(Number(details.seekOffset || 15)),
                seekto: details => { if (Number.isFinite(details.seekTime)) this.seekTo(details.seekTime); },
                stop: () => this.close(),
            };
            for (const action of mediaActions) {
                try { session.setActionHandler(action, handlers[action]); } catch { /* Unsupported action. */ }
            }
            session.playbackState = 'playing';
            this.updateMediaPosition();
        },
        onPause() {
            this.savePosition(true);
            if (mediaOwner === this && navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
        },
        onEnded() {
            if (this.$refs.audio) this.$refs.audio.currentTime = 0;
            this.savePosition(true);
            if (!this.isPreview && this.activeChapter + 1 < this.chapters.length) {
                this.chapterIndex = this.activeChapter + 1;
                if (this.nextSrc) {
                    clearTimeout(this.nextTimer);
                    const next = this.nextSrc;
                    this.generation++; this.activeChapter = this.chapterIndex;
                    this.nextSrc = ''; this.nextJob = null; this.nextError = ''; this.autoPlay = true; this.src = next;
                    this.prefetchNext(this.generation);
                } else this.prepare(false, true);
            } else { this.releaseMediaSession(); if (this.isPreview) this.loadPlan(); }
        },
        seek(offset) { this.seekTo(this.$refs.audio.currentTime + offset); },
        seekTo(time) {
            const audio = this.$refs.audio;
            if (audio && Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, time));
            this.savePosition(true);
        },
        updateMediaPosition() {
            const audio = this.$refs.audio;
            if (mediaOwner !== this || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
            try { navigator.mediaSession.setPositionState({duration: audio.duration, playbackRate: this.rate, position: Math.min(audio.duration, audio.currentTime)}); }
            catch { /* Unsupported position reporting. */ }
        },
        releaseMediaSession() {
            if (mediaOwner !== this || !navigator.mediaSession) return;
            for (const action of mediaActions) {
                try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Unsupported action. */ }
            }
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = 'none';
            mediaOwner = null;
        },
        onAudioError() {
            if (!this.src) return;
            this.savePosition(true);
            this.releaseMediaSession();
            this.src = '';
            this.fail(new Error('Не удалось загрузить аудио. Повторите подготовку, чтобы обновить ссылку.'));
        },
    },
};
</script>

<style scoped>
.reader-audio {
    position: fixed; z-index: 2100; right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom)); width: min(420px, calc(100vw - 24px));
    color: var(--reader-text, #222); background: var(--reader-bg, #fff);
    border: 1px solid currentColor; border-radius: 12px; box-shadow: 0 4px 24px #0003;
}
.reader-audio-panel { padding: 12px; max-height: calc(100dvh - 24px); overflow-y: auto; }
.reader-audio--minimized { width: auto; max-width: calc(100vw - 24px); }
@media (max-width: 1023.98px) {
    .reader-audio--minimized { top: calc(72px + env(safe-area-inset-top)); bottom: auto; }
}
.reader-audio-header { display: flex; align-items: center; gap: 4px; }
.reader-audio-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-audio-options { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.reader-audio-options label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.reader-audio-options select { color: inherit; background: inherit; border: 1px solid currentColor; border-radius: 4px; padding: 4px; }
.reader-audio-mode { display: grid; gap: 8px; margin: 8px 0; }
.reader-audio-mode label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.reader-audio-mode select { flex: 1; min-width: 0; color: inherit; background: var(--reader-bg); border: 1px solid currentColor; border-radius: 4px; padding: 4px; }
.reader-audio-preview { font-size: 12px; }
.reader-audio progress { width: 100%; accent-color: var(--reader-accent); }
.reader-audio-preload { display: none; }
.reader-audio-hint { font-size: 12px; line-height: 1.5; margin: 8px 0; opacity: .8; }
.reader-audio-error { font-size: 13px; color: #c62828; }
.reader-audio-status { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.reader-audio audio { width: 100%; margin-top: 8px; }
</style>
