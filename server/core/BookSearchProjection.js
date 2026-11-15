const {words, root} = require('../../shared/CatalogSearch');

function normalizeKeyPart(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g,' ');
}

function physicalBookKey(row, mergeSources = false) {
    const source = mergeSources ? '' : (row.sourceId || '');
    if (row.libid && !row.folder && !row.file)
        return ['libid',source,row.sourcelib || '',row.libid,row.ext || ''].join(':');
    const file = [source,row.folder,row.file,row.ext,String(row.insno || 0)].map(normalizeKeyPart);
    if (file.some(Boolean)) return 'file:' + file.join('|');
    return ['meta',source,row.author,row.series,String(row.serno || 0),row.title,
        String(row.size || 0),row.ext].map(normalizeKeyPart).join('|');
}

function bookScore(row) {
    return (!row.del ? 1000 : 0) + (row.librate ? row.librate * 100 : 0)
        + (row.ext === 'fb2' ? 20 : 0) + (row.size ? Math.min(row.size,100000000) / 1000000 : 0);
}

function compareBookFields(a,b) {
    let cmp = a.author.localeCompare(b.author);
    if (cmp === 0 && (a.series || b.series))
        cmp = a.series && b.series ? a.series.localeCompare(b.series) : (a.series ? -1 : 1);
    if (cmp === 0) cmp = a.serno - b.serno;
    if (cmp === 0) cmp = a.title.localeCompare(b.title);
    return cmp;
}

function compareBooks(a,b) {return compareBookFields(a,b) || a.order - b.order;}

function encodeBook(row) {
    const tokens = ['author','series','title'].map(field => words(row[field]).flatMap(word => [word,root(word)]));
    return JSON.stringify([row,{words:tokens,physical:physicalBookKey(row),score:bookScore(row)}]) + '\n';
}

module.exports = {encodeBook, compareBooks, compareBookFields, bookScore, normalizeKeyPart, physicalBookKey};
