const {key, locate} = require('../../../shared/SpeechAnchor');

function supported(host = typeof window === 'undefined' ? {} : window) {
    return !!(host.speechSynthesis && typeof host.SpeechSynthesisUtterance === 'function');
}

function phrases(text, max = 220) {
    const result = [];
    const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[\s\S]*?[.!?…](?:\s+|$)|[\s\S]+$/g) || [];
    for (const sentence of sentences) {
        let rest = sentence.trim();
        while (rest.length > max) {
            let end = rest.lastIndexOf(' ', max);
            if (end < max / 2) end = max;
            if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
            result.push(rest.slice(0, end).trim());
            rest = rest.slice(end).trim();
        }
        if (rest) result.push(rest);
    }
    return result.filter(text => /[\p{L}\p{N}]/u.test(text));
}

// Use the complete, inert reading document, never just the currently rendered page.
// Notes, their numeric links and the annotation are outside the spoken book.
function partsFromHtml(html, doc = document) {
    const template = doc.createElement('template');
    template.innerHTML = html;
    const root = template.content;
    for (const node of root.querySelectorAll('.reader-notes,.reader-note-link,script,style,img,svg')) node.remove();
    const selector = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,.reader-epigraph-author,.reader-opening-title';
    const nodes = Array.from(root.querySelectorAll(selector)).filter(node => !node.querySelector(selector));
    const parts = [];
    let offset = 0;
    for (const node of nodes) {
        for (const text of phrases(node.textContent)) {
            parts.push({text, anchor: {textSnippet: text.slice(0, 180), sourceOffset: offset,
                sectionId: node.closest('.reader-section-block')?.id || ''}});
            offset += key(text).length;
        }
    }
    return parts;
}

class BrowserSpeech {
    constructor({synth, Utterance, onChange = () => {}}) {
        this.synth = synth;
        this.Utterance = Utterance;
        this.onChange = onChange;
        this.parts = [];
        this.index = 0;
        this.status = 'idle';
        this.generation = 0;
        this.voiceId = '';
        this.lang = 'ru';
        this.rate = 1;
        this.pitch = 1;
        this.preview = false;
        this.utterance = null;
    }

    notify(error = '') {
        this.onChange({status: this.status, index: this.index, preview: this.preview, error});
    }

    cancel() {
        this.generation++;
        if (this.utterance) {
            this.utterance = null;
            this.synth.cancel();
        }
    }

    setParts(parts, index = 0) {
        this.cancel();
        this.parts = parts;
        this.index = Math.max(0, Math.min(parts.length - 1, Number(index) || 0));
        this.preview = false;
        this.status = 'idle';
        this.notify();
    }

    play() {
        this.cancel();
        this.preview = false;
        if (this.index >= this.parts.length) this.index = 0;
        this.speak(this.parts[this.index]?.text || '');
    }

    speak(text) {
        if (!text) { this.status = 'idle'; this.notify('В книге нет текста для озвучки.'); return; }
        const generation = ++this.generation;
        const utterance = new this.Utterance(text);
        const voice = this.synth.getVoices().find(item => item.voiceURI === this.voiceId);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || this.lang || 'ru';
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        this.utterance = utterance;
        utterance.onend = () => {
            if (generation !== this.generation) return;
            this.utterance = null;
            if (this.preview) { this.preview = false; this.status = 'paused'; this.notify(); return; }
            this.index++;
            if (this.index < this.parts.length) this.speak(this.parts[this.index].text);
            else { this.status = 'ended'; this.notify(); }
        };
        utterance.onerror = event => {
            if (generation !== this.generation) return;
            this.utterance = null;
            this.status = 'paused';
            this.preview = false;
            this.notify(event.error === 'not-allowed' ? 'Браузер запретил озвучку. Нажмите «Продолжить».'
                : 'Не удалось озвучить текст. Проверьте голос и его доступность без сети.');
        };
        this.status = 'speaking';
        this.notify();
        try { this.synth.speak(utterance); }
        catch { utterance.onerror({error: 'synthesis-failed'}); }
    }

    pause() {
        this.cancel();
        this.preview = false;
        this.status = 'paused';
        this.notify();
    }

    stop() {
        this.cancel();
        this.preview = false;
        this.status = 'idle';
        this.notify();
    }

    seek(index) {
        const playing = this.status === 'speaking' && !this.preview;
        this.pause();
        this.index = Math.max(0, Math.min(this.parts.length - 1, index));
        if (playing) this.play();
        else this.notify();
    }

    locate(anchor) { this.seek(locate(this.parts, anchor)); }

    sample() {
        this.cancel();
        this.preview = true;
        this.speak('Так звучит выбранный голос. Выберите удобную скорость и продолжайте чтение.');
    }
}

module.exports = {supported, phrases, partsFromHtml, BrowserSpeech};
