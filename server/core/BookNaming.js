function render(template, book = {}, ext = '') {
    const number = Number(book.serno);
    const numbered = Number.isFinite(number) && number > 0;
    const digits = numbered ? String(number).split('.') : [];
    const fields = {
        TITLE: String(book.title || ''), AUTHOR: String(book.author || ''), SERIES: String(book.series || ''),
        NUMBER: numbered ? String(number) : '',
        NUMBER_PADDED: numbered ? digits[0].padStart(2, '0') + (digits.length > 1 ? `.${digits[1]}` : '') : '',
        EXT: String(ext || book.ext || ''),
    };
    const token = /\$\{([A-Z_]+)\}/g;
    const expand = text => text.replace(token, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(fields, key))
            throw new Error(`Неизвестное поле шаблона книги: ${match}`);
        return fields[key];
    });
    // Check placeholders even inside a conditional block that will be omitted.
    expand(String(template || ''));
    const conditional = String(template || '').replace(/\[([^[\]]*)\]/g, (match, inner) => {
        const keys = Array.from(inner.matchAll(token), item => item[1]);
        return keys.length ? (keys.some(key => !fields[key]) ? '' : inner) : match;
    });
    return expand(conditional).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex
}

function filename(book, fallback, ext, config = {}) {
    const template = String(config.bookFilenameTemplate || '').trim();
    if (!template) return fallback;
    const suffix = `.${ext}`;
    let value = render(template, book, ext);
    if (value.toLowerCase().endsWith(suffix.toLowerCase())) value = value.slice(0, -suffix.length);
    value = value.normalize('NFC').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '').trim();
    const chars = Array.from(value);
    while (Buffer.byteLength(chars.join(''), 'utf8') > 200) chars.pop();
    value = chars.join('').replace(/[. ]+$/g, '');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `_${value}`;
    return value ? `${value}${suffix}` : fallback;
}

function title(book, ext, config = {}) {
    const template = String(config.bookTitleTemplate || '').trim();
    return template ? render(template, book, ext) || String(book.title || '').trim() || null : null;
}

async function cachedBook(worker, desc, hash, requestedUid = '') {
    if (!worker || !worker.db) return {};
    const db = worker.db;
    let uid = desc.bookUid;
    if (requestedUid) {
        const rows = await db.select({table: 'file_hash', where: `@@id(${db.esc(requestedUid)})`});
        if (!rows.some(row => row.hash === hash)) throw new Error('404 Книга не соответствует файлу кэша');
        uid = requestedUid;
    }
    if (!uid) {
        const rows = await db.select({table: 'file_hash', where: `@@filter($r.hash === ${db.esc(hash)})`, limit: 1});
        uid = rows.length ? rows[0].id : '';
    }
    if (!uid) return {};
    const rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(uid)})`});
    return rows[0] || {};
}

module.exports = {render, filename, title, cachedBook};
