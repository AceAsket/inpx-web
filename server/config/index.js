const _ = require('lodash');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const SecretStore = require('../core/SecretStore');

const branchFilename = __dirname + '/application_env';

const propsToSave = [
    'dataDir',
    'tempDir',
    'logDir',
    'libDir',
    'inpx',
    'librarySources',
    'inpxFilterFile',
    'allowConfigRewrite',
    'allowUnsafeFilter',
    'accessPassword',
    'accessTimeout',
    'extendedSearch',
    'bookReadLink',
    'loggingEnabled',
    'logServerStats',
    'logQueries',
    'loginRateLimitWindowMs',
    'loginRateLimitMaxAttempts',
    'requireAuth',
    'authMode',
    'trustProxy',
    'proxyAuthHeader',
    'trustedProxyCidrs',
    'authExemptHealth',
    'metricsEnabled',
    'metricsPath',
    'metricsToken',
    'metricsExemptAuth',
    'dbCacheSize',
    'maxFilesDirSize',
    'coverCacheSize',
    'queryCacheEnabled',
    'queryCacheMemSize',
    'queryCacheDiskSize',
    'cacheCleanInterval',
    'adminEventLogEnabled',
    'adminEventLogSize',
    'inpxCheckInterval',
    'lowMemoryMode',
    'fullOptimization',
    'allowRemoteLib',
    'remoteLib',
    'server',
    'opds',
    'latestReleaseLink',
    'checkReleaseLink',
    'telegramShareEnabled',
    'telegramBotToken',
    'telegramChatId',
    'telegramCaptionTemplate',
    'emailShareEnabled',
    'smtpHost',
    'smtpPort',
    'smtpSecure',
    'smtpUser',
    'smtpPass',
    'emailFrom',
    'emailTo',
    'discovery',
    'uiDefaults',
];

function normalizeVersion(value = '') {
    return String(value || '').trim().replace(/^v/i, '');
}

function isRcVersion(value = '') {
    return /-rc(?:[.\-]?\d+)?$/i.test(normalizeVersion(value));
}

function resolveUpdateChannel(config = {}) {
    const raw = String(config.updateChannel || '').trim().toLowerCase();
    if (raw === 'rc' || raw === 'stable')
        return raw;

    return (isRcVersion(config.version) ? 'rc' : 'stable');
}

async function resolveInstallMode(config = {}) {
    const raw = String(config.installMode || '').trim().toLowerCase();
    if (raw)
        return raw;

    try {
        if (await fs.pathExists('/.dockerenv'))
            return 'docker';
    } catch (err) {
        //
    }

    return 'native';
}

let instance = null;

function resolveFallbackDataDir(config = {}) {
    const appDataDir = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (appDataDir)
        return path.join(appDataDir, config.name);

    return path.join(os.homedir(), `.${config.name}`);
}

async function ensureWritableDir(dirPath) {
    await fs.ensureDir(dirPath);
    await fs.access(dirPath, fs.constants.W_OK);
}

//singleton
class ConfigManager {
    constructor() {    
        if (!instance) {
            this.inited = false;

            instance = this;
        }

        return instance;
    }

    async init(defaultDataDir, configFile) {
        if (this.inited)
            throw new Error('already inited');

        this.branch = 'production';
        try {
            await fs.access(branchFilename);
            this.branch = (await fs.readFile(branchFilename, 'utf8')).trim();
        } catch (err) {
            //
        }

        process.env.NODE_ENV = this.branch;

        this.branchConfigFile = __dirname + `/${this.branch}.js`;
        const config = require(this.branchConfigFile);
        const defaultExecDataDir = `${config.execDir}/.${config.name}`;
        const canUseWindowsFallback = !defaultDataDir && !configFile && process.pkg && process.platform === 'win32';

        if (!defaultDataDir)
            defaultDataDir = defaultExecDataDir;

        if (configFile) {
            config.configFile = path.resolve(configFile);
        } else {
            let resolvedDataDir = defaultDataDir;

            try {
                await ensureWritableDir(resolvedDataDir);
            } catch (err) {
                if (!canUseWindowsFallback)
                    throw err;

                const fallbackDataDir = resolveFallbackDataDir(config);
                if (path.resolve(fallbackDataDir) === path.resolve(resolvedDataDir))
                    throw err;

                await ensureWritableDir(fallbackDataDir);
                resolvedDataDir = fallbackDataDir;
            }

            config.dataDir = config.dataDir || resolvedDataDir;
            config.configFile = `${resolvedDataDir}/config.json`;
        }

        this._config = config;

        this.inited = true;
    }

    get config() {
        if (!this.inited)
            throw new Error('not inited');
        return _.cloneDeep(this._config);
    }

    set config(value) {
        Object.assign(this._config, value);
    }

    async load() {
        try {
            if (!this.inited)
                throw new Error('not inited');

            if (await fs.pathExists(this._config.configFile)) {
                const data = JSON.parse(await fs.readFile(this._config.configFile, 'utf8'));
                const rawConfig = _.pick(data, propsToSave);
                const secretStore = new SecretStore(this._config);
                const secretResult = await secretStore.unprotectConfig(rawConfig);
                const config = secretResult.config;
                let needsSave = false;

                if (!config.latestReleaseLink || config.latestReleaseLink === 'https://github.com/bookpauk/inpx-web/releases/latest') {
                    config.latestReleaseLink = 'https://github.com/AceAsket/inpx-web/releases/latest';
                    needsSave = true;
                }

                if (!config.checkReleaseLink || config.checkReleaseLink === 'https://api.github.com/repos/bookpauk/inpx-web/releases/latest') {
                    config.checkReleaseLink = 'https://api.github.com/repos/AceAsket/inpx-web/releases/latest';
                    needsSave = true;
                }

                if (secretResult.needsSave)
                    needsSave = true;

                const discovery = Object.assign({}, this._config.discovery || {}, config.discovery || {});

                this.config = config;
                this._config.discovery = discovery;
                this._config.updateChannel = resolveUpdateChannel(this._config);
                this._config.installMode = await resolveInstallMode(this._config);

                //сохраним конфиг, если не все атрибуты присутствуют в файле конфига
                if (needsSave) {
                    await this.save();
                } else if (config.allowConfigRewrite) {
                    for (const prop of propsToSave) {
                        if (!Object.prototype.hasOwnProperty.call(config, prop)) {
                            await this.save();
                            break;                        
                        }
                    }
                }
            } else {
                this._config.updateChannel = resolveUpdateChannel(this._config);
                this._config.installMode = await resolveInstallMode(this._config);
                await this.save();
            }
        } catch(e) {
            throw new Error(`Error while loading "${this._config.configFile}": ${e.message}`);
        }
    }

    async save() {
        if (!this.inited)
            throw new Error('not inited');

        const secretStore = new SecretStore(this._config);
        const dataToSave = await secretStore.protectConfig(_.pick(this._config, propsToSave));
        await fs.writeFile(this._config.configFile, JSON.stringify(dataToSave, null, 4));
    }
}

module.exports = ConfigManager;
