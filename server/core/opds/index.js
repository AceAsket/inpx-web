const RootPage = require('./RootPage');
const AuthorPage = require('./AuthorPage');
const SeriesPage = require('./SeriesPage');
const TitlePage = require('./TitlePage');
const GenrePage = require('./GenrePage');
const BookPage = require('./BookPage');
const ReadingListsPage = require('./ReadingListsPage');
const ReadingListPage = require('./ReadingListPage');
const ReadingProfilesPage = require('./ReadingProfilesPage');
const ReadingProgressPage = require('./ReadingProgressPage');

const OpensearchPage = require('./OpensearchPage');
const SearchPage = require('./SearchPage');
const SearchHelpPage = require('./SearchHelpPage');

const log = new (require('../AppLogger'))().log;//singleton

function parseBasicAuth(header = '') {
    const match = String(header || '').match(/^Basic\s+(.+)$/i);
    if (!match)
        return null;

    try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const splitAt = decoded.indexOf(':');
        if (splitAt < 0)
            return null;

        return {
            user: decoded.slice(0, splitAt),
            password: decoded.slice(splitAt + 1),
        };
    } catch(e) {
        return null;
    }
}

function requireBasicAuth(res, realm = 'inpx-web OPDS') {
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send('Authentication required');
}

module.exports = function(app, config) {
    if (!config.opds || !config.opds.enabled)
        return;
    
    const opdsRoot = config.opds.root || '/opds';
    config.opdsRoot = opdsRoot;

    const root = new RootPage(config);
    const author = new AuthorPage(config);
    const series = new SeriesPage(config);
    const title = new TitlePage(config);
    const genre = new GenrePage(config);
    const book = new BookPage(config);
    const readingLists = new ReadingListsPage(config);
    const readingList = new ReadingListPage(config);
    const readingProfiles = new ReadingProfilesPage(config);
    const readingProgress = new ReadingProgressPage(config);

    const opensearch = new OpensearchPage(config);
    const search = new SearchPage(config);
    const searchHelp = new SearchHelpPage(config);

    const routes = [
        ['', root],
        ['/root', root],
        ['/author', author],
        ['/series', series],
        ['/title', title],
        ['/genre', genre],
        ['/book', book],
        ['/reading-lists', readingLists],
        ['/reading-lists/list', readingList],
        ['/reading-profiles', readingProfiles],
        ['/reading-progress', readingProgress],

        ['/opensearch', opensearch],
        ['/search', search],
        ['/search-help', searchHelp],
    ];

    const pages = new Map();
    for (const r of routes) {
        pages.set(`${opdsRoot}${r[0]}`, r[1]);
    }

    const opds = async(req, res, next) => {
        try {
            const page = pages.get(req.path);

            if (page) {
                res.set('Content-Type', req.path === `${opdsRoot}/opensearch`
                    ? 'application/opensearchdescription+xml; charset=utf-8'
                    : 'application/atom+xml; charset=utf-8');

                const result = await page.body(req, res);

                if (result !== false)
                    res.send(result);
            } else {
                next();
            }
        } catch (e) {
            log(LM_ERR, `OPDS: ${e.message}, url: ${req.originalUrl}`);
            res.status(500).send({error: e.message});
        }
    };

    const opdsPaths = [opdsRoot, `${opdsRoot}/*`];

    app.use(opdsPaths, async(req, res, next) => {
        try {
            const credentials = parseBasicAuth(req.headers.authorization);

            if (config.opds.password) {
                if (!config.opds.user)
                    throw new Error('User must not be empty if password set');

                if (!credentials || credentials.user !== config.opds.user || credentials.password !== config.opds.password) {
                    requireBasicAuth(res);
                    return;
                }

                next();
                return;
            }

            const scopedUser = String((req.query && req.query.user) || '').trim();
            if (!scopedUser) {
                next();
                return;
            }

            const auth = await root.webWorker.verifyOpdsPassword(scopedUser, credentials ? credentials.user : '', credentials ? credentials.password : '');
            if (auth.user && auth.user.opdsAuthEnabled === true && !auth.authorized) {
                requireBasicAuth(res, `inpx-web OPDS ${auth.user.name || scopedUser}`);
                return;
            }

            next();
        } catch(e) {
            log(LM_ERR, `OPDS auth: ${e.message}, url: ${req.originalUrl}`);
            res.status(500).send({error: e.message});
        }
    });

    app.get(opdsPaths, opds);
};

