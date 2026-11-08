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
    const Api = new Function('require', 'componentOptions', 'profileSessionStorageKey', 'profileLoginHistoryStorageKey', 'localStorage', 'wsc', `${body};return Api;`)(
        createRequire(file), {}, sessionKey, 'inpx-web-profile-login-history', localStorage, socket);
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
    assert.equal(JSON.parse(storage.get(sessionKey)).profileAccessToken, 'admin-session');
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

module.exports = [testProfileLogoutClearsCredentialsAndStopsOldPageWrites, testFailedLogoutRetainsSessionAndSsoCannotPretendToSignOut,
    testLateConfigCannotRestoreAdminAfterLogout, testLogoutButtonWaitsForRevocationAndReportsFailure];
