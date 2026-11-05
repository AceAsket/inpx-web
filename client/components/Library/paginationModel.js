function pageLimit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : 1;
}

function boundedPage(value, count) {
    return Math.min(pageLimit(count), pageLimit(value));
}

function parsePage(value, count) {
    const input = String(value || '').trim();
    if (!/^\d+$/.test(input)) return null;
    const number = Number(input);
    return Number.isSafeInteger(number) ? boundedPage(number, count) : null;
}

function pageWindow(value, count) {
    const max = pageLimit(count), current = boundedPage(value, max);
    const center = Math.max(3, Math.min(max - 2, current));
    const pages = max <= 7 ? Array.from({length: max}, (_, index) => index + 1)
        : [1, center - 1, center, center + 1, max];
    const result = [];
    for (const page of pages) {
        const previous = result[result.length - 1];
        if (typeof previous === 'number' && page - previous === 2) result.push(previous + 1);
        else if (typeof previous === 'number' && page - previous > 2) result.push(`gap-${page}`);
        result.push(page);
    }
    return result;
}

module.exports = {pageLimit, boundedPage, parsePage, pageWindow};
