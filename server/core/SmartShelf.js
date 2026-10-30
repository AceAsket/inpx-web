const fields = ['author', 'title', 'series', 'genre', 'lang', 'ext', 'date', 'librate', 'ratingCount', 'keywords', 'sourceId', 'isbn'];

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
    if (result.ratingCount) require('../../shared/RatingCount').parse(result.ratingCount);
    if (result.isbn) result.isbn = require('../../shared/Isbn').normalize(result.isbn);
    result.unreadOnly = value.unreadOnly === true;
    result.hideCopies = value.hideCopies === true || value.hideCopies === 'true';
    result.del = '0';
    return result;
}

function query(filters) {
    const result = {...filters};
    const periods = {today:[0, 'day'], '3days':[3, 'day'], week:[1, 'week'], '2weeks':[2, 'week'], month:[1, 'month'], '2months':[2, 'month'], '3months':[3, 'month']};
    if (periods[result.date]) {
        const [amount, unit] = periods[result.date];
        result.date = require('dayjs')().subtract(amount, unit).format('YYYY-MM-DD');
    }
    return result;
}

module.exports = {normalize, query};
