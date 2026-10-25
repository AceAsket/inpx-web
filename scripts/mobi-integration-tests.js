const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const converter = require('../server/core/BookConverter');
const {validateMobi} = require('../server/core/MobiValidation');

function inspectMobi(data) {
    const offsets = Array.from({length: data.readUInt16BE(76)}, (_, i) => data.readUInt32BE(78 + i * 8));
    const records = offsets.map((offset, i) => data.subarray(offset, offsets[i + 1] || data.length));
    const first = records[0], textLength = first.readUInt32BE(4), textCount = first.readUInt16BE(8);
    const out = [];
    assert.strictEqual(first.readUInt16BE(0), 2, 'PalmDOC compression');
    for (const record of records.slice(1, textCount + 1)) {
        let cursor = 0;
        while (cursor < record.length && out.length < textLength) {
            const value = record[cursor++];
            if (value >= 1 && value <= 8) {
                for (let n = 0; n < value; n++) out.push(record[cursor++]);
            } else if (value < 128) out.push(value);
            else if (value >= 192) out.push(32, value ^ 128);
            else {
                const pair = (value << 8) | record[cursor++], distance = (pair & 16383) >> 3, length = (pair & 7) + 3;
                assert.ok(distance && distance <= out.length);
                for (let n = 0; n < length; n++) out.push(out[out.length - distance]);
            }
        }
    }
    const text = Buffer.from(out).subarray(0, textLength);
    return {records, text, html: text.toString('utf8')};
}

async function main() {
    const args = require('minimist')(process.argv.slice(2));
    assert.ok(args.fbc && args.kindling, 'Usage: node scripts/mobi-integration-tests.js --fbc PATH --kindling PATH');
    const fbc = path.resolve(args.fbc), kindling = path.resolve(args.kindling);
    const version = execFileSync(kindling, ['--version'], {encoding:'utf8', windowsHide:true});
    assert.match(version, /0\.45\.6\b/); console.log(version.trim());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-mobi-integration-'));
    try {
        const cover = (await fs.readFile(path.join(__dirname, '../client/assets/pwa-icon-192.png'))).toString('base64');
        const original = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre><author><first-name>Иван</first-name><last-name>Петров</last-name></author><book-title>Исходное название</book-title><coverpage><image l:href="#cover.png"/></coverpage><lang>ru</lang><sequence name="Серия" number="7"/></title-info><document-info><author><nickname>Test</nickname></author><date>2026-10-25</date><id>mobi-integration</id><version>1.0</version></document-info></description>
<body><section id="chapter1"><title><p>Глава первая</p></title><p>Кириллица: ёж, съёмка. <a l:href="#note1" type="note">Примечание 1</a></p></section><section id="chapter2"><title><p>Глава вторая</p></title><p>Второй раздел и оглавление.</p></section></body>
<body name="notes"><section id="note1"><title><p>1</p></title><p>Текст примечания по-русски.</p></section></body>
<binary id="cover.png" content-type="image/png">${cover}</binary></FictionBook>`;
        const inputFile = path.join(dir, 'source.fb2'); await fs.writeFile(inputFile, original);
        const config = {conversionEnabled:true, mobiEnabled:true, converterPaths:{fb2cng:fbc}, kindlingPath:kindling,
            fb2cngVersion:'v1.9.0', kindlingVersion:'v0.45.6', bookTitleTemplate:'${NUMBER_PADDED} - ${TITLE}', bookFilenameTemplate:'${TITLE}'};
        converter.configure({conversionConcurrency:1});
        const options = {inputFile, cacheBasePath:path.join(dir, 'cached'), sourceFileName:'source.fb2', downFileName:'source.fb2',
            format:'mobi', book:{title:'Книга «ё»', serno:2}, config};
        const result = await converter.prepareConvertedFile(options);
        await validateMobi(result.filePath);
        assert.strictEqual(result.downloadName, 'Книга «ё».mobi');
        const data = await fs.readFile(result.filePath), {records, text, html} = inspectMobi(data);
        assert.ok(records[0].includes(Buffer.from('02 - Книга «ё»')), 'Catalogue title and series number in MOBI metadata');
        for (const fragment of ['Глава первая', 'Глава вторая', 'Кириллица: ёж, съёмка.', 'Текст примечания по-русски.']) assert.ok(html.includes(fragment), fragment);
        const links = [...html.matchAll(/filepos=["']?(\d+)/g)];
        assert.ok(links.length >= 2, 'Footnote and return links must survive');
        for (const link of links) assert.ok(Number(link[1]) < text.length, 'Footnote byte offset must point into the legacy text');
        assert.ok(records.some(record => record.toString('ascii', 0, 4) === 'INDX'), 'KF8 navigation index');
        assert.ok(records.some(record => record[0] === 0xff && record[1] === 0xd8), 'Cover image resource');
        assert.strictEqual((await converter.prepareConvertedFile(options)).created, false);
        assert.strictEqual(await fs.readFile(inputFile, 'utf8'), original);
        console.log('ok: FB2 → dual MOBI, Cyrillic, catalogue title, chapters/index, cover, footnote, cached download');

        const epub = await converter.prepareConvertedFile({...options, format:'epub'});
        const epubBefore = await fs.readFile(epub.filePath);
        const fromEpub = await converter.prepareConvertedFile({...options, inputFile:epub.filePath, sourceFileName:'original.epub', config:{...config, fb2cngConfigPath:'/unused/missing'}});
        await validateMobi(fromEpub.filePath);
        assert.ok(inspectMobi(await fs.readFile(fromEpub.filePath)).html.includes('Глава вторая'));
        assert.deepStrictEqual(await fs.readFile(epub.filePath), epubBefore);
        console.log('ok: existing EPUB → MOBI without fbc, original EPUB unchanged');

        const epub3 = await converter.prepareConvertedFile({...options, format:'epub3'});
        const fromEpub3 = await converter.prepareConvertedFile({...options, inputFile:epub3.filePath, sourceFileName:'original.epub', cacheBasePath:path.join(dir, 'epub3-cache')});
        await validateMobi(fromEpub3.filePath);
        assert.ok(inspectMobi(await fs.readFile(fromEpub3.filePath)).html.includes('Глава вторая'));
        console.log('ok: existing EPUB3 → dual MOBI');

        const large = path.join(dir, 'large.fb2');
        const paragraphs = Array.from({length:600}, (_, i) => `<p>Раздел ${i}. Проверяем длинный русский текст, переносы, ёжика и несколько записей PalmDOC.</p>`).join('');
        await fs.writeFile(large, original.replace('Кириллица: ёж, съёмка.', 'Начало длинной книги.').replace('</section><section id="chapter2">', `${paragraphs}</section><section id="chapter2">`));
        const largeResult = await converter.prepareConvertedFile({...options, inputFile:large, cacheBasePath:path.join(dir, 'large-cache')});
        const largeData = await fs.readFile(largeResult.filePath), largeBook = inspectMobi(largeData);
        assert.ok(largeBook.records[0].readUInt16BE(8) > 1, 'Multiple legacy text records');
        for (const fragment of ['Раздел 0.', 'Раздел 599.', 'Глава вторая', 'Текст примечания по-русски.']) assert.ok(largeBook.html.includes(fragment), fragment);
        console.log('ok: multi-record Russian book, beginning/end, chapter and note after long text');

        const custom = path.join(dir, 'custom'); await fs.ensureDir(custom);
        const yamlPath = path.join(custom, 'fbc.yaml');
        const yaml = 'document:\n  stylesheet_path: style.css\n';
        await fs.writeFile(yamlPath, yaml); await fs.writeFile(path.join(custom, 'style.css'), 'p { color: #123456; }');
        const customResult = await converter.prepareConvertedFile({...options, config:{...config, fb2cngConfigPath:yamlPath, fb2cngArgs:['--no-cover']}});
        await validateMobi(customResult.filePath);
        assert.notStrictEqual(customResult.filePath, result.filePath);
        assert.strictEqual(await fs.readFile(yamlPath, 'utf8'), yaml);
        assert.ok(!(await fs.readFile(customResult.filePath)).equals(data));
        console.log('ok: custom fbc YAML, relative CSS and --no-cover, distinct cache');

        const broken = path.join(dir, 'broken.epub'); await fs.writeFile(broken, 'not an EPUB');
        await assert.rejects(converter.prepareConvertedFile({...options, inputFile:broken, sourceFileName:'broken.epub', cacheBasePath:path.join(dir, 'broken-cache')}));
        assert.ok(!(await fs.readdir(dir)).some(name => name.startsWith('broken-cache')));
        console.log('ok: invalid EPUB rejected, no partial output cached');
    } finally { await fs.remove(dir); }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
