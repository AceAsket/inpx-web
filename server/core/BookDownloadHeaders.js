const path = require('path');
const crypto = require('crypto');

const cyrillic = Object.fromEntries([
    ...'абвгдеёжзийклмнопрстуфхцчшщъыьэюяєіїґў',
].map((char, index) => [char, [
    'a','b','v','g','d','e','yo','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','kh','ts','ch','sh','shch','','y','','e','yu','ya','ye','i','yi','g','u',
][index]]));

function readableStem(value) {
    return value.replace(/[а-яёєіїґў]/gi, char => {
        const translated = cyrillic[char.toLowerCase()];
        return char === char.toLowerCase() ? translated : translated.charAt(0).toUpperCase() + translated.slice(1);
    }).normalize('NFKD').replace(/\p{M}/gu, '')
        .replace(/\./g, '_').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Old reader browsers do not understand RFC 5987 filename*. Keep the real
// extension in the ASCII fallback and in the final download URL.
function fallbackFilename(value) {
    const name = path.posix.basename(String(value || '').replace(/\\/g, '/'));
    const ext = path.posix.extname(name).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
    const stem = readableStem(suffix ? name.slice(0, -ext.length) : name);
    const hash = () => crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
    let readable = stem.replace(/^[ _-]+|[ _-]+$/g, '');
    if (!readable) return 'book-' + hash() + suffix;
    if (readable.length > 180) readable = readable.slice(0, 167).trimEnd() + '-' + hash();
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(readable)) readable = 'book-' + readable;
    return readable + suffix;
}

function disposition(value) {
    const encoded = encodeURIComponent(String(value || '')).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${fallbackFilename(value)}"; filename*=UTF-8''${encoded}`;
}

module.exports = {fallbackFilename, disposition};
