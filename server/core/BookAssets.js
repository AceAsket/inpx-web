const crypto = require('crypto');
const path = require('path');

function cacheDirectories(publicFilesDir) {
    // Older cache files may have been produced before validating source paths.
    const root = path.join(publicFilesDir, 'source-verified-v1');
    return {bookDir:path.join(root, 'book'), coverDir:path.join(root, 'cover')};
}

function coverCacheKey(book) {
    // Prepared/downloaded size is presentation metadata, not a source revision.
    const revision = book._recordHash || [book.inpxSize ?? book.size, book.date];
    const identity = [book._uid, book.sourceId, book.sourceLibDir, book.folder, book.file, book.ext, revision];
    return `book-v3-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

module.exports = {cacheDirectories, coverCacheKey};
