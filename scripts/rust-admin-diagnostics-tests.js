const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {once} = require('node:events');
const {gzipSync} = require('node:zlib');
const {ZipFile} = require('yazl');
const {connect, signIn, waitFor} = require('./rust-events-tests');

const password = 'rust-diagnostics-admin';
const title = 'Книга проверки библиотеки';

async function zip(entries) {
    const archive = new ZipFile();
    const chunks = [];
    archive.outputStream.on('data', chunk => chunks.push(chunk));
    const done = once(archive.outputStream,'end');
    for (const [name,content] of entries) archive.addBuffer(Buffer.from(content),name);
    archive.end();
    await done;
    return Buffer.concat(chunks);
}

async function fixture(directory) {
    await fs.mkdir(directory,{recursive:true});
    const fb2 = content => '<FictionBook><description><title-info><book-title>'+title+
        '</book-title><lang>ru</lang></title-info></description><body><section>'+content+'</section></body></FictionBook>';
    const valid = fb2('<p>Короткий текст для проверки.</p>');
    const invalid = '<FictionBook><body></FictionBook>';
    const long = fb2('<p>Повторяемый фрагмент для проверки отмены.</p>'.repeat(4000));
    const epub = await zip([
        ['META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'],
        ['OPS/book.opf','<package><metadata><title>EPUB для проверки</title></metadata></package>'],
    ]);
    const brokenEpub = await zip([['META-INF/container.xml','<container><rootfiles><rootfile full-path="../missing.opf"/></rootfiles></container>']]);
    const row = (name, entry, size, id, ext = 'fb2', deleted = 0) =>
        ['Автор,Тестовый:','sf:',name,'',0,entry,size,id,deleted,ext,'2026-11-17','ru',0,''].join('\x04');
    const members = [
        row(title,1,Buffer.byteLength(valid),1),
        row('Нет записи в ZIP',99,1,2),
        row('Повреждённый FB2',2,Buffer.byteLength(invalid),3),
        row('Сжатый FB2',3,Buffer.byteLength(valid),4),
        row('Корректный EPUB',4,epub.length,5,'epub'),
        row('Повреждённый EPUB',5,brokenEpub.length,6,'epub'),
        row('Удалённая книга',99,1,7,'fb2',1),
        row('Пропущенный PDF',6,8,8,'pdf'),
        ...Array.from({length:1300},(_,index)=>row('Учебная книга '+index,7,Buffer.byteLength(long),index+100)),
    ];
    await fs.writeFile(path.join(directory,'audit.inpx'),await zip([
        ['collection.info','Тест диагностики\n'],
        ['audit.inp',members.join('\n')+'\n'],
        ['missing.inp',row('Нет исходного архива',1,1,2000)+'\n'],
    ]));
    await fs.writeFile(path.join(directory,'audit.zip'),await zip([
        ['1.fb2',valid],['2.fb2',invalid],['3.fb2',gzipSync(valid)],['4.epub',epub],
        ['5.epub',brokenEpub],['6.pdf','%PDF-1.5'],['7.fb2',long],
    ]));
}

function command(client, identity) {
    return async (name, fields = {}) => {
        const result = await client.send(name,{...identity,...fields});
        assert.equal(result.error || '', '', name+': '+result.error);
        return result;
    };
}

async function verify(base) {
    const admin = await connect(base);
    const operator = await connect(base);
    const guest = await connect(base);
    try {
        const identity = await signIn(admin,'admin',password);
        const send = command(admin,identity);
        const operatorIdentity = await signIn(operator,'admin',password);
        const operate = command(operator,operatorIdentity);
        assert(admin.config.clientApi.features.includes('adminDashboard'));
        await send('create-user-profile',{profile:{login:'diagnostic-reader',name:'Читатель',password}});
        const reader = await signIn(guest,'diagnostic-reader',password);
        for (const action of [
            'start-library-audit','cancel-library-audit','get-admin-dashboard','get-admin-dashboard-metrics',
            'get-admin-performance','start-admin-benchmark','cancel-admin-benchmark','get-admin-events',
            'update-admin-event-log','add-admin-test-event',
        ]) assert.match((await guest.send(action,reader)).error,/администратора/);
        assert.equal((await admin.send('start-library-audit',{...identity,csrfToken:'bad'})).error,'bad_csrf_token');

        const info = await send('get-admin-dashboard');
        assert(info.generatedAt && info.index.ready);
        assert(info.stats.bookCountAll>=1308);
        assert(info.memory.rss>0);
        assert(info.sizes.db.files>0);
        assert(info.activity.totals.logins>=3);
        assert(info.runtime.totalActions>=10);
        assert.equal(info.sources.length,1);
        assert(info.sources[0].inpxExists && info.sources[0].libDirExists && info.sources[0].archiveCount>=1);
        const sourceId = info.sources[0].id;
        const uid = (await send('bookSearch',{query:{title:'='+title}})).found[0]._uid;
        const link = await send('get-book-link',{bookUid:uid});
        const book = await fetch(base+link.link,{headers:{cookie:admin.cookie}});
        assert.equal(book.status,200);
        await book.arrayBuffer();
        const live = await waitFor(()=>send('get-admin-dashboard-metrics'), row=>row.activity.totals.downloads>0, 'HTTP download not reflected in dashboard');
        assert(live.uptime>=info.uptime && live.runtime.totalActions>info.runtime.totalActions);
        assert(live.cpu.userSeconds>=0 && live.cpu.systemSeconds>=0);
        assert.equal(live.sources,undefined);
        console.log('ok diagnostic commands scoped to the admin, dashboard sources, live CPU, storage and activity');

        const tasks = ()=>send('get-background-tasks');
        const finished = state => waitFor(tasks, row=>row.audit?.state===state, 'Audit did not reach '+state,700);
        const first = await send('start-library-audit',{options:{deep:false}});
        assert(first.audit.running);
        const shallow = (await finished('completed')).audit;
        assert.equal(shallow.checked,shallow.total);
        assert.equal(shallow.missing,2);
        assert.equal(shallow.damaged,0);
        const deep = await send('start-library-audit',{options:{deep:true}});
        assert(deep.audit.running && deep.audit.deep);
        await waitFor(tasks,result=>result.audit.checked>0 && result.tasks.some(task=>task.kind==='audit' && task.state==='running'),
            'Live audit progress was not visible');
        const search = await send('bookSearch',{query:{title:'='+title}});
        assert.equal(search.totalFound,1);
        const report = (await finished('completed')).audit;
        assert.equal(report.checked,report.total);
        assert.equal(report.damaged,2);
        assert.equal(report.missing,2);
        assert.equal(report.skipped,2);
        assert(report.issues.some(item=>item.title==='Повреждённый FB2' && item.kind==='damaged'));
        assert(report.issues.some(item=>item.title==='Повреждённый EPUB' && item.kind==='damaged'));
        const restricted = await command(guest,reader)('get-background-tasks');
        assert.equal(restricted.audit,null);
        assert(!restricted.tasks.some(task=>['audit','benchmark'].includes(task.kind)));
        await send('start-library-audit',{options:{deep:true}});
        assert.equal((await send('cancel-library-audit')).audit.state,'cancelling');
        assert.equal((await finished('cancelled')).audit.error,'Проверка отменена');
        await operate('start-library-audit',{options:{deep:true}});
        await operate('logout-user-profile');
        const revoked = (await finished('cancelled')).audit;
        assert.match(revoked.error,/отозваны/);
        console.log('ok shallow and deep audit, missing and damaged books, live progress, cancel and session revocation');

        const performance = ()=>send('get-admin-performance');
        const pending = await performance();
        assert(pending.databaseCache.available && pending.databaseCache.engine==='redb');
        assert(pending.settings.native);
        assert.deepEqual(pending.settings.profiles.map(p=>p.id), ['economy','balanced','performance','unlimited']);
        assert(pending.machine.cpu>0);
        assert.match((await admin.send('start-admin-benchmark',{...identity,options:{mode:'profile',profileId:'missing'}})).error,/профиль/);
        assert.match((await admin.send('start-admin-benchmark',{...identity,options:{mode:'custom',limits:{total:2,images:1,reviews:3,conversions:1}}})).error,/лимит/);
        const start = await send('start-admin-benchmark',{options:{sourceId,mode:'compare'}});
        assert(start.job.state==='running' && start.job.candidates.length===3);
        const completed = await waitFor(performance,row=>row.job?.state==='completed','No benchmark report',500);
        assert.equal(completed.report.rows.length,3);
        assert.equal(completed.report.engine,'rust');
        assert.equal(completed.report.stale,false);
        assert.equal(completed.report.source.id,sourceId);
        assert(completed.report.coverage.includes('Проверка содержимого FB2/EPUB'));
        assert(completed.report.rows.every(row=>row.completed && row.elapsedMs>0 && row.probeSamples>=5 && row.probeP95Ms>=0 && row.peakMemory>0));
        await send('start-admin-benchmark',{options:{sourceId,mode:'custom',limits:{total:2,images:1,reviews:2,conversions:1}}});
        assert.equal((await send('cancel-admin-benchmark')).job.state,'cancelling');
        const cancelled = await waitFor(performance,row=>row.job?.state==='cancelled','Benchmark was not cancelled');
        assert.equal(cancelled.report.measuredAt,completed.report.measuredAt);
        const reauthenticated = command(operator,await signIn(operator,'admin',password));
        await reauthenticated('start-admin-benchmark',{options:{sourceId,mode:'compare'}});
        await reauthenticated('logout-user-profile');
        const benchRevoked = await waitFor(performance,row=>row.job?.state==='cancelled','Benchmark did not stop after revocation');
        assert.match(benchRevoked.job.message,/отозваны/);
        console.log('ok resource measurements, comparison, custom limits, cancellation and revocation retain previous report');

        const events = options=>send('get-admin-events',{options});
        const policy = await send('update-admin-event-log',{options:{enabled:true,maxSize:20}});
        assert.deepEqual([policy.enabled,policy.maxSize],[true,20]);
        assert((await events({category:'benchmark'})).events.some(row=>row.message.includes('завершена')));
        for (let i=0;i<24;i++) await send('add-admin-test-event',{level:i%2?'warn':'error'});
        const latest = await events({level:'error',category:'system',limit:2});
        assert.equal(latest.events.length,2);
        assert(latest.events.every(row=>row.level==='error' && row.category==='system' && row.message.includes('Admin event log test')));
        assert.equal((await events({})).events.length,20);
        const prometheus = await (await fetch(base+'/metrics')).text();
        assert.match(prometheus,/inpx_web_admin_events_total\{level="error",category="system"\} 10/);
        await send('update-admin-event-log',{options:{enabled:false,maxSize:23}});
        await send('add-admin-test-event',{level:'error'});
        const disabled = await events({});
        assert.equal(disabled.enabled,false);
        assert.equal(disabled.maxSize,23);
        assert.deepEqual(disabled.events,[]);
        console.log('ok journal events, filtering, retention, disable and Prometheus samples');
    } finally {
        admin.close();
        operator.close();
        guest.close();
    }
}

async function restart(base) {
    const client = await connect(base);
    try {
        const send = command(client,await signIn(client,'admin',password));
        const events = await send('get-admin-events');
        assert.equal(events.enabled,false);
        assert.equal(events.maxSize,23);
        const loaded = await send('get-admin-performance');
        assert.equal(loaded.report.rows.length,3);
        assert.equal(loaded.report.stale,false);
        assert.equal(loaded.job,null);
        await send('update-admin-event-log',{options:{enabled:true,maxSize:23}});
        console.log('ok journal policy and benchmark report survive restart');
    } finally { client.close(); }
}

async function browser(base) {
    const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
    const instance = await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
    try {
        const page = await instance.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
        page.setDefaultTimeout(20000);
        const errors = [];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(base+'/#/profile');
        await page.getByRole('region',{name:'Текущий профиль'}).getByRole('button',{name:'Войти',exact:true}).click();
        await page.getByRole('textbox',{name:'Логин',exact:true}).fill('admin');
        await page.getByRole('textbox',{name:'Пароль',exact:true}).fill(password);
        await page.getByRole('button',{name:'OK',exact:true}).click();
        await page.locator('.profile-bottom .profile-logout').waitFor();
        await page.locator('.library-shell__header').getByRole('button',{name:'Настройки библиотеки',exact:true}).click();
        await page.getByRole('button',{name:/^Администрирование/}).click();
        await page.getByRole('heading',{name:'Действует на сервере'}).waitFor();
        await page.getByTestId('performance-active').waitFor();
        await page.getByTestId('performance-result').waitFor();
        await page.getByText('RSS Rust:',{exact:false}).waitFor();
        await page.getByTestId('performance-start').click();
        await page.getByRole('button',{name:'Остановить',exact:true}).waitFor();
        await page.getByText('Проверка завершена',{exact:true}).waitFor();
        assert.deepEqual(errors,[]);
        console.log('ok admin dashboard and measured performance result in mobile Chromium');
    } finally { await instance.close(); }
}

const [mode, value] = process.argv.slice(2);
const operations = {fixture,verify,restart,browser};
if (require.main===module) operations[mode](value).catch(error=>{console.error(error);process.exitCode=1;});
