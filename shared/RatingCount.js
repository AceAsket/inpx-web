function parse(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const match = /^(\d+)(?:\.\.(\d*)?)?$|^\.\.(\d+)$/.exec(text);
    if (!match) throw new Error('Число голосов: укажите N, N..M, N.. или ..M');
    const min = match[1] === undefined ? 0 : Number(match[1]);
    const max = text.includes('..') ? (match[3] !== undefined ? Number(match[3]) : match[2] ? Number(match[2]) : Infinity) : min;
    if (!Number.isSafeInteger(min) || max !== Infinity && !Number.isSafeInteger(max) || min > max)
        throw new Error('Некорректный диапазон числа голосов');
    return {min, max};
}

module.exports = {parse};
