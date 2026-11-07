const assert = require('assert/strict');
const path = require('path');
const {loadClient} = require('./catalog-list-filter-tests');

function settings(admin = true, source = {}) {
    const Type = loadClient(path.resolve(__dirname, '../client/components/Search/SettingsDialog/SettingsDialog.vue')).default;
    const value = new Type(), calls = [];
    value.$store = {state:{config:{profileAuthorized:admin, currentUserProfile:{isAdmin:admin}, adminIntegrations:source}, settings:{}}};
    value.$root = {notify:{success:message => calls.push(['success',message])}, stdDialog:{alert:message => calls.push(['alert',message])}};
    value.api = {
        updateAdminIntegrations:async integrations => {
            calls.push(['save',structuredClone(integrations)]);
            return {integrations:{...integrations,telegramProxyPassword:'',telegramProxyPasswordSet:!!integrations.telegramProxyPassword}};
        },
        updateConfig:async() => calls.push(['config']),
        testAdminIntegration:async kind => {calls.push(['test',kind]); return {message:'fixture connection ok'};},
    };
    value.commit = () => {throw new Error('Connection credentials must not be persisted as browser settings');};
    value.loadIntegrations();
    return {value,calls};
}

async function testTelegramProxyClientDefaultsAndSecretPlaceholder() {
    const {value} = settings(true, {telegramProxyMode:'custom',telegramProxyHost:'proxy.example.invalid',telegramProxyPort:1080,
        telegramProxyUsername:'fixture-user',telegramProxyPasswordSet:true,telegramIpFamily:'6'});
    assert.equal(value.makeDefaultIntegrations().telegramProxyMode,'system');
    assert.equal(value.integrations.telegramProxyPassword,'__KEEP__');
    assert.equal(value.integrations.telegramProxyHost,'proxy.example.invalid');
    assert.equal(value.integrations.telegramIpFamily,'6');
    assert.deepEqual(value.telegramProxyModes.map(option => option.value),['direct','system','custom']);
    assert.deepEqual(value.telegramProxyProtocols.map(option => option.value),['http','https','socks5','socks5h']);
    assert.match(value.telegramConnectionHint,/соединению сервера с прокси/);
    value.$store.state.config.adminIntegrations = {telegramProxyMode:'system'};
    value.telegramProxyPasswordVisible = true; value.loadIntegrations();
    assert.equal(value.integrations.telegramProxyPassword,'');
    assert.equal(value.telegramProxyPasswordVisible,false);
    for (const name of ['HTTPS_PROXY','ALL_PROXY','NO_PROXY']) assert(value.telegramConnectionHint.includes(name));
    assert(!value.telegramConnectionHint.includes('системный прокси'));
}

async function testTelegramProxyClientProbeUsesSavedModeAndKeepsPassword() {
    const {value,calls} = settings();
    Object.assign(value.integrations,{telegramProxyMode:'custom',telegramProxyProtocol:'socks5h',telegramProxyHost:'proxy.example.invalid',
        telegramProxyPort:1080,telegramProxyUsername:'fixture-user',telegramProxyPassword:'client-proxy-fixture',telegramIpFamily:'4'});
    await value.testTelegram();
    assert.deepEqual(calls.map(call => call[0]),['save','config','test','success']);
    const payload = calls[0][1];
    assert.equal(payload.telegramProxyProtocol,'socks5h');
    assert.equal(payload.telegramProxyHost,'proxy.example.invalid');
    assert.equal(payload.telegramProxyPassword,'client-proxy-fixture');
    assert.equal(payload.telegramIpFamily,'4');
    assert(!Object.keys(payload).some(key => /proxy.*url/i.test(key)), 'Credentials are sent as fields, never embedded in a proxy URL');
    assert.equal(calls[2][1],'telegram');
    assert.equal(value.integrations.telegramProxyPassword,'__KEEP__');
    assert.equal(value.telegramTestLoading,false); assert.equal(value.integrationSaveLoading,false);
    calls.length = 0; await value.saveIntegrations({quiet:true});
    assert.equal(calls[0][1].telegramProxyPassword,'__KEEP__');
    value.integrations.telegramProxyPassword = null; calls.length = 0;
    await value.saveIntegrations({quiet:true});
    assert.equal(calls[0][1].telegramProxyPassword,null, 'Clearing the password requests removal rather than keeping it');
    assert.equal(value.integrations.telegramProxyPassword,'');
}

async function testTelegramProxyClientSaveFailureAndGuestCannotProbe() {
    const {value,calls} = settings();
    value.api.updateAdminIntegrations = async() => {throw new Error('fixture validation failure');};
    await value.testTelegram();
    assert.deepEqual(calls,[['alert','fixture validation failure']]);
    assert.equal(value.integrationSaveLoading,false); assert.equal(value.telegramTestLoading,false);
    const guest = settings(false);
    await guest.value.testTelegram();
    assert.deepEqual(guest.calls,[]);
}

async function testTelegramProxyClientInactiveDraftCannotBlockDirectOrSystem() {
    for (const mode of ['direct','system']) {
        const {value,calls} = settings();
        Object.assign(value.integrations,{telegramProxyMode:mode,telegramProxyProtocol:'invalid',telegramProxyHost:'https://invalid.example/path',
            telegramProxyPort:99999,telegramProxyUsername:'unsaved-user',telegramProxyPassword:'unsaved-password'});
        value.api.updateAdminIntegrations = async patch => {
            calls.push(['save']);
            assert.equal(patch.telegramProxyMode,mode);
            assert.deepEqual(Object.keys(patch).filter(key => key.startsWith('telegramProxy')),['telegramProxyMode'],
                'Inactive custom drafts are omitted so the existing server values and secret remain intact');
            return {integrations:{telegramProxyMode:mode,telegramProxyHost:'saved.example.invalid',telegramProxyPort:1080,telegramProxyPasswordSet:true}};
        };
        await value.testTelegram();
        assert.deepEqual(calls.map(call => call[0]),['save','config','test','success']);
        assert.equal(value.integrations.telegramProxyHost,'saved.example.invalid');
        assert.equal(value.integrations.telegramProxyPassword,'__KEEP__');
    }
}

module.exports = [testTelegramProxyClientDefaultsAndSecretPlaceholder,testTelegramProxyClientProbeUsesSavedModeAndKeepsPassword,
    testTelegramProxyClientSaveFailureAndGuestCannotProbe,testTelegramProxyClientInactiveDraftCannotBlockDirectOrSystem];
