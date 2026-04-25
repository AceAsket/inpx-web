const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const express = require('express');
const http = require('http');
const WebSocket = require ('ws');

const utils = require('./core/utils');
const {resolveLibrarySources} = require('./core/LibrarySources');

const ayncExit = new (require('./core/AsyncExit'))();

let log;
let config;
let argv;
let branch = '';
const argvStrings = ['host', 'port', 'config', 'data-dir', 'app-dir', 'lib-dir', 'inpx', 'library-sources', 'admin-login', 'admin-password'];

function applyEnvSecurityOverrides(targetConfig) {
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_REQUIRE_AUTH'))
        targetConfig.requireAuth = process.env.INPX_REQUIRE_AUTH === 'true';
    if (process.env.INPX_AUTH_MODE)
        targetConfig.authMode = String(process.env.INPX_AUTH_MODE || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_TRUST_PROXY'))
        targetConfig.trustProxy = process.env.INPX_TRUST_PROXY === 'true';
    if (process.env.INPX_PROXY_AUTH_HEADER)
        targetConfig.proxyAuthHeader = process.env.INPX_PROXY_AUTH_HEADER;
    if (process.env.INPX_TRUSTED_PROXY_CIDRS)
        targetConfig.trustedProxyCidrs = String(process.env.INPX_TRUSTED_PROXY_CIDRS || '').split(',').map(item => item.trim()).filter(Boolean);
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_AUTH_EXEMPT_HEALTH'))
        targetConfig.authExemptHealth = process.env.INPX_AUTH_EXEMPT_HEALTH !== 'false';
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_METRICS_ENABLED'))
        targetConfig.metricsEnabled = process.env.INPX_METRICS_ENABLED === 'true';
    if (process.env.INPX_METRICS_PATH)
        targetConfig.metricsPath = process.env.INPX_METRICS_PATH;
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_METRICS_TOKEN'))
        targetConfig.metricsToken = process.env.INPX_METRICS_TOKEN || '';
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_METRICS_EXEMPT_AUTH'))
        targetConfig.metricsExemptAuth = process.env.INPX_METRICS_EXEMPT_AUTH === 'true';
    if (Object.prototype.hasOwnProperty.call(process.env, 'INPX_LOGIN_RATE_LIMIT_ENABLED'))
        targetConfig.loginRateLimitEnabled = process.env.INPX_LOGIN_RATE_LIMIT_ENABLED !== 'false';
}

function showHelp(defaultConfig) {
    console.log(utils.versionText(defaultConfig));
    console.log(
`Usage: ${defaultConfig.name} [options]

Options:
  --help               Print ${defaultConfig.name} command line options
  --host=<ip>          Set web server host, default: ${defaultConfig.server.host}
  --port=<port>        Set web server port, default: ${defaultConfig.server.port}
  --config=<filepath>  Set config filename, default: <dataDir>/config.json
  --data-dir=<dirpath> (or --app-dir) Set application working directory, default: <execDir>/.${defaultConfig.name}
  --lib-dir=<dirpath>  Set library directory, default: the same as ${defaultConfig.name} executable's
  --inpx=<filepath>    Set INPX collection file, default: the one that found in library dir
  --library-sources=<json> Set multiple INPX sources, JSON array or "name|inpx|libDir;..."
  --admin-login=<str>  Set admin profile login, default: ${defaultConfig.adminLogin}
  --admin-password=<str> Set admin profile password, default: ${defaultConfig.adminPassword}
  --reset-admin-password Force reset of admin login/password on start
  --recreate           Force recreation of the search database on start
  --unsafe-filter      Use filter config at your own risk
`
    );
}

async function init() {
    argv = require('minimist')(process.argv.slice(2), {string: argvStrings});
    const argvDataDir = argv['data-dir'] || argv['app-dir'];
    const configFile = argv['config'];

    //config
    const configManager = new (require('./config'))();//singleton
    await configManager.init(argvDataDir, configFile);
    const defaultConfig = configManager.config;

    await configManager.load();
    config = configManager.config;
    applyEnvSecurityOverrides(config);
    branch = config.branch;

    //dirs
    config.dataDir = config.dataDir || argvDataDir || `${config.execDir}/.${config.name}`;
    config.tempDir = config.tempDir || `${config.dataDir}/tmp`;
    if (config.tempDir === '${OS}')
        config.tempDir = `${os.tmpdir()}/${config.name}`

    config.logDir = config.logDir || `${config.dataDir}/log`;    
    config.publicDir = `${config.dataDir}/public`;
    config.publicFilesDir = `${config.dataDir}/public-files`;
    config.rootPathStatic = config.server.root || '';
    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;
    config.coverDir = `${config.publicFilesDir}/cover`;

    configManager.config = config;

    await fs.ensureDir(config.dataDir);
    await fs.ensureDir(config.bookDir);
    await fs.ensureDir(config.coverDir);
    await fs.ensureDir(config.tempDir);
    await fs.emptyDir(config.tempDir);

    //logger
    const appLogger = new (require('./core/AppLogger'))();//singleton
    await appLogger.init(config);
    log = appLogger.log;

    //cli
    if (argv.help) {
        showHelp(defaultConfig);
        ayncExit.exit(0);
    } else {
        log(utils.versionText(config));
        log('Initializing');
    }

    if (argv.host) {
        config.server.host = argv.host;
    }

    if (argv.port) {
        config.server.port = argv.port;
    }

    if (argv['admin-login']) {
        config.adminLogin = argv['admin-login'];
    }

    if (Object.prototype.hasOwnProperty.call(argv, 'admin-password')) {
        config.adminPassword = String(argv['admin-password'] || '');
    }

    if (argv['reset-admin-password']) {
        config.resetAdminPassword = true;
    }

    if (argv['library-sources']) {
        const {parseSourcesFromString} = require('./core/LibrarySources');
        config.librarySources = parseSourcesFromString(argv['library-sources']);
    }

    if (config.remoteLib) {
        config.inpxFile = `${config.dataDir}/remote.inpx`;
        const RemoteLib = require('./core/RemoteLib');//singleton
        const remoteLib = new RemoteLib(config);
        await remoteLib.downloadInpxFile();
    }

    await resolveLibrarySources(config, argv);

    config.recreateDb = argv.recreate || false;
    config.inpxFilterFile = config.inpxFilterFile || `${path.dirname(config.configFile)}/filter.json`;
    config.allowUnsafeFilter = argv['unsafe-filter'] || config.allowUnsafeFilter || false;

    //web app
    if (branch !== 'development') {
        const createWebApp = require('./createWebApp');
        await createWebApp(config);
    }

    //log dirs
    for (const prop of ['configFile', 'dataDir', 'tempDir', 'logDir']) {
        log(`${prop}: ${config[prop]}`);
    }

    if (await fs.pathExists(config.inpxFilterFile))
        log(`inpxFilterFile: ${config.inpxFilterFile}`)
}

function logQueries(app) {
    app.use(function(req, res, next) {
        const start = Date.now();
        log(`${req.method} ${req.originalUrl} ${utils.cutString(req.body)}`);
        //log(`${JSON.stringify(req.headers, null, 2)}`)
        res.once('finish', () => {
            log(`${Date.now() - start}ms`);
        });
        next();
    });
}

async function main() {
    const log = new (require('./core/AppLogger'))().log;//singleton

    //server
    const app = express();
    const security = new (require('./core/Security'))(config);
    await security.init();
    if (config.trustProxy)
        app.set('trust proxy', (address) => security.isTrustedProxyAddress(address));
    app.use(security.middleware());
    app.use(security.requiredAuthMiddleware());

    const server = http.createServer(app);
    const wss = new WebSocket.Server({
        server,
        maxPayload: config.maxPayloadSize*1024*1024,
        verifyClient: (info, done) => {
            done(security.verifyWebSocket(info.req), 403, 'Forbidden');
        },
    });

    let devModule = undefined;
    if (branch == 'development') {
        const devFileName = './dev.js'; //require ignored by pkg -50Mb executable size
        devModule = require(devFileName);
        devModule.webpackDevMiddleware(app);
    }

    if (devModule)
        devModule.logQueries(app);

    const opds = require('./core/opds');
    opds(app, config);

    const webAccess = new (require('./core/WebAccess'))(config);
    await webAccess.init();

    const { WebSocketController } = require('./controllers');
    const webSocketController = new WebSocketController(wss, webAccess, config, security);

    const initHealthRoutes = require('./core/HealthRoutes');
    initHealthRoutes(app, config, webSocketController.webWorker, security, webSocketController);

    const initStatic = require('./static');
    initStatic(app, config);

    if (config.logQueries) {
        logQueries(app);
    }

    if (devModule) {
        devModule.logErrors(app);
    } else {
        app.use(function(err, req, res, next) {// eslint-disable-line no-unused-vars
            log(LM_ERR, err.stack);
            res.sendStatus(500);
        });
    }

    server.listen(config.server.port, config.server.host, () => {
        config.server.ready = true;
        log(`Server accessible at http://127.0.0.1:${config.server.port} (listening on ${config.server.host}:${config.server.port})`);
    });
}

(async() => {
    try {
        await init();
        await main();
    } catch (e) {
        const mes = (branch == 'development' ? e.stack : e.message);
        if (log)
            log(LM_FATAL, mes);
        else
            console.error(mes);

        ayncExit.exit(1);
    }
})();
