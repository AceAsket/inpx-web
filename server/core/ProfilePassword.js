const crypto = require('crypto');
const {promisify} = require('util');
const native = require('./RustCredentials');
const scrypt = promisify(crypto.scrypt);

// OWASP's 16 MiB scrypt configuration; version fixes costs independently of input.
const prefix = 'scrypt:v1:';
const options = {N: 16384, r: 8, p: 5, maxmem: 32*1024*1024};
const maxPasswordBytes = 4096;
let active = 0;

function legacy(login, password) {
    return crypto.createHash('sha256').update(`${String(login || '').trim().toLowerCase()}::${String(password || '')}`).digest('hex');
}

async function withScrypt(task) {
    if (active >= 4)
        throw new Error('Проверка паролей занята, повторите позже');
    active++;
    try {
        return await task();
    } finally {
        active--;
    }
}

async function hash(password) {
    const text = String(password || '');
    if (Buffer.byteLength(text) > maxPasswordBytes) throw new Error('Пароль слишком длинный');
    return withScrypt(async () => {
        if (native.executable()) return native.hash(text);
        const salt = crypto.randomBytes(16);
        const key = await scrypt(text, salt, 32, options);
        try {return `${prefix}${salt.toString('hex')}:${key.toString('hex')}`;}
        finally {key.fill(0);}
    });
}

function isLegacy(value) {
    return /^[a-f0-9]{64}$/.test(value);
}

async function verify(stored, login, password) {
    const text = String(password || '');
    if (Buffer.byteLength(text) > maxPasswordBytes)
        return false;
    if (isLegacy(stored)) {
        if (native.executable()) return native.verify(String(stored),String(login || '').trim().toLowerCase(),text,true);
        return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(legacy(login, password), 'hex'));
    }
    const match = /^scrypt:v1:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(stored);
    if (!match)
        return false;
    return withScrypt(async () => {
        if (native.executable()) return native.verify(String(stored),'',text,false);
        const key = await scrypt(text, Buffer.from(match[1], 'hex'), 32, options);
        try {return crypto.timingSafeEqual(key, Buffer.from(match[2], 'hex'));}
        finally {key.fill(0);}
    });
}

module.exports = {hash, verify, isLegacy, legacy, maxPasswordBytes, withScrypt};
