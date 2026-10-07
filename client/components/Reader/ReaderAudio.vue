<template>
    <aside v-show="visible" class="reader-audio" aria-label="Озвучка книги">
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
            <p v-if="!src && !busy && !error" class="reader-audio-hint">
                Silero подготовит всю книгу в MP3. Первая подготовка может занять долгое время; готовая запись сохранится в кэше.
            </p>
            <div v-if="busy" class="reader-audio-status" role="status">
                <q-spinner size="20px" /> {{ state === 'queued' ? 'Книга в очереди…' : 'Готовим аудиокнигу…' }}
            </div>
            <p v-if="error" class="reader-audio-error" role="alert">
                {{ error }}
            </p>
            <q-btn v-if="!src && !busy" no-caps outline icon="la la-headphones" :label="error ? 'Повторить подготовку' : 'Подготовить озвучку'" @click="prepare" />
            <audio
                v-show="src" ref="audio" :src="src || undefined" controls preload="metadata"
                @loadedmetadata="restorePosition" @play="onPlay" @pause="onPause"
                @timeupdate="savePosition(false)" @seeked="savePosition(true)" @ended="onEnded" @error="onAudioError"
            />
            <p v-if="src" class="reader-audio-hint">
                Нажмите ▶, чтобы слушать. Можно свернуть плеер и выключить экран.
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
            visible: false, minimized: false, speaker: 'xenia', rate: 1,
            state: '', src: '', error: '', jobId: '', generation: 0,
            pollTimer: null, storageKey: '', lastSaved: 0, pageHideHandler: null,
            voices: [
                {id: 'xenia', name: 'Ксения (Xenia)'}, {id: 'kseniya', name: 'Ксения (Kseniya)'},
                {id: 'baya', name: 'Бая'}, {id: 'aidar', name: 'Айдар'}, {id: 'eugene', name: 'Евгений'},
            ],
        };
    },
    computed: {
        busy() { return this.state === 'queued' || this.state === 'generating' || this.state === 'requesting'; },
        profileIdentity() {
            const config = this.$store.state.config || {};
            const settings = this.$store.state.settings || {};
            return [settings.currentUserId || config.currentUserId || '', config.profileAuthorized, settings.profileAccessToken || ''].join(':');
        },
    },
    watch: {
        bookUid() { this.close(); },
        profileIdentity() { this.close(); },
        speaker() { this.clearAudio(); },
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
        open() { this.visible = true; this.minimized = false; },
        close() { this.clearAudio(); this.visible = false; },
        clearAudio() {
            this.generation++;
            clearTimeout(this.pollTimer);
            this.savePosition(true);
            const audio = this.$refs.audio;
            if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
            this.releaseMediaSession();
            this.src = ''; this.state = ''; this.error = ''; this.jobId = ''; this.storageKey = '';
        },
        async prepare() {
            this.clearAudio();
            const generation = this.generation;
            const settings = this.$store.state.settings || {};
            const config = this.$store.state.config || {};
            this.storageKey = `inpx.audio.v1:${config.rootPathStatic || '/'}:${settings.currentUserId || config.currentUserId}:${this.bookUid}:${this.speaker}`;
            this.state = 'requesting';
            try {
                const result = await this.$root.api.prepareReaderAudio(this.bookUid, this.speaker);
                if (generation === this.generation) this.acceptStatus(result, generation);
            } catch (error) { if (generation === this.generation) this.fail(error); }
        },
        acceptStatus(result, generation) {
            this.jobId = result.id;
            this.state = result.state;
            this.error = result.error || '';
            if (result.state === 'ready') { this.src = result.url; return; }
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
        restorePosition() {
            const audio = this.$refs.audio;
            if (!this.src || !audio) return;
            try {
                const saved = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
                if (Number.isFinite(saved.time) && saved.time >= 0 && saved.time < audio.duration)
                    audio.currentTime = saved.time;
                if ([0.75, 1, 1.25, 1.5, 2].includes(saved.rate)) this.rate = saved.rate;
            } catch { /* Storage is optional. */ }
            this.applyRate();
        },
        savePosition(force) {
            const audio = this.$refs.audio;
            if (!this.storageKey || !this.src || !audio || !Number.isFinite(audio.currentTime)) return;
            if (!force && Date.now() - this.lastSaved < 3000) return;
            this.lastSaved = Date.now();
            try { localStorage.setItem(this.storageKey, JSON.stringify({time: audio.currentTime, rate: this.rate})); }
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
            this.releaseMediaSession();
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
.reader-audio-panel { padding: 12px; }
.reader-audio-header { display: flex; align-items: center; gap: 4px; }
.reader-audio-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-audio-options { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.reader-audio-options label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.reader-audio-options select { color: inherit; background: inherit; border: 1px solid currentColor; border-radius: 4px; padding: 4px; }
.reader-audio-hint { font-size: 12px; line-height: 1.5; margin: 8px 0; opacity: .8; }
.reader-audio-error { font-size: 13px; color: #c62828; }
.reader-audio-status { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.reader-audio audio { width: 100%; margin-top: 8px; }
</style>
