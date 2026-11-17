const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {connect, signIn, waitFor} = require('./rust-events-tests');
const {createFixture} = require('./binary-smoke-test');

const password = 'rust-settings-fixture';
const primary = {id:'main', name:'Копия библиотеки', type:'inpx', libDir:'/library', inpx:'/library/smoke.inpx'};
const extra = {id:'extra', name:'Дополнительная папка', type:'folder', libDir:'/library/extra'};
const extraTitle = 'Книга дополнительного источника';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const fakeTelegram = '123456:fixture-token';
const fakeSmtp = 'fixture-smtp-password';
const opdsPassword = 'fixture-opds-password';

async function fixture(directory, installation) {
    const data = path.join(directory,'copy'), library = path.join(directory,'library');
    await fs.cp(installation,data,{recursive:true,filter:file =>
        !['__softlock','__lock','server.err','server.out'].includes(path.basename(file))});
    await createFixture(library);
    await fs.mkdir(path.join(library,'extra'),{recursive:true});
    await fs.mkdir(path.join(library,'covers'),{recursive:true});
    await fs.mkdir(path.join(library,'etc'),{recursive:true});
    await fs.writeFile(path.join(library,'extra','second.fb2'),`<FictionBook><description><title-info><author><first-name>Иван</first-name><last-name>Тестов</last-name></author><book-title>${extraTitle}</book-title><lang>ru</lang></title-info></description><body><section><p>Второй источник.</p></section></body></FictionBook>`);
    const configFile=path.join(data,'config.json');
    const config = JSON.parse(await fs.readFile(configFile,'utf8'));
    Object.assign(config,{
        dataDir:'/data', server:{host:'0.0.0.0', port:12380, root:''}, accessPassword:'', requireAuth:false,
        opds:{enabled:true,root:'/opds',user:'',password:''}, librarySources:[primary], libDir:'/library',
        inpx:'/library/smoke.inpx', inpxCheckInterval:0, cacheCleanSchedule:'',
    });
    await fs.writeFile(configFile,JSON.stringify(config,null,2));
    const native = path.join(data,'public-files','source-verified-v1','book');
    const legacy = path.join(data,'public-files','source-verified-v1','cover');
    await fs.mkdir(native,{recursive:true});
    await fs.mkdir(legacy,{recursive:true});
    const digest=createHash('sha256').update(png).digest('hex');
    await fs.writeFile(path.join(native,digest+'.reader-cover'),Buffer.from('corrupt'));
    await fs.writeFile(path.join(native,'bad.reader-cover'),Buffer.alloc(0));
    await fs.writeFile(path.join(legacy,'broken.jpg'),Buffer.alloc(0));
    await fs.writeFile(path.join(native,'old-cache-fixture'),Buffer.alloc(2*1024*1024,7));
}

async function legacySettings() {
    const legacy = process.env.INPX_RC15_SOURCE;
    assert(legacy, 'Set INPX_RC15_SOURCE to an extracted RC15 package');
    const logger=new (require(path.resolve(legacy,'server/core/AppLogger')))();
    if (!logger.inited) await logger.init({loggingEnabled:false,name:'rust-settings-tests'});
    const Worker = require(path.resolve(legacy,'server/core/WebWorker'));
    const worker = Object.create(Worker.prototype);
    worker.checkMyState = () => {};
    worker.requireAdmin = async () => {};
    worker.config = {
        librarySources:[primary,extra], extendedSearch:false, uiDefaults:{limit:47},
        opds:{enabled:true,root:'/restored-opds',user:'fixture-opds',password:opdsPassword},
        telegramBotToken:'legacy-token', smtpPass:'legacy-smtp', emailTo:'recipient@example.test',
    };
    return worker;
}

async function verify(base, relay) {
    const admin = await connect(base);
    let guest;
    try {
        assert.equal(admin.config.adminIntegrations,undefined);
        assert.equal(admin.config.adminLibrarySources,undefined);
        const identity = await signIn(admin,'admin',password);
        const request = (action, fields={})=>admin.send(action,{...identity,...fields});
        const send = async (action, fields)=>{
            const result = await request(action,fields);
            assert.equal(result.error || '', '', `${action}: ${result.error}`);
            return result;
        };
        const config = ()=>send('get-config');
        assert((await config()).adminLibrarySources.some(source=>source.id==='main'));
        assert.equal((await request('update-admin-opds',{csrfToken:'wrong',opds:{enabled:false}})).error,'bad_csrf_token');
        await send('create-user-profile',{profile:{name:'Тестовый читатель', login:'settings-reader',password}});
        guest = await connect(base);
        const other = await signIn(guest,'settings-reader',password);
        assert.match((await guest.send('admin-diagnose-library-source',{...other,source:primary})).error,/администратора/);
        assert.match((await guest.send('export-admin-settings',other)).error,/администратора/);
        assert.equal((await guest.send('get-config',other)).adminOpds,undefined);

        const report = await send('admin-diagnose-library-source',{source:primary});
        assert(report.inpxExists && report.libDirExists && report.hasCovers && report.hasEtc);
        assert(report.foundInpx.includes('/library/smoke.inpx'));
        assert(report.archiveCount>=2);
        const missing = await send('admin-diagnose-library-source',{source:{libDir:'/absent-source',inpx:'/absent.inpx'}});
        assert(!missing.inpxExists && !missing.libDirExists);
        assert.deepEqual(missing.foundInpx,[]);
        assert.match((await request('update-admin-library-sources',{sources:[{...primary,enabled:false}]})).error,/включён/);
        const saved = await send('update-admin-library-sources',{sources:[primary,extra,{id:'off',libDir:'/disabled',type:'folder',enabled:false}]});
        assert.equal(saved.sources.length,3);
        assert(saved.reindexRequired);
        assert.equal((await config()).adminLibrarySources.length,3);
        assert.equal((await send('bookSearch',{query:{title:'='+extraTitle}})).totalFound,0);
        await waitFor(()=>send('admin-reindex'), value=>value.started, 'Reindex did not start');
        const found = await waitFor(()=>send('bookSearch',{query:{title:'='+extraTitle}}), value=>value.totalFound===1,
            'Extra folder did not enter the active index',250);
        const link = await send('get-book-link',{bookUid:found.found[0]._uid});
        const book = await fetch(base+link.link);
        assert.equal(book.status,200);
        assert((await book.text()).includes('Второй источник.'));
        console.log('ok clone, source diagnostics, inactive source, explicit reindex and download from new folder');

        const newOpds = await send('update-admin-opds',{opds:{enabled:true,root:'fixture-opds/',user:'fixture-opds',password:opdsPassword}});
        assert.equal(newOpds.opds.root,'/fixture-opds');
        assert.equal(newOpds.opds.password,'__KEEP__');
        const authorization = 'Basic '+Buffer.from('fixture-opds:'+opdsPassword).toString('base64');
        assert.equal((await fetch(base+'/fixture-opds')).status,401);
        const feed = await fetch(base+'/fixture-opds',{headers:{authorization}});
        assert.equal(feed.status,200);
        assert.match(await feed.text(),/<feed/);
        const jsonFeed = await fetch(base+'/fixture-opds/v2',{headers:{authorization}});
        assert.equal(jsonFeed.status,200);
        assert((await jsonFeed.json()).metadata);
        await send('update-admin-opds',{opds:{enabled:false,password:'__KEEP__'}});
        assert.equal((await fetch(base+'/fixture-opds',{headers:{authorization}})).status,404);
        await send('update-admin-opds',{opds:{enabled:true}});
        assert.equal((await fetch(base+'/fixture-opds',{headers:{authorization}})).status,200);
        console.log('ok live OPDS root, Basic authentication, Atom, OPDS 2, disable and credential reuse');

        const settings = await send('update-admin-integrations',{integrations:{
            telegramShareEnabled:false,telegramBotEnabled:false,telegramBotToken:fakeTelegram,telegramProxyMode:'direct',
            emailShareEnabled:true,smtpHost:'relay',smtpPort:2525,smtpSecure:false,smtpPass:fakeSmtp,
            emailTo:'recipient@example.test',emailFrom:'admin@example.test',
        }});
        assert.equal(settings.integrations.smtpPass,'__KEEP__');
        assert.equal(settings.integrations.telegramBotToken,'__KEEP__');
        assert.match((await request('update-admin-integrations',{integrations:{telegramProxyMode:'custom'}})).error,/хост и порт/);
        const probe = await send('test-admin-integration',{kind:'telegram'});
        assert.equal(probe.checked,'token');
        assert.equal(probe.username,'fixture_delivery_bot');
        assert((await send('test-admin-integration',{kind:'smtp'})).success);
        await send('update-admin-integrations',{integrations:{telegramShareEnabled:true,telegramBotEnabled:true,
            telegramBotToken:'__KEEP__',smtpPass:'__KEEP__'}});
        await waitFor(()=>send('admin-telegram-bot-status'), value=>value.telegramBotStatus.state==='running',
            'Telegram configuration did not start the poller',250);
        assert((await send('test-admin-integration',{kind:'smtp'})).success);
        const mock = await (await fetch(relay+'/state')).json();
        assert.equal(mock.documents.length,0);
        assert.equal(mock.mail.length,0);
        console.log('ok integration hot reload, masked credentials, Telegram getMe and SMTP connection probe');

        const smoke = (await send('bookSearch',{query:{title:'=Packaged smoke book'}})).found[0];
        const rebuild = await send('admin-rebuild-cover',{bookUid:smoke._uid});
        assert(rebuild.rebuilt && rebuild.removed>=1);
        const cover = await fetch(base+rebuild.coverUrl);
        assert.equal(cover.status,200);
        assert.deepEqual(Buffer.from(await cover.arrayBuffer()),png);
        const broken = await send('admin-clean-broken-covers');
        assert(broken.removed>=2,JSON.stringify(broken));
        assert.equal((await send('admin-clean-broken-covers')).removed,0);
        assert.match((await request('update-admin-cache',{cache:{cacheCleanSchedule:'61 0 * * *'}})).error,/cron/);
        const cache = await send('update-admin-cache',{cache:{
            bookCacheSizeMb:1,coverCacheSizeMb:1,cacheCleanTargetPercent:60,cacheCleanSchedule:'30 4 * * mon',
        }});
        assert.equal(cache.cache.bookCacheSize,1024*1024);
        assert.equal(cache.cache.cacheCleanTargetRatio,0.6);
        assert(Date.parse(cache.cache.cacheCleanNextRunAt)>Date.now());
        const clean = await send('admin-clean-cache',{kind:'book'});
        assert.equal(clean.cleaned.length,1);
        assert(clean.cleaned[0].removed>0,JSON.stringify(clean));
        assert(clean.cleaned[0].after<=clean.cleaned[0].targetSize);
        const covers = await send('admin-clean-cache',{kind:'cover'});
        assert(covers.cleaned.every(row=>row.id==='cover' && !row.error));
        await send('admin-clean-cache',{kind:'all'});
        assert.equal((await fetch(base+rebuild.coverUrl)).status,200);
        console.log('ok cover rebuild and repair, cache scope, oldest-file rotation and validated cron');

        const legacy = await legacySettings();
        const rc15 = await legacy.exportAdminSettings();
        assert.equal(rc15.settings.opds.password,undefined);
        const restored = await send('import-admin-settings',{data:rc15});
        assert(restored.success && restored.reindexRequired);
        assert(restored.importedKeys.includes('uiDefaults'));
        assert.equal(restored.settings.opds.root,'/restored-opds');
        assert.equal(restored.settings.opds.password,undefined);
        assert.equal(restored.settings.opds.passwordSet,true);
        assert.equal((await fetch(base+'/restored-opds',{headers:{authorization}})).status,200);
        const overview = await config();
        assert.equal(overview.uiDefaults.limit,47);
        assert.equal(overview.extendedSearch,false);
        assert.equal(overview.adminIntegrations.telegramBotToken,'__KEEP__');
        assert.match((await request('bookSearch',{query:{title:extraTitle}})).error,/extendedSearch disabled/);
        const exported = await send('export-admin-settings');
        assert(Date.parse(exported.exportedAt));
        assert.equal(legacy.normalizeImportedAdminSettings(exported).opds.root,'/restored-opds');
        const raw = JSON.stringify(exported);
        for (const secret of [fakeTelegram,fakeSmtp,opdsPassword,'telegramProxyPassword','smtpPass','telegramBotToken'])
            assert(!raw.includes(secret));
        const invalid = await request('import-admin-settings',{data:{settings:{opds:{root:'/should-not-save'},cacheCleanSchedule:'not cron'}}});
        assert(invalid.error);
        assert.equal((await config()).adminOpds.root,'/restored-opds');
        console.log('ok RC15 settings import/export, UI and routes updated, secrets excluded, invalid import rolled back');
    } finally {
        guest?.close();
        admin.close();
    }
}

async function restart(base) {
    const client = await connect(base);
    try {
        const identity = await signIn(client,'admin',password);
        const result = await client.send('get-config',identity);
        assert.equal(result.adminOpds.root,'/restored-opds');
        assert.equal(result.adminOpds.password,'__KEEP__');
        assert.equal(result.adminIntegrations.smtpPass,'__KEEP__');
        assert.equal(result.adminIntegrations.telegramBotToken,'__KEEP__');
        assert.equal(result.adminCache.cacheCleanSchedule,'30 4 * * mon');
        assert(result.adminLibrarySources.some(source=>source.id==='extra'));
        assert.equal((await client.send('test-admin-integration',{...identity,kind:'telegram'})).username,'fixture_delivery_bot');
        assert((await client.send('test-admin-integration',{...identity,kind:'smtp'})).success);
        const title = await client.send('search',{...identity,from:'title',query:{title:'='+extraTitle,del:'0'}});
        assert.equal(title.totalFound,1,title.error);
        assert.equal(title.found[0].title,extraTitle);
        console.log('ok settings, encrypted credentials and added source retained after container restart');
    } finally { client.close(); }
}

async function browserCheck(base) {
    const {chromium}=require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
    const browser=await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
    try {
        const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
        page.setDefaultTimeout(20000);
        const errors=[];
        const actions=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('websocket',socket=>socket.on('framesent',frame=>{
            try { actions.push(JSON.parse(frame.payload).action); } catch {}
        }));
        await page.addInitScript(()=>{
            if (!localStorage.getItem('vuex'))
                localStorage.setItem('vuex',JSON.stringify({settings:{catalogAppearance:'shelves',defaultsSet:true}}));
        });
        await page.goto(base+'/#/profile');
        await page.getByRole('region',{name:'Текущий профиль'}).getByRole('button',{name:'Войти',exact:true}).click();
        await page.getByRole('textbox',{name:'Логин',exact:true}).fill('admin');
        await page.getByRole('textbox',{name:'Пароль',exact:true}).fill(password);
        await page.getByRole('button',{name:'OK',exact:true}).click();
        await page.locator('.profile-bottom .profile-logout').waitFor();
        await page.locator('.library-shell__header').getByRole('button',{name:'Настройки библиотеки',exact:true}).click();
        await page.getByRole('button',{name:/^Администрирование/}).click();
        await page.locator('.admin-cache-settings-grid').waitFor();
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='Дополнительная папка'));
        assert(actions.includes('get-admin-dashboard'));
        assert.deepEqual(errors,[]);
        console.log('ok settings panel displays saved sources and cache in mobile Chromium');
    } finally { await browser.close(); }
}

const [mode, first, second] = process.argv.slice(2);
const task = mode==='fixture' ? fixture(first,second)
    : mode==='restart' ? restart(first)
    : mode==='browser' ? browserCheck(first)
    : verify(mode,first);
task.catch(error=>{console.error(error);process.exitCode=1;});
