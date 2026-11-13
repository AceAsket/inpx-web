const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');
const {Readable, Transform} = require('stream');
const bookNaming = require('./BookNaming');

const tickets = new Map();
let running = false;
const maximum = 200;
const lifetime = 15 * 60 * 1000;
const cacheLimit = 1024 ** 3;
let cleanupTimer;
async function cleanup(now = Date.now()) {
    for (const [key, ticket] of tickets) {
        if (ticket.expires <= now && !ticket.readers) {await fs.remove(ticket.file); tickets.delete(key);}
        else if (!await fs.pathExists(ticket.file)) tickets.delete(key);
    }
    return [...tickets.values()].reduce((total, ticket) => total + ticket.bytes, 0);
}

function ensureCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => cleanup().catch(() => {}), 60000);
    cleanupTimer.unref?.();
}
function safeName(value, fallback) {
    const clean = Array.from(String(value || '')).filter(char => char.charCodeAt(0) >= 32).join('');
    const name = clean.normalize('NFC').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 120);
    return name || fallback;
}
async function create(worker, userId, selection) {
    if (running) throw new Error('Другой ZIP уже готовится. Повторите позже.');
    running = true;
    let output;
    try {
        worker.checkMyState();
        ensureCleanup();
        const retained = await cleanup();
        if (tickets.size >= 256 || retained >= cacheLimit)
            throw new Error('Кэш пакетных ZIP заполнен. Повторите через 15 минут.');
        let uids = selection.bookUids;
        if (selection.listId) {
            const item = await worker.readingListStore.getList(userId, selection.listId);
            if (!item) throw new Error('Список не найден');
            if (item.filters ? (await worker.smartShelfEntries(userId, item)).length > maximum : (item.books || []).length > maximum)
                throw new Error(`В одном ZIP может быть не больше ${maximum} книг`);
            const {books} = await worker.getReadingList(userId, selection.listId);
            uids = books.map(book => book._uid);
        } else if (selection.series) {
            const series = String(selection.series);
            if (series.length > 100) throw new Error('Для длинного названия серии выберите книги и скачайте выбранные');
            const ids = await worker.dbSearcher.bookSearchIds({series: `=${series}`, del: '0'});
            if (ids.length > maximum) throw new Error(`В одном ZIP может быть не больше ${maximum} книг`);
            const books = await worker.db.select({table: 'book', where: `@@id(${worker.db.esc(Array.from(ids))})`});
            books.sort((a, b) => a.serno - b.serno || a.title.localeCompare(b.title));
            uids = books.map(book => book._uid);
        }
        if (!Array.isArray(uids) || !uids.length || uids.length > maximum)
            throw new Error(`Выберите от 1 до ${maximum} книг`);
        uids = [...new Set(uids.map(value => String(value).trim()))];
        const token = crypto.randomBytes(32).toString('hex');
        output = path.join(worker.config.tempDir, `batch-${token}.zip`);
        const zip = new yazl.ZipFile();
        let outputBytes = 0;
        const limiter = new Transform({transform(chunk, encoding, callback) {
            outputBytes += chunk.length;
            callback(outputBytes > cacheLimit - retained ? new Error('Кэш пакетных ZIP заполнен. Повторите через 15 минут.') : null, chunk);
        }});
        const inputs = new Set();
        let pipelineError;
        const abort = error => {
            pipelineError = pipelineError || error;
            for (const input of inputs) input.destroy();
            zip.outputStream.destroy(pipelineError);
        };
        const checkOutput = () => {if (pipelineError) throw pipelineError;};
        const complete = pipeline(zip.outputStream, limiter, fs.createWriteStream(output));
        complete.catch(abort);
        zip.on('error', abort);
        let bytes = 0;
        const names = new Set();
        try {
            for (let index = 0; index < uids.length; index++) {
                checkOutput();
                const prepared = await worker.getPreparedBookFile(uids[index]);
                checkOutput();
                const stat = await fs.stat(prepared.rawFile);
                checkOutput();
                bytes += stat.size;
                if (bytes > 512 * 1024 * 1024) throw new Error('ZIP превышает лимит 512 МБ');
                const book = prepared.book;
                const folder = safeName(book.series, 'Вне серий');
                const name = safeName(`${book.serno ? `${book.serno}. ` : ''}${book.author} — ${book.title}`, `Книга-${index + 1}`);
                const ext = String(book.ext || '').replace(/[^a-z0-9]/gi, '');
                const fileName = bookNaming.filename(book, `${String(index + 1).padStart(3, '0')}_${name}.${ext}`, ext, worker.config);
                let entry = `${folder}/${fileName}`;
                let duplicate = 1;
                while (names.has(entry.toLowerCase())) {
                    duplicate++;
                    entry = `${folder}/${path.basename(fileName, `.${ext}`)}_${duplicate}.${ext}`;
                }
                names.add(entry.toLowerCase());
                // Open a descriptor only when yazl reaches this entry, while
                // retaining control of every active reader on output failure.
                const input = Readable.from((async function*() {
                    const source = fs.createReadStream(prepared.rawFile);
                    inputs.add(source); source.once('close', () => inputs.delete(source));
                    try {for await (const chunk of source) yield chunk;}
                    finally {source.destroy();}
                })());
                inputs.add(input);
                input.once('close', () => inputs.delete(input));
                input.on('error', abort);
                zip.addReadStream(input, entry, {size:stat.size, mtime:stat.mtime, mode:stat.mode});
            }
            zip.end();
            await complete;
        } catch (error) {abort(error); await complete.catch(() => {}); throw pipelineError;}
        finally {
            const closing = [...inputs].map(input => new Promise(resolve => {
                if (input.closed) return resolve();
                input.once('close', resolve); input.destroy();
            }));
            await Promise.all(closing);
        }
        tickets.set(token, {file: output, userId, count: uids.length, bytes:outputBytes, readers:0, expires: Date.now() + lifetime});
        return {url: `${worker.config.bookPathStatic}/batch/${token}`, count: uids.length};
    } catch (error) { if (output) await fs.remove(output); throw error; }
    finally { running = false; }
}
function register(app, config, trackDownload) {
    app.get(`${config.bookPathStatic}/batch/:token`, (req, res) => {
        const ticket = tickets.get(req.params.token);
        if (!ticket || ticket.expires <= Date.now()) {cleanup().catch(() => {}); return res.sendStatus(404);}
        if (req.profileAccessIdentity && req.profileAccessIdentity.user && req.profileAccessIdentity.user.id !== ticket.userId)
            return res.sendStatus(403);
        res.set('Cache-Control', 'private, no-store');
        ticket.readers++;
        let finished = false;
        const finish = () => {if (finished) return; finished = true; ticket.readers--; cleanup().catch(() => {});};
        res.once('finish', finish); res.once('close', finish);
        trackDownload?.(req, res, ticket.count);
        res.download(ticket.file, 'books.zip', error => {finish(); if (error && !res.headersSent) res.sendStatus(500);});
    });
}
module.exports = {create, register, safeName, maximum, cleanup};
