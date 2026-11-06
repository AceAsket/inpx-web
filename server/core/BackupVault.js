const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const {withFileTransactions, withFileTransaction, writeFileAtomic} = require('./FilePersistence');
const SecretStore = require('./SecretStore');
const encryption = require('./BackupCrypto');
const namePattern = /^inpx-web-(?:auto-)?backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.zip(?:\.enc)?$/;

class BackupVault {
    constructor(worker) {
        this.worker = worker; this.config = worker.config;
        this.policyFile = path.join(this.config.dataDir, 'backup-vault.json');
        this.directory = path.join(this.config.dataDir, 'backups');
        this.secret = new SecretStore(this.config);
        this.running = false;
    }
    async policy() {
        let value;
        try {value = await fs.readJson(this.policyFile);} catch (e) {if (e.code !== 'ENOENT') throw e; value = {};}
        return {version: 1, enabled: value.enabled === true, hour: Number.isInteger(value.hour) && value.hour >= 0 && value.hour <= 23 ? value.hour : 3,
            keep: Number.isInteger(value.keep) && value.keep >= 1 && value.keep <= 60 ? value.keep : 7,
            key: value.key || '', salt: value.salt || '', lastScheduledAt: value.lastScheduledAt || '', lastError: value.lastError || ''};
    }
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
            const policy = await this.policy();
            if (options.password !== undefined && options.password !== '') {
                const salt = crypto.randomBytes(16), key = await encryption.derive(options.password, salt);
                try {policy.key = await this.secret.encrypt(key.toString('base64')); policy.salt = salt.toString('base64');}
                finally {key.fill(0);}
            }
            if (options.clearPassword === true) {policy.key = ''; policy.salt = ''; policy.enabled = false;}
            if (options.hour !== undefined) {
                if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) throw new Error('Укажите час от 0 до 23');
                policy.hour = options.hour;
            }
            if (options.keep !== undefined) {
                if (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 60) throw new Error('Можно хранить от 1 до 60 автоматических копий');
                policy.keep = options.keep;
            }
            if (options.enabled !== undefined) policy.enabled = options.enabled === true;
            if (policy.enabled && !policy.key) throw new Error('Для автоматических копий сначала задайте пароль');
            await writeFileAtomic(this.policyFile, JSON.stringify(policy, null, 2));
        });
        return this.status();
    }
    async path(name) {
        if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('Некорректное имя резервной копии');
        const file = path.join(this.directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Резервная копия недоступна');
        return file;
    }
    async list(scheduledOnly = false) {
        let names;
        try {names = await fs.readdir(this.directory);} catch (e) {if (e.code === 'ENOENT') return []; throw e;}
        const result = [];
        const timestamp = name => name.replace(/^inpx-web-(?:auto-)?backup-/, '');
        for (const name of names.filter(name => namePattern.test(name) && (!scheduledOnly || name.includes('-auto-')))
            .sort((a, b) => timestamp(b).localeCompare(timestamp(a))).slice(0, 500)) {
            try {
                const file = await this.path(name), stat = await fs.stat(file);
                result.push({name, size: stat.size, createdAt: stat.mtime.toISOString(), encrypted: name.endsWith('.enc'), scheduled: name.includes('-auto-'),
                    link: `${String(this.config.rootPathStatic || '').replace(/\/$/, '')}/admin-backups/${encodeURIComponent(name)}`});
            } catch (e) {if (e.code !== 'ENOENT') throw e;}
        }
        return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    async create({scheduled = false} = {}) {
        if (this.running) throw new Error('Резервная копия уже создаётся');
        this.running = true;
        try {
            const files = Object.values(require('./BackupTransaction').targets(this.config));
            return await withFileTransactions(files, async() => {
                const policy = await this.policy();
                if (scheduled && (!policy.enabled || !policy.key)) return null;
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
                    if (scheduled) {
                        policy.lastScheduledAt = new Date().toISOString(); policy.lastError = '';
                        await writeFileAtomic(this.policyFile, JSON.stringify(policy, null, 2));
                    }
                } catch (e) {
                    if (result?.fileName) await fs.remove(path.join(this.directory, result.fileName)).catch(() => {});
                    throw e;
                } finally {if (key) key.fill(0);}
                this.worker.addAdminEvent('info', 'backup', scheduled ? 'Создана автоматическая резервная копия' : 'Создана резервная копия');
                if (scheduled) {
                    const automatic = await this.list(true);
                    for (const row of automatic.slice(policy.keep)) await fs.remove(await this.path(row.name));
                }
                return result;
            });
        } finally {this.running = false;}
    }
    async payload(name, password) {
        const file = await this.path(name), stat = await fs.stat(file);
        if (stat.size > require('./RequestLimits').limits(this.config).backup) throw new Error('Превышен размер резервной копии');
        return {contentBase64: (await fs.readFile(file)).toString('base64'), password};
    }
    async remove(name) {
        if (this.running) throw new Error('Дождитесь окончания создания резервной копии');
        await fs.remove(await this.path(name)); return this.status();
    }
    async tick(now = new Date()) {
        if (this.running || this.worker.myState !== 'normal') return;
        const policy = await this.policy();
        if (!policy.enabled || now.getHours() < policy.hour) return;
        const previous = new Date(policy.lastScheduledAt);
        if (Number.isFinite(previous.getTime()) && previous.toDateString() === now.toDateString()) return;
        try {await this.create({scheduled: true});}
        catch (e) {
            this.worker.addAdminEvent('error', 'backup', `Не удалось создать автоматическую копию: ${e.message}`);
            await withFileTransaction(this.policyFile, async() => {
                const fresh = await this.policy(); fresh.lastError = 'Не удалось создать копию. Проверьте журнал и место на диске.';
                await writeFileAtomic(this.policyFile, JSON.stringify(fresh, null, 2));
            });
            // A failed disk or password must not cause a retry loop every minute.
            this.retryAfter = Date.now() + 60 * 60 * 1000;
        }
    }
    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (Date.now() < (this.retryAfter || 0) || this.ticking) return;
            this.ticking = this.tick().catch(e => this.worker.addAdminEvent('error', 'backup', e.message)).finally(() => {this.ticking = null;});
        }, 60000);
        this.timer.unref();
    }
    stop() {clearInterval(this.timer); this.timer = null;}
}
module.exports = BackupVault;
module.exports.namePattern = namePattern;
