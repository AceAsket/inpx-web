const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');
const bookNaming = require('./BookNaming');

const tickets = new Map();
let running = false;
const maximum = 200;
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
        const complete = pipeline(zip.outputStream, fs.createWriteStream(output));
        complete.catch(() => {});
        zip.on('error', error => zip.outputStream.destroy(error));
        let bytes = 0;
        const names = new Set();
        try {
            for (let index = 0; index < uids.length; index++) {
                const prepared = await worker.getPreparedBookFile(uids[index]);
                bytes += (await fs.stat(prepared.rawFile)).size;
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
                zip.addFile(prepared.rawFile, entry);
            }
            zip.end();
            await complete;
        } catch (error) { zip.outputStream.destroy(error); await complete.catch(() => {}); throw error; }
        for (const [key, ticket] of tickets) {
            if (ticket.expires < Date.now()) { tickets.delete(key); await fs.remove(ticket.file); }
        }
        tickets.set(token, {file: output, userId, expires: Date.now() + 15 * 60 * 1000});
        return {url: `${worker.config.bookPathStatic}/batch/${token}`, count: uids.length};
    } catch (error) { if (output) await fs.remove(output); throw error; }
    finally { running = false; }
}
function register(app, config) {
    app.get(`${config.bookPathStatic}/batch/:token`, (req, res) => {
        const ticket = tickets.get(req.params.token);
        if (!ticket || ticket.expires < Date.now()) return res.sendStatus(404);
        if (req.profileAccessIdentity && req.profileAccessIdentity.user && req.profileAccessIdentity.user.id !== ticket.userId)
            return res.sendStatus(403);
        res.set('Cache-Control', 'private, no-store');
        res.download(ticket.file, 'books.zip');
    });
}
module.exports = {create, register, safeName, maximum};
