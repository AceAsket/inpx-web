const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const passwords = require('../server/core/ProfilePassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const transaction = require('../server/core/BackupTransaction');
const requestLimits = require('../server/core/RequestLimits');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-stage4-'));
    try {
        await task(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function archive(entries) {
    const zip = new (require('yazl').ZipFile)();
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        zip.outputStream.on('data', chunk => chunks.push(chunk));
        zip.outputStream.on('end', resolve);
        zip.outputStream.on('error', reject);
    });
    for (const [name, value] of Object.entries(entries))
        zip.addBuffer(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), name);
    zip.end();
    await done;
    return {contentBase64: Buffer.concat(chunks).toString('base64')};
}

async function testScryptMigrationAndOpds() {
    const first = await passwords.hash('пароль');
    const second = await passwords.hash('пароль');
    assert.notStrictEqual(first, second);
    assert.strictEqual(await passwords.verify(first, 'different-login', 'пароль'), true);
    assert.strictEqual(await passwords.verify(first, 'different-login', 'wrong'), false);
    assert.strictEqual(await passwords.verify('scrypt:v999:9999999999999999:bad', '', ''), false);
    await assert.rejects(passwords.hash('x'.repeat(4097)), /длинный/);
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir});
        const user = await store.createUser({name: 'Legacy OPDS', login: 'legacy', opdsEnabled: true,
            opdsAuthEnabled: true, passwordHash: passwords.legacy('legacy', 'secret')});
        assert.strictEqual((await store.verifyOpdsPassword(user.id, 'legacy', 'wrong')).authorized, false);
        assert.strictEqual((await store.getUser(user.id)).passwordHash, user.passwordHash);
        assert.strictEqual((await store.verifyOpdsPassword(user.id, 'legacy', 'secret')).authorized, true);
        const migrated = await store.getUser(user.id);
        assert.match(migrated.passwordHash, /^scrypt:v1:/);
        await store.updateUser(user.id, {login: 'renamed'});
        const restarted = new ReadingListStore({dataDir});
        assert.strictEqual((await restarted.verifyOpdsPassword(user.id, 'renamed', 'secret')).authorized, true);
        assert.strictEqual((await restarted.getUser(user.id)).passwordHash, migrated.passwordHash);
        assert.match((await restarted.getUser('admin')).passwordHash, /^scrypt:v1:/);
    });
}

async function testWebSocketBoundsAndRecovery() {
    const WebSocket = require('ws');
    const Controller = require('../server/controllers/WebSocketController');
    const controller = Object.create(Controller.prototype);
    controller.config = {importLimitMb: 1, backupUploadLimitMb: 1};
    controller.webAccess = {hasAccess: async() => true};
    controller.test = async(req, ws) => controller.send({ok: true}, req, ws);
    const server = new WebSocket.Server({port: 0, host: '127.0.0.1', maxPayload: requestLimits.transportLimit(controller.config)});
    server.on('connection', socket => {
        socket.on('error', () => {});
        socket.on('message', data => controller.onMessage(socket, data.toString()));
    });
    await new Promise(resolve => server.on('listening', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise(resolve => socket.on('open', resolve));
    const call = (message) => new Promise(resolve => {
        const receive = data => {
            const response = JSON.parse(data);
            if (!response._rok) {
                socket.off('message', receive);
                resolve(response);
            }
        };
        socket.on('message', receive);
        socket.send(message);
    });
    try {
        for (const malformed of ['null', '[]', 'false', '{'])
            assert.ok((await call(malformed)).error);
        assert.match((await call(JSON.stringify({action: 'test', data: 'x'.repeat(1024*1024)}))).error, /размер/);
        assert.strictEqual((await call(JSON.stringify({action: 'test'}))).ok, true);
        const closed = new Promise(resolve => socket.once('close', resolve));
        socket.send('x'.repeat(7*1024*1024));
        assert.strictEqual(await closed, 1009);
    } finally {
        socket.terminate();
        for (const client of server.clients)
            client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
    let release;
    const gate = new Promise(resolve => release = resolve);
    controller.test = async() => gate;
    const fake = {readyState: WebSocket.OPEN, send() {}, close(code) { this.code = code; }};
    const busy = Array.from({length: 8}, () => controller.onMessage(fake, '{"action":"test"}'));
    await controller.onMessage(fake, '{"action":"test"}');
    assert.strictEqual(fake.code, 1013);
    release();
    await Promise.all(busy);
    assert.strictEqual(controller.activeRequests, 0);
    assert.strictEqual(fake.activeRequests, 0);
    requestLimits.checkRequest({action: 'update-reader-preferences'}, 6*1024*1024, controller.config);
    assert.throws(() => requestLimits.checkRequest({action: 'update-reader-preferences'}, 6*1024*1024 + 1, controller.config), /размер/);
    assert.throws(() => requestLimits.checkImport({lists: Array.from({length: 1001}, () => ({}))}), /1000/);
    assert.throws(() => requestLimits.checkImport({lists: [{books: Array(100001).fill('book')}]}), /100000/);
}

async function testBackupValidationBeforeMutation() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.config = {dataDir, configFile: path.join(dataDir, 'config.json'), tempDir: path.join(dataDir, 'tmp'),
            backupExpandedLimitMb: 1, opds: {password: 'old'}};
        worker.checkMyState = () => {};
        worker.requireAdmin = async() => {};
        worker.addAdminEvent = () => {};
        worker.profileSessions = new Map([['old', {userId: 'admin'}]]);
        worker.readingListStore = new ReadingListStore(worker.config);
        await worker.readingListStore.load();
        await fs.writeJson(worker.config.configFile, {opds: {password: 'old'}});
        const before = await fs.readFile(worker.config.configFile, 'utf8');
        const listsBefore = await fs.readFile(worker.readingListStore.file, 'utf8');
        const base = {'backup-info.json': {version: 'test'}, 'config.json': {opds: {password: 'new'}}};
        const invalid = await archive({...base, 'reading-lists.json': '{broken'});
        await assert.rejects(worker.importAdminBackup('admin', 'token', invalid));
        const bomb = await archive({...base, 'discovery-cache.json': JSON.stringify({large: 'x'.repeat(1024*1024)})});
        await assert.rejects(worker.importAdminBackup('admin', 'token', bomb), /распакованный размер/);
        const secretStore = new (require('../server/core/SecretStore'))(worker.config);
        const protectedConfig = await secretStore.protectConfig({opds: {password: 'new'}});
        const mismatch = await archive({...base, 'config.json': protectedConfig,
            'secret.key': require('crypto').randomBytes(32).toString('base64')});
        await assert.rejects(worker.importAdminBackup('admin', 'token', mismatch));
        assert.strictEqual(await fs.readFile(worker.config.configFile, 'utf8'), before);
        assert.strictEqual(await fs.readFile(worker.readingListStore.file, 'utf8'), listsBefore);
        assert.strictEqual(worker.config.opds.password, 'old');
        assert.strictEqual(worker.profileSessions.size, 1);
        assert.deepStrictEqual(await fs.readdir(worker.config.tempDir), []);
    });
}

async function testBackupRollbackAndCrashRecovery() {
    await temporary(async(dataDir) => {
        const config = {dataDir, configFile: path.join(dataDir, 'config.json')};
        const original = {'config.json': JSON.stringify({dataDir, loggingEnabled: false}), 'reading-lists.json': '{"users":[],"lists":[]}'};
        const content = {'config.json': JSON.stringify({dataDir, loggingEnabled: true}), 'reading-lists.json': '{"new":true}'};
        const targets = transaction.targets(config);
        for (const [name, value] of Object.entries(original))
            await fs.writeFile(targets[name], value);
        const rename = fs.rename;
        let failed = false;
        fs.rename = async(from, to) => {
            if (!failed && to === targets['reading-lists.json']) {
                failed = true;
                throw new Error('injected write failure');
            }
            return rename(from, to);
        };
        try {
            await assert.rejects(transaction.commit(config, content), /injected/);
        } finally {
            fs.rename = rename;
        }
        for (const [name, value] of Object.entries(original))
            assert.strictEqual(await fs.readFile(targets[name], 'utf8'), value);
        const child = `
            const fs = require(process.argv[1]);
            const transaction = require(process.argv[2]);
            const config = JSON.parse(process.argv[3]);
            const rename = fs.rename;
            fs.rename = async(from, to) => {
                await rename(from, to);
                if (to === config.configFile) process.exit(86);
            };
            transaction.commit(config, JSON.parse(process.argv[4])).catch(error => {console.error(error); process.exit(1)});
        `;
        await assert.rejects(execFile(process.execPath, ['-e', child, require.resolve('fs-extra'),
            require.resolve('../server/core/BackupTransaction'), JSON.stringify(config), JSON.stringify(content)]), error => error.code === 86);
        assert.strictEqual(await fs.readFile(config.configFile, 'utf8'), content['config.json']);
        const restart = `
            const Manager = require(process.argv[1]);
            const config = JSON.parse(process.argv[2]);
            (async() => {
                const manager = new Manager();
                await manager.init(config.dataDir, config.configFile);
                await manager.load();
                require('assert').strictEqual(manager.config.loggingEnabled, false);
            })().catch(error => {console.error(error); process.exit(1)});
        `;
        await execFile(process.execPath, ['-e', restart, require.resolve('../server/config'), JSON.stringify(config)]);
        assert.strictEqual((await fs.readJson(config.configFile)).loggingEnabled, false);
        assert.strictEqual(await fs.readFile(targets['reading-lists.json'], 'utf8'), original['reading-lists.json']);
        await transaction.commit(config, content);
        for (const [name, value] of Object.entries(content))
            assert.strictEqual(await fs.readFile(targets[name], 'utf8'), value);
        assert.strictEqual(await fs.pathExists(path.join(dataDir, '.restore-transaction')), false);
    });
}

module.exports = [testScryptMigrationAndOpds, testWebSocketBoundsAndRecovery,
    testBackupValidationBeforeMutation, testBackupRollbackAndCrashRecovery];
