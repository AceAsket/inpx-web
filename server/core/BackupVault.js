const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const {withFileTransactions, withFileTransaction} = require('./FilePersistence');
const {openBackupStore, namePattern} = require('./BackupVaultStore');
const {executable} = require('./RustLookupIndex');
const SecretStore = require('./SecretStore');
const encryption = require('./BackupCrypto');

function scheduleWindow(now) {
    const start = new Date(now);
    start.setHours(0,0,0,0);
    const end = new Date(now);
    end.setDate(now.getDate()+1);
    end.setHours(0,0,0,0);
    return {hour:now.getHours(), dayStart:start.getTime(), nextDay:end.getTime()};
}

class BackupVault {
    constructor(worker) {
        this.worker = worker; this.config = worker.config;
        this.policyFile = path.join(this.config.dataDir, 'backup-vault.json');
        this.directory = path.join(this.config.dataDir, 'backups');
        this.secret = new SecretStore(this.config);
        this.store = openBackupStore(this.config.dataDir);
        this.running = false;
    }
    policy() {return this.store.policy();}
    async status() {
        const policy = await this.policy();
        return {enabled: policy.enabled, hour: policy.hour, keep: policy.keep, passwordSet: !!policy.key,
            lastScheduledAt: policy.lastScheduledAt, lastError: policy.lastError, running: this.running,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            uploadLimit: require('./RequestLimits').limits(this.config).backup,
            backups: await this.list()};
    }
    async update(options = {}) {
        await withFileTransaction(this.policyFile, async() => {
            let replacement = null;
            if (options.password !== undefined && options.password !== '') {
                const salt = crypto.randomBytes(16), key = await encryption.derive(options.password, salt);
                try {replacement = {key:await this.secret.encrypt(key.toString('base64')), salt:salt.toString('base64')};}
                finally {key.fill(0);}
            }
            const {clearPassword,hour,keep,enabled} = options;
            await this.store.update({clearPassword,hour,keep,enabled},replacement);
        });
        return this.status();
    }
    async path(name) {
        await this.store.inspect(name);
        return path.join(this.directory,name);
    }
    async list(scheduledOnly = false) {
        const prefix = `${String(this.config.rootPathStatic || '').replace(/\/$/, '')}/admin-backups/`;
        return (await this.store.list(scheduledOnly)).map(({modifiedMs,...row}) => ({
            ...row, createdAt:new Date(modifiedMs).toISOString(), link:prefix+encodeURIComponent(row.name),
        }));
    }
    async create({scheduled = false, window} = {}) {
        if (this.running) throw new Error('Резервная копия уже создаётся');
        this.running = true;
        try {
            const files = Object.values(require('./BackupTransaction').targets(this.config));
            return await withFileTransactions(files, async() => {
                const policy = await this.store.policy(window);
                if (scheduled && (!policy?.enabled || !policy.key)) return null;
                let key = null, salt;
                if (policy.key) {
                    key = Buffer.from(await this.secret.decrypt(policy.key), 'base64'); salt = Buffer.from(policy.salt, 'base64');
                    if (key.length !== 32 || salt.length !== 16) throw new Error('Повреждены настройки шифрования. Задайте пароль заново');
                }
                let result;
                try {
                    result = await this.worker.writeAdminBackupSnapshot({scheduled, encryption: key ? {key, salt} : null});
                    const source = path.join(this.directory, result.fileName);
                    if ((await fs.stat(source)).size > require('./RequestLimits').limits(this.config).backup)
                        throw new Error('Резервная копия превышает лимит восстановления. Увеличьте backupUploadLimitMb');
                    result.encrypted = !!key;
                    if (scheduled) await this.store.markCreated(new Date().toISOString());
                } catch (e) {
                    if (result?.fileName) await fs.remove(path.join(this.directory, result.fileName)).catch(() => {});
                    throw e;
                } finally {if (key) key.fill(0);}
                this.worker.addAdminEvent('info', 'backup', scheduled ? 'Создана автоматическая резервная копия' : 'Создана резервная копия');
                if (scheduled) await this.store.rotate(policy.keep);
                return result;
            });
        } finally {this.running = false;}
    }
    async payload(name, password) {
        const size = await this.store.inspect(name);
        if (size > require('./RequestLimits').limits(this.config).backup) throw new Error('Превышен размер резервной копии');
        const file = path.join(this.directory,name);
        return {contentBase64: (await fs.readFile(file)).toString('base64'), password};
    }
    restoreSource(name, password) {
        if (!executable()) return this.payload(name,password);
        return {password,[require('./BackupArchive').savedBackup]:name};
    }
    async remove(name) {
        if (this.running) throw new Error('Дождитесь окончания создания резервной копии');
        await this.store.remove(name); return this.status();
    }
    async tick(now = new Date()) {
        if (this.running || this.worker.myState !== 'normal') return;
        const window = scheduleWindow(now);
        if (!await this.store.due(window)) return;
        try {await this.create({scheduled:true,window});}
        catch (e) {
            this.worker.addAdminEvent('error', 'backup', `Не удалось создать автоматическую копию: ${e.message}`);
            await withFileTransaction(this.policyFile, () => this.store.markFailed());
            // A failed disk or password must not cause a retry loop every minute.
            this.retryAfter = Date.now() + 60 * 60 * 1000;
        }
    }
    start() {
        if (this.timer) return;
        this.store.start?.().catch(error => this.worker.addAdminEvent('error','backup',error.message));
        this.timer = setInterval(() => {
            if (Date.now() < (this.retryAfter || 0) || this.ticking) return;
            this.ticking = this.tick().catch(e => this.worker.addAdminEvent('error', 'backup', e.message)).finally(() => {this.ticking = null;});
        }, 60000);
        this.timer.unref();
    }
    async stop() {
        clearInterval(this.timer);
        this.timer = null;
        await this.ticking;
        await this.store.stop?.();
    }
}
module.exports = BackupVault;
module.exports.namePattern = namePattern;
