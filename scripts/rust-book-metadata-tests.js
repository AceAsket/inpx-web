const assert = require('node:assert/strict');
const fs = require('fs-extra');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {pipeline} = require('node:stream/promises');
const {gzipSync} = require('node:zlib');
const iconv = require('iconv-lite');
const yazl = require('yazl');
const archive = require('../server/core/RustBookArchive');
const {BookMetadata,fb2Metadata,epubMetadata} = require('../server/core/BookMetadata');
const IsbnIndex = require('../server/core/LibraryIsbnIndex');

async function zip(file,entries) {
    const archive = new yazl.ZipFile();
    const done = pipeline(archive.outputStream,fs.createWriteStream(file));
    for (const [name,bytes] of Object.entries(entries)) archive.addBuffer(Buffer.from(bytes),name);
    archive.end();
    await done;
}

async function withoutRust(run) {
    const binary = process.env.INPX_RUST_CATALOG_BINARY;
    delete process.env.INPX_RUST_CATALOG_BINARY;
    try {return await run();}
    finally {process.env.INPX_RUST_CATALOG_BINARY = binary;}
}

async function checkMetadata(directory) {
    const fb2 = join(directory,'sample.fb2'), gz = join(directory,'compressed.fb2'), epub = join(directory,'sample.epub'),
        collection = join(directory,'collection.zip'), oversized = join(directory,'oversized.epub');
    const description = '<FictionBook><description><title-info><annotation><p>Первый абзац.</p><p>Текст &amp; ещё.</p></annotation><keywords>метка; тема</keywords><lang>ru</lang></title-info><publish-info><publisher>Издатель &#xED;</publisher><year>2026</year><isbn>0-8044-2957-X</isbn></publish-info></description>';
    const body = '<body><section><p>'+ 'текст '.repeat(20000) +'</p></section></body></FictionBook>';
    const bytes = iconv.encode('<?xml version="1.0" encoding="windows-1251"?>'+description+body,'windows-1251');
    const utf16 = Buffer.from('\uFEFF<?xml version="1.0" encoding="UTF-16"?>'+description+body,'utf16le');
    await fs.writeFile(fb2,bytes);
    await fs.writeFile(gz,gzipSync(utf16));
    const parts = {
        'Book/META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
        'Book/OPS/book.opf':'<package><metadata><dc:title>Тест EPUB</dc:title><dc:creator>Автор</dc:creator><dc:description><![CDATA[One<br/>Two]]></dc:description><dc:language>ru</dc:language><dc:date>2026-11-16</dc:date><dc:publisher>Books &amp; Press</dc:publisher><dc:identifier opf:scheme="ISBN">urn:isbn:0306406152</dc:identifier><dc:identifier>isbn:9780804429573</dc:identifier><dc:subject>тема</dc:subject></metadata></package>',
    };
    await zip(epub,parts);
    await zip(oversized,{...parts,'Book/OPS/book.opf':'x'.repeat(4*1024*1024+1)});
    await zip(collection,{'first.fb2':bytes,'second.fb2':await fs.readFile(gz),'third.epub':await fs.readFile(epub)});
    const legacyFb2 = fb2Metadata(bytes), legacyEpub = await withoutRust(()=>epubMetadata(epub));
    assert.equal(legacyFb2.description,'Первый абзац.\nТекст & ещё.');
    assert.equal(legacyEpub.description,'One\nTwo');
    for (const [file,name] of [[fb2,null],[gz,null],[collection,'first.fb2'],[collection,'second.fb2']]) {
        assert.deepEqual(await archive.metadata(file,name,'fb2'),legacyFb2);
        assert.deepEqual(await archive.metadata(file,name,'fb2',{isbnOnly:true}),['9780804429573']);
    }
    assert.deepEqual(await epubMetadata(epub),legacyEpub);
    assert.deepEqual(await archive.metadata(collection,'third.epub','epub'),legacyEpub);
    assert.deepEqual(await archive.metadata(collection,'third.epub','epub',{isbnOnly:true}),['9780306406157','9780804429573']);
    await assert.rejects(epubMetadata(oversized),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
    await assert.rejects(archive.metadata(collection,'first.fb2','fb2',{isbnOnly:true,limit:bytes.length-1}),{code:'INPX_RESOURCE_OUTPUT_LIMIT'});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(archive.metadata(collection,'first.fb2','fb2',{signal:controller.signal}),{code:'ABORT_ERR'});

    const worker = Object.assign(Object.create(require('../server/core/WebWorker').prototype),{
        config:{libDir:directory,tempDir:directory},libraryAssetGeneration:1,
        extractBook:async()=>assert.fail('Rust metadata should read from the archive directly'),
    });
    const metadata = new BookMetadata(worker);
    try {
        const book = {folder:'collection.zip',file:'first',ext:'fb2',_uid:'native',size:bytes.length};
        assert.deepEqual(await metadata.read(book),legacyFb2);
    } finally {metadata.cache.close();}
}

async function checkLegacyIndex(directory) {
    const file = join(directory,'isbn-index.json');
    const worker = {config:{dataDir:directory},db:{select:async()=>[]}};
    const index = new IsbnIndex(worker);
    index.signature = async()=> 'snapshot';
    const state = {version:1,signature:'snapshot',revision:'old',complete:true,entries:[[7,['0306406152']],[11,['9780306406157'],true]]};
    await fs.writeJson(file,state);
    try {
        assert.equal((await index.status()).state,'ready');
        const first = await index.select('ISBN-10: 0306406152');
        assert.deepEqual(Array.from(first.ids),[7,11]);
        assert.deepEqual([...first.deletedIds],[11]);
        assert.deepEqual(await fs.readJson(file),state);
        assert(await fs.pathExists(join(directory,'isbn-index.redb')));

        // Import was committed once. A reopened index selects from Rust storage.
        await index.release();
        await fs.writeJson(file,{...state,entries:[]});
        assert.deepEqual(Array.from((await index.select('9780306406157')).ids),[7,11]);
        index.signature = async()=> 'new-catalogue';
        await assert.rejects(index.select('9780306406157'),/ещё не готов/);

        await index.native.save({...state,revision:'new',signature:'new-catalogue',complete:false,updatedAt:1,entries:[]},true);
        await index.native.save({...state,revision:'new',signature:'new-catalogue',lastId:9,checked:9,found:1,updatedAt:2,
            entries:[[9,['9780804429573'],false]]},false);
        await index.release();
        assert.deepEqual(Array.from((await index.select('080442957X')).ids),[9]);
        assert.deepEqual(Array.from((await index.select('9780306406157')).ids),[]);
    } finally {await index.close();}
}

async function checkFolderMetadata(directory) {
    const {metadata} = require('../server/core/FolderIndexer');
    const fields = '<description><TITLE-INFO><genre> sf </genre><genre/>'
        + '<author><last-name>Иванов</last-name><first-name> И. </first-name><nickname>Ignored</nickname></author>'
        + '<author><nickname>Автор &amp; друг</nickname></author><author/>'
        + '<book-title><![CDATA[Ignored]]> Роман &amp; повесть<!-- Split -->ignored</book-title>'
        + '<lang> ru </lang><keywords> A, B </keywords>'
        + '<sequence NAME="Серия &amp; книги" number="0x10"/><sequence name="Ignored" number="2"/></TITLE-INFO></description>';
    const samples = [
        ['utf8', fields], ['windows-1251', fields], ['cp866', fields], ['utf16-le', fields], ['utf16-be', fields],
        ...['windows-1250','windows-1252','windows-1254'].map(encoding => [encoding, fields.replace('Иванов','Renée')]),
        ['utf8', '<description><title-info><book-title/><book-title>Ignored</book-title></title-info><title-info><book-title>Ignored</book-title></title-info></description>'],
        ['utf8', '<description><publish-info><book-name>Print title</book-name></publish-info></description>'],
    ];
    for (const [i,[encoding,description]] of samples.entries()) {
        const file=join(directory,`folder-${i}.fb2`);
        const bom=encoding.startsWith('utf16')?'\uFEFF':'';
        const xml=`${bom}<?xml version="1.0" encoding="${encoding}"?><FictionBook>${description}<body><p>Текст</p></body></FictionBook>`;
        await fs.writeFile(file,iconv.encode(xml,encoding));
        assert(await archive.metadata(file,null,'folderFb2'), `Native reader rejected ${encoding} fixture ${i}`);
        assert.deepEqual(await metadata(file,'fb2'),await withoutRust(()=>metadata(file,'fb2')));
    }
    const malformed=join(directory,'broken.fb2');
    await fs.writeFile(malformed,'<FictionBook><body/>');
    assert.equal(await archive.metadata(malformed,null,'folderFb2'),null);
    await assert.rejects(metadata(malformed,'fb2'),/Не найдены метаданные FB2/);
}

async function main() {
    process.env.INPX_RUST_CATALOG_BINARY = resolve(process.argv[2]);
    await new (require('../server/core/AppLogger'))().init({loggingEnabled:false});
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-book-metadata-'));
    const stop = archive.start();
    try {
        await checkMetadata(directory);
        await checkFolderMetadata(directory);
        await checkLegacyIndex(directory);
        for (const test of require('./isbn-tests')) await test();
        console.log('Rust book metadata and ISBN storage tests passed');
    } finally {
        await stop();
        await fs.remove(directory);
    }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
