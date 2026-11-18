const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join,basename,dirname,resolve} = require('node:path');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const {docker,until,initial} = require('./rust-inpx-filter-tests');

async function main(rust, rc15, input, artifacts) {
    assert(input && rc15 && rust,'Usage: node scripts/rust-migration-browser-test.js <rust-image> <rc15-image> <large.inpx> [artifacts]');
    const dir = await fs.mkdtemp(join(tmpdir(),'inpx-migration-ui-'));
    const prefix = 'inpx-migration-ui-'+process.pid;
    const sources = ['Основная','Дополнительная'].map((name,i)=>({
        id:'s'+i, name, type:'inpx', libDir:'/source'+i, inpx:'/source'+i+'/'+basename(input),
    }));
    let browser;
    try {
        await fs.writeFile(join(dir,'config.json'),JSON.stringify({dataDir:'/data',
            server:{host:'0.0.0.0',port:12380,root:'/library'}, librarySources:sources,
            inpxCheckInterval:0,inpxFilterFile:'/data/filter.json',loggingEnabled:false}));
        await fs.writeFile(join(dir,'filter.json'),JSON.stringify({includeAuthors:initial.includeAuthors}));
        await docker('volume','create',prefix);
        const data = ['--mount','type=volume,source='+prefix+',target=/data'];
        await docker('run','--rm',...data,'--mount','type=bind,source='+dir+',target=/fixture,readonly',
            '--entrypoint','sh',rc15,'-ec','cp /fixture/*.json /data/');
        const start = async(name,image) => {
            await docker('run','-d','--name',name,'-p','127.0.0.1::12380',...data,
                ...sources.flatMap(s=>['--mount','type=bind,source='+dirname(resolve(input))+',target='+s.libDir+',readonly']),
                '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false','-e','INPX_ALLOW_ANONYMOUS_ACCESS=true',
                image,'--data-dir=/data','--admin-password=migration-test-password');
            return 'http://'+await docker('port',name,'12380/tcp');
        };
        const before = await start(prefix+'-old',rc15);
        await until(()=>fetch(before+'/ready').then(r=>r.ok).catch(()=>false),Boolean,'RC15 index',360);
        await docker('stop',prefix+'-old');
        await docker('run','--rm',...data,'--entrypoint','sh',rc15,'-ec','test -d /data/db/book');
        browser = await chromium.launch({headless:true});
        const page = await browser.newPage({viewport:{width:850,height:620}});
        const base = await start(prefix+'-new',rust);
        const url = base+'/library/#/books';
        await until(()=>fetch(base+'/health').then(r=>r.ok).catch(()=>false),Boolean,'Rust health');
        assert.equal((await fetch(base+'/ready')).status,503);
        await page.goto(url);
        const seen = [];
        for (const [i,source] of sources.entries()) {
            await page.waitForFunction(name=>document.getElementById('source')?.textContent===name &&
                Number(document.getElementById('progress').value)>0 && document.getElementById('records').textContent,
                source.name,{timeout:240000});
            assert.equal(await page.locator('h1').textContent(),'Перенос каталога на Rust');
            seen.push({source:source.name, records:await page.locator('#records').textContent(),
                parts:await page.locator('#parts').textContent(),elapsed:await page.locator('#elapsed').textContent()});
            if (artifacts) {
                await fs.mkdir(artifacts,{recursive:true});
                await page.screenshot({path:join(artifacts,'migration-'+(i+1)+'.png')});
            }
            if (i === 0) {
                const seconds = (await (await fetch(base+'/api/index-status')).json()).elapsedSeconds;
                await page.reload();
                await page.getByRole('heading',{name:'Перенос каталога на Rust'}).waitFor();
                const next = await (await fetch(base+'/api/index-status')).json();
                assert(next.elapsedSeconds>=seconds && next.ready===false);
            }
        }
        const number = text=>Number(text.replace(/\s/g,''));
        assert(number(seen[1].records)>number(seen[0].records),'Live record count must increase between sources');
        await until(()=>fetch(base+'/ready').then(r=>r.ok).catch(()=>false),Boolean,'Published Rust index',360);
        await page.locator('.library-shell__nav').waitFor({timeout:60000});
        assert.equal(await page.locator('body').getAttribute('data-catalog-appearance'),'shelves');
        assert.equal(new URL(page.url()).hash.split('?')[0],'#/books');
        const report = {sources:seen, reload:true, automaticCatalogue:true, appearance:'shelves'};
        if (artifacts) await fs.writeFile(join(artifacts,'migration.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify(report));
    } finally {
        if (browser) await browser.close();
        for (const name of [prefix+'-old',prefix+'-new']) await docker('rm','-fv',name).catch(()=>{});
        await docker('volume','rm',prefix).catch(()=>{});
        await fs.rm(dir,{recursive:true,force:true});
    }
}
main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
