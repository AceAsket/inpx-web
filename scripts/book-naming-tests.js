const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const naming = require('../server/core/BookNaming');
const ZipReader = require('../server/core/ZipReader');

async function fixture(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-book-naming-'));
    try { await fn(dir); } finally { await fs.remove(dir); }
}

async function testBookNamingConditionalTemplatesAndSafeFilenames() {
    const book = {title:'Доктор Гарин', author:'Сорокин Владимир', series:'Доктор Гарин', serno:2, ext:'fb2'};
    const config = {bookFilenameTemplate:'[${NUMBER_PADDED} - ]${TITLE}', bookTitleTemplate:'[${NUMBER_PADDED} - ]${TITLE}'};
    assert.strictEqual(naming.filename(book, 'old.fb2', 'fb2', config), '02 - Доктор Гарин.fb2');
    assert.strictEqual(naming.title(book, 'epub', config), '02 - Доктор Гарин');
    assert.strictEqual(naming.title({...book, serno:0}, 'epub', config), 'Доктор Гарин');
    assert.strictEqual(naming.title({...book, serno:2.5}, 'epub', config), '02.5 - Доктор Гарин');
    assert.strictEqual(naming.render('${AUTHOR} / ${SERIES} / ${NUMBER} / ${EXT}', book, 'kepub.epub'), 'Сорокин Владимир / Доктор Гарин / 2 / kepub.epub');
    assert.strictEqual(naming.filename(book, 'old.fb2', 'fb2', {}), 'old.fb2');
    assert.strictEqual(naming.title(book, 'epub', {}), null);
    assert.strictEqual(naming.filename(book, 'old.epub', 'epub', {bookFilenameTemplate:'${TITLE}.${EXT}'}), 'Доктор Гарин.epub');
    assert.strictEqual(naming.filename({title:'../CON'}, 'old.fb2', 'fb2', {bookFilenameTemplate:'${TITLE}'}), '_CON.fb2');
    assert.strictEqual(naming.filename({title:'..'}, 'old.fb2', 'fb2', {bookFilenameTemplate:'${TITLE}'}), 'old.fb2');
    assert.ok(Buffer.byteLength(naming.filename({title:'Я'.repeat(300)}, 'old.epub', 'epub', {bookFilenameTemplate:'${TITLE}'})) <= 205);
    assert.strictEqual(naming.render('[${NUMBER} ]${TITLE}', {...book, title:'${AUTHOR} {{ test }}'}), '2 ${AUTHOR} {{ test }}');
    assert.throws(() => naming.render('[${UNKNOWN}]${TITLE}', {...book, serno:0}), /Неизвестное поле/);
    const basePath = require.resolve('../server/config/base');
    const names = ['INPX_BOOK_FILENAME_TEMPLATE', 'INPX_BOOK_TITLE_TEMPLATE'];
    const previous = names.map(name => process.env[name]);
    try {
        process.env[names[0]] = config.bookFilenameTemplate;
        process.env[names[1]] = config.bookTitleTemplate;
        delete require.cache[basePath];
        const base = require(basePath);
        assert.strictEqual(base.bookFilenameTemplate, config.bookFilenameTemplate);
        assert.strictEqual(base.bookTitleTemplate, config.bookTitleTemplate);
        assert.ok(!require('../server/config').propsToSave.includes('bookTitleTemplate'), 'Launch settings must not be saved to config.json');
    } finally {
        names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
        delete require.cache[basePath]; require(basePath);
    }
}

async function testBookTitleOverrideKeepsConfigAndSeparatesConversionCache() {
    await fixture(async dir => {
        const Module = require('module'), yaml = require('js-yaml');
        const filename = require.resolve('../server/core/BookConverter');
        const nativeRequire = Module.createRequire(filename);
        const isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
        const css = path.join(dir, 'style.css'), configPath = path.join(dir, 'config.yaml');
        await fs.writeFile(css, 'body {color:black;}');
        const originalConfig = 'document:\n  stylesheet_path: style.css\n  metainformation:\n    creator_name_template: "{{ .FirstName }}"\n';
        await fs.writeFile(configPath, originalConfig);
        let effectiveFile;
        isolated.require = name => name === './ConversionRuntime' ? {
            ConversionRuntime: require('../server/core/ConversionRuntime').ConversionRuntime,
            runProcess: async(command, args, processOptions) => {
                assert.strictEqual(processOptions.cwd, dir, 'Keep relative CSS/font paths based at original config directory');
                if (args.includes('dumpconfig')) {
                    if (args.length === 4) await fs.writeFile(args[3], yaml.dump({document:{stylesheet_path:'style.css', metainformation:{creator_name_template:'{{ .FirstName }}'}}}));
                    return;
                }
                effectiveFile = args[1];
                const data = yaml.load(await fs.readFile(effectiveFile, 'utf8'));
                assert.strictEqual(data.document.stylesheet_path, 'style.css');
                assert.strictEqual(data.document.metainformation.creator_name_template, '{{ .FirstName }}');
                assert.strictEqual(data.document.metainformation.title_template, '{{ "02 - Название {{literal}}" }}');
                await fs.outputFile(path.join(args.at(-1), 'result.epub'), 'converted');
            },
        } : nativeRequire(name);
        isolated._compile(await fs.readFile(filename, 'utf8'), filename);
        const inputFile = path.join(dir, 'source.fb2'); await fs.writeFile(inputFile, 'original');
        const options = {inputFile, cacheBasePath:path.join(dir,'cache'), sourceFileName:'source.fb2', downFileName:'old.fb2', format:'epub',
            book:{title:'Название {{literal}}',serno:2}, config:{conversionEnabled:true, fb2cngConfigPath:configPath,
                bookTitleTemplate:'[${NUMBER_PADDED} - ]${TITLE}', bookFilenameTemplate:'${TITLE}'}};
        const plain = await isolated.exports.getConversionCacheInfo({...options, config:{...options.config, bookTitleTemplate:''}});
        const changed = await isolated.exports.getConversionCacheInfo(options);
        assert.notStrictEqual(changed.filePath, plain.filePath);
        assert.notStrictEqual(changed.filePath, (await isolated.exports.getConversionCacheInfo({...options, book:{...options.book,serno:3}})).filePath);
        const named = await isolated.exports.getConversionCacheInfo({...options, config:{...options.config, bookFilenameTemplate:'${AUTHOR}'}});
        assert.strictEqual(named.filePath, changed.filePath, 'Download naming must not regenerate identical book bytes');
        const prepared = await isolated.exports.prepareConvertedFile(options);
        assert.strictEqual(prepared.downloadName, 'Название {{literal}}.epub');
        assert.strictEqual(await fs.pathExists(effectiveFile), false);
        assert.strictEqual(await fs.readFile(configPath, 'utf8'), originalConfig);
        assert.strictEqual(await fs.readFile(inputFile, 'utf8'), 'original');
    });
}

async function testBookNamingAppliesToLegacyCacheAndSharedHttpDownloads() {
    await fixture(async dir => {
        const bookDir = path.join(dir,'book'); await fs.ensureDir(bookDir);
        const hash = 'abcdef1234567890';
        const records = [{id:1,_uid:'one',author:'Автор Один',title:'Название',series:'Серия',serno:2,ext:'fb2',file:'1',folder:''},
            {id:2,_uid:'two',author:'Автор Два',title:'Вторая',serno:3,ext:'fb2',file:'2',folder:''}];
        const source = Buffer.from('<FictionBook><body><section><p>Original source</p></section></body></FictionBook>');
        const utils = require('../server/core/utils');
        await fs.writeFile(path.join(bookDir,hash), await utils.gzipBuffer(source));
        await fs.writeJson(path.join(bookDir,hash+'.d.json'), {assetVersion:'fb2-encoding-v6',downFileName:'old.fb2',size:source.length});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        const config = {bookDir,bookPathStatic:'/book',rootPathStatic:'',publicFilesDir:dir,publicDir:dir,libDir:dir,
            bookFilenameTemplate:'[${NUMBER_PADDED} - ]${TITLE}'};
        worker.config = config; worker.checkMyState = () => {};
        worker.db = {esc:JSON.stringify, select:async({table,where}) => {
            const uid = where.includes('"two"') ? 'two' : 'one';
            return table === 'file_hash' ? [{id:uid,hash}] : [records.find(row => row._uid === uid)];
        }};
        const app = require('express')(); require('../server/static')(app, config, worker);
        const server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            for (const [uid,name] of [['one','02 - Название.fb2'],['two','03 - Вторая.fb2']]) {
                const response = await fetch(`${base}/book/by-uid?uid=${uid}&format=raw`);
                assert.strictEqual(response.status,200);
                assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(name)));
                assert.ok(Buffer.from(await response.arrayBuffer()).equals(source));
            }
            let archiveIndex = 0;
            const assertZipName = async expected => {
                const response = await fetch(`${base}/book/by-uid?uid=one&zip=1`);
                const file = path.join(dir,`zip-${archiveIndex++}.zip`); await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
                const zip = new ZipReader(); await zip.open(file);
                try { assert.deepStrictEqual(Object.keys(zip.entries),[expected]); } finally {await zip.close();}
            };
            await assertZipName('02 - Название.fb2');
            config.bookFilenameTemplate = '${TITLE}';
            await assertZipName('Название.fb2');
            const legacy = await fetch(`${base}/book/${hash}/raw`);
            assert.ok(legacy.headers.get('content-disposition').includes(encodeURIComponent('Название.fb2')));
            await fs.remove(path.join(bookDir,hash+'.d.json'));
            worker.restoreBook = async(uid,folder,file,defaultName) => {
                assert.strictEqual(defaultName, 'Автор О._Название.fb2', 'Cache descriptor must retain default name when launch template is removed');
                await fs.writeJson(path.join(bookDir,hash+'.d.json'), {bookUid:uid,assetVersion:'fb2-encoding-v6',downFileName:defaultName,size:source.length});
                return `/book/${hash}`;
            };
            assert.strictEqual((await fetch(`${base}/book/by-uid?uid=one&format=raw`)).status,200);
            config.bookFilenameTemplate = '';
            const defaultDownload = await fetch(`${base}/book/by-uid?uid=one&format=raw`);
            assert.ok(defaultDownload.headers.get('content-disposition').includes(encodeURIComponent('Автор О._Название.fb2')));
            config.bookFilenameTemplate = '${UNKNOWN}';
            assert.strictEqual((await fetch(`${base}/book/by-uid?uid=one&format=raw`)).status,500);
        } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    });
}

async function testBookNamingBatchZipKeepsDistinctNames() {
    await fixture(async dir => {
        const source = path.join(dir,'source.fb2'); await fs.writeFile(source,'source');
        const records = [{_uid:'one',title:'Название',series:'Серия',serno:2,ext:'fb2'},
            {_uid:'two',title:'Название',series:'Серия',serno:2,ext:'fb2'}, {_uid:'three',title:'Без серии',ext:'fb2'}];
        const worker = {config:{tempDir:dir,bookPathStatic:'/book',bookFilenameTemplate:'[${NUMBER_PADDED} - ]${TITLE}'},checkMyState:()=>{},
            getPreparedBookFile:async uid => ({rawFile:source,book:records.find(book => book._uid === uid)})};
        const batch = require('../server/core/BatchDownload');
        const result = await batch.create(worker,'test',{bookUids:records.map(book => book._uid)});
        const file = path.join(dir,`batch-${path.basename(result.url)}.zip`);
        const zip = new ZipReader(); await zip.open(file);
        try { assert.deepStrictEqual(Object.keys(zip.entries),['Серия/02 - Название.fb2','Серия/02 - Название_2.fb2','Вне серий/Без серии.fb2']); }
        finally {await zip.close();}
    });
}

module.exports = [testBookNamingConditionalTemplatesAndSafeFilenames, testBookTitleOverrideKeepsConfigAndSeparatesConversionCache,
    testBookNamingAppliesToLegacyCacheAndSharedHttpDownloads, testBookNamingBatchZipKeepsDistinctNames];
