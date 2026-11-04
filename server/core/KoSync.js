const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const express = require('express');
const {withFileTransaction, writeFileAtomic} = require('./FilePersistence');
const position = require('./KoSyncPosition');
const {equal} = require('./opds/Auth');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const documentId = value => /^[a-f0-9]{32}$/.test(String(value || ''));
const isPersonalProfile = user => !!user?.id && !(user.id === 'default' && !user.login && !user.passwordHash) && !user.anonymousProfile;

async function partialMd5(file) {
    const handle = await fs.open(file, 'r');
    const hash = crypto.createHash('md5');
    try {
        const buffer = Buffer.alloc(1024);
        for (const offset of [0, ...Array.from({length: 11}, (_, i) => 1024 * 4 ** i)]) {
            const {bytesRead} = await fs.read(handle, buffer, 0, 1024, offset);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally { await fs.close(handle); }
    return hash.digest('hex');
}

class KoSync {
    constructor(config, worker) {
        this.config = config; this.worker = worker;
        this.file = path.join(config.dataDir, 'kosync.json');
        this.indexJobs = new Map();
    }

    async load() {
        try {
            if ((await fs.stat(this.file)).size > 32 * 1024 * 1024) throw new Error('Хранилище KOSync превышает лимит');
            return await fs.readJson(this.file);
        } catch (error) {
            if (error.code === 'ENOENT') return {version: 1, accounts: {}, books: {}};
            throw error;
        }
    }

    async save(data) {
        const json = JSON.stringify(data);
        if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('Хранилище KOSync заполнено');
        await writeFileAtomic(this.file, json);
    }

    async settings(user, operation = 'status') {
        if (!isPersonalProfile(user)) throw new Error('need_profile_login');
        return withFileTransaction(this.file, async() => {
            const data = await this.load();
            let password;
            if (operation === 'enable') {
                if (this.config.kosyncEnabled === false) throw new Error('KOSync выключен при запуске сервера');
                password = crypto.randomBytes(24).toString('base64url');
                const clientKey = crypto.createHash('md5').update(password).digest('hex');
                data.accounts[user.id] = {verifier: digest(clientKey), documents: data.accounts[user.id]?.documents || {}};
                await this.save(data);
            } else if (operation === 'disable') {
                delete data.accounts[user.id]; await this.save(data);
            } else if (operation !== 'status') throw new Error('Неизвестная операция KOSync');
            return {available: this.config.kosyncEnabled !== false, enabled: !!data.accounts[user.id],
                username: user.login || user.id, path: `${this.config.rootPathStatic || ''}/kosync`,
                ...(password ? {password} : {})};
        });
    }

    async authenticate(req) {
        const username = String(req.headers['x-auth-user'] || '');
        const key = String(req.headers['x-auth-key'] || '');
        if (username.length > 128 || !documentId(key)) return null;
        const data = await this.load();
        const users = (await this.worker.readingListStore.load()).users;
        const user = users.find(user => isPersonalProfile(user) && (user.login || user.id) === username);
        const account = user && data.accounts[user.id];
        return account && equal(account.verifier, digest(key)) ? {...user, kosyncVerifier: account.verifier} : null;
    }

    async linkDownload(file, bookUid, ext) {
        if (this.config.kosyncEnabled === false || !bookUid || !['fb2', 'epub', 'pdf', 'djvu'].includes(ext)) return;
        if (!await fs.pathExists(this.file)) return;
        return withFileTransaction(this.file, async() => {
            const data = await this.load();
            if (!Object.keys(data.accounts).length) return;
            const document = await partialMd5(file);
            const previous = data.books[document];
            if (previous && previous.bookUid !== bookUid) {
                // Identical files may represent several catalog entries. Never pick one arbitrarily.
                data.books[document] = {ambiguous: true};
            } else data.books[document] = {bookUid, ext, cacheFile: path.basename(file), updatedAt: Date.now()};
            const keys = Object.keys(data.books);
            if (keys.length > 8192) {
                keys.sort((a, b) => (data.books[a].updatedAt || 0) - (data.books[b].updatedAt || 0));
                for (const key of keys.slice(0, keys.length - 8192)) delete data.books[key];
            }
            await this.save(data);
        });
    }

    async bookIndex(document, book) {
        if (book.ext !== 'fb2') return null;
        const file = path.join(this.config.dataDir, 'kosync', `${document}.json`);
        try {
            if ((await fs.stat(file)).size <= 8 * 1024 * 1024) return await fs.readJson(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (this.indexJobs.has(document)) return this.indexJobs.get(document);
        if (this.indexJobs.size >= 2) throw new Error('Индекс KOSync занят, повторите позже');
        const job = (async() => {
            let raw = path.join(this.config.bookDir, path.basename(book.cacheFile));
            if (!await fs.pathExists(raw)) {
                const result = await this.worker.getBookLink(book.bookUid);
                const base = path.join(this.config.bookDir, path.basename(result.link));
                raw = base + '.raw';
                const desc = await fs.readJson(base + '.d.json');
                await require('./utils').ensureGunzipFile(base, raw, desc.size);
            }
            if (await partialMd5(raw) !== document) throw new Error('Файл книги изменился. Скачайте его заново для KOSync');
            const index = await position.indexFile(raw);
            await writeFileAtomic(file, JSON.stringify(index));
            // This is a regenerable on-disk index, not an unbounded second book collection.
            const entries = await fs.readdir(path.dirname(file));
            const cached = await Promise.all(entries.filter(name => /^[a-f0-9]{32}\.json$/.test(name)).map(async name => {
                const target = path.join(path.dirname(file), name);
                try {const stat = await fs.stat(target); return {file: target, size: stat.size, time: stat.mtimeMs};}
                catch {return null;}
            }));
            const ordered = cached.filter(Boolean).sort((a, b) => b.time - a.time);
            let bytes = 0;
            for (let i = 0; i < ordered.length; i++) {
                bytes += ordered[i].size;
                if (i >= 128 || bytes > 128 * 1024 * 1024) await fs.remove(ordered[i].file);
            }
            return index;
        })();
        this.indexJobs.set(document, job);
        try { return await job; } finally { this.indexJobs.delete(document); }
    }

    async progress(user, document, patch) {
        return withFileTransaction(this.file, async() => {
            const data = await this.load(), account = data.accounts[user.id];
            if (!account || (user.kosyncVerifier && account.verifier !== user.kosyncVerifier)) throw Object.assign(new Error('Unauthorized'), {status: 401});
            // getUser deliberately falls back to the guest profile. A deleted KOSync
            // account must never use that fallback during an in-flight request.
            const currentUser = (await this.worker.readingListStore.load()).users.find(row => row.id === user.id);
            if (!isPersonalProfile(currentUser)) throw Object.assign(new Error('Unauthorized'), {status: 401});
            const previous = account.documents[document] || {};
            const book = data.books[document];
            const linked = book?.bookUid && await this.worker.getBookRecordByUid(book.bookUid);
            let current;
            if (linked) {
                current = currentUser.readerProgress?.[book.bookUid] || {};
            }
            let index = null;
            if (linked && book.ext === 'fb2') {
                try { index = await this.bookIndex(document, book); }
                catch { /* Native KOReader-to-KOReader sync remains available if bridging fails. */ }
            }
            if (patch) {
                const record = {...patch, timestamp: Math.floor(Date.now() / 1000)};
                if (current) {
                    // KOReader has no CAS or original offline timestamp. Require a pull after
                    // an intervening web edit; the web reader also keeps its revision checks.
                    const revision = Number(current.revision) || 0;
                    const generation = currentUser.readerProgressGeneration || 0;
                    const canBridge = (!revision || previous.bridgeRevision === revision)
                        && (!generation || previous.bridgeGeneration === generation);
                    if (canBridge) {
                        record.bridgeRevision = revision;
                        record.bridgeGeneration = generation;
                    }
                    const anchor = index ? position.fromKo(index, patch.progress) : null;
                    if (canBridge && (anchor || book.ext !== 'fb2')) {
                        const result = await this.worker.updateReaderProgress(user.id, book.bookUid, {
                            ...(anchor || {textSnippet: '', textOffset: -1, pageIndex: 0, sectionId: ''}),
                            percent: patch.percentage, hidden: false, updatedAt: new Date().toISOString(),
                            baseRevision: revision, generation: currentUser.readerProgressGeneration || 0,
                        });
                        if (!result.progress.conflict && !result.progress.generationMismatch) {
                            record.bridgeRevision = result.progress.revision;
                            record.bridgeGeneration = result.progress.generation;
                        }
                    }
                }
                account.documents[document] = record;
                const keys = Object.keys(account.documents);
                if (keys.length > 2000) {
                    keys.sort((a, b) => account.documents[a].timestamp - account.documents[b].timestamp);
                    for (const key of keys.slice(0, keys.length - 2000)) delete account.documents[key];
                }
                await this.save(data);
                return {document, timestamp: record.timestamp};
            }
            let result = previous.progress ? {...previous} : {};
            if (currentUser?.readerProgressGeneration > (previous.bridgeGeneration || 0) && !Number(current?.revision)) {
                account.documents[document] = {bridgeGeneration: currentUser.readerProgressGeneration, bridgeRevision: 0};
                await this.save(data); return {};
            }
            if (current && index && Number(current.revision)) {
                const pointer = position.toKo(index, current);
                if (pointer && Number(current.revision) !== previous.bridgeRevision) result = {
                    document, progress: pointer, percentage: current.percent,
                    device: 'INPX Web', device_id: 'inpx-web', timestamp: Math.floor(Date.parse(current.updatedAt) / 1000),
                };
                if (pointer) {
                    account.documents[document] = {...result, bridgeRevision: current.revision,
                        bridgeGeneration: currentUser.readerProgressGeneration || 0};
                    await this.save(data);
                }
            } else if (current && !index) {
                account.documents[document] = {...previous, bridgeRevision: Number(current.revision) || 0,
                    bridgeGeneration: currentUser.readerProgressGeneration || 0};
                await this.save(data);
            }
            delete result.bridgeRevision; delete result.bridgeGeneration;
            return result;
        });
    }
}

function register(app, config, worker, security) {
    const service = worker.koSync || (worker.koSync = new KoSync(config, worker));
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (config.kosyncEnabled === false) return res.sendStatus(404);
        next();
    });
    router.get('/healthcheck', (req, res) => res.json({state: 'OK'}));
    router.post('/users/create', (req, res) => res.status(403).json({message: 'Создайте ключ в настройках профиля INPX Web'}));
    router.use(async(req, res, next) => {
        try {
            security.checkLoginRate(req, 'opds');
            const user = await service.authenticate(req);
            security.checkLoginRate(req, 'opds'); security.recordLoginAttempt(req, !!user, 'opds');
            if (!user) return res.status(401).json({message: 'Unauthorized'});
            req.kosyncUser = user; next();
        } catch (error) {
            if (error.code === 'INPX_LOGIN_RATE_LIMIT') res.set('Retry-After', String(error.retryAfter));
            res.status(error.code === 'INPX_LOGIN_RATE_LIMIT' ? 429 : 503).json({message: 'KOSync temporarily unavailable'});
        }
    });
    router.use(express.json({limit: '16kb', type: ['application/json', 'application/vnd.koreader.v1+json']}));
    router.get('/users/auth', (req, res) => res.json({authorized: 'OK'}));
    const run = async(req, res, next) => {
        try {
            const input = req.method === 'PUT' ? req.body : req.params;
            if (!input || !documentId(input.document)) return res.status(400).json({message: 'Invalid document'});
            let patch;
            if (req.method === 'PUT') {
                if (typeof input.progress !== 'string' || !input.progress || input.progress.length > 4096
                    || typeof input.percentage !== 'number' || !Number.isFinite(input.percentage) || input.percentage < 0 || input.percentage > 1
                    || typeof input.device !== 'string' || input.device.length > 128
                    || (input.device_id !== undefined && (typeof input.device_id !== 'string' || input.device_id.length > 128))) return res.status(400).json({message: 'Invalid progress'});
                patch = {document: input.document, progress: input.progress, percentage: input.percentage, device: input.device, device_id: input.device_id || ''};
            }
            res.json(await service.progress(req.kosyncUser, input.document, patch));
        } catch (error) { next(error); }
    };
    router.put('/syncs/progress', run); router.get('/syncs/progress/:document', run);
    router.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
        res.status(error.status || 503).json({message: 'KOSync request failed'});
    });
    app.use(`${config.rootPathStatic || ''}/kosync`, router);
    return service;
}

module.exports = {KoSync, register, partialMd5, isPersonalProfile};
