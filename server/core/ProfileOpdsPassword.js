const crypto = require('node:crypto');
const native = require('./RustCredentials');

const passwordPattern = /^inpx_[A-Za-z0-9_-]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function digest(password) {
    return crypto.createHash('sha256').update(password).digest();
}

async function issue() {
    if (native.executable()) return native.issueOpdsPassword();
    const password = 'inpx_' + crypto.randomBytes(24).toString('base64url');
    return {password, hash:digest(password).toString('hex')};
}

async function verify(stored, password) {
    if (typeof password !== 'string' || !passwordPattern.test(password) || !hashPattern.test(stored)) return false;
    if (native.executable()) return native.verifyOpdsPassword(stored,password);
    return crypto.timingSafeEqual(digest(password),Buffer.from(stored,'hex'));
}

module.exports = {issue, verify};
