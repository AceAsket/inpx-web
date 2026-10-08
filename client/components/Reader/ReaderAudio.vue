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
            <details class="reader-audio-tuning">
                <summary>
                    <i class="la la-sliders-h" aria-hidden="true" />
                    <span>Настроить озвучку</span>
                    <i class="la la-angle-down reader-audio-tuning-arrow" aria-hidden="true" />
                </summary>
                <fieldset :disabled="busy">
                    <label>Высота голоса
                        <select v-model="draftOptions.pitch">
                            <option value="x-low">Очень низкая</option><option value="low">Низкая</option>
                            <option value="medium">Обычная</option><option value="high">Высокая</option><option value="x-high">Очень высокая</option>
                        </select>
                    </label>
                    <label v-for="pause in pauseControls" :key="pause.key">{{ pause.label }}
                        <select v-model="draftOptions[pause.key]">
                            <option :value="null">Автоматически</option>
                            <option v-for="ms in pause.values" :key="ms" :value="ms">{{ ms === 0 ? 'Без дополнительной паузы' : `${ms / 1000} сек` }}</option>
                        </select>
                    </label>
                    <label class="reader-audio-dictionary">Словарь произношения
                        <textarea v-model="draftOptions.dictionary" rows="2" maxlength="10000" placeholder="Гермиона = Герми+она" />
                    </label>
                    <p class="reader-audio-hint">
                        Одна замена на строку. Плюс перед гласной задаёт ударение.
                    </p>
                    <p v-if="tuningError" class="reader-audio-error" role="alert">
                        {{ tuningError }}
                    </p>
                    <div class="reader-audio-tuning-actions">
                        <q-btn no-caps outline label="Применить" :disabled="!tuningDirty || !!tuningError" @click="applyTuning" />
                        <q-btn no-caps flat label="Сбросить" @click="resetTuning" />
                    </div>
                    <p class="reader-audio-hint">
                        Применение остановит текущую запись.
                    </p>
                    <label class="reader-audio-dictionary">Текст пробы
                        <textarea v-model="sampleText" rows="2" maxlength="500" />
                    </label>
                    <p class="reader-audio-hint">
                        До 500 символов. Проба учитывает выбранные настройки.
                    </p>
                </fieldset>
            </details>
            <q-btn v-if="!busy" :disabled="tuningDirty" class="reader-audio-preview" no-caps outline icon="la la-volume-up" label="Послушать пробу" @click="prepare(true, true)" />
            <p v-if="!src && !busy && !error" class="reader-audio-hint">
                {{ mode === 'online' ? 'Начните с первого фрагмента — остальные готовятся по ходу чтения.' : mode === 'chapters' ? 'Выбранная глава готовится первой, затем следующая.' : 'Прослушивание начнётся после подготовки всей книги.' }}
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
            <q-btn v-if="(!src || isPreview) && !busy" class="reader-audio-start" :disabled="planLoading || tuningDirty" no-caps outline icon="la la-headphones" :label="error ? 'Повторить подготовку' : mode === 'book' ? 'Создать аудиокнигу' : 'Подготовить и слушать'" @click="prepare(false)" />
            <audio
                v-show="src" ref="audio" :src="src || undefined" controls preload="metadata"
                @loadedmetadata="restorePosition" @play="onPlay" @pause="onPause"
                @timeupdate="savePosition(false)" @seeked="savePosition(true)" @ended="onEnded" @error="onAudioError"
            />
            <audio ref="preloadAudio" class="reader-audio-preload" :src="nextSrc || undefined" preload="auto" aria-hidden="true" />
            <p v-if="src" class="reader-audio-hint">
                {{ isPreview ? 'Проба голоса' : mode === 'book' ? 'Вся книга' : `${mode === 'online' ? 'Фрагмент' : 'Глава'} ${activeChapter + 1}/${chapters.length} · ${nextSrc ? 'следующий готов' : nextError || (activeChapter + 1 < chapters.length ? 'следующий готовится…' : 'конец книги')}` }}
            </p>
        </div>
        <q-btn v-show="minimized" no-caps icon="la la-headphones" :label="busy ? 'Готовим озвучку…' : 'Озвучка'" @click="minimized = false" />
    </aside>
</template>

<script>
const {defaultSpeechOptions, normalizeSpeechOptions, hasSpeechOptions} = require('../../../shared/speechOptions');
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
            speechOptions: defaultSpeechOptions(), draftOptions: defaultSpeechOptions(), loadedTuningKey: '', engineId: '',
            sampleText: 'Гермиона открыла книгу и устроилась поудобнее. За окном тихо шумел дождь.\n\nКаждая новая история — это путешествие. Послушайте мой голос и выберите удобную скорость чтения.',
            pauseControls: [
                {key: 'sentencePauseMs', label: 'Между предложениями', values: [0, 150, 300, 500, 1000, 2000]},
                {key: 'paragraphPauseMs', label: 'Между абзацами', values: [0, 300, 500, 1000, 2000, 3000, 5000]},
                {key: 'chapterPauseMs', label: 'Между главами', values: [0, 500, 1000, 2000, 3000, 5000, 10000]},
            ],
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
        tuningError() { try { normalizeSpeechOptions(this.draftOptions); return ''; } catch (error) { return error.message; } },
        tuningDirty() { try { return JSON.stringify(normalizeSpeechOptions(this.draftOptions)) !== JSON.stringify(this.speechOptions); } catch { return true; } },
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
        open() { this.loadTuning(); this.visible = true; this.minimized = false; if (!this.chapters.length) this.loadPlan(); },
        close() { this.clearAudio(); this.visible = false; },
        reset() { this.close(); this.planGeneration++; this.chapters = []; this.chapterIndex = 0; this.estimate = null; this.planLoading = false; this.loadedTuningKey = ''; },
        tuningKey() {
            const settings = this.$store.state.settings || {}, config = this.$store.state.config || {};
            return `inpx.speech-options.v1:${config.rootPathStatic || '/'}:${settings.currentUserId || config.currentUserId}:${this.bookUid}`;
        },
        loadTuning() {
            const key = this.tuningKey();
            if (this.loadedTuningKey === key) return;
            this.speechOptions = defaultSpeechOptions();
            try { this.speechOptions = normalizeSpeechOptions(JSON.parse(localStorage.getItem(key) || '{}')); } catch { /* Storage is optional. */ }
            this.draftOptions = {...this.speechOptions}; this.loadedTuningKey = key;
        },
        applyTuning() {
            let options;
            try { options = normalizeSpeechOptions(this.draftOptions); } catch (error) { this.fail(error); return; }
            this.clearAudio(); this.speechOptions = options; this.draftOptions = {...options};
            try { localStorage.setItem(this.tuningKey(), JSON.stringify(options)); } catch { /* Storage is optional. */ }
            this.loadPlan();
        },
        resetTuning() { this.draftOptions = defaultSpeechOptions(); this.applyTuning(); },
        formatTime(seconds) {
            seconds = Math.max(1, Math.ceil(seconds));
            if (seconds < 60) return `${seconds} сек`;
            const minutes = Math.ceil(seconds / 60);
            if (minutes < 60) return `${minutes} мин`;
            return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
        },
        positionKey() {
            const settings = this.$store.state.settings || {}, config = this.$store.state.config || {};
            const key = `inpx.audio.v2:${config.rootPathStatic || '/'}:${settings.currentUserId || config.currentUserId}:${this.bookUid}:${this.speaker}:${this.mode}`;
            const engineKey = this.engineId ? `${key}:engine-v1:${this.engineId}` : key;
            return hasSpeechOptions(this.speechOptions) ? `${engineKey}:speech-v1:${JSON.stringify(this.speechOptions)}` : engineKey;
        },
        async loadPlan() {
            const generation = ++this.planGeneration;
            this.planLoading = true;
            try {
                const result = await this.$root.api.getReaderAudioPlan(this.bookUid, this.mode);
                if (generation !== this.planGeneration) return;
                this.chapters = result.chapters; this.estimate = result.estimate;
                this.engineId = result.engineId || '';
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
                const result = preview ? await this.$root.api.previewReaderVoice(this.speaker, this.speechOptions, this.sampleText)
                    : await this.$root.api.prepareReaderAudio(this.bookUid, this.speaker, this.mode, this.activeChapter, this.speechOptions);
                if (generation === this.generation) this.acceptStatus(result, generation);
            } catch (error) { if (generation === this.generation) this.fail(error); }
        },
        acceptStatus(result, generation) {
            if (typeof result.engineId === 'string' && result.engineId !== this.engineId) {
                this.engineId = result.engineId;
                if (!this.isPreview) this.storageKey = this.positionKey();
            }
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
                const next = await this.$root.api.prepareReaderAudio(this.bookUid, this.speaker, this.mode, this.activeChapter + 1, this.speechOptions);
                if (generation !== this.generation) return;
                this.nextJob = next;
                this.acceptNext(next, generation);
            } catch (error) { if (generation === this.generation) this.nextError = `Следующий фрагмент: ${error.message || error}`; }
        },
        acceptNext(result, generation) {
            this.nextJob = result;
            if (typeof result.engineId === 'string' && result.engineId !== this.engineId) {
                this.nextError = 'Способ расстановки ударений изменился. Откройте плеер заново.';
                return;
            }
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
                if (typeof this.nextJob?.engineId === 'string' && this.nextJob.engineId !== this.engineId) {
                    this.clearAudio();
                    this.fail(new Error('Способ расстановки ударений изменился. Повторите подготовку аудио.'));
                    return;
                }
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
    color: var(--reader-text, #222); background: var(--reader-surface, #fff);
    border: 1px solid var(--reader-border, currentColor); border-radius: 12px; box-shadow: 0 4px 24px #0003;
}
.reader-audio-panel { padding: 12px; max-height: calc(100dvh - 24px); overflow-y: auto; }
.reader-audio--minimized { width: auto; max-width: calc(100vw - 24px); }
@media (max-width: 1023.98px) {
    .reader-audio--minimized { top: calc(72px + env(safe-area-inset-top)); bottom: auto; }
}
.reader-audio-header { display: flex; align-items: center; gap: 4px; }
.reader-audio-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-audio-options { display: grid; grid-template-columns: minmax(0, 1fr) 100px; gap: 10px; margin: 12px 0; }
.reader-audio-options label { display: grid; gap: 4px; font-size: 12px; color: var(--reader-muted, inherit); }
.reader-audio-options select { width: 100%; min-width: 0; }
.reader-audio-mode { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 8px 0; }
.reader-audio-mode label { display: grid; grid-template-columns: 68px minmax(0, 1fr); align-items: center; gap: 8px; font-size: 13px; }
.reader-audio-mode select { width: 100%; min-width: 0; }
.reader-audio-preview, .reader-audio-start { width: 100%; min-height: 40px; font-size: 13px; }
.reader-audio-preview { margin-top: 4px; }
.reader-audio-start { background: var(--reader-accent-soft); font-weight: 600; }
.reader-audio-tuning { margin: 8px 0; font-size: 13px; }
.reader-audio-tuning summary {
    display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px;
    box-sizing: border-box; border: 1px solid var(--reader-border, currentColor); border-radius: 8px;
    background: var(--reader-surface-2, inherit); font-weight: 600; cursor: pointer; list-style: none;
}
.reader-audio-tuning summary::-webkit-details-marker { display: none; }
.reader-audio-tuning summary:hover { border-color: var(--reader-accent, currentColor); }
.reader-audio-tuning summary:focus-visible { outline: 2px solid var(--reader-accent, currentColor); outline-offset: 2px; }
.reader-audio-tuning summary i { font-size: 18px; }
.reader-audio-tuning-arrow { margin-left: auto; }
.reader-audio-tuning[open] .reader-audio-tuning-arrow { transform: rotate(180deg); }
.reader-audio-tuning fieldset { border: 0; padding: 12px 0 4px; margin: 0; display: grid; gap: 8px; min-width: 0; }
.reader-audio-tuning label { display: grid; grid-template-columns: minmax(0, 1fr) minmax(112px, 148px); align-items: center; gap: 8px; }
.reader-audio-tuning select { width: 100%; min-width: 0; }
.reader-audio-options select, .reader-audio-mode select, .reader-audio-tuning select, .reader-audio-tuning textarea {
    box-sizing: border-box;
    color: var(--reader-text, inherit); background: var(--reader-surface, inherit);
    border: 1px solid var(--reader-border, currentColor); border-radius: 6px; padding: 7px 8px; min-height: 38px;
}
.reader-audio select:focus-visible, .reader-audio textarea:focus-visible { outline: 2px solid var(--reader-accent, currentColor); outline-offset: 1px; }
.reader-audio-tuning .reader-audio-dictionary { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.reader-audio-tuning textarea { width: 100%; resize: vertical; box-sizing: border-box; }
.reader-audio-tuning-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.reader-audio-tuning fieldset .reader-audio-hint { margin: 0; }
.reader-audio progress { width: 100%; accent-color: var(--reader-accent); }
.reader-audio-preload { display: none; }
.reader-audio-hint { font-size: 12px; line-height: 1.5; margin: 8px 0; opacity: .8; }
.reader-audio-error { font-size: 13px; color: #c62828; }
.reader-audio-status { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.reader-audio audio { width: 100%; margin-top: 8px; }
</style>
