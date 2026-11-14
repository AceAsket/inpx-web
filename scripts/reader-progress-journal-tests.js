const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {writeFileAtomic} = require('../server/core/FilePersistence');
const ReadingListStore = require('../server/core/ReadingListStore');
const {maxBytes, checkpointField} = require('../server/core/ReaderProgressJournal');
const ProfileAccess = require('../server/core/ProfileAccess');

async function fixture(run) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-progress-journal-'));
    try {
        const config = {dataDir, configFile: path.join(dataDir, 'config.json'), adminPassword: 'progress-fixture'};
        await run(config, new ReadingListStore(config));
    } finally {
        await fs.remove(dataDir);
    }
}

async function testProgressJournalPreservesLegacyAndReplaysCompleteUpdates() {
    await fixture(async(config, store) => {
        await store.updateReaderProgress('admin', 'old', {percent: 0.4});
        const legacy = await store.exportSnapshot();
        assert.equal(Object.hasOwn(legacy, checkpointField), false);
        await writeFileAtomic(store.file, JSON.stringify(legacy));

        const first = await store.updateReaderProgress('admin', 'old', {percent: 0.5, baseRevision: 1});
        assert.equal(first.revision, 2);
        const before = await fs.readFile(store.file, 'utf8');
        assert.equal((await store.updateReaderProgress('admin', 'new', {percent: 0.1})).revision, 1);
        assert.equal(await fs.readFile(store.file, 'utf8'), before);
        const open = new ReadingListStore(config);
        assert.equal((await open.getUser('admin')).readerProgress.new.percent, 0.1);

        await fs.appendFile(store.progressFile, '\n');
        await assert.rejects(new ReadingListStore(config).getUser('admin'), /Некорректная запись/);
        const journalBytes = (await fs.stat(store.progressFile)).size;
        await fs.truncate(store.progressFile, journalBytes - 1);
        await fs.appendFile(store.progressFile, '["partial');
        const sameBook = await Promise.all([
            store.updateReaderProgress('admin', 'new', {percent: 0.2, baseRevision: 1}),
            open.updateReaderProgress('admin', 'new', {percent: 0.3, baseRevision: 1}),
        ]);
        assert.equal(sameBook[0].revision, 2);
        assert.equal(sameBook[1].conflict, true);
        const stale = await store.updateReaderProgress('admin', 'new', {
            percent: 0.9, updatedAt: '2000-01-01T00:00:00.000Z',
        });
        stale.percent = 1;
        assert.equal((await open.getUser('admin')).readerProgress.new.percent, 0.2);
        assert(!(await fs.readFile(store.progressFile, 'utf8')).includes('partial'));
        assert.equal((await open.exportSnapshot()).users[0].readerProgress.new.revision, 2);
    });
}

async function testProgressJournalFoldsIntoBackupAndDoesNotReplayAfterRestoreOrReset() {
    await fixture(async(config, store) => {
        await store.updateReaderProgress('admin', 'book', {percent: 0.1});
        const backup = await store.exportSnapshot();
        await store.updateReaderProgress('admin', 'book', {percent: 0.2});
        const upgrade = await require('../server/core/UpgradeSnapshot').prepare({...config, version:'next'});
        const snapshot = await fs.readJson(path.join(upgrade, 'reading-lists.json'));
        assert.equal(snapshot.users[0].readerProgress.book.percent, 0.2);
        assert.equal(Object.hasOwn(snapshot, checkpointField), false);

        const restored = await store.rebaseReaderProgressGeneration(backup);
        await require('../server/core/BackupTransaction').commit(config, {'reading-lists.json': JSON.stringify(restored)});
        const open = new ReadingListStore(config);
        assert.equal((await store.getUser('admin')).readerProgress.book.percent, 0.1);
        assert.equal((await open.getUser('admin')).readerProgress.book.generation, 1);
        assert.equal((await store.updateReaderProgress('admin', 'book', {percent: 0.7, generation: 0})).generationMismatch, true);
        await store.updateReaderProgress('admin', 'book', {percent: 0.8, generation: 1});
        await store.updateReaderProgress('admin', 'book', {percent: 0.9, generation: 1});
        assert.equal((await open.getUser('admin')).readerProgress.book.percent, 0.9);
        await store.clearReaderProgress('admin');
        assert.deepEqual((await open.getUser('admin')).readerProgress, {});
        assert.equal((await open.updateReaderProgress('admin', 'book', {percent: 0.4, generation: 1})).reset, true);
    });
}

async function testProgressJournalCompactsAtBoundedSizeWithoutLosingBooks() {
    await fixture(async(config, store) => {
        await store.updateReaderProgress('admin', 'first', {percent: 0.1});
        for (let i = 0; i < 12; i++)
            await store.updateReaderProgress('admin', 'large-' + i, {sectionId: 'x'.repeat(maxBytes / 9 | 0)});
        assert((await fs.stat(store.progressFile)).size < maxBytes);
        const persisted = await fs.readJson(store.file);
        assert(Object.keys(persisted.users[0].readerProgress).length > 1, 'Pending entries were checkpointed');
        const user = await new ReadingListStore(config).getUser('admin');
        assert.equal(Object.keys(user.readerProgress).length, 13);
        assert.equal(user.readerProgress.first.percent, 0.1);
    });
}

async function testProgressWebSocketAuthorizesWithoutCloningProfileHistories() {
    await fixture(async(config, store) => {
        const user = await store.getUser('admin');
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.readingListStore = store;
        worker.checkMyState = () => {};
        worker.getProfileSessionUser = token => token === 'authorized' ? user.id : '';
        const Controller = require('../server/controllers/WebSocketController');
        const controller = Object.create(Controller.prototype);
        controller.webWorker = worker;
        let reply;
        controller.send = value => {reply = value;};
        const security = {getSession: () => null};
        const access = new ProfileAccess({...config, allowAnonymousAccess:false}, worker, security);
        const request = {action:'update-reader-progress', userId:user.id, profileAccessToken:'authorized',
            bookUid:'book', progress:{percent:0.5}};
        store.load = store.getUser = async() => {throw new Error('Progress must not clone the profile histories');};

        await assert.rejects(access.prepareWebSocket({...request, profileAccessToken:'wrong'}, {}), /need_profile_login/);
        await access.prepareWebSocket(request, {});
        await controller.updateReaderProgress(request);
        assert.equal(reply.progress.percent, 0.5);
        assert.equal((await new ReadingListStore(config).getUser(user.id)).readerProgress.book.percent, 0.5);
    });
}

module.exports = [
    testProgressJournalPreservesLegacyAndReplaysCompleteUpdates,
    testProgressJournalFoldsIntoBackupAndDoesNotReplayAfterRestoreOrReset,
    testProgressJournalCompactsAtBoundedSizeWithoutLosingBooks,
    testProgressWebSocketAuthorizesWithoutCloningProfileHistories,
];
