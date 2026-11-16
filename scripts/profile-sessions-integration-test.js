const assert = require('node:assert/strict');
const {on,once} = require('node:events');
const WebSocket = require('ws');
const {hotp} = require('../server/core/ProfileTotp');

function totpCode(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret,letter=>alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
    return hotp(key,Math.floor(Date.now()/30000));
}

async function withBrowser(url, run) {
    const signal = AbortSignal.timeout(15000);
    const response = await fetch(`${url}/ebook/login`,{signal});
    assert.equal(response.status,200);
    const session = response.headers.getSetCookie().find(value=>value.startsWith('inpx_web_session='));
    await response.body.cancel();
    assert(session,'Profile session test requires a browser cookie');
    const socket = new WebSocket(url.replace(/^http/,'ws')+'/ws',{
        headers:{cookie:session.split(';')[0],origin:url},
    });
    let sequence = 0, csrfToken;
    async function request(action, fields) {
        const requestId = String(++sequence);
        const messages = on(socket,'message',{signal:AbortSignal.timeout(15000),close:['close']});
        try {
            socket.send(JSON.stringify({action,csrfToken,...fields,requestId}));
            for await (const [raw] of messages) {
                const result = JSON.parse(raw);
                if (result.requestId===requestId && !result._rok) return result;
            }
            throw new Error('WebSocket closed');
        } catch (cause) {
            throw new Error(`Profile session request failed (${action}): ${cause.message}`,{cause});
        } finally {
            await messages.return();
        }
    }
    try {
        await once(socket,'open',{signal});
        const config = await request('get-config');
        csrfToken = config.csrfToken;
        assert(csrfToken,config.error);
        return await run(request,config);
    } finally {
        if (socket.readyState===WebSocket.CONNECTING) socket.once('error',()=>{});
        socket.terminate();
    }
}

module.exports = async function checkProfileSessions(url,{adminPassword}) {
    const login = 'native-session-reader';
    const password = 'local-profile-session-fixture';
    const credentials = result => {
        assert(result.userId,result.error);
        assert.match(result.profileAccessToken || '',/^[a-f0-9]{48}$/,result.error);
        return {userId:result.userId,profileAccessToken:result.profileAccessToken};
    };
    await withBrowser(url,async (admin,config)=>{
        const adminLogin = config.userProfiles.find(user=>user.isAdmin)?.login;
        assert(adminLogin);
        const owner = credentials(await admin('login-user-profile',{login:adminLogin,password:adminPassword}));
        const created = await admin('create-user-profile',{
            ...owner,profile:{name:'Native session reader',login,password},
        });
        const targetUserId = created.user?.id;
        assert(targetUserId,created.error);

        await withBrowser(url,async firstBrowser=>{
            const first = credentials(await firstBrowser('login-user-profile',{login,password}));
            const enrollment = await firstBrowser('profile-totp',{...first,operation:'start',payload:{password}});
            assert(enrollment.secret,enrollment.error);

            await withBrowser(url,async secondBrowser=>{
                const second = credentials(await secondBrowser('login-user-profile',{login,password}));
                assert.notEqual(first.profileAccessToken,second.profileAccessToken);
                assert.equal((await firstBrowser('resume-user-profile',first)).userId,targetUserId);
                assert.equal((await firstBrowser('logout-user-profile',first)).success,true);
                assert.equal((await firstBrowser('resume-user-profile',first)).error,'need_profile_login');
                assert.equal((await secondBrowser('resume-user-profile',second)).userId,targetUserId);

                const pending = await secondBrowser('profile-totp',{...second,operation:'start',payload:{password}});
                assert(pending.secret,pending.error);
                const enabled = await secondBrowser('profile-totp',{
                    ...second,operation:'enable',payload:{password,code:totpCode(pending.secret)},
                });
                assert.equal(enabled.otpEnabled,true,enabled.error);
                const recoveryCode = enabled.recoveryCodes[0];
                assert(recoveryCode);
                const rejected = await secondBrowser('login-user-profile',{login,password,otp:'invalid-recovery-code'});
                assert.equal(rejected.errorCode,'INPX_INVALID_PROFILE_CREDENTIALS');
                const recovered = credentials(await secondBrowser('login-user-profile',{login,password,otp:recoveryCode}));
                assert.equal(recovered.userId,targetUserId);

                const blocked = await admin('set-user-profile-blocked',{...owner,targetUserId,blocked:true});
                assert.equal(blocked.blocked,true,blocked.error);
                assert.equal((await secondBrowser('resume-user-profile',second)).error,'need_profile_login');
                assert.equal((await secondBrowser('resume-user-profile',recovered)).error,'need_profile_login');
                assert.equal((await admin('resume-user-profile',owner)).userId,owner.userId);
            });
        });
    });
    console.log('ok packaged profile sessions: independent browsers, logout, TOTP enrollment, recovery code and blocking');
};
