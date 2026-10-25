const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {isolatedConverter} = require('./converter-options-tests');
const {validateMobi} = require('../server/core/MobiValidation');

function fixtureMobi() {
    const count = 5, first = 78 + count * 8;
    const offsets = [first, first + 300, first + 304, first + 312, first + 612];
    const data = Buffer.alloc(first + 616);
    data.write('BOOKMOBI', 60); data.writeUInt16BE(count, 76);
    offsets.forEach((offset, i) => data.writeUInt32BE(offset, 78 + i * 8));
    data.writeUInt16BE(2, first); data.writeUInt32BE(4, first + 4); data.writeUInt16BE(1, first + 8);
    data.write('MOBI', first + 16); data.writeUInt32BE(232, first + 20);
    data.writeUInt32BE(65001, first + 28); data.writeUInt32BE(6, first + 36);
    data.write('EXTH', first + 248); data.writeUInt32BE(24, first + 252); data.writeUInt32BE(1, first + 256);
    data.writeUInt32BE(121, first + 260); data.writeUInt32BE(12, first + 264); data.writeUInt32BE(3, first + 268);
    data.write('text', offsets[1]); data.write('BOUNDARY', offsets[2]);
    data.write('MOBI', offsets[3] + 16); data.writeUInt32BE(8, offsets[3] + 36);
    return data;
}

async function withFixture(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-mobi-test-'));
    try { await fn(dir); } finally { await fs.remove(dir); }
}

async function testMobiRequiresLaunchFlagAndDoesNotPersist() {
    const execFile = require('util').promisify(require('child_process').execFile);
    const script = `const assert=require('assert');const config=require('./server/config/base');
        assert.strictEqual(config.mobiEnabled,process.env.INPX_MOBI_ENABLED==='true');
        assert.strictEqual(config.conversionFormats.includes('mobi'),config.mobiEnabled);
        const saved=require('./server/config').propsToSave;
        for(const key of ['mobiEnabled','kindlingPath','kindlingVersion'])assert.ok(!saved.includes(key));`;
    for (const flag of ['true', 'false', ''])
        await execFile(process.execPath, ['-e', script], {cwd: path.resolve(__dirname, '..'),
            env: {...process.env, INPX_MOBI_ENABLED: flag, INPX_CONVERSION_FORMATS: 'epub,mobi,pdf'}});
    await withFixture(async dir => {
        const converter = await isolatedConverter(async() => { throw new Error('Must not launch when disabled'); });
        const filePath = path.join(dir, 'cached');
        const options = {inputFile: 'book.epub', sourceFileName: 'book.epub', downFileName: 'book.epub', cacheBasePath: filePath,
            format: 'mobi', config: {conversionEnabled: true}};
        const cache = await converter.getConversionCacheInfo(options);
        await fs.writeFile(cache.filePath, fixtureMobi());
        await assert.rejects(converter.prepareConvertedFile(options), /INPX_MOBI_ENABLED=true/);
        await assert.rejects(converter.convert({inputFile:'book.epub', outputFile:filePath, format:'MOBI'}), /INPX_MOBI_ENABLED=true/);
    });
}

async function testMobiPipelineUsesOneSlotAndCachesValidatedOutput() {
    await withFixture(async dir => {
        const calls = [];
        const converter = await isolatedConverter(async(command, args, options) => {
            calls.push({command, args, options});
            if (command === 'fbc-test') {
                assert.ok(args.includes('epub2'));
                await fs.outputFile(path.join(args.at(-1), 'book.epub'), 'EPUB content');
            } else {
                assert.strictEqual(command, 'kindling-test');
                assert.strictEqual(await fs.readFile(args[1], 'utf8'), 'EPUB content');
                assert.ok(args.includes('--legacy-mobi'));
                assert.ok(args.includes('--no-embed-source'));
                assert.ok(!args.includes('--no-self-check'));
                await fs.writeFile(args.at(-1), fixtureMobi());
            }
        });
        converter.configure({conversionConcurrency: 1, conversionTimeoutMs: 2000});
        const inputFile = path.join(dir, 'source');
        await fs.writeFile(inputFile, 'original FB2');
        const options = {inputFile, cacheBasePath:path.join(dir, 'cache'), sourceFileName:'book.fb2', downFileName:'book.fb2', format:'mobi',
            config:{conversionEnabled:true, mobiEnabled:true, kindlingPath:'kindling-test', converterPaths:{fb2cng:'fbc-test'}}};
        const [first, parallel] = await Promise.all([converter.prepareConvertedFile(options), converter.prepareConvertedFile(options)]);
        assert.strictEqual(first.filePath, parallel.filePath);
        assert.strictEqual(first.downloadName, 'book.mobi');
        assert.strictEqual((await converter.prepareConvertedFile(options)).created, false);
        assert.strictEqual(calls.length, 2, 'One pipeline, including simultaneous requests and repeat download');
        assert.strictEqual(await fs.pathExists(calls[1].options.cwd), false, 'Intermediate directory removed');
        assert.strictEqual(await fs.readFile(inputFile, 'utf8'), 'original FB2');
        const epub = {...options, sourceFileName:'book.epub', config:{...options.config, fb2cngConfigPath:'/missing/unused.yaml', fb2cngArgs:'unused'}};
        await fs.writeFile(inputFile, 'EPUB content');
        await converter.prepareConvertedFile(epub);
        assert.strictEqual(calls.length, 3, 'Existing EPUB must not launch fbc or read its config');
        assert.ok(!(await fs.readdir(dir)).some(name => /\.work-|\.input-|\.fb2cng$/.test(name)));
    });
}

async function testMobiCacheIncludesBothConvertersAndMetadata() {
    const converter = require('../server/core/BookConverter');
    const options = {cacheBasePath:'cache', sourceFileName:'book.fb2', format:'mobi',
        book:{title:'Книга', serno:2}, config:{mobiEnabled:true, fb2cngVersion:'v1.9.0', kindlingVersion:'v0.45.6', bookTitleTemplate:'${NUMBER_PADDED} - ${TITLE}'}};
    const original = await converter.getConversionCacheInfo(options);
    assert.strictEqual(original.bookTitle, '02 - Книга');
    for (const overrides of [{kindlingVersion:'next'}, {kindlingPath:'/other'}, {fb2cngVersion:'next'}, {fb2cngArgs:['--no-cover']}, {bookTitleTemplate:'${TITLE}'}])
        assert.notStrictEqual((await converter.getConversionCacheInfo({...options, config:{...options.config, ...overrides}})).filePath, original.filePath);
    assert.notStrictEqual((await converter.getConversionCacheInfo({...options, book:{...options.book, serno:3}})).filePath, original.filePath);
    assert.deepStrictEqual(converter.kindlingCommandCandidates('/configured path/missing'), ['/configured path/missing']);
    assert.ok(converter.canConvertSourceTo('epub', 'mobi'));
    assert.ok(!converter.canConvertSourceTo('pdf', 'mobi'));
}

async function testMobiRejectsCorruptAndAzw3OnlyResults() {
    await withFixture(async dir => {
        const file = path.join(dir, 'book.mobi');
        const good = fixtureMobi();
        await fs.writeFile(file, good); await validateMobi(file);
        const first = good.readUInt32BE(78);
        for (const mutate of [b => b.subarray(0, 70), b => {b.write('BOOKAZW3', 60); return b;},
            b => {b.writeUInt32BE(8, first + 36); return b;}, b => {b.writeUInt32BE(0xffffffff, 78); return b;},
            b => {b.writeUInt32BE(0xffffffff, first + 264); return b;}, b => {b.writeUInt32BE(99, first + 268); return b;}]) {
            await fs.writeFile(file, mutate(Buffer.from(good)));
            await assert.rejects(validateMobi(file), {code:'INPX_INVALID_MOBI'});
        }
        for (const failure of ['corrupt', 'missing', 'timeout']) {
            let intermediate;
            const converter = await isolatedConverter(async(command, args, options) => {
                intermediate = options.cwd;
                if (failure === 'missing') throw Object.assign(new Error('missing'), {code:'ENOENT'});
                await fs.writeFile(args.at(-1), 'partial');
                if (failure === 'timeout') throw Object.assign(new Error('timeout'), {code:'INPX_CONVERSION_TIMEOUT'});
            });
            const inputFile = path.join(dir, 'source.epub');
            await fs.writeFile(inputFile, 'original'); await fs.writeFile(file, good);
            await assert.rejects(converter.convert({inputFile, outputFile:file, format:'mobi', mobiEnabled:true, kindlingPath:'missing-explicit'}),
                {code: failure === 'corrupt' ? 'INPX_INVALID_MOBI' : failure === 'missing' ? 'INPX_CONVERTER_NOT_FOUND' : 'INPX_CONVERSION_TIMEOUT'});
            assert.deepStrictEqual(await fs.readFile(file), good, 'Previous completed output survives failure');
            assert.strictEqual(await fs.pathExists(intermediate), false);
            assert.ok(!(await fs.readdir(dir)).some(name => name.includes('.work-')));
        }
    });
}

async function testMobiAvailabilityInWebAndOpds() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const BookView = loadClient(path.resolve(__dirname, '../client/components/Search/BookView/BookView.vue')).default;
    const view = Object.create(BookView.prototype);
    view.$store = {state:{config:{conversionFormats:['epub', 'pdf', 'mobi']}}};
    for (const ext of ['fb2', 'epub', 'pdf']) {
        view.book = {ext};
        assert.strictEqual(view.availableConversionFormats.includes('mobi'), ext !== 'pdf');
    }
    view.book = {ext:'epub'}; view.$store.state.config.conversionFormats = ['epub', 'pdf'];
    assert.deepStrictEqual(view.availableConversionFormats, ['pdf']);
    const BookPage = require('../server/core/opds/BookPage');
    for (const ext of ['fb2', 'epub', 'mobi']) {
        for (const enabled of [true, false]) {
            const book = {_uid:'test', ext, title:'Книга', genre:'', author:'Автор'};
            const page = Object.create(BookPage.prototype);
            page.config = {conversionEnabled:true, mobiEnabled:enabled, bookPathStatic:'/book'};
            page.webWorker = {getGenreMap:async() => new Map(), getBookRecordByUid:async() => book,
                applyMetadataOverridesToSearchResult:async() => {}, getBookInfo:async() => ({bookInfo:{book, fb2:false}})};
            page.baseLinks = () => []; page.getGenres = async() => ({genreMap:new Map()});
            page.makeBody = value => value; page.downLink = value => value; page.imgLink = value => value;
            page.inpxInfo = () => []; page.htmlInfo = () => '';
            const result = await page.body({query:{uid:'test'}});
            const converted = result.entry[0].link.filter(link => link.href.includes('format=mobi'));
            assert.strictEqual(converted.length, enabled && ext !== 'mobi' ? 1 : 0);
            assert.ok(result.entry[0].link.some(link => link.href.includes('format=raw')), 'Original link remains first-class');
        }
    }
}

module.exports = [testMobiRequiresLaunchFlagAndDoesNotPersist, testMobiPipelineUsesOneSlotAndCachesValidatedOutput,
    testMobiCacheIncludesBothConvertersAndMetadata, testMobiRejectsCorruptAndAzw3OnlyResults, testMobiAvailabilityInWebAndOpds];
