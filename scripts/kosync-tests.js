const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const {KoSync, partialMd5, register} = require('../server/core/KoSync');
const position = require('../server/core/KoSyncPosition');
const ReadingListStore = require('../server/core/ReadingListStore');

const xml = '<FictionBook><description><title-info><book-title>Книга</book-title></title-info></description>' +
    '<body><section><title><p>Заголовок</p></title><p>Первый абзац <strong>книги</strong><a type="note">1</a>.</p>' +
    '<p>Второй абзац книги.</p></section></body><body name="notes"><section><p>Не основной текст</p></section></body></FictionBook>';

async function fixture(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kosync-'));
    try {
        const config = {dataDir: dir, bookDir: path.join(dir, 'books'), adminPassword: 'not-a-kosync-password', rootPathStatic: '/books'};
        const store = new ReadingListStore(config); const user = (await store.load()).users.find(user => user.isAdmin);
        const worker = {readingListStore: store, getBookRecordByUid: async uid => uid === 'book' ? {_uid: 'book'} : null,
            updateReaderProgress: async(uid, book, patch) => ({progress: await store.updateReaderProgress(uid, book, patch)})};
        const service = new KoSync(config, worker); worker.koSync = service;
        const file = path.join(config.bookDir, 'fixture.raw'); await fs.outputFile(file, xml);
        await task({config, store, user, worker, service, file});
    } finally { await fs.remove(dir); }
}

async function testKoSyncPartialHashAndParagraphBridge() {
    await fixture(async({file}) => {
        const bytes = Buffer.from(xml), hash = crypto.createHash('md5');
        hash.update(bytes); // fixture is shorter than the first 1024-byte sample
        assert.equal(await partialMd5(file), hash.digest('hex'));
        const long = Buffer.alloc(100000, 'a'); for (let i = 0; i < long.length; i++) long[i] = i % 251;
        await fs.writeFile(file, long);
        const expected = crypto.createHash('md5');
        for (const offset of [0, 1024, 4096, 16384, 65536]) expected.update(long.subarray(offset, offset + 1024));
        assert.equal(await partialMd5(file), expected.digest('hex'), 'KOReader hashes sparse 1 KiB samples, not the whole file');
        await fs.writeFile(file, xml);
        const index = await position.indexFile(file);
        assert.deepEqual(index.blocks.map(row => row.text), ['Заголовок', 'Первый абзац книги.', 'Второй абзац книги.']);
        const pointer = position.toKo(index, {textSnippet: 'Второй абзац книги.', percent: 0.8});
        assert.equal(pointer, '/FictionBook/body[1]/section[1]/p[2]/text().0');
        assert.equal(position.fromKo(index, '/FictionBook/body/section/p[2]/strong/text().4').textSnippet, 'Второй абзац книги.');
        assert.equal(position.fromKo(index, '/FictionBook/body/section/p[2]/autoBoxing/text().4').textSnippet, 'Второй абзац книги.');
        assert.equal(position.fromKo(index, '/FictionBook/body[2]/section/p[1]/text().0'), null);
        assert.equal(position.toKo(index, {textSnippet: 'Неизвестное издание', percent: 0.8}), null);
    });
}

async function testKoSyncCredentialsAndPersistence() {
    await fixture(async({config, service, user, file, worker, store}) => {
        const guest = (await store.load()).users.find(user => user.id === 'default');
        await assert.rejects(service.settings(guest, 'enable'), /need_profile_login/);
        assert.equal((await service.settings(user)).enabled, false);
        const settings = await service.settings(user, 'enable');
        const request = key => ({headers: {'x-auth-user': settings.username, 'x-auth-key': crypto.createHash('md5').update(key).digest('hex')}});
        assert(await service.authenticate(request(settings.password)));
        assert.equal(await service.authenticate(request('not-a-kosync-password')), null, 'Profile password is not a KOSync key');
        assert(!(await fs.readFile(service.file, 'utf8')).includes(settings.password));
        await service.linkDownload(file, 'book', 'fb2'); const document = await partialMd5(file);
        await service.progress(user, document, {document, progress: '/FictionBook/body/section/p[1]/text().0', percentage: 0.25, device: 'Reader', device_id: 'one'});
        const restart = new KoSync(config, worker);
        assert.equal((await restart.progress(user, document)).percentage, 0.25);
        const oldIdentity = await service.authenticate(request(settings.password));
        await service.settings(user, 'enable');
        assert.equal((await service.progress(user, document)).percentage, 0.25, 'Key rotation preserves listening/reading data');
        assert.equal(await service.authenticate(request(settings.password)), null, 'Key rotation revokes old clients');
        await assert.rejects(service.progress(oldIdentity, document), /Unauthorized/);
        await service.settings(user, 'disable'); assert.equal(await service.authenticate(request(settings.password)), null);
    });
}

async function testKoSyncBidirectionalProgressAndConflicts() {
    await fixture(async({service, store, user, file, worker}) => {
        await service.settings(user, 'enable'); await service.linkDownload(file, 'book', 'fb2'); const document = await partialMd5(file);
        const patch = {document, progress: '/FictionBook/body/section/p[1]/text().0', percentage: 0.25, device: 'Reader', device_id: 'one'};
        await service.progress(user, document, patch);
        let current = (await store.getUser(user.id)).readerProgress.book;
        assert.equal(current.textSnippet, 'Первый абзац книги.'); assert.equal(current.percent, 0.25);
        const web = await worker.updateReaderProgress(user.id, 'book', {percent: 0.8, textSnippet: 'Второй абзац книги.', baseRevision: current.revision});
        await service.progress(user, document, patch);
        assert.equal((await store.getUser(user.id)).readerProgress.book.revision, web.progress.revision, 'A stale KOReader push cannot overwrite an intervening web edit before a pull');
        const exported = await service.progress(user, document);
        assert.equal(exported.percentage, 0.8); assert(exported.progress.includes('p[2]'));
        assert.deepEqual(await service.progress(user, document), exported, 'Repeated pulls keep the exported web pointer');
        const unsupported = {...patch, progress: '/UnsupportedLayout/p[7]/text().0', percentage: 0.6};
        await service.progress(user, document, unsupported);
        assert.equal((await service.progress(user, document)).progress, unsupported.progress, 'An unsupported text pointer still synchronizes between KOReader devices');
        assert.equal((await store.getUser(user.id)).readerProgress.book.percent, 0.8);
        await service.progress(user, document, {...patch, percentage: 0.4});
        current = (await store.getUser(user.id)).readerProgress.book;
        assert.equal(current.percent, 0.4);
        const staleWeb = await worker.updateReaderProgress(user.id, 'book', {percent: 0.1, baseRevision: web.progress.revision});
        assert.equal(staleWeb.progress.conflict, true);
        await store.clearReaderProgress(user.id);
        await service.progress(user, document, patch);
        assert.equal((await store.getUser(user.id)).readerProgress.book, undefined, 'A reset cannot be undone by a stale push');
        assert.deepEqual(await service.progress(user, document), {});
        await service.linkDownload(file, 'different-entry', 'fb2');
        await service.progress(user, document, patch);
        assert.equal((await store.getUser(user.id)).readerProgress.book, undefined, 'Ambiguous catalog identities must never be guessed');
    });
}

async function testKoSyncSeparateProfilesAndOneWayFormats() {
    await fixture(async({service, store, user, file, worker}) => {
        const second = await store.createUser({name: 'Second reader', login: 'second'});
        await service.settings(user, 'enable'); await service.settings(second, 'enable');
        await service.linkDownload(file, 'book', 'epub'); const document = await partialMd5(file);
        const patch = {document, progress: '/body/DocFragment[2]/p[5]', percentage: 0.2, device: 'Reader', device_id: 'one'};
        await service.progress(user, document, patch);
        assert.deepEqual(await service.progress(second, document), {}, 'Another profile never sees a reader position');
        let current = (await store.getUser(user.id)).readerProgress.book;
        assert.equal(current.percent, 0.2); assert.equal(current.textSnippet, '');
        await worker.updateReaderProgress(user.id, 'book', {percent: 0.5, baseRevision: current.revision});
        await service.progress(user, document);
        await service.progress(user, document, {...patch, percentage: 0.7});
        current = (await store.getUser(user.id)).readerProgress.book;
        assert.equal(current.percent, 0.7, 'A pull permits subsequent percentage imports for non-FB2 books');
        const auth = await service.settings(second, 'enable');
        await store.deleteUser(second.id);
        const req = {headers: {'x-auth-user': auth.username, 'x-auth-key': crypto.createHash('md5').update(auth.password).digest('hex')}};
        assert.equal(await service.authenticate(req), null);
        await assert.rejects(service.progress(second, document, patch), /Unauthorized/, 'An in-flight deleted profile cannot fall back to the guest');
        assert.equal((await store.getUser('default')).readerProgress.book, undefined);
    });
}

async function testKoSyncHttpProtocolAndIsolation() {
    await fixture(async({service, worker, config, user}) => {
        const settings = await service.settings(user, 'enable');
        const app = express(); const security = {checkLoginRate() {}, recordLoginAttempt() {}};
        register(app, config, worker, security);
        const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}/books/kosync`;
            const headers = {'x-auth-user': settings.username, 'x-auth-key': crypto.createHash('md5').update(settings.password).digest('hex'), 'content-type': 'application/json'};
            assert.equal((await fetch(base + '/users/auth')).status, 401);
            assert.equal((await fetch(base + '/users/auth', {headers})).status, 200);
            assert.equal((await fetch(base + '/users/create', {method: 'POST'})).status, 403);
            const document = 'a'.repeat(32), body = {document, progress: '/body/p[1]', percentage: 0.2, device: 'KOReader', device_id: 'id'};
            let response = await fetch(base + '/syncs/progress', {method: 'PUT', headers, body: JSON.stringify(body)});
            assert.equal(response.status, 200); assert.equal((await response.json()).document, document);
            response = await fetch(base + '/syncs/progress/' + document, {headers});
            assert.equal((await response.json()).percentage, 0.2); assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal((await fetch(base + '/syncs/progress/' + 'b'.repeat(32), {headers})).status, 200);
            assert.deepEqual(await (await fetch(base + '/syncs/progress/' + 'b'.repeat(32), {headers})).json(), {});
            assert.equal((await fetch(base + '/syncs/progress', {method: 'PUT', headers, body: JSON.stringify({...body, percentage: 99})})).status, 400);
            assert.equal((await fetch(base + '/syncs/progress', {method: 'PUT', headers, body: '{bad'})).status, 400);
            assert.equal((await fetch(base + '/syncs/progress/' + document, {headers: {...headers, 'x-auth-user': 'another-profile'}})).status, 401);
            config.kosyncEnabled = false; assert.equal((await fetch(base + '/users/auth', {headers})).status, 404);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
}

module.exports = [testKoSyncPartialHashAndParagraphBridge, testKoSyncCredentialsAndPersistence, testKoSyncBidirectionalProgressAndConflicts,
    testKoSyncSeparateProfilesAndOneWayFormats, testKoSyncHttpProtocolAndIsolation];
