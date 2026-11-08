const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const {partialMd5} = require('../server/core/KoSync');

module.exports = async function checkKoSync(url, directory) {
    const response = await fetch(url + '/');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', {headers: {cookie, origin: url}});
    await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
    let counter = 0;
    const common = {};
    const request = data => new Promise((resolve, reject) => {
        const requestId = String(++counter);
        const timer = setTimeout(() => {socket.off('message', listener); reject(new Error('KOSync integration WebSocket timeout'));}, 15000);
        const listener = raw => {
            const body = JSON.parse(raw);
            if (body.requestId !== requestId || body._rok) return;
            clearTimeout(timer); socket.off('message', listener); resolve(body);
        };
        socket.on('message', listener); socket.send(JSON.stringify({...common, ...data, requestId}));
    });
    try {
        const config = await request({action: 'get-config'}); common.csrfToken = config.csrfToken;
        assert.equal((await request({action: 'kosync-settings', operation: 'enable'})).error, 'need_profile_login');
        const login = await request({action: 'login-user-profile', login: 'admin', password: 'browser-speech-test'});
        assert(!login.error, login.error); Object.assign(common, login);
        delete common.requestId;
        const settings = await request({action: 'kosync-settings', operation: 'enable'});
        assert(settings.password, settings.error);
        const headers = {'x-auth-user': settings.username, 'x-auth-key': crypto.createHash('md5').update(settings.password).digest('hex'), 'content-type': 'application/json'};
        assert.equal((await fetch(url + settings.path + '/users/auth', {headers})).status, 200);
        assert.equal((await request({action: 'kosync-settings', operation: 'status'})).password, undefined);
        // Use the current catalog UID, not the historical hash of the INPX row.
        const found = await request({action:'bookSearch',query:{title:'=Packaged smoke book',ext:'fb2',del:'0',limit:1}});
        const bookUid = found.found?.[0]?._uid;assert(bookUid,'The fixture book is indexed');
        const prepared = await request({action: 'get-book-link', bookUid}); assert(prepared.link, prepared.error);
        const book = await fetch(url + prepared.link + '/raw', {headers: {cookie}}); assert.equal(book.status, 200);
        const downloaded = path.join(directory, 'downloaded.fb2'); await fs.writeFile(downloaded, Buffer.from(await book.arrayBuffer()));
        const document = await partialMd5(downloaded);
        const push = {document, progress: '/FictionBook/body/section/p[1]/text().0', percentage: 0.3, device: 'KOReader test', device_id: 'test'};
        assert.equal((await fetch(url + settings.path + '/syncs/progress', {method: 'PUT', headers, body: JSON.stringify(push)})).status, 200);
        const state = await request({action: 'get-reader-state', bookUid});
        assert.equal(state.progress.percent, 0.3, JSON.stringify(state));
        assert.equal(state.progress.textSnippet, 'Текст книги для синхронизации KOReader.');
        const updated = await request({action: 'update-reader-progress', bookUid,
            progress: {...state.progress, percent: 0.7, textSnippet: 'Второй абзац книги для синхронизации.', baseRevision: state.progress.revision}});
        assert(!updated.error, updated.error);
        const result = await (await fetch(url + settings.path + '/syncs/progress/' + document, {headers})).json();
        assert.equal(result.percentage, 0.7, JSON.stringify(result)); assert(result.progress.includes('p[2]'));
        await request({action: 'kosync-settings', operation: 'disable'});
        assert.equal((await fetch(url + settings.path + '/users/auth', {headers})).status, 401);
        console.log('KOSync integration: real WebSocket profile/CSRF, private key, actual download mapping, FB2 bridge both ways and revocation passed');
    } finally {socket.terminate();}
};
