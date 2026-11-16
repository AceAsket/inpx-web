const crypto = require('crypto');
const {defaults} = require('./ProfileAuthPolicy');
const native = require('./RustCredentials');

const secondsPerDay = 24 * 60 * 60;
const maxDevices = 10;
const keyPattern = /^[0-9a-f]{64}$/;

function available(policy = defaults) {
    return policy.trustedBrowsersEnabled === true;
}

function digest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function active(devices, now = Date.now()) {
    if (!Array.isArray(devices)) return [];
    return devices.slice(-maxDevices).filter(device => device && typeof device.hash === 'string'
        && keyPattern.test(device.hash) && Number.isSafeInteger(device.expiresAt) && device.expiresAt > now)
        .map(({hash, expiresAt}) => ({hash, expiresAt}));
}

async function recognizes(devices, token) {
    if (typeof token !== 'string' || !keyPattern.test(token)) return false;
    const now = Date.now();
    const candidates = active(devices,now);
    if (!candidates.length) return false;
    if (native.executable()) return native.secondFactor({action:'recognizes',devices:candidates,token,now});
    const hash = Buffer.from(digest(token), 'hex');
    return candidates.some(device => crypto.timingSafeEqual(hash, Buffer.from(device.hash, 'hex')));
}

function remember(devices, replaced, days) {
    return {devices, replaced:typeof replaced === 'string' && keyPattern.test(replaced) ? replaced : '', days};
}

function issue(devices, replacedToken, days = defaults.trustedBrowserDays) {
    const now = Date.now();
    const maxAgeSeconds = days * secondsPerDay;
    const token = crypto.randomBytes(32).toString('hex');
    const replacedHash = typeof replacedToken === 'string' && keyPattern.test(replacedToken) ? digest(replacedToken) : '';
    const next = active(devices, now).filter(device => device.hash !== replacedHash);
    next.push({hash:digest(token), expiresAt:now + maxAgeSeconds * 1000});
    return {token, maxAgeSeconds, devices:next.slice(-maxDevices)};
}

module.exports = {active, available, recognizes, remember, issue};
