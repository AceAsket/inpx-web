// Catalog words only. Explicit =, *, # and ~ operators keep their existing meaning.
function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').split(/\s+/).map(word => {
        if (!/[а-я]/.test(word) || !/[a-z]/.test(word)) return word;
        const pairs = {a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х'};
        return word.replace(/[aceopx]/g, letter => pairs[letter]);
    }).join(' ');
}
function words(value) { return normalize(value).match(/[\p{L}\p{N}]+/gu) || []; }
function root(word) {
    if (!/^[а-я]{5,}$/.test(word)) return word;
    const result = word.replace(/(?:иями|ями|ами|ого|ому|ыми|ими|ах|ях|ов|ев|ая|ое|ую|ые|ых|ой|ей|ий|ый|ам|ям|ом|ем|а|я|ы|и|у|ю|е|о|ь)$/u, '');
    return result.length >= 4 ? result : word;
}
function match(value, query) {
    const wanted = words(query), available = words(value);
    return wanted.length > 0 && wanted.every(word => available.some(candidate => candidate.startsWith(word) || root(candidate).startsWith(root(word))));
}
// Jemba runs query expressions in a separate worker; only these pure functions travel there.
function expression(value, query) {
    return `(() => {const normalize = ${normalize.toString()}; const words = ${words.toString()}; const root = ${root.toString()}; const match = ${match.toString()}; return match(${value}, ${JSON.stringify(query)});})()`;
}
module.exports = {normalize, words, root, match, expression};
