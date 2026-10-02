const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const Security = require('../server/core/Security');
const ProfileAccess = require('../server/core/ProfileAccess');
const ReadingListStore = require('../server/core/ReadingListStore');

async function fixture(options, test) {
    const Worker = require('../server/core/WebWorker');
    const Controller = require('../server/controllers/WebSocketController');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-access-'));
    const config = Object.assign({dataDir: dir, rootPathStatic: '', bookPathStatic: '/book', libDir: dir, bookDir: path.join(dir, 'books'),
        publicDir: path.join(dir, 'public'), publicFilesDir: path.join(dir, 'public-files'), tempDir: path.join(dir, 'tmp'),
        librarySources: [], name: 'inpx-web', version: 'test', webConfigParams: ['name'], opds: {enabled: true}}, options);
    const worker = Object.create(Worker.prototype);
    worker.config = config;
    worker.checkMyState = () => {};
    worker.profileSessions = new Map();
    worker.readingListStore = new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
    worker.dbConfig = async() => ({inpxInfo: {collection: 'Test collection'}});
    worker.getSharedDiscoveryConfig = async() => ({});
    worker.buildUserReadingSummary = async() => ({count: 0, items: []});
    const alice = await worker.readingListStore.createUser({name: 'Alice', login: 'alice', emailTo: 'alice@example.test',
        opdsAuthEnabled: true, passwordHash: await worker.hashProfilePassword('alice', 'alice-fixture')});
    const bob = await worker.readingListStore.createUser({name: 'Bob', login: 'bob', emailTo: 'bob@example.test'});
    const security = new Security(config);
    await security.init();
    const access = new ProfileAccess(config, worker, security);
    const controller = Object.create(Controller.prototype);
    Object.assign(controller, {config, security, webWorker: worker, profileAccess: access,
        webAccess: {hasAccess: async() => true, freeAccess: true}, activeRequests: 0,
        workerState: {getState: () => ({state: 'normal', fileName: 'PRIVATE_LIBRARY_PATH'})}});
    const app = express();
    app.use(security.middleware());
    app.use(security.requiredAuthMiddleware());
    await fs.outputFile(path.join(config.publicDir, 'index.html'), '<html>Login shell</html>');
    await fs.outputFile(path.join(config.bookDir, 'fixture.txt'), 'BOOK_FIXTURE');
    await fs.outputFile(path.join(config.dataDir, 'backups', 'fixture.zip'), 'BACKUP_FIXTURE');
    require('../server/static')(app, config, worker, security);
    app.use('/opds', access.httpGuard(true), require('../server/core/opds/Auth')(config,
        (...args) => worker.verifyOpdsPassword(...args), security));
    app.get('/opds', (req, res) => res.json({user: req.query.user || ''}));
    for (const [url, name] of [['/opds/reading-profiles', 'ReadingProfilesPage'], ['/opds/reading-lists/list', 'ReadingListPage']]) {
        const page = Object.create(require(`../server/core/opds/${name}`).prototype);
        Object.assign(page, {config, webWorker: worker, opdsRoot: '/opds', rootTag: 'feed', id: name, title: name});
        app.get(url, async(req, res) => {
            try { res.send(await page.body(req)); }
            catch (error) { res.status(404).send(error.message); }
        });
    }
    const server = http.createServer(app);
    const wss = new WebSocket.Server({server, verifyClient: info => security.verifyWebSocket(info.req)});
    wss.on('connection', (socket, req) => {
        socket.req = req;
        socket.on('message', raw => controller.onMessage(socket, raw.toString()));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, headers = {}) => fetch(base + url, {headers, redirect: 'manual'});
    const session = () => {
        const value = security.ensureSession({headers: {}});
        return {value, cookie: `inpx_web_session=${security.packSessionId(value.id)}`};
    };
    const sockets = new Set();
    const connect = async(headers = {}) => {
        const socket = new WebSocket(base.replace('http', 'ws'), {headers});
        sockets.add(socket);
        await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
        let counter = 0;
        return async(params) => {
            const requestId = String(++counter);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {socket.off('message', listener); reject(new Error('WebSocket request timed out'));}, 5000);
                const listener = raw => {
                    const result = JSON.parse(raw);
                    if (result.requestId === requestId && !result._rok) {
                        clearTimeout(timer);
                        socket.off('message', listener);
                        resolve(result);
                    }
                };
                socket.on('message', listener);
                socket.send(JSON.stringify({...params, requestId}));
            });
        };
    };
    try {
        await test({config, worker, security, access, alice, bob, request, session, connect});
    } finally {
        for (const socket of sockets) socket.terminate();
        for (const socket of wss.clients) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.remove(dir);
    }
}

async function testProxyHeaderRequiredWithOldCookie() {
    await fixture({requireAuth: true, authMode: 'proxy', trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']}, async({security, request, connect}) => {
        const cookie = `inpx_web_proxy_auth=${security.proxyAuthCookieValue('alice')}; broken=%ZZ`;
        const headers = {'Remote-User': 'alice', cookie};
        const ok = await request('/', headers);
        assert.strictEqual(ok.status, 200);
        assert.ok(!(ok.headers.get('set-cookie') || '').includes('inpx_web_proxy_auth'));
        assert.strictEqual((await request('/', {cookie})).status, 401);
        await assert.rejects(connect({cookie}), /401/);
        assert.ok(!(await (await connect(headers))({action: 'test'})).error);
        security.trustedProxyRanges = new Security({trustedProxyCidrs: ['10.0.0.0/8']}).trustedProxyRanges;
        assert.strictEqual((await request('/', headers)).status, 403);
    });
}

async function testAnonymousAccessDisabledHttpAndWebSocket() {
    await fixture({allowAnonymousAccess: false}, async({worker, alice, bob, request, session, connect}) => {
        assert.strictEqual((await request('/')).status, 200, 'Login shell stays reachable');
        for (const url of ['/book/fixture.txt', '/cover/123', '/reader-lab-source/example.fb2', '/opds'])
            assert.strictEqual((await request(url)).status, 401, url);
        const browser = session();
        const call = await connect({cookie: browser.cookie});
        const config = await call({action: 'get-config', userId: bob.id, profileLoginRequired: false});
        assert.strictEqual(config.profileLoginRequired, true);
        assert.deepStrictEqual(config.userProfiles, []);
        assert.strictEqual(config.dbConfig, undefined);
        const state = await call({action: 'get-worker-state', workerId: 'server_state'});
        assert.strictEqual(state.state, 'normal');
        assert.strictEqual(state.fileName, undefined);
        for (const action of ['search', 'get-user-profiles', 'get-reading-lists', 'create-reading-list', 'get-admin-dashboard']) {
            const response = await call({action, userId: bob.id, csrfToken: config.csrfToken});
            assert.strictEqual(response.error, 'need_profile_login', action);
        }
        const bad = await call({action: 'login-user-profile', login: 'alice', password: 'wrong', csrfToken: config.csrfToken});
        assert.match(bad.error, /Неверный/);
        const login = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken: config.csrfToken});
        assert.strictEqual(login.userId, alice.id);
        const authed = await call({action: 'get-config', userId: bob.id});
        assert.strictEqual(authed.currentUserId, alice.id, 'Stale selection must be replaced');
        assert.strictEqual(authed.profileAuthorized, true);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 200);
        assert.strictEqual((await request('/opds?user=bob', {cookie: browser.cookie})).status, 401);
        assert.strictEqual((await (await request('/opds', {cookie: browser.cookie})).json()).user, alice.id);
        assert.strictEqual((await call({action: 'get-reading-lists', userId: bob.id})).error, 'need_profile_login');
        await call({action: 'logout-user-profile', csrfToken: config.csrfToken});
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 401);
        assert.strictEqual((await call({action: 'get-reading-lists', userId: alice.id, profileAccessToken: login.profileAccessToken})).error, 'need_profile_login');
        browser.value.profileAccessToken = worker.createProfileSession(alice.id);
        worker.revokeUserSessions(alice.id);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 401);
        const basic = {authorization: 'Basic ' + Buffer.from('alice:alice-fixture').toString('base64')};
        assert.strictEqual((await request('/book/fixture.txt', basic)).status, 200);
        assert.strictEqual((await (await request('/opds', basic)).json()).user, alice.id);
        assert.strictEqual((await request('/opds?user=bob', basic)).status, 403);
    });
}

async function testProxyProfileBindingAndIdentityChange() {
    await fixture({authMode: 'proxy', proxyBindProfile: true, trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']},
        async({config, worker, alice, bob, request, session, connect}) => {
            assert.strictEqual((await request('/')).status, 401, 'Binding itself requires trusted SSO identity');
            const browser = session();
            browser.value.profileAccessToken = worker.createProfileSession('admin');
            const oldToken = browser.value.profileAccessToken;
            const headers = {cookie: browser.cookie, 'Remote-User': ' ALICE '};
            const call = await connect(headers);
            const authed = await call({action: 'get-config', userId: bob.id, profileAccessToken: oldToken});
            assert.strictEqual(authed.currentUserId, alice.id);
            assert.strictEqual(authed.profileBoundId, alice.id);
            assert.strictEqual(authed.profileAuthorized, true, 'SSO avoids a second password prompt');
            assert.deepStrictEqual(authed.userProfiles.map(user => user.id), [alice.id]);
            assert.strictEqual(authed.userProfiles[0].requiresLogin, false);
            assert.strictEqual(authed.currentUserProfile.emailTo, 'alice@example.test');
            assert.strictEqual((await request('/admin-backups/fixture.zip', headers)).status, 403, 'Stale admin cookie cannot grant backup access');
            const switched = await call({action: 'get-reading-lists', userId: bob.id, profileAccessToken: oldToken, profileBoundId: ''});
            assert.match(switched.error, /закреплён/);
            const renamed = await call({action: 'update-user-profile', targetUserId: alice.id, profile: {login: 'changed'}, csrfToken: authed.csrfToken});
            assert.match(renamed.error, /закреплён/);
            assert.match((await call({action: 'login-user-profile', login: 'bob', password: 'ignored', csrfToken: authed.csrfToken})).error, /закреплён/);
            assert.strictEqual((await request('/opds?user=bob', headers)).status, 403);
            assert.strictEqual((await (await request('/opds?user=alice', headers)).json()).user, alice.id);
            const ownList = await worker.readingListStore.createList(alice.id, 'Alice OPDS list', 'opds');
            const otherList = await worker.readingListStore.createList(bob.id, 'Bob OPDS list', 'opds');
            const profiles = await (await request('/opds/reading-profiles', headers)).text();
            assert.ok(profiles.includes('Alice'));
            assert.ok(!profiles.includes('Bob'));
            assert.strictEqual((await request(`/opds/reading-lists/list?id=${ownList.id}`, headers)).status, 200);
            const other = await request(`/opds/reading-lists/list?id=${otherList.id}`, headers);
            assert.strictEqual(other.status, 404);
            assert.ok(!(await other.text()).includes('Bob OPDS list'));
            const boundToken = browser.value.profileAccessToken;
            const bobCall = await connect({...headers, 'Remote-User': 'bob'});
            const bobConfig = await bobCall({action: 'get-config', userId: alice.id, profileAccessToken: boundToken});
            assert.strictEqual(bobConfig.currentUserId, bob.id);
            assert.strictEqual(bobConfig.currentUserProfile.emailTo, 'bob@example.test');
            assert.strictEqual(worker.getProfileSessionUser(boundToken), '', 'Previous bound token must be revoked');
            const adminHeaders = {...headers, 'Remote-User': 'admin'};
            const adminCall = await connect(adminHeaders);
            const adminConfig = await adminCall({action: 'get-config', userId: bob.id});
            assert.strictEqual(adminConfig.currentUserProfile.isAdmin, true);
            assert.ok(adminConfig.userProfiles.some(user => user.id === bob.id), 'Bound admins retain profile management');
            assert.strictEqual((await request('/admin-backups/fixture.zip', adminHeaders)).status, 200);
            const unknownCall = await connect({...headers, 'Remote-User': 'unmapped'});
            const legacy = await unknownCall({action: 'get-config', userId: bob.id});
            assert.strictEqual(legacy.profileBoundId, '');
            assert.strictEqual(legacy.currentUserId, bob.id, 'Unmapped SSO user keeps legacy selection');
            assert.strictEqual(browser.value.proxyProfileUserId, undefined);
            await worker.deleteUserProfile(alice.id);
            const removed = await call({action: 'get-config', userId: bob.id});
            assert.strictEqual(removed.profileBoundId, '');
            config.proxyBindProfile = false;
            assert.strictEqual((await request('/')).status, 200);
        });
}

async function testLegacyAccessAndGlobalOpdsCredentials() {
    await fixture({}, async({request, connect, bob}) => {
        assert.strictEqual((await request('/book/fixture.txt')).status, 200);
        assert.strictEqual((await request('/opds')).status, 200);
        const call = await connect();
        assert.strictEqual((await call({action: 'get-config', userId: bob.id})).currentUserId, bob.id);
    });
    await fixture({allowAnonymousAccess: false, opds: {enabled: true, user: 'catalog', password: 'opds-fixture'}}, async({request}) => {
        const headers = {authorization: 'Basic ' + Buffer.from('catalog:opds-fixture').toString('base64')};
        assert.strictEqual((await request('/opds', headers)).status, 200);
        assert.strictEqual((await request('/book/fixture.txt', headers)).status, 200, 'OPDS readers can download acquisitions');
        assert.strictEqual((await request('/book/fixture.txt')).status, 401);
    });
}

module.exports = [testProxyHeaderRequiredWithOldCookie, testAnonymousAccessDisabledHttpAndWebSocket,
    testProxyProfileBindingAndIdentityChange, testLegacyAccessAndGlobalOpdsCredentials];
