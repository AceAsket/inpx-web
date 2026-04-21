const path = require('path');
const pckg = require('../../package.json');

const execDir = path.resolve(__dirname, '..');

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

    //поправить в случае, если были критические изменения в DbCreator или InpxParser
    //иначе будет рассинхронизация по кешу между сервером и клиентом на уровне БД
    dbVersion: '12',
    dbCacheSize: 5,

    maxPayloadSize: 500,//in MB
    maxFilesDirSize: 1024*1024*1024,//1Gb
    queryCacheEnabled: true,
    queryCacheMemSize: 50,
    queryCacheDiskSize: 500,
    cacheCleanInterval: 60,//minutes
    inpxCheckInterval: 60,//minutes
    lowMemoryMode: false,
    fullOptimization: false,

    webConfigParams: ['name', 'version', 'latestVersion', 'branch', 'bookReadLink', 'dbVersion', 'extendedSearch', 'latestReleaseLink', 'rootPathStatic', 'conversionEnabled', 'telegramShareEnabled', 'emailShareEnabled', 'onlineReaderEnabled', 'uiDefaults'],

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
    adminLogin: process.env.INPX_ADMIN_LOGIN || 'admin',
    adminPassword: process.env.INPX_ADMIN_PASSWORD || 'admin',
    resetAdminPassword: process.env.INPX_RESET_ADMIN_PASSWORD === 'true',
    conversionEnabled: process.env.INPX_ENABLE_CONVERSION !== 'false',
    telegramShareEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramCaptionTemplate: process.env.TELEGRAM_CAPTION_TEMPLATE || '${AUTHOR} - ${TITLE}',
    emailShareEnabled: Boolean(process.env.SMTP_HOST && process.env.EMAIL_TO),
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
    emailTo: process.env.EMAIL_TO || '',
    onlineReaderEnabled: true,

    uiDefaults: {
        limit: 20,
        downloadAsZip: false,
        showCounts: true,
        showRates: true,
        showInfo: true,
        showGenres: true,
        showDates: false,
        showDeleted: false,
        abCacheEnabled: true,
        langDefault: '',
        showJson: false,
        showNewReleaseAvailable: true,
        darkTheme: false,
    },
};

