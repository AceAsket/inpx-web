function normalize(value) {
    if (!Array.isArray(value)) return [];
    const result = [], keys = new Set();
    const uids = rows => [...new Set((Array.isArray(rows) ? rows.slice(0,5000) : []).filter(row => typeof row === 'string' && row.length > 0 && row.length <= 512))].sort();
    for (const row of value.slice(0,20)) {
        if (!row || !['author','series'].includes(row.kind) || typeof row.value !== 'string') continue;
        const name = row.value.replace(/\s+/g,' ').trim().slice(0,200), key = row.kind + ':' + name.toLowerCase();
        if (!name || keys.has(key)) continue;
        keys.add(key);
        result.push({id:String(row.id || '').slice(0,80), kind:row.kind, value:name, revision:Math.max(0,Number.isSafeInteger(row.revision) ? row.revision : 0),
            createdAt:String(row.createdAt || '').slice(0,40), knownUids:uids(row.knownUids), newUids:uids(row.newUids)});
    }
    return result;
}
module.exports = {normalize};
