const crypto = require('crypto');
const {resolve} = require('node:path');
const SecretStore = require('./SecretStore');
const native = require('./RustCredentials');
const trustedDevices = require('./ProfileTrustedDevices');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const period = 30;
const recoveryCount = 8;
const secretPattern = /^[A-Z2-7]{32}$/;
const recoveryPattern = /^[A-Z2-7]{20}$/;
const hashPattern = /^[0-9a-f]{64}$/;

function encodeBase32(bytes) {
    let value = 0, bits = 0, result = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += alphabet[(value >>> bits) & 31];
        }
    }
    if (bits) result += alphabet[(value << (5 - bits)) & 31];
    return result;
}

function decodeSecret(secret) {
    if (!secretPattern.test(secret)) throw new Error('Некорректный секрет двухфакторной защиты');
    const bytes = Buffer.alloc(20);
    let value = 0, bits = 0, index = 0;
    for (const letter of secret) {
        value = (value << 5) | alphabet.indexOf(letter);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes[index++] = (value >>> bits) & 255;
        }
    }
    return bytes;
}

function hotp(key, step, digits = 6) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = digest.at(-1) & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

function verify(secret, code, lastStep = -1, now = Date.now()) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const key = decodeSecret(secret);
    const provided = Buffer.from(code);
    const step = Math.floor(now / (period * 1000));
    for (const candidate of [step, step - 1, step + 1]) {
        if (candidate >= 0 && crypto.timingSafeEqual(provided, Buffer.from(hotp(key, candidate))))
            return candidate > lastStep ? candidate : null;
    }
    return null;
}

async function start(login) {
    const secret = native.executable() ? await native.secondFactor({action:'start'}) : encodeBase32(crypto.randomBytes(20));
    const issuer = 'inpx-web';
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(login)}`;
    const query = new URLSearchParams({secret, issuer, algorithm:'SHA1', digits:'6', period:String(period)});
    return {secret, otpAuthUri:`otpauth://totp/${label}?${query}`};
}

function normalize(value) {
    if (value == null) return null;
    return {
        // Retain enabled state on storage damage so password alone cannot bypass it.
        secret: SecretStore.isEncrypted(value.secret) ? value.secret : '',
        lastStep: Number.isSafeInteger(value.lastStep) && value.lastStep >= 0 ? value.lastStep : -1,
        recoveryHashes: Array.isArray(value.recoveryHashes)
            ? [...new Set(value.recoveryHashes.slice(0, recoveryCount).filter(hash => typeof hash === 'string' && hashPattern.test(hash)))]
            : [],
    };
}

function recoveryHash(userId, code) {
    return crypto.createHash('sha256').update(userId).update('\0').update(code).digest('hex');
}

function legacyRecoveryCodes(userId) {
    const recoveryCodes = Array.from({length:recoveryCount},
        () => encodeBase32(crypto.randomBytes(12)).match(/.{5}/g).join('-'));
    const recoveryHashes = recoveryCodes.map(code => recoveryHash(userId, code.replace(/-/g, '')));
    return {recoveryCodes, recoveryHashes};
}

async function newRecoveryCodes(userId) {
    if (native.executable()) return native.secondFactor({action:'recovery',user:userId.toWellFormed()});
    return legacyRecoveryCodes(userId);
}

function validChoice(code) {
    return typeof code === 'string' && code.length <= 64;
}

async function readSecret(secretStore, userId, state) {
    if (native.executable() && secretStore.keyFile) {
        return native.secondFactor({action:'read', file:resolve(secretStore.keyFile), user:userId.toWellFormed(), state});
    }
    const decrypted = await secretStore.decrypt(state.secret);
    const prefix = userId + '\n';
    if (!decrypted.startsWith(prefix) || !secretPattern.test(decrypted.slice(prefix.length)))
        throw new Error('Секрет двухфакторной защиты повреждён');
    return decrypted.slice(prefix.length);
}

async function consumeLegacy(secretStore, userId, state, provided, now) {
    if (!validChoice(provided)) return null;
    if (/^\d{6}$/.test(provided)) {
        const secret = await readSecret(secretStore, userId, state).catch(() => '');
        if (!secret) return null;
        const lastStep = verify(secret, provided, state.lastStep, now);
        return lastStep === null ? null : {...state, lastStep};
    }
    const code = provided.replace(/[\s-]/g, '').toUpperCase();
    if (!recoveryPattern.test(code)) return null;
    const hash = Buffer.from(recoveryHash(userId, code), 'hex');
    const remaining = state.recoveryHashes.filter(value => !crypto.timingSafeEqual(hash, Buffer.from(value, 'hex')));
    return remaining.length === state.recoveryHashes.length ? null : {...state, recoveryHashes:remaining};
}

async function consumeWithTrust(secretStore, userId, state, provided, now = Date.now(), remember) {
    if (!validChoice(provided)) return null;
    if (native.executable() && secretStore.keyFile) {
        return native.secondFactor({action:'consume', file:resolve(secretStore.keyFile), user:userId.toWellFormed(),
            state, code:provided.toWellFormed(), now, remember});
    }
    const accepted = await consumeLegacy(secretStore,userId,state,provided,now);
    if (!accepted) return null;
    const grant = remember && /^\d{6}$/.test(provided)
        ? trustedDevices.issue(remember.devices,remember.replaced,remember.days)
        : null;
    return {state:accepted,grant};
}

async function consume(secretStore, userId, state, provided, now) {
    return (await consumeWithTrust(secretStore,userId,state,provided,now))?.state || null;
}

async function enable(secretStore, userId, secret, lastStep) {
    if (native.executable() && secretStore.keyFile) {
        return native.secondFactor({action:'enable',file:resolve(secretStore.keyFile),user:userId.toWellFormed(),secret,lastStep});
    }
    const {recoveryCodes, recoveryHashes} = legacyRecoveryCodes(userId);
    return {state:{secret:await secretStore.encrypt(userId + '\n' + secret), lastStep, recoveryHashes}, recoveryCodes};
}

async function confirm(secretStore,userId,secret,code,now=Date.now()) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    if (native.executable() && secretStore.keyFile) {
        return native.secondFactor({action:'confirm',file:resolve(secretStore.keyFile),user:userId.toWellFormed(),secret,code,now});
    }
    const step = verify(secret,code,-1,now);
    return step === null ? null : enable(secretStore,userId,secret,step);
}

module.exports = {start, normalize, verify, hotp, consume, consumeWithTrust, enable, confirm, newRecoveryCodes, readSecret};
