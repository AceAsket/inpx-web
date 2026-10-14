const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const he = require('he');
const converter = require('../server/core/BookConverter');
const ZipReader = require('../server/core/ZipReader');

async function epubContents(file) {
    const zip = new ZipReader();
    try {
        await zip.open(file);
        const contents = {};
        for (const name of Object.keys(zip.entries)) {
            if (/\.(opf|css|xhtml)$/.test(name))
                contents[name] = (await zip.extractToBuf(name)).toString('utf8');
        }
        const opf = Object.values(contents).find(text => text.includes('<dc:title'));
        assert.ok(opf, 'EPUB must contain title metadata');
        const title = he.decode(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/)[1]);
        return {contents, opf, title};
    } finally {
        await zip.close();
    }
}

async function main() {
    const args = require('minimist')(process.argv.slice(2));
    assert.ok(args.fbc, 'Usage: node scripts/fb2cng-integration-tests.js --fbc /path/to/fbc');
    const fbc = path.resolve(args.fbc);
    const version = execFileSync(fbc, ['--version'], {encoding: 'utf8', windowsHide: true});
    assert.match(version, /version 1\.9\.0\b/);
    console.log(version.trim());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-fbc-integration-'));
    try {
        const source = path.join(dir, 'source.fb2');
        const cover = (await fs.readFile(path.join(__dirname, '../client/assets/pwa-icon-192.png'))).toString('base64');
        const original = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre><author><first-name>Иван</first-name><last-name>Иванов</last-name></author><book-title>Исходное название</book-title><coverpage><image l:href="#cover.png"/></coverpage><lang>ru</lang><sequence name="Исходная серия" number="7"/></title-info><document-info><author><nickname>Test</nickname></author><date>2026-10-15</date><id>inpx-fbc-test</id><version>1.0</version></document-info></description>
<body><section><title><p>Глава первая</p></title><p>Это текст книги для проверки настоящего конвертера.</p></section></body>
<binary id="cover.png" content-type="image/png">${cover}</binary></FictionBook>`;
        await fs.writeFile(source, original);
        const book = {title:'Доктор Гарин', author:'Иванов Иван', series:'Каталожная серия', serno:2};
        const config = {
            conversionEnabled:true, converterPaths:{fb2cng:fbc}, fb2cngVersion:'v1.9.0',
            bookFilenameTemplate:'[${NUMBER_PADDED} - ]${TITLE}',
            bookTitleTemplate:'[${NUMBER_PADDED} - ]${TITLE}',
        };
        const prepare = (format, overrides = {}, metadata = book) => converter.prepareConvertedFile({
            inputFile:source, cacheBasePath:path.join(dir, 'cached'), sourceFileName:'source.fb2',
            downFileName:'Иванов И._Исходное название.fb2', format, config:{...config, ...overrides}, book:metadata,
        });
        for (const format of ['epub', 'epub3', 'kepub', 'kfx', 'azw8']) {
            const result = await prepare(format);
            assert.ok((await fs.stat(result.filePath)).size > 100);
            assert.strictEqual(result.downloadName, `02 - Доктор Гарин.${converter.getConvertedExtension(format)}`);
            if (['epub', 'epub3', 'kepub'].includes(format)) {
                const epub = await epubContents(result.filePath);
                assert.strictEqual(epub.title, '02 - Доктор Гарин');
                assert.match(epub.opf, /Иванов/);
                assert.match(epub.opf, /cover/i);
            } else {
                assert.ok((await fs.readFile(result.filePath)).includes(Buffer.from('02 - Доктор Гарин')), `${format} must contain catalogue title metadata`);
            }
            assert.strictEqual((await prepare(format)).created, false, 'Reuse conversion cache');
            console.log(`ok: ${format}, catalogue title and series number, cached download`);
        }
        const literal = await prepare('epub', {}, {...book, title:'Книга "кавычки" {{ .Title }}', serno:0});
        assert.strictEqual((await epubContents(literal.filePath)).title, 'Книга "кавычки" {{ .Title }}');
        console.log('ok: literal title with quotes/template syntax, no series number');

        const configDir = path.join(dir, 'custom');
        await fs.ensureDir(configDir);
        const customPath = path.join(configDir, 'config.yaml');
        const custom = 'document:\n  stylesheet_path: style.css\n  metainformation:\n    title_template: "OLD {{ .Title }}"\n    creator_name_template: "AUTHOR {{ .LastName }}"\n';
        await fs.writeFile(customPath, custom);
        await fs.writeFile(path.join(configDir, 'style.css'), 'p { color: #123456; }\n');
        const customResult = await prepare('epub', {fb2cngConfigPath:customPath});
        const epub = await epubContents(customResult.filePath);
        assert.strictEqual(epub.title, '02 - Доктор Гарин');
        assert.match(epub.opf, /AUTHOR Иванов/);
        assert.ok(Object.values(epub.contents).some(text => text.includes('#123456')), 'Relative custom CSS must survive title override');
        assert.strictEqual(await fs.readFile(customPath, 'utf8'), custom);
        console.log('ok: title override preserves custom YAML and relative CSS');

        const noCover = await prepare('epub', {fb2cngArgs:['--no-cover']});
        assert.doesNotMatch((await epubContents(noCover.filePath)).opf, /<meta[^>]*name="cover"/);
        assert.strictEqual(await fs.readFile(source, 'utf8'), original);
        console.log('ok: --no-cover, original FB2 unchanged');
    } finally {
        await fs.remove(dir);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
