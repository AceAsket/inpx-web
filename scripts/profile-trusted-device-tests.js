const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const express = require('express');
const ProfileTotp = require('../server/core/ProfileTotp');
const ProfilePassword = require('../server/core/ProfilePassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const SecretStore = require('../server/core/SecretStore');
const Security = require('../server/core/Security');
const {defaults, maximumTrustedBrowserDays, normalize} = require('../server/core/ProfileAuthPolicy');

const origin = 'https://library.example.test';
const password = 'test-reader-password';
const adminPassword = 'test-admin-password';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const codeFor = time => ProfileTotp.hotp(Buffer.from('12345678901234567890'), Math.floor(time / 30000));

async function fixture(run) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-trusted-device-'));
    const config = {dataDir, adminPassword, adminEventLogEnabled:false, rootPathStatic:'/lib',
        trustProxy:true, trustedProxyCidrs:['127.0.0.1/32']};
    const Worker = require('../server/core/WebWorker');
    const makeWorker = () => Object.assign(Object.create(Worker.prototype), {config, myState:'normal', profileSessions:new Map(),
        readingListStore:new ReadingListStore(config)});
    const worker = makeWorker();
    const store = worker.readingListStore;
    const now = Date.now;
    const clock = {value:Math.floor(now() / 30000) * 30000 + 10000};
    Date.now = () => clock.value;
    try {
        const passwordHash = await ProfilePassword.hash(password);
        const reader = await store.createUser({name:'Reader', login:'reader', passwordHash});
        const another = await store.createUser({name:'Another', login:'another', passwordHash});
        const enable = async user => {
            const {state, recoveryCodes} = await ProfileTotp.enable(new SecretStore(config), user.id, secret, -1);
            await store.updateProfileCredentials(user.id, {profileTotp:state});
            return recoveryCodes;
        };
        const recoveryCodes = await enable(reader);
        await enable(another);
        await run({clock, config, store, worker, makeWorker, reader, another, recoveryCodes});
    } finally {
        Date.now = now;
        await fs.remove(dataDir);
    }
}

async function testTrustedBrowserLoginRequiresSecureSessionPasswordAndFreshTotp() {
    const expectedDefaults = {otpRequired:false, trustedBrowsersEnabled:true, trustedBrowserDays:30};
    assert.deepEqual(normalize(), expectedDefaults);
    assert.deepEqual(normalize({otpRequired:true}), {...expectedDefaults, otpRequired:true});
    await fixture(async({clock, config, store, worker, makeWorker, reader, another, recoveryCodes}) => {
        const security = new Security(config);
        await security.init();
        const app = express();
        app.use(security.middleware());
        const profileAccess = new (require('../server/core/ProfileAccess'))(config, worker, security);
        require('../server/core/ProfileWebLogin').register(app, config, worker, security,
            {hasAccess:async token => token === 'library-access'}, profileAccess);
        app.get('/lib/', (req, res) => res.json({csrfToken:security.getCsrfToken(req)}));
        const server = app.listen(0, '127.0.0.1');
        try {
            if (!server.listening) await require('events').once(server, 'listening');
            const base = `http://127.0.0.1:${server.address().port}/lib/`;
            const proxy = {'x-forwarded-proto':'https', 'x-forwarded-host':'library.example.test'};
            const bootstrap = await fetch(base, {headers:proxy});
            const sessionCookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
            const {csrfToken} = await bootstrap.json();
            const post = async(body = {}, headers = {}) => {
                const response = await fetch(base + 'api/profile/login', {method:'POST',
                    headers:{...proxy, cookie:sessionCookie, origin, 'content-type':'application/json', ...headers},
                    body:JSON.stringify({login:reader.login, password, csrfToken, accessToken:'library-access', ...body})});
                return {status:response.status, cookies:response.headers.getSetCookie(), data:await response.json()};
            };
            assert.equal((await post({}, {'x-forwarded-proto':'http'})).status, 403);
            assert.equal((await post({}, {origin:'https://elsewhere.example.test'})).status, 403);
            assert.equal((await post({}, {cookie:''})).status, 403);
            assert.equal((await post({csrfToken:'wrong'})).data.code, 'bad_csrf_token');
            assert.equal((await post({accessToken:'wrong'})).data.code, 'need_access_token');
            assert.equal((await post({rememberDevice:true})).data.code, 'need_profile_otp');
            const recovery = await post({otp:recoveryCodes[0], rememberDevice:true});
            assert.equal(recovery.status, 200);
            assert.deepEqual(recovery.cookies, []);
            assert.equal((await post({otp:codeFor(clock.value), rememberDevice:true, password:'wrong'})).status, 401);

            const first = await post({otp:codeFor(clock.value), rememberDevice:true});
            assert.equal(first.status, 200);
            assert.deepEqual(Object.keys(first.data).sort(), ['profileAccessToken','userId']);
            assert.equal(worker.getProfileSessionUser(first.data.profileAccessToken), reader.id);
            assert.equal(first.cookies.length, 1);
            assert.match(first.cookies[0], /^inpx_web_trusted_device=[a-f\d]{64};/);
            for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=2592000', 'Path=/lib'])
                assert.ok(first.cookies[0].split('; ').includes(attribute), `missing ${attribute}`);
            const deviceCookie = first.cookies[0].split(';')[0];
            const deviceToken = deviceCookie.split('=')[1];
            assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(deviceToken));
            assert.ok(!JSON.stringify(await store.exportSnapshot()).includes('profileTrustedDevices'));
            const browser = {cookie:`${sessionCookie}; ${deviceCookie}`};
            assert.equal((await post({password:'wrong'}, browser)).status, 401);
            assert.equal((await post({login:another.login}, browser)).data.code, 'need_profile_otp');
            assert.equal((await post({otp:'not valid'}, browser)).status, 401);
            const signedIn = await post({}, browser);
            assert.equal(signedIn.status, 200);
            assert.deepEqual(signedIn.cookies, []);
            assert.equal(worker.getProfileSessionUser(signedIn.data.profileAccessToken), reader.id);
            assert.equal((await post()).data.code, 'need_profile_otp');

            const action = payload => worker.profileTotpAction(reader.id, signedIn.data.profileAccessToken, 'revoke-trusted-devices', payload);
            await assert.rejects(action({password, code:deviceToken}), {code:'INPX_INVALID_PROFILE_CREDENTIALS'});
            clock.value += 30000;
            const status = await action({password, code:codeFor(clock.value)});
            assert.equal(status.trustedDeviceCount, 0);
            assert.equal(worker.getProfileSessionUser(first.data.profileAccessToken), '');
            assert.equal((await post({}, browser)).data.code, 'need_profile_otp');

            const admin = await worker.loginUserProfile('admin', adminPassword);
            const setPolicy = policy => worker.setProfileAuthPolicy(admin.userId, admin.profileAccessToken, policy, adminPassword);
            await setPolicy({...defaults, trustedBrowserDays:maximumTrustedBrowserDays});
            clock.value += 30000;
            const longerGrant = await post({otp:codeFor(clock.value), rememberDevice:true});
            assert.equal(longerGrant.status, 200);
            assert.match(longerGrant.cookies[0], new RegExp(`Max-Age=${maximumTrustedBrowserDays * 86400}(?:;|$)`));
            const longBrowser = {cookie:`${sessionCookie}; ${longerGrant.cookies[0].split(';')[0]}`};
            assert.equal((await post({}, longBrowser)).status, 200);

            await setPolicy({...defaults, trustedBrowserDays:1});
            assert.equal((await post({}, longBrowser)).data.code, 'need_profile_otp');
            clock.value += 30000;
            const shortGrant = await post({otp:codeFor(clock.value), rememberDevice:true});
            assert.match(shortGrant.cookies[0], /Max-Age=86400(?:;|$)/);
            const shortBrowser = {cookie:`${sessionCookie}; ${shortGrant.cookies[0].split(';')[0]}`};
            await setPolicy({...defaults, trustedBrowsersEnabled:false, trustedBrowserDays:1});
            assert.deepEqual((await makeWorker().readingListStore.load()).profileAuthPolicy,
                {...defaults, trustedBrowsersEnabled:false, trustedBrowserDays:1});
            assert.equal((await post({}, shortBrowser)).data.code, 'need_profile_otp');
            clock.value += 30000;
            const loginWhileDisabled = await post({otp:codeFor(clock.value), rememberDevice:true});
            assert.equal(loginWhileDisabled.status, 200);
            assert.deepEqual(loginWhileDisabled.cookies, []);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
}

async function testTrustedBrowserExpiresAndIsRevokedByCredentialChanges() {
    await fixture(async({clock, worker, store, makeWorker, reader, another, recoveryCodes}) => {
        const signIn = () => worker.loginUserProfile(reader.login, password, codeFor(clock.value), {rememberDevice:true});
        const {trustedDeviceToken:first, trustedDeviceMaxAge:firstLifetime} = await signIn();
        assert.equal(firstLifetime, defaults.trustedBrowserDays * 86400);
        const restarted = makeWorker();
        assert.equal((await restarted.loginUserProfile(reader.login, password, '', {trustedDeviceToken:first})).userId, reader.id);
        clock.value += firstLifetime * 1000;
        await assert.rejects(restarted.loginUserProfile(reader.login, password, '', {trustedDeviceToken:first}), {code:'need_profile_otp'});

        const {trustedDeviceToken:second} = await signIn();
        const updated = await worker.updateUserProfile(reader.id, {name:'Renamed'});
        assert.ok(!Object.hasOwn(updated.user, 'profileTrustedDevices'));
        assert.equal((await restarted.loginUserProfile(reader.login, password, '', {trustedDeviceToken:second})).userId, reader.id);
        const changedPassword = 'changed-fixture-password';
        await worker.updateUserProfile(reader.id, {passwordHash:await ProfilePassword.hash(changedPassword)});
        await assert.rejects(restarted.loginUserProfile(reader.login, changedPassword, '', {trustedDeviceToken:second}), {code:'need_profile_otp'});

        clock.value += 30000;
        const third = await worker.loginUserProfile(reader.login, changedPassword, codeFor(clock.value), {rememberDevice:true});
        await worker.profileTotpAction(reader.id, third.profileAccessToken, 'disable', {password:changedPassword, code:recoveryCodes[0]});
        assert.deepEqual((await store.getProfileCredentials(reader.id)).profileTrustedDevices, []);

        const admin = await worker.loginUserProfile('admin', adminPassword);
        await worker.loginUserProfile(another.login, password, codeFor(clock.value), {rememberDevice:true});
        await worker.resetUserProfileTotp(admin.userId, admin.profileAccessToken, another.id, adminPassword);
        assert.deepEqual((await store.getProfileCredentials(another.id)).profileTrustedDevices, []);
    });
}

async function testRequiredOtpAllowsOnlyOptedInTrustedBrowsers() {
    await fixture(async({clock, config, worker, store, reader}) => {
        const signIn = () => worker.loginUserProfile(reader.login, password, codeFor(clock.value), {rememberDevice:true});
        const {trustedDeviceToken:token, profileAccessToken} = await signIn();
        const admin = await worker.loginUserProfile('admin', adminPassword);
        const {state} = await ProfileTotp.enable(new SecretStore(config), admin.userId, secret, -1);
        await store.updateProfileCredentials(admin.userId, {profileTotp:state});
        const setPolicy = changes => worker.setProfileAuthPolicy(admin.userId, admin.profileAccessToken,
            {...defaults, otpRequired:true, ...changes}, adminPassword, codeFor(clock.value));

        await setPolicy();
        assert.equal(worker.getProfileSessionUser(profileAccessToken), '');
        assert.equal((await worker.loginUserProfile(reader.login, password, '', {trustedDeviceToken:token})).userId, reader.id);
        await assert.rejects(worker.loginUserProfile(reader.login, password), {code:'need_profile_otp'});
        await assert.rejects(worker.loginUserProfile(reader.login, 'wrong', '', {trustedDeviceToken:token}), {code:'INPX_INVALID_PROFILE_CREDENTIALS'});
        clock.value += 30000;
        const {trustedDeviceToken:newToken} = await signIn();
        assert.ok(newToken);
        await setPolicy({trustedBrowsersEnabled:false});
        assert.deepEqual((await store.getProfileCredentials(reader.id)).profileTrustedDevices, []);
        await assert.rejects(worker.loginUserProfile(reader.login, password, '', {trustedDeviceToken:token}), {code:'need_profile_otp'});
        await assert.rejects(worker.loginUserProfile(reader.login, password, '', {trustedDeviceToken:newToken}), {code:'need_profile_otp'});
        clock.value += 30000;
        const result = await signIn();
        assert.equal(result.userId, reader.id);
        assert.ok(!Object.hasOwn(result, 'trustedDeviceToken'));
    });
}

module.exports = [testTrustedBrowserLoginRequiresSecureSessionPasswordAndFreshTotp, testTrustedBrowserExpiresAndIsRevokedByCredentialChanges,
    testRequiredOtpAllowsOnlyOptedInTrustedBrowsers];

if (require.main === module) {
    require('../server/core/Logger');
    (async() => {
        await new (require('../server/core/AppLogger'))().init({loggingEnabled:false, name:'profile-trusted-device-tests'});
        for (const test of module.exports) {
            await test();
            console.log(`ok ${test.name}`);
        }
    })().catch(error => {console.error(error); process.exitCode = 1;});
}
