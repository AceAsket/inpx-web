const assert = require('node:assert/strict');
const {once} = require('node:events');
const {chmod,mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,utimes,writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {dirname,join,relative,resolve} = require('node:path');
const express = require('express');
const diagnostics = require('../server/core/DirectoryDiagnostics');
const initHealthRoutes = require('../server/core/HealthRoutes');

async function verifyRoutes(config,expected) {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.assign(Object.create(WebWorker.prototype),{
        config,
        getIndexStatus:async()=>({ready:true}),
        readingListStore:{getDiscoveryMetrics:async()=>({})},
        requireAdmin:async()=>{},
    });
    const dashboard = await worker.buildAdminDashboardMetrics({ready:true},{});
    assert.deepEqual(dashboard.sizes,{db:expected[0],bookCache:expected[1],coverCache:expected[2],tempDir:expected[3]});
    const source = {libDir:config.bookDir};
    assert.deepEqual(await worker.diagnoseLibrarySource('admin','token',source),await diagnostics.source(source));

    const app = express();
    initHealthRoutes(app,config,worker);
    const server = app.listen(0,'127.0.0.1');
    try {
        await once(server,'listening');
        const response = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
        assert.equal(response.status,200);
        const body = await response.text();
        assert(body.includes(`\ninpx_web_db_size_bytes ${expected[0].size}\n`));
        assert(body.includes(`\ninpx_web_book_cache_size_bytes ${expected[1].size}\n`));
        assert(body.includes(`\ninpx_web_cover_cache_size_bytes ${expected[2].size}\n`));
        assert(body.includes(`\ninpx_web_cover_cache_files ${expected[2].files}\n`));
    } finally {
        await new Promise(resolve=>server.close(resolve));
    }
}

async function verifyCleanup(folder) {
    const books = join(folder,'rotate-cache');
    const covers = join(folder,'repair-covers');
    const protectedDir = join(books,'nested');
    await Promise.all([mkdir(protectedDir,{recursive:true}),mkdir(covers)]);
    await writeFile(join(protectedDir,'must-remain'),'nested');
    const worker = Object.assign(Object.create(require('../server/core/WebWorker').prototype),{
        config:{bookDir:books,coverDir:covers,bookCacheSize:15,cacheCleanTargetRatio:2/3},
        addAdminEvent(){},
    });
    const now = new Date();
    const older = new Date(+now-60000);
    for (const [name,time] of [['b.cache',older],['a.cache',older],['старый.cache',new Date(1970,0,2)],['recent.cache',now]]) {
        await writeFile(join(books,name),'12345');
        await utimes(join(books,name),time,time);
    }
    const tied = (await readdir(books)).filter(name=>['a.cache','b.cache'].includes(name));
    const rotation = worker.runCacheClean('scheduled',{kind:'book'});
    assert.deepEqual(await worker.runCacheClean('manual',{kind:'book'}),{skipped:true,reason:'already-running'});
    const [{size,after,found,removed,overLimit,targetSize}] = (await rotation).cleaned;
    assert.deepEqual({size,after,found,removed,overLimit,targetSize},{size:20,after:10,found:4,removed:2,overLimit:true,targetSize:10});
    assert.deepEqual((await readdir(books)).sort(),[tied[1],'nested','recent.cache'].sort());
    assert.equal(await readFile(join(protectedDir,'must-remain'),'utf8'),'nested');
    const passive = await worker.cleanDir({dir:books,maxSize:15,targetSize:5});
    assert.equal(passive.removed,0);
    const forced = await worker.cleanDir({dir:books,maxSize:15,targetSize:5,forceTarget:true});
    assert.equal(forced.removed,1);
    assert.equal(forced.after,5);
    assert.equal(forced.overLimit,false);
    const disabled = await worker.cleanDir({dir:books,maxSize:null,forceTarget:true});
    assert.equal(disabled.exists,false);
    assert.equal(await readFile(join(books,'recent.cache'),'utf8'),'12345');

    await writeFile(join(covers,'good.JPG'),'pic');
    await writeFile(join(covers,'empty.jpg'),'');
    await writeFile(join(covers,'unsupported.webp'),'unused');
    await mkdir(join(covers,'folder.jpg'));
    await writeFile(join(covers,'folder.jpg','keep.dat'),'must stay');
    if (process.platform==='win32') await chmod(join(covers,'unsupported.webp'),0o444);
    else {
        await symlink(join(protectedDir,'must-remain'),join(covers,'external.tmp'));
        await symlink(join(folder,'missing'),join(covers,'dangling.tmp'));
        const invalid = worker.cleanDir({dir:covers,maxSize:0});
        await assert.rejects(invalid,/dangling\.tmp/);
        assert.equal(await readFile(join(covers,'good.JPG'),'utf8'),'pic');
    }
    const repair = await worker.cleanBrokenCoverCacheFiles(covers);
    const link = process.platform==='win32' ? 0 : 1;
    assert.deepEqual(repair,{dir:covers,checked:3+link,removed:2+link});
    assert.equal(await readFile(join(protectedDir,'must-remain'),'utf8'),'nested');
    assert.equal(await readFile(join(covers,'folder.jpg','keep.dat'),'utf8'),'must stay');
    assert.equal(await readFile(join(covers,'good.JPG'),'utf8'),'pic');
}

async function verify(folder,binary) {
    const config = {dataDir:folder,bookDir:join(folder,'Книги'),coverDir:join(folder,'covers'),
        tempDir:join(folder,'temp'),metricsEnabled:true,server:{ready:true}};
    const db = join(folder,'db');
    await Promise.all([db,config.coverDir,config.tempDir,join(config.bookDir,'z'),join(config.bookDir,'A'),
        join(config.bookDir,'etc')].map(path=>mkdir(path,{recursive:true})));
    const inpx = join(config.bookDir,'Флибуста.INPX');
    const books = [inpx,join(config.bookDir,'.inpx'),join(config.bookDir,'etc','annotations.ZIP'),
        join(config.bookDir,'A','1.7z'),join(config.bookDir,'z','2.FB2'),join(config.bookDir,'z','3.EPub')];
    for (let n=0;n<24;n++) books.push(join(config.bookDir,n%2 ? 'z' : 'A',`catalogue-${n}.inpx`));
    for (const [index,file] of [join(db,'lookup.redb'),join(config.coverDir,'sample.jpg'),...books].entries())
        await writeFile(file,Buffer.alloc(index+1));
    await symlink(join(config.bookDir,'A'),join(config.bookDir,'linked-A'),process.platform==='win32' ? 'junction' : 'dir');
    if (process.platform!=='win32') {
        await symlink(inpx,join(config.bookDir,'linked.inpx'));
        await symlink(join(folder,'nonexistent'),join(config.bookDir,'missing.zip'));
    }
    const directories = [
        {path:`${folder}/db`},{path:config.bookDir},{path:config.coverDir},{path:config.tempDir,maxFiles:5000},
        {path:config.bookDir,maxFiles:1},{path:config.bookDir,maxFiles:7},{path:join(folder,'missing')},
        {path:inpx},{path:''},{},
    ];
    const source = {libDir:relative(process.cwd(),config.bookDir),inpxFile:` ${inpx} `};
    const oldBinary = process.env.INPX_RUST_CATALOG_BINARY;
    delete process.env.INPX_RUST_CATALOG_BINARY;
    const expected = await diagnostics.sizes(directories);
    const expectedSource = await diagnostics.source(source);
    assert.equal(expectedSource.foundInpx.length,20);
    assert.equal(expectedSource.archiveCount,process.platform==='win32' ? 4 : 5);
    assert.equal(expectedSource.inpxExists,true);
    assert.equal(expectedSource.hasEtc,true);
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    const stop = diagnostics.start({lazy:false});
    try {
        assert.deepEqual(await diagnostics.sizes(directories),expected);
        assert.deepEqual(await diagnostics.source(source),expectedSource);
        assert.equal((await diagnostics.source({})).libDirExists,false);
        assert.equal((await diagnostics.source({libDir:inpx})).libDirExists,true);
        assert.deepEqual(await diagnostics.source({libDir:inpx}),{...expectedSource,inpxExists:false,foundInpx:[],
            archiveCount:0,archiveCountTruncated:false,hasEtc:false});
        await verifyRoutes(config,expected);
        await verifyCleanup(folder);

        const cycle = join(folder,'cycle');
        await mkdir(cycle);
        await writeFile(join(cycle,'book.fb2'),'book');
        await symlink(cycle,join(cycle,'parent'),process.platform==='win32' ? 'junction' : 'dir');
        assert.deepEqual((await diagnostics.sizes([{path:cycle}]))[0],{path:cycle,exists:true,size:4,files:1,truncated:false});
    } finally {
        await stop();
        if (oldBinary === undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY = oldBinary;
    }
}

async function main(binary) {
    if (!binary) throw new Error('Usage: node scripts/rust-directory-diagnostics-tests.js <inpx-catalog>');
    binary = resolve(binary);
    const root = await realpath(tmpdir());
    const folder = await mkdtemp(join(root,'inpx-directory-diagnostics-'));
    const cwd = process.cwd();
    try {
        await new (require('../server/core/AppLogger'))().init({dataDir:folder,loggingEnabled:false});
        process.chdir(folder);
        await verify(folder,binary);
    } finally {
        process.chdir(cwd);
        assert.equal(dirname(await realpath(folder)),root);
        await rm(folder,{recursive:true,force:true});
    }
    console.log('Rust directory diagnostics, admin metrics, cache rotation and cover repair passed');
}

main(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
