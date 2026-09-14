const MiB = 1024*1024;
// The reader already accepts a 4 MiB background image, encoded as base64.
const preferencesLimit = 6*MiB;
function bounded(value, fallback, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
}
function limits(config = {}) {
    return {
        message: bounded(config.wsMessageLimitMb, 1, 16)*MiB,
        import: bounded(config.importLimitMb, 16, 64)*MiB,
        backup: bounded(config.backupUploadLimitMb, 32, 128)*MiB,
        expanded: bounded(config.backupExpandedLimitMb, 64, 256)*MiB,
    };
}
function transportLimit(config) {
    const value = limits(config);
    return Math.max(preferencesLimit, value.message, value.import + 65536, Math.ceil(value.backup/3)*4 + 65536);
}
function checkRequest(req, bytes, config) {
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.action !== 'string')
        throw new Error('Некорректный запрос WebSocket');
    const value = limits(config);
    let maximum = value.message;
    if (req.action === 'update-reader-preferences' || req.action === 'update-user-profile')
        maximum = Math.max(maximum, preferencesLimit);
    if (req.action === 'import-reading-lists' || req.action === 'import-admin-settings')
        maximum = value.import + 65536;
    if (req.action === 'import-admin-backup')
        maximum = Math.ceil(value.backup/3)*4 + 65536;
    if (bytes > maximum)
        throw new Error('Превышен размер запроса');
}
function checkImport(payload, config) {
    if (Buffer.byteLength(JSON.stringify(payload) || '') > limits(config).import)
        throw new Error('Превышен размер файла импорта');
    if (payload && Array.isArray(payload.lists)) {
        if (payload.lists.length > 1000)
            throw new Error('В импорте больше 1000 списков');
        let books = 0;
        for (const list of payload.lists) {
            books += Array.isArray(list && list.books) ? list.books.length : 0;
            if (books > 100000)
                throw new Error('В импорте больше 100000 записей книг');
        }
    }
}
module.exports = {limits, transportLimit, checkRequest, checkImport};
