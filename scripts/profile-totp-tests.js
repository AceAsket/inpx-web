const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const ProfileTotp = require('../server/core/ProfileTotp');
const ProfilePassword = require('../server/core/ProfilePassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const SecretStore = require('../server/core/SecretStore');

const badCredentials = {code:'INPX_INVALID_PROFILE_CREDENTIALS'};
const needsOtp = {code:'need_profile_otp'};
const needsLogin = {message:'need_profile_login'};
const interval = 30000;
const fixturePassword = 'reader-fixture-password';

function makeWorker(config) {
    const Worker = require('../server/core/WebWorker');
    return Object.assign(Object.create(Worker.prototype), {config, myState:'normal', profileSessions:new Map(),
        readingListStore:new ReadingListStore(config)});
}

async function fixture(run) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-totp-'));
    const now = Date.now;
    const clock = {value:Math.floor(now() / interval) * interval + 5000};
    Date.now = () => clock.value;
    try {
        await run({dataDir, adminPassword:'fixture-admin-password'}, clock);
    } finally {
        Date.now = now;
        await fs.remove(dataDir);
    }
}

function codeFor(secret, time) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret, letter => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    return ProfileTotp.hotp(key, Math.floor(time / interval));
}

async function testProfileTotpRfcVectors() {
    const key = Buffer.from('12345678901234567890');
    const vectors = [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],
        [1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']];
    for (const [unix, code] of vectors)
        assert.equal(ProfileTotp.hotp(key, Math.floor(unix / 30), 8), code);
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(ProfileTotp.verify(secret, '287082', -1, 59000), 1);
    assert.equal(ProfileTotp.verify(secret, '287082', -1, 61000), 1);
    assert.equal(ProfileTotp.verify(secret, '287082', 1, 61000), null);
    assert.equal(ProfileTotp.verify(secret, '287082', -1, 91000), null);
}

async function testProfileTotpEnrollmentAndRestarts() {
    await fixture(async(config, clock) => {
        const worker = makeWorker(config);
        const store = worker.readingListStore;
        const user = await store.createUser({name:'Reader', login:'reader',
            passwordHash:ProfilePassword.legacy('reader', fixturePassword)});
        const other = await worker.loginUserProfile(user.login, fixturePassword);
        const {profileAccessToken:token} = await worker.loginUserProfile(user.login, fixturePassword);
        const action = (operation, payload = {}) => worker.profileTotpAction(user.id, token, operation, {password:fixturePassword, ...payload});
        assert.deepEqual(await action('status'), {otpEnabled:false, recoveryCodesRemaining:0, opdsAppPasswordSet:false, hasPassword:true});
        const setup = await action('start');
        assert.match(setup.secret, /^[A-Z2-7]{32}$/);
        assert.equal(new URL(setup.otpAuthUri).searchParams.get('secret'), setup.secret);
        assert.equal(new URL(setup.otpAuthUri).searchParams.get('period'), '30');
        assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(setup.secret));
        const code = codeFor(setup.secret, clock.value);
        await assert.rejects(worker.profileTotpAction(user.id, other.profileAccessToken, 'enable', {password:fixturePassword, code}), /Начните/);
        await assert.rejects(action('enable', {code, password:'wrong'}), badCredentials);
        const enabled = await action('enable', {code});
        assert.equal(enabled.otpEnabled, true);
        assert.equal(enabled.recoveryCodes.length, 8);
        assert.equal(new Set(enabled.recoveryCodes).size, 8);
        assert.equal(worker.getProfileSessionUser(other.profileAccessToken), '');
        assert.equal(worker.getProfileSessionUser(token), user.id);
        await assert.rejects(worker.loginUserProfile(user.login, 'incorrect'), badCredentials);
        await assert.rejects(worker.loginUserProfile(user.login, fixturePassword), needsOtp);
        await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, code), badCredentials);
        await assert.rejects(action('disable', {code}), badCredentials);
        const raw = await fs.readFile(store.file, 'utf8');
        const stored = (await store.getUser(user.id)).profileTotp;
        assert.ok(SecretStore.isEncrypted(stored.secret));
        assert.equal(await ProfileTotp.readSecret(new SecretStore(config), user.id, stored), setup.secret);
        assert.ok(!raw.includes(setup.secret) && enabled.recoveryCodes.every(value => !raw.includes(value)));
        const personal = JSON.stringify(await store.exportData(user.id));
        assert.ok(!personal.includes('profileTotp') && stored.recoveryHashes.every(hash => !personal.includes(hash)));
        const {user:updated} = await worker.updateUserProfile(user.id, {name:'Reader changed'});
        assert.ok(!Object.hasOwn(updated,'profileTotp') && !Object.hasOwn(updated,'passwordHash'));
        await assert.rejects(worker.updateUserProfile(user.id, {login:''}), /Сначала отключите/);

        const restarted = makeWorker(config);
        clock.value += interval;
        const nextCode = codeFor(setup.secret, clock.value);
        const concurrent = await Promise.allSettled([
            worker.loginUserProfile(user.login, fixturePassword, nextCode),
            restarted.loginUserProfile(user.login, fixturePassword, nextCode),
        ]);
        assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1);
        assert.equal(concurrent.find(value => value.status === 'rejected').reason.code, badCredentials.code);

        const [first, second, third] = enabled.recoveryCodes;
        const recoveryLogin = await restarted.loginUserProfile(user.login, fixturePassword, first);
        await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, first), badCredentials);
        await assert.rejects(restarted.profileTotpAction(user.id, token, 'status'), needsLogin);
        const resumedAction = (operation, code) => restarted.profileTotpAction(user.id, recoveryLogin.profileAccessToken,
            operation, {password:fixturePassword, code});
        assert.equal((await resumedAction('status')).recoveryCodesRemaining, 7);
        const regenerated = await resumedAction('regenerate-recovery', second);
        assert.equal(regenerated.recoveryCodes.length, 8);
        await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, third), badCredentials);
        await assert.rejects(resumedAction('disable'), badCredentials);
        assert.equal((await resumedAction('disable', regenerated.recoveryCodes[0])).otpEnabled, false);
        assert.ok((await makeWorker(config).loginUserProfile(user.login, fixturePassword)).profileAccessToken);
    });
}

async function testProfileTotpExpiryRateAndFailedWrites() {
    await fixture(async(config, clock) => {
        const worker = makeWorker(config);
        const user = await worker.readingListStore.createUser({name:'Reader', login:'reader',
            passwordHash:ProfilePassword.legacy('reader', fixturePassword)});
        const {profileAccessToken:token} = await worker.loginUserProfile(user.login, fixturePassword);
        const action = (operation, code) => worker.profileTotpAction(user.id, token, operation, {password:fixturePassword, code});
        const expired = await action('start');
        clock.value += 5 * 60 * 1000;
        await assert.rejects(action('enable', codeFor(expired.secret, clock.value)), /Начните/);
        const setup = await action('start');
        await action('enable', codeFor(setup.secret, clock.value));
        clock.value += interval;
        const code = codeFor(setup.secret, clock.value);
        const store = worker.readingListStore;
        const write = store.save;
        store.save = async() => { throw new Error('Local fixture write failed'); };
        try {
            await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, code), /fixture write failed/);
            assert.equal(worker.profileSessions.size, 1);
        } finally {
            store.save = write;
        }
        assert.ok((await worker.loginUserProfile(user.login, fixturePassword, code)).profileAccessToken);

        for (let attempt = 0; attempt < 8; attempt++)
            await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, 'bad'), badCredentials);
        clock.value += interval;
        await assert.rejects(worker.loginUserProfile(user.login, fixturePassword, codeFor(setup.secret, clock.value)), badCredentials);
        clock.value += 5 * 60 * 1000;
        assert.ok((await worker.loginUserProfile(user.login, fixturePassword, codeFor(setup.secret, clock.value))).profileAccessToken);
    });
}

async function testProfileTotpAdminPasswordReset() {
    await fixture(async(config, clock) => {
        const worker = makeWorker(config);
        const admin = (await worker.readingListStore.load()).users.find(user => user.isAdmin);
        const login = await worker.loginUserProfile(admin.login, config.adminPassword);
        const change = (operation, code) => worker.profileTotpAction(admin.id, login.profileAccessToken,
            operation, {password:config.adminPassword, code});
        const setup = await change('start');
        await change('enable', codeFor(setup.secret, clock.value));
        const changedPassword = 'admin-new-fixture-password';
        await worker.updateUserProfile(admin.id, {passwordHash:await ProfilePassword.hash(changedPassword)});
        await assert.rejects(worker.loginUserProfile(admin.login, changedPassword), needsOtp);
        const recovered = makeWorker({...config, resetAdminPassword:true});
        assert.ok((await recovered.loginUserProfile(admin.login, config.adminPassword)).profileAccessToken);
        assert.ok(!(await recovered.readingListStore.getUser(admin.id)).profileTotp);
    });
}

async function testProfileTotpFullBackupRestoresMatchingKey() {
    await fixture(async(config, clock) => {
        config.configFile = path.join(config.dataDir, 'config.json');
        config.adminEventLogEnabled = false;
        config.tempDir = config.dataDir;
        await fs.writeJson(config.configFile, {coverCacheSize:256});
        const worker = makeWorker(config);
        const user = await worker.readingListStore.createUser({name:'Reader', login:'reader',
            passwordHash:ProfilePassword.legacy('reader', fixturePassword)});
        const {profileAccessToken:token} = await worker.loginUserProfile(user.login, fixturePassword);
        const action = (operation, code) => worker.profileTotpAction(user.id, token, operation, {password:fixturePassword, code});
        const setup = await action('start');
        const enabled = await action('enable', codeFor(setup.secret, clock.value));
        const {fileName} = await worker.writeAdminBackupSnapshot();
        const contentBase64 = (await fs.readFile(path.join(config.dataDir, 'backups', fileName))).toString('base64');
        const dataDir = path.join(config.dataDir, 'restored');
        await fs.ensureDir(dataDir);
        const restoredWorker = makeWorker({...config, dataDir, configFile:path.join(dataDir, 'config.json')});
        const admin = await restoredWorker.loginUserProfile('admin', config.adminPassword);
        const restore = payload => restoredWorker.importAdminBackup(admin.userId, admin.profileAccessToken, payload);
        const result = await restore({contentBase64});
        assert.ok(result.restored.includes('secret.key'));
        await assert.rejects(restoredWorker.loginUserProfile(user.login, fixturePassword), needsOtp);
        await assert.rejects(restoredWorker.loginUserProfile(user.login, fixturePassword, codeFor(setup.secret, clock.value)), badCredentials);
        clock.value += interval;
        assert.ok((await restoredWorker.loginUserProfile(user.login, fixturePassword, codeFor(setup.secret, clock.value))).profileAccessToken);
        assert.ok((await restoredWorker.loginUserProfile(user.login, fixturePassword, enabled.recoveryCodes[0])).profileAccessToken);
    });
}

async function testAdminRecoversAnotherProfileTotp() {
    await fixture(async(config, clock) => {
        const worker = makeWorker(config);
        const store = worker.readingListStore;
        const addReader = name => store.createUser({name, login:name, passwordHash:ProfilePassword.legacy(name, fixturePassword)});
        const reader = await addReader('reader');
        const unrelated = await addReader('unrelated');
        const makeEnrollment = async(login, password) => {
            const {profileAccessToken:token, userId} = await worker.loginUserProfile(login, password);
            const action = (operation, code) => worker.profileTotpAction(userId, token, operation, {password, code});
            const setup = await action('start');
            const enabled = await action('enable', codeFor(setup.secret, clock.value));
            return {token, userId, setup, action, recoveryCodes:enabled.recoveryCodes};
        };
        const admin = await makeEnrollment('admin', config.adminPassword);
        const user = await makeEnrollment(reader.login, fixturePassword);
        const other = await makeEnrollment(unrelated.login, fixturePassword);
        const {opdsAppPassword} = await user.action('create-opds-password', user.recoveryCodes[0]);
        assert.equal((await store.verifyOpdsPassword(reader.id,reader.login,opdsAppPassword)).authorized, true);
        const reset = (target = reader.id, password = config.adminPassword, code = '', token = admin.token) =>
            worker.resetUserProfileTotp(admin.userId, token, target, password, code);

        assert.ok((await worker.getUserProfiles()).users.every(profile => !Object.hasOwn(profile,'otpEnabled')));
        assert.equal((await worker.getUserProfiles(admin.userId,{includeTotpStatus:true})).users.find(profile => profile.id === reader.id).otpEnabled,true);
        await assert.rejects(reset(reader.id, config.adminPassword,'',other.token), needsLogin);
        await assert.rejects(worker.resetUserProfileTotp(unrelated.id, other.token, reader.id, fixturePassword, other.recoveryCodes[0]), /Только администратор/);
        await assert.rejects(reset(admin.userId), /Свою двухфакторную/);
        await assert.rejects(reset(reader.id,'incorrect',admin.recoveryCodes[0]), badCredentials);
        await assert.rejects(reset(), badCredentials);
        await assert.rejects(reset(reader.login, config.adminPassword,admin.recoveryCodes[0]), /Пользователь не найден/);

        clock.value += interval;
        const code = codeFor(admin.setup.secret, clock.value);
        const write = store.save;
        store.save = async() => {throw new Error('Local fixture write failed');};
        try {
            await assert.rejects(reset(reader.id, config.adminPassword, code), /fixture write failed/);
        } finally {store.save = write;}
        assert.equal(worker.getProfileSessionUser(user.token), reader.id);
        assert.equal((await store.verifyOpdsPassword(reader.id,reader.login,opdsAppPassword)).authorized, true);

        const readStore = store.load;
        const extraAdminToken = worker.createProfileSession(admin.userId);
        store.load = async() => {
            const data = await readStore.call(store);
            worker.closeProfileSession(extraAdminToken);
            return data;
        };
        try {
            await assert.rejects(reset(reader.id, config.adminPassword, code,extraAdminToken), needsLogin);
        } finally {store.load = readStore;}
        assert.equal((await store.getUser(reader.id)).opdsAuthEnabled, false);

        worker.pendingProfileTotp.set('expired-target-token', {userId:reader.id});
        const result = await reset(reader.id, config.adminPassword, code);
        assert.deepEqual(result,{userId:reader.id,otpEnabled:false,opdsAppPasswordSet:false,opdsEnabled:true,opdsAuthEnabled:true});
        assert.equal(worker.getProfileSessionUser(user.token),'');
        assert.equal(worker.getProfileSessionUser(admin.token),admin.userId);
        assert.equal(worker.getProfileSessionUser(other.token),other.userId);
        assert.equal(worker.pendingProfileTotp.has('expired-target-token'),false);
        assert.equal((await store.verifyOpdsPassword(reader.id,reader.login,opdsAppPassword)).authorized,false);
        assert.equal((await store.verifyOpdsPassword(reader.id,'','')).authorized,false);
        assert.equal((await store.verifyOpdsPassword(reader.id,reader.login,fixturePassword)).authorized,true);
        assert.ok((await makeWorker(config).loginUserProfile(reader.login, fixturePassword)).profileAccessToken);
        assert.deepEqual(worker.adminEvents.at(-1).details,{adminId:admin.userId,userId:reader.id});
        await assert.rejects(reset(unrelated.id,config.adminPassword,code),badCredentials);
        await assert.rejects(reset(reader.id,config.adminPassword,admin.recoveryCodes[0]), /не включена/);
        config.opds = {password:'shared-opds-fixture'};
        assert.equal((await reset(unrelated.id,config.adminPassword,admin.recoveryCodes[0])).opdsEnabled,false);
        assert.equal(await store.getOpdsUser(unrelated.id),null);
        await assert.rejects(worker.loginUserProfile('admin',config.adminPassword,admin.recoveryCodes[0]),badCredentials);
    });
}

module.exports = [testProfileTotpRfcVectors, testProfileTotpEnrollmentAndRestarts,
    testProfileTotpExpiryRateAndFailedWrites, testProfileTotpAdminPasswordReset, testProfileTotpFullBackupRestoresMatchingKey,
    testAdminRecoversAnotherProfileTotp];

if (require.main === module) {
    require('../server/core/Logger');
    (async() => {
        await new (require('../server/core/AppLogger'))().init({loggingEnabled:false, name:'profile-totp-tests'});
        for (const test of module.exports) {
            await test();
            console.log(`ok ${test.name}`);
        }
    })().catch(error => {console.error(error); process.exitCode = 1;});
}
