const {execFile} = require('node:child_process');
const {createHash} = require('node:crypto');
const runtime = require('./ResourceRuntime');

function catalogGeneration(config) {
    if (!config?.inpxHash || !config.indexUpdate?.updatedAt)
        return '';
    return createHash('sha256').update(JSON.stringify([
        config.inpxHash, config.indexUpdate.updatedAt, config.dbVersion,
        process.versions.icu, process.versions.tz,
        new Intl.Collator().resolvedOptions().locale, new Intl.DateTimeFormat().resolvedOptions().timeZone,
    ])).digest('hex');
}

function query(executable, indexPath, request, signal) {
    const input = JSON.stringify(request);
    return new Promise((resolve, reject) => {
        const child = execFile(executable, ['shelves', indexPath], {
            windowsHide:true, signal, timeout:runtime.settings.taskTimeoutMs,
        }, (error, stdout) => {
            if (error) {reject(error);return;}
            try {resolve(JSON.parse(stdout));}
            catch (parseError) {reject(parseError);}
        });
        // A process that fails before reading the request is reported by execFile.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function selectShelfBooks(db, config, request, {executable, indexPath} = {
    executable:process.env.INPX_RUST_CATALOG_BINARY,
    indexPath:process.env.INPX_RUST_CATALOG_INDEX,
}) {
    if (!executable || !indexPath) return null;
    const generation = catalogGeneration(config);
    if (!generation) return null;
    const windows = await query(executable, indexPath, {...request, generation}, runtime.signal());
    const limits = request.daysWindows.map(() => request.newestLimit);
    if (request.popularLimit > 0) limits.push(request.popularLimit);
    if (!Array.isArray(windows) || windows.length !== limits.length || windows.some((ids, index) =>
        !Array.isArray(ids) || ids.length > limits[index] || ids.some(uid => typeof uid !== 'string' || !uid)))
        throw new Error('Некорректный ответ Rust-индекса полок');

    const ids = [...new Set(windows.flat())];
    if (!ids.length) return windows;
    const rows = await db.select({table:'book', where:`@@hash('_uid', ${db.esc(ids)})`});
    const books = new Map(rows.map(row => [row._uid,row]));
    if (ids.some(uid => !books.has(uid)))
        throw new Error('Rust-индекс ссылается на книги, которых нет в текущем каталоге');
    return windows.map(shelf => shelf.map(uid => books.get(uid)));
}

module.exports = {catalogGeneration, selectShelfBooks};
