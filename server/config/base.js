const path = require('path');
const pckg = require('../../package.json');

const execDir = path.resolve(__dirname, '..');
const MB = 1024*1024;

function sizeFromEnv(bytesName, mbName, fallback) {
    const bytes = parseInt(process.env[bytesName] || '', 10);
    if (Number.isFinite(bytes) && bytes >= 0)
        return bytes;

    const mb = parseInt(process.env[mbName] || '', 10);
    if (Number.isFinite(mb) && mb >= 0)
        return mb * MB;

    return fallback;
}

function numberFromEnv(name, fallback) {
    const value = parseFloat(process.env[name] || '');
    return (Number.isFinite(value) ? value : fallback);
}

const defaultBookCacheSize = sizeFromEnv('INPX_BOOK_CACHE_SIZE', 'INPX_BOOK_CACHE_SIZE_MB', 2048*MB);
const defaultCoverCacheSize = sizeFromEnv('INPX_COVER_CACHE_SIZE', 'INPX_COVER_CACHE_SIZE_MB', 512*MB);

module.exports = {
    branch: 'unknown',
    version: pckg.version,
    latestVersion: '',
    name: pckg.name,

    execDir,
    dataDir: '',
    tempDir: '',
    logDir: '',
    libDir: '',
    inpx: '',
    librarySources: [],
    inpxFilterFile: '',

    allowConfigRewrite: false,
    allowUnsafeFilter: false,
    accessPassword: '',
    accessTimeout: 0,
    extendedSearch: true,
    bookReadLink: '',
    loggingEnabled: true,
    logServerStats: false,
    logQueries: false,
    loginRateLimitEnabled: process.env.INPX_LOGIN_RATE_LIMIT_ENABLED !== 'false',
    loginRateLimitWindowMs: 15*60*1000,
    loginRateLimitMaxAttempts: 8,
    requireAuth: process.env.INPX_REQUIRE_AUTH === 'true',
    authMode: String(process.env.INPX_AUTH_MODE || 'local').trim().toLowerCase(),
    trustProxy: process.env.INPX_TRUST_PROXY === 'true',
    proxyAuthHeader: process.env.INPX_PROXY_AUTH_HEADER || 'Remote-User',
    trustedProxyCidrs: String(process.env.INPX_TRUSTED_PROXY_CIDRS || '').split(',').map(item => item.trim()).filter(Boolean),
    authExemptHealth: process.env.INPX_AUTH_EXEMPT_HEALTH !== 'false',
    metricsEnabled: process.env.INPX_METRICS_ENABLED === 'true',
    metricsPath: process.env.INPX_METRICS_PATH || '/metrics',
    metricsToken: process.env.INPX_METRICS_TOKEN || '',
    metricsExemptAuth: process.env.INPX_METRICS_EXEMPT_AUTH === 'true',

    // Поправить в случае, если были критические изменения в DbCreator или InpxParser,
    // иначе будет рассинхронизация по кэшу между сервером и клиентом на уровне БД.
    dbVersion: '13',
    dbCacheSize: 5,

    maxPayloadSize: 500,//in MB
    maxFilesDirSize: defaultBookCacheSize,//legacy alias for bookCacheSize
    bookCacheSize: defaultBookCacheSize,
    coverCacheSize: defaultCoverCacheSize,
    queryCacheEnabled: true,
    queryCacheMemSize: 50,
    queryCacheDiskSize: 500,
    cacheCleanInterval: numberFromEnv('INPX_CACHE_CLEAN_INTERVAL_MINUTES', 24*60),//minutes
    cacheCleanTargetRatio: numberFromEnv('INPX_CACHE_CLEAN_TARGET_RATIO', 0.8),
    adminEventLogEnabled: true,
    adminEventLogSize: 300,
    inpxCheckInterval: 60,//minutes
    lowMemoryMode: false,
    fullOptimization: false,

    webConfigParams: ['name', 'version', 'latestVersion', 'branch', 'bookReadLink', 'dbVersion', 'extendedSearch', 'latestReleaseLink', 'rootPathStatic', 'conversionEnabled', 'conversionFormats', 'telegramShareEnabled', 'emailShareEnabled', 'onlineReaderEnabled', 'updateChannel', 'installMode', 'uiDefaults', 'discovery', 'librarySources'],

    allowRemoteLib: false,
    remoteLib: false,
    /*
    allowRemoteLib: true, // на сервере
    remoteLib: { // на клиенте
        accessPassword: '',
        url: 'wss://remoteInpxWeb.ru',
    },
    */

    server: {
        host: '0.0.0.0',
        port: '22380',
        root: '',
    },
    //opds: false,
    opds: {
        enabled: true,
        user: '',
        password: '',
        root: '/opds',
    },

    latestReleaseLink: 'https://github.com/AceAsket/inpx-web/releases/latest',
    checkReleaseLink: 'https://api.github.com/repos/AceAsket/inpx-web/releases/latest',
    updateChannel: process.env.INPX_UPDATE_CHANNEL || 'auto',
    installMode: process.env.INPX_INSTALL_MODE || '',
    adminLogin: process.env.INPX_ADMIN_LOGIN || 'admin',
    adminPassword: process.env.INPX_ADMIN_PASSWORD || 'admin',
    resetAdminPassword: process.env.INPX_RESET_ADMIN_PASSWORD === 'true',
    conversionEnabled: process.env.INPX_ENABLE_CONVERSION !== 'false',
    conversionFormats: String(process.env.INPX_CONVERSION_FORMATS || 'epub,epub3,kepub,kfx,azw8,pdf').split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
    converterPaths: {},
    telegramShareEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramCaptionTemplate: process.env.TELEGRAM_CAPTION_TEMPLATE || '${AUTHOR} - ${TITLE}',
    emailShareEnabled: Boolean(process.env.SMTP_HOST),
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
    emailTo: process.env.EMAIL_TO || '',
    onlineReaderEnabled: true,
    discovery: {
        enabled: true,
        shelfLimit: parseInt(process.env.INPX_DISCOVERY_LIMIT || '8', 10) || 8,
        externalSource: String(process.env.INPX_DISCOVERY_EXTERNAL_SOURCE || 'none').trim().toLowerCase(),
        externalName: String(process.env.INPX_DISCOVERY_EXTERNAL_NAME || '').trim(),
        externalLimit: parseInt(process.env.INPX_DISCOVERY_EXTERNAL_LIMIT || '8', 10) || 8,
        externalUrl: String(process.env.INPX_DISCOVERY_EXTERNAL_URL || '').trim(),
        externalTtlMinutes: parseInt(process.env.INPX_DISCOVERY_EXTERNAL_TTL_MINUTES || '1440', 10) || 1440,
    },

    uiDefaults: {
        limit: 20,
        downloadAsZip: false,
        showCounts: true,
        showRates: true,
        showInfo: true,
        showGenres: true,
        bookCardView: 'cards',
        showDates: false,
        showDeleted: false,
        abCacheEnabled: true,
        langDefault: '',
        showJson: false,
        showNewReleaseAvailable: true,
        darkTheme: false,
    },
};

