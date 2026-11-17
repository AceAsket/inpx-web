const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {dirname, basename, join, resolve} = require('node:path');
const {tmpdir} = require('node:os');
const {setTimeout:sleep} = require('node:timers/promises');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const JembaDb = require('jembadb/src/JembaDb');
const {connect,signIn} = require('./rust-events-tests');

const run = promisify(execFile);
const password = 'inpx-filter-test-admin';
const initial = {
    filter:'(inpxRec) => inpxRec.del == 0',
    includeAuthors:['ауренга','Ауренга,Кимури Мария','Еськов Кирилл Юрьевич',
        'Клайн Барбара Ловетт','Булгаков Михаил Афанасьевич'],
    info:{collection:'RC15 INPX filter comparison',version:'initial'},
};
const changed = {
    ...initial,
    filter:`function (row) {
        return row['del'] == 0 && row.sourceId === 'main' &&
            ['fb2', 'epub'].includes(row.ext) && row.lang &&
            row.lang.toLowerCase() === 'ru' && row.title && row.title.trim().length > 2;
    }`,
    excludeAuthors:['КиМуРи МаРиЯ','Еськов Кирилл Юрьевич'],
    info:{...initial.info,version:'reindexed'},
};
const complex = {
    ...changed,
    filter:String.raw`(() => {
        const language = new RegExp('^ru$', 'iu');
        const formats = /^(fb2|epub)$/u;
        const wanted = [/мастер|маргарит/iu, /(?<![а-яё])(?:роман|повесть|рассказ)\p{L}*(?![а-яё])/iu,
            /^театр/iu, /\b(\d+)\s*[-–]\s*\1\b/u];
        return function (row) {
            if (row.del != 0 || row.sourceId !== 'main' || !formats.test(row.ext) || !language.test(row.lang))
                return false;
            const title = (row.title || '').trim();
            if (title.length <= 2) return false;
            for (const part of title.split(/\s*[:—]\s*/u)) {
                let index = 0;
                while (index < wanted.length) {
                    if (wanted[index++].test(part)) return true;
                }
            }
            return false;
        };
    })()`,
    info:{...initial.info,version:'complex-regex-loops'},
};

async function docker(...args) {
    return (await run('docker',args,{timeout:40000,windowsHide:true})).stdout.trim();
}

async function until(read, evaluate, message, seconds = 210) {
    const limit = Date.now()+seconds*1000;
    while (Date.now()<limit) {
        const item = await read();
        if (evaluate(item)) return item;
        await sleep(500);
    }
    assert.fail(message);
}

async function writeFilter(file, rule) {
    await fs.writeFile(file+'.next',JSON.stringify(rule));
    await fs.rename(file+'.next',file);
}

async function start(name, image, source, rules, snapshotDirectory) {
    await docker('run','-d','--name',name,'--tmpfs','/data','-p','127.0.0.1::12380',
        '-e','INPX_AUTH_MODE=local','-e','INPX_REQUIRE_AUTH=false','-e','INPX_ALLOW_ANONYMOUS_ACCESS=true',
        '--mount','type=bind,source='+dirname(source)+',target=/library,readonly',
        '--mount','type=bind,source='+rules+',target=/rules,readonly',
        ...(snapshotDirectory?['--mount','type=bind,source='+snapshotDirectory+',target=/snapshots']:[]),image,
        'sh','-ec','cp /rules/config.json /data/config.json; exec inpx-web "$@"','test',
        '--data-dir=/data','--host=0.0.0.0','--port=12380','--lib-dir=/library',
        '--inpx=/library/'+basename(source),'--admin-password='+password,'--unsafe-filter');
    const origin = 'http://'+await docker('port',name,'12380/tcp');
    await until(async()=>{
        try {
            const response = await fetch(origin+'/ready',{signal:AbortSignal.timeout(1500)});
            await response.body.cancel();
            return response.ok;
        } catch { return false; }
    },Boolean,name+' did not become ready');
    const client = await connect(origin);
    const identity = await signIn(client,'admin',password);
    return {
        close:client.close,
        name,
        origin,
        send:(action, payload)=>client.send(action,{...identity,...payload}),
    };
}

async function config(client, version) {
    const response = await until(
        ()=>client.send('get-config').catch(()=>null),
        response=>response?.dbConfig?.inpxInfo?.version===version && response.dbConfig.inpxHash,
        'Catalogue did not load filter version '+version,
    );
    return response.dbConfig;
}

async function legacyRows(name, directory) {
    await fs.mkdir(directory);
    await docker('exec',name,'cp','-R','/data/db/book','/snapshots/'+basename(directory)+'/book');
    const db = new JembaDb();
    try {
        await db.lock({dbPath:directory,softLock:true});
        await db.open({table:'book'});
        return await db.select({table:'book'});
    } finally {
        await db.unlock();
    }
}

async function rustRows(name, fields) {
    const metadata = JSON.parse(await docker('exec',name,'cat','/data/db/catalogue.json'));
    const request = {id:1,op:'scan',limit:4096,generation:metadata.rustBookStoreGeneration,fields};
    const reply = JSON.parse(await docker('exec',name,'sh','-ec',
        'printf "%s\\n" "$1" | /usr/local/bin/bin/inpx-catalog store /data/db',
        'test',JSON.stringify(request)));
    assert.equal(reply.error,undefined);
    assert.equal(reply.result.after,null);
    return reply.result.rows;
}

async function contents(client, version, legacyDirectory) {
    const db = await config(client,version);
    assert.equal(db.inpxInfo.collection,initial.info.collection);
    const expected = db.stats.bookCount;
    assert(expected>0 && expected<1000,'Expected a small filtered catalogue, got '+expected);
    assert.equal(db.stats.bookDelCount,0);
    const fields = ['_uid','folder','file','ext','author','title','series','lang','del','insno'];
    const rows = legacyDirectory
        ? await legacyRows(client.name,legacyDirectory)
        : await rustRows(client.name,['id',...fields]);
    assert.equal(rows.length,expected);
    const records = rows.map(row=>JSON.stringify(fields.map(field=>row[field]??null))).sort();
    assert.equal(new Set(records).size,expected);
    const digest = createHash('sha256').update(records.join('\n')).digest('hex');
    return {count:expected, rows, records, digest, hash:db.inpxHash};
}

async function reindex(client) {
    const result = await client.send('admin-reindex');
    assert.equal(result.error || '','');
    assert.equal(result.started,true);
}

function compare(label, legacy, rust) {
    assert.deepEqual(rust.records,legacy.records);
    assert.equal(rust.hash,legacy.hash);
    console.log(JSON.stringify({stage:label,count:rust.count,booksSha256:rust.digest,indexHash:rust.hash}));
}

async function failedFilter(client, file, filter, error) {
    const failures = async()=>{
        const result = await run('docker',['logs',client.name],{timeout:7000});
        return result.stderr.split('\n').filter(line=>line.includes('Index update failed:'));
    };
    const before = (await failures()).length;
    await writeFilter(file,{...complex,filter});
    await reindex(client);
    const after = await until(failures,entries=>entries.length>before,'Rust did not report a failed filter',30);
    assert.match(after.at(-1),error);
    const status = await until(async()=>{
        const response = await fetch(client.origin+'/api/index-status',{signal:AbortSignal.timeout(5000)});
        return response.json();
    },status=>status.ready && status.error,'Rust did not keep the previous catalogue ready after a rule error',10);
    assert.equal(status.updating,false);
}

async function main(rustImage, rc15Image, inpx) {
    assert(rustImage && rc15Image && inpx,
        'Usage: node scripts/rust-inpx-filter-tests.js <rust-image> <rc15-image> <library.inpx>');
    const source = resolve(inpx);
    const directory = await fs.mkdtemp(join(tmpdir(),'inpx-filter-comparison-'));
    const prefix = 'inpx-filter-'+process.pid;
    const names = [prefix+'-rc15',prefix+'-rust'];
    const clients = [];
    try {
        const sourceDigest = createHash('sha256').update(await fs.readFile(source)).digest('hex');
        const prepare = async label=>{
            const dir = join(directory,label);
            await fs.mkdir(dir);
            await fs.writeFile(join(dir,'config.json'),JSON.stringify({
                inpxFilterFile:'/rules/filter.json',inpxCheckInterval:0,loggingEnabled:false,
                allowAnonymousAccess:true,server:{host:'0.0.0.0',port:'12380',root:''},
            }));
            await writeFilter(join(dir,'filter.json'),initial);
            return dir;
        };
        const [oldRules,newRules] = await Promise.all(['rc15','rust'].map(prepare));
        const legacy = await start(names[0],rc15Image,source,oldRules,directory);
        clients.push(legacy);
        const beforeLegacy = await contents(legacy,'initial',join(directory,'rc15-initial-db'));
        console.log(JSON.stringify({stage:'rc15-ready',sourceSha256:sourceDigest,count:beforeLegacy.count}));
        await until(()=>docker('image','inspect',rustImage,'--format','{{.Id}}').catch(()=>''),Boolean,
            'Rust image did not finish building',600);
        const rust = await start(names[1],rustImage,source,newRules);
        clients.push(rust);
        const beforeRust = await contents(rust,'initial');
        compare('first-index',beforeLegacy,beforeRust);
        assert(beforeRust.rows.some(row=>row.author.includes('Кимури Мария')));

        await Promise.all([oldRules,newRules].map(dir=>writeFilter(join(dir,'filter.json'),changed)));
        await Promise.all([legacy,rust].map(reindex));
        const [afterLegacy,afterRust] = await Promise.all([
            contents(legacy,'reindexed',join(directory,'rc15-reindexed-db')),
            contents(rust,'reindexed'),
        ]);
        compare('live-reindex',afterLegacy,afterRust);
        assert(afterRust.count<beforeRust.count);
        for (const row of afterRust.rows) {
            assert(!['Еськов Кирилл Юрьевич','Кимури Мария'].some(author=>row.author.split(',').includes(author)));
            assert.equal(row.lang.toLowerCase(),'ru');
        }
        const ids = new Map(beforeRust.rows.map(row=>[row._uid,row.id]));
        assert(afterRust.rows.every(row=>ids.get(row._uid)===row.id),'Retained Rust IDs changed during reindex');

        await Promise.all([oldRules,newRules].map(dir=>writeFilter(join(dir,'filter.json'),complex)));
        await Promise.all([legacy,rust].map(reindex));
        const [complexLegacy,complexRust] = await Promise.all([
            contents(legacy,complex.info.version,join(directory,'rc15-complex-db')),
            contents(rust,complex.info.version),
        ]);
        compare('complex-live-reindex',complexLegacy,complexRust);
        assert(complexRust.count<afterRust.count);
        assert(complexRust.rows.every(row=>ids.get(row._uid)===row.id));

        const filterFile = join(newRules,'filter.json');
        for (const [rule,error] of [
            ['row => /[/.test(row.title)',/Некорректное правило filter INPX/],
            ['row => { while (true) {} }',/interrupted/i],
            ['row => /^(a+)+$/.test("a".repeat(10000) + "!")',/interrupted/i],
            ['row => process.version',/process.*not defined/i],
        ]) {
            await failedFilter(rust,filterFile,rule,error);
            const retained = await contents(rust,complex.info.version);
            assert.equal(retained.hash,complexRust.hash);
            assert.equal(retained.digest,complexRust.digest);
        }
        assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'),sourceDigest);
        console.log('ok syntax errors, loop and regex deadlines, and missing Node.js globals leave the ready catalogue and INPX intact');
    } catch (error) {
        for (const name of names) {
            const logs = await run('docker',['logs','--tail','32',name],{timeout:7000}).catch(()=>null);
            if (logs) console.error(name,logs.stdout+logs.stderr);
        }
        throw error;
    } finally {
        for (const client of clients) client.close();
        for (const name of names) await docker('rm','-f',name).catch(()=>{});
        await fs.rm(directory,{recursive:true,force:true});
    }
}

if (require.main === module) {
    main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
}

module.exports = {docker, until, legacyRows, rustRows, initial};
