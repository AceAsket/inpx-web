const {normalize, words} = require('./CatalogSearch');
const MIN_SUGGEST_CHARS = 3;

function text(value, maximum = 120) {
    if (typeof value !== 'string' || Array.from(value).length > maximum) throw new Error('Слишком длинный поисковый запрос');
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function prefix(value = '') {
    if (typeof value !== 'string' || Array.from(value).length > 500 || Array.from(value).some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127))
        throw new Error('Некорректный префикс каталога');
    // A trailing space is part of an index key (e.g. "корнеев ").
    return value.toLowerCase();
}

// Bounded Damerau-Levenshtein: adjacent transpositions count as a single typo.
// Pure so the same implementation can run in the database worker.
function distance(a, b, maximum = 2) {
    if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
    let previous = Array.from({length: b.length + 1}, (_, i) => i), before = previous;
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] !== b[j - 1]));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                current[j] = Math.min(current[j], before[j - 2] + 1);
        }
        if (Math.min(...current) > maximum) return maximum + 1;
        before = previous; previous = current;
    }
    return previous[b.length];
}

function relevance(value, query) {
    const name = normalize(value), wanted = normalize(query);
    if (name === wanted) return 1000;
    if (name.startsWith(wanted)) return 800;
    const available = words(value), tokens = words(query);
    if (tokens.every((token, i) => available[i]?.startsWith(token))) return 600;
    if (name.includes(wanted)) return 400;
    return 200;
}

function scope(value = {}) {
    const result = {del: '0'};
    for (const key of ['lang', 'ext', 'sourceId', 'genre']) {
        if (value[key] !== undefined && value[key] !== '') {
            if (typeof value[key] !== 'string' || value[key].length > 500 || /^[~*#=]/.test(value[key]))
                throw new Error('Некорректный фильтр каталога');
            result[key] = value[key];
        }
    }
    return result;
}

module.exports = {text, prefix, distance, relevance, scope, MIN_SUGGEST_CHARS};
