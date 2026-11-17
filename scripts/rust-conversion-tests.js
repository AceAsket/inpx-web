const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout:sleep} = require('node:timers/promises');
const {createFixture} = require('./binary-smoke-test');
const {connect,signIn} = require('./rust-events-tests');

const execute = promisify(execFile);
const password = 'rust-conversion-test-admin';
const formats = {
    epub: ['epub','application/epub+zip'],
    epub3: ['epub','application/epub+zip'],
    kepub: ['kepub.epub','application/epub+zip'],
    kfx: ['kfx','application/vnd.amazon.ebook'],
    azw8: ['azw8','application/vnd.amazon.ebook'],
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
        const download = async (format, target=uid) => {
            const url = base+'/book/by-uid?'+new URLSearchParams({uid:target,format});
            const response = await fetch(url,{headers:{cookie:client.cookie},signal:AbortSignal.timeout(30000)});
            assert.equal(response.status,200,format+' returned HTTP '+response.status);
            const [extension,mime] = formats[format];
            assert.equal(response.headers.get('content-type'),mime);
            assert(response.headers.get('content-disposition').includes('.'+extension));
            return Buffer.from(await response.arrayBuffer());
        };
        const [first, duplicate] = await Promise.all([download('epub'),download('epub')]);
        assert.deepEqual(first,duplicate);
        await epub(first,directory,'epub');
        for (const format of ['epub3','kepub','kfx','azw8']) {
            const bytes = await download(format);
            assert(bytes.length>100);
            if (format==='epub3'||format==='kepub') await epub(bytes,directory,format);
        }
        const source = await find('EPUB original');
        assert((await download('epub3',source)).length>100);
        const converted = await docker('exec',container,'sh','-ec',
            'find /data/public-files -name "*.fbc-v1-epub-*.epub" | wc -l');
        assert.equal(Number(converted),1);
        console.log('ok fb2cng EPUB, EPUB3, KEPUB, KFX, AZW8, EPUB source and shared cache');

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
            telegramChatId:'123',emailTo:'reader@example.test',defaultTelegramFormat:'epub',defaultEmailFormat:'epub',
        }});
        await send('send-book-telegram',{bookUid:uid});
        await send('send-book-email',{bookUid:uid});
        const state = await (await fetch(relay+'/state')).json();
        assert.equal(state.documents.length,1);
        assert(state.documents[0].filename.endsWith('.epub'));
        assert.deepEqual(Buffer.from(state.documents[0].bytes,'base64'),first);
        assert.equal(state.mail.length,1);
        assert(state.mail[0].raw.replace(/\r\n/g,'').includes(first.toString('base64')));
        const original = await fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'original'}));
        assert.equal(original.status,200);
        assert.match(await original.text(),/<FictionBook/);
        const rejected = await fetch(base+'/book/by-uid?'+new URLSearchParams({uid,format:'mobi'}));
        assert.equal(rejected.status,404);
        console.log('ok OPDS links, Telegram and SMTP use the same EPUB bytes, original and unsupported format');
    } finally { client.close(); }
}

async function main(image) {
    assert(image,'Usage: node scripts/rust-conversion-tests.js <image>');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-rust-conversion-'));
    const library = path.join(directory,'library');
    const prefix = 'inpx-conv-test-'+process.pid+'-'+Date.now();
    const relay = prefix+'-relay';
    const server = prefix+'-rust';
    const mock = path.resolve(__dirname,'rust-delivery-tests.js');
    process.env.INPX_SMOKE_EPUB = 'true';
    let network = false;
    try {
        await createFixture(library);
        await docker('network','create',prefix);
        network = true;
        await docker('run','--rm','-d','--name',relay,'--network',prefix,'--network-alias','relay',
            '-p','127.0.0.1::8080','--mount','type=bind,source='+mock+',target=/tmp/relay.js,readonly',
            'node:24-bookworm-slim','node','/tmp/relay.js','service');
        const run = (name,...options) => docker('run','--rm','-d','--name',name,'--network',prefix,
            '-p','127.0.0.1::12380','--tmpfs','/data',
            '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false','-e','INPX_TELEGRAM_API_URL=http://relay:8080',
            '--mount','type=bind,source='+library+',target=/library,readonly',...options,image,
            '--data-dir=/data','--lib-dir=/library','--inpx=/library/smoke.inpx','--admin-password='+password);
        await run(server);
        await verify(await origin(server,12380),await origin(relay,8080,'/state'),directory,server);
        const disabled = server+'-disabled';
        await run(disabled,'-e','INPX_ENABLE_CONVERSION=false');
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
        const configuration = path.join(directory,'converter');
        await fs.mkdir(configuration);
        await fs.writeFile(path.join(configuration,'style.css'),'p { color: #123456; }\n');
        const configured = server+'-yaml';
        await run(configured,'--mount','type=bind,source='+configuration+',target=/converter',
            '-e','INPX_FB2CNG_CONFIG=/converter/config.yaml');
        await custom(await origin(configured,12380),directory,path.join(configuration,'config.yaml'));
    } finally {
        for (const name of [server,server+'-disabled',server+'-yaml',relay]) await docker('rm','-f',name).catch(()=>{});
        if (network) await docker('network','rm',prefix).catch(()=>{});
        await fs.rm(directory,{recursive:true,force:true});
    }
}

if (require.main===module) main(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
