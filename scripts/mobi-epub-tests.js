const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const yazl = require('yazl');
const {validateEpubForMobi} = require('../server/core/MobiEpubValidation');

async function epubFixture(content = '<p>Книга</p>', filename = 'OPS/Text/book.xhtml') {
    const zip = new yazl.ZipFile(), chunks = [];
    const done = new Promise((resolve, reject) => {
        zip.outputStream.on('data', chunk => chunks.push(chunk));
        zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
        zip.outputStream.once('error', reject);
    });
    zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype');
    zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
    zip.addBuffer(Buffer.from('<package><manifest><item href="Text/book.xhtml"/></manifest></package>'), 'OPS/book.opf');
    zip.addBuffer(Buffer.from(content), filename);
    zip.end();
    return await done;
}

async function testMobiEpubCannotReadOrWriteOutsideBook() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-mobi-epub-'));
    try {
        const file = path.join(dir, 'book.epub');
        const valid = '<html><head><link href="../Styles/book.css"/></head><body><a href="#note">Примечание</a><a href="https://example.org">Ссылка</a><img src="../Images/cover.png"/></body></html>';
        await fs.writeFile(file, await epubFixture(valid)); await validateEpubForMobi(file);
        await fs.writeFile(file, await epubFixture(valid, 'Text/book.xhtml')); await validateEpubForMobi(file);
        for (const content of ['<img src="../../../secret"/>', '<img src="/etc/passwd"/>', '<item href="C:\\secret"/>',
            '<img src="&#47;etc/passwd"/>', '<img src="%2e%2e/%2e%2e/%2e%2e/secret"/>', '<img src=../../../secret>',
            '<rootfile full-path="../../secret"/>', '<style>p { background:url(../../../secret) }</style>',
            '<style>@import "../../../secret";</style>', '<style>p { background:url(\\2f etc/passwd) }</style>',
            '<html xml:base="file:///etc/"/>', '<!ENTITY x SYSTEM "file:///etc/passwd">']) {
            await fs.writeFile(file, await epubFixture(content));
            await assert.rejects(validateEpubForMobi(file), {code:'INPX_UNSAFE_MOBI_EPUB'}, content);
        }
        // ZIP names cannot be crafted through yazl, so mutate a same-length
        // central-directory/local name and preserve all compressed contents.
        const zip = await epubFixture('text', 'xxxxxx/evil.txt');
        const malicious = Buffer.from(zip.toString('latin1').replaceAll('xxxxxx/evil.txt', '../xxx/evil.txt'), 'latin1');
        await fs.writeFile(file, malicious);
        await assert.rejects(validateEpubForMobi(file), {code:'INPX_UNSAFE_MOBI_EPUB'});
        await fs.writeFile(file, await epubFixture('text', 'OPS/BOOK.OPF'));
        await assert.rejects(validateEpubForMobi(file), {code:'INPX_UNSAFE_MOBI_EPUB'});
        const {isolatedConverter} = require('./converter-options-tests');
        const converter = await isolatedConverter(async() => { throw new Error('Unsafe EPUB must never reach Kindling'); });
        const outputFile = path.join(dir, 'output.mobi');
        await assert.rejects(converter.convert({inputFile:file, outputFile, format:'mobi', mobiEnabled:true}), {code:'INPX_UNSAFE_MOBI_EPUB'});
        assert.ok(!(await fs.readdir(dir)).some(name => name.includes('.work-')));
    } finally { await fs.remove(dir); }
}

module.exports = [testMobiEpubCannotReadOrWriteOutsideBook];
module.exports.epubFixture = epubFixture;
