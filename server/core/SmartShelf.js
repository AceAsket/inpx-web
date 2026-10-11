const fields = ['author', 'title', 'series', 'genre', 'lang', 'ext', 'date', 'librate', 'keywords', 'sourceId'];

function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const field of fields) {
        if (typeof value[field] === 'string' && value[field].trim()) {
            if (value[field].length > 100) throw new Error('Фильтр полки длиннее 100 символов');
            if (value[field].trim().startsWith('~')) require('./utils').checkSearchRegExp(value[field].trim().slice(1));
            result[field] = value[field].trim();
        }
    }
    if (!Object.keys(result).length) throw new Error('Задайте хотя бы один фильтр умной полки');
    result.unreadOnly = value.unreadOnly === true;
    result.hideCopies = value.hideCopies === true || value.hideCopies === 'true';
    result.del = '0';
    return result;
}

module.exports = {normalize};
