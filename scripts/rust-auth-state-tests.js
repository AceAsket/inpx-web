const assert = require('node:assert/strict');
const {createHash,createHmac} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const Security = require('../server/core/Security');
const ProfileSessions = require('../server/core/ProfileSessions');
const {ProfileTotpAttempts, attemptLimit} = require('../server/core/ProfileTotpAttempts');
const ProfileTotpEnrollments = require('../server/core/ProfileTotpEnrollments');
const {WebAccessChallenges} = require('../server/core/WebAccessChallenges');
const {idleMs, maxAgeMs, maxSessions} = require('../server/core/SessionLifetime');

const request = index => ({headers:{},socket:{remoteAddress:`client-${index}`}});
const windowMs = 60_000;
const sessionToken = index => index.toString(16).padStart(48,'0');

function engine(file) {
    if (file) process.env.INPX_RUST_AUTH_WASM = file;
    else delete process.env.INPX_RUST_AUTH_WASM;
}

async function atFixedTime(task) {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {return await task(elapsed => {now += elapsed;});}
    finally {Date.now = realNow;}
}

async function testExpiryAndSaturation() {
    await atFixedTime(async advance => {
        const config = {loginRateLimitMaxAttempts:1,loginRateLimitWindowMs:windowMs};
        const security = new Security(config);
        const req = request(0);
        const outsider = request(10_000);
        for (let i=0;i<10_000;i++) security.recordLoginAttempt(request(i),false,'access');
        assert.equal(security.getLoginMetrics().activeFailedAttempts,10_000);
        assert.throws(()=>security.checkLoginRate(outsider),{code:'INPX_LOGIN_RATE_LIMIT',retryAfter:60});
        security.recordLoginAttempt(req,true,'access');
        security.checkLoginRate(outsider);
        security.recordLoginAttempt(outsider,false,'profile');
        advance(windowMs);
        assert.throws(()=>security.checkLoginRate(outsider,'profile'),{code:'INPX_LOGIN_RATE_LIMIT',retryAfter:1});
        advance(1);
        security.checkLoginRate(outsider,'profile');
        assert.equal(security.getLoginMetrics().rateLimitedIps,0);
        assert.equal(security.getLoginMetrics().activeFailedAttempts,0);
        assert.equal(security.getLoginMetrics().attempts.find(row=>row.labels.kind==='profile' && row.labels.result==='blocked').value,1);
    });
}

async function testPolicyChangeDuringVerification() {
    const config = {loginRateLimitMaxAttempts:1};
    const security = new Security(config);
    const req = request(0);
    const gate = Promise.withResolvers();
    const attempt = security.withLoginAttempt(req,'profile',()=>gate.promise);
    config.loginRateLimitEnabled = false;
    gate.resolve(false);
    await attempt;
    config.loginRateLimitEnabled = true;
    await security.withLoginAttempt(req,'profile',()=>true);
    assert.equal(security.getLoginMetrics().activeFailedAttempts,0);
    assert.equal(security.getLoginMetrics().attempts.find(row=>row.labels.kind==='profile' && row.labels.result==='failure').value,1);
}

function testProfileSessions() {
    const sessions = new ProfileSessions();
    const time = Date.now();
    assert(sessions.native);
    sessions.create('first','читатель',time);
    assert.equal(sessions.user('first',time+idleMs), '');
    assert.equal(sessions.user('first',time), '');
    sessions.create('renewed','читатель',time);
    for (let day=1;day<30;day++)
        assert.equal(sessions.user('renewed',time+day*24*60*60*1000),'читатель');
    assert.equal(sessions.user('renewed',time+maxAgeMs),'');
    for (let i=0;i<maxSessions;i++)
        sessions.create(sessionToken(i),i===0 ? 'other' : 'reader',time);
    sessions.delete(sessionToken(100));
    sessions.create('old-replacement','other',time);
    sessions.create('new-replacement','other',time);
    assert.equal(sessions.user(sessionToken(0),time),'');
    assert.equal(sessions.user(sessionToken(1),time),'reader');
    assert.equal(sessions.size,maxSessions);

    sessions.revoke('reader',sessionToken(1));
    assert.equal(sessions.size,3);
    assert.equal(sessions.user(sessionToken(1),time),'reader');
    assert.equal(sessions.user(sessionToken(2),time),'');
    sessions.clear('new-replacement');
    assert.equal(sessions.size,1);
    assert.equal(sessions.user('new-replacement',time),'other');
    sessions.clear();
    assert.equal(sessions.size,0);

    const worker = Object.create(require('../server/core/WebWorker').prototype);
    const token = worker.createProfileSession('читатель');
    const bytes = worker.profileSessions.native.api.memory.buffer.byteLength;
    const invalid = token.repeat(10_000);
    assert.equal(worker.getProfileSessionUser(invalid),'');
    worker.closeProfileSession(invalid);
    assert.equal(worker.profileSessions.native.api.memory.buffer.byteLength,bytes);
    assert.equal(worker.getProfileSessionUser(token),'читатель');
}

function testBrowserCookieCompatibility() {
    const security = new Security({});
    security.secret = 'постоянный ключ '.repeat(8);
    const legacySign = value=>createHmac('sha256',security.secret).update(value).digest('hex');
    const handle = security.ensureSession({headers:{}});
    const signed = security.packSessionId(handle.id);
    assert.equal(signed,`${handle.id}.${legacySign(handle.id)}`);
    assert.equal(security.unpackSessionId(signed+'.old-suffix'),handle.id);
    const request = {headers:{cookie:`another=value; inpx_web_session=${signed}`}};
    const loaded = security.getSession(request);
    assert(loaded);
    assert.equal(loaded.csrfToken,handle.csrfToken);
    assert(security.hasValidCsrf(request,handle.csrfToken));
    assert(!security.hasValidCsrf(request,'0'.repeat(handle.csrfToken.length)));
    assert.equal(security.getSession({headers:{cookie:request.headers.cookie+'x'}}),null);
    handle.profileAccessToken = 'profile';
    loaded.proxyProfileUserId = 'читатель';
    loaded.proxyProfileLogin = 'reader.with.dots';
    loaded.ebookAccessToken = 'library';
    assert.equal(loaded.profileAccessToken,'profile');
    assert.equal(handle.proxyProfileUserId,'читатель');
    assert.equal(handle.proxyProfileLogin,'reader.with.dots');
    assert.equal(handle.ebookAccessToken,'library');
    loaded.profileAccessToken = undefined;
    assert.equal(handle.profileAccessToken,undefined);

    const user = 'reader.ёж';
    const now = Date.now();
    const oldProxy = `${user}.${now}.${legacySign(`proxy:${user}:${now}`)}`;
    assert.equal(security.unpackProxyAuthCookie(oldProxy),user);
    assert.equal(security.unpackProxyAuthCookie(oldProxy+'x'),'');
    const clock = Date.now;
    const untouched = security.ensureSession({headers:{}});
    const issuedAt = clock();
    const untouchedCookie = 'inpx_web_session='+security.packSessionId(untouched.id);
    try {
        Date.now = () => issuedAt+idleMs-100;
        assert.equal(security.getSession({headers:{cookie:untouchedCookie+'x'}}),null);
        Date.now = () => issuedAt+idleMs+100;
        assert.equal(security.getSession({headers:{cookie:untouchedCookie}}),null);
    } finally {Date.now = clock;}
    security.secret = 'rotated-fixture-secret';
    assert.equal(security.getSession(request),null);
    assert.equal(security.getSession({headers:request.headers}),null);
    assert.equal(security.unpackProxyAuthCookie(oldProxy),'');
    assert.equal(handle.ebookAccessToken,undefined);
}

function testTotpAttempts() {
    const now = Date.now();
    const attempts = new ProfileTotpAttempts(new Security({}).nativeAuth);
    const profiles = Array.from({length:4096},(_,i)=>`reader-${i}`);
    for (const user of profiles) {
        assert(attempts.allows(user,now));
        attempts.failed(user,now);
    }
    assert(!attempts.allows('new-reader',now));
    for (let i=1;i<attemptLimit;i++) {
        assert(attempts.allows(profiles[0],now));
        attempts.failed(profiles[0],now);
    }
    assert(!attempts.allows(profiles[0],now+299_999));
    assert(attempts.allows(profiles[0],now+300_000));
    assert(attempts.allows('new-reader',now+300_000));
    for (let i=0;i<attemptLimit;i++) attempts.failed('other',now+300_000);
    assert(!attempts.allows('other',now+300_001));
    attempts.delete('other');
    assert(attempts.allows('other',now+300_001));
    for (let i=0;i<attemptLimit;i++) attempts.failed('bulk',now+300_001);
    attempts.clear();
    assert(attempts.allows('bulk',now+300_002));
}

const fixedSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const fixturePassword = 'библиотека-fixture';
const accessProof = salt=>createHash('sha256').update(fixturePassword+salt).digest('hex');

function testEnrollments() {
    const now = Date.now();
    const sessions = new ProfileSessions();
    const signed = new ProfileTotpEnrollments(sessions,false);
    const required = new ProfileTotpEnrollments(sessions,true);
    const open = sessionToken(0);
    sessions.create(open,'reader',now);
    assert(signed.prepare(open,now));
    signed.create(open,'reader',fixedSecret,now);
    assert(required.prepare('reader',now));
    required.create(open,'reader',fixedSecret,now);
    assert.equal(signed.secret(open,'other',now),undefined);
    assert.equal(required.secret(open,'other',now),undefined);
    for (let i=0;i<8;i++) signed.failed(open,'other');
    assert.equal(signed.secret(open,'reader',now),fixedSecret);
    for (let i=0;i<8;i++) signed.failed(open,'reader');
    assert.equal(signed.secret(open,'reader',now),undefined);
    assert.equal(required.secret(open,'reader',now),fixedSecret);
    assert(required.prepare('reader',now));
    const replacement = sessionToken(1);
    required.create(replacement,'reader',fixedSecret,now);
    assert.equal(required.secret(open,'reader',now),undefined);
    assert.equal(required.secret(replacement,'reader',now+299_999),fixedSecret);
    assert.equal(required.secret(replacement,'reader',now+300_000),undefined);

    for (let i=0;i<128;i++) {
        const user = `reader-${i}`;
        assert(required.prepare(user,now));
        required.create(sessionToken(i),user,fixedSecret,now);
    }
    assert(!required.prepare('full',now));
    assert(required.prepare('reader-64',now));
    required.create(replacement,'reader-64',fixedSecret,now);
    assert.equal(required.secret(replacement,'reader-64',now),fixedSecret);
    required.revoke('reader-64');
    assert.equal(required.secret(replacement,'reader-64',now),undefined);
    assert(required.prepare('full',now));
    signed.clear();
}

function testAccessChallengeTable() {
    const now = Date.now();
    const challenges = new WebAccessChallenges();
    const short = accessProof(challenges.issue('short',fixturePassword,now,10_000));
    assert(!challenges.take(short,now+10_000));
    const limit = accessProof(challenges.issue('long',fixturePassword,now,600_000));
    assert(!challenges.take(limit,now+300_000));
    const removed = accessProof(challenges.issue('cancelled',fixturePassword,now,0));
    challenges.remove(removed);
    assert(!challenges.take(removed,now));
    const taken = accessProof(challenges.issue('once',fixturePassword,now,0));
    assert(challenges.take(taken,now));
    assert(!challenges.take(taken,now));
    for (let i=0;i<4096;i++) challenges.issue(`client-${i}`,fixturePassword,now,0);
    assert.equal(challenges.size,4096);
    assert.throws(()=>challenges.issue('full',fixturePassword,now,0),{code:'INPX_LOGIN_RATE_LIMIT',retryAfter:300});
    assert.doesNotThrow(()=>challenges.issue('full',fixturePassword,now+300_000,0));
    assert.equal(challenges.size,1);
}

function testUnavailableEntropy(file) {
    let api, fill = false;
    const imports = {inpx:{random_fill(ptr,length) {
        if (!fill) return 0;
        new Uint8Array(api.memory.buffer,ptr,length).fill(0x4c);
        return 1;
    }}};
    api = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(file)),imports).exports;
    const issue = () => {
        const value = Buffer.from('client' + fixturePassword);
        const offset = api.auth_input(value.length);
        value.copy(Buffer.from(api.memory.buffer),offset);
        return api.challenge_issue(6,60_000,0);
    };
    assert.equal(issue(),-1);
    assert.equal(api.challenge_count(),0);
    fill = true;
    const ptr = issue();
    assert(ptr>0);
    assert.equal(Buffer.from(api.memory.buffer,ptr,api.auth_output_len()).toString('ascii'),'4c'.repeat(32));
    assert.equal(api.challenge_count(),1);
}

async function benchmark(file) {
    await atFixedTime(async advance => {
        const subjects = [];
        for (const binary of ['',file]) {
            engine(binary);
            const config = {loginRateLimitMaxAttempts:8};
            const spare = new Security(config);
            const full = new Security(config);
            const browser = new Security(config);
            browser.secret = 'benchmark-session-secret';
            const active = {headers:{}};
            const old = browser.ensureSession(active);
            const signed = browser.packSessionId(old.id);
            const cookies = {cookie:'inpx_web_session='+signed};
            active.headers = cookies;
            const proxy = browser.proxyAuthCookieValue('reader.with.dots');
            const capped = new Security(config);
            capped.secret = browser.secret;
            for (let i=0;i<maxSessions;i++) capped.ensureSession({headers:{}});
            const attempts = new ProfileTotpAttempts(new Security(config).nativeAuth);
            const sessions = new ProfileSessions();
            const enrollmentSessions = new ProfileSessions();
            const required = new ProfileTotpEnrollments(enrollmentSessions,true);
            const signedIn = new ProfileTotpEnrollments(enrollmentSessions,false);
            const challenges = new WebAccessChallenges();
            const now = Date.now();
            for (let i=0;i<128;i++) {
                const token = sessionToken(i);
                const user = `enrollment-${i}`;
                required.create(token,user,fixedSecret,now);
                if (i<64) {
                    enrollmentSessions.create(token,user,now);
                    signedIn.create(token,user,fixedSecret,now);
                }
            }
            for (let i=0;i<4096;i++) attempts.failed(`reader-${i}`,now);
            const req = request(0);
            const outsider = request(10_000);
            for (let i=0;i<10_000;i++) full.recordLoginAttempt(request(i),false,'profile');
            const tokens = Array.from({length:maxSessions+2500},(_,i)=>sessionToken(i));
            for (const token of tokens.slice(0,maxSessions)) sessions.create(token,'reader',now);
            let next = maxSessions;
            const liveToken = tokens[maxSessions-1];
            subjects.push({
                'login-with-success':()=>spare.withLoginAttempt(req,'profile',()=>true),
                'full-table-denial':()=>{
                    try {full.checkLoginRate(outsider,'profile');}
                    catch(error) {if(error.code==='INPX_LOGIN_RATE_LIMIT') return; throw error;}
                    throw new Error('Unexpected login');
                },
                'profile-session-lookup':()=>{
                    assert.equal(sessions.user(liveToken,now),'reader');
                },
                'profile-session-insert-at-limit':()=>{
                    sessions.create(tokens[next++],'reader',now);
                },
                'browser-cookie':()=>assert.equal(browser.getSession({headers:cookies}).id,old.id),
                'browser-cookie-renewed':()=>assert.equal(browser.getSession({headers:cookies}).id,old.id),
                'browser-cookie-sign':()=>assert.equal(browser.packSessionId(old.id),signed),
                'browser-request-session':()=>assert.equal(browser.getSession(active),old),
                'browser-csrf':()=>assert(browser.hasValidCsrf(active,old.csrfToken)),
                'proxy-cookie':()=>assert.equal(browser.unpackProxyAuthCookie(proxy),'reader.with.dots'),
                'browser-create-at-limit':()=>capped.ensureSession({headers:{}}),
                'profile-otp-at-limit':()=>assert(!attempts.allows('other-reader',now)),
                'otp-required-restart-at-limit':()=>{
                    assert(required.prepare('enrollment-64',now));
                    required.create(sessionToken(64),'enrollment-64',fixedSecret,now);
                },
                'otp-signed-in-prepare':()=>assert(signedIn.prepare(sessionToken(63),now)),
                'library-challenge-issue-and-take':()=>{
                    const salt = challenges.issue('fixture-client',fixturePassword,now,0);
                    assert(challenges.take(accessProof(salt),now));
                },
            });
        }
        // Warm both engines and alternate which one runs first.
        for (const stage of Object.keys(subjects[0])) {
            const samples=[[],[]];
            for (let round=0;round<2500;round++) {
                if (stage==='browser-cookie-renewed') advance(1);
                for (const index of round%2 ? [1,0] : [0,1]) {
                    const start=performance.now();
                    await subjects[index][stage]();
                    if (round>=500) samples[index].push(performance.now()-start);
                }
            }
            const stats = values=>{
                values.sort((a,b)=>a-b);
                return {medianMs:values[1000],p95Ms:values[1899]};
            };
            console.log(JSON.stringify({stage,before:stats(samples[0]),after:stats(samples[1])}));
        }
    });
}

async function main(modulePath,mode) {
    if (!modulePath) throw new Error('Usage: node scripts/rust-auth-state-tests.js <auth-wasm> [benchmark]');
    const file = resolve(modulePath);
    if (mode==='benchmark') return benchmark(file);
    engine(file);
    assert(new Security({}).nativeAuth);
    const logger = new (require('../server/core/AppLogger'))();
    if (!logger.inited) await logger.init({name:'rust-auth-state-tests',loggingEnabled:false});
    const testSuites = [
        ['./security-regression-tests','testLoginRateReservesAttemptsDuringCredentialVerification'],
        ['./resource-limit-tests','testProfileLoginRateLimitSurvivesOtherSuccesses'],
        ['./resource-limit-tests','testOpdsAuthenticationRateLimit'],
        ['./security-regression-tests','testProfileCredentialChangesRevokeSessions'],
        ['./profile-access-tests','testAdminLogoutRevokesBrowserTokensAndKeepsOtherDevices'],
        ['./profile-access-tests','testProfileBlockRevokesAuthenticationAndPreservesData'],
        ['./security-regression-tests','testSessionLifetimeAndMalformedCookies'],
        ['./profile-access-tests','testProxyHeaderRequiredWithOldCookie'],
        ['./profile-access-tests','testProxyProfileBindingAndIdentityChange'],
        ['./ebook-tests','testEbookProfileLoginCsrfPasswordAndRevokedSessionStayProtected'],
        ['./ebook-tests','testEbookLibraryPasswordLogoutAndSafeReturnPaths'],
        ['./ebook-tests','testEbookLatePrivateResponseIsRejectedAfterProfileLogout'],
        ['./profile-totp-tests','testProfileTotpExpiryRateAndFailedWrites'],
        ['./profile-totp-tests','testAdminRecoversAnotherProfileTotp'],
        ['./profile-totp-tests','testRequiredProfileTotpEnrollmentAndRecovery'],
        ['./security-regression-tests','testLibraryAccessChallengesExpireAndPromoteOnlyOnUse'],
    ];
    for (const [suite,name] of testSuites) {
        await require(suite).find(test=>test.name===name)();
        console.log('ok Rust',name);
    }
    await testExpiryAndSaturation();
    await testPolicyChangeDuringVerification();
    console.log('ok Rust login expiration, maximum buckets and reconfiguration');
    testProfileSessions();
    console.log('ok Rust profile session expiration, capacity and revocation');
    testBrowserCookieCompatibility();
    console.log('ok Rust HMAC cookie compatibility, browser state and key rotation');
    testTotpAttempts();
    console.log('ok Rust profile OTP attempts, window boundary and capacity');
    testEnrollments();
    testAccessChallengeTable();
    testUnavailableEntropy(file);
    console.log('ok Rust pending OTP state, library challenge lifetime and capacity');
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
