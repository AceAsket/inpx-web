<template>
    <aside v-if="visible" class="browser-speech" aria-label="Озвучка голосами устройства" @keydown.stop>
        <button v-if="minimized" type="button" class="browser-speech-mini" @click="minimized = false">
            <i class="la la-volume-up" aria-hidden="true" /> Озвучка · {{ status === 'speaking' ? 'Читаем' : 'Пауза' }}
        </button>
        <template v-else>
            <div class="browser-speech-header">
                <strong>{{ title || 'Озвучка книги' }}</strong>
                <q-btn flat dense round icon="la la-minus" aria-label="Свернуть озвучку" @click="minimized = true" />
                <q-btn flat dense round icon="la la-times" aria-label="Закрыть озвучку устройства" @click="close" />
            </div>
            <div class="browser-speech-fields">
                <label class="browser-speech-voice">Голос устройства
                    <select v-model="voiceId" @change="applySettings">
                        <option value="">Автоматически · {{ language || 'язык книги' }}</option>
                        <option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.label }}</option>
                    </select>
                </label>
                <label>Скорость
                    <select v-model.number="rate" @change="applySettings">
                        <option v-for="value in [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]" :key="value" :value="value">{{ value }}×</option>
                    </select>
                </label>
                <label>Тон
                    <select v-model.number="pitch" @change="applySettings">
                        <option v-for="item in pitches" :key="item.value" :value="item.value">{{ item.label }}</option>
                    </select>
                </label>
            </div>
            <div class="browser-speech-actions">
                <q-btn outline no-caps icon="la la-volume-up" label="Проба" @click="sample" />
                <q-btn outline no-caps label="Слушать отсюда" :disable="!parts.length" @click="$emit('listen-here')" />
                <q-btn v-if="sileroEnabled" flat no-caps label="Silero · MP3" @click="$emit('use-silero')" />
            </div>
            <div class="browser-speech-playback">
                <q-btn flat round icon="la la-step-backward" aria-label="Предыдущая фраза" :disable="!parts.length || index === 0" @click="seek(-1)" />
                <q-btn
                    unelevated no-caps :icon="status === 'speaking' ? 'la la-pause' : 'la la-play'"
                    :label="status === 'speaking' ? 'Пауза' : index > 0 && status !== 'ended' ? 'Продолжить' : 'Слушать'"
                    :disable="!parts.length" @click="toggle"
                />
                <q-btn flat round icon="la la-step-forward" aria-label="Следующая фраза" :disable="!parts.length || index >= parts.length - 1" @click="seek(1)" />
                <label>Таймер сна
                    <select v-model.number="sleepMinutes" @change="armSleep">
                        <option :value="0">Выключен</option><option :value="15">15 мин</option>
                        <option :value="30">30 мин</option><option :value="60">60 мин</option>
                    </select>
                </label>
            </div>
            <p v-if="parts.length" class="browser-speech-position" role="status">
                {{ preview ? 'Проба голоса' : status === 'ended' ? 'Книга озвучена' : `Фраза ${Math.min(index + 1, parts.length)} из ${parts.length}` }}
            </p>
            <p v-if="error" class="browser-speech-error" role="alert">
                {{ error }}
            </p>
            <p class="browser-speech-hint">
                Без сети работают установленные локальные голоса. При сворачивании или блокировке экрана озвучка ставится на паузу. После паузы текущая фраза повторяется.
            </p>
        </template>
    </aside>
</template>

<script>
const {BrowserSpeech, partsFromHtml, supported} = require('./browserSpeech');
const settingsKey = 'inpx.browserSpeech.settings.v1';

export default {
    props: {
        html: {type: String, default: ''}, sourceKey: {type: String, required: true},
        scopeKey: {type: String, default: ''}, title: {type: String, default: ''},
        language: {type: String, default: 'ru'}, sileroEnabled: {type: Boolean, default: false},
    },
    emits: ['listen-here', 'use-silero'],
    data: () => ({visible: false, minimized: false, voices: [], voiceId: '', rate: 1, pitch: 1,
        status: 'idle', index: 0, preview: false, parts: [], error: '', sleepMinutes: 0,
        pitches: [{value: 0.75, label: 'Низкий'}, {value: 1, label: 'Обычный'}, {value: 1.25, label: 'Высокий'}]}),
    watch: {sourceKey() { this.reset(); }, scopeKey() { this.reset(); }, html() { this.reset(); }},
    mounted() {
        this.voicesChanged = () => this.loadVoices();
        window.speechSynthesis?.addEventListener('voiceschanged', this.voicesChanged);
        this.visibilityChanged = () => {
            if (document.hidden && this.status === 'speaking') this.speech?.pause();
            this.checkSleep();
        };
        this.pageHidden = () => this.close();
        document.addEventListener('visibilitychange', this.visibilityChanged);
        window.addEventListener('pagehide', this.pageHidden);
    },
    deactivated() { this.close(); },
    beforeUnmount() {
        this.close();
        window.speechSynthesis?.removeEventListener('voiceschanged', this.voicesChanged);
        document.removeEventListener('visibilitychange', this.visibilityChanged);
        window.removeEventListener('pagehide', this.pageHidden);
    },
    methods: {
        storageKey() { return `inpx.browserSpeech.position.v1:${JSON.stringify([this.scopeKey, this.sourceKey])}`; },
        loadVoices() {
            this.voices = (window.speechSynthesis?.getVoices() || []).map(voice => ({id: voice.voiceURI,
                label: `${voice.name} · ${voice.lang}${voice.localService ? ' · локальный' : ' · сеть'}`}));
        },
        open() {
            this.visible = true; this.minimized = false; this.error = '';
            if (!supported(window)) { this.error = 'Этот браузер не поддерживает системную озвучку.'; return; }
            this.loadVoices();
            if (this.speech) return;
            try {
                const settings = JSON.parse(localStorage.getItem(settingsKey) || '{}');
                this.voiceId = String(settings.voiceId || '');
                this.rate = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(settings.rate) ? settings.rate : 1;
                this.pitch = [0.75, 1, 1.25].includes(settings.pitch) ? settings.pitch : 1;
            } catch { /* Storage can be disabled. */ }
            this.parts = partsFromHtml(this.html);
            this.loadedStorageKey = this.storageKey();
            this.speech = new BrowserSpeech({synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance,
                onChange: state => {
                    Object.assign(this, state);
                    if (!state.preview) this.savePosition();
                }});
            let index = 0;
            try {
                const saved = JSON.parse(localStorage.getItem(this.loadedStorageKey) || '{}');
                if (Number.isInteger(saved.index) && this.parts[saved.index]?.text === saved.text) index = saved.index;
            } catch { /* A changed book starts at its beginning. */ }
            this.speech.setParts(this.parts, index);
            this.applySettings();
            if (!this.parts.length) this.error = 'В книге нет текста для озвучки.';
        },
        savePosition() {
            if (!this.loadedStorageKey || !this.parts.length) return;
            try { localStorage.setItem(this.loadedStorageKey, JSON.stringify({index: this.index, text: this.parts[this.index]?.text || ''})); }
            catch { /* Playback still works without storage. */ }
        },
        applySettings() {
            const playing = this.speech?.status === 'speaking' && !this.speech.preview;
            if (this.speech?.status === 'speaking') this.speech.pause();
            if (this.speech) Object.assign(this.speech, {voiceId: this.voiceId, rate: this.rate, pitch: this.pitch, lang: this.language});
            try { localStorage.setItem(settingsKey, JSON.stringify({voiceId: this.voiceId, rate: this.rate, pitch: this.pitch})); }
            catch { /* Storage can be disabled. */ }
            if (playing) this.speech.play();
        },
        toggle() { if (this.status === 'speaking') this.speech.pause(); else { this.checkSleep(); this.speech.play(); } },
        sample() { this.speech?.sample(); },
        seek(delta) { this.speech?.seek(this.index + delta); },
        openAt(anchor) { this.open(); try { this.speech?.locate(anchor); this.speech?.play(); } catch (error) { this.error = error.message; } },
        armSleep() {
            clearInterval(this.sleepInterval);
            this.sleepDeadline = this.sleepMinutes ? Date.now() + this.sleepMinutes * 60000 : 0;
            if (this.sleepDeadline) this.sleepInterval = setInterval(() => this.checkSleep(), 1000);
        },
        checkSleep() {
            if (!this.sleepDeadline || Date.now() < this.sleepDeadline) return;
            this.speech?.pause(); this.sleepMinutes = 0; this.armSleep();
        },
        close() {
            this.speech?.stop(); this.visible = false; this.sleepMinutes = 0; this.armSleep();
        },
        reset() { this.close(); this.speech = null; this.parts = []; this.loadedStorageKey = ''; },
    },
};
</script>

<style scoped>
.browser-speech {
    position: fixed;
    z-index: 2200;
    right: 16px;
    top: 76px;
    width: min(440px,calc(100vw - 32px));
    max-height: calc(100vh - 104px);
    max-height: calc(100dvh - 104px);
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--reader-border, #777);
    border-radius: 16px;
    background: var(--reader-surface, #faf7ef);
    color: var(--reader-text, #332a20);
    box-shadow: 0 12px 36px #0003;
}

.browser-speech-header {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
}

.browser-speech-header strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.browser-speech-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}

.browser-speech-voice {
    grid-column: 1/-1;
}

.browser-speech label {
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: 13px;
}

.browser-speech select {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 6px 10px;
    border: 1px solid var(--reader-border, #777);
    border-radius: 8px;
    background: var(--reader-surface, #faf7ef);
    color: inherit;
    font: inherit;
}

.browser-speech-actions,.browser-speech-playback {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
}

.browser-speech-playback label {
    flex: 1;
    min-width: 100px;
}

.browser-speech-playback .q-btn--unelevated {
    background: var(--reader-accent, #a36f42);
    color: var(--reader-bg, #fff);
}

.browser-speech-hint,.browser-speech-position {
    font-size: 12px;
    line-height: 1.5;
    margin: 12px 0 0;
}

.browser-speech-hint {
    opacity: .8;
}

.browser-speech-error {
    color: #c33;
    margin: 12px 0 0;
}

.browser-speech-mini {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
}

@media (max-width:600px) {
    .browser-speech {
        top: 68px;
        right: 8px;
        width: calc(100vw - 16px);
        padding: 12px;
        max-height: calc(100vh - 84px);
        max-height: calc(100dvh - 84px);
    }
}
</style>
