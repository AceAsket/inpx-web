const RootPage = require('./RootPage');
const AuthorPage = require('./AuthorPage');
const SeriesPage = require('./SeriesPage');
const TitlePage = require('./TitlePage');
const GenrePage = require('./GenrePage');
const BookPage = require('./BookPage');
const ReadingListsPage = require('./ReadingListsPage');
const ReadingListPage = require('./ReadingListPage');
const CatalogShelfPage = require('./CatalogShelfPage');
const ReadingProfilesPage = require('./ReadingProfilesPage');
const ReadingProgressPage = require('./ReadingProgressPage');

const OpensearchPage = require('./OpensearchPage');
const SearchPage = require('./SearchPage');
const SearchHelpPage = require('./SearchHelpPage');

const log = new (require('../AppLogger'))().log;//singleton

// Profile lookups fall back to the first profile (the admin), and the OPDS auth check skips profiles
// without OPDS: a ?user= scope must name a profile with OPDS on, or the signed-in profile itself.
function scopeGuard(getWorker) {
    return async(req, res, next) => {
        try {
            const scopeUser = String((req.query && req.query.user) || '').trim();
            const identity = req.profileAccessIdentity;
            if (scopeUser) {
                const user = (identity && identity.user && identity.user.id === scopeUser ? identity.user
                    : await getWorker().readingListStore.getOpdsUser(scopeUser));
                if (!user) {
                    res.set('Cache-Control', 'no-store');
                    return res.status(404).send('Profile not found');
                }
                // Every page and generated link must refer to the profile checked above.
                req.query.user = user.id;
                req.opdsUser = user;
                res.set('Cache-Control','private, no-store');
                res.vary('Cookie');
                res.vary('Authorization');
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

function mountCatalog(app, config, security, catalogRoot, version) {
    // Inherit live server settings: copying config/opds would retain old
    // credentials after an administrator changes them without a restart.
    const catalogConfig = version === 2 ? Object.assign(Object.create(config), {opdsRoot:catalogRoot, opdsVersion:2}) : config;
    const opdsRoot = catalogRoot;

    const root = new RootPage(catalogConfig);
    const author = new AuthorPage(catalogConfig);
    const series = new SeriesPage(catalogConfig);
    const title = new TitlePage(catalogConfig);
    const genre = new GenrePage(catalogConfig);
    const book = new BookPage(catalogConfig);
    const BookExtrasPage = require('./BookExtrasPage');
    const reviews = new BookExtrasPage(catalogConfig, 'reviews');
    const authors = new BookExtrasPage(catalogConfig, 'authors');
    const readingLists = new ReadingListsPage(catalogConfig);
    const readingList = new ReadingListPage(catalogConfig);
    const catalogShelf = new CatalogShelfPage(catalogConfig);
    const readingProfiles = new ReadingProfilesPage(catalogConfig);
    const readingProgress = new ReadingProgressPage(catalogConfig);

    const opensearch = new OpensearchPage(catalogConfig);
    const search = new SearchPage(catalogConfig);
    const searchHelp = new SearchHelpPage(catalogConfig);

    const routes = [
        ['', root],
        ['/root', root],
        ['/author', author],
        ['/series', series],
        ['/title', title],
        ['/genre', genre],
        ['/book', book],
        ['/book/reviews', reviews],
        ['/book/authors', authors],
        ['/reading-lists', readingLists],
        ['/reading-lists/list', readingList],
        ['/catalog-shelves', catalogShelf],
        ['/reading-profiles', readingProfiles],
        ['/reading-progress', readingProgress],

        ['/opensearch', opensearch],
        ['/search', search],
        ['/search-help', searchHelp],
    ];

    const pages = new Map();
    for (const r of routes) {
        if (version === 2 && r[0] === '/opensearch') continue;
        pages.set(`${opdsRoot}${r[0]}`, r[1]);
    }

    const opds = async(req, res, next) => {
        try {
            if (catalogConfig.opds?.enabled === false) return res.sendStatus(404);
            const page = pages.get(version === 2 ? req.path.replace(/\/$/,'') : req.path);

            if (page) {
                res.set('Content-Type', version === 2
                    ? (page === book ? 'application/opds-publication+json; charset=utf-8' : 'application/opds+json; charset=utf-8')
                    : req.path === `${opdsRoot}/opensearch`
                    ? 'application/opensearchdescription+xml; charset=utf-8'
                    : 'application/atom+xml; charset=utf-8');

                if (version === 2 && page === search && Object.hasOwn(req.query,'query')) {
                    req.query.term = String(req.query.query || '');
                    if (!req.query.type) req.query.type = 'title';
                }

                const result = await page.body(req, res);

                if (result !== false)
                    res.send(result);
            } else {
                if (version === 2) res.status(404).json({error:'Каталог не найден'});
                else next();
            }
        } catch (e) {
            log(LM_ERR, `OPDS: ${e.message}, url: ${req.originalUrl}`);
            res.status(e.status || 500).send({error: e.message});
        }
    };

    const opdsPaths = [opdsRoot, `${opdsRoot}/*`];

    app.use(opdsPaths, new (require('../ProfileAccess'))(catalogConfig, root.webWorker, security).httpGuard(true));
    app.use(opdsPaths, require('./Auth')(catalogConfig, (...args) => root.webWorker.verifyOpdsPassword(...args), security));
    app.use(opdsPaths, scopeGuard(() => root.webWorker));

    if (version === 2) {
        app.get(opdsPaths,opds);
        app.post(opdsPaths,(req,res) => res.sendStatus(405));
    } else require('./Compatibility').mount(app, opdsPaths, opds, catalogConfig);
}

module.exports = function(app, config, security = new (require('../Security'))(config)) {
    if (!config.opds || !config.opds.enabled) return;
    const opdsRoot = config.opds.root || '/opds';
    config.opdsRoot = opdsRoot;
    // WebWorker is shared: its first construction must use the server config,
    // never the presentation config whose catalog root points to OPDS 2.
    new (require('../WebWorker'))(config);

    // The more specific routes must precede the OPDS 1 wildcard and its guards.
    mountCatalog(app, config, security, `${opdsRoot}/v2`, 2);
    mountCatalog(app, config, security, opdsRoot, 1);
};

module.exports.scopeGuard = scopeGuard;
