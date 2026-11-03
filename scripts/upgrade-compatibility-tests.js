const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const RemoteMetadata = require('../server/core/RemoteMetadata');

async function testRemoteCapabilitiesRefreshAfterReconnectAndExpiry() {
    let socket = {}, modern = false, requests = 0;
    const remote = {ensureConnection:async() => metadata.setConnection(socket), wsRequest:async req => {
        if (req.action === 'get-config') {requests++; return modern ? {libraryProtocol:{version:1,features:['metadata','ratings']}} : {};}
        return {revision:'current',items:[['book',25]],next:null};
    }};
    const metadata = new RemoteMetadata(remote);
    assert.strictEqual((await metadata.ratingIndex()).signature, 'legacy');
    modern = true; socket = {};
    assert.strictEqual((await metadata.ratingIndex()).counts.get('book'), 25);
    assert.strictEqual(requests, 2);
    modern = false; socket = {};
    assert.strictEqual((await metadata.ratingIndex()).signature, 'legacy');
    assert.strictEqual(metadata.ratings, null);
    modern = true; metadata.checkedAt = Date.now() - 61000;
    assert.strictEqual(await metadata.supported('ratings'), true);
    assert.strictEqual(requests, 4);
}

async function testObsoleteRemoteResponsesCannotReplaceNewConnectionState() {
    let releaseHandshake, releaseIndex;
    const remote = {wsRequest:async req => {
        if (req.action === 'get-config') return new Promise(resolve => {releaseHandshake = resolve;});
        return new Promise(resolve => {releaseIndex = resolve;});
    }};
    const metadata = new RemoteMetadata(remote);
    metadata.setConnection({});
    const oldHandshake = assert.rejects(metadata.supported(), /Подключение/);
    const oldResolve = releaseHandshake;
    metadata.setConnection({});
    const currentHandshake = metadata.supported();
    const currentResolve = releaseHandshake;
    // The old response arrives while negotiation for the new socket is in flight.
    currentResolve({libraryProtocol:{version:1,features:['ratings']}});
    await currentHandshake;
    // A separately delayed index must not publish after a connection change either.
    const oldIndex = metadata.ratingIndex();
    await new Promise(resolve => setImmediate(resolve));
    metadata.setConnection({});
    const newHandshake = metadata.supported();
    releaseHandshake({libraryProtocol:{version:1,features:['metadata']}});
    await newHandshake;
    const rejectedIndex = assert.rejects(oldIndex, /Подключение/);
    releaseIndex({revision:'obsolete',items:[['old',99]],next:null});
    await rejectedIndex;
    assert.strictEqual(metadata.ratings, null);
    assert.strictEqual(await metadata.supported(), true);
    // Complete the first handshake last and verify it cannot clear the newer one.
    oldResolve({});
    await oldHandshake;
    assert.strictEqual(await metadata.supported(), true);
}

async function testUpgradeSnapshotPreservesUserDataSecretsAndCustomReader() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-upgrade-'));
    try {
        const config = {dataDir:dir,configFile:path.join(dir,'config.json'),version:'next'};
        const initial = {'config.json':'{"encryptedSecret":"unchanged"}', 'secret.key':'PRIVATE_FIXTURE_KEY',
            'reading-lists.json':JSON.stringify({version:5,users:[{id:'reader',readerProgress:{book:{position:42}},bookmarks:['chapter']}],
                lists:[{id:'old',filters:{title:'Book',unreadOnly:true}}]}),
            'public/version.txt':'old', 'public/custom-reader/index.html':'CUSTOM_READER'};
        for (const [name, data] of Object.entries(initial)) await fs.outputFile(path.join(dir,name), data);
        const {prepare} = require('../server/core/UpgradeSnapshot');
        const snapshot = await prepare(config);
        for (const [name, data] of Object.entries(initial)) assert.strictEqual(await fs.readFile(path.join(snapshot,name),'utf8'), data);
        const upgraded = JSON.parse(initial['reading-lists.json']);
        upgraded.lists.push({id:'new',filters:{ratingCount:'20..'}});
        await fs.writeJson(path.join(dir,'reading-lists.json'), upgraded);
        await fs.remove(path.join(dir,'public/custom-reader'));
        assert.strictEqual(await prepare(config), snapshot, 'A restart must never overwrite the pre-upgrade snapshot');
        for (const name of ['config.json','secret.key','reading-lists.json','public']) {
            await fs.remove(path.join(dir,name));
            await fs.copy(path.join(snapshot,name),path.join(dir,name));
        }
        for (const [name, data] of Object.entries(initial)) assert.strictEqual(await fs.readFile(path.join(dir,name),'utf8'), data);
        await fs.remove(path.join(dir,'.upgrade-version.json'));
        assert.notStrictEqual(await prepare(config), snapshot);
    } finally {await fs.remove(dir);}
}

async function testRemoteTransportKeepsLegacyAccessAfterProviderUpgradeAndRollback() {
    const {WebSocketServer} = require('ws');
    const Connection = require('../server/core/WebSocketConnection');
    const RemoteLib = require('../server/core/RemoteLib');
    const token = require('../server/core/utils').getBufHash('fixture-password' + 'fixture-salt', 'sha256', 'hex');
    const server = new WebSocketServer({port:0,host:'127.0.0.1',path:'/library/ws'});
    await new Promise(resolve => server.once('listening', resolve));
    let modern = false, metadataRequests = 0;
    server.on('connection', socket => socket.on('message', raw => {
        const req = JSON.parse(raw);
        socket.send(JSON.stringify({requestId:req.requestId,_rok:true}));
        let result;
        if (req.accessToken !== token) result = {error:'need_access_token',salt:'fixture-salt'};
        else if (req.action === 'get-config') result = modern ? {libraryProtocol:{version:1,features:['ratings']}} : {name:'Legacy provider'};
        else if (req.action === 'get-library-metadata') {
            metadataRequests++;
            result = modern ? {revision:'new-provider',items:[['rated',20]],next:null} : {error:'Unknown action'};
        } else if (req.action === 'get-inpx-file') result = {data:Buffer.from('INPX_FIXTURE').toString('base64')};
        else result = {link:'book/abcdef'};
        socket.send(JSON.stringify({...result,requestId:req.requestId}));
    }));
    const remote = Object.create(RemoteLib.prototype);
    remote.config = {remoteLib:{accessPassword:'fixture-password'}};
    remote.wsc = new Connection(`ws://127.0.0.1:${server.address().port}/library/ws`, 1);
    remote.metadata = new RemoteMetadata(remote);
    try {
        assert.strictEqual((await remote.metadata.ratingIndex()).signature, 'legacy');
        assert.strictEqual((await remote.wsRequest({action:'get-book-link'})).link, 'book/abcdef');
        modern = true; remote.wsc.terminate();
        assert.strictEqual((await remote.metadata.ratingIndex()).counts.get('rated'), 20);
        modern = false; remote.wsc.terminate();
        assert.strictEqual((await remote.metadata.ratingIndex()).signature, 'legacy');
        assert.strictEqual(metadataRequests, 1, 'Never send an unsupported metadata action to a legacy provider');
        assert.strictEqual(Buffer.from((await remote.wsRequest({action:'get-inpx-file'})).data,'base64').toString(), 'INPX_FIXTURE');
    } finally {
        remote.wsc.close();
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

module.exports = [testRemoteCapabilitiesRefreshAfterReconnectAndExpiry,
    testObsoleteRemoteResponsesCannotReplaceNewConnectionState, testUpgradeSnapshotPreservesUserDataSecretsAndCustomReader,
    testRemoteTransportKeepsLegacyAccessAfterProviderUpgradeAndRollback];
