function check13(text) {
    if (!/^97[89]\d{10}$/.test(text)) return false;
    return [...text].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0) % 10 === 0;
}

function normalize(value) {
    const raw = String(value ?? '').trim();
    if (raw.length > 100) throw new Error('ISBN слишком длинный');
    const text = raw.replace(/^(?:urn:isbn:|isbn(?:[ -]?1[03])?\s*:?\s*)/i, '').replace(/[\s\-\u2010-\u2015]/g, '').toUpperCase();
    if (check13(text)) return text;
    if (/^\d{9}[\dX]$/.test(text) && [...text].reduce((sum, digit, i) => sum + (digit === 'X' ? 10 : Number(digit)) * (10 - i), 0) % 11 === 0) {
        const prefix = '978' + text.slice(0, 9);
        const sum = [...prefix].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
        return prefix + ((10 - sum % 10) % 10);
    }
    throw new Error('Укажите корректный ISBN-10 или ISBN-13');
}

function extract(value) {
    const text = String(value ?? '').slice(0, 16000).replace(/[\u2010-\u2015]/g, '-');
    const result = new Set();
    for (const match of text.matchAll(/(?<![\dA-Za-z])(?:97[89](?:[\s-]*\d){10}|(?:\d[\s-]*){9}[\dXx])(?![\dA-Za-z])/g)) {
        try {result.add(normalize(match[0]));} catch { /* Invalid publisher metadata is not a searchable ISBN. */ }
    }
    return [...result];
}

module.exports = {normalize, extract};
