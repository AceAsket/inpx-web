const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const sax = require('sax');
const {pipeline} = require('stream/promises');
const epub = require('../server/core/EpubToFb2');
const converter = require('../server/core/BookConverter');

async function archive(file, entries) {
    const zip = new yazl.ZipFile(); const complete = pipeline(zip.outputStream, fs.createWriteStream(file));
    for (const [name, data] of entries) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
    zip.end(); await complete;
}

async function fixture(file, additions = [], replace = {}) {
    const picture = await fs.readFile(path.join(__dirname, '../client/assets/pwa-icon-192.png'));
    const entries = [
        ['mimetype', 'application/epub+zip'],
        ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
        ['OPS/book.opf', `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Книга &amp; главы</dc:title><dc:creator>Тестовый Автор</dc:creator><dc:language>ru</dc:language><dc:description>Аннотация книги.</dc:description><dc:identifier>urn:test:epub</dc:identifier><dc:date>2026-11-05</dc:date><meta name="cover" content="cover"/></metadata><manifest><item id="a" href="chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="b" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="n" href="notes.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="img" href="images/picture.png" media-type="image/png"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>`],
        ['OPS/chapter 1.xhtml', `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Глава первая</title></head><body><h1 id="first">Первая глава</h1><p id="paragraph">Текст первой главы &nbsp; с&nbsp;пробелами.</p><p><a epub:type="noteref" href="notes.xhtml#n1">1</a></p><p><img src="images/picture.png" alt="Иллюстрация"/></p><table><tr><th>Ключ</th><td colspan="2">Значение</td></tr></table></body></html>`],
        ['OPS/chapter2.xhtml', `<html><head><title>Глава вторая</title></head><body><h1>Вторая глава</h1><p>Текст второй главы: <em>курсив<br/>новая строка</em>, <strong>жирный</strong>.</p><p><a href="chapter%201.xhtml#paragraph">Перейти к первой</a></p><blockquote><p>Цитата</p></blockquote><script>dangerous()</script></body></html>`],
        ['OPS/notes.xhtml', `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><aside epub:type="footnote" id="n1"><p>Текст сноски.</p><p><a href="chapter%201.xhtml#first">Назад</a></p></aside></body></html>`],
        ['OPS/cover.svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/picture.png"/></svg>'],
        ['OPS/images/picture.png', picture],
    ].filter(([name]) => replace[name] !== null).map(([name, data]) => [name, replace[name] ?? data]);
    await archive(file, [...entries, ...additions]);
}

async function temporary(test) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-epub-fb2-'));
    try {await test(directory);} finally {await fs.remove(directory);}
}

function validateXml(source) {
    const ids = new Set(), references = [];
    const parser = sax.parser(true);
    parser.onerror = error => {throw error;};
    parser.onopentag = node => {
        if (node.attributes.id) {assert(!ids.has(node.attributes.id), 'IDs must be unique'); ids.add(node.attributes.id);}
        const href = node.attributes['l:href']; if (href?.startsWith('#')) references.push(href.slice(1));
    };
    parser.write(source).close();
    for (const ref of references) assert(ids.has(ref), `Link target must exist: ${ref}`);
}

async function testEpubToFb2PreservesReadingOrderMetadataImagesAndNotes() {
    await temporary(async dir => {
        const input = path.join(dir, 'book.epub'), output = path.join(dir, 'book.fb2'); await fixture(input);
        await epub.convert(input, output);
        const source = await fs.readFile(output, 'utf8'); validateXml(source);
        assert(source.indexOf('Текст второй главы') < source.indexOf('Текст первой главы'), 'Spine, not file order, defines reading order');
        for (const expected of ['Книга &amp; главы', 'Тестовый Автор', '<lang>ru</lang>', 'Аннотация книги.', '<emphasis>курсив</emphasis>', '<emphasis>новая строка</emphasis>', '<strong>жирный</strong>', '<cite', '<table', 'colspan="2"', '<body name="notes">', 'Текст сноски.', 'type="note"']) assert(source.includes(expected), expected);
        assert(!source.includes('dangerous')); assert.equal((source.match(/<binary /g) || []).length, 1, 'Cover and inline image share one binary');
        assert(!source.includes('undefined')); assert(!source.includes('NaN'));
        const parser = new (require('../server/core/fb2/Fb2Parser'))(); parser.fromString(source, {lowerCase:true});
        assert.equal(require('he').decode(parser.bookInfo().titleInfo.bookTitle), 'Книга & главы');
        // The web reader parses the same document representation as downloaded FB2.
        assert(parser.rawNodes.length > 0);
        const second = path.join(dir, 'again.fb2'); await epub.convert(input, second);
        assert.equal(await fs.readFile(second, 'utf8'), source, 'Stable output keeps reader anchors and positions across restarts');
    });
}

async function testEpubToFb2RejectsInvalidReferencesEncryptionAndXmlEntities() {
    await temporary(async dir => {
        const input = path.join(dir, 'book.epub'), output = path.join(dir, 'book.fb2');
        for (const replacement of [
            {'OPS/chapter2.xhtml':'<html><body><img src="../../outside.png"/></body></html>'},
            {'OPS/chapter2.xhtml':'<html><body><img src="%2e%2e/%2e%2e/outside.png"/></body></html>'},
            {'OPS/chapter2.xhtml':'<!DOCTYPE html [<!ENTITY leak SYSTEM "file:///etc/passwd">]><html><body><p>&leak;</p></body></html>'},
            {'OPS/chapter2.xhtml':'<html><body><p>Broken'},
            {'OPS/chapter2.xhtml':null},
        ]) {
            await fixture(input, [], replacement);
            await assert.rejects(epub.convert(input, output), error => error.code === 'INPX_INVALID_EPUB', JSON.stringify(replacement));
            assert.equal(await fs.pathExists(output), false);
        }
        await fixture(input, [['META-INF/encryption.xml', '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/chapter2.xhtml"/></CipherData></EncryptedData></encryption>']]);
        await assert.rejects(epub.convert(input, output), /шифрованием/);
        await fixture(input, [['OPS/CHAPTER2.XHTML', '<html><body><p>Duplicate</p></body></html>']]);
        await assert.rejects(epub.convert(input, output), /повторяющийся путь/);
    });
}

async function testEpubToFb2LimitsCancellationAndFailureLeaveExistingFilesIntact() {
    await temporary(async dir => {
        const input = path.join(dir, 'book.epub'), output = path.join(dir, 'book.fb2'); await fixture(input);
        await assert.rejects(epub.convert(input, output, {maxOutputBytes:100}), /размер результата/);
        assert.equal(await fs.pathExists(output), false);
        const controller = new AbortController(); controller.abort();
        await assert.rejects(epub.convert(input, output, {signal:controller.signal}), {code:'ABORT_ERR'});
        await assert.rejects(epub.convert(input, output, {deadline:Date.now()-1}), {code:'INPX_CONVERSION_TIMEOUT'});
        await fs.writeFile(output, 'existing book');
        await assert.rejects(epub.convert(input, output), {code:'EEXIST'});
        assert.equal(await fs.readFile(output, 'utf8'), 'existing book');
    });
}

async function testEpubFb2CacheIsSharedAndFormatsAreOfferedConsistently() {
    await temporary(async dir => {
        const input = path.join(dir, 'book.raw'); await fixture(input);
        const config = {conversionEnabled:true, onlineReaderEnabled:true, conversionFormats:['fb2','epub','epub3','kepub','pdf']};
        const args = {inputFile:input, cacheBasePath:path.join(dir,'cached'), sourceFileName:'book.epub', downFileName:'book.epub', format:'fb2', config};
        const [first, second] = await Promise.all([converter.prepareConvertedFile(args), converter.prepareConvertedFile(args)]);
        assert.equal(first.filePath, second.filePath); validateXml(await fs.readFile(first.filePath, 'utf8'));
        assert.equal((await converter.prepareConvertedFile(args)).created, false);
        assert.equal(first.downloadName, 'book.fb2');
        const formats = require('../shared/BookFormats');
        assert.deepEqual(formats.available('epub', config), ['fb2','epub3','kepub','pdf']);
        assert.equal(formats.canRead('epub', config), true);
        assert.equal(formats.canRead('epub', {...config, conversionEnabled:false}), false);
        assert.equal(formats.canRead('fb2', {...config, conversionEnabled:false}), true);
        assert.equal(formats.resolve('epub',config,'fb2'), 'fb2');
        const info = await converter.getConversionCacheInfo({...args, format:'kepub'});
        assert.equal(info.usesFb2cng, true);
        assert.equal((await fs.readFile(input)).subarray(0,2).toString(), 'PK', 'Original EPUB is never replaced');
    });
}

module.exports = [testEpubToFb2PreservesReadingOrderMetadataImagesAndNotes, testEpubToFb2RejectsInvalidReferencesEncryptionAndXmlEntities,
    testEpubToFb2LimitsCancellationAndFailureLeaveExistingFilesIntact, testEpubFb2CacheIsSharedAndFormatsAreOfferedConsistently];
module.exports.fixture = fixture;
