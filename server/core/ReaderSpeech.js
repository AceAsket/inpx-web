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
        const id = crypto.createHash('sha256').update(JSON.stringify([
            'silero-mp3-v1', this.config.ttsModel || 'v5_5_ru', speaker, bookUid, text,
        ])).digest('hex');
        // The lock also covers the async cache lookup: concurrent clicks enqueue once.
        if (!this.pending.has(id)) {
            const preparation = this.prepareJob(id, text, speaker);
            this.pending.set(id, preparation);
            preparation.finally(() => this.pending.delete(id)).catch(() => {});
        }
        const job = await this.pending.get(id);
        job.users.add(userId);
        return this.describe(job);
    }

    async prepareJob(id, text, speaker) {
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
        const job = {id, file, speaker, text: cached ? '' : text, state: cached ? 'ready' : 'queued', users: new Set(), error: ''};
        this.jobs.set(id, job);
        if (cached) await fs.utimes(file, new Date(), new Date());
        else {
            this.queue.push(job);
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
                try {
                    if (!this.enabled) throw new Error('Озвучка выключена в настройках.');
                    if (await this.cleanCache(this.cacheLimit * 0.8) >= this.cacheLimit)
                        throw new Error('Кэш озвучки заполнен. Увеличьте INPX_TTS_CACHE_SIZE_MB или повторите позже.');
                    job.state = 'generating';
                    response = await this.transport.post(`${this.config.ttsUrl.replace(/\/$/, '')}/synthesize`, {
                        text: job.text, speaker: job.speaker, model: this.config.ttsModel || 'v5_5_ru',
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
                } finally { job.text = ''; }
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

module.exports = {ReaderSpeech, getReaderSpeech, extractSpeechText, speakers, registerSpeechRoute};
