const path = require('path');
const crypto = require('crypto');

// Old reader browsers do not understand RFC 5987 filename*. Keep the real
// extension in the ASCII fallback and in the final download URL.
function fallbackFilename(value) {
    const name = path.posix.basename(String(value || '').replace(/\\/g, '/'));
    const ext = path.posix.extname(name).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
    const stem = suffix ? name.slice(0, -ext.length) : name;
    if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}$/.test(stem)) return stem.replace(/\./g, '_') + suffix;
    return 'book-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 12) + suffix;
}

function disposition(value) {
    const encoded = encodeURIComponent(String(value || '')).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${fallbackFilename(value)}"; filename*=UTF-8''${encoded}`;
}

module.exports = {fallbackFilename, disposition};
