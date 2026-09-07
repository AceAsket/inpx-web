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

async function testConfigSecretsSurviveRestart() {
    const execFile = require('util').promisify(require('child_process').execFile);
    const configModulePath = require.resolve('../server/config');
    const cases = [
        {explicit: true, cli: true, saved: true},
        {explicit: true, saved: true},
        {cli: true, saved: true},
        {explicit: true, cli: true},
        {explicit: true},
        {explicit: true, empty: true},
        {cli: true},
        {},
        {explicit: true, saved: true, plaintext: true},
    ];
    const childScript = `
        const assert = require('assert');
        const path = require('path');
        const [modulePath, optionsJson, phase] = process.argv.slice(1);
        const options = JSON.parse(optionsJson);
        // Keep the executable's default data directory inside the test sandbox.
        for (const branch of ['development', 'production']) {
            const config = require(path.join(path.dirname(modulePath), branch));
            config.execDir = options.execDir;
            config.dataDir = '';
        }
        (async() => {
            const manager = new (require(modulePath))();
            await manager.init(options.cliDir, options.explicitFile);
            await manager.load();
            assert.strictEqual(path.resolve(manager.config.dataDir), options.expectedDir);
            assert.strictEqual(manager.config.opds.user, 'user1');
            if (phase === 'save') {
                assert.strictEqual(manager.config.opds.password, options.initialPassword);
                manager.config = {
                    opds: {...manager.config.opds, password: 'opds-test-password'},
                    smtpPass: 'smtp-test-password',
                    telegramBotToken: 'telegram-test-token',
                    metricsToken: 'metrics-test-token',
                };
                await manager.save();
            } else {
                assert.strictEqual(manager.config.opds.password, 'opds-test-password');
                assert.strictEqual(manager.config.smtpPass, 'smtp-test-password');
                assert.strictEqual(manager.config.telegramBotToken, 'telegram-test-token');
                assert.strictEqual(manager.config.metricsToken, 'metrics-test-token');
            }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;

    for (const scenario of cases) {
        await withTempDir(async(dir) => {
            const execDir = path.join(dir, 'app');
            const cliDir = scenario.cli ? path.join(dir, 'cli-data') : undefined;
            const defaultDir = cliDir || path.join(execDir, '.inpx-web');
            const expectedDir = scenario.saved ? path.join(dir, 'saved-data') : defaultDir;
            const configFile = scenario.explicit ? path.join(dir, 'config.json') : path.join(defaultDir, 'config.json');
            const initialPassword = scenario.plaintext ? 'old-plaintext-password' : '';
            const initialConfig = {opds: {enabled: true, user: 'user1', password: initialPassword}};
            if (scenario.saved || scenario.empty)
                initialConfig.dataDir = scenario.saved ? expectedDir : '';
            await fs.outputJson(configFile, initialConfig);
            const options = {execDir, cliDir, expectedDir, initialPassword,
                explicitFile: scenario.explicit ? configFile : undefined};
            const run = phase => execFile(process.execPath,
                ['-e', childScript, configModulePath, JSON.stringify(options), phase], {cwd: dir});
            await run('save');
            const stored = await fs.readJson(configFile);
            assert.ok(stored.opds.password.startsWith('enc:v1:'));
            const keyFile = path.join(expectedDir, 'secret.key');
            const keyBeforeRestart = await fs.readFile(keyFile, 'utf8');
            await run('load');
            assert.strictEqual(await fs.readFile(keyFile, 'utf8'), keyBeforeRestart);
            assert.ok(!await fs.pathExists(path.join(dir, 'secret.key')));
        });
    }
}

async function testTitleSearchKeepsIndexedPrefixFallbacks() {
    const DbSearcher = require('../server/core/DbSearcher');
    const searcher = Object.create(DbSearcher.prototype);
    searcher.db = {esc: JSON.stringify};

    const candidates = searcher.getTitleSearchPrefixCandidates('night');
    assert.ok(candidates.includes('night'));
    assert.ok(candidates.includes('«night'));
    assert.ok(candidates.includes('"night'));
    assert.ok(candidates.includes('(night'));
    assert.deepStrictEqual(searcher.getTitleSearchPrefixCandidates('*night'), ['*night']);

    const where = searcher.getWhere('Night', {looseTitlePrefix: true});
    assert.match(where, /@dirtyIndexLR\('value', "night"/);
    assert.match(where, /@dirtyIndexLR\('value', "«night"/);
    assert.doesNotMatch(where, /@indexIter/);

    const preparedWhere = `async(__tr) => { const ids = ${where}; return Array.from(ids); }`
        .replace(/@@/g, 'return await __tr.')
        .replace(/@/g, 'await __tr.');
    const whereFunc = new Function(`'use strict'; return ${preparedWhere}`)();
    const ids = await whereFunc({
        dirtyIndexLR: async(_field, from) => {
            if (from === 'night')
                return [1, 2];
            if (from === '\u00abnight')
                return [2, 3];
            return [];
        },
    });
    assert.deepStrictEqual(ids, [1, 2, 3]);
}

function testConvertedBookFileNames() {
    const bookConverter = require('../server/core/BookConverter');

    assert.strictEqual(bookConverter.getConvertedExtension('epub'), 'epub');
    assert.strictEqual(bookConverter.getConvertedExtension('epub3'), 'epub');
    assert.strictEqual(bookConverter.getConvertedExtension('kepub'), 'kepub.epub');
    assert.strictEqual(bookConverter.getConvertedExtension('KEPUB'), 'kepub.epub');
    assert.strictEqual(bookConverter.getConvertedExtension('AzW8'), 'azw8');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'kepub'), 'Book.kepub.epub');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'KEPUB'), 'Book.kepub.epub');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'epub3'), 'Book.epub');
}

async function testFb2cngConfigAndConversionCache() {
    const baseConfigPath = require.resolve('../server/config/base');
    const ConfigManager = require('../server/config');
    const bookConverter = require('../server/core/BookConverter');
    const envNames = ['INPX_FB2CNG_CONFIG', 'FB2CNG_CONFIG'];
    const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

    try {
        process.env.INPX_FB2CNG_CONFIG = '/config/inpx.yaml';
        process.env.FB2CNG_CONFIG = '/config/legacy.yaml';
        delete require.cache[baseConfigPath];
        assert.strictEqual(require('../server/config/base').fb2cngConfigPath, '/config/inpx.yaml');

        delete process.env.INPX_FB2CNG_CONFIG;
        delete require.cache[baseConfigPath];
        assert.strictEqual(require('../server/config/base').fb2cngConfigPath, '/config/legacy.yaml');
    } finally {
        for (const name of envNames) {
            if (previousEnv[name] === undefined)
                delete process.env[name];
            else
                process.env[name] = previousEnv[name];
        }
        delete require.cache[baseConfigPath];
        require('../server/config/base');
    }

    assert.ok(!ConfigManager.propsToSave.includes('fb2cngConfigPath'));
    assert.strictEqual(typeof(bookConverter.convert), 'function');
    assert.strictEqual(typeof(bookConverter.prepareConvertedFile), 'function');

    await withTempDir(async(dir) => {
        const configPath = path.join(dir, 'fb2cng', 'config.yaml');
        const cacheBasePath = path.join(dir, 'cache', 'book-hash');
        await fs.outputFile(configPath, 'document:\n  title: first\n');

        const config = {
            conversionEnabled: true,
            converterPaths: {fb2cng: '/opt/tools/fbc-custom'},
            fb2cngConfigPath: configPath,
            fb2cngVersion: 'v1.2.3',
        };
        const common = {
            cacheBasePath,
            inputFile: path.join(dir, 'book.raw'),
            sourceFileName: 'Book.fb2',
            config,
        };
        const epub = await bookConverter.getConversionCacheInfo({...common, format: 'epub'});
        const epub3 = await bookConverter.getConversionCacheInfo({...common, format: 'epub3'});
        assert.notStrictEqual(epub.filePath, epub3.filePath);
        assert.match(epub.filePath, /\.converted-v2-epub-/);
        assert.match(epub3.filePath, /\.converted-v2-epub3-/);

        const otherVersion = await bookConverter.getConversionCacheInfo({
            ...common,
            format: 'epub',
            config: {...config, fb2cngVersion: 'v1.2.4'},
        });
        assert.notStrictEqual(epub.filePath, otherVersion.filePath);

        await fs.writeFile(configPath, 'document:\n  title: second\n');
        const changedConfig = await bookConverter.getConversionCacheInfo({...common, format: 'epub'});
        assert.notStrictEqual(epub.filePath, changedConfig.filePath);

        let validationCall = null;
        await bookConverter.validateFb2cngConfig(
            changedConfig.fb2cngConfig,
            config.converterPaths,
            async(commands, args) => {
                validationCall = {commands, args};
            },
        );
        assert.strictEqual(validationCall.commands[0], '/opt/tools/fbc-custom');
        assert.deepStrictEqual(validationCall.args, ['--config', path.resolve(configPath), 'dumpconfig']);

        await fs.writeFile(configPath, 'invalid: [yaml\n');
        const invalidConfig = await bookConverter.readFb2cngConfig(configPath);
        await assert.rejects(
            () => bookConverter.validateFb2cngConfig(
                invalidConfig,
                config.converterPaths,
                async() => { throw new Error('YAML parse error'); },
            ),
            /Invalid fb2cng config.+YAML parse error/,
        );

        await assert.rejects(
            () => bookConverter.getConversionCacheInfo({
                ...common,
                format: 'epub',
                config: {...config, fb2cngConfigPath: path.join(dir, 'missing.yaml')},
            }),
            /Invalid fb2cng config.+does not exist or is not readable/,
        );

        const noCustomConfig = {...config, fb2cngConfigPath: ''};
        const cached = await bookConverter.getConversionCacheInfo({
            ...common,
            format: 'epub',
            config: noCustomConfig,
        });
        await fs.outputFile(cached.filePath, 'cached conversion');
        const prepared = await bookConverter.prepareConvertedFile({
            inputFile: common.inputFile,
            cacheBasePath,
            format: 'epub',
            sourceFileName: common.sourceFileName,
            downFileName: common.sourceFileName,
            config: noCustomConfig,
        });
        assert.deepStrictEqual(prepared, {
            filePath: cached.filePath,
            downloadName: 'Book.epub',
            created: false,
        });
    });

    const staticSource = await fs.readFile(path.join(__dirname, '../server/static.js'), 'utf8');
    const workerSource = await fs.readFile(path.join(__dirname, '../server/core/WebWorker.js'), 'utf8');
    assert.match(staticSource, /cacheBasePath: bookFile/);
    assert.match(workerSource, /cacheBasePath: gzipFile/);
    assert.match(workerSource, /Неподдерживаемый формат отправки/);
    assert.match(workerSource, /Конвертация книг отключена в текущем образе/);
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

async function testFb2ContentsExcludeNotesBodies() {
    const Fb2Parser = require('../server/core/fb2/Fb2Parser');
    const parser = new Fb2Parser();
    parser.fromString(`
        <FictionBook>
            <description>
                <title-info>
                    <book-title>Annotation fixture</book-title>
                    <annotation><p>Separate annotation</p><p><strong>Formatted text</strong></p></annotation>
                </title-info>
            </description>
            <body>
                <section><title><p>От автора</p></title><p>Ссылка <a l:href="#note-1" type="note">[1]</a></p></section>
                <section>
                    <title><p>1</p></title>
                    <section><title><p>Вложенная глава</p></title></section>
                </section>
            </body>
            <body name=" NoTeS ">
                <section id="note-1"><title><p>1</p></title><p>Текст сноски</p></section>
                <section id="note-2"><title><p>2</p></title><p>Ещё одна сноска</p></section>
            </body>
        </FictionBook>
    `, {lowerCase: true});

    const annotation = parser.bookInfo().titleInfo.annotation;
    assert.ok(Array.isArray(annotation));
    assert.strictEqual(annotation.length, 2);
    assert.strictEqual(annotation[0][1], 'p');

    const expectedContents = [
        {title: 'От автора', level: 0},
        {title: '1', level: 0},
        {title: 'Вложенная глава', level: 1},
    ];
    assert.deepStrictEqual(makeWorker().extractFb2Contents(parser), expectedContents);

    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');
    const readerContentsStart = readerSource.indexOf('    extractReaderContents(parser) {');
    const readerContentsEnd = readerSource.indexOf('    escapeCssId(id = \'\') {', readerContentsStart);
    assert.ok(readerContentsStart >= 0 && readerContentsEnd > readerContentsStart);
    const readerContentsMethod = readerSource.slice(readerContentsStart, readerContentsEnd).trim();
    const ReaderContents = new Function(`return class ReaderContents {${readerContentsMethod}}`)();
    assert.deepStrictEqual(new ReaderContents().extractReaderContents(parser), expectedContents);
}

async function testReaderAnnotationStaysOutsideReadingFlow() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');
    const annotationBuilderStart = readerSource.indexOf('    buildReaderAnnotationHtml(parser, annotationNodes = []) {');
    const readerBuilderStart = readerSource.indexOf('    buildReaderHtml(parser) {', annotationBuilderStart);
    const readerBuilderEnd = readerSource.indexOf('    createFb2Parser(source = \'\') {', readerBuilderStart);

    assert.ok(annotationBuilderStart >= 0 && readerBuilderStart > annotationBuilderStart);
    assert.ok(readerBuilderEnd > readerBuilderStart);
    const annotationBuilder = readerSource.slice(annotationBuilderStart, readerBuilderStart);
    const readerBuilder = readerSource.slice(readerBuilderStart, readerBuilderEnd);
    assert.match(annotationBuilder, /this\.renderBlockNodes\(annotationNodes/);
    assert.doesNotMatch(annotationBuilder, /annotationHtml|v-html|innerHTML/);
    assert.doesNotMatch(readerBuilder, /annotation/i);
    assert.match(readerSource, /this\.readerAnnotationHtml = this\.buildReaderAnnotationHtml\(/);
    assert.match(readerSource, /this\.readerSearchText = this\.normalizeReaderSearchText\(this\.stripHtml\(this\.readerHtml \|\| ''\)\)\.toLowerCase\(\);/);
    assert.match(readerSource, /get hasContentsMenu\(\)[\s\S]{0,160}this\.hasContents \|\| this\.hasAnnotation/);
    assert.match(readerSource, /v-if="hasContentsMenu"/);
    assert.match(readerSource, /contentsPanelView === 'annotation'/);
    assert.match(readerSource, /this\.findPagedPageIndexByAnchor\(targetId\)/);
    assert.match(readerSource, /this\.readerHtmlHasAnchor\(targetId\)/);
    assert.match(readerSource, /\.filter\(\(img\) => !img\.closest\('\.reader-annotation-html'\)\)/);
    assert.match(readerSource, /\.filter\(\(link\) => !link\.closest\('\.reader-annotation-html'\)\)/);
    assert.strictEqual((readerSource.match(/src="\$\{this\.escapeHtml\(src\)\}"/g) || []).length, 2);

    const handlerStart = readerSource.indexOf('    handleReaderAnnotationClick(event) {');
    const handlerEnd = readerSource.indexOf('    captureReaderNoteReturnPoint() {', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const handlerMethod = readerSource.slice(handlerStart, handlerEnd).trim();
    const AnnotationHandler = new Function(`return class AnnotationHandler {${handlerMethod}}`)();
    const makeHandler = ({pageIndex = -1, readerHtmlHasAnchor = false, annotationTarget = null} = {}) => {
        const handler = new AnnotationHandler();
        const jumps = [];
        const link = {};
        const root = {
            contains: item => item === link,
            querySelector: () => annotationTarget,
        };
        const event = {
            currentTarget: root,
            target: {closest: () => link},
            prevented: false,
            stopped: false,
            preventDefault() { this.prevented = true; },
            stopPropagation() { this.stopped = true; },
        };
        handler.$refs = {scroller: {querySelector: () => null}};
        handler.isPagedMode = true;
        handler.getReaderLinkTarget = () => 'chapter-2';
        handler.escapeCssId = value => value;
        handler.findPagedPageIndexByAnchor = () => pageIndex;
        handler.readerHtmlHasAnchor = () => readerHtmlHasAnchor;
        handler.captureReaderNoteReturnPoint = () => ({pageIndex: 0});
        handler.jumpToReaderAnchor = (id, options) => jumps.push({id, options});
        return {event, handler, jumps};
    };

    const offPage = makeHandler({pageIndex: 4});
    offPage.handler.handleReaderAnnotationClick(offPage.event);
    assert.strictEqual(offPage.event.prevented, true);
    assert.strictEqual(offPage.event.stopped, true);
    assert.deepStrictEqual(offPage.jumps, [{id: 'chapter-2', options: {returnPoint: {pageIndex: 0}}}]);

    let localScrolls = 0;
    const localTarget = {scrollIntoView: () => { localScrolls += 1; }};
    const localAnchor = makeHandler({annotationTarget: localTarget});
    localAnchor.handler.handleReaderAnnotationClick(localAnchor.event);
    assert.strictEqual(localAnchor.jumps.length, 0);
    assert.strictEqual(localScrolls, 1);
}

async function testReaderBookNotesMenuAndReturnLayout() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');

    assert.match(readerSource, /readerNotesAnchorId = '';/);
    assert.match(readerSource, /get hasBookNotes\(\)[\s\S]{0,120}readerNotesAnchorId/);
    assert.match(readerSource, /get hasContentsMenu\(\)[\s\S]{0,180}this\.hasContents \|\| this\.hasAnnotation \|\| this\.hasBookNotes/);
    assert.strictEqual((readerSource.match(/data-testid="reader-notes-link"/g) || []).length, 2);
    assert.strictEqual((readerSource.match(/'reader-note-return'/g) || []).length, 1);
    assert.match(readerSource, /v-if="\(hasAnnotation \|\| hasBookNotes\) && displayContents\.length"/);
    assert.match(readerSource, /bookNotes: '\\u041f\\u0440\\u0438\\u043c\\u0435\\u0447\\u0430\\u043d\\u0438\\u044f'/);

    const firstAnnotationLink = readerSource.indexOf('@click="showReaderAnnotation"');
    const firstNotesLink = readerSource.indexOf('@click="showReaderNotes"', firstAnnotationLink);
    const firstFeatureSeparator = readerSource.indexOf('(hasAnnotation || hasBookNotes) && displayContents.length', firstNotesLink);
    assert.ok(firstAnnotationLink >= 0 && firstNotesLink > firstAnnotationLink);
    assert.ok(firstFeatureSeparator > firstNotesLink);

    const anchorMethodStart = readerSource.indexOf('    createReaderNotesAnchorId(parser) {');
    const anchorMethodEnd = readerSource.indexOf('    buildReaderHtml(parser) {', anchorMethodStart);
    assert.ok(anchorMethodStart >= 0 && anchorMethodEnd > anchorMethodStart);
    const anchorMethod = readerSource.slice(anchorMethodStart, anchorMethodEnd).trim();
    const NotesAnchor = new Function(`return class NotesAnchor {${anchorMethod}}`)();
    const anchorHelper = new NotesAnchor();
    const anchorId = anchorHelper.createReaderNotesAnchorId({
        eachDeepSelf(callback) {
            callback({type: 1, attrs: () => new Map([['id', 'reader-book-notes']])});
            callback({type: 1, attrs: () => new Map([['xml:id', 'reader-book-notes-2']])});
        },
    });
    assert.strictEqual(anchorId, 'reader-book-notes-3');

    const builderMethodStart = readerSource.indexOf('    buildReaderHtml(parser) {');
    const builderMethodEnd = readerSource.indexOf('    createFb2Parser(source = \'\') {', builderMethodStart);
    assert.ok(builderMethodStart >= 0 && builderMethodEnd > builderMethodStart);
    const builderMethod = readerSource.slice(builderMethodStart, builderMethodEnd).trim();
    const NotesBuilder = new Function(`return class NotesBuilder {${builderMethod}}`)();
    const makeBody = (name, marker) => ({
        attrs: () => ({name}),
        rawNodes: [[1, 'body', [], [marker]]],
    });
    const notesBuilder = new NotesBuilder();
    notesBuilder.extractImageMap = () => new Map();
    notesBuilder.createReaderNotesAnchorId = () => 'reader-book-notes';
    notesBuilder.escapeHtml = value => value;
    notesBuilder.renderBlockNodes = (nodes) => {
        if (nodes[0] === 'main')
            return '<p>Основной текст</p>';
        if (nodes[0] === 'note-1')
            return '<section id="note-1"><p>Первая сноска</p></section>';
        if (nodes[0] === 'note-2')
            return '<section id="note-2"><p>Вторая сноска</p></section>';
        return '';
    };
    const notesHtml = notesBuilder.buildReaderHtml({
        $$array: () => [makeBody('', 'main'), makeBody('notes', 'note-1'), makeBody(' NoTeS ', 'note-2')],
    });
    assert.strictEqual(notesBuilder.readerNotesAnchorId, 'reader-book-notes');
    assert.strictEqual((notesHtml.match(/id="reader-book-notes"/g) || []).length, 1);
    assert.match(notesHtml, /<section class="reader-notes"><h2 id="reader-book-notes">Примечания<\/h2>/);
    assert.doesNotMatch(notesHtml, /<section id="reader-book-notes" class="reader-notes">/);
    assert.strictEqual((notesHtml.match(/class="reader-notes"/g) || []).length, 2);

    const emptyNotesBuilder = new NotesBuilder();
    emptyNotesBuilder.extractImageMap = () => new Map();
    emptyNotesBuilder.createReaderNotesAnchorId = () => 'reader-book-notes';
    emptyNotesBuilder.escapeHtml = value => value;
    emptyNotesBuilder.renderBlockNodes = () => '   ';
    const emptyNotesHtml = emptyNotesBuilder.buildReaderHtml({
        $$array: () => [makeBody('notes', 'empty-note')],
    });
    assert.strictEqual(emptyNotesBuilder.readerNotesAnchorId, '');
    assert.strictEqual(emptyNotesHtml, '');

    const showNotesStart = readerSource.indexOf('    showReaderNotes() {');
    const showNotesEnd = readerSource.indexOf('    showContentsList() {', showNotesStart);
    assert.ok(showNotesStart >= 0 && showNotesEnd > showNotesStart);
    const showNotesMethod = readerSource.slice(showNotesStart, showNotesEnd).trim();
    const NotesNavigation = new Function(`return class NotesNavigation {${showNotesMethod}}`)();
    const notesNavigation = new NotesNavigation();
    const jumps = [];
    notesNavigation.hasBookNotes = true;
    notesNavigation.readerNotesAnchorId = 'reader-book-notes';
    notesNavigation.captureReaderNoteReturnPoint = () => ({pageIndex: 6, scrollTop: 240});
    notesNavigation.jumpToReaderAnchor = (id, options) => jumps.push({id, options});
    notesNavigation.showReaderNotes();
    assert.deepStrictEqual(jumps, [{
        id: 'reader-book-notes',
        options: {returnPoint: {pageIndex: 6, scrollTop: 240}},
    }]);

    assert.match(readerSource, /:class="\{'reader-back-btn--note-return': readerNoteReturnPoint\}"/);
    assert.match(readerSource, /:aria-label="readerNoteReturnPoint \? uiText\.noteReturn : uiText\.back"/);
    assert.match(readerSource, /:data-testid="readerNoteReturnPoint \? 'reader-note-return' : null"/);
    assert.match(readerSource, /:label="isCompactLayout \? '' : \(readerNoteReturnPoint \? uiText\.noteReturn : uiText\.back\)"/);
    assert.doesNotMatch(readerSource, /\{\{ readerNoteReturnPoint \? uiText\.noteReturn : uiText\.back \}\}/);
    assert.match(readerSource, /\.reader-back-btn--note-return :deep\(\.block\) \{\s*display: none;/);
    assert.doesNotMatch(readerSource, /class="reader-note-return-btn"/);
    assert.match(readerSource, /v-if="bookUid && isCompactLayout && \(showCompactStatusBar \|\| !compactChromeHidden \|\| controlsOpen\)"/);
    assert.match(readerSource, /v-if="bookUid && showDesktopStatusBar"/);

    const goBackStart = readerSource.indexOf('    goBack() {');
    const goBackEnd = readerSource.indexOf('    toggleControls() {', goBackStart);
    assert.ok(goBackStart >= 0 && goBackEnd > goBackStart);
    const goBackMethod = readerSource.slice(goBackStart, goBackEnd).trim();
    const ReaderBack = new Function(`return class ReaderBack {${goBackMethod}}`)();
    const readerBack = new ReaderBack();
    let returnedFromNote = 0;
    readerBack.readerNoteReturnPoint = {pageIndex: 6};
    readerBack.returnFromReaderNote = () => { returnedFromNote += 1; };
    readerBack.$router = {
        back() { throw new Error('router back must not run while returning from a note'); },
        push() { throw new Error('router push must not run while returning from a note'); },
    };
    readerBack.goBack();
    assert.strictEqual(returnedFromNote, 1);

    const clearRestoreStart = readerSource.indexOf('    clearPendingReaderNavigationRestore({clearNoteReturn = false} = {}) {');
    const clearRestoreEnd = readerSource.indexOf('    capturePendingReflowAnchor(', clearRestoreStart);
    assert.ok(clearRestoreStart >= 0 && clearRestoreEnd > clearRestoreStart);
    const clearRestoreMethod = readerSource.slice(clearRestoreStart, clearRestoreEnd).trim();
    const ReaderNavigationRestore = new Function(`return class ReaderNavigationRestore {${clearRestoreMethod}}`)();
    const navigationRestore = new ReaderNavigationRestore();
    navigationRestore.pendingReflowAnchor = {textSnippet: 'notes'};
    navigationRestore.stableReaderReflowAnchor = {textSnippet: 'notes'};
    navigationRestore.reflowPageStartOverride = {pageIndex: 72};
    navigationRestore.pendingReaderAnchorJump = {id: 'reader-book-notes'};
    navigationRestore.restorePending = true;
    navigationRestore.restoreFromSavedProgress = true;
    navigationRestore.restoreProgressFrame = 0;
    navigationRestore.readerNoteReturnPoint = {pageIndex: 3};
    let clearedHighlights = 0;
    navigationRestore.clearReaderReflowAnchorHighlight = () => { clearedHighlights += 1; };
    navigationRestore.clearPendingReaderNavigationRestore({clearNoteReturn: true});
    assert.strictEqual(navigationRestore.pendingReflowAnchor, null);
    assert.strictEqual(navigationRestore.stableReaderReflowAnchor, null);
    assert.strictEqual(navigationRestore.reflowPageStartOverride, null);
    assert.strictEqual(navigationRestore.pendingReaderAnchorJump, null);
    assert.strictEqual(navigationRestore.restorePending, false);
    assert.strictEqual(navigationRestore.restoreFromSavedProgress, false);
    assert.strictEqual(navigationRestore.restoreProgressFrame, 0);
    assert.strictEqual(navigationRestore.readerNoteReturnPoint, null);
    assert.strictEqual(clearedHighlights, 1);
    navigationRestore.readerNoteReturnPoint = {pageIndex: 4};
    navigationRestore.clearPendingReaderNavigationRestore();
    assert.deepStrictEqual(navigationRestore.readerNoteReturnPoint, {pageIndex: 4});

    assert.match(readerSource, /jumpToContent\(id = ''\) \{\s*this\.clearPendingReaderNavigationRestore\(\{clearNoteReturn: true\}\);/);
    assert.match(readerSource, /setCurrentPagedPage\(index = 0, save = false\) \{[\s\S]{0,140}if \(save\)\s*this\.clearPendingReaderNavigationRestore\(\);/);
    assert.match(readerSource, /returnFromReaderNote\(\) \{\s*const point = this\.readerNoteReturnPoint;\s*this\.clearPendingReaderNavigationRestore\(\{clearNoteReturn: true\}\);/);
}

async function testReaderTextShadowDefaultsOff() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');
    const ReadingListStore = require('../server/core/ReadingListStore');
    const store = new ReadingListStore({dataDir: path.resolve(__dirname, '../.tmp-reader-preferences-test')});
    const defaults = store.normalizeReaderPreferences();
    const legacy = store.normalizeReaderPreferences({
        textShadow: true,
        einkProfile: {textShadow: true},
    });
    const explicit = store.normalizeReaderPreferences({
        readerPreferencesVersion: 2,
        textShadow: true,
        einkProfile: {textShadow: true},
    });

    assert.strictEqual(defaults.readerPreferencesVersion, 2);
    assert.strictEqual(defaults.textShadow, false);
    assert.strictEqual(defaults.einkProfile.textShadow, false);
    assert.strictEqual(legacy.textShadow, false);
    assert.strictEqual(legacy.einkProfile.textShadow, false);
    assert.strictEqual(explicit.textShadow, true);
    assert.strictEqual(explicit.einkProfile.textShadow, true);
    assert.match(readerSource, /const readerPreferencesVersion = 3;/);
    assert.match(readerSource, /version < 2[\s\S]{0,180}next\.textShadow = false;/);
    assert.match(readerSource, /version < 3[\s\S]{0,500}next\.contentWidthMode = 'viewport';/);
    assert.match(readerSource, /normalizeReaderSpacingPreferences\(this\.migrateReaderPreferences\(preferences\)\)/);
    assert.match(readerSource, /defaultReaderPreferences = _\.cloneDeep\(this\.preferences\);/);
}

async function testReaderPaginationResumesAcrossViewportGeometry() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');

    assert.match(readerSource, /pagedLayoutCache = new Map\(\);\s*pagedLayoutCacheLimit = 2;/);
    assert.match(readerSource, /const checkpoint = \(cachedLayout && cachedLayout\.type === 'partial'\)/);
    assert.match(readerSource, /for \(let index = startIndex; index < queue\.length; index \+= 1\)/);
    assert.match(readerSource, /storePartialLayout\(index\);\s*return false;/);
    assert.match(readerSource, /type: 'complete',\s*pages: finalPages/);
    assert.match(readerSource, /async loadReader\(\) \{[\s\S]{0,400}this\.pagedLayoutCache\.clear\(\);/);
}

async function testReaderDefersViewportRefreshAcrossScreenUnlock() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');

    assert.match(readerSource, /document\.visibilityState === 'hidden'[\s\S]{0,140}this\.suspendViewportRefreshForVisibility\(\);/);
    assert.match(readerSource, /document\.visibilityState === 'visible'[\s\S]{0,140}this\.resumeViewportRefreshAfterVisibility\(\);/);
    assert.match(readerSource, /resumeViewportRefreshAfterVisibility\(\) \{[\s\S]{0,500}this\.viewportResumeGuardUntil = Date\.now\(\) \+ 520;/);
    assert.match(readerSource, /deferViewportRefreshForVisibility\(calibrate = true\)[\s\S]{0,700}Date\.now\(\) \+ 220/);
    assert.match(readerSource, /scheduleViewportRefresh\(\{calibrate = true\} = \{\}\) \{[\s\S]{0,180}this\.deferViewportRefreshForVisibility\(calibrate\)/);
    assert.match(readerSource, /await this\.waitForStablePagedStage\(\);\s*if \(this\.deferViewportRefreshForVisibility\(true\)\)/);
}

async function testReaderCancelsStaleCompactChromePagination() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');

    assert.match(readerSource, /compactChromeTransitionId = 0;/);
    assert.match(readerSource, /const transitionId = \+\+this\.compactChromeTransitionId;/);
    assert.match(readerSource, /if \(this\.pagedBuildInProgress\)\s*this\.pagedBuildNeedsRefresh = true;/);
    assert.match(readerSource, /await this\.afterLayoutRefreshPaint\(\);\s*if \(transitionId !== this\.compactChromeTransitionId\)\s*return;/);
    assert.match(readerSource, /if \(this\.pagedBuildInProgress\)\s*await this\.waitForPagedBuildIdle\(2400\);/);
    assert.match(readerSource, /requestAnimationFrame\(\(\) => \{\s*if \(transitionId !== this\.compactChromeTransitionId\)/);
}

async function testReaderHomeFieldsIgnoreGlobalDarkTheme() {
    const readerSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');

    assert.match(
        readerSource,
        /\.reader-page \.reader-home-search :deep\(\.q-field__control\),\s*\.reader-page \.reader-home-sort :deep\(\.q-field__control\) \{[\s\S]{0,180}background: var\(--reader-surface\);/
    );
    assert.match(readerSource, /\.reader-toolbar,\s*\.reader-home \{\s*text-shadow: none !important;/);
}

async function testReaderImageDataUrlsAreValidated() {
    const readerContent = require('../server/core/fb2/ReaderContent');
    assert.strictEqual(
        readerContent.createReaderImageDataUrl('image/png', ' iVBORw0KGgo=\n'),
        'data:image/png;base64,iVBORw0KGgo='
    );
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AQI'), 'data:image/png;base64,AQI');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/svg+xml', 'AAAA'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png\" onerror=\"alert(1)', 'AAAA'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AAAA\" onerror=\"alert(1)'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'A'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AAAA==='), '');
}

async function testAppCacheRecoveryBootstrapAndRoute() {
    const mainSource = (await fs.readFile(path.resolve(__dirname, '../client/main.js'), 'utf8'))
        .replace(/\r\n/g, '\n');
    const bootstrapStart = mainSource.indexOf('async function bootstrapApplication()');
    const bootstrapEnd = mainSource.indexOf('\n}\n\nbootstrapApplication()', bootstrapStart);
    assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
    const bootstrapSource = mainSource.slice(bootstrapStart, bootstrapEnd);
    const resetIndex = bootstrapSource.indexOf('await handleRequestedCacheReset()');
    const buildIndex = bootstrapSource.indexOf('await ensureCurrentAppBuild()');
    const mountIndex = bootstrapSource.indexOf('mountApplication()');
    assert.ok(resetIndex >= 0 && resetIndex < buildIndex);
    assert.ok(buildIndex < mountIndex);
    assert.match(mainSource, /Promise\.allSettled\(\[\s*clearKnownAppCaches\(\),\s*unregisterScopedServiceWorkers\(\)/);
    assert.match(mainSource, /const appReloadMaxAttempts = 3;/);
    assert.doesNotMatch(mainSource, /searchParams\.get\('appBuild'\) === deployedBuildId/);

    await withTempDir(async(dir) => {
        const publicDir = path.join(dir, 'public');
        const bookDir = path.join(dir, 'book');
        await fs.ensureDir(publicDir);
        await fs.ensureDir(bookDir);

        await withStaticServer({
            rootPathStatic: '/shelf',
            bookPathStatic: '/shelf/book',
            bookDir,
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir,
            tempDir: path.join(dir, 'tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            const response = await request(
                server,
                '/shelf/app-reset?return=https%3A%2F%2Fevil.example%2F%3Cscript%3E'
            );
            assert.strictEqual(response.status, 200);
            assert.match(response.headers['cache-control'] || '', /no-store/);
            assert.strictEqual(response.headers.pragma, 'no-cache');
            assert.match(response.headers['content-type'] || '', /text\/html/);

            const body = response.body.toString('utf8');
            assert.match(body, /const BASE_PATH = "\/shelf\/";/);
            assert.match(body, /Promise\.allSettled/);
            assert.match(body, /key\.startsWith\('inpx-web-'\)/);
            assert.match(body, /registration\.scope === currentScope/);
            assert.match(body, /target\.origin !== window\.location\.origin/);
            assert.match(body, /Настройки читалки, прогресс и закладки сохраняются/);
            assert.doesNotMatch(body, /evil\.example|<script><\/script>/);
            assert.doesNotMatch(body, /localStorage|sessionStorage\.clear|inpx\.reader\./);

            const outsideBase = await request(server, '/app-reset');
            assert.strictEqual(outsideBase.status, 404);
        });

        await withStaticServer({
            rootPathStatic: '/',
            bookPathStatic: '/book',
            bookDir,
            publicFilesDir: path.join(dir, 'root-public-files'),
            publicDir,
            tempDir: path.join(dir, 'root-tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            const response = await request(server, '/app-reset');
            assert.strictEqual(response.status, 200);
            assert.match(response.headers['cache-control'] || '', /no-store/);
            assert.match(response.body.toString('utf8'), /const BASE_PATH = "\/";/);
        });
    });
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

        // A full admin restore is authoritative: it must be able to replace a
        // newer local reset generation with the progress stored in the backup.
        await restoreWorker.readingListStore.save({
            version: 5,
            users: [{
                id: 'reader',
                name: 'Reader before restore',
                readerProgress: {
                    'book:stale': {
                        percent: 0.9,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            }],
            lists: [],
        });
        const preRestoreReset = await restoreWorker.readingListStore.clearReaderProgress('reader');
        assert.strictEqual(preRestoreReset.generation, 1);

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
        assert.strictEqual(restoredReader.readerProgressGeneration, 2);
        assert.strictEqual(restoredReader.readerProgress['book:1'].percent, 0.5);
        assert.strictEqual(restoredReader.readerProgress['book:1'].generation, 2);
        assert.strictEqual(restoredReader.readerBookmarks['book:1'][0].id, 'bookmark-1');

        const staleAfterRestore = await restoreWorker.readingListStore.updateReaderProgress('reader', 'book:1', {
            percent: 0.99,
            updatedAt: '2030-01-01T00:00:00.000Z',
            generation: 1,
        });
        assert.strictEqual(staleAfterRestore.generationMismatch, true);
        assert.strictEqual(staleAfterRestore.percent, 0.5);
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

async function testReaderProgressResetAndHiddenState() {
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
                id: 'reader-reset',
                name: 'Reader Reset',
                readerProgress: {
                    'book:hidden': {
                        percent: 0.2,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        hidden: true,
                    },
                    'book:visible': {
                        percent: 0.6,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        hidden: false,
                    },
                },
                readerBookmarks: {
                    'book:hidden': [{id: 'bookmark-reset', title: 'Keep me'}],
                },
            }],
            lists: [],
        });

        const hidden = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.4,
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
        assert.strictEqual(hidden.hidden, true);

        const staleSnapshot = await store.load();
        const reset = await store.clearReaderProgress('reader-reset');
        assert.strictEqual(reset.success, true);
        assert.strictEqual(reset.count, 2);
        assert.strictEqual(reset.generation, 1);
        assert.deepStrictEqual(reset.bookUids.sort(), ['book:hidden', 'book:visible']);
        assert.ok(Number.isFinite(Date.parse(reset.resetAt)));

        await store.save(staleSnapshot);

        let data = await store.load();
        let user = data.users.find(item => item.id === 'reader-reset');
        assert.deepStrictEqual(user.readerProgress, {});
        assert.strictEqual(user.readerProgressGeneration, reset.generation);
        assert.strictEqual(user.readerProgressResetAt, reset.resetAt);
        assert.strictEqual(user.readerBookmarks['book:hidden'][0].id, 'bookmark-reset');

        const stale = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.9,
            updatedAt: '2026-01-03T00:00:00.000Z',
        });
        assert.strictEqual(stale.reset, true);
        assert.strictEqual(stale.generation, reset.generation);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.deepStrictEqual(user.readerProgress, {});

        // A valid reset generation must not depend on synchronized client/server clocks.
        const freshUpdatedAt = '2001-01-01T00:00:00.000Z';
        const fresh = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.1,
            updatedAt: freshUpdatedAt,
            generation: reset.generation,
        });
        assert.strictEqual(fresh.percent, 0.1);
        assert.strictEqual(fresh.hidden, false);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:hidden'].updatedAt, freshUpdatedAt);

        const explicitlyHidden = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            hidden: true,
            percent: 0.1,
        });
        assert.strictEqual(explicitlyHidden.hidden, true);

        await Promise.all([
            store.updateReaderProgress('reader-reset', 'book:parallel-a', {
                percent: 0.2,
                updatedAt: '2002-01-01T00:00:00.000Z',
                generation: reset.generation,
            }),
            store.updateReaderProgress('reader-reset', 'book:parallel-b', {
                percent: 0.3,
                updatedAt: '2003-01-01T00:00:00.000Z',
                generation: reset.generation,
            }),
        ]);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:parallel-a'].percent, 0.2);
        assert.strictEqual(user.readerProgress['book:parallel-b'].percent, 0.3);

        await store.setBooksRead('reader-reset', ['book:read'], true);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:read'].generation, reset.generation);
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

async function testCacheRotationUsesTargetWatermark() {
    await withTempDir(async(dir) => {
        const cacheDir = path.join(dir, 'cache');
        await fs.ensureDir(cacheDir);

        const now = Date.now();
        const files = ['oldest.bin', 'old.bin', 'new.bin', 'newest.bin'];
        for (let i = 0; i < files.length; i++) {
            const filePath = path.join(cacheDir, files[i]);
            await fs.writeFile(filePath, Buffer.alloc(400, i));
            const time = new Date(now - ((files.length - i) * 60000));
            await fs.utimes(filePath, time, time);
        }

        const worker = makeWorker();
        const cleaned = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetSize: null,
            targetRatio: 0.5,
        });

        assert.strictEqual(cleaned.size, 1600);
        assert.strictEqual(cleaned.targetSize, 500);
        assert.strictEqual(cleaned.removed, 3);
        assert.strictEqual(cleaned.after, 400);
        assert.deepStrictEqual((await fs.readdir(cacheDir)).sort(), ['newest.bin']);

        await fs.emptyDir(cacheDir);
        await fs.writeFile(path.join(cacheDir, 'old.bin'), Buffer.alloc(400));
        await fs.writeFile(path.join(cacheDir, 'new.bin'), Buffer.alloc(400));

        const passive = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetRatio: 0.5,
        });
        assert.strictEqual(passive.removed, 0);

        const forced = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetRatio: 0.5,
            forceTarget: true,
        });
        assert.strictEqual(forced.removed, 1);
    });
}

async function testCacheRotationAlignsToServerClock() {
    const worker = makeWorker({
        cacheCleanSchedule: '0 0 * * *',
    });
    const morning = new Date(2026, 0, 2, 10, 15, 30, 0);
    const nextMidnight = new Date(2026, 0, 3, 0, 0, 0, 0);
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(morning), nextMidnight.getTime() - morning.getTime());

    worker.config.cacheCleanSchedule = '0 11 * * *';
    const nextHour = new Date(2026, 0, 2, 11, 0, 0, 0);
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(morning), nextHour.getTime() - morning.getTime());
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(new Date(2026, 0, 2, 11, 0, 0, 0)), 0);

    worker.config.cacheCleanSchedule = '*/15 10-11 * * 1-5';
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(new Date(2026, 0, 2, 10, 10, 0, 0)), 5*60*1000);
    assert.throws(() => worker.normalizeAdminCachePatch({cacheCleanSchedule: 'bad cron'}), /cron/);
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

async function testDiscoveryNewestAvoidsUnboundedFallback() {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    worker.discoveryCache = new Map();
    worker.checkMyState = () => {};
    worker.getDiscoveryConfigForRequest = async() => ({
        enabled: true,
        shelfLimit: 8,
        externalSource: 'none',
    });
    worker.dbConfig = async() => ({inpxHash: 'test-hash'});
    worker.buildDiscoveryPopularityMap = async() => ({});
    worker.getPersonalDiscoveryShelvesV2 = async() => [];
    const newestWindows = [];
    worker.buildLocalDiscoveryShelfV2 = async(kind, limit, options = {}) => {
        if (kind === 'newest')
            newestWindows.push(parseInt(options.daysWindow, 10) || 0);
        return null;
    };

    const result = await worker.getDiscoveryShelvesV2({newestLimit: 8, popularLimit: 8});
    assert.deepStrictEqual(newestWindows, [7, 30, 90, 180, 365]);
    assert.deepStrictEqual(result.shelves.map(shelf => shelf.id), ['newest-0d']);
    assert.deepStrictEqual(result.shelves[0].items, []);
}

async function testDiscoveryFeedbackAndEventsPersist() {
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({
            dataDir: dir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });
        await store.save({
            version: 5,
            users: [
                {id: 'reader-feedback', name: 'Reader'},
                {id: 'reader-dismiss', name: 'Reader Dismiss'},
            ],
            lists: [],
        });

        let preferences = await store.updateDiscoveryPreferences('reader-feedback', {
            taste: {
                genres: ['sf_fantasy'],
                authors: ['Favorite Author'],
                languages: ['ru'],
                explorationRatio: 0.25,
                completedAt: '2026-07-13T00:00:00.000Z',
            },
            feedbackSet: [
                {bookUid: 'book:liked', kind: 'more_like_this', shelfId: 'similar-books'},
                {bookUid: 'book:author', kind: 'dislike_author', shelfId: 'similar-books'},
                {bookUid: 'book:read', kind: 'already_read', shelfId: 'similar-books'},
                {bookUid: 'book:ignored-taste', kind: 'ignore_for_taste', shelfId: 'similar-books'},
            ],
        });
        assert.strictEqual(preferences.feedback['book:liked'].kind, 'more_like_this');
        assert.ok(!preferences.hiddenBooks.includes('book:liked'));
        assert.ok(preferences.hiddenBooks.includes('book:author'));
        assert.ok(preferences.hiddenBooks.includes('book:read'));
        assert.strictEqual(preferences.feedback['book:ignored-taste'].kind, 'ignore_for_taste');
        assert.ok(!preferences.hiddenBooks.includes('book:ignored-taste'));
        assert.deepStrictEqual(preferences.taste.genres, ['sf_fantasy']);
        assert.deepStrictEqual(preferences.taste.authors, ['Favorite Author']);
        assert.strictEqual(preferences.taste.explorationRatio, 0.25);

        await store.recordDiscoveryEvents('reader-feedback', [
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
        ]);
        await store.recordDiscoveryEvents('reader-feedback', [
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
            {bookUid: 'book:candidate', type: 'open', shelfId: 'similar-books'},
        ]);
        const exported = await store.exportData('reader-feedback');
        const event = exported.user.discoveryPreferences.events['book:candidate'];
        assert.strictEqual(event.impressionCount, 2);
        assert.strictEqual(event.openCount, 1);
        assert.ok(event.lastShownAt);
        assert.ok(event.lastOpenedAt);
        const metrics = await store.getDiscoveryMetrics();
        assert.strictEqual(metrics.totals.impression, 2);
        assert.strictEqual(metrics.totals.open, 1);
        assert.strictEqual(metrics.totals.feedback, 4);
        assert.strictEqual(metrics.totals.ignore_for_taste, 1);
        assert.strictEqual(metrics.shelves['similar-books'].impression, 2);
        assert.strictEqual(metrics.rates.ctr, 0.5);
        assert.strictEqual(metrics.configuredProfiles, 1);

        preferences = await store.updateDiscoveryPreferences('reader-feedback', {
            hiddenBooksRemove: ['book:author'],
            feedbackRemove: ['book:author'],
        });
        assert.ok(!preferences.hiddenBooks.includes('book:author'));
        assert.strictEqual(preferences.feedback['book:author'], undefined);

        const dismissedPreferences = await store.updateDiscoveryPreferences('reader-dismiss', {
            tastePromptDismissedAt: '2026-07-14T00:00:00.000Z',
        });
        assert.strictEqual(dismissedPreferences.taste.completedAt, '');
        assert.strictEqual(dismissedPreferences.taste.promptDismissedAt, '2026-07-14T00:00:00.000Z');
    });
}

async function testPersonalDiscoveryUsesColdStartTaste() {
    const worker = makeWorker();
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    worker.getBookRecordByUid = async() => null;

    const profile = await worker.buildPersonalDiscoveryTasteProfile({
        id: 'cold-reader',
        discoveryPreferences: {
            taste: {
                genres: ['sf_fantasy'],
                authors: ['Favorite Author'],
                languages: ['ru'],
                explorationRatio: 0.25,
                completedAt: '2026-07-13T00:00:00.000Z',
            },
        },
        readerProgress: {},
    }, {lists: []});

    assert.strictEqual(profile.signalCount, 0);
    assert.ok(profile.authorWeights.get('favorite author') > 0);
    assert.ok(profile.genreWeights.get('sf_fantasy') > 0);
    assert.ok(profile.explicitTasteAuthors.has('favorite author'));
    assert.strictEqual(profile.taste.explorationRatio, 0.25);

    const preferredScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'preferred', author: 'Favorite Author', genre: 'sf_fantasy', lang: 'ru', title: 'Preferred',
    }, profile, 5);
    const unrelatedScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'unrelated', author: 'Other Author', genre: 'history', lang: 'en', title: 'Unrelated',
    }, profile, 5);
    assert.ok(preferredScore > 0);
    assert.strictEqual(unrelatedScore, 0);
    assert.ok(worker.scorePersonalDiscoveryExplorationCandidate({
        _uid: 'explore', author: 'New Author', genre: 'history', lang: 'ru', title: 'Explore', librate: 5,
    }, profile, 5) > 0);

    assert.strictEqual(
        worker.getPersonalDiscoveryGenreReason(['love_erotica'], profile),
        'Учитывает ваши читательские интересы'
    );
    assert.strictEqual(
        worker.getPersonalDiscoveryGenreReason(['sf_fantasy'], profile),
        'Вы выбрали жанр: sf_fantasy'
    );

    const popular = worker.decorateDiscoveryBook({librate: 4}, {
        mode: 'popular',
        popularityInfo: {progressCount: 2, listCount: 1, finishedCount: 3},
    });
    assert.strictEqual(popular.discoveryReason, 'Популярно у читателей · Оценка библиотеки 4/5');
    assert.ok(!/В списках|В чтении|Прочитано/.test(popular.discoveryReason));
}

async function testPersonalDiscoveryUsesEngagementTopicsAndDismissals() {
    const worker = makeWorker();
    const books = {
        glance: {
            _uid: 'glance', author: 'Glance Author', genre: 'detective', keywords: 'crime', lang: 'ru',
        },
        favorite: {
            _uid: 'favorite', author: 'Favorite Author', genre: 'sf_fantasy', keywords: 'dragons, magic', lang: 'ru',
        },
        dismissed: {
            _uid: 'dismissed', author: 'Dismissed Author', genre: 'sf_horror', keywords: 'grim', lang: 'ru',
        },
        ignored: {
            _uid: 'ignored', author: 'Ignored Author', genre: 'history', keywords: 'rome', lang: 'ru',
        },
    };
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    worker.getBookRecordByUid = async bookUid => books[bookUid] || null;

    const profile = await worker.buildPersonalDiscoveryTasteProfile({
        id: 'reader',
        discoveryPreferences: {
            hiddenBooks: ['dismissed'],
            feedback: {
                ignored: {kind: 'ignore_for_taste', updatedAt: '2024-01-03T00:00:00.000Z'},
            },
        },
        readerProgress: {
            glance: {percent: 0.01, updatedAt: '2024-01-01T00:00:00.000Z'},
            favorite: {percent: 1, updatedAt: '2024-01-02T00:00:00.000Z'},
            ignored: {percent: 1, updatedAt: '2024-01-03T00:00:00.000Z'},
        },
    }, {lists: []});

    assert.strictEqual(profile.authorWeights.has('glance author'), false);
    assert.ok(profile.authorWeights.get('favorite author') > 0);
    assert.ok(profile.keywordWeights.get('dragons') > 0);
    assert.ok(profile.keywordWeights.get('magic') > 0);
    assert.ok(profile.rejectedAuthorWeights.get('dismissed author') > 0);
    assert.ok(profile.knownBookUids.has('glance'));
    assert.ok(profile.knownBookUids.has('ignored'));
    assert.strictEqual(profile.authorWeights.has('ignored author'), false);
    assert.strictEqual(profile.genreWeights.has('history'), false);
    assert.strictEqual(profile.rejectedAuthorWeights.has('ignored author'), false);

    const topicalScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7);
    const unrelatedScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'unrelated', author: 'Another Author', genre: 'history', keywords: 'rome', lang: 'ru',
    }, profile, 7);
    const dismissedAuthorScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'dismissed-author', author: 'Dismissed Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7);

    assert.ok(topicalScore > unrelatedScore);
    assert.ok(dismissedAuthorScore < topicalScore);

    profile.discoveryEvents.topic = {
        impressionCount: 3,
        openCount: 0,
        lastShownAt: new Date().toISOString(),
    };
    assert.strictEqual(worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7), 0);
    profile.discoveryEvents.topic.openCount = 1;
    assert.ok(worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7) > 0);
}

async function testPersonalDiscoveryDiversifiesAuthorsAndSeries() {
    const worker = makeWorker();
    const {JembaDb} = require('jembadb');
    const favorite = {
        _uid: 'favorite', author: 'Favorite Author', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru',
    };
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    worker.getBookRecordByUid = async bookUid => (bookUid === 'favorite' ? favorite : null);

    const user = {
        id: 'reader',
        discoveryPreferences: {hiddenBooks: []},
        readerProgress: {
            favorite: {percent: 1, updatedAt: '2024-01-02T00:00:00.000Z'},
        },
    };
    await withTempDir(async dir => {
        const db = new JembaDb();
        const dbPath = path.join(dir, 'db');
        await fs.ensureDir(dbPath);
        await db.lock({dbPath});
        try {
            await db.create({table: 'book'});
            await db.insert({table: 'book', rows: [
                {_uid: 'same-1', title: 'Same 1', author: 'Favorite Author', series: 'Saga A', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-2', title: 'Same 2', author: 'Favorite Author', series: 'Saga B', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-3', title: 'Same 3', author: 'Favorite Author', series: 'Saga C', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'new-author', title: 'New Author', author: 'Different Author', series: '', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-series', title: 'Same Series', author: 'Third Author', series: 'Saga A', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'explore-1', title: 'Explore History', author: 'History Author', series: '', genre: 'history', keywords: 'rome', lang: 'ru', librate: 5},
                {_uid: 'explore-2', title: 'Explore Detective', author: 'Detective Author', series: '', genre: 'detective', keywords: 'crime', lang: 'ru', librate: 4},
            ]});
            worker.db = db;
            const shelf = await worker.buildSimilarBooksShelfV2(user, 4, {
                lists: [],
                progressMap: user.readerProgress,
                readBookUids: new Set(['favorite']),
            });
            const favoriteAuthorCount = shelf.items.filter(book => book.author === 'Favorite Author').length;
            const sagaACount = shelf.items.filter(book => book.series === 'Saga A').length;

            assert.ok(shelf.items.some(book => book.author !== 'Favorite Author'));
            assert.ok(shelf.items.some(book => book.discoveryExploration === true));
            assert.ok(shelf.items.find(book => book.discoveryExploration === true).discoveryReason.includes('нового'));
            assert.strictEqual(shelf.discoveryNeedsTasteSetup, true);
            assert.ok(favoriteAuthorCount <= 2);
            assert.ok(sagaACount <= 1);

            user.discoveryPreferences.taste = {promptDismissedAt: '2026-07-14T00:00:00.000Z'};
            const dismissedShelf = await worker.buildSimilarBooksShelfV2(user, 4, {
                lists: [],
                progressMap: user.readerProgress,
                readBookUids: new Set(['favorite']),
            });
            assert.strictEqual(dismissedShelf.discoveryNeedsTasteSetup, false);
        } finally {
            await db.unlock();
        }
    });
}

const tests = [
    testConfigSecretsSurviveRestart,
    testAppCacheRecoveryBootstrapAndRoute,
    testTitleSearchKeepsIndexedPrefixFallbacks,
    testFb2ContentsExcludeNotesBodies,
    testReaderAnnotationStaysOutsideReadingFlow,
    testReaderBookNotesMenuAndReturnLayout,
    testReaderTextShadowDefaultsOff,
    testReaderPaginationResumesAcrossViewportGeometry,
    testReaderDefersViewportRefreshAcrossScreenUnlock,
    testReaderCancelsStaleCompactChromePagination,
    testReaderHomeFieldsIgnoreGlobalDarkTheme,
    testReaderImageDataUrlsAreValidated,
    testConvertedBookFileNames,
    testFb2cngConfigAndConversionCache,
    testAdminSettingsRestoreKeepsSecrets,
    testAdminBackupArchiveAndDownload,
    testUserBackupExportsAndRestoresReaderState,
    testReaderProgressResetAndHiddenState,
    testDiscoveryFeedbackAndEventsPersist,
    testCoverCacheRoutesAndCleaner,
    testCacheRotationUsesTargetWatermark,
    testCacheRotationAlignsToServerClock,
    testExternalDiscoveryMultiSourceSearch,
    testExternalDiscoverySingleFetch,
    testConfiguredConverterPathsHavePriority,
    testDiscoveryNewestAvoidsUnboundedFallback,
    testPersonalDiscoveryUsesColdStartTaste,
    testPersonalDiscoveryUsesEngagementTopicsAndDismissals,
    testPersonalDiscoveryDiversifiesAuthorsAndSeries,
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
