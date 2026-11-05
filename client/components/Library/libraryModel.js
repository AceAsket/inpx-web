// Shared presentation rules. Keep server records intact for existing book actions.
const libraryRoutes = new Set(['/overview', '/my-books', '/profile']);
const catalogRoutes = new Set(['/', '/author', '/series', '/title', '/books', '/for-you', '/newest', '/popular', '/bestsellers', '/extended']);

function appearance(value) {
    return value === 'shelves' ? 'shelves' : 'classic';
}

function appearanceRedirect(route, value) {
    if (appearance(value) === 'shelves') {
        if (route.path === '/' && !Object.keys(route.query || {}).length)
            return '/overview';
    } else if (libraryRoutes.has(route.path)) {
        return route.path === '/overview' ? '/for-you' : '/books';
    }
    return '';
}

function bookUid(book = {}) {
    return String(book._uid || book.bookUid || '').trim();
}

function progress(book = {}) {
    const value = book.percent ?? book._readerProgress?.percent;
    return value === undefined ? null : Math.max(0, Math.min(1, Number(value) || 0));
}

function coverUrl(book = {}, root = '') {
    if (book.discoveryCoverUrl) return book.discoveryCoverUrl;
    const uid = bookUid(book);
    root = String(root).replace(/\/$/, '');
    if (uid) return `${root}/cover/by-uid?uid=${encodeURIComponent(uid)}`;
    if (!book.libid) return '';
    return `${root}/cover/${book.sourceId ? `${encodeURIComponent(book.sourceId)}/` : ''}${encodeURIComponent(book.libid)}`;
}

function readable(book, config) {
    return !!(config.onlineReaderEnabled && bookUid(book) && !book.unavailable
        && !book.discoveryMissingLocal && String(book.ext || '').toLowerCase() === 'fb2');
}

function recentBooks(items = []) {
    const seen = new Set();
    return items.filter(book => {
        const uid = bookUid(book);
        if (!uid || seen.has(uid) || book.hidden || book.unavailable) return false;
        seen.add(uid);
        return true;
    }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function homeBooks(items = []) {
    const books = recentBooks(items);
    const current = books.find(book => book.state !== 'read' && (progress(book) || 0) < .999) || null;
    return {current, recent: books.filter(book => book !== current).slice(0, 8)};
}

function personalAccess(config = {}, settings = {}) {
    if (config.currentUserId && settings.currentUserId && config.currentUserId !== settings.currentUserId) return false;
    const profile = config.currentUserProfile || {};
    return !!config.profileAuthorized || !(config.profileLoginRequired || profile.requiresLogin);
}

function identity(config = {}, settings = {}) {
    return JSON.stringify([config.rootPathStatic || '', settings.currentUserId || config.currentUserId || 'default', config.currentUserId || '',
        !!config.profileAuthorized, !!config.profileLoginRequired, !!config.currentUserProfile?.requiresLogin,
        config.discovery?.enabled !== false, settings.profileAccessToken || '', config.dbConfig?.inpxHash || '']);
}

function discoveryOptions(settings = {}) {
    return {
        newestLimit: Math.max(1, Math.min(24, Number(settings.discoveryNewestLimit) || 8)),
        popularLimit: Math.max(1, Math.min(24, Number(settings.discoveryPopularLimit) || 8)),
        externalLimit: 8,
        personalSimilarEnabled: false,
    };
}

function normalizeShelves(shelves = []) {
    return shelves.filter(shelf => shelf && typeof shelf === 'object').map((shelf, index) => ({
        ...shelf,
        id: String(shelf.id || `discovery-${index}`),
        title: String(shelf.title || 'Подборка книг'),
        books: (Array.isArray(shelf.items) ? shelf.items : Array.isArray(shelf.books) ? shelf.books : [])
            .filter(book => book && !book.hidden && !book.unavailable && (bookUid(book) || book.discoveryUrl)),
    }));
}

function genreMapFromTree(tree = []) {
    const result = new Map();
    for (const section of tree) for (const genre of section.value || [])
        if (genre.value) result.set(String(genre.value), String(genre.name || genre.value));
    return result;
}

module.exports = {appearance, appearanceRedirect, libraryRoutes, catalogRoutes, bookUid, progress, coverUrl,
    readable, recentBooks, homeBooks, personalAccess, identity, discoveryOptions, normalizeShelves, genreMapFromTree};
