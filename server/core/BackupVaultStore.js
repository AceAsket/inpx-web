const path = require('node:path');
const fs = require('fs-extra');
const {writeFileAtomic} = require('./FilePersistence');
const {RustLookupIndex, executable} = require('./RustLookupIndex');
const runtime = require('./ResourceRuntime');

const namePattern = /^inpx-web-(?:auto-)?backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.zip(?:\.enc)?$/;
const failedCopy = 'Не удалось создать копию. Проверьте журнал и место на диске.';

class LegacyBackupStore {
    constructor(dataDir) {
        this.file = path.join(dataDir,'backup-vault.json');
        this.directory = path.join(dataDir,'backups');
    }

    async policy(window) {
        let value;
        try {value = await fs.readJson(this.file);} catch (error) {if (error.code !== 'ENOENT') throw error; value = {};}
        const policy = {version:1, enabled:value.enabled === true,
            hour:Number.isInteger(value.hour) && value.hour >= 0 && value.hour <= 23 ? value.hour : 3,
            keep:Number.isInteger(value.keep) && value.keep >= 1 && value.keep <= 60 ? value.keep : 7,
            key:value.key || '', salt:value.salt || '', lastScheduledAt:value.lastScheduledAt || '', lastError:value.lastError || ''};
        if (window) {
            const time = new Date(policy.lastScheduledAt).getTime();
            if (!policy.enabled || !policy.key || window.hour < policy.hour || (time >= window.dayStart && time < window.nextDay))
                return null;
        }
        return policy;
    }

    async due(window) {return !!await this.policy(window);}

    async edit(mutate) {
        const policy = await this.policy();
        mutate(policy);
        await writeFileAtomic(this.file, JSON.stringify(policy,null,2));
    }

    async update(patch, key) {
        await this.edit(policy => {
            if (key) Object.assign(policy,key);
            if (patch.clearPassword === true) {policy.key = ''; policy.salt = ''; policy.enabled = false;}
            if (patch.hour !== undefined) {
                if (!Number.isInteger(patch.hour) || patch.hour < 0 || patch.hour > 23) throw new Error('Укажите час от 0 до 23');
                policy.hour = patch.hour;
            }
            if (patch.keep !== undefined) {
                if (!Number.isInteger(patch.keep) || patch.keep < 1 || patch.keep > 60) throw new Error('Можно хранить от 1 до 60 автоматических копий');
                policy.keep = patch.keep;
            }
            if (patch.enabled !== undefined) policy.enabled = patch.enabled === true;
            if (policy.enabled && !policy.key) throw new Error('Для автоматических копий сначала задайте пароль');
        });
    }

    markCreated(timestamp) {return this.edit(policy => {policy.lastScheduledAt = timestamp; policy.lastError = '';});}
    markFailed() {return this.edit(policy => {policy.lastError = failedCopy;});}

    async inspect(name) {
        if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('Некорректное имя резервной копии');
        const stat = await fs.lstat(path.join(this.directory,name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Резервная копия недоступна');
        return stat.size;
    }

    async list(scheduled = false) {
        let names;
        try {names = await fs.readdir(this.directory);} catch (error) {if (error.code === 'ENOENT') return []; throw error;}
        const result = [];
        const timestamp = name => name.replace(/^inpx-web-(?:auto-)?backup-/, '');
        for (const name of names.filter(name => namePattern.test(name) && (!scheduled || name.includes('-auto-')))
            .sort((a,b) => timestamp(b).localeCompare(timestamp(a))).slice(0,500)) {
            try {
                await this.inspect(name);
                const stat = await fs.stat(path.join(this.directory,name));
                result.push({name,size:stat.size,modifiedMs:stat.mtime.getTime(),encrypted:name.endsWith('.enc'),scheduled:name.includes('-auto-')});
            } catch (error) {if (error.code !== 'ENOENT') throw error;}
        }
        return result.sort((a,b) => b.modifiedMs-a.modifiedMs);
    }

    async remove(name) {
        await this.inspect(name);
        await fs.unlink(path.join(this.directory,name));
    }

    async rotate(keep) {
        for (const row of (await this.list(true)).slice(keep)) {
            try {await this.remove(row.name);} catch (error) {if (error.code !== 'ENOENT') throw error;}
        }
    }
}

class RustBackupStore {
    constructor(dataDir,binary) {
        this.dataDir = path.resolve(dataDir);
        this.binary = binary;
        this.pending = new Set();
    }

    async query(op,fields = {}) {
        clearTimeout(this.idle);
        this.client ||= new RustLookupIndex(this.dataDir,null,{
            binary:this.binary, file:this.dataDir, generation:'vault', command:'backup-vault',
        });
        const client = this.client;
        const operation = runtime.withSignal(undefined,() => client.run(
            process => process.query({op,...fields}),
            () => {throw new Error(client.lastError || 'Процесс резервного копирования недоступен');},
        ));
        this.pending.add(operation);
        try {
            const response = await operation;
            if (typeof response?.message === 'string') {
                const error = new Error(response.message);
                if (response.notFound) error.code = 'ENOENT';
                throw error;
            }
            if (!response || !Object.hasOwn(response,'value')) throw new Error('Некорректный ответ хранилища резервных копий');
            return response.value;
        } finally {
            this.pending.delete(operation);
            if (!this.held && !this.pending.size && this.client === client)
                this.idle = setTimeout(() => {void this.stop();},1000);
        }
    }

    policy(window) {return this.query('policy',{window});}
    due(window) {return this.query('due',{window});}
    update(patch,key) {return this.query('update',{patch,key});}
    markCreated(timestamp) {return this.query('markCreated',{timestamp});}
    markFailed() {return this.query('markFailed');}
    list(scheduled = false) {return this.query('list',{scheduled});}
    inspect(name) {return this.query('inspect',{name:typeof name === 'string' ? name : ''});}
    remove(name) {return this.query('remove',{name:typeof name === 'string' ? name : ''});}
    rotate(keep) {return this.query('rotate',{keep});}

    start() {
        this.held = true;
        return this.query('probe');
    }

    async stop() {
        clearTimeout(this.idle);
        this.held = false;
        const client = this.client;
        this.client = null;
        await Promise.allSettled([...this.pending]);
        await client?.close();
    }
}

function openBackupStore(dataDir) {
    const binary = executable();
    return binary ? new RustBackupStore(dataDir,binary) : new LegacyBackupStore(dataDir);
}

module.exports = {openBackupStore, namePattern};
