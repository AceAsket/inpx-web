const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {writeFileAtomic} = require('../server/core/FilePersistence');
const {KoSync,partialMd5} = require('../server/core/KoSync');
const native = require('../server/core/RustKoSync');
const position = require('../server/core/KoSyncPosition');

function lookup(binary,file,query) {
    return native.lookup(binary,file,query).then(result=>{
        assert.equal(result.ready,true);
        return result.value;
    });
}

async function fingerprintParity(directory,binary) {
    const file = join(directory,'samples.raw');
    const source = Buffer.alloc(4_194_305);
    for (let i=0;i<source.length;i++) source[i]=i%251;
    for (const size of [0,100,1024,1025,4093,65_700,1_049_600,source.length]) {
        await fs.writeFile(file,source.subarray(0,size));
        delete process.env.INPX_RUST_CATALOG_BINARY;
        const expected = await partialMd5(file);
        process.env.INPX_RUST_CATALOG_BINARY = binary;
        assert.equal(await partialMd5(file),expected,'Sparse blocks at '+size+' bytes');
    }
    return file;
}

async function indexParity(directory,binary) {
    const source = join(directory,'book.raw');
    await fs.writeFile(source,'\uFEFF<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns:f="urn:fb2">' +
        '<body><section><title><p>Заголовок</p></title><p>Ёж&nbsp;в лесу &#x1f600;.\r\n<![CDATA[  Ёлка  ]]><a type="note">55</a></p>' +
        '<p>Первый <emphasis>текст</emphasis></p><table><tr><td>Начало <p>Вложенный текст</p> конец</td><td>Другой блок</td></tr></table>' +
        '<f:p>Ёж в лесу Ёлка</f:p><subtitle>Финал ①</subtitle><empty-line/></section></body>' +
        '<body name="NOTES"><section><p>Сноска</p></section></body><body name="comments"><p>Комментарий</p></body>' +
        '<binary id="large">'+ 'YXJy'.repeat(2048*1024)+'</binary></FictionBook>');
    const document = await partialMd5(source);
    const directoryIndex = join(directory,'kosync');
    const file = join(directoryIndex,document+'.json');
    const query = {direction:'from',pointer:'/FictionBook/body/section/p[1]/autoBoxing/text().1'};
    assert.deepEqual(await native.lookup(binary,file,query),{ready:false});
    const wrong = 'f'.repeat(32);
    await assert.rejects(native.build(binary,join(directoryIndex,wrong+'.json'),source,wrong),/Файл книги изменился/);
    await native.build(binary,file,source,document);
    const expected = await position.indexFile(source);
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),expected);
    const from = await lookup(binary,file,query);
    assert.deepEqual(from,position.fromKo(expected,query.pointer));
    assert(from.textSnippet.includes('😀'));
    for (const pointer of ['/FictionBook/body[2]/section/p[1]/text().0',
        '/FictionBook/body/section/table/tr/td[1]/p/inlinebox/text().0',
        '/FictionBook/body/section/table/tr/td[1]/p', '/fictionbook/body[1]/section[1]/p[2]']) {
        assert.deepEqual(await lookup(binary,file,{direction:'from',pointer}),position.fromKo(expected,pointer),pointer);
    }
    for (const [textSnippet,percent] of [['еж в лесу елка',0],['еж в лесу елка',0.99],['финал 1',1],
        ['неизвестная позиция',0.4],['',0],['',0.1]]) {
        const progress = {textSnippet,percent};
        assert.equal(await lookup(binary,file,{direction:'to',...progress}),position.toKo(expected,progress),JSON.stringify(progress));
    }
    expected.blocks[1].text = 'Обновлённый индекс прежнего формата';
    await writeFileAtomic(file,JSON.stringify(expected));
    assert.deepEqual(await lookup(binary,file,query),position.fromKo(expected,query.pointer));
    await writeFileAtomic(file,JSON.stringify({
        blocks:[{path:'/p',text:String.fromCharCode(0xd83d),offset:0}],total:1,
    }));
    assert.deepEqual(await native.lookup(binary,file,query),{ready:false});
    const service = new KoSync({dataDir:directory,bookDir:directory},null);
    const regenerated = await service.bookPosition(document,{ext:'fb2',bookUid:'fixture',cacheFile:'book.raw'},query);
    assert.deepEqual(regenerated.value,from);
    await fs.unlink(file);
    assert.deepEqual(await native.lookup(binary,file,query),{ready:false});
}

async function linkParity(directory,binary,source) {
    const store = new KoSync({dataDir:directory},null);
    const document = await partialMd5(source);
    const oldKeys = Array.from({length:8192},(_,i)=>i.toString(16).padStart(32,'0'));
    const older = {
        version:1,
        accounts:{reader:{verifier:'fixture',documents:{previous:{progress:'/book/body',percentage:0.5}}}},
        books:Object.fromEntries(oldKeys.map(key=>[key,{bookUid:'another',ext:'fb2',cacheFile:'old.raw',updatedAt:1234}])),
        extension:{additional:'Preserve unknown fields'},
    };
    const realNow = Date.now;
    Date.now = ()=>2000;
    let expected;
    try {
        delete process.env.INPX_RUST_CATALOG_BINARY;
        await store.save(older);
        await store.linkDownload(source,'fixture','fb2');
        expected = await store.load();
        await store.save(older);
        process.env.INPX_RUST_CATALOG_BINARY = binary;
        await store.linkDownload(source,'fixture','fb2');
    } finally {
        process.env.INPX_RUST_CATALOG_BINARY = binary;
        Date.now = realNow;
    }
    assert.deepEqual(await store.load(),expected);
    assert(!Object.hasOwn(expected.books,oldKeys[0]));
    assert.equal(expected.books[document].bookUid,'fixture');
    await store.linkDownload(source,'collision','fb2');
    assert.deepEqual((await store.load()).books[document],{ambiguous:true});
    await store.linkDownload(source,'fixture','fb2');
    assert.deepEqual((await store.load()).books[document],{ambiguous:true});
    const disallowed = join(directory,'not-a-file');
    await native.link(binary,disallowed,disallowed,'fixture','epub',123);
    await store.save({...older,accounts:{}});
    await store.linkDownload(disallowed,'fixture','epub');
    assert.deepEqual(await store.load(),{...older,accounts:{}});
}

async function accountTransactions(directory,binary) {
    const user = {id:'reader',login:'reader',passwordHash:'fixture-web-verifier'};
    const utf16Password = 'Reader password '+String.fromCharCode(0xd83d);
    assert.equal(await native.clientKey(binary,utf16Password),createHash('md5').update(utf16Password).digest('hex'));
    const worker = {readingListStore:{loadSnapshot:async()=>({users:[user]})}};
    const service = new KoSync({dataDir:join(directory,'accounts')},worker);
    const state = service.file;
    const documents = Object.fromEntries(Array.from({length:2000},(_,i)=>[
        i.toString(16).padStart(32,'0'),{progress:'/body/p[1]',timestamp:1500,device:'First reader'},
    ]));
    const first = Object.keys(documents)[0], second = Object.keys(documents)[1];
    documents[second].progress += String.fromCharCode(0xd83d);
    const seeded = {
        version:1,
        accounts:{reader:{verifier:'disabled-old-fixture',documents,
            extension:{keep:'credential extension'+String.fromCharCode(0xd83d)}}},
        books:{},
        extra:{other:'snapshot extension'},
    };
    await writeFileAtomic(state,JSON.stringify(seeded));
    service.load = service.save = async()=>{throw new Error('Rust mode must use its own KOSync storage');};
    const read = async()=>JSON.parse(await fs.readFile(state,'utf8'));
    const request = password=>({headers:{'x-auth-user':'reader',
        'x-auth-key':createHash('md5').update(password).digest('hex')}});
    const newDocument = 'fabd'.repeat(8);
    {
        const result = await service.progress(user,second);
        assert.equal(result.progress,documents[second].progress,'Preserve escapes from an old JSON position');
        const old = await native.progress(binary,state,user,undefined,second);
        const record = {...old.previous,device:'Edited position'};
        await native.saveProgress(binary,state,user.id,second,old.stamp,record,false);
        const updated = await read();
        assert.deepEqual(updated.accounts.reader.extension,seeded.accounts.reader.extension);
        assert.deepEqual(updated.extra,seeded.extra);
    }
    const settings = await service.settings(user,'enable');
    const authorized = await service.authenticate(request(settings.password));
    assert(authorized);
    await service.progress(authorized,newDocument,{document:newDocument,progress:'/body/p[3]',percentage:0.75});
    const stored = await read();
    assert.equal(Object.keys(stored.accounts.reader.documents).length,2000);
    assert.equal(stored.accounts.reader.documents[first],undefined,'Prune the first entry among equal timestamps');
    assert.equal(stored.accounts.reader.documents[second].progress,documents[second].progress);
    assert.equal(stored.accounts.reader.documents[newDocument].progress,'/body/p[3]');
    assert.deepEqual(stored.extra,seeded.extra);
    const snapshot = await native.progress(binary,state,user,authorized.kosyncVerifier,newDocument);
    const before = await fs.stat(state,{bigint:true});
    await native.saveProgress(binary,state,user.id,newDocument,snapshot.stamp,snapshot.previous,false);
    const same = await fs.stat(state,{bigint:true});
    assert.equal(same.ino,before.ino,'An unchanged progress record does not replace the stored snapshot');
    const changed = await service.settings(user,'enable');
    assert.equal(await service.authenticate(request(settings.password)),null);
    assert(await service.authenticate(request(changed.password)));
    assert.equal(await native.progress(binary,state,user,authorized.kosyncVerifier,newDocument),null);
    await assert.rejects(native.saveProgress(binary,state,user.id,newDocument,snapshot.stamp,{progress:'stale'},true),/изменено/);
    assert.equal((await service.progress(user,newDocument)).progress,'/body/p[3]');
    await service.settings(user,'disable');
    assert.equal(await service.authenticate(request(changed.password)),null);
    await assert.rejects(service.progress(user,newDocument),{status:401});
    await fs.unlink(state);
    await assert.rejects(native.saveProgress(binary,state,user.id,newDocument,snapshot.stamp,{progress:'stale'},true),/изменено/);
    await assert.rejects(fs.stat(state),{code:'ENOENT'});
}

async function main() {
    const binary = resolve(process.argv[2]);
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-kosync-'));
    const stop = native.start();
    try {
        const source = await fingerprintParity(directory,binary);
        await indexParity(directory,binary);
        await linkParity(directory,binary,source);
        await accountTransactions(directory,binary);
        for (const test of require('./kosync-tests')) await test();
        console.log('ok Rust KOSync sparse fingerprints, index parity, cache replacement, link persistence and HTTP progress');
    } finally {
        await stop?.();
        await fs.rm(directory,{recursive:true,force:true});
    }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
