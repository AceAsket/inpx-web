const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const SecretStore = require('../server/core/SecretStore');
const ReadingListStore = require('../server/core/ReadingListStore');
const Security = require('../server/core/Security');
const FileDownloader = require('../server/core/FileDownloader');
const lifetime = require('../server/core/SessionLifetime');

async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-security-test-'));
    try {
        return await fn(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function testConcurrentSecretKeyCreation() {
    await temporary(async(dir) => {
        const values = await Promise.all(Array.from({length: 16}, (_, i) => new SecretStore({dataDir: dir}).encrypt(`value-${i}`)));
        for (let i = 0; i < values.length; i++)
            assert.strictEqual(await new SecretStore({dataDir: dir}).decrypt(values[i]), `value-${i}`);

        const multiDir = path.join(dir, 'multiprocess');
        const modulePath = require.resolve('../server/core/SecretStore');
        const source = `new (require(process.argv[1]))({dataDir:process.argv[2]}).encrypt(process.argv[3]).then(v=>process.stdout.write(v)).catch(e=>{console.error(e);process.exitCode=1;});`;
        const children = await Promise.all(Array.from({length: 8}, (_, i) => execFile(process.execPath, ['-e', source, modulePath, multiDir, `child-${i}`])));
        for (let i = 0; i < children.length; i++)
            assert.strictEqual(await new SecretStore({dataDir: multiDir}).decrypt(children[i].stdout), `child-${i}`);

        const missing = new SecretStore({dataDir: path.join(dir, 'missing')});
        await assert.rejects(missing.decrypt(values[0]), /Secret key is missing/);
        assert.strictEqual(await fs.pathExists(missing.keyFile), false);
        await fs.writeFile(path.join(dir, 'secret.key'), 'broken');
        await assert.rejects(new SecretStore({dataDir: dir}).encrypt('test'), /Invalid secret key/);
        assert.strictEqual(await fs.readFile(path.join(dir, 'secret.key'), 'utf8'), 'broken');
    });
}

async function testConcurrentStoreMutations() {
    await temporary(async(dataDir) => {
        const stores = [new ReadingListStore({dataDir}), new ReadingListStore({dataDir})];
        // Include first initialization, multiple instances, and distinct mutation types.
        await Promise.all(Array.from({length: 12}, (_, i) => stores[i % 2].createList('default', `List ${i}`)));
        assert.strictEqual((await stores[0].load()).lists.length, 12);
        const list = (await stores[0].load()).lists[0];
        await Promise.all([
            stores[0].addBooks('default', list.id, ['book:1']),
            stores[1].addBooks('default', list.id, ['book:2']),
            stores[0].updateReaderProgress('default', 'book:3', {percent: 0.4}),
            stores[1].updateReaderProgress('default', 'book:4', {percent: 0.7}),
            stores[0].updateMetadataOverride('book:1', {title: 'Corrected'}),
        ]);
        const saved = await stores[0].load();
        assert.deepStrictEqual(saved.lists[0].books.map(b => b.bookUid).sort(), ['book:1', 'book:2']);
        assert.strictEqual(saved.users.find(u => u.id === 'default').readerProgress['book:3'].percent, 0.4);
        assert.strictEqual(saved.users.find(u => u.id === 'default').readerProgress['book:4'].percent, 0.7);
        const attempts = await Promise.allSettled([
            stores[0].createList('default', ''),
            stores[1].createList('default', 'After error'),
        ]);
        assert.strictEqual(attempts[0].status, 'rejected');
        assert.strictEqual(attempts[1].status, 'fulfilled');
        assert.strictEqual((await stores[0].load()).lists.length, 13);
    });
}

async function testAtomicConfigSave() {
    await temporary(async(dataDir) => {
        const ConfigManager = require('../server/config');
        const manager = new ConfigManager();
        manager.inited = true;
        manager._config = {dataDir, configFile: path.join(dataDir, 'config.json'), smtpPass: 'one'};
        const first = manager.save();
        manager._config.smtpPass = 'two';
        await Promise.all([first, manager.save()]);
        const disk = await fs.readFile(manager._config.configFile, 'utf8');
        assert.strictEqual(await new SecretStore({dataDir}).decrypt(JSON.parse(disk).smtpPass), 'two');
        const rename = fs.rename;
        fs.rename = async() => { throw new Error('simulated replacement failure'); };
        try {
            manager._config.smtpPass = 'three';
            await assert.rejects(manager.save(), /simulated replacement failure/);
        } finally {
            fs.rename = rename;
        }
        assert.strictEqual(await fs.readFile(manager._config.configFile, 'utf8'), disk);
        assert.ok(!(await fs.readdir(dataDir)).some(name => name.includes('.tmp-')));
        await manager.save();
        assert.strictEqual(await new SecretStore({dataDir}).decrypt((await fs.readJson(manager._config.configFile)).smtpPass), 'three');
    });
}

async function testSessionLifetimeAndMalformedCookies() {
    const security = new Security({});
    security.secret = 'test-secret';
    const middleware = security.middleware();
    const response = {setHeader: () => assert.fail('Polling or assets must not set cookies')};
    for (let i = 0; i < 1000; i++) {
        for (const pathname of ['/health', '/ready', '/metrics', '/app.js'])
            middleware({path: pathname, headers: {}, socket: {}}, response, () => {});
    }
    assert.strictEqual(security.sessions.size, 0);
    let cookie;
    middleware({path: '/', headers: {}, socket: {}}, {setHeader: (_, value) => { cookie = value; }}, () => {});
    assert.ok(cookie.startsWith('inpx_web_session='));
    const request = {headers: {cookie}};
    const session = security.getSession(request);
    assert.ok(session);
    session.updatedAt = Date.now() - lifetime.idleMs - 1;
    assert.strictEqual(security.getSession(request), null);
    const absolute = security.ensureSession({headers: {}});
    absolute.createdAt = Date.now() - lifetime.maxAgeMs - 1;
    assert.strictEqual(security.getSession({headers: {}, securitySession: absolute}), null);
    assert.deepStrictEqual(security.parseCookies('bad=%ZZ; good=value'), {good: 'value'});
    assert.strictEqual(security.unpackSessionId(`id.${'я'.repeat(64)}`), '');
    assert.strictEqual(security.hasValidCsrf({headers: {}}, 'я'.repeat(64)), false);
    assert.strictEqual(security.unpackProxyAuthCookie(security.proxyAuthCookieValue('a.b')), 'a.b');
    const oldTime = Date.now() - lifetime.maxAgeMs - 1;
    assert.strictEqual(security.unpackProxyAuthCookie(`reader.${oldTime}.${security.sign(`proxy:reader:${oldTime}`)}`), '');
    for (let i = 0; i < lifetime.maxSessions + 10; i++)
        security.ensureSession({headers: {}});
    assert.strictEqual(security.sessions.size, lifetime.maxSessions);
}

async function testProfileCredentialChangesRevokeSessions() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.checkMyState = () => {};
        worker.profileSessions = new Map();
        worker.readingListStore = new ReadingListStore({dataDir});
        const user = await worker.readingListStore.createUser({name: 'Reader', login: 'reader',
            passwordHash: require('../server/core/ProfilePassword').legacy('reader', 'old')});
        await assert.rejects(worker.updateUserProfile(user.id, {login: 'renamed'}), /пароль заново/);
        const login = await worker.loginUserProfile('reader', 'old');
        await worker.updateUserProfile(user.id, {login: 'reader', name: 'Changed name'});
        assert.strictEqual(worker.getProfileSessionUser(login.profileAccessToken), user.id);
        assert.match((await worker.readingListStore.getUser(user.id)).passwordHash, /^scrypt:v1:/);
        await worker.loginUserProfile('reader', 'old');
        await worker.updateUserProfile(user.id, {passwordHash: await worker.hashProfilePassword('reader', 'new')});
        await assert.rejects(worker.requireAuthorizedUser(user.id, login.profileAccessToken), /need_profile_login/);
        await assert.rejects(worker.loginUserProfile('reader', 'old'), /Неверный/);
        const current = await worker.loginUserProfile('reader', 'new');
        await worker.updateUserProfile(user.id, {login: 'renamed'});
        assert.strictEqual(worker.getProfileSessionUser(current.profileAccessToken), '');
        const renamed = await worker.loginUserProfile('renamed', 'new');
        worker.profileSessions.get(renamed.profileAccessToken).updatedAt = Date.now() - lifetime.idleMs - 1;
        assert.strictEqual(worker.getProfileSessionUser(renamed.profileAccessToken), '');
        const deleted = await worker.loginUserProfile('renamed', 'new');
        await worker.deleteUserProfile(user.id);
        assert.strictEqual(worker.getProfileSessionUser(deleted.profileAccessToken), '');
    });
}

async function testDownloaderClosesFailedTransfers() {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.url === '/ok') {
            assert.strictEqual(req.headers['x-test'], 'present');
            res.end('complete');
        } else if (req.url === '/large-header') {
            res.writeHead(200, {'content-length': '100000'});
            res.flushHeaders();
        } else if (req.url === '/large-stream') {
            res.write('too much data');
        } else if (req.url === '/stall') {
            res.write('a');
        } // /no-headers deliberately never responds.
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const downloader = new FileDownloader(8);
    const options = {timeout: 1000, idleTimeout: 100, proxy: false};
    try {
        assert.strictEqual((await downloader.load(`${url}/ok`, {...options, headers: {'x-test': 'present'}})).toString(), 'complete');
        await assert.rejects(downloader.load(`${url}/large-header`, options), /слишком большой/);
        await assert.rejects(downloader.load(`${url}/large-stream`, options), /слишком большой/);
        await assert.rejects(downloader.load(`${url}/stall`, options), /timed out/);
        await assert.rejects(downloader.load(`${url}/no-headers`, {...options, timeout: 100}), /timed out|timeout/);
        await assert.rejects(downloader.head(`${url}/no-headers`, {...options, timeout: 100}), /timeout/);
        let abort = false;
        const cancelled = downloader.load(`${url}/no-headers`, options, null, () => abort);
        abort = true;
        await assert.rejects(cancelled, /abort/);
        const deadline = Date.now() + 1000;
        while (sockets.size && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(sockets.size, 0, 'Failed downloads must close their server sockets');
    } finally {
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testDownloaderVerifiesTlsCertificates() {
    const https = require('https');
    const cert = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'));
    const key = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-key.pem'));
    const server = https.createServer({key, cert}, (_req, res) => res.end('verified'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${server.address().port}`;
    const agent = new https.Agent({ca: cert});
    try {
        const downloader = new FileDownloader(100);
        await assert.rejects(downloader.load(url, {proxy: false}), /self.signed certificate/i);
        assert.strictEqual((await downloader.load(url, {proxy: false, httpsAgent: agent})).toString(), 'verified');
    } finally {
        agent.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testBookRouteRejectsTraversal() {
    await temporary(async(dir) => {
        const config = {dataDir: path.join(dir, 'data'), rootPathStatic: '', bookPathStatic: '/book',
            publicDir: path.join(dir, 'data', 'public'), bookDir: path.join(dir, 'data', 'public-files', 'book')};
        await fs.ensureDir(config.bookDir);
        await fs.outputFile(path.join(config.dataDir, 'reading-lists.json'), '{}');
        const app = require('express')();
        require('../server/static')(app, config);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            // Raw paths: fetch() would normalize the encoded dots away.
            for (const url of ['/book/%2E%2E', '/book/..%2F..', '/book/..%2F..%2Fraw', '/book/..%2F../zip']) {
                await new Promise((resolve, reject) => http.get({host: '127.0.0.1', port: server.address().port, path: url},
                    res => res.resume().on('end', resolve)).on('error', reject));
            }
            assert.ok(await fs.pathExists(path.join(config.dataDir, 'reading-lists.json')), 'Data dir must survive');
            assert.ok(await fs.pathExists(config.bookDir), 'Book cache must survive');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

async function testAdminGetsRandomPasswordByDefault() {
    await temporary(async(dataDir) => {
        const config = {dataDir, adminLogin: 'admin', adminPassword: ''};
        const store = new ReadingListStore(config);
        const admin = (await store.load()).users.find(user => user.isAdmin);
        assert.ok(config.adminPassword.length >= 16, 'A random password must be generated');
        assert.ok(await store.verifyUserPassword(admin.id, config.adminPassword));
        assert.strictEqual(await store.verifyUserPassword(admin.id, 'admin'), false);
    });
}

async function testStoreReadErrorKeepsData() {
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir, adminPassword: 'fixture'});
        await store.createList('default', 'Keep me');
        const before = await fs.readFile(store.file, 'utf8');
        const readFile = fs.readFile;
        fs.readFile = async() => { throw Object.assign(new Error('EMFILE: too many open files'), {code: 'EMFILE'}); };
        try {
            await assert.rejects(store.load(), /EMFILE/);
        } finally {
            fs.readFile = readFile;
        }
        assert.strictEqual(await fs.readFile(store.file, 'utf8'), before, 'A read error must not reset the store');
    });
}

async function testStoreLoadCacheStaysCurrent() {
    await temporary(async(dataDir) => {
        const [first, second] = [new ReadingListStore({dataDir, adminPassword: 'fixture'}), new ReadingListStore({dataDir, adminPassword: 'fixture'})];
        await first.load();
        const copy = await first.load();
        copy.lists.push({id: 'leaked'});
        assert.strictEqual((await first.load()).lists.length, 0, 'Mutating a loaded copy must not reach the cache');
        await second.createList('default', 'From another instance');
        assert.deepStrictEqual((await first.load()).lists.map(list => list.name), ['From another instance']);
    });
}

// Author bios and FB2 annotations come from library files and are shown with v-html.
async function testLibraryHtmlIsCleaned() {
    const {safeHtml} = require('../shared/safeHtml');
    assert.strictEqual(safeHtml('<P align="justify">Bio <b>bold</b><br/>&nbsp;&#171;q&#187;</P>'),
        '<p>Bio <b>bold</b><br>&nbsp;&#171;q&#187;</p>');
    assert.strictEqual(safeHtml('<subtitle>Part 1</subtitle>'), 'Part 1', 'Unknown tags are dropped, text stays');
    assert.strictEqual(safeHtml('&lt;b&gt; and a < b'), '&lt;b&gt; and a &lt; b', 'Escaped text stays text');
    for (const hostile of ['<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', '<p onclick="alert(1)">x</p>',
        '<a href="javascript:alert(1)">x</a>', '<b\nonmouseover=alert(1)>x</b>', '<scr<script>ipt>alert(1)</script>',
        '<p title="a>b" onmouseover="alert(1)">x</p>', '<iframe srcdoc="<script>alert(1)</script>">'])
        assert.ok(!/<(?!\/?(p|br|b|i|u|em|strong|h[1-6]|sub|sup|ul|ol|li|blockquote|div|span)>)/i.test(safeHtml(hostile)), hostile);
}

module.exports = [testBookRouteRejectsTraversal, testLibraryHtmlIsCleaned, testStoreLoadCacheStaysCurrent, testStoreReadErrorKeepsData, testAdminGetsRandomPasswordByDefault, testConcurrentSecretKeyCreation, testConcurrentStoreMutations, testAtomicConfigSave,
    testSessionLifetimeAndMalformedCookies, testProfileCredentialChangesRevokeSessions,
    testDownloaderClosesFailedTransfers, testDownloaderVerifiesTlsCertificates];
