const crypto = require('crypto');
const fs = require('fs-extra');
const {promisify} = require('util');
const {pipeline} = require('stream/promises');
const scrypt = promisify(crypto.scrypt);
const MAGIC = Buffer.from('INPXWEB1');
const HEADER = 36, TAG = 16;

function isEncrypted(buffer) {return buffer.length >= MAGIC.length && buffer.subarray(0, 8).equals(MAGIC);}
async function derive(password, salt) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 1024)
        throw new Error('Пароль резервной копии должен содержать от 10 до 1024 символов');
    if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new Error('Повреждены параметры шифрования резервной копии');
    return scrypt(password, salt, 32, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
}
async function encryptStream(input, output, key, salt) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const temporary = `${output}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
        await fs.writeFile(temporary, Buffer.concat([MAGIC, salt, iv]), {flag: 'wx', mode: 0o600});
        await pipeline(input, cipher, fs.createWriteStream(temporary, {flags: 'a', mode: 0o600}));
        await fs.appendFile(temporary, cipher.getAuthTag());
        const handle = await fs.open(temporary, 'r+');
        try {await fs.fsync(handle);} finally {await fs.close(handle);}
        await fs.rename(temporary, output);
    } finally {key.fill(0); await fs.remove(temporary);}
}
async function encryptFile(input, output, key, salt) {return encryptStream(fs.createReadStream(input), output, key, salt);}
async function decrypt(buffer, password) {
    if (!isEncrypted(buffer)) return buffer;
    if (buffer.length < HEADER + TAG) throw new Error('Зашифрованная резервная копия повреждена');
    const key = await derive(password, buffer.subarray(8, 24));
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(24, HEADER));
        decipher.setAuthTag(buffer.subarray(buffer.length - TAG));
        return Buffer.concat([decipher.update(buffer.subarray(HEADER, -TAG)), decipher.final()]);
    } catch {throw new Error('Неверный пароль резервной копии или файл повреждён');}
    finally {key.fill(0);}
}
module.exports = {MAGIC, derive, encryptFile, encryptStream, decrypt, isEncrypted};
