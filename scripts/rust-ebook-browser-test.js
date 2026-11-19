const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createHmac} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {setTimeout:sleep} = require('node:timers/promises');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {fixture} = require('./ebook-browser-test');
const {connect,signIn} = require('./rust-events-tests');
const {validateMobi} = require('../server/core/MobiValidation');

const exec = promisify(execFile);
const password = 'ebook-browser-fixture';
const root = '/library';
const ebook = root+'/ebook';
const title = 'Книга для электронной книги 00';

async function docker(...args) {
    return (await exec('docker',args,{windowsHide:true,timeout:40000})).stdout.trim();
}

function totp(secret, offset = 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = Array.from(secret,letter=>alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
    const digest = createHmac('sha1',key).update(counter).digest();
    return String((digest.readUInt32BE(digest.at(-1)&15)&0x7fffffff)%1000000).padStart(6,'0');
}

async function start(image, name, library, profileRequired, libraryPassword = '') {
    const policy = await fs.readFile(join(library,'config.json'),'utf8');
    await fs.writeFile(join(library,'container.json'),JSON.stringify({
        ...JSON.parse(policy), accessPassword:libraryPassword, conversionEnabled:true,
        conversionFormats:['fb2','epub','mobi','pdf'],
    }));
    await docker('run','-d','--name',name,'--tmpfs','/data','-p','127.0.0.1::12380',
        '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH='+profileRequired,
        '-e','INPX_ALLOW_ANONYMOUS_ACCESS=true',
        '-e','INPX_ENABLE_CONVERSION=true','-e','INPX_CONVERSION_FORMATS=fb2,epub,mobi,pdf',
        '--mount','type=bind,source='+library+',target=/library,readonly',image,
        'sh','-ec','cp /library/container.json /data/config.json; exec inpx-web "$@"','test',
        '--data-dir=/data','--lib-dir=/library','--inpx=/library/ebook.inpx','--admin-password='+password);
    const base = 'http://'+await docker('port',name,'12380/tcp');
    for (let tries=0;tries<120;tries++) {
        try {
            const response = await fetch(base+'/ready',{signal:AbortSignal.timeout(1000)});
            await response.body.cancel();
            if (response.ok) return base;
        } catch { /* Allow the catalogue to open. */ }
        await sleep(250);
    }
    assert.fail(name+' failed readiness');
}

async function setup(base) {
    const client = await connect(base,root);
    try {
        const identity = await signIn(client,'admin',password);
        const send = async (action, fields={}) => {
            const reply = await client.send(action,{...identity,...fields});
            assert.equal(reply.error || '','',action+': '+reply.error);
            return reply;
        };
        assert.equal((await send('get-config')).ebookReaderEnabled,true);
        const {found} = await send('bookSearch',{query:{title:'='+title}});
        const uid = found[0]._uid;
        const {list} = await send('create-reading-list',{name:'Моя полка',visibility:'private'});
        await send('update-reading-list-book',{listId:list.id,bookUid:uid,enabled:true});
        const {list:smart} = await send('create-reading-list',{
            name:'Умная полка',visibility:'private',filters:{title:'электронной',lang:'ru'},
        });
        const {secret} = await send('profile-totp',{operation:'start',payload:{password}});
        assert.match(secret,/^[A-Z2-7]{32}$/);
        const {recoveryCodes} = await send('profile-totp',{
            operation:'enable',payload:{password,code:totp(secret)},
        });
        assert.equal(recoveryCodes.length,8);
        return {uid,secret,recoveryCodes,list:list.id,smart:smart.id};
    } finally {client.close();}
}

function observe(context) {
    const bad = [];
    context.on('request',request=>{
        if (['script','stylesheet','font','xhr','fetch'].includes(request.resourceType())) bad.push(request.url());
    });
    context.on('page',page=>page.on('websocket',socket=>bad.push(socket.url())));
    return bad;
}

async function submitLogin(page, code, wrong = false) {
    const form = page.locator('.auth');
    await form.getByLabel('Логин',{exact:true}).fill('admin');
    await form.getByLabel('Пароль',{exact:true}).fill(password);
    await form.getByRole('button',{name:'Войти'}).click();
    await form.getByLabel('Одноразовый или резервный код',{exact:true}).waitFor();
    if (wrong) {
        await form.getByLabel('Пароль',{exact:true}).fill(password);
        await form.getByLabel('Одноразовый или резервный код',{exact:true}).fill('invalid');
        await form.getByRole('button',{name:'Войти'}).click();
        await page.getByRole('alert').getByText('Неверный логин, пароль или код.').waitFor();
    }
    await form.getByLabel('Пароль',{exact:true}).fill(password);
    await form.getByLabel('Одноразовый или резервный код',{exact:true}).fill(code());
    await form.getByRole('button',{name:'Войти'}).click();
}

async function readPosition(context, base, uid) {
    const cookie = (await context.cookies(base+ebook)).map(row=>row.name+'='+row.value).join('; ');
    const client = await connect(base,root,cookie);
    try {
        assert.equal(client.config.currentUserId,'admin');
        const state = await client.send('get-reader-state',{bookUid:uid,userId:'admin'});
        assert(!state.error,state.error);
        return state.progress;
    } finally { client.close(); }
}

async function checkLibraryLogin(browser, base) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        const login = page.getByRole('textbox',{name:'Логин',exact:true});
        for (const route of ['/books', '/reader?bookUid=fixture']) {
            await page.goto(base+root+'/#'+route);
            await login.waitFor();
            assert.equal(await page.locator('.library-shell__nav, .reader-html').count(),0);
            await page.keyboard.press('Escape');
            assert(await login.isVisible());
        }
        await page.goto(base+root+'/#/books');
        await login.fill('admin');
        await page.getByRole('textbox',{name:'Пароль',exact:true}).fill(password);
        await page.getByRole('button',{name:'OK',exact:true}).click();
        await page.locator('.library-shell__nav').waitFor();
        await page.goto(base+root+'/#/profile');
        await page.locator('.profile-bottom .profile-logout').click();
        await login.waitFor();
        assert.equal(await page.locator('.library-shell__nav').count(),0);
    } finally {await context.close();}
}

async function profileFlow(browser, base, data) {
    const context = await browser.newContext({javaScriptEnabled:false,acceptDownloads:true,viewport:{width:320,height:800}});
    const bad = observe(context);
    const page = await context.newPage();
    try {
        const query = base+ebook+'?q='+encodeURIComponent('электронной');
        const entry = await page.goto(query);
        assert.equal(entry.status(),401);
        assert.match(entry.headers()['content-security-policy'],/script-src 'none'/);
        assert.equal(await page.locator('.result').count(),0);
        await submitLogin(page,()=>totp(data.secret,1),true);
        assert.equal(new URL(page.url()).searchParams.get('q'),'электронной');
        await page.getByRole('heading',{name:'Найдено: 25'}).waitFor();
        await page.getByLabel('Автор',{exact:true}).fill('Тестовый Автор');
        await page.getByRole('button',{name:'Найти книги'}).click();
        await page.getByRole('heading',{name:'Найдено: 25'}).waitFor();
        assert.equal(await page.locator('.result').count(),10);
        await page.locator('.pagination').getByRole('link',{name:'Следующая'}).click();
        assert.equal(new URL(page.url()).searchParams.get('page'),'2');
        await page.locator('.pagination').getByRole('link',{name:'Предыдущая'}).click();
        await page.getByRole('link',{name:title,exact:true}).click();
        await page.getByRole('link',{name:'Показать аннотацию'}).click();
        await page.locator('.annotation').getByText('Аннотация для электронной книги.',{exact:false}).waitFor();
        assert.equal(await page.locator('.annotation img').count(),0);

        await page.getByRole('link',{name:'Мои полки',exact:true}).click();
        await page.getByRole('link',{name:'Моя полка',exact:true}).click();
        assert.equal(await page.locator('.result').count(),1);
        const invalid = await context.request.post(base+ebook+'/format',{
            form:{csrf:'invalid',format:'epub',next:ebook+'/shelves'},
        });
        assert.equal(invalid.status(),403);
        await page.getByLabel('Формат скачивания',{exact:true}).selectOption('epub');
        await page.getByRole('button',{name:'Сохранить формат'}).click();
        assert.equal(await page.getByLabel('Формат скачивания',{exact:true}).inputValue(),'epub');
        const pending = page.waitForEvent('download');
        await page.locator('.quick-download a').click();
        const epub = await pending;
        assert.match(epub.suggestedFilename(),/^[\x20-\x7e]+\.epub$/);
        const zip = new (require('node-stream-zip').async)({file:await epub.path()});
        try { assert.equal((await zip.entryData('mimetype')).toString(),'application/epub+zip'); }
        finally { await zip.close(); }
        await page.locator('.result h3 a').click();
        await page.getByRole('link',{name:'К полке',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('id'),data.list);
        await page.goto(base+ebook+'/shelf?'+new URLSearchParams({id:data.smart}));
        assert.equal(await page.locator('.result').count(),10);
        await page.getByRole('link',{name:'Следующая',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('cursor'),'10');
        await page.getByRole('link',{name:'Предыдущая',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('cursor'),'0');
        console.log('ok no-JS profile login with TOTP, search and pagination, private and smart shelves, real EPUB download');

        await page.goto(base+ebook+'/book?'+new URLSearchParams({uid:data.uid}));
        await page.getByRole('link',{name:'Читать текст',exact:true}).click();
        const first = await page.locator('.reading').textContent();
        assert(first.includes('Первая глава'));
        const stale = await context.newPage();
        await stale.goto(page.url());
        await page.locator('.reader-pages').last().getByRole('button',{name:'Следующая'}).click();
        const second = await page.locator('.reading').textContent();
        assert.notEqual(first,second);
        const at = new URL(page.url()).searchParams.get('at');
        assert(Number(at)>0);
        const progress = await readPosition(context,base,data.uid);
        assert(progress.percent>0 && progress.textSnippet && progress.revision>0);
        await stale.locator('.reader-pages').last().getByRole('button',{name:'Следующая'}).click();
        await stale.getByRole('status').getByText('Место в профиле изменилось.',{exact:false}).waitFor();
        assert.equal((await readPosition(context,base,data.uid)).revision,progress.revision);
        await stale.close();
        await page.getByRole('link',{name:'36',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('at'),at);
        await page.getByRole('link',{name:'Малый экран',exact:true}).click();
        assert.equal(new URL(page.url()).searchParams.get('at'),at);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.goto(base+ebook+'/recent');
        await page.getByRole('link',{name:title,exact:true}).waitFor();
        await page.getByRole('button',{name:'Выйти',exact:true}).click();
        const denied = await page.goto(base+ebook+'/shelf?'+new URLSearchParams({id:data.list}));
        assert.equal(denied.status(),401);
        assert.equal(await page.locator('.result').count(),0);
        await page.goto(base+ebook+'/read?'+new URLSearchParams({uid:data.uid}));
        await submitLogin(page,()=>data.recoveryCodes[0]);
        assert.equal(await page.locator('.reading').textContent(),second);
        assert.deepEqual(bad,[]);
        console.log('ok text page turns, stale form protection, compact mode, recovery-code login and exact resume');
    } finally { await context.close(); }
}

async function guestFlow(browser,base) {
    const context = await browser.newContext({javaScriptEnabled:false,acceptDownloads:true,viewport:{width:600,height:900}});
    const bad = observe(context);
    const page = await context.newPage();
    try {
        const response = await page.goto(base+ebook+'?q='+encodeURIComponent('электронной'));
        assert.equal(response.status(),401);
        await page.getByRole('heading',{name:'Доступ к библиотеке'}).waitFor();
        await page.getByLabel('Пароль библиотеки',{exact:true}).fill('test-ebook-library-password');
        await page.locator('.auth').getByRole('button',{name:'Войти'}).click();
        await page.getByRole('link',{name:title,exact:true}).click();
        await page.getByLabel('Формат скачивания',{exact:true}).selectOption('mobi');
        await page.getByRole('button',{name:'Применить формат'}).click();
        const href = await page.locator('.quick-download a').getAttribute('href');
        assert(new URL(href,base).pathname.endsWith('.mobi'));
        const pending = page.waitForEvent('download');
        await page.locator('.quick-download a').click();
        const mobi = await pending;
        assert.match(mobi.suggestedFilename(),/\.mobi$/);
        await validateMobi(await mobi.path());
        await page.getByLabel('Формат скачивания',{exact:true}).selectOption('raw');
        await page.getByRole('button',{name:'Применить формат'}).click();
        const original = page.waitForEvent('download');
        await page.locator('.quick-download a').click();
        assert.match(await fs.readFile(await (await original).path(),'utf8'),/<FictionBook/);
        assert.deepEqual(bad,[]);
        console.log('ok library password, guest native format form, actual MOBI and original FB2 downloads');
    } finally { await context.close(); }
}

async function main(image) {
    assert(image,'Usage: node scripts/rust-ebook-browser-test.js <rust-image>');
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-rust-ebook-'));
    const library = join(directory,'library'), names = [];
    let browser;
    try {
        await fixture(library);
        const startCase = (label,...args) => {
            const name = 'inpx-ebook-'+label+'-'+process.pid;
            names.push(name);
            return start(image,name,library,...args);
        };
        const base = await startCase('profile',true);
        browser = await chromium.launch({headless:true});
        await checkLibraryLogin(browser,base);
        const data = await setup(base);
        await profileFlow(browser,base,data);
        const guest = await startCase('guest',false,'test-ebook-library-password');
        await guestFlow(browser,guest);
    } catch (error) {
        for (const name of names) {
            const logs = await exec('docker',['logs','--tail','25',name],{timeout:5000}).catch(()=>null);
            if (logs) console.error(logs.stdout+logs.stderr);
        }
        throw error;
    } finally {
        if (browser) await browser.close();
        for (const name of names.reverse()) await docker('rm','-f',name).catch(()=>{});
        await fs.rm(directory,{recursive:true,force:true});
    }
}

main(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
