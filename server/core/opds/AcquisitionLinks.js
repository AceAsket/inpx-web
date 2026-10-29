const formats = require('../../../shared/BookFormats');

const mimeTypes = {
    fb2:'application/fb2+xml', epub:'application/epub+zip', epub3:'application/epub+zip', kepub:'application/epub+zip',
    mobi:'application/x-mobipocket-ebook', pdf:'application/pdf', kfx:'application/vnd.amazon.ebook', azw8:'application/vnd.amazon.ebook',
};

function forBook(book, config, profile = {}) {
    const ext = String(book.ext || '').toLowerCase();
    const base = `${config.bookPathStatic}/by-uid?uid=${encodeURIComponent(book._uid)}`;
    const offered = [...new Set([ext, ...(config.conversionEnabled ? formats.available(ext, config) : [])])];
    const selected = formats.resolve(ext, config, formats.preference(profile, 'opds')) || ext;
    offered.sort((a, b) => Number(b === selected) - Number(a === selected));
    const links = [];
    for (const format of offered) {
        const href = `${base}&format=${format === ext ? 'raw' : format}`;
        const title = `${format.toUpperCase()}${format === ext ? ' (исходный)' : ''}${format === selected && selected !== ext ? ' — предпочитаемый' : ''}`;
        const types = format === 'fb2' ? ['application/fb2+xml', 'application/x-fictionbook+xml']
            : [mimeTypes[format] || (/^[a-z0-9_-]+$/.test(format) ? `application/${format}` : 'application/octet-stream')];
        for (const type of types) links.push({href, type, title});
    }
    if (!['fb2', 'epub', 'mobi'].includes(ext))
        links.push({href:`${base}&zip=1`, type:'application/zip', title:`ZIP (${ext.toUpperCase()})`});
    return links;
}

module.exports = {forBook};
