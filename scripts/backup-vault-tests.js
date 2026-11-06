const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const crypto = require('crypto');
require('../server/core/Logger');

async function testEncryptedBackupPreviewRestoreAndRotation() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-vault-'));
    try {
        const logger = new (require('../server/core/AppLogger'))();
        if (!logger.inited) await logger.init({loggingEnabled: false, name: 'backup-vault-tests'});
        const WebWorker = require('../server/core/WebWorker');
        const worker = Object.create(WebWorker.prototype);
        worker.config = {name: 'inpx-web', version: 'test', dataDir: dir, tempDir: dir, adminPassword: 'vault-integration-test-password',
            configFile: path.join(dir, 'config.json'), rootPathStatic: '/library', librarySources: []};
        worker.checkMyState = () => {}; worker.requireAdmin = async() => ({id: 'admin'});
        worker.addAdminEvent = () => {}; worker.profileSessions = new Map(); worker.myState = 'normal';
        worker.normalizeImportedAdminSettings = () => {};
        worker.readingListStore = new (require('../server/core/ReadingListStore'))(worker.config);
        await worker.readingListStore.load();
        await fs.writeJson(worker.config.configFile, {name: 'inpx-web', librarySources: []});
        const vault = worker.getBackupVault();
        await assert.rejects(vault.update({enabled: true}), /пароль/);
        await vault.update({password: 'a production backup password', enabled: true, hour: 0, keep: 2});
        const policyRaw = await fs.readFile(vault.policyFile, 'utf8');
        assert(!policyRaw.includes('a production backup password'));
        assert(JSON.parse(policyRaw).key.startsWith('enc:v1:'));
        const created = await worker.createAdminBackup('admin', 'test');
        assert(created.encrypted && created.fileName.endsWith('.zip.enc'));
        const contents = await fs.readFile(await vault.path(created.fileName));
        assert(contents.subarray(0, 8).equals(Buffer.from('INPXWEB1')));
        assert(!contents.includes(Buffer.from('config.json')));
        assert(!(await fs.readdir(vault.directory)).some(name => name.endsWith('.zip') || name.includes('.tmp')), 'Encrypted snapshots leave no plaintext or partial files');
        const payload = {contentBase64: contents.toString('base64'), password: 'a production backup password', preview: true};
        const before = await fs.readFile(worker.config.configFile, 'utf8');
        const preview = await worker.importAdminBackup('admin', 'test', payload);
        assert.strictEqual(preview.encrypted, true); assert(preview.users >= 1);
        assert.strictEqual(await fs.readFile(worker.config.configFile, 'utf8'), before, 'Preview never commits files');
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, password: 'the wrong password'}), /пароль|повреждён/);
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, fingerprint: 'changed'}), /изменился/);
        const tampered = Buffer.from(contents); tampered[tampered.length - 1] ^= 1;
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, contentBase64: tampered.toString('base64')}), /пароль|повреждён/);
        const restored = await worker.importAdminBackup('admin', 'test', {...payload, preview: false, fingerprint: preview.fingerprint});
        assert(restored.success && restored.restored.includes('reading-lists.json'));
        assert.strictEqual((await vault.status()).passwordSet, true);
        for (let i = 0; i < 3; i++) await vault.create({scheduled: true});
        const list = await vault.list();
        assert.strictEqual(list.filter(item => item.scheduled).length, 2);
        assert(list.some(item => item.name === created.fileName), 'Rotation preserves manual snapshots');
        const last = (await vault.policy()).lastScheduledAt;
        await vault.tick(new Date()); assert.strictEqual((await vault.policy()).lastScheduledAt, last, 'A daily backup is not repeated');
        await assert.rejects(vault.path('../config.json'));
        await vault.update({clearPassword: true}); assert.strictEqual((await vault.status()).enabled, false);
        const plain = await worker.createAdminBackup('admin', 'test');
        const legacyPayload = await vault.payload(plain.fileName);
        assert.strictEqual((await worker.importAdminBackup('admin', 'test', {...legacyPayload, preview: true})).encrypted, false);
        const key = await require('../server/core/BackupCrypto').derive('unicode пароль 🔑', crypto.randomBytes(16));
        assert.strictEqual(key.length, 32); key.fill(0);
        const redacted = require('../server/core/SensitiveLog').redact({action: 'preview-admin-backup', data: payload, options: {password: 'secret'}, profileAccessToken: 'token'});
        assert(!JSON.stringify(redacted).includes('a production backup password')); assert(!JSON.stringify(redacted).includes('secret'));
    } finally {await fs.remove(dir);}
}
module.exports = {testEncryptedBackupPreviewRestoreAndRotation};
if (require.main === module) testEncryptedBackupPreviewRestoreAndRotation().then(() => console.log('Backup vault: OK')).catch(error => {console.error(error); process.exitCode = 1;});
