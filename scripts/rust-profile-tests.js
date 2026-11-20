const assert = require('node:assert/strict');
const {sessionCookieHeader} = require('./test-session-cookie');
const {once} = require('node:events');
const WebSocket = require('ws');
const {hotp} = require('../server/core/ProfileTotp');

function code(secret, offset = 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret,letter=>alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
    return hotp(key,Math.floor(Date.now()/30000)+offset);
}

function credentials(reply) {
    assert(reply.userId && /^[a-f0-9]{48}$/.test(reply.profileAccessToken || ''),reply.error);
    return {userId:reply.userId,profileAccessToken:reply.profileAccessToken};
}

const invalid = 'INPX_INVALID_PROFILE_CREDENTIALS';

async function verifyProfileCommands(base, options = {}) {
    const root = options.root || '';
    const adminPassword = options.adminPassword || 'profile-commands-fixture-admin';
    const originalPassword = 'profile-commands-fixture-alice';
    const bobPassword = 'profile-commands-fixture-bob';
    const password = originalPassword+'-changed';
    const origin = options.trust ? 'https://reader-profile.test' : base;
    const forwarded = options.trust ? {'x-forwarded-proto':'https','x-forwarded-host':'reader-profile.test'} : {};
    const opened = [];

    async function browser() {
        const headers = {origin,...forwarded};
        const page = await fetch(base+root+'/',{headers});
        assert.equal(page.status,200);
        const cookie = sessionCookieHeader(page)?.split(';')[0];
        await page.body.cancel();
        assert(cookie,'Missing profile browser cookie');
        const socket = new WebSocket(base.replace(/^http/,'ws')+root+'/ws',{headers:{...headers,cookie}});
        opened.push(socket);
        await once(socket,'open',{signal:AbortSignal.timeout(8000)});
        let sequence = 0, csrfToken;
        const pending = new Map();
        socket.on('message',raw=>{
            const reply = JSON.parse(raw);
            if (reply._rok) return;
            pending.get(reply.requestId)?.(reply);
        });
        const send = (action,fields = {})=>new Promise((resolve,reject)=>{
            const requestId = String(++sequence);
            const timer = setTimeout(()=>{pending.delete(requestId);reject(new Error('No response to '+action));},10000);
            pending.set(requestId,value=>{clearTimeout(timer);pending.delete(requestId);resolve(value);});
            socket.send(JSON.stringify({action,requestId,csrfToken,...fields}));
        });
        const config = await send('get-config');
        csrfToken = config.csrfToken;
        assert(csrfToken,config.error);
        const http = (fields, {remembered = '', requestOrigin = origin} = {})=>fetch(base+root+'/api/profile/login',{
            method:'POST',headers:{...headers,origin:requestOrigin,'content-type':'application/json',cookie:[cookie,remembered].filter(Boolean).join('; ')},
            body:JSON.stringify({csrfToken,...fields}),
        });
        return {send,config,http};
    }

    try {
        const guest = await browser();
        assert.equal(guest.config.profileLoginRequired,true);
        assert.equal(guest.config.canRememberProfileDevice,!!options.trust);
        assert(guest.config.clientApi.features.includes('profileTotp'));
        assert(guest.config.clientApi.features.includes('profileAuthPolicy'));
        assert.equal((await guest.send('create-user-profile',{userId:'admin',profile:{name:'Wrong'}})).error,'need_profile_login');
        assert.equal((await guest.send('login-user-profile',{login:'admin',password:adminPassword,csrfToken:''})).error,'bad_csrf_token');
        const adminBrowser = await browser();
        const adminIdentity = credentials(await adminBrowser.send('login-user-profile',{login:'admin',password:adminPassword}));
        const admin = (action,fields)=>adminBrowser.send(action,{...adminIdentity,...fields});
        const cfg = await admin('get-config');
        assert.equal(cfg.currentUserProfile.isAdmin,true);
        assert.equal(cfg.profileAuthPolicy.otpRequired,false);
        assert.equal((await admin('profile-totp',{operation:'status'})).otpEnabled,false);
        const rejectedPolicy = await admin('set-profile-auth-policy',{password:adminPassword,
            otpRequired:true,trustedBrowsersEnabled:true,trustedBrowserDays:30});
        assert.match(rejectedPolicy.error,/Сначала настройте OTP/);
        for (const profile of [
            {name:'Alice',login:'alice',password:originalPassword,isAdmin:true,blocked:true,otpRequired:true,opdsAuthEnabled:true},
            {name:'Bob',login:'bob',password:bobPassword},
        ]) {
            const result = await admin('create-user-profile',{profile});
            assert(result.user?.id,result.error);
            assert.equal(result.user.isAdmin,false);
            assert(!Object.hasOwn(result.user,'passwordHash'));
            assert.equal(result.user.otpEnabled,false);
        }
        const profileRows = (await admin('get-user-profiles')).users;
        const alice = profileRows.find(row=>row.login==='alice');
        const bob = profileRows.find(row=>row.login==='bob');
        const aliceId = alice.id, bobId = bob.id;
        assert.equal(alice.blocked,false);
        assert.equal(alice.otpRequired,false);
        const local = await browser(), other = await browser();
        const localIdentity = credentials(await local.send('login-user-profile',{login:'alice',password:originalPassword}));
        const otherIdentity = credentials(await other.send('login-user-profile',{login:'alice',password:originalPassword}));
        const asAlice = (action,fields)=>local.send(action,{...localIdentity,...fields});
        assert.match((await asAlice('create-user-profile',{profile:{name:'Denied'}})).error,/Только администратор/);
        assert.match((await asAlice('update-user-profile',{targetUserId:bobId,profile:{name:'Denied'}})).error,/Только администратор/);
        assert.match((await asAlice('reset-user-profile-totp',{targetUserId:bobId,password:originalPassword})).error,/Только администратор/);
        assert.equal((await asAlice('update-user-profile',{userId:adminIdentity.userId,targetUserId:bobId,profile:{name:'Denied'}})).error,'need_profile_login');
        const renamed = await asAlice('update-user-profile',{targetUserId:aliceId,
            profile:{name:'Alice Reader',isAdmin:true,emailTo:'reader@example.invalid',defaultDownloadFormat:'epub'}});
        assert.equal(renamed.user?.isAdmin,false,renamed.error);
        assert.equal(renamed.user.name,'Alice Reader');
        const localConfig = await asAlice('get-config');
        assert.equal(localConfig.currentUserProfile.defaultDownloadFormat,'epub');
        assert.equal(localConfig.currentUserProfile.emailTo,'reader@example.invalid');
        const layout = [{id:'recommendations',hidden:false},{id:'discovery:external-source',hidden:true}];
        assert.equal((await asAlice('update-user-profile',{targetUserId:aliceId,profile:{overviewShelfLayout:layout}})).error,undefined);
        assert.deepEqual((await other.send('get-config',otherIdentity)).currentUserProfile.overviewShelfLayout,layout);
        assert.deepEqual((await admin('get-config')).currentUserProfile.overviewShelfLayout,[]);
        assert(!Object.hasOwn(localConfig,'profileAuthPolicy'));
        assert.equal((await asAlice('update-user-profile',{targetUserId:aliceId,profile:{password}})).user?.id,aliceId);
        assert.equal((await local.send('resume-user-profile',localIdentity)).error,'need_profile_login');
        assert.equal((await other.send('resume-user-profile',otherIdentity)).error,'need_profile_login');
        assert.equal((await local.send('login-user-profile',{login:'alice',password:originalPassword})).errorCode,invalid);
        const aliceBeforeOtp = credentials(await local.send('login-user-profile',{login:'alice',password}));
        const bobBefore = credentials(await other.send('login-user-profile',{login:'bob',password:bobPassword}));

        const start = await admin('profile-totp',{operation:'start',payload:{password:adminPassword}});
        assert(start.secret,start.error);
        assert.match(start.otpAuthUri,/^otpauth:\/\/totp\/inpx-web:admin\?/);
        const enrolled = await admin('profile-totp',{operation:'enable',payload:{password:adminPassword,code:code(start.secret,-1)}});
        assert.equal(enrolled.otpEnabled,true,enrolled.error);
        assert.equal(enrolled.recoveryCodes.length,8);
        const adminCodes = enrolled.recoveryCodes;
        assert.equal((await admin('resume-user-profile')).userId,adminIdentity.userId);
        assert.equal((await admin('reset-user-profile-totp',{targetUserId:adminIdentity.userId,password:adminPassword})).error
            ?.includes('Свою двухфакторную защиту'),true);

        const individual = {targetUserId:aliceId,password:adminPassword,required:true};
        assert.equal((await admin('set-user-profile-totp-required',{...individual,otp:'invalid'})).errorCode,invalid);
        assert.equal((await admin('set-user-profile-totp-required',{...individual,otp:adminCodes[0]})).otpRequired,true);
        assert.equal((await local.send('resume-user-profile',aliceBeforeOtp)).error,'need_profile_login');
        assert.equal((await local.send('login-user-profile',{login:'alice',password})).errorCode,'need_profile_otp_setup');

        const payload = {login:'alice',password};
        const setup = await local.send('profile-totp-enrollment',{operation:'start',payload});
        assert(setup.enrollmentId,setup.error);
        const enableSetup = {operation:'enable',payload:{...payload,enrollmentId:setup.enrollmentId,code:code(setup.secret,-1)}};
        assert.match((await guest.send('profile-totp-enrollment',enableSetup)).error,/Начните настройку/);
        assert.equal((await local.send('profile-totp-enrollment',{...enableSetup,payload:{...enableSetup.payload,code:'invalid'}})).errorCode,invalid);
        const enabled = await local.send('profile-totp-enrollment',enableSetup);
        const enrolledAlice = credentials(enabled);
        const aliceCodes = enabled.recoveryCodes;
        const aliceAction = (operation,auth=undefined)=>local.send('profile-totp',{...enrolledAlice,operation,payload:{password,code:auth}});
        const status = await aliceAction('status');
        assert.equal(status.otpRequired,true);
        assert.equal(status.otpEnabled,true);
        assert.equal(status.recoveryCodesRemaining,8);
        assert.match((await aliceAction('disable',aliceCodes[0])).error,/OTP обязателен/);

        const replay = await browser();
        const loginOtp = code(setup.secret);
        assert.equal((await replay.send('login-user-profile',{login:'alice',password})).errorCode,'need_profile_otp');
        if (options.trust) {
            const badOrigin = await replay.http({login:'alice',password},{requestOrigin:'https://another-origin.test'});
            assert.equal(badOrigin.status,403);
            const resp = await replay.http({login:'alice',password,otp:loginOtp,rememberDevice:true});
            assert.equal(resp.status,200,(await resp.clone().json()).error);
            const trustCookie = resp.headers.getSetCookie().find(value=>value.startsWith('inpx_web_trusted_device='));
            assert(trustCookie && /HttpOnly; Secure; SameSite=Strict/.test(trustCookie));
            const remembered = trustCookie.split(';')[0];
            assert.equal((await replay.http({login:'alice',password},{remembered})).status,200);
            const revoked = await aliceAction('revoke-trusted-devices',aliceCodes[0]);
            assert.equal(revoked.trustedDeviceCount,0,revoked.error);
            const noTrust = await replay.http({login:'alice',password},{remembered});
            assert.equal((await noTrust.json()).code,'need_profile_otp');
        } else {
            const verified = credentials(await replay.send('login-user-profile',{login:'alice',password,otp:loginOtp}));
            assert.equal(verified.userId,aliceId);
        }
        assert.equal((await replay.send('login-user-profile',{login:'alice',password,otp:loginOtp})).errorCode,invalid);
        const app = await aliceAction('create-opds-password',aliceCodes[1]);
        assert(app.opdsAppPasswordSet && /^inpx_/.test(app.opdsAppPassword||''),app.error);
        assert.equal((await aliceAction('revoke-opds-password',aliceCodes[2])).opdsAppPasswordSet,false);
        const regenerated = await aliceAction('regenerate-recovery',aliceCodes[3]);
        assert.equal(regenerated.recoveryCodes?.length,8,regenerated.error);
        assert.equal((await replay.send('login-user-profile',{login:'alice',password,otp:aliceCodes[4]})).errorCode,invalid);
        const recovered = credentials(await replay.send('login-user-profile',{login:'alice',password,otp:regenerated.recoveryCodes[0]}));
        assert.equal(recovered.userId,aliceId);
        assert.equal((await replay.send('login-user-profile',{login:'alice',password,otp:regenerated.recoveryCodes[0]})).errorCode,invalid);

        const reset = await admin('reset-user-profile-totp',{targetUserId:aliceId,password:adminPassword,otp:adminCodes[1]});
        assert.equal(reset.otpEnabled,false,reset.error);
        assert.equal(reset.otpRequired,true);
        assert.equal((await replay.send('resume-user-profile',recovered)).error,'need_profile_login');
        assert.equal((await admin('set-user-profile-totp-required',{...individual,required:false,otp:adminCodes[2]})).otpRequired,false);
        const optionalIdentity = credentials(await local.send('login-user-profile',{login:'alice',password}));
        const optional = (operation, code)=>local.send('profile-totp',{...optionalIdentity,operation,payload:{password,code}});
        const pending = await optional('start');
        assert(pending.secret,pending.error);
        const optionalEnabled = await optional('enable',code(pending.secret));
        assert.equal(optionalEnabled.otpEnabled,true,optionalEnabled.error);
        const optionalDisabled = await optional('disable',optionalEnabled.recoveryCodes[0]);
        assert.equal(optionalDisabled.otpEnabled,false,optionalDisabled.error);
        assert.equal(optionalDisabled.recoveryCodesRemaining,0);
        const beforePolicy = credentials(await local.send('login-user-profile',{login:'alice',password}));
        const policy = {password:adminPassword,otpRequired:true,trustedBrowsersEnabled:false,trustedBrowserDays:15};
        const forced = await admin('set-profile-auth-policy',{...policy,otp:adminCodes[3]});
        assert.deepEqual(forced.profileAuthPolicy,{otpRequired:true,trustedBrowsersEnabled:false,trustedBrowserDays:15},forced.error);
        assert.equal((await local.send('resume-user-profile',beforePolicy)).error,'need_profile_login');
        assert.equal((await other.send('resume-user-profile',bobBefore)).error,'need_profile_login');
        assert.equal((await other.send('login-user-profile',{login:'bob',password:bobPassword})).errorCode,'need_profile_otp_setup');
        assert.equal((await admin('get-config')).canRememberProfileDevice,false);
        assert.equal((await admin('resume-user-profile')).userId,adminIdentity.userId);
        const disabled = await admin('set-profile-auth-policy',{...policy,otpRequired:false,otp:adminCodes[4]});
        assert.equal(disabled.profileAuthPolicy?.otpRequired,false,disabled.error);

        const beforeBlock = credentials(await local.send('login-user-profile',{login:'alice',password}));
        const aliveBob = credentials(await other.send('login-user-profile',{login:'bob',password:bobPassword}));
        const shelf = await local.send('create-reading-list',{...beforeBlock,name:'Profile deletion fixture'});
        assert(shelf.list?.id,shelf.error);
        assert.equal((await admin('set-user-profile-blocked',{targetUserId:aliceId,blocked:true})).blocked,true);
        assert.equal((await local.send('resume-user-profile',beforeBlock)).error,'need_profile_login');
        assert.equal((await local.send('login-user-profile',{login:'alice',password})).errorCode,invalid);
        assert.equal((await admin('get-config')).userProfiles.find(row=>row.id===aliceId).blocked,true);
        assert(!(await other.send('get-user-profiles',aliveBob)).users.some(row=>row.id===aliceId));
        assert.equal((await admin('set-user-profile-blocked',{targetUserId:aliceId,blocked:false})).blocked,false);
        assert.equal((await local.send('resume-user-profile',beforeBlock)).error,'need_profile_login');
        const afterBlock = credentials(await local.send('login-user-profile',{login:'alice',password}));
        assert.equal((await local.send('get-reading-list',{...afterBlock,listId:shelf.list.id})).list.name,'Profile deletion fixture');
        assert.match((await admin('delete-user-profile',{targetUserId:adminIdentity.userId})).error,/Нельзя удалить/);
        assert.equal((await admin('delete-user-profile',{targetUserId:aliceId})).success,true);
        assert.equal((await local.send('resume-user-profile',afterBlock)).error,'need_profile_login');
        assert(!(await admin('get-user-profiles')).users.some(row=>row.id===aliceId));
        assert.equal((await admin('delete-user-profile',{targetUserId:bobId})).success,true);
        if (options.restart) {
            base = await options.restart() || base;
            const restarted = await browser();
            assert.equal((await restarted.send('resume-user-profile',adminIdentity)).error,'need_profile_login');
            assert.equal((await restarted.send('login-user-profile',{login:'admin',password:adminPassword})).errorCode,'need_profile_otp');
            const identity = credentials(await restarted.send('login-user-profile',{login:'admin',password:adminPassword,otp:adminCodes[5]}));
            assert.equal((await restarted.send('profile-totp',{...identity,operation:'status'})).recoveryCodesRemaining,2);
            const active = await restarted.send('get-config',identity);
            assert.deepEqual(active.profileAuthPolicy,{otpRequired:false,trustedBrowsersEnabled:false,trustedBrowserDays:15});
            console.log('ok persisted OTP, recovery and login policy after container restart');
        }
        console.log('ok Rust profile commands, password and OTP login, recovery, role isolation, blocking and revocation'+(options.trust?' with trusted HTTPS browser':''));
    } finally {
        for (const socket of opened) {
            if (socket.readyState===WebSocket.CONNECTING) socket.once('error',()=>{});
            socket.terminate();
        }
    }
}

module.exports = verifyProfileCommands;

if (require.main === module) {
    verifyProfileCommands(process.argv[2],{root:process.argv[3],trust:process.argv.includes('--trust')})
        .catch(error=>{console.error(error);process.exitCode=1;});
}
