const key = text => String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]/gu,'');
function locate(parts, anchor) {
    const snippet = key(String(anchor?.textSnippet || '').slice(0,500));
    if (snippet.length < 8) throw new Error('Не удалось определить место в тексте. Выберите фрагмент вручную');
    const texts = parts.map(part => key(part.text)), lengths = texts.map(text => text.length);
    const full = texts.join(''), positions = [];
    let offset = 0;
    for (const length of lengths) {positions.push(offset); offset += length;}
    for (const length of [...new Set([Math.min(120,snippet.length),Math.min(64,snippet.length),Math.min(24,snippet.length)])]) {
        const needle = snippet.slice(0,length), hits = [];
        for (let found = full.indexOf(needle); found >= 0 && hits.length < 1000; found = full.indexOf(needle,found + 1)) hits.push(found);
        if (!hits.length) continue;
        const percent = Number(anchor?.percent), sourceOffset = Number(anchor?.sourceOffset);
        const target = Number.isFinite(sourceOffset) && sourceOffset >= 0 ? sourceOffset
            : Number.isFinite(percent) ? Math.max(0,Math.min(100,percent)) / 100 * full.length : 0;
        const found = hits.sort((a,b) => Math.abs(a - target) - Math.abs(b - target))[0];
        let index = 0;
        while (index + 1 < positions.length && positions[index + 1] <= found) index++;
        return index;
    }
    throw new Error('Не удалось найти место в озвучке. Выберите фрагмент вручную');
}
module.exports = {locate, key};
