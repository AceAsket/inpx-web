const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const {pipeline} = require('stream/promises');
const {Transform} = require('stream');
const Fb2Parser = require('./fb2/Fb2Parser');
const he = require('he');

const speakers = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'];
const maxTextLength = 3000000;
const tokenLifetime = 24 * 60 * 60 * 1000;
const chapterLimit = 6000;
const voiceSample = 'Откройте книгу и устройтесь поудобнее. За окном тихо шумел дождь, а в комнате было тепло и спокойно. Каждая новая история — это путешествие. Послушайте мой голос и выберите удобную скорость чтения.';

function splitSpeechText(text, limit = chapterLimit) {
    const parts = [];
    while (text.length > limit) {
        const prefix = text.slice(0, limit);
        let cut = prefix.lastIndexOf('\n\n');
        if (cut < limit / 2) {
            const ends = [...prefix.matchAll(/[.!?…](?:["»])?\s+/g)];
            cut = ends.length ? ends[ends.length - 1].index + ends[ends.length - 1][0].length : prefix.lastIndexOf(' ');
        }
        if (cut < 1) cut = limit;
        // Avoid splitting a UTF-16 surrogate pair in unusual book text.
        if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
        parts.push(text.slice(0, cut).trim());
        text = text.slice(cut).trim();
    }
    if (text) parts.push(text);
    return parts;
}

function extractSpeechChapters(rawNodes, limit = chapterLimit) {
    // Keep the whole-book validation and exclusion rules shared with extraction.
    extractSpeechText(rawNodes);
    const parser = new Fb2Parser(rawNodes);
    const units = [];
    function extract(nodes) {
        return extractSpeechText([[1, 'FictionBook', [], [[1, 'body', [], nodes]]]]);
    }
    function walk(nodes, inheritedTitle = '') {
        let buffered = [];
        const titleNode = nodes.find(node => node[0] === 1 && node[1] === 'title');
        let title = inheritedTitle;
        if (titleNode) {
            try { title = extract([titleNode]).replace(/\s+/g, ' ').trim(); } catch { /* Empty title. */ }
        }
        const flush = () => {
            if (!buffered.length) return;
            try { units.push({title, text: extract(buffered), headingOnly: buffered.every(node => node[0] !== 1 || ['title', 'image', 'empty-line'].includes(node[1]))}); }
            catch (error) { if (!error.message.includes('нет текста')) throw error; }
            buffered = [];
        };
        for (const node of nodes) {
            if (node[0] === 1 && node[1] === 'section') { flush(); walk(node[3] || [], title); }
            else buffered.push(node);
        }
        flush();
    }
    for (const body of parser.$$array('/body')) {
        const node = body.rawNodes[0];
        if (String(new Map(node[2] || []).get('name') || '').toLowerCase() !== 'notes') walk(node[3] || []);
    }
    const chapters = [];
    let heading = '';
    for (const unit of units) {
        if (unit.headingOnly) { heading += `${unit.text}\n\n`; continue; }
        const parts = splitSpeechText(heading + unit.text, limit);
        heading = '';
        const title = unit.title || `Глава ${chapters.length + 1}`;
        for (const [part, text] of parts.entries()) chapters.push({
            index: chapters.length, title: parts.length > 1 ? `${title} · часть ${part + 1}/${parts.length}` : title, text,
        });
    }
    if (heading.trim()) {
        for (const text of splitSpeechText(heading.trim(), limit)) chapters.push({index: chapters.length, title: 'Заключение', text});
    }
    return chapters;
}

// Extract prose from FB2, without the description, binaries or footnote bodies.
function extractSpeechText(rawNodes) {
    const parser = new Fb2Parser(rawNodes);
    const paragraphs = [];
    function text(nodes) {
        return (nodes || []).map(node => {
            if (node[0] === 2) return he.decode(String(node[1] || ''));
            if (node[0] === 3) return String(node[1] || '');
            if (node[0] !== 1) return '';
            if (node[1] === 'a' && new Map(node[2] || []).get('type') === 'note') return '';
            if (node[1] === 'image' || node[1] === 'binary') return '';
            return text(node[3]);
        }).join('');
    }
    function walk(nodes) {
        for (const node of nodes || []) {
            if (node[0] !== 1) continue;
            if (['p', 'v', 'subtitle', 'text-author'].includes(node[1])) {
                const value = text(node[3]).replace(/\s+/g, ' ').trim();
                if (value) paragraphs.push(value);
            } else if (!['image', 'binary'].includes(node[1])) walk(node[3]);
        }
    }
    for (const body of parser.$$array('/body')) {
        const attrs = new Map(body.rawNodes[0][2] || []);
        if (String(attrs.get('name') || '').toLowerCase() !== 'notes') walk(body.rawNodes[0][3]);
    }
    const result = paragraphs.join('\n\n');
    if (!result) throw new Error('В книге нет текста для озвучки. Поддерживается FB2.');
    if (result.length > maxTextLength) throw new Error('Текст книги слишком большой для озвучки (лимит 3 млн символов).');
    return result;
}

class ReaderSpeech {
    constructor(config, transport = axios) {
        this.config = config;
        this.transport = transport;
        this.jobs = new Map();
        this.pending = new Map();
        this.queue = [];
        this.running = false;
        this.secret = crypto.randomBytes(32);
        this.directory = path.resolve(config.dataDir, 'speech');
    }

    get enabled() { return Boolean(this.config.ttsEnabled && this.config.ttsUrl); }
    get cacheLimit() { return Math.max(64, Number(this.config.ttsCacheSizeMb) || 4096) * 1024 * 1024; }

    async prepare(userId, bookUid, bookInfo, speaker = 'xenia') {
        if (!this.enabled) throw new Error('Серверная озвучка не настроена.');
        if (!speakers.includes(speaker)) throw new Error('Неизвестный голос Silero.');
        if (!bookInfo || !bookInfo.fb2) throw new Error('Озвучка доступна для книг FB2.');
        const text = extractSpeechText(bookInfo.fb2);
        return this.prepareText(userId, bookUid, text, speaker);
    }

    parts(bookInfo, mode = 'chapters') {
        if (!this.enabled) throw new Error('Серверная озвучка не настроена.');
        if (!bookInfo || !bookInfo.fb2) throw new Error('Озвучка доступна для книг FB2.');
        if (mode === 'book') return [{index: 0, title: 'Вся книга', text: extractSpeechText(bookInfo.fb2)}];
        if (!['online', 'chapters'].includes(mode)) throw new Error('Неизвестный режим озвучки.');
        return extractSpeechChapters(bookInfo.fb2, mode === 'online' ? 700 : chapterLimit);
    }

    async plan(bookInfo, mode) {
        const chapters = this.parts(bookInfo, mode).map(({index, title, text}) => ({index, title, characters: text.length}));
        const characters = chapters.reduce((sum, part) => sum + part.characters, 0);
        let estimate;
        try {
            const response = await this.transport.get(`${this.config.ttsUrl.replace(/\/$/, '')}/estimate`, {
                timeout: 5000, maxRedirects: 0,
                headers: this.config.ttsApiKey ? {'Authorization': `Bearer ${this.config.ttsApiKey}`} : {},
            });
            const data = response.data || {};
            if (Number.isFinite(Number(data.charactersPerSecond)) && Number(data.charactersPerSecond) > 0) estimate = {
                charactersPerSecond: Number(data.charactersPerSecond), warmupSeconds: Math.max(0, Number(data.warmupSeconds) || 0),
                measured: data.measured === true,
            };
        } catch { /* Older/offline services cannot estimate; preparation reports the actual error. */ }
        const queuedCharacters = Array.from(this.jobs.values()).filter(job => ['queued', 'generating'].includes(job.state))
            .reduce((sum, job) => sum + Math.max(0, job.characters - (job.processedCharacters || 0)), 0);
        return {chapters, characters, estimate: estimate ? {
            charactersPerSecond: estimate.charactersPerSecond, warmupSeconds: estimate.warmupSeconds,
            firstSeconds: Math.ceil(chapters[0].characters / estimate.charactersPerSecond + estimate.warmupSeconds),
            totalSeconds: Math.ceil(characters / estimate.charactersPerSecond + estimate.warmupSeconds),
            queueSeconds: Math.ceil(queuedCharacters / estimate.charactersPerSecond), measured: estimate.measured,
        } : null};
    }

    async preparePart(userId, bookUid, bookInfo, speaker, mode, chapterIndex) {
        const chapters = this.parts(bookInfo, mode);
        if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= chapters.length)
            throw new Error('Глава озвучки не найдена.');
        const chapter = chapters[chapterIndex];
        return this.prepareText(userId, mode === 'book' ? bookUid : `${bookUid}:${mode}:${chapterIndex}`, chapter.text, speaker);
    }

    async preview(userId, speaker) {
        return this.prepareText(userId, 'voice-preview-v1', voiceSample, speaker, true);
    }

    async prepareText(userId, bookUid, text, speaker, priority = false) {
        if (!this.enabled) throw new Error('Серверная озвучка не настроена.');
        if (!speakers.includes(speaker)) throw new Error('Неизвестный голос Silero.');
        const id = crypto.createHash('sha256').update(JSON.stringify([
            'silero-mp3-v1', this.config.ttsModel || 'v5_5_ru', speaker, bookUid, text,
        ])).digest('hex');
        // The lock also covers the async cache lookup: concurrent clicks enqueue once.
        if (!this.pending.has(id)) {
            const preparation = this.prepareJob(id, text, speaker, priority);
            this.pending.set(id, preparation);
            preparation.finally(() => this.pending.delete(id)).catch(() => {});
        }
        const job = await this.pending.get(id);
        job.users.add(userId);
        return this.describe(job);
    }

    async prepareJob(id, text, speaker, priority = false) {
        const existing = this.jobs.get(id);
        if (existing && existing.state !== 'error' && (existing.state !== 'ready' || await fs.pathExists(existing.file))) return existing;
        await fs.ensureDir(this.directory);
        const file = path.join(this.directory, `${id}.mp3`);
        const cached = await fs.pathExists(file);
        if (!cached && this.queue.length + Number(this.running) >= 8)
            throw new Error('Очередь озвучки заполнена. Повторите позже.');
        // Bound retained status records independently from the on-disk cache.
        for (const [key, value] of this.jobs) {
            if (this.jobs.size < 128) break;
            if (value.state === 'ready' || value.state === 'error') this.jobs.delete(key);
        }
        const job = {id, file, speaker, text: cached ? '' : text, characters: text.length, processedCharacters: cached ? text.length : 0,
            state: cached ? 'ready' : 'queued', users: new Set(), error: ''};
        this.jobs.set(id, job);
        if (cached) await fs.utimes(file, new Date(), new Date());
        else {
            if (priority) this.queue.unshift(job);
            else this.queue.push(job);
            this.drain();
        }
        return job;
    }

    status(userId, id) {
        const job = this.jobs.get(String(id));
        if (!job || !job.users.has(userId)) throw new Error('Задание озвучки не найдено.');
        return this.describe(job);
    }

    signature(id, expires) {
        return crypto.createHmac('sha256', this.secret).update(`${id}:${expires}`).digest('hex');
    }

    describe(job) {
        const result = {id: job.id, state: job.state, error: job.error, speaker: job.speaker};
        result.progress = job.state === 'ready' ? 1 : Math.min(0.99, (job.processedCharacters || 0) / Math.max(1, job.characters));
        result.remainingSeconds = job.remainingSeconds ?? null;
        result.phase = job.phase || '';
        result.queuePosition = job.state === 'queued' ? this.queue.indexOf(job) + Number(this.running) : 0;
        if (job.state === 'ready') {
            const expires = Date.now() + tokenLifetime;
            const root = String(this.config.rootPathStatic || '').replace(/\/$/, '');
            result.url = `${root}/reader-audio/${job.id}.mp3?access=${expires}.${this.signature(job.id, expires)}`;
        }
        return result;
    }

    async authorizedFile(id, access) {
        if (!this.enabled || !/^[a-f0-9]{64}$/.test(id)) return null;
        const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(String(access || ''));
        if (!match || Number(match[1]) < Date.now() || Number(match[1]) > Date.now() + tokenLifetime) return null;
        const expected = Buffer.from(this.signature(id, match[1]), 'hex');
        if (!crypto.timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) return null;
        const file = path.join(this.directory, `${id}.mp3`);
        if (!await fs.pathExists(file)) return null;
        await fs.utimes(file, new Date(), new Date());
        return file;
    }

    async cleanCache(target = this.cacheLimit) {
        const files = [];
        let size = 0;
        for (const name of await fs.readdir(this.directory)) {
            if (!/^[a-f0-9]{64}\.mp3$/.test(name)) continue;
            const file = path.join(this.directory, name);
            const stat = await fs.stat(file);
            size += stat.size;
            files.push({file, stat});
        }
        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        for (const entry of files) {
            if (size <= target) break;
            // Preserve recently served files while the browser may issue range requests.
            if (Date.now() - entry.stat.mtimeMs < tokenLifetime) continue;
            await fs.remove(entry.file);
            size -= entry.stat.size;
        }
        return size;
    }

    async drain() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                const job = this.queue.shift();
                const temp = `${job.file}.partial`;
                let response;
                let progressTimer;
                let finished = false;
                try {
                    if (!this.enabled) throw new Error('Озвучка выключена в настройках.');
                    if (await this.cleanCache(this.cacheLimit * 0.8) >= this.cacheLimit)
                        throw new Error('Кэш озвучки заполнен. Увеличьте INPX_TTS_CACHE_SIZE_MB или повторите позже.');
                    job.state = 'generating';
                    const progressUrl = `${this.config.ttsUrl.replace(/\/$/, '')}/jobs/${job.id}`;
                    const trackProgress = async() => {
                        try {
                            const status = await this.transport.get(progressUrl, {timeout: 3000, maxRedirects: 0,
                                headers: this.config.ttsApiKey ? {'Authorization': `Bearer ${this.config.ttsApiKey}`} : {}});
                            if (!finished) {
                                job.phase = String(status.data.state || '');
                                job.processedCharacters = Math.min(job.characters, Math.round(job.characters * Math.max(0, Math.min(1, Number(status.data.progress) || 0))));
                                job.remainingSeconds = Number.isFinite(status.data.remainingSeconds) ? Math.max(0, status.data.remainingSeconds) : null;
                            }
                        } catch { /* Progress is optional for old services. */ }
                        if (!finished) progressTimer = setTimeout(trackProgress, 2000);
                    };
                    progressTimer = setTimeout(trackProgress, 1000);
                    response = await this.transport.post(`${this.config.ttsUrl.replace(/\/$/, '')}/synthesize`, {
                        text: job.text, speaker: job.speaker, model: this.config.ttsModel || 'v5_5_ru', requestId: job.id,
                    }, {
                        responseType: 'stream', timeout: Number(this.config.ttsTimeoutMs) || 3600000,
                        maxRedirects: 0, maxBodyLength: 16 * 1024 * 1024,
                        headers: this.config.ttsApiKey ? {'Authorization': `Bearer ${this.config.ttsApiKey}`} : {},
                    });
                    if (!String(response.headers['content-type'] || '').startsWith('audio/mpeg'))
                        throw new Error('Silero вернул некорректный аудиофайл.');
                    let bytes = 0;
                    const maximum = this.cacheLimit - await this.cleanCache();
                    const limiter = new Transform({transform(chunk, encoding, callback) {
                        bytes += chunk.length;
                        callback(bytes > maximum ? new Error('Недостаточно места в кэше озвучки.') : null, chunk);
                    }});
                    await pipeline(response.data, limiter, fs.createWriteStream(temp));
                    if (!bytes) throw new Error('Silero вернул пустой аудиофайл.');
                    await fs.move(temp, job.file, {overwrite: true});
                    job.state = 'ready';
                } catch (error) {
                    if (response && response.data) response.data.destroy();
                    if (error.response && error.response.data && error.response.data.destroy) error.response.data.destroy();
                    await fs.remove(temp).catch(() => {});
                    job.state = 'error';
                    job.error = error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND'
                        ? 'Сервис Silero недоступен. Проверьте контейнер озвучки.'
                        : error.code === 'ECONNABORTED' ? 'Истекло время подготовки аудио.' : error.response
                            ? `Ошибка сервиса Silero (HTTP ${error.response.status}). Проверьте его журнал.` : error.message;
                } finally { finished = true; clearTimeout(progressTimer); job.text = ''; }
            }
        } finally { this.running = false; }
    }
}

let instance;
function getReaderSpeech(config) {
    if (!instance) instance = new ReaderSpeech(config);
    return instance;
}

function registerSpeechRoute(app, config, speech = null) {
    const root = String(config.rootPathStatic || '').replace(/\/$/, '');
    app.get(`${root}/reader-audio/:fileName`, async(req, res, next) => {
        try {
            if (!config.ttsEnabled || !config.ttsUrl) return res.sendStatus(404);
            const match = /^([a-f0-9]{64})\.mp3$/.exec(req.params.fileName);
            const file = match && await (speech || getReaderSpeech(config)).authorizedFile(match[1], req.query.access);
            if (!file) return res.sendStatus(404);
            res.set('Cache-Control', 'private, no-store');
            res.type('audio/mpeg');
            res.sendFile(file);
        } catch (error) { next(error); }
    });
}

module.exports = {ReaderSpeech, getReaderSpeech, extractSpeechText, extractSpeechChapters, splitSpeechText, speakers, registerSpeechRoute};
