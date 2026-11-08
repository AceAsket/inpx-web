const crypto = require('crypto');

function coverCacheKey(book) {
    // Prepared/downloaded size is presentation metadata, not a source revision.
    const revision = book._recordHash || [book.inpxSize ?? book.size, book.date];
    const identity = [book._uid, book.sourceId, book.sourceLibDir, book.folder, book.file, book.ext, revision];
    return `book-v3-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

module.exports = {coverCacheKey};
