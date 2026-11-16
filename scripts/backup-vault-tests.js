const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const crypto = require('crypto');
const {openBackupStore} = require('../server/core/BackupVaultStore');
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
        worker.addAdminEvent = () => {}; worker.myState = 'normal';
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
        const saved = await worker.adminBackupVault('admin','test','preview',{name:created.fileName,password:payload.password});
        assert.deepStrictEqual(saved,preview);
        assert.strictEqual(preview.encrypted, true); assert(preview.users >= 1);
        assert.strictEqual(await fs.readFile(worker.config.configFile, 'utf8'), before, 'Preview never commits files');
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, password: 'the wrong password'}), /пароль|повреждён/);
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, fingerprint: 'changed'}), /изменился/);
        const tampered = Buffer.from(contents); tampered[tampered.length - 1] ^= 1;
        await assert.rejects(worker.importAdminBackup('admin', 'test', {...payload, contentBase64: tampered.toString('base64')}), /пароль|повреждён/);
        await assert.rejects(worker.adminBackupVault('admin','test','restore',{
            name:created.fileName,password:payload.password,fingerprint:'changed',
        }),/изменился/);
        await assert.rejects(worker.adminBackupVault('admin','test','preview',{name:'../outside.zip'}),/Некорректное имя/);
        const restored = await worker.adminBackupVault('admin','test','restore',{
            name:created.fileName,password:payload.password,fingerprint:preview.fingerprint,
        });
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
function openWithBinary(directory, binary) {
    const previous = process.env.INPX_RUST_CATALOG_BINARY;
    try {
        if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
        else delete process.env.INPX_RUST_CATALOG_BINARY;
        return openBackupStore(directory);
    } finally {
        if (previous) process.env.INPX_RUST_CATALOG_BINARY = previous;
        else delete process.env.INPX_RUST_CATALOG_BINARY;
    }
}

function backupName(index, scheduled = index%5 !== 0) {
    const stamp = new Date(Date.UTC(2026,9,24)+index*1000).toISOString().replace(/[:.]/g,'-');
    return `inpx-web-${scheduled ? 'auto-' : ''}backup-${stamp}-${index.toString(16).padStart(8,'0')}.zip${index%3 ? '.enc' : ''}`;
}

async function populateVault(directory, count) {
    const target = path.join(directory,'backups');
    await fs.ensureDir(target);
    for (let start=0; start<count; start+=32) {
        await Promise.all(Array.from({length:Math.min(32,count-start)},async (_,offset) => {
            const index = start+offset;
            const file = path.join(target,backupName(index));
            await fs.writeFile(file,'x'.repeat(index%97+1));
            const modified = new Date(Date.UTC(2026,9,26)+(count-index)*1000);
            await fs.utimes(file,modified,modified);
        }));
    }
    await fs.writeFile(path.join(target,'ignored.zip'),'ignored');
    return target;
}

async function testVaultStoreParity(binary, root) {
    const directory = await fs.mkdtemp(path.join(root,'vault-parity-'));
    const legacy = openWithBinary(directory), rust = openWithBinary(directory,binary);
    await rust.start();
    try {
        assert.deepStrictEqual(await rust.list(),[]);
        assert.deepStrictEqual(await rust.policy(),await legacy.policy());
        await assert.rejects(rust.update({enabled:true}),/пароль/);
        const window = {hour:2,dayStart:Date.UTC(2026,9,24,22),nextDay:Date.UTC(2026,9,25,23)};
        await rust.update({enabled:true,hour:2,keep:3},{key:'fixture',salt:'fixture'});
        assert.deepStrictEqual(await rust.policy(),await legacy.policy());
        assert.strictEqual(await rust.due({...window,hour:1}),false);
        assert.strictEqual(await rust.due(window),true);
        await rust.markCreated(new Date(window.dayStart).toISOString());
        assert.strictEqual(await rust.due(window),false);
        assert.strictEqual(await rust.policy(window),null);
        await rust.markCreated(new Date(window.nextDay).toISOString());
        assert.strictEqual(await rust.due(window),true);
        assert.strictEqual(await rust.due(window),await legacy.due(window));
        await rust.markFailed();
        assert.match((await legacy.policy()).lastError,/Не удалось создать копию/);
        await assert.rejects(rust.update({keep:null}),/60/);
        assert.strictEqual((await rust.policy()).keep,3);

        const directoryOfFiles = await populateVault(directory,30);
        assert.deepStrictEqual(await rust.list(),await legacy.list());
        assert.deepStrictEqual(await rust.list(true),await legacy.list(true));
        const manual = (await legacy.list()).filter(row=>!row.scheduled).map(row=>row.name);
        await rust.rotate(3);
        assert.strictEqual((await rust.list(true)).length,3);
        assert.deepStrictEqual((await rust.list()).filter(row=>!row.scheduled).map(row=>row.name),manual);
        await assert.rejects(rust.remove('../config.json'),/Некорректное имя/);
        const blocked = backupName(300);
        await fs.mkdir(path.join(directoryOfFiles,blocked));
        await assert.rejects(rust.remove(blocked),/недоступна/);
        assert((await fs.stat(path.join(directoryOfFiles,blocked))).isDirectory());
        await fs.rmdir(path.join(directoryOfFiles,blocked));
        const target = path.join(directory,'confined-target');
        await fs.mkdir(target);
        await fs.writeFile(path.join(target,'preserve.txt'),'safe');
        const alias = backupName(301);
        await fs.symlink(target,path.join(directoryOfFiles,alias),process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(rust.remove(alias),/недоступна/);
        const archive = require('../server/core/BackupArchive');
        await assert.rejects(archive.read({[archive.savedBackup]:alias},{dataDir:directory},directory),/недоступна/);
        assert.strictEqual(await fs.readFile(path.join(target,'preserve.txt'),'utf8'),'safe');
        await fs.unlink(path.join(directoryOfFiles,alias));
        await rust.remove(manual[0]);
        await assert.rejects(rust.inspect(manual[0]),{code:'ENOENT'});
        await rust.update({clearPassword:true});
        assert.strictEqual(await rust.due(window),false);
    } finally {await rust.stop();}
}

const median = values => Math.round(values.toSorted((a,b)=>a-b)[values.length>>1]*100)/100;

async function benchmarkVaultStore(binary, root) {
    const directory = await fs.mkdtemp(path.join(root,'vault-bench-'));
    const shared = await Promise.all([20,200,700].map(async count => {
        const folder = path.join(directory,`list-${count}`);
        await populateVault(folder,count);
        return [count,openWithBinary(folder),openWithBinary(folder,binary)];
    }));
    async function measure(stage, count, actors, action) {
        const samples = [[],[]];
        let result;
        for(let i=0; i<20; i++) {
            for (const index of i%2 ? [1,0] : [0,1]) {
                const start = performance.now();
                const value = await action(actors[index]);
                if(i) samples[index].push(performance.now()-start);
                if(result === undefined) result = value;
                else assert.deepStrictEqual(value,result);
            }
        }
        console.log(JSON.stringify({stage,files:count,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
    }
    for (const [count,legacy,rust] of shared) {
        await rust.start();
        try {
            await measure('list',count,[legacy,rust],store=>store.list());
            if (count === 20) {
                const window = {hour:2,dayStart:Date.UTC(2026,10,16),nextDay:Date.UTC(2026,10,17)};
                await legacy.update({enabled:true,hour:2},{key:'fixture',salt:'fixture'});
                await measure('schedule',count,[legacy,rust],store=>store.due(window));
            }
        } finally {await rust.stop();}
    }
    const folders = [path.join(directory,'rotation-before'),path.join(directory,'rotation-after')];
    const actors = [openWithBinary(folders[0]),openWithBinary(folders[1],binary)];
    const samples = [[],[]];
    await actors[1].start();
    try {
        for(let i=0; i<8; i++) {
            const files = await Promise.all(folders.map(folder=>populateVault(folder,120)));
            for (const index of i%2 ? [1,0] : [0,1]) {
                const start = performance.now();
                await actors[index].rotate(7);
                if(i) samples[index].push(performance.now()-start);
            }
            assert.deepStrictEqual((await fs.readdir(files[0])).sort(),(await fs.readdir(files[1])).sort());
        }
        console.log(JSON.stringify({stage:'rotate',files:120,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
    } finally {await actors[1].stop();}
}

module.exports = {testEncryptedBackupPreviewRestoreAndRotation,testVaultStoreParity,benchmarkVaultStore};
if (require.main === module) testEncryptedBackupPreviewRestoreAndRotation().then(() => console.log('Backup vault: OK')).catch(error => {console.error(error); process.exitCode = 1;});
