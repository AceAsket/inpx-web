const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const encryptedPrefix = 'enc:v1:';
const secretFields = [
    'telegramBotToken',
    'smtpPass',
    'opds.password',
    'metricsToken',
];

function getPath(obj = {}, field = '') {
    return String(field || '').split('.').reduce((acc, key) => (
        acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
    ), obj);
}

function setPath(obj = {}, field = '', value) {
    const parts = String(field || '').split('.');
    let target = obj;
    while (parts.length > 1) {
        const key = parts.shift();
        if (!target[key] || typeof(target[key]) !== 'object')
            target[key] = {};
        target = target[key];
    }
    target[parts[0]] = value;
}

function clonePlain(value = {}) {
    return JSON.parse(JSON.stringify(value || {}));
}

class SecretStore {
    constructor(config = {}) {
        this.config = config;
        this.keyFile = path.join(config.dataDir || '.', 'secret.key');
    }

    static isEncrypted(value) {
        return (typeof(value) === 'string' && value.startsWith(encryptedPrefix));
    }

    async getKey(create = true) {
        let raw;
        try {
            raw = await fs.readFile(this.keyFile, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            if (!create)
                throw new Error('Secret key is missing; restore secret.key from backup');

            await fs.ensureDir(path.dirname(this.keyFile));
            const temporary = `${this.keyFile}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
            try {
                const handle = await require('fs').promises.open(temporary, 'wx', 0o600);
                try {
                    await handle.writeFile(crypto.randomBytes(32).toString('base64'));
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                // Publish a complete key without overwriting another process's winner.
                try {
                    await fs.link(temporary, this.keyFile);
                } catch (linkError) {
                    if (linkError.code !== 'EEXIST')
                        throw linkError;
                }
            } finally {
                await fs.remove(temporary);
            }
            raw = await fs.readFile(this.keyFile, 'utf8');
        }

        const key = Buffer.from(String(raw).trim(), 'base64');
        if (key.length !== 32)
            throw new Error('Invalid secret key length');
        return key;
    }

    async encrypt(value) {
        const text = String(value || '');
        if (!text || SecretStore.isEncrypted(text))
            return text;

        const key = await this.getKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([
            cipher.update(text, 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();

        return [
            encryptedPrefix.slice(0, -1),
            iv.toString('base64'),
            tag.toString('base64'),
            encrypted.toString('base64'),
        ].join(':');
    }

    async decrypt(value) {
        const text = String(value || '');
        if (!SecretStore.isEncrypted(text))
            return text;

        const [, , ivRaw, tagRaw, dataRaw] = text.split(':');
        if (!ivRaw || !tagRaw || !dataRaw)
            throw new Error('Invalid encrypted secret format');

        const key = await this.getKey(false);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'));
        decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));

        return Buffer.concat([
            decipher.update(Buffer.from(dataRaw, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    }

    async unprotectConfig(config = {}) {
        const result = clonePlain(config);
        let needsSave = false;

        for (const field of secretFields) {
            const valueRaw = getPath(result, field);
            if (valueRaw === undefined)
                continue;

            const value = String(valueRaw || '');
            if (SecretStore.isEncrypted(value)) {
                setPath(result, field, await this.decrypt(value));
            } else if (value) {
                needsSave = true;
            }
        }

        return {config: result, needsSave};
    }

    async protectConfig(config = {}) {
        const result = clonePlain(config);

        for (const field of secretFields) {
            const value = getPath(result, field);
            if (value !== undefined)
                setPath(result, field, await this.encrypt(value));
        }

        return result;
    }
}

module.exports = SecretStore;
