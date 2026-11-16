const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const {join,resolve} = require('node:path');
const SecretStore = require('../server/core/SecretStore');
const ProfilePassword = require('../server/core/ProfilePassword');
const opdsPassword = require('../server/core/ProfileOpdsPassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const totp = require('../server/core/ProfileTotp');
const trust = require('../server/core/ProfileTrustedDevices');
const native = require('../server/core/RustCredentials');

const profilePassword = 'Фиксированный пароль 🔐\0';
const login = '  ΟΣ-ЧИТАТЕЛЬ  ';
const settings = {smtpPass:'🔒 почта',telegramBotToken:'fixture-token',telegramProxyPassword:'proxy',
    metricsToken:'test-metrics',opds:{password:'пароль\0 opds',user:'library'},librarySources:[{id:'test'}]};

function engine(binary) {
    if (binary) process.env.INPX_RUST_CATALOG_BINARY = binary;
    else delete process.env.INPX_RUST_CATALOG_BINARY;
}

async function compatibility(binary, directory) {
    const store = new SecretStore({dataDir:directory});
    engine();
    const legacy = await store.protectConfig(settings);
    const key = await fs.readFile(store.keyFile);
    const legacyHash = await ProfilePassword.hash(profilePassword);
    const sha256 = ProfilePassword.legacy(login,profilePassword);
    engine(binary);
    assert.deepEqual(await store.unprotectConfig(legacy),{config:settings,needsSave:false});
    assert.deepEqual(await store.unprotectConfig(settings),{config:settings,needsSave:true});
    const protectedConfig = await store.protectConfig(settings);
    assert.deepEqual(await store.protectConfig(protectedConfig),protectedConfig);
    assert.deepEqual(await fs.readFile(store.keyFile),key);
    const nativeHash = await ProfilePassword.hash(profilePassword);
    assert(await ProfilePassword.verify(legacyHash,login,profilePassword));
    assert(await ProfilePassword.verify(sha256,login,profilePassword));
    assert.equal(await ProfilePassword.verify(sha256,login,profilePassword+'!'),false);
    assert.equal(await ProfilePassword.verify(legacyHash,'changed-login','wrong'),false);
    assert.equal(await ProfilePassword.verify(nativeHash,login,'я'.repeat(2049)),false);
    await assert.rejects(ProfilePassword.hash('я'.repeat(2049)),/длинный/);
    const malformed = {...protectedConfig};
    const parts = protectedConfig.smtpPass.split(':');
    const tag = Buffer.from(parts[3],'base64');
    tag[0] ^= 1;
    parts[3] = tag.toString('base64');
    malformed.smtpPass=parts.join(':');
    await assert.rejects(store.unprotectConfig(malformed),/authenticate/);
    assert.deepEqual(await store.unprotectConfig(protectedConfig),{config:settings,needsSave:false});
    const concurrent = Array.from({length:4},()=>ProfilePassword.verify(nativeHash,login,profilePassword));
    await assert.rejects(ProfilePassword.hash('limit'),/занята/);
    assert.deepEqual(await Promise.all(concurrent),[true,true,true,true]);
    engine();
    assert(await ProfilePassword.verify(nativeHash,'new-login',profilePassword));
    assert.deepEqual(await store.unprotectConfig(protectedConfig),{config:settings,needsSave:false});
    await secondFactorCompatibility(binary,store);
    await opdsCompatibility(binary);
    engine(binary);
    const named = (file,name) => require(file).find(test => test.name===name);
    for (const [file,name] of [
        ['./security-regression-tests','testConcurrentSecretKeyCreation'],
        ['./security-regression-tests','testAtomicConfigSave'],
        ['./audit-stage4-tests','testScryptMigrationAndOpds'],
        ['./profile-access-tests','testOpdsAppPasswordIsProfileScopedRevocableAndCannotCreateWebSession'],
    ]) {
        await named(file,name)();
        console.log('ok native',name);
    }
    for (const file of ['./profile-totp-tests','./profile-trusted-device-tests']) {
        for (const test of require(file)) {
            await test();
            console.log('ok native',test.name);
        }
    }
}

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const rfcUser = 'читатель';
const rfcNow = 59_000;
const rfcCode = '287082';

async function secondFactorCompatibility(binary,store) {
    engine();
    const original = await totp.enable(store,rfcUser,rfcSecret,-1);
    const recovery = original.recoveryCodes[0].toLowerCase().replace(/-/g,'\uFEFF');
    const expectedRecovery = await totp.consume(store,rfcUser,original.state,recovery,rfcNow);
    engine(binary);
    const setup = await totp.start('Ч/А');
    assert.match(setup.secret,/^[A-Z2-7]{32}$/);
    assert.equal(new URL(setup.otpAuthUri).searchParams.get('secret'),setup.secret);
    const confirmed = await totp.confirm(store,rfcUser,rfcSecret,rfcCode,rfcNow);
    assert.equal(confirmed.state.lastStep,1);
    assert.equal(confirmed.recoveryCodes.length,8);
    assert.equal(await totp.confirm(store,rfcUser,rfcSecret,rfcCode,91_000),null);
    assert.equal(await totp.consume(store,rfcUser,confirmed.state,rfcCode,61_000),null);
    assert.equal(await totp.consume(store,'not-the-owner',original.state,rfcCode,rfcNow),null);
    for (const [now,code] of [[59_000,'287082'],[1_111_111_109_000,'081804'],[1_111_111_111_000,'050471'],
        [1_234_567_890_000,'005924'],[2_000_000_000_000,'279037'],[20_000_000_000_000,'353130']]) {
        const accepted = await totp.consume(store,rfcUser,original.state,code,now);
        assert.equal(accepted?.lastStep,Math.floor(now/30_000));
    }
    assert.equal(await totp.consume(store,rfcUser,original.state,'\ud800',rfcNow),null);
    const remember = trust.remember([],'',30);
    const once = await totp.consumeWithTrust(store,rfcUser,original.state,recovery,rfcNow,remember);
    assert.deepEqual(once.state,expectedRecovery);
    assert.equal(once.grant,null);
    assert.equal(await totp.consume(store,rfcUser,once.state,recovery,rfcNow),null);
    const grant = (await totp.consumeWithTrust(store,rfcUser,original.state,rfcCode,rfcNow,remember)).grant;
    const time = Date.now;
    Date.now = ()=>rfcNow;
    try {
        assert(await trust.recognizes(grant.devices,grant.token));
        const rotated = (await totp.consumeWithTrust(store,rfcUser,original.state,rfcCode,rfcNow,
            trust.remember(grant.devices,grant.token,30))).grant;
        assert.equal(await trust.recognizes(rotated.devices,grant.token),false);
        assert(await trust.recognizes(rotated.devices,rotated.token));
        Date.now = ()=>rotated.devices.at(-1).expiresAt;
        assert.equal(await trust.recognizes(rotated.devices,rotated.token),false);
    } finally {Date.now=time;}
    engine();
    assert.equal(await totp.readSecret(store,rfcUser,confirmed.state),rfcSecret);
    assert.equal((await totp.consume(store,rfcUser,confirmed.state,confirmed.recoveryCodes[0],rfcNow)).recoveryHashes.length,7);
}

async function opdsCompatibility(binary) {
    engine();
    const old = await opdsPassword.issue();
    engine(binary);
    assert(await opdsPassword.verify(old.hash,old.password));
    assert.equal(await opdsPassword.verify(old.hash,old.password+'\n'),false);
    assert.equal(await opdsPassword.verify(old.hash.toUpperCase(),old.password),false);
    assert.equal(await opdsPassword.verify('0'.repeat(64),old.password),false);
    const issued = await opdsPassword.issue();
    assert.match(issued.password,/^inpx_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(issued.password,old.password);
    assert.equal(await opdsPassword.verify(old.hash,issued.password),false);
    engine();
    assert(await opdsPassword.verify(issued.hash,issued.password));
}

const median = values => Math.round(values.toSorted((a,b)=>a-b)[values.length>>1]*100)/100;

async function benchmark(binary, directory) {
    const store = new SecretStore({dataDir:directory});
    engine();
    const encrypted = await store.protectConfig(settings);
    const stored = await ProfilePassword.hash(profilePassword);
    const compare = async (stage, rounds, action, check) => {
        const samples = [[],[]];
        for (let round=0; round<=rounds; round++) {
            for (const index of round%2 ? [1,0] : [0,1]) {
                engine(index ? binary : '');
                const start = performance.now(), result = await action();
                if (round) samples[index].push(performance.now()-start);
                check(result);
            }
        }
        console.log(JSON.stringify({stage,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
    };
    await compare('config-seal-5',43,()=>store.protectConfig(settings),value=>assert(SecretStore.isEncrypted(value.smtpPass)));
    await compare('config-open-5',43,()=>store.unprotectConfig(encrypted),value=>assert.deepEqual(value.config,settings));
    await compare('scrypt-hash',15,()=>ProfilePassword.hash(profilePassword),value=>assert.match(value,/^scrypt:v1:/));
    await compare('scrypt-verify',15,()=>ProfilePassword.verify(stored,login,profilePassword),value=>assert.equal(value,true));
    await compare('scrypt-verify-4',7,()=>Promise.all(Array.from({length:4},()=>ProfilePassword.verify(stored,login,profilePassword))),
        value=>assert.deepEqual(value,[true,true,true,true]));
    const legacy = ProfilePassword.legacy(login,profilePassword);
    await compare('legacy-verify',43,()=>ProfilePassword.verify(legacy,login,profilePassword),value=>assert.equal(value,true));
}

async function benchmarkPair(binary, stage, before, after, check, {oldEngine=binary,rounds=201} = {}) {
    const samples=[[],[]];
    const actions=[before,after];
    for (let round=0; round<=rounds; round++) {
        for (const index of round%2 ? [1,0] : [0,1]) {
            engine(index ? binary : oldEngine);
            const start=performance.now();
            const result=await actions[index]();
            if (round) samples[index].push(performance.now()-start);
            check(result);
        }
    }
    console.log(JSON.stringify({stage,beforeMs:median(samples[0]),afterMs:median(samples[1])}));
}

async function benchmarkSecondFactor(binary, directory) {
    const store = new SecretStore({dataDir:directory});
    engine(binary);
    const initial = await totp.enable(store,rfcUser,rfcSecret,-1);
    const grant = trust.issue([]);
    const remember = trust.remember(grant.devices,grant.token,30);
    const oldVerify = async () => {
        const decrypted = await store.decrypt(initial.state.secret);
        const secret = decrypted.slice(rfcUser.length+1);
        return {...initial.state,lastStep:totp.verify(secret,rfcCode,-1,rfcNow)};
    };
    await benchmarkPair(binary,'totp-consume',oldVerify,()=>totp.consume(store,rfcUser,initial.state,rfcCode,rfcNow),
        result=>assert.equal(result.lastStep,1));
    await benchmarkPair(binary,'totp-with-trust',
        async()=>({state:await oldVerify(),grant:trust.issue(remember.devices,remember.replaced,remember.days)}),
        ()=>totp.consumeWithTrust(store,rfcUser,initial.state,rfcCode,rfcNow,remember),
        result=>assert(result.grant && result.state.lastStep===1));
    const verification = () => trust.recognizes(grant.devices,grant.token);
    await benchmarkPair(binary,'recognize-trusted',verification,verification,value=>assert.equal(value,true),{oldEngine:''});
    const consumeRecovery = () => totp.consume(store,rfcUser,initial.state,initial.recoveryCodes[0],rfcNow);
    await benchmarkPair(binary,'consume-recovery',consumeRecovery,consumeRecovery,
        result=>assert.equal(result.recoveryHashes.length,7),{oldEngine:''});
}

async function benchmarkOpds(binary, directory) {
    engine();
    const issued = await opdsPassword.issue();
    const check = value=>assert.equal(value,true);
    const verify = ()=>opdsPassword.verify(issued.hash,issued.password);
    await benchmarkPair(binary,'opds-app-verify',verify,verify,check,{oldEngine:''});
    await benchmarkPair(binary,'opds-app-issue',opdsPassword.issue,opdsPassword.issue,
        value=>assert.match(value.password,/^inpx_[A-Za-z0-9_-]{32}$/),{oldEngine:''});

    engine(binary);
    const store = new ReadingListStore({dataDir:directory,adminPassword:profilePassword});
    const data = await store.load();
    const passwordHash = await ProfilePassword.hash(profilePassword);
    const user = store.normalizeUser({id:'opds-reader-0',name:'OPDS reader',login:'opds-reader',passwordHash});
    for (let profile=0; profile<10; profile++) {
        const progress = Object.fromEntries(Array.from({length:2000},(_,index)=>[
            `item:${index}`,{percent:0.5,sectionId:'chapter-two',textOffset:index,textSnippet:'Фрагмент книги'}
        ]));
        data.users.push({...user,id:`opds-reader-${profile}`,name:`Reader ${profile}`,login:`reader-${profile}`,
            readerProgress:progress});
    }
    await store.save(data);
    assert.equal(Object.keys((await store.getUser(user.id)).readerProgress).length,2000);
    const before = async () => {
        const profile = (await store.load()).users.find(item=>item.id===user.id);
        return ProfilePassword.verify(profile.passwordHash,profile.login,profilePassword);
    };
    await benchmarkPair(binary,'opds-profile-verify-20k-progress',before,()=>store.verifyUserPassword(user.id,profilePassword),
        check,{rounds:21});
}

async function main(binary,mode) {
    if(!binary) throw new Error('Usage: node scripts/rust-credentials-tests.js <catalog-binary> [benchmark|second-factor|opds]');
    const logger = new (require('../server/core/AppLogger'))();
    if (!logger.inited) await logger.init({name:'rust-credentials-tests',loggingEnabled:false});
    const directory = await fs.mkdtemp(join(os.tmpdir(),'inpx-credentials-'));
    binary=resolve(binary);
    engine(binary);
    const close=native.start();
    try {
        if (mode === 'benchmark') await benchmark(binary,directory);
        else if (mode === 'second-factor') await benchmarkSecondFactor(binary,directory);
        else if (mode === 'opds') await benchmarkOpds(binary,directory);
        else await compatibility(binary,directory);
    } finally {
        await close();
        await fs.rm(directory,{recursive:true,force:true});
    }
}

main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
