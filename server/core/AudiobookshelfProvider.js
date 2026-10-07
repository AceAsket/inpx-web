const crypto = require('crypto');
const {BookMetadata} = require('./BookMetadata');
const genreNames = new Map(require('./genres').flatMap(section => section.value).map(genre => [genre.value, genre.name]));
const coverLifetime = 24 * 60 * 60 * 1000;
// Audiobookshelf's CustomProviderAdapter stops waiting after 10 seconds.
const searchTimeoutMs = 8000;
const metadataTimeoutMs = 3000;

function equal(left = '', right = '') {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rootPath(config) {
    return `${String(config.rootPathStatic || '').replace(/\/$/, '')}/api/audiobookshelf`;
}

function coverSignature(config, uid, expires) {
    return crypto.createHmac('sha256', config.absToken).update(`abs-cover:${uid}:${expires}`).digest('hex');
}

function isAuthorizedRequest(req, config) {
    if (!config.absEnabled || !config.absToken)
        return false;
    const pathname = String(req.path || '').replace(/\/+$/, '');
    if (![rootPath(config), `${rootPath(config)}/search`, `${rootPath(config)}/cover`].includes(pathname) || !['GET', 'HEAD'].includes(req.method))
        return false;
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (equal(supplied, config.absToken))
        return true;
    if (pathname !== `${rootPath(config)}/cover`)
        return false;
    const {uid, expires, signature} = req.query || {};
    if (typeof uid !== 'string' || !uid || uid.length > 256 || typeof expires !== 'string' || typeof signature !== 'string')
        return false;
    const time = Number(expires);
    return Number.isSafeInteger(time) && time > Date.now() && time <= Date.now() + coverLifetime
        && equal(signature, coverSignature(config, uid, expires));
}

function normalized(value = '') {
    return String(value).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function authorMatches(author, wanted) {
    const words = normalized(author).split(' ');
    return normalized(wanted).split(' ').filter(Boolean).every(word => words.some(candidate =>
        candidate === word || (word.length === 1 && candidate.startsWith(word))));
}

function publicBase(req, config, security) {
    const supplied = config.absPublicUrl || `${security.forwardedProto(req) || security.requestProto(req)}://${security.forwardedHost(req) || security.requestHost(req)}${config.rootPathStatic || ''}`;
    const url = new URL(`${supplied.replace(/\/$/, '')}/`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw Object.assign(new Error('Invalid metadata provider public URL'), {status: 400});
    return url;
}

function signedCoverUrl(book, req, config, security) {
    const url = new URL('api/audiobookshelf/cover', publicBase(req, config, security));
    const expires = String(Date.now() + coverLifetime);
    url.searchParams.set('uid', book._uid);
    url.searchParams.set('expires', expires);
    url.searchParams.set('signature', coverSignature(config, book._uid, expires));
    return url.toString();
}

function mapMetadata(book, extra) {
    const result = {
        title: book.title || 'Без названия',
        author: String(book.author || '').split(',').map(value => value.trim()).filter(Boolean).join(', '),
        language: extra.language || book.lang || '',
        genres: String(book.genre || '').split(',').filter(Boolean).map(value => genreNames.get(value) || value),
        tags: [...new Set([...(extra.tags || []), ...String(book.keywords || '').split(/[,;]/).map(value => value.trim()).filter(Boolean)])],
    };
    for (const field of ['description', 'publisher', 'isbn'])
        if (extra[field]) result[field] = String(extra[field]);
    const year = extra.publishedYear || book.year;
    if (year && String(year) !== '0') result.publishedYear = String(year);
    if (book.series) {
        result.series = [{series: book.series}];
        if (book.serno) result.series[0].sequence = String(book.serno);
    }
    return result;
}

function init(app, config, worker, security) {
    const metadata = new BookMetadata(worker);
    const root = rootPath(config);
    let activeSearches = 0;
    const authorize = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!config.absEnabled) return res.status(404).json({error: 'Metadata provider is disabled'});
        if (!config.absToken) return res.status(503).json({error: 'INPX_ABS_TOKEN is required'});
        if (!isAuthorizedRequest(req, config)) return res.status(401).json({error: 'Invalid authorization token'});
        next();
    };
    app.get(root, authorize, (req, res) => res.json({
        provider: 'inpx-web', version: config.version || '', search: `${root}/search`, authorizationRequired: true,
    }));
    app.get(`${root}/search`, authorize, async(req, res) => {
        if (activeSearches >= 2)
            return res.status(429).set('Retry-After', '2').json({error: 'Too many metadata searches'});
        activeSearches++;
        let timer;
        let metadataTimer;
        let indexWork;
        try {
            const {query, author = ''} = req.query;
            if (typeof query !== 'string' || typeof author !== 'string' || query.length > 200 || author.length > 200 || (!query.trim() && !author.trim()))
                return res.status(400).json({error: 'Provide query or author, at most 200 characters each'});
            const title = query.trim();
            const authorTerm = author.trim();
            const search = {del: '0', limit: 60, offset: 0};
            if (title) search.title = `*${title}`;
            if (authorTerm) {
                const longest = authorTerm.split(/[\s,]+/).filter(Boolean).sort((a, b) => b.length - a.length)[0];
                search.author = `*${longest}`;
            }
            const deadline = Date.now() + searchTimeoutMs;
            const timeout = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error('Metadata index search timed out'), {status: 503})), searchTimeoutMs);
            });
            indexWork = Promise.resolve(worker.bookSearch(search));
            const result = await Promise.race([indexWork, timeout]);
            const limit = Math.max(1, Math.min(20, Math.floor(Number(config.absMaxResults) || 10)));
            const books = (result.found || []).filter(book => !authorTerm || authorMatches(book.author, authorTerm));
            books.sort((a, b) => {
                const score = book => (normalized(book.title) === normalized(title) ? 4 : 0) + (book.ext === 'fb2' ? 1 : 0);
                return score(b) - score(a);
            });
            const selected = books.slice(0, limit);
            const extras = selected.map(() => ({}));
            const enrich = Promise.all(selected.map((book, i) => metadata.read(book)
                .then(value => {extras[i] = value;})
                .catch(() => {})));
            // Archive reads are optional: retain index matches when a NAS is
            // slow or the bounded metadata queue is full. Finished reads enter
            // the shared cache and enrich subsequent searches.
            const budget = Math.max(0, Math.min(metadataTimeoutMs, deadline - Date.now()));
            await Promise.race([enrich, new Promise(resolve => {metadataTimer = setTimeout(resolve, budget);})]);
            res.json({matches: selected.map((book, i) => ({...mapMetadata(book, extras[i]), cover: signedCoverUrl(book, req, config, security)}))});
        } catch (error) {
            res.status(error.status || 503).json({error: error.status ? error.message : 'Metadata search is unavailable'});
        } finally {
            clearTimeout(timer);
            clearTimeout(metadataTimer);
            // An index query that outlives its HTTP deadline still occupies a
            // slot. Archive work is already bounded by BookMetadata's semaphore.
            if (indexWork) indexWork.then(() => {activeSearches--;}, () => {activeSearches--;});
            else activeSearches--;
        }
    });
    app.get(`${root}/cover`, authorize, async(req, res) => {
        try {
            const uid = req.query.uid;
            if (typeof uid !== 'string' || !uid || uid.length > 256)
                return res.status(400).json({error: 'Invalid book UID'});
            const book = await worker.getBookRecordByUid(uid);
            if (!book) return res.status(404).json({error: 'Book not found'});
            const cover = await metadata.cover(book);
            if (!cover) return res.status(404).json({error: 'Cover not found'});
            res.type(cover.contentType).send(cover.data);
        } catch (error) {
            res.status(error.status || 503).json({error: 'Cover is unavailable'});
        }
    });
    return metadata;
}

module.exports = {init, isAuthorizedRequest, coverSignature, rootPath, mapMetadata, authorMatches};
