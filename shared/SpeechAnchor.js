const key = text => String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]/gu,'');
function createLocator(parts) {
    const texts = parts.map(part => key(part.text));
    const full = texts.join('');
    const positions = [];
    let offset = 0;
    for (const text of texts) {
        positions.push(offset);
        offset += text.length;
    }
    return anchor => {
        const snippet = key(String(anchor?.textSnippet || '').slice(0,500));
        if (snippet.length < 8) throw new Error('Не удалось определить место в тексте. Выберите фрагмент вручную');
        const percent = Number(anchor?.percent), sourceOffset = Number(anchor?.sourceOffset);
        const target = Number.isFinite(sourceOffset) && sourceOffset >= 0 ? sourceOffset
            : Number.isFinite(percent) ? Math.max(0,Math.min(100,percent)) / 100 * full.length : 0;
        for (const length of new Set([Math.min(120,snippet.length),Math.min(64,snippet.length),Math.min(24,snippet.length)])) {
            const needle = snippet.slice(0,length);
            const before = full.lastIndexOf(needle, Math.floor(target));
            const after = full.indexOf(needle, Math.ceil(target));
            if (before < 0 && after < 0) continue;
            const found = after < 0 || before >= 0 && target - before <= after - target ? before : after;
            let index = 0, upper = positions.length;
            while (upper - index > 1) {
                const middle = Math.floor((index + upper) / 2);
                if (positions[middle] <= found) index = middle;
                else upper = middle;
            }
            return {index, offset:found - positions[index]};
        }
        throw new Error('Не удалось найти место в озвучке. Выберите фрагмент вручную');
    };
}

function locate(parts, anchor) {return createLocator(parts)(anchor).index;}

module.exports = {locate, key, createLocator};
