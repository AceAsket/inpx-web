const crypto = require('crypto');

function coverCacheKey(book) {
    const identity = [book._uid, book.sourceId, book.sourceLibDir, book.folder, book.file, book.ext];
    return `book-v2-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

module.exports = {coverCacheKey};
