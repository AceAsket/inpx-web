const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout:sleep} = require('node:timers/promises');
const {createFixture} = require('./binary-smoke-test');
const {connect,signIn} = require('./rust-events-tests');
const {validateMobi} = require('../server/core/MobiValidation');

const execute = promisify(execFile);
const password = 'rust-conversion-test-admin';
const titleTemplate = 'Издание «${TITLE}» & "{{ .Title }}"';
const renderedTitle = 'Издание «Packaged smoke book» & "{{ .Title }}"';
const formats = {
    epub: ['epub','application/epub+zip'],
    epub3: ['epub','application/epub+zip'],
    kepub: ['kepub.epub','application/epub+zip'],
    kfx: ['kfx','application/vnd.amazon.ebook'],
    azw3: ['azw3','application/vnd.amazon.ebook'],
    azw8: ['azw8','application/vnd.amazon.ebook'],
    mobi: ['mobi','application/x-mobipocket-ebook'],
    pdf: ['pdf','application/pdf'],
};

async function docker(...args) {
    return (await execute('docker',args,{windowsHide:true,timeout:40000})).stdout.trim();
}

async function origin(name, port, ready = '/ready') {
    const address = await docker('port',name,port+'/tcp');
    const base = 'http://'+address;
    for (let i=0;i<100;i++) {
        try {
            const response = await fetch(base+ready,{signal:AbortSignal.timeout(1500)});
            await response.body.cancel();
            if (response.ok) return base;
        } catch (_) { /* The server may still be starting. */ }
        await sleep(250);
    }
    throw Error(name+' did not become ready');
}

async function epub(buffer, directory, label) {
    const file = path.join(directory,label+'.epub');
    await fs.writeFile(file,buffer);
    const zip = new (require('node-stream-zip').async)({file});
    try {
        assert.equal((await zip.entryData('mimetype')).toString(),'application/epub+zip');
        const entries = Object.keys(await zip.entries());
        assert(entries.some(name=>name.endsWith('.opf')));
        const contents = await Promise.all(entries.filter(name=>/\.x?html$/.test(name))
            .map(async name=>(await zip.entryData(name)).toString()));
        assert(contents.join('').includes('Smoke text'));
        return (await Promise.all(entries.filter(name=>/\.(opf|css)$/.test(name))
            .map(async name=>(await zip.entryData(name)).toString()))).join('\n');
    } finally { await zip.close(); }
}

function bookUrl(base, uid, format) {
    return base+'/book/by-uid?'+new URLSearchParams({uid,format});
}

async function download(base, uid, format, cookie = '') {
    const response = await fetch(bookUrl(base,uid,format),{
        headers:{cookie},signal:AbortSignal.timeout(90000),
    });
    if (response.status !== 200)
        assert.fail(format+' returned HTTP '+response.status+': '+(await response.text()).slice(0,500));
    const [extension,mime] = formats[format];
    assert.equal(response.headers.get('content-type'),mime);
    assert(response.headers.get('content-disposition').includes('.'+extension));
    return Buffer.from(await response.arrayBuffer());
}

async function mobi(bytes, directory, label) {
    const file = path.join(directory,label+'.mobi');
    await fs.writeFile(file,bytes);
    await validateMobi(file);
}

function pdf(bytes) {
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    assert.match(bytes.subarray(-32).toString(),/%%EOF/);
}

function azw3(bytes) {
    assert.equal(bytes.toString('ascii',60,68),'BOOKMOBI');
    const first = bytes.readUInt32BE(78);
    assert.equal(bytes.toString('ascii',first+16,first+20),'MOBI');
    assert.equal(bytes.readUInt32BE(first+36),8);
}

async function checkPackagedConversions(base, uid, directory) {
    const client = await connect(base);
    try {
        assert.equal(client.config.conversionEnabled, true);
        assert.deepEqual(client.config.conversionFormats, ['fb2','epub','epub3','kepub','kfx','azw3','azw8','mobi','pdf'],
            'Default download menu in a clean standalone installation');
    } finally { client.close(); }
    for (const format of ['epub','epub3','kepub'])
        await epub(await download(base, uid, format), directory, 'installed-' + format);
    for (const format of ['kfx','azw8']) {
        const bytes = await download(base, uid, format);
        assert.equal(bytes.toString('ascii', 0, 4), 'CONT', format + ' container');
        assert(bytes.length > 100);
    }
    azw3(await download(base, uid, 'azw3'));
    await mobi(await download(base, uid, 'mobi'), directory, 'installed');
    pdf(await download(base, uid, 'pdf'));
    console.log('ok installed Rust HTTP server advertised and delivered all bundled conversion formats');
}

async function conversionEpub(directory) {
    const file = path.join(directory,'conversion.epub');
    await require('./epub-fb2-tests').fixture(file,[],{
        'OPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB for conversion</dc:title><dc:language>ru</dc:language><dc:identifier id="id">urn:inpx:fixture</dc:identifier></metadata><manifest><item id="chapter" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="png" href="images/picture.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        'OPS/chapter2.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава</title></head><body><h1>Глава</h1><p>Текст главы.</p></body></html>',
    });
    return await fs.readFile(file);
}

async function custom(base, directory, configuration) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        const {found} = await client.send('bookSearch',{...identity,query:{title:'=Packaged smoke book'}});
        const url = base+'/book/by-uid?'+new URLSearchParams({uid:found[0]._uid,format:'epub'});
        const download = async () => {
            const response = await fetch(url,{signal:AbortSignal.timeout(30000)});
            assert.equal(response.status,200);
            return Buffer.from(await response.arrayBuffer());
        };
        const change = title => fs.writeFile(configuration,
            'document:\n  stylesheet_path: style.css\n  metainformation:\n    title_template: "'+title+' {{ .Title }}"\n');
        await change('First fixture');
        const first = await epub(await download(),directory,'yaml-first');
        assert(first.includes('First fixture'));
        assert(first.includes('#123456'));
        await change('Second fixture');
        const second = await epub(await download(),directory,'yaml-second');
        assert(second.includes('Second fixture'));
        assert(second.includes('#123456'));
        console.log('ok custom YAML, relative CSS and cache invalidation after changing converter settings');
    } finally { client.close(); }
}

async function customTitle(base, directory) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        const {found} = await client.send('bookSearch',{...identity,query:{title:'=Packaged smoke book'}});
        const result = require('he').decode(await epub(await download(base,found[0]._uid,'epub'),directory,'yaml-title'));
        assert(result.includes(renderedTitle));
        assert(result.includes('#123456'));
        assert(!result.includes('Second fixture'));
        console.log('ok literal catalogue title overrides custom metadata while keeping relative CSS');
    } finally { client.close(); }
}

async function verify(base, relay, directory, container) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        const send = async (action, fields={}) => {
            const result = await client.send(action,{...identity,...fields});
            assert.equal(result.error || '','',action+': '+result.error);
            return result;
        };
        const config = await send('get-config');
        assert.deepEqual(config.conversionFormats,['fb2',...Object.keys(formats)]);
        const find = async title=>(await send('bookSearch',{query:{title:'='+title}})).found[0]._uid;
        const uid = await find('Packaged smoke book');
        const get = (format,target=uid) => download(base,target,format,client.cookie);
        const [first, duplicate] = await Promise.all([get('epub'),get('epub')]);
        assert.deepEqual(first,duplicate);
        assert(require('he').decode(await epub(first,directory,'epub')).includes(renderedTitle));
        for (const format of ['epub3','kepub','kfx','azw3','azw8']) {
            const bytes = await get(format);
            assert(bytes.length>100);
            if (format==='azw3') azw3(bytes);
            if (format==='epub3'||format==='kepub') await epub(bytes,directory,format);
        }
        assert((await get('epub3',await find('EPUB original'))).length>100);
        const source = await find('EPUB for conversion');
        azw3(await get('azw3',source));
        const converted = await docker('exec',container,'sh','-ec',
            'find /data/public-files -name "*.fbc-v1-epub-*.epub" | wc -l');
        assert.equal(Number(converted),1);
        console.log('ok fb2cng EPUB, EPUB3, KEPUB, KFX, AZW3, AZW8, EPUB source and shared cache');

        const [fb2Mobi, sameMobi, fb2Pdf] = await Promise.all([get('mobi'),get('mobi'),get('pdf')]);
        await mobi(fb2Mobi,directory,'from-fb2');
        assert.deepEqual(sameMobi,fb2Mobi);
        assert(fb2Mobi.includes(Buffer.from(renderedTitle)));
        await mobi(await get('mobi',source),directory,'from-epub');
        pdf(fb2Pdf);
        pdf(await get('pdf',source));
        const bad = await find('Unsafe EPUB');
        for (const format of ['mobi','pdf']) {
            const result = await fetch(bookUrl(base,bad,format));
            assert.equal(result.status,415);
        }
        const cached = await docker('exec',container,'sh','-ec',
            'find /data/public-files -type f -name "*.convert-v1-*" | wc -l');
        assert.equal(Number(cached),4);
        const pages = await docker('exec',container,'sh','-ec',
            'find /data/public-files -name "*.convert-v1-pdf-*.pdf" | while IFS= read -r file; do mutool info "$file"; done');
        assert.equal((pages.match(/Pages: [1-9]/g) || []).length,2,pages);
        console.log('ok both source formats to dual MOBI and MuPDF, shared cache and unsafe archive rejected');

        const atom = await (await fetch(base+'/opds/search?type=title&term=Packaged')).text();
        for (const format of Object.keys(formats))
            assert(atom.includes('format='+format),format+' absent from OPDS');
        const opds = await fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'epub'}));
        assert.equal(opds.status,200);
        assert.deepEqual(Buffer.from(await opds.arrayBuffer()),first);
        await send('update-admin-integrations',{integrations:{
            telegramShareEnabled:true,telegramBotToken:'123456:fixture-token',telegramBotEnabled:false,
            emailShareEnabled:true,smtpHost:'relay',smtpPort:2525,smtpSecure:false,
            emailFrom:'admin@example.test',emailTo:'reader@example.test',
        }});
        await send('update-user-profile',{targetUserId:identity.userId,profile:{
            telegramChatId:'123',emailTo:'reader@example.test',defaultTelegramFormat:'mobi',defaultEmailFormat:'pdf',
        }});
        await send('send-book-telegram',{bookUid:uid});
        await send('send-book-email',{bookUid:uid});
        const state = await (await fetch(relay+'/state')).json();
        assert.equal(state.documents.length,1);
        assert(state.documents[0].filename.endsWith('.mobi'));
        assert.deepEqual(Buffer.from(state.documents[0].bytes,'base64'),fb2Mobi);
        assert.equal(state.mail.length,1);
        assert(state.mail[0].raw.replace(/\r\n/g,'').includes(fb2Pdf.toString('base64')));
        const original = await fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'original'}));
        assert.equal(original.status,200);
        assert.match(await original.text(),/<book-title>Packaged smoke book<\/book-title>/);
        const rejected = await fetch(bookUrl(base,uid,'docx'));
        assert.equal(rejected.status,404);
        console.log('ok OPDS, Telegram MOBI and SMTP PDF use cached bytes, original and unsupported format');
    } finally { client.close(); }
}

async function verifyCalibre(base, container) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        assert(client.config.conversionFormats.includes('pdf'));
        for (const title of ['Packaged smoke book','EPUB for conversion']) {
            const result = await client.send('bookSearch',{...identity,query:{title:'='+title}});
            pdf(await download(base,result.found[0]._uid,'pdf',client.cookie));
        }
        const info = await docker('exec',container,'sh','-ec',
            'find /data/public-files -name "*.convert-v1-pdf-*.pdf" | while IFS= read -r file; do mutool show "$file" trailer/Info; done');
        const encodedName = Buffer.from('calibre','utf16le').swap16().toString('hex');
        const creator = new RegExp('/Creator\\s+(?:\\(calibre\\b|<FEFF'+encodedName+')','gi');
        assert.equal((info.match(creator) || []).length,2,info);
        console.log('ok configured Calibre path used for FB2 and EPUB to PDF');
    } finally { client.close(); }
}

async function verifyQueue(base, container, converterDirectory) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        const search = () => client.send('bookSearch',{...identity,query:{title:'=Packaged smoke book'}});
        const {found} = await search();
        const uid = found[0]._uid;
        const pending = fetch(bookUrl(base,uid,'epub'),{signal:AbortSignal.timeout(10000)});
        const started = path.join(converterDirectory,'started');
        for (let attempt = 0; attempt < 50; attempt++) {
            if (await fs.stat(started).catch(()=>null)) break;
            await sleep(25);
        }
        assert(await fs.stat(started));
        assert.equal((await search()).found[0]._uid,uid);
        assert.equal((await fetch(bookUrl(base,uid,'epub3'))).status,503);
        assert.equal((await pending).status,504);
        const staged = await docker('exec',container,'sh','-ec',
            'find /data/public-files -name "*.fbc-v1-*" -o -name ".conversion-*" | wc -l');
        assert.equal(Number(staged),0);
        console.log('ok conversion queue saturation, catalogue search during conversion, timeout and cache cleanup');
    } finally { client.close(); }
}

async function main(image, calibreImage) {
    assert(image,'Usage: node scripts/rust-conversion-tests.js <image> [calibre-image]');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-rust-conversion-'));
    const library = path.join(directory,'library');
    const prefix = 'inpx-conv-test-'+process.pid+'-'+Date.now();
    const relay = prefix+'-relay';
    const server = prefix+'-rust';
    const containers = [relay];
    const mock = path.resolve(__dirname,'rust-delivery-tests.js');
    process.env.INPX_SMOKE_EPUB = 'true';
    let network = false;
    try {
        const unsafe = await require('./mobi-epub-tests').epubFixture('<img src="%2e%2e/%2e%2e/%2e%2e/outside.png"/>');
        await createFixture(library,{extraEpubs:[
            ['EPUB for conversion',await conversionEpub(directory)],
            ['Unsafe EPUB',unsafe],
        ]});
        await docker('network','create',prefix);
        network = true;
        await docker('run','--rm','-d','--name',relay,'--network',prefix,'--network-alias','relay',
            '-p','127.0.0.1::8080','--mount','type=bind,source='+mock+',target=/tmp/relay.js,readonly',
            'node:24-bookworm-slim','node','/tmp/relay.js','service');
        const run = (name, options = [], target = image, prepare = []) => {
            containers.push(name);
            return docker('run','-d','--name',name,'--network',prefix,
                '-p','127.0.0.1::12380','--tmpfs','/data',
                '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false','-e','INPX_TELEGRAM_API_URL=http://relay:8080',
                '--mount','type=bind,source='+library+',target=/library,readonly',...options,target,...prepare,
                '--data-dir=/data','--lib-dir=/library','--inpx=/library/smoke.inpx','--admin-password='+password);
        };
        await run(server,['-e','INPX_BOOK_TITLE_TEMPLATE='+titleTemplate]);
        const relayBase = await origin(relay,8080,'/state');
        await verify(await origin(server,12380),relayBase,directory,server);
        const disabled = server+'-disabled';
        await run(disabled,['-e','INPX_ENABLE_CONVERSION=false']);
        const base = await origin(disabled,12380);
        const client = await connect(base);
        try {
            assert.equal(client.config.conversionEnabled,false);
            assert.deepEqual(client.config.conversionFormats,[]);
            const resolved = await client.send('bookSearch',{query:{title:'=Packaged smoke book'}});
            const uid = resolved.found[0]._uid;
            assert.equal((await fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'epub'}))).status,404);
        } finally { client.close(); }
        console.log('ok settings disable all conversion formats');

        const noMobi = server+'-no-mobi';
        await run(noMobi,['-e','INPX_MOBI_ENABLED=false']);
        const noMobiBase = await origin(noMobi,12380);
        const noMobiClient = await connect(noMobiBase);
        try {
            assert(!noMobiClient.config.conversionFormats.includes('mobi'));
            assert(noMobiClient.config.conversionFormats.includes('pdf'));
            const identity = await signIn(noMobiClient,'admin',password);
            const {found} = await noMobiClient.send('bookSearch',{...identity,query:{title:'=Packaged smoke book'}});
            const uid = found[0]._uid;
            assert.equal((await fetch(bookUrl(noMobiBase,uid,'mobi'))).status,404);
            await noMobiClient.send('update-admin-integrations',{...identity,integrations:{
                emailShareEnabled:true,smtpHost:'relay',smtpPort:2525,smtpSecure:false,
                emailFrom:'admin@example.test',emailTo:'reader@example.test',
            }});
            await noMobiClient.send('update-user-profile',{...identity,targetUserId:identity.userId,
                profile:{emailTo:'reader@example.test',defaultEmailFormat:'mobi'}});
            const fallback = await noMobiClient.send('send-book-email',{...identity,bookUid:uid});
            assert.equal(fallback.error || '','');
            const raw = Buffer.from(await (await fetch(bookUrl(noMobiBase,uid,'original'))).arrayBuffer());
            const state = await (await fetch(relayBase+'/state')).json();
            assert.equal(state.mail.length,2);
            assert(state.mail[1].raw.replace(/\r\n/g,'').includes(raw.toString('base64')));
        } finally { noMobiClient.close(); }
        console.log('ok MOBI can be disabled independently, and delivery falls back to the original');

        const configuration = path.join(directory,'converter');
        await fs.mkdir(configuration);
        await fs.writeFile(path.join(configuration,'style.css'),'p { color: #123456; }\n');
        const configured = server+'-yaml';
        const settingsMount = ['--mount','type=bind,source='+configuration+',target=/converter'];
        const yaml = [...settingsMount,'-e','INPX_FB2CNG_CONFIG=/converter/config.yaml'];
        await run(configured,yaml);
        await custom(await origin(configured,12380),directory,path.join(configuration,'config.yaml'));
        const withTitle = server+'-title';
        await run(withTitle,[...yaml,'-e','INPX_BOOK_TITLE_TEMPLATE='+titleTemplate]);
        await customTitle(await origin(withTitle,12380),directory);

        if (calibreImage) {
            const calibre = server+'-calibre';
            await fs.writeFile(path.join(configuration,'calibre.json'),JSON.stringify({
                converterPaths:{calibre:['/missing/ebook-convert','/usr/bin/ebook-convert']},
            }));
            await run(calibre,settingsMount,calibreImage,
                ['sh','-ec','cp /converter/calibre.json /data/config.json; exec inpx-web "$@"','inpx-test']);
            await verifyCalibre(await origin(calibre,12380),calibre);
        }
        const queued = server+'-queue';
        await fs.writeFile(path.join(configuration,'slow-fbc'),
            '#!/bin/sh\ntouch /converter/started\nsleep 15\nexec /usr/local/bin/fbc "$@"\n');
        await fs.writeFile(path.join(configuration,'queue.json'),JSON.stringify({
            converterPaths:{fbc:'/tmp/inpx-test-fbc'},
        }));
        await run(queued,[...settingsMount,'-e','INPX_CONVERSION_CONCURRENCY=1',
            '-e','INPX_CONVERSION_QUEUE_LIMIT=0','-e','INPX_CONVERSION_TIMEOUT_MS=3000'],image,
            ['sh','-ec','cp /converter/queue.json /data/config.json; cp /converter/slow-fbc /tmp/inpx-test-fbc; chmod +x /tmp/inpx-test-fbc; exec inpx-web "$@"','inpx-test']);
        await verifyQueue(await origin(queued,12380),queued,configuration);
    } catch (error) {
        for (const name of containers) {
            const logs = await execute('docker',['logs','--tail','25',name],{timeout:10000}).catch(()=>null);
            if (logs) console.error(logs.stdout+logs.stderr);
        }
        throw error;
    } finally {
        for (const name of containers.reverse()) await docker('rm','-f',name).catch(()=>{});
        if (network) await docker('network','rm',prefix).catch(()=>{});
        await fs.rm(directory,{recursive:true,force:true});
    }
}

module.exports = {checkPackagedConversions};
if (require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{console.error(error);process.exitCode=1;});
