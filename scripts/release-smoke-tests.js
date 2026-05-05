const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');

require('../server/core/Logger');

const AppLogger = require('../server/core/AppLogger');

async function ensureLogger() {
    const logger = new AppLogger();
    if (!logger.inited)
        await logger.init({loggingEnabled: false, name: 'release-smoke-tests'});
}

function makeWorker(config = {}) {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    worker.config = Object.assign({
        name: 'inpx-web',
        version: 'test',
        librarySources: [],
        opds: {},
    }, config);
    worker.checkMyState = () => true;
    worker.requireAdmin = async() => true;
    worker.addAdminEvent = () => {};
    return worker;
}

async function withTempDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-release-smoke-'));
    try {
        return await fn(dir);
    } finally {
        await fs.remove(dir);
    }
}

function createHttpServer(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(server, urlPath) {
    const port = server.address().port;
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port,
            path: urlPath,
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
    });
}

async function withStaticServer(config, fn) {
    const express = require('express');
    const app = express();
    require('../server/static')(app, Object.assign({rootPathStatic: ''}, config));
    const server = await createHttpServer(app);
    try {
        return await fn(server);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function testAdminSettingsRestoreKeepsSecrets() {
    const worker = makeWorker({
        opds: {
            enabled: true,
            login: 'opds',
            password: 'current-secret',
        },
    });

    const patch = worker.normalizeImportedAdminSettings({
        settings: {
            opds: {
                enabled: false,
                passwordSet: true,
            },
            coverCacheSize: 128,
        },
    });

    assert.strictEqual(patch.coverCacheSize, 128);
    assert.strictEqual(patch.opds.enabled, false);
    assert.strictEqual(patch.opds.password, 'current-secret');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(patch.opds, 'passwordSet'), false);
    assert.throws(
        () => worker.normalizeImportedAdminSettings({settings: {librarySources: {bad: true}}}),
        /librarySources/
    );
}

async function testAdminBackupArchiveAndDownload() {
    await withTempDir(async(dir) => {
        const bookDir = path.join(dir, 'book');
        const dataDir = path.join(dir, 'data');
        const configFile = path.join(dataDir, 'config.json');
        await fs.ensureDir(dataDir);
        await fs.writeJson(configFile, {
            coverCacheSize: 256,
            opds: {
                enabled: true,
                password: 'full-backup-secret',
            },
        });
        await fs.writeJson(path.join(dataDir, 'reading-lists.json'), {
            version: 5,
            users: [{
                id: 'reader',
                name: 'Reader',
                readerProgress: {'book:1': {percent: 0.5}},
                readerBookmarks: {'book:1': [{id: 'bookmark-1', title: 'Chapter'}]},
            }],
            lists: [{id: 'list-1', userId: 'reader', name: 'Reading', books: [{bookUid: 'book:1', read: false}]}],
        });
        await fs.writeJson(path.join(dataDir, 'discovery-cache.json'), {items: []});
        await fs.writeFile(path.join(dataDir, 'secret.key'), 'secret');
        await fs.ensureDir(path.join(dataDir, 'db'));
        await fs.writeFile(path.join(dataDir, 'db', 'index.json'), '{}');

        const worker = makeWorker({
            name: 'inpx-web',
            version: '1.6.7-test',
            bookDir,
            bookPathStatic: '/book',
            dataDir,
            configFile,
        });

        const result = await worker.createAdminBackup('admin', 'token');
        assert.strictEqual(result.success, true);
        assert.match(result.fileName, /^inpx-web-backup-.+\.zip$/);
        assert.strictEqual(result.link, `/book/backup/${encodeURIComponent(result.fileName)}`);
        assert.strictEqual(await fs.pathExists(path.join(bookDir, 'backup', result.fileName)), true);

        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({file: path.join(bookDir, 'backup', result.fileName)});
        try {
            const entries = await zip.entries();
            assert.ok(entries['backup-info.json']);
            assert.ok(entries['config.json']);
            assert.ok(entries['reading-lists.json']);
            assert.ok(entries['secret.key']);
            assert.ok(entries['discovery-cache.json']);
            assert.strictEqual(entries['db/index.json'], undefined);

            const readingLists = JSON.parse((await zip.entryData('reading-lists.json')).toString('utf8'));
            assert.strictEqual(readingLists.users[0].readerProgress['book:1'].percent, 0.5);
            assert.strictEqual(readingLists.users[0].readerBookmarks['book:1'][0].id, 'bookmark-1');
            assert.strictEqual(readingLists.lists[0].books[0].bookUid, 'book:1');

            const info = JSON.parse((await zip.entryData('backup-info.json')).toString('utf8'));
            assert.match(info.note, /reader progress and bookmarks/);
            assert.match(info.note, /does not include .*search DB/i);
        } finally {
            await zip.close();
        }

        await withStaticServer({
            bookDir,
            bookPathStatic: '/book',
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            const ok = await request(server, `/book/backup/${encodeURIComponent(result.fileName)}`);
            assert.strictEqual(ok.status, 200);
            assert.match(ok.headers['content-disposition'] || '', /attachment/);
            assert.ok(ok.body.length > 0);

            const notZip = await request(server, '/book/backup/readme.txt');
            assert.strictEqual(notZip.status, 404);
        });

        const ReadingListStore = require('../server/core/ReadingListStore');
        const restoreDataDir = path.join(dir, 'restore-data');
        const restoreConfigFile = path.join(restoreDataDir, 'config.json');
        const restoreWorker = makeWorker({
            dataDir: restoreDataDir,
            tempDir: path.join(dir, 'restore-tmp'),
            configFile: restoreConfigFile,
            bookDir: path.join(dir, 'restore-book'),
            bookPathStatic: '/book',
            opds: {
                enabled: false,
                password: 'old-secret',
            },
        });
        restoreWorker.readingListStore = new ReadingListStore({
            dataDir: restoreDataDir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });

        const restored = await restoreWorker.importAdminBackup('admin', 'token', {
            fileName: result.fileName,
            contentBase64: (await fs.readFile(path.join(bookDir, 'backup', result.fileName))).toString('base64'),
        });
        assert.strictEqual(restored.success, true);
        assert.strictEqual(restored.restartRecommended, true);
        assert.ok(restored.restored.includes('config.json'));
        assert.ok(restored.restored.includes('secret.key'));
        assert.ok(restored.restored.includes('reading-lists.json'));
        assert.strictEqual((await fs.readJson(restoreConfigFile)).opds.password, 'full-backup-secret');
        assert.strictEqual((await fs.readFile(path.join(restoreDataDir, 'secret.key'), 'utf8')), 'secret');

        const restoredLists = await restoreWorker.readingListStore.load();
        const restoredReader = restoredLists.users.find(user => user.id === 'reader');
        assert.ok(restoredReader);
        assert.strictEqual(restoredReader.readerProgress['book:1'].percent, 0.5);
        assert.strictEqual(restoredReader.readerBookmarks['book:1'][0].id, 'bookmark-1');
    });
}

async function testUserBackupExportsAndRestoresReaderState() {
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({
            dataDir: dir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });
        await store.save({
            version: 5,
            users: [{
                id: 'reader-a',
                name: 'Reader A',
                emailTo: 'reader@example.test',
                telegramChatId: '12345',
                opdsEnabled: true,
                opdsAuthEnabled: true,
                readerPreferences: {
                    theme: 'sepia',
                    fontFamily: 'sans',
                    fontSize: 21,
                },
                readerProgress: {
                    'source:book:1': {
                        percent: 0.75,
                        sectionId: 'chapter-3',
                        hidden: false,
                    },
                },
                readerBookmarks: {
                    'source:book:1': [{
                        id: 'bookmark-a',
                        title: 'Chapter 3',
                        excerpt: 'Text',
                        note: 'Note',
                        percent: 0.75,
                    }],
                },
                discoveryPreferences: {
                    hiddenBooks: ['source:book:2'],
                },
            }, {
                id: 'reader-b',
                name: 'Reader B',
            }],
            lists: [{
                id: 'list-a',
                userId: 'reader-a',
                name: 'Reading',
                visibility: 'private',
                books: [{bookUid: 'source:book:1', read: true}],
            }],
        });

        const exported = await store.exportData('reader-a');
        assert.strictEqual(exported.version, 4);
        assert.strictEqual(exported.user.emailTo, 'reader@example.test');
        assert.strictEqual(exported.user.readerPreferences.theme, 'sepia');
        assert.strictEqual(exported.user.readerProgress['source:book:1'].percent, 0.75);
        assert.strictEqual(exported.user.readerBookmarks['source:book:1'][0].id, 'bookmark-a');
        assert.deepStrictEqual(exported.user.discoveryPreferences.hiddenBooks, ['source:book:2']);
        assert.strictEqual(exported.lists[0].books[0].read, true);

        const imported = await store.importData('reader-b', exported);
        assert.strictEqual(imported.importedLists, 1);
        assert.strictEqual(imported.importedBooks, 1);
        assert.strictEqual(imported.importedProgress, 1);
        assert.strictEqual(imported.importedBookmarks, 1);

        const restored = await store.exportData('reader-b');
        assert.strictEqual(restored.user.name, 'Reader B');
        assert.strictEqual(restored.user.telegramChatId, '12345');
        assert.strictEqual(restored.user.readerPreferences.fontFamily, 'sans');
        assert.strictEqual(restored.user.readerProgress['source:book:1'].sectionId, 'chapter-3');
        assert.strictEqual(restored.user.readerBookmarks['source:book:1'][0].note, 'Note');
        assert.deepStrictEqual(restored.user.discoveryPreferences.hiddenBooks, ['source:book:2']);
    });
}

async function testCoverCacheRoutesAndCleaner() {
    await withTempDir(async(dir) => {
        const coverDir = path.join(dir, 'cover');
        await fs.ensureDir(coverDir);
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        await fs.writeFile(path.join(coverDir, 'source-a-123.jpg'), jpg);

        await withStaticServer({
            coverDir,
            bookDir: path.join(dir, 'book'),
            bookPathStatic: '/book',
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'),
            libDir: dir,
            librarySources: [{id: 'source-a', name: 'Source A', libDir: dir, inpx: path.join(dir, 'a.inpx')}],
        }, async(server) => {
            const cached = await request(server, '/cover/source-a/123');
            assert.strictEqual(cached.status, 200);
            assert.match(cached.headers['content-type'] || '', /image\/jpeg/);
            assert.deepStrictEqual(cached.body, jpg);

            const missing = await request(server, '/cover/source-a/not-a-number');
            assert.strictEqual(missing.status, 404);
        });

        await fs.writeFile(path.join(coverDir, 'empty.jpg'), '');
        await fs.writeFile(path.join(coverDir, 'bad.webp'), 'not cached here');
        const worker = makeWorker();
        const cleaned = await worker.cleanBrokenCoverCacheFiles(coverDir);
        assert.strictEqual(cleaned.checked, 3);
        assert.strictEqual(cleaned.removed, 2);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'source-a-123.jpg')), true);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'empty.jpg')), false);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'bad.webp')), false);
    });
}

async function testExternalDiscoveryMultiSourceSearch() {
    const singleSourceWorker = makeWorker({
        librarySources: [{id: 'only', name: 'Only', enabled: true}],
    });
    assert.deepStrictEqual(singleSourceWorker.externalDiscoverySearchQueries({title: 'Night Watch'}, 5), [
        {title: '=Night Watch', limit: 5},
        {title: '*Night Watch', limit: 5},
    ]);

    const multiSourceWorker = makeWorker({
        librarySources: [
            {id: 'one', name: 'One', enabled: true},
            {id: 'two', name: 'Two', enabled: true},
            {id: 'disabled', name: 'Disabled', enabled: false},
            {id: 'three', name: 'Three', enabled: true},
        ],
    });
    const queries = multiSourceWorker.externalDiscoverySearchQueries({title: 'Night Watch'}, 7);
    assert.strictEqual(queries.length, 6);
    assert.deepStrictEqual(queries.map(item => item.sourceId), ['one', 'one', 'two', 'two', 'three', 'three']);

    const calls = [];
    multiSourceWorker.dbSearcher = {
        async bookSearch(query) {
            calls.push(query);
            return {
                found: query.sourceId === 'three'
                    ? [{_uid: 'three:1', title: 'Night Watch'}]
                    : [],
            };
        },
    };
    const candidates = await multiSourceWorker.findExternalDiscoveryCandidates({title: 'Night Watch'}, 7);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]._uid, 'three:1');
    assert.strictEqual(calls.length, 6);
}

async function testExternalDiscoverySingleFetch() {
    const worker = makeWorker();
    const calls = [];
    worker.fetchExternalFeedItems = async(limit, url) => {
        calls.push({limit, url});
        return {items: [], sourceUrl: url};
    };

    const result = await worker.fetchExternalDiscoveryItemsV2({
        externalLimit: 12,
        externalUrl: 'https://example.test/root',
        externalBrowseUrl: 'https://example.test/genre',
        externalName: 'Example',
    });

    assert.strictEqual(result.sourceUrl, 'https://example.test/genre');
    assert.deepStrictEqual(calls, [{limit: 12, url: 'https://example.test/genre'}]);

    worker.fetchExternalFeedItems = async() => {
        throw new Error('HTTP 404');
    };
    await assert.rejects(
        () => worker.fetchExternalDiscoveryItemsV2({
            externalLimit: 12,
            externalUrl: 'https://example.test/root',
            externalBrowseUrl: 'https://example.test/missing-genre',
            externalName: 'Example',
        }),
        /Example.+HTTP 404/
    );
}

async function testConfiguredConverterPathsHavePriority() {
    const externalTools = require('../server/core/ExternalTools');
    const bookConverter = require('../server/core/BookConverter');
    const configured = {
        sevenZip: '/opt/tools/7za-custom',
        djxl: '/opt/tools/djxl-custom',
        dwebp: '/opt/tools/dwebp-custom',
        fb2cng: '/opt/tools/fbc-custom',
        mutool: '/opt/tools/mutool-custom',
        calibre: '/opt/tools/ebook-convert-custom',
    };

    assert.strictEqual(externalTools.sevenZipCommandCandidates(configured)[0], configured.sevenZip);
    assert.strictEqual(externalTools.djxlCommandCandidates([], configured)[0], configured.djxl);
    assert.strictEqual(externalTools.dwebpCommandCandidates([], configured)[0], configured.dwebp);
    assert.strictEqual(bookConverter.fb2cngCommandCandidates(configured)[0], configured.fb2cng);
    assert.strictEqual(bookConverter.mutoolCommandCandidates(configured)[0], configured.mutool);
    assert.strictEqual(bookConverter.calibreCommandCandidates(configured)[0], configured.calibre);
}

const tests = [
    testAdminSettingsRestoreKeepsSecrets,
    testAdminBackupArchiveAndDownload,
    testUserBackupExportsAndRestoresReaderState,
    testCoverCacheRoutesAndCleaner,
    testExternalDiscoveryMultiSourceSearch,
    testExternalDiscoverySingleFetch,
    testConfiguredConverterPathsHavePriority,
];

(async() => {
    await ensureLogger();

    for (const test of tests) {
        await test();
        console.log(`ok ${test.name}`);
    }
})().catch((e) => {
    console.error(e && e.stack || e);
    process.exitCode = 1;
});
