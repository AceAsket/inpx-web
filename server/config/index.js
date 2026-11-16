const _ = require('lodash');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const SecretStore = require('../core/SecretStore');
const {run:native} = require('../core/RustStartup');
const {migrateWorkingDirectory} = require('../core/DataDirectoryMigration');
const {withFileTransaction, writeFileAtomic} = require('../core/FilePersistence');

const branchFilename = __dirname + '/application_env';

const {properties:propsToSave} = require('../../rust/catalog/config-fields.json');

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

async function loadLegacy(defaults) {
    const {configFile, dataDir:defaultDataDir} = defaults;
    const recoveryDir = await fs.pathExists(configFile) ? (await fs.readJson(configFile)).dataDir || defaultDataDir : defaultDataDir;
    await require('../core/BackupTransaction').recover({...defaults,dataDir:recoveryDir});
    const raw = await fs.pathExists(configFile) ? _.pick(await fs.readJson(configFile),propsToSave) : null;
    const migrated = raw && await migrateWorkingDirectory(defaults,raw);
    const dataDir = raw?.dataDir || defaultDataDir;
    await require('../core/UpgradeSnapshot').prepare({...defaults,dataDir});
    if (!raw) return {config:null,needsSave:false};
    raw.dataDir = dataDir;
    const result = await new SecretStore(raw).unprotectConfig(raw);
    const {config} = result;
    let needsSave = migrated || result.needsSave;
    for (const [key,previous,current] of [
        ['latestReleaseLink','https://github.com/bookpauk/inpx-web/releases/latest','https://github.com/AceAsket/inpx-web/releases/latest'],
        ['checkReleaseLink','https://api.github.com/repos/bookpauk/inpx-web/releases/latest','https://api.github.com/repos/AceAsket/inpx-web/releases/latest'],
    ]) {
        if (!config[key] || config[key] === previous) {
            config[key] = current;
            needsSave = true;
        }
    }
    return {config,needsSave};
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
            config.dataDir = config.dataDir || defaultDataDir;
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
        const result = _.cloneDeep(this._config);
        Object.assign(result, require('../../shared/TelegramNetwork').environmentPatch(process.env));
        // Resource policy is launch-only and cannot be replaced by saved settings
        // or an administrator's imported configuration.
        result.conversionConcurrency = require('../core/ResourceRuntime').settings.limits.conversions;
        result.conversionTimeoutMs = require('../core/ResourceRuntime').settings.taskTimeoutMs;
        result.conversionQueueTimeoutMs = require('../core/ResourceRuntime').settings.taskTimeoutMs;
        // Explicit container limits must still win after config.json has been
        // saved by a previous launch. An empty optional variable uses the file.
        for (const [key, name] of [['dbCacheBudgetMb', 'INPX_DB_CACHE_BUDGET_MB'], ['queryCacheMemMb', 'INPX_QUERY_CACHE_MEM_MB'], ['queryCacheDiskMb', 'INPX_QUERY_CACHE_DISK_MB']]) {
            const value = process.env[name];
            if (value !== undefined && value.trim() !== '') result[key] = Number(value);
        }
        return result;
    }

    set config(value) {
        Object.assign(this._config, value);
    }

    async load() {
        try {
            if (!this.inited)
                throw new Error('not inited');

            const {configFile,dataDir,execDir,name,version} = this._config;
            const loaded = await native('load-config', [], {file:configFile,defaultDataDir:dataDir,execDir,name,version});
            const {config,needsSave} = loaded?.state === 'ready' ? loaded : await loadLegacy(this._config);
            if (config) {
                const discovery = Object.assign({}, this._config.discovery || {}, config.discovery || {});

                if (Object.prototype.hasOwnProperty.call(config, 'telegramIpFamily'))
                    config.telegramIpFamily = require('../../shared/TelegramNetwork').normalizeIpFamily(config.telegramIpFamily);
                Object.assign(config,require('../../shared/TelegramNetwork').normalizeProxyConfig({...this._config,...config}));
                this.config = config;
                this._config.discovery = discovery;
            }
            this._config.updateChannel = resolveUpdateChannel(this._config);
            this._config.installMode = await resolveInstallMode(this._config);
            if (!config || needsSave || config.allowConfigRewrite && propsToSave.some(prop=>!Object.hasOwn(config,prop)))
                await this.save();
        } catch(e) {
            throw new Error(`Error while loading "${this._config.configFile}": ${e.message}`);
        }
    }

    async save() {
        if (!this.inited)
            throw new Error('not inited');

        await withFileTransaction(this._config.configFile, async() => {
            const snapshot = _.cloneDeep(this._config);
            const config = _.pick(snapshot,propsToSave);
            const saved = await native('save-config', [], {file:snapshot.configFile,dataDir:snapshot.dataDir || '.',config});
            if (saved?.saved === true) return;
            const dataToSave = await new SecretStore(snapshot).protectConfig(config);
            await writeFileAtomic(snapshot.configFile, JSON.stringify(dataToSave, null, 4));
        });
    }
}

ConfigManager.propsToSave = propsToSave;

module.exports = ConfigManager;
