const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {parse} = require('@vue/compiler-sfc');
const {createRequire} = require('module');

const sessionKey = 'inpx-web-profile-session';
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function api() {
    const file = path.resolve(__dirname, '../client/components/Api/Api.vue');
    const source = parse(fs.readFileSync(file, 'utf8')).descriptor.script.content;
    const body = source.slice(source.indexOf('class Api {'), source.indexOf('export default'));
    const storage = new Map([[sessionKey, JSON.stringify({currentUserId: 'admin', profileAccessToken: 'admin-session'})]]);
    const localStorage = {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)};
    const calls = [];
    const socket = {send: async params => {calls.push(params); return params;}, message: async() => ({success: true})};
    const Api = new Function('require', 'componentOptions', 'profileSessionStorageKey', 'profileLoginHistoryStorageKey', 'localStorage', 'wsc', 'webAppVersion', `${body};return Api;`)(
        createRequire(file), {}, sessionKey, 'inpx-web-profile-login-history', localStorage, socket, require('../package.json').version);
    const value = new Api();
    value.$store = {state: {settings: {currentUserId: 'admin', profileAccessToken: 'admin-session'}, config: {
        profileAuthorized: true, currentUserId: 'admin', currentUserProfile: {id: 'admin', isAdmin: true}, userProfiles: [{id: 'admin'}],
    }}};
    value.$root = {stdDialog: {alert: message => {throw new Error(message);}}};
    value.commit = (type, patch) => {
        if (type === 'setConfig') value.$store.state.config = patch;
        else value.$store.state.settings = {...value.$store.state.settings, ...patch};
    };
    value.loadSettings();
    return {value, storage, calls};
}

async function testProfileLogoutClearsCredentialsAndStopsOldPageWrites() {
    const {value, storage, calls} = api();
    await value.signOutProfile();
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'logout-user-profile');
    assert.equal(calls[0].profileAccessToken, 'admin-session', 'Server revocation must use the authenticated session');
    assert.equal(storage.has(sessionKey), false);
    assert.equal(value.profileAccessToken, ''); assert.equal(value.currentUserId, 'default');
    assert.equal(value.$store.state.settings.profileAccessToken, '');
    assert.equal(value.$store.state.config.profileAuthorized, false);
    assert.equal(value.$store.state.config.currentUserProfile, null);
    value.loadSettings(); assert.equal(value.profileAccessToken, '', 'Settings refresh cannot restore a saved admin token');
    await assert.rejects(value.request({action: 'update-reader-progress', bookUid: 'old-book', progress: {percent: 0.5}}), /выход из профиля/);
    assert.equal(calls.length, 1, 'A cached reader must not save private progress into the guest profile on page unload');
}

async function testFailedLogoutRetainsSessionAndSsoCannotPretendToSignOut() {
    const {value, storage} = api();
    value.logoutUserProfile = async() => {throw new Error('Server unavailable');};
    await assert.rejects(value.signOutProfile(), /Server unavailable/);
    assert.equal(value.profileSigningOut, false);
    assert.equal(value.$store.state.config.profileAuthorized, true);
    assert.equal(value.profileAccessToken, 'admin-session');
    assert.equal(value.$store.state.settings.profileAccessToken, 'admin-session');
    assert.equal(JSON.parse(storage.get(sessionKey)).currentUserId, 'admin');
    assert.equal(JSON.parse(storage.get(sessionKey)).profileAccessToken, undefined, 'Legacy bearer tokens are scrubbed from localStorage');
    value.$store.state.config.profileBoundId = 'admin';
    await assert.rejects(value.signOutProfile(), /SSO/);
    assert.equal(value.$store.state.config.profileAuthorized, true);
}

async function testLateConfigCannotRestoreAdminAfterLogout() {
    const {value, storage} = api(), response = deferred();
    value.getConfig = () => response.promise;
    const pending = value.updateConfig();
    await value.signOutProfile();
    response.resolve({profileAuthorized: true, currentUserId: 'admin', userProfiles: [{id: 'admin'}]});
    await pending;
    assert.equal(value.$store.state.config.profileAuthorized, false);
    assert.equal(value.$store.state.settings.currentUserId, 'default');
    assert.equal(storage.has(sessionKey), false);
}

async function testLogoutButtonWaitsForRevocationAndReportsFailure() {
    const source = parse(fs.readFileSync(path.resolve(__dirname, '../client/components/share/ProfileLogout.vue'), 'utf8')).descriptor.script.content;
    let reloads = 0, requests = 0;
    const response = deferred(), errors = [];
    const component = new Function('window', source.replace('export default', 'return'))({location: {reload() {reloads++;}}});
    const value = {...component.data(), $store: {state: {config: {profileAuthorized: true}}},
        $root: {api: {signOutProfile: () => {requests++; return response.promise;}}, stdDialog: {alert: message => errors.push(message)}}};
    value.logout = component.methods.logout.bind(value);
    assert.equal(component.computed.canLogout.call(value), true, 'The button is available to an authenticated admin');
    const leaving = value.logout(); await value.logout();
    assert.equal(requests, 1); assert.equal(reloads, 0);
    response.resolve(); await leaving; assert.equal(reloads, 1);
    value.$root.api.signOutProfile = async() => {throw new Error('Network failed');};
    await value.logout(); assert.equal(reloads, 1); assert.deepEqual(errors, ['Network failed']);
    value.$store.state.config.profileBoundId = 'admin'; assert.equal(component.computed.canLogout.call(value), false);
    value.$store.state.config = {profileAuthorized: false}; assert.equal(component.computed.canLogout.call(value), false);
}

async function testInitialUiDefaultsWaitForConfigAndPreserveManualSettings() {
    const {value} = api();
    value.commit('setSettings',{defaultsSet:false,langDefault:'en',limit:20});
    const pending = deferred();
    value.getConfig = () => pending.promise;
    const load = value.updateConfig({skipProfileLogin:true});
    assert.equal(value.accessGranted,false);
    pending.resolve({profileLoginRequired:true,profileAuthorized:false,uiDefaults:{langDefault:'ru',limit:40}});
    await load;
    assert.equal(value.accessGranted,false);
    assert.equal(value.settings.defaultsSet,false);
    assert.equal(value.settings.langDefault,'en');
    value.getConfig = async()=>({profileAuthorized:true,currentUserId:'admin',uiDefaults:{langDefault:'ru',limit:40}});
    await value.updateConfig();
    assert.equal(value.accessGranted,true);
    assert.equal(value.settings.defaultsSet,true);
    assert.equal(value.settings.langDefault,'ru');
    assert.equal(value.settings.limit,40);
    value.commit('setSettings',{langDefault:'de',limit:7});
    await value.updateConfig();
    assert.equal(value.settings.langDefault,'de');
    assert.equal(value.settings.limit,7);
}

async function testReopeningGuestAccessDismissesActiveRequiredLogin() {
    const {value} = api();
    const started = deferred(), prompt = deferred();
    let dismissed = 0;
    value.$root.stdDialog.profileLogin = (_message, _title, options) => {
        assert.equal(options.noCancel, true);
        started.resolve();
        return prompt.promise;
    };
    value.$root.stdDialog.dismissRequiredProfileLogin = () => {
        dismissed++;
        prompt.resolve(null);
    };
    value.getConfig = async() => ({profileLoginRequired: true, profileAuthorized: false});
    const original = value.updateConfig();
    await Promise.race([started.promise, original.then(() => {throw new Error('Login was not opened');})]);
    assert.equal(value.accessGranted, false);
    value.getConfig = async() => ({profileLoginRequired: false, profileAuthorized: false});
    await value.updateConfig();
    await original;
    assert.equal(dismissed, 1);
    assert.equal(value.accessGranted, true);
}

module.exports = [testInitialUiDefaultsWaitForConfigAndPreserveManualSettings, testReopeningGuestAccessDismissesActiveRequiredLogin, testProfileLogoutClearsCredentialsAndStopsOldPageWrites, testFailedLogoutRetainsSessionAndSsoCannotPretendToSignOut,
    testLateConfigCannotRestoreAdminAfterLogout, testLogoutButtonWaitsForRevocationAndReportsFailure];
