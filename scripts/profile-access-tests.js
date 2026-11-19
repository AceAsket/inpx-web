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

function currentTotpCode(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...secret].map(letter => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    return require('../server/core/ProfileTotp').hotp(key, Math.floor(Date.now() / 30000));
}

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
    app.use('/opds', require('../server/core/opds').scopeGuard(() => worker));
    app.get('/opds', (req, res) => res.json({user: req.query.user || ''}));
    for (const [url, name] of [['/opds/reading-profiles', 'ReadingProfilesPage'], ['/opds/reading-lists', 'ReadingListsPage'],
        ['/opds/reading-lists/list', 'ReadingListPage']]) {
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

async function testLocalRequireAuth() {
    await testAnonymousAccessDisabledHttpAndWebSocket({requireAuth:true,allowAnonymousAccess:true});
}

async function testAnonymousAccessDisabledHttpAndWebSocket(policy = {allowAnonymousAccess:false}) {
    await fixture(policy, async({worker, alice, bob, request, session, connect}) => {
        assert.strictEqual((await request('/')).status, 200, 'Login shell stays reachable');
        for (const url of ['/book/fixture.txt', '/cover/123', '/reader-lab-source/example.fb2', '/opds'])
            assert.strictEqual((await request(url)).status, 401, url);
        for (const headers of [{'sec-fetch-dest':'image'},{referer:'http://localhost/',accept:'image/webp,image/*'}]) {
            const cover = await request('/cover/123', headers);
            assert.equal(cover.status, 401);
            assert.equal(cover.headers.get('www-authenticate'), null);
        }
        assert.match((await request('/opds')).headers.get('www-authenticate'), /^Basic /);
        const browser = session();
        const call = await connect({cookie: browser.cookie});
        const config = await call({action: 'get-config', userId: bob.id, profileLoginRequired: false});
        assert.strictEqual(config.profileLoginRequired, true);
        assert.deepStrictEqual(config.userProfiles, []);
        assert.strictEqual(config.dbConfig, undefined);
        const state = await call({action: 'get-worker-state', workerId: 'server_state'});
        assert.strictEqual(state.state, 'normal');
        assert.strictEqual(state.fileName, undefined);
        for (const action of ['search', 'get-library-metadata', 'get-user-profiles', 'get-reading-lists', 'create-reading-list', 'get-admin-dashboard',
            'get-background-tasks','get-library-follows','change-library-follow','start-library-audit','cancel-library-audit','get-rating-index-status']) {
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

async function testWebSocketCatalogAuthorizationUsesProfileIdentity() {
    for (const sso of [false, true]) {
        const options = sso ? {authMode:'proxy', proxyBindProfile:true, trustProxy:true, trustedProxyCidrs:['127.0.0.1/32']}
            : {allowAnonymousAccess:false};
        await fixture({...options, extendedSearch:true}, async({worker, alice, bob, session, connect}) => {
            const browser = session();
            const headers = {cookie:browser.cookie};
            if (sso) headers['Remote-User'] = alice.login;
            else browser.value.profileAccessToken = worker.createProfileSession(alice.id);

            worker.bookSearch = async() => ({totalFound:1, found:[]});
            worker.getCatalogDiscovery = () => ({suggest:async() => ({groups:[]})});
            worker.readingListStore.load = async() => assert.fail('Catalog authorization cloned all profiles');
            const call = await connect(headers);
            const search = await call({action:'bookSearch', userId:alice.id, query:{title:'book'}});
            assert.strictEqual(search.totalFound, 1, search.error);
            const suggest = await call({action:'catalog-suggest', userId:alice.login, options:{query:'book'}});
            assert.deepStrictEqual(suggest.groups, [], suggest.error);
            assert.match((await call({action:'bookSearch', userId:bob.id, query:{title:'book'}})).error,
                sso ? /закреплён/ : /need_profile_login/);
        });
    }
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

// Profile lookups fall back to the admin: an unknown or OPDS-disabled ?user= must not reach its lists.
async function testOpdsScopeNeedsAnOpdsProfile() {
    await fixture({}, async({worker, bob, request}) => {
        const store = worker.readingListStore;
        const admin = (await store.load()).users.find(user => user.isAdmin);
        const adminList = await store.createList(admin.id, 'Admin OPDS list', 'opds');
        const bobList = await store.createList(bob.id, 'Bob OPDS list', 'opds');
        const list = (user, id) => request(`/opds/reading-lists/list?user=${encodeURIComponent(user)}&id=${encodeURIComponent(id)}`);
        assert.strictEqual((await list('no-such-user', adminList.id)).status, 404);
        assert.strictEqual((await list(admin.id, adminList.id)).status, 404, 'OPDS is off for the admin');
        assert.strictEqual((await list(bob.id, bobList.id)).status, 200);
        assert.strictEqual((await list('bob', bobList.id)).status, 200, 'A login names the profile too');
        await store.updateUser(bob.id, {opdsEnabled: false});
        assert.strictEqual((await list(bob.id, bobList.id)).status, 404, 'A profile that turned OPDS off');
    });
}

async function testOpdsScopeCanonicalizesProfileIds() {
    await fixture({}, async({worker, bob, request}) => {
        const store = worker.readingListStore;
        const hidden = await store.createUser({name: 'Hidden profile', login: 'hidden', opdsEnabled: false,
            opdsAuthEnabled: true, passwordHash: await worker.hashProfilePassword('hidden', 'hidden-fixture')});
        const hiddenList = await store.createList(hidden.id, 'Hidden shelf', 'opds');
        const bobList = await store.createList(bob.id, 'Public shelf', 'opds');
        await store.updateUser(bob.id, {login: hidden.id});
        const lists = user => request(`/opds/reading-lists?user=${encodeURIComponent(user)}`);
        const list = (user, id) => request(`/opds/reading-lists/list?user=${encodeURIComponent(user)}&id=${encodeURIComponent(id)}`);
        assert.strictEqual((await lists(hidden.id)).status, 404, 'An ID takes precedence over another profile login');
        assert.strictEqual((await list(hidden.id, hiddenList.id)).status, 404);
        await store.updateUser(hidden.id, {opdsEnabled: true});
        assert.strictEqual((await lists(hidden.id)).status, 401, 'The ID owner password must be required');
        await store.updateUser(bob.id, {login: 'bob'});
        const response = await lists('bob');
        assert.strictEqual(response.status, 200);
        const body = await response.text();
        assert.ok(body.includes('Public shelf'));
        assert.ok(body.includes(`user=${bob.id}`), 'Navigation uses the checked profile canonical ID');
        assert.strictEqual((await list('bob', bobList.id)).status, 200);
        assert.strictEqual((await list('bob', hiddenList.id)).status, 404, 'A public profile cannot read foreign lists');
    });
}

async function testAdminLogoutRevokesBrowserTokensAndKeepsOtherDevices() {
    for (const allowAnonymousAccess of [true, false]) await fixture({allowAnonymousAccess}, async({worker, request, session, connect}) => {
        const browser = session(), call = await connect({cookie: browser.cookie});
        const config = await call({action: 'get-config'});
        const first = await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture', csrfToken: config.csrfToken});
        const second = await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture', csrfToken: config.csrfToken});
        const anotherDevice = worker.createProfileSession('admin');
        assert(first.profileAccessToken && second.profileAccessToken);
        assert.equal(browser.value.profileAccessToken, second.profileAccessToken);
        const result = await call({action: 'logout-user-profile', userId: 'admin', profileAccessToken: first.profileAccessToken, csrfToken: config.csrfToken});
        assert.equal(result.success, true);
        assert.equal(browser.value.profileAccessToken, undefined);
        for (const token of [first.profileAccessToken, second.profileAccessToken]) {
            assert(!worker.getProfileSessionUser(token));
            const denied = await call({action: 'create-user-profile', userId: 'admin', profileAccessToken: token,
                csrfToken: config.csrfToken, profile: {name: 'Should not be created'}});
            assert.equal(denied.error, 'need_profile_login');
        }
        assert.equal(worker.getProfileSessionUser(anotherDevice), 'admin', 'Leaving this browser does not sign out another device');
        const afterReload = await connect({cookie: browser.cookie});
        const current = await afterReload({action: 'get-config', userId: 'default'});
        assert.equal(current.profileAuthorized, false);
        assert.equal((await request('/book/fixture.txt', {cookie: browser.cookie})).status, allowAnonymousAccess ? 200 : 401);
    });
}

async function testOpdsAppPasswordIsProfileScopedRevocableAndCannotCreateWebSession() {
    for (const allowAnonymousAccess of [false, true]) {
        await fixture({allowAnonymousAccess}, async ({config,worker,alice,bob,request}) => {
            const store = worker.readingListStore;
            const auth = (login,password) => ({authorization:'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')});
            const route = `/opds?user=${encodeURIComponent(alice.id)}`;
            assert.equal((await request(route,auth('alice','alice-fixture'))).status,200);
            const created = await store.manageOpdsAppPassword(alice.id,'create-opds-password');
            assert.equal(created.opdsAppPasswordSet,true);
            assert.equal(await store.verifyUserPassword(alice.id,created.opdsAppPassword),false);
            const state = await store.load();
            const target = state.users.find(user => user.id === alice.id);
            target.profileTotp = (await require('../server/core/ProfileTotp').enable(new (require('../server/core/SecretStore'))(config),
                alice.id,'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',-1)).state;
            await store.save(state);
            assert(!JSON.stringify(await store.exportData(alice.id)).includes('opdsAppPassword'));
            assert(!JSON.stringify(await store.load()).includes(created.opdsAppPassword));

            assert.equal((await request(route,auth('alice','alice-fixture'))).status,401);
            assert.equal((await request(route,auth('alice',created.opdsAppPassword))).status,200);
            const expectedDenied = allowAnonymousAccess ? 200 : 401;
            assert.equal((await request('/book/fixture.txt',auth('alice','alice-fixture'))).status,expectedDenied);
            assert.equal((await request('/book/fixture.txt',auth('alice',created.opdsAppPassword))).status,200);
            await store.updateUser(alice.id,{opdsAuthEnabled:false});
            assert.equal((await request(route)).status,401,'An enrolled profile remains private with the former Basic toggle off');
            assert.equal((await request(route,auth('alice',created.opdsAppPassword))).status,401,'Changing OPDS authentication revokes the previous app password');
            const privatePassword = await store.manageOpdsAppPassword(alice.id,'create-opds-password');
            config.opds.user = 'catalog';
            config.opds.password = 'global-fixture';
            assert.equal((await request('/opds',auth('catalog','global-fixture'))).status,200);
            assert.equal((await (await request('/opds',auth('alice',privatePassword.opdsAppPassword))).json()).user,alice.id);
            assert.equal((await request(route,auth('catalog','global-fixture'))).status,401);
            assert.equal((await request(route,auth('alice',privatePassword.opdsAppPassword))).status,200);
            assert.equal((await request(`/opds?user=${encodeURIComponent(bob.id)}`,auth('catalog','global-fixture'))).status,200);
            assert.equal(worker.profileSessions.size,0);

            const rotated = await store.manageOpdsAppPassword(alice.id,'create-opds-password');
            assert.notEqual(rotated.opdsAppPassword,privatePassword.opdsAppPassword);
            assert.equal((await request(route,auth('alice',privatePassword.opdsAppPassword))).status,401);
            assert.equal((await request(route,auth('alice',rotated.opdsAppPassword))).status,200);
            assert.deepEqual(await store.manageOpdsAppPassword(alice.id,'revoke-opds-password'),{opdsAppPasswordSet:false});
            assert.equal((await request(route,auth('alice',rotated.opdsAppPassword))).status,401);
        });
    }
}

async function testAndroidProtocolKeepsLegacyLoginAndRequiresOtpForEnrolledProfile() {
    await fixture({allowAnonymousAccess:false}, async({worker,alice,request,session,connect}) => {
        const client = {type:'android', version:'0.17.4', protocol:1};
        const first = session();
        const legacy = await connect({cookie:first.cookie});
        const config = await legacy({action:'get-config',client});
        assert(config.clientApi.features.includes('profileTotp'));
        const auth = await legacy({action:'login-user-profile',client,login:'alice',password:'alice-fixture',csrfToken:config.csrfToken});
        assert.equal(auth.userId,alice.id);
        assert(auth.profileAccessToken);
        const resumed = await legacy({action:'resume-user-profile',client,userId:alice.id,profileAccessToken:auth.profileAccessToken,csrfToken:config.csrfToken});
        assert.equal(resumed.userId,alice.id);
        const enrollment = await legacy({action:'profile-totp',operation:'start',userId:alice.id,profileAccessToken:auth.profileAccessToken,
            csrfToken:config.csrfToken,payload:{password:'alice-fixture'},client});
        const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const bits = [...enrollment.secret].map(letter=>table.indexOf(letter).toString(2).padStart(5,'0')).join('');
        const key = Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
        const totp = require('../server/core/ProfileTotp');
        const code = totp.hotp(key,Math.floor(Date.now()/30000));
        const enabled = await legacy({action:'profile-totp',operation:'enable',userId:alice.id,profileAccessToken:auth.profileAccessToken,
            csrfToken:config.csrfToken,payload:{password:'alice-fixture',code},client});
        assert.equal(enabled.otpEnabled,true);
        const second = session();
        const call = await connect({cookie:second.cookie});
        const fresh = await call({action:'get-config',client});
        const login = {action:'login-user-profile',client,login:'alice',password:'alice-fixture',csrfToken:fresh.csrfToken};
        const noCode = await call(login);
        assert.equal(noCode.errorCode,'need_profile_otp');
        assert.equal(noCode.profileAccessToken,undefined);
        assert.equal((await request('/book/fixture.txt',{cookie:second.cookie})).status,401);
        const entered = await call({...login,otp:enabled.recoveryCodes[0]});
        assert.equal(entered.userId,alice.id);
        assert.equal((await request('/book/fixture.txt',{cookie:second.cookie})).status,200);

        const settings = {action:'profile-totp',userId:alice.id,profileAccessToken:entered.profileAccessToken,csrfToken:fresh.csrfToken};
        const create = { ...settings, operation:'create-opds-password', payload:{password:'alice-fixture',code:enabled.recoveryCodes[1]} };
        const blocked = await call({...create,csrfToken:''});
        assert.equal(blocked.error,'bad_csrf_token');
        const app = await call(create);
        assert.equal(app.opdsAppPasswordSet,true);
        const basic = {authorization:'Basic '+Buffer.from('alice:'+app.opdsAppPassword).toString('base64')};
        assert.equal((await request('/opds?user='+alice.id,basic)).status,200);
        assert.equal((await request('/book/fixture.txt',basic)).status,200);
        const revoked = await call({...settings,operation:'revoke-opds-password',payload:{password:'alice-fixture',code:enabled.recoveryCodes[2]}});
        assert.equal(revoked.opdsAppPasswordSet,false);
        assert.equal((await request('/opds?user='+alice.id,basic)).status,401);
    });
}

async function testRequiredTotpEnrollmentBeforePrivateAccess() {
    await fixture({allowAnonymousAccess:false}, async({alice,request,session,connect}) => {
        const administrator = session();
        const admin = await connect({cookie:administrator.cookie});
        const adminConfig = await admin({action:'get-config'});
        assert(adminConfig.clientApi.features.includes('adminProfileTotpPolicy'));
        const adminLogin = await admin({action:'login-user-profile', login:'admin', password:'admin-fixture', csrfToken:adminConfig.csrfToken});
        assert(adminLogin.profileAccessToken);
        const setPolicy = {action:'set-user-profile-totp-required', targetUserId:alice.id, required:true, password:'admin-fixture'};
        assert.equal((await admin(setPolicy)).error, 'bad_csrf_token');
        assert.equal((await admin({...setPolicy, csrfToken:adminConfig.csrfToken})).otpRequired, true);

        const reader = session();
        const call = await connect({cookie:reader.cookie});
        const config = await call({action:'get-config'});
        const payload = {login:'alice', password:'alice-fixture'};
        const csrfToken = config.csrfToken;
        const login = await call({action:'login-user-profile', ...payload, csrfToken});
        assert.equal(login.errorCode, 'need_profile_otp_setup');
        assert.equal(reader.value.profileAccessToken, undefined);
        const enrollment = {action:'profile-totp-enrollment', operation:'start', payload};
        assert.equal((await call(enrollment)).error, 'bad_csrf_token');
        const pending = await call({...enrollment, csrfToken});
        assert.equal(pending.profileAccessToken, undefined);
        assert.equal((await request('/book/fixture.txt', {cookie:reader.cookie})).status, 401);
        const basic = {authorization:'Basic '+Buffer.from('alice:alice-fixture').toString('base64')};
        assert.equal((await request('/opds?user='+alice.id,basic)).status, 401);
        const code = currentTotpCode(pending.secret);
        const enabled = await call({...enrollment, operation:'enable', csrfToken, payload:{...payload, enrollmentId:pending.enrollmentId, code}});
        assert.equal(enabled.userId, alice.id);
        assert.equal(enabled.recoveryCodes.length, 8);
        assert.equal(reader.value.profileAccessToken, enabled.profileAccessToken);
        assert.equal((await request('/book/fixture.txt', {cookie:reader.cookie})).status, 200);
    });
}

async function testGlobalProfileTotpOverridesAnonymousAndSharedOpdsAccess() {
    await fixture({allowAnonymousAccess:true, opds:{enabled:true,user:'catalog',password:'shared-opds'}},
        async({worker,alice,bob,request,session,connect}) => {
            const adminBrowser = session();
            const admin = await connect({cookie:adminBrowser.cookie});
            const {csrfToken} = await admin({action:'get-config'});
            const signIn = await admin({action:'login-user-profile', login:'admin', password:'admin-fixture', csrfToken});
            assert(signIn.profileAccessToken);
            const act = (action, payload = {}) => admin({action, csrfToken, userId:signIn.userId,
                profileAccessToken:signIn.profileAccessToken, ...payload});
            const policy = {otpRequired:true, trustedBrowsersEnabled:true, trustedBrowserDays:180, password:'admin-fixture'};
            assert.match((await act('set-profile-auth-policy',policy)).error, /Сначала настройте OTP/);
            const start = await act('profile-totp', {operation:'start', payload:{password:policy.password}});
            const enrolled = await act('profile-totp', {operation:'enable', payload:{password:policy.password, code:currentTotpCode(start.secret)}});
            assert.equal(enrolled.otpEnabled, true);
            assert.match((await act('set-profile-auth-policy',{...policy,otp:enrolled.recoveryCodes[0]})).error, /Bob/);
            await worker.updateUserProfile(bob.id, {passwordHash:await worker.hashProfilePassword(bob.login, 'bob-fixture')});
            const guestPreferences = await worker.readingListStore.updateReaderPreferences('default',
                {backgroundImage:'data:image/png;base64,'+Buffer.alloc(100,7).toString('base64')});
            const previousReader = await worker.loginUserProfile(alice.login,'alice-fixture');
            assert.equal((await request('/book/fixture.txt')).status, 200);
            assert.equal((await request(guestPreferences.backgroundImage)).status, 200);
            const enabled = await act('set-profile-auth-policy',{...policy,otp:enrolled.recoveryCodes[0]});
            assert.deepEqual(enabled.profileAuthPolicy, {otpRequired:true,trustedBrowsersEnabled:true,trustedBrowserDays:180});
            assert.equal(worker.getProfileSessionUser(previousReader.profileAccessToken), '');
            assert.equal(worker.getProfileSessionUser(signIn.profileAccessToken), signIn.userId);
            assert.equal((await request('/book/fixture.txt')).status, 401);
            assert.equal((await request(guestPreferences.backgroundImage)).status, 401);
            const shared = {authorization:'Basic '+Buffer.from('catalog:shared-opds').toString('base64')};
            assert.equal((await request('/opds',shared)).status, 401);
            assert.equal((await request('/opds?user='+alice.id,shared)).status, 401);
            await assert.rejects(worker.createUserProfile({name:'No credentials'}), /логин и пароль/);
            const future = await worker.createUserProfile({name:'Future',login:'future',passwordHash:await worker.hashProfilePassword('future','future-fixture')});
            await assert.rejects(worker.loginUserProfile(future.user.login,'future-fixture'), {code:'need_profile_otp_setup'});
            await assert.rejects(worker.loginUserProfile(alice.login,'alice-fixture'), {code:'need_profile_otp_setup'});
            const restarted = new ReadingListStore({...worker.readingListStore.config});
            await restarted.loadSnapshot();
            assert.equal(restarted.profileAuthPolicy.otpRequired, true);

            const reader = session();
            const call = await connect({cookie:reader.cookie});
            const guest = await call({action:'get-config'});
            assert.equal(guest.profileLoginRequired, true);
            assert.equal(guest.profileAuthPolicy, undefined);
            const payload = {login:alice.login,password:'alice-fixture'};
            const enrollment = {action:'profile-totp-enrollment',csrfToken:guest.csrfToken};
            const pending = await call({...enrollment,operation:'start',payload});
            const confirmed = await call({...enrollment,operation:'enable',payload:{...payload,
                enrollmentId:pending.enrollmentId,code:currentTotpCode(pending.secret)}});
            assert(confirmed.profileAccessToken);
            const app = await call({action:'profile-totp',operation:'create-opds-password',csrfToken:guest.csrfToken,
                payload:{password:payload.password,code:confirmed.recoveryCodes[0]}});
            const scoped = {authorization:'Basic '+Buffer.from(alice.login+':'+app.opdsAppPassword).toString('base64')};
            assert.equal((await request('/opds?user='+alice.id,scoped)).status, 200);
            const disabled = await act('set-profile-auth-policy',{...policy,otpRequired:false,otp:enrolled.recoveryCodes[1]});
            assert.equal(disabled.profileAuthPolicy.otpRequired, false);
            assert.equal(disabled.profileAuthPolicy.trustedBrowserDays, 180);
            assert.equal((await request('/book/fixture.txt')).status, 200);
            await assert.rejects(worker.loginUserProfile(alice.login,'alice-fixture'), {code:'need_profile_otp'});
        });
}

async function testProfileBlockRevokesAuthenticationAndPreservesData() {
    await fixture({allowAnonymousAccess:false,opds:{enabled:true,user:'catalog',password:'shared-fixture'}}, async({worker,alice,bob,request,session,connect}) => {
        const store = worker.readingListStore;
        const adminBrowser = session();
        const admin = await connect({cookie:adminBrowser.cookie});
        const config = await admin({action:'get-config'});
        assert(config.clientApi.features.includes('adminProfileBlock'));
        const auth = await admin({action:'login-user-profile',login:'admin',password:'admin-fixture',csrfToken:config.csrfToken});
        const action = {action:'set-user-profile-blocked',targetUserId:alice.id,blocked:true};
        const manage = (patch = {}) => admin({...action,csrfToken:config.csrfToken,...patch});
        assert.equal((await admin(action)).error,'bad_csrf_token');
        assert.match((await manage({targetUserId:auth.userId})).error,/собственный профиль/);
        assert.match((await manage({targetUserId:'default'})).error,/нельзя заблокировать/);

        const readerBrowser = session();
        const reader = await connect({cookie:readerBrowser.cookie});
        const readerConfig = await reader({action:'get-config'});
        const client = {type:'android',version:'0.17.4',protocol:1};
        const login = {action:'login-user-profile',login:alice.login,password:'alice-fixture',csrfToken:readerConfig.csrfToken,client};
        const readerLogin = await reader(login);
        assert(readerLogin.profileAccessToken);
        assert.match((await reader({...action,targetUserId:bob.id,csrfToken:readerConfig.csrfToken})).error,/Только администратор/);
        const list = await store.createList(alice.id, 'Alice shelf', 'opds');
        await store.updateUser(alice.id,{telegramChatId:'42'});
        assert.equal((await store.findTelegramUser('1','42')).id, alice.id);
        const otpAction = (operation, payload = {}) => reader({action:'profile-totp',operation,csrfToken:readerConfig.csrfToken,
            payload:{password:login.password,...payload}});
        const setup = await otpAction('start');
        const enrollCode = currentTotpCode(setup.secret);
        const enabled = await otpAction('enable',{code:enrollCode});
        assert(enabled.otpEnabled);
        const opds = await otpAction('create-opds-password',{code:enabled.recoveryCodes[0]});
        const basic = {authorization:'Basic '+Buffer.from(alice.login+':'+opds.opdsAppPassword).toString('base64')};
        const shared = {authorization:'Basic '+Buffer.from('catalog:shared-fixture').toString('base64')};
        assert.equal((await request('/opds?user='+alice.id,basic)).status,200);
        const koSync = new (require('../server/core/KoSync').KoSync)(worker.config,worker);
        const koAccount = await koSync.settings(alice,'enable');
        const koRequest = {headers:{'x-auth-user':alice.login,'x-auth-key':require('crypto').createHash('md5').update(koAccount.password).digest('hex')}};
        assert.equal((await koSync.authenticate(koRequest)).id,alice.id);
        const trusted = require('../server/core/ProfileTrustedDevices').issue([]);
        await store.updateProfileCredentials(alice.id,{profileTrustedDevices:trusted.devices});
        const existing = await worker.loginUserProfile(alice.login,login.password,'',{trustedDeviceToken:trusted.token});
        assert.equal(existing.userId,alice.id);

        assert.equal((await manage()).blocked,true);
        assert.equal((await manage()).blocked,true, 'Repeated block is safe');
        assert.equal(worker.getProfileSessionUser(readerLogin.profileAccessToken),'');
        assert.equal(worker.getProfileSessionUser(existing.profileAccessToken),'');
        assert.equal(worker.getProfileSessionUser(auth.profileAccessToken),auth.userId);
        const stored = await new ReadingListStore(store.config).getProfileCredentials(alice.id);
        assert.equal(stored.blocked,true);
        assert.deepEqual(stored.profileTrustedDevices,[]);
        assert.equal((await reader(login)).errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
        assert.equal((await reader({...login,otp:enabled.recoveryCodes[1]})).errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
        await assert.rejects(worker.loginUserProfile(alice.login,login.password,'',{trustedDeviceToken:trusted.token}), {code:'INPX_INVALID_PROFILE_CREDENTIALS'});
        assert.equal((await request('/book/fixture.txt',{cookie:readerBrowser.cookie})).status,401);
        assert.equal((await request('/opds?user='+alice.id,basic)).status,401);
        assert.equal((await request('/opds',shared)).status,200);
        assert.equal((await request('/opds?user='+alice.id,shared)).status,404);
        assert.equal(await koSync.authenticate(koRequest),null);
        assert.equal(await store.findTelegramUser('1','42'),null);
        assert.equal((await admin({action:'get-config'})).userProfiles.find(user=>user.id===alice.id).blocked,true);
        assert.equal((await store.getList(alice.id,list.id)).name,'Alice shelf');

        assert.equal((await manage({blocked:false})).blocked,false);
        assert.equal((await reader(login)).errorCode,'need_profile_otp');
        const fresh = await reader({...login,otp:enabled.recoveryCodes[1]});
        assert.equal(fresh.userId,alice.id);
        assert.notEqual(fresh.profileAccessToken,readerLogin.profileAccessToken);
        await assert.rejects(worker.loginUserProfile(alice.login,login.password,'',{trustedDeviceToken:trusted.token}),{code:'need_profile_otp'});
        assert.equal((await request('/opds?user='+alice.id,basic)).status,200);
        assert.equal((await koSync.authenticate(koRequest)).id,alice.id);
        assert.equal((await store.findTelegramUser('1','42')).id,alice.id);
    });
}

async function testBlockedProfileCannotUseGuestOrProxyAuthorization() {
    const proxyConfig = {authMode:'proxy',proxyBindProfile:true,trustProxy:true,trustedProxyCidrs:['127.0.0.1/32']};
    await fixture(proxyConfig, async({config,worker,bob,request,session,connect}) => {
        const readerBrowser = session();
        const headers = {cookie:readerBrowser.cookie,'Remote-User':'bob'};
        const reader = await connect(headers);
        assert.equal((await reader({action:'get-config'})).profileBoundId,bob.id);
        const token = readerBrowser.value.profileAccessToken;
        const ownerBrowser = session();
        const owner = await connect({cookie:ownerBrowser.cookie,'Remote-User':'admin'});
        const ownerConfig = await owner({action:'get-config'});
        const action = {action:'set-user-profile-blocked',targetUserId:bob.id,blocked:true,csrfToken:ownerConfig.csrfToken};
        assert.equal((await owner(action)).blocked,true);
        assert.equal(worker.getProfileSessionUser(token),'');
        assert.equal((await reader({action:'get-config'})).error,'Профиль недоступен');
        assert.equal((await request('/book/fixture.txt',headers)).status,403);
        assert.equal((await request('/opds?user=bob',headers)).status,403);

        config.proxyBindProfile = false;
        const guest = await connect();
        const guestConfig = await guest({action:'get-config',userId:bob.id});
        assert(!guestConfig.userProfiles.some(user=>user.id===bob.id));
        assert.equal(guestConfig.profileAuthorized,false);
        assert.equal((await guest({action:'get-reading-lists',userId:bob.id})).errorCode,'need_profile_login');
        assert.equal((await request('/opds?user=bob')).status,404);
        config.proxyBindProfile = true;
        assert.equal((await owner({...action,blocked:false})).blocked,false);
        assert.equal((await reader({action:'get-config'})).profileBoundId,bob.id);
        assert.notEqual(readerBrowser.value.profileAccessToken,token);
    });
}

module.exports = [testProfileBlockRevokesAuthenticationAndPreservesData,testBlockedProfileCannotUseGuestOrProxyAuthorization,testGlobalProfileTotpOverridesAnonymousAndSharedOpdsAccess,testRequiredTotpEnrollmentBeforePrivateAccess,testAndroidProtocolKeepsLegacyLoginAndRequiresOtpForEnrolledProfile,testOpdsAppPasswordIsProfileScopedRevocableAndCannotCreateWebSession,testAdminLogoutRevokesBrowserTokensAndKeepsOtherDevices, testOpdsScopeCanonicalizesProfileIds, testOpdsScopeNeedsAnOpdsProfile, testProxyHeaderRequiredWithOldCookie, testLocalRequireAuth, testAnonymousAccessDisabledHttpAndWebSocket,
    testProxyProfileBindingAndIdentityChange, testWebSocketCatalogAuthorizationUsesProfileIdentity, testLegacyAccessAndGlobalOpdsCredentials];
