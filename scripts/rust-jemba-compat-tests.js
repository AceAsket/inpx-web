const assert = require('node:assert/strict');
const {hash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createWriteStream} = require('node:fs');
const {pipeline} = require('node:stream/promises');
const JembaDb = require('jembadb/src/JembaDb');
const RustTableBuilder = require('../server/core/RustTableBuilder');
const readBookIdentities = require('../server/core/RustIdentityReader');
const DbCreator = require('../server/core/DbCreator');
const {buildIndexInWorker} = require('../server/core/IndexBuilder');

async function checkBooks(binary, directory, db) {
    const rawLast = {_uid:'three', title:'Последняя запись', sourceId:'fixture', folder:'a\\Б.zip', file:'123', ext:'FB2', insno:-3};
    const rows = [
        {id:1, _uid:'one', title:'Ф'.repeat(350000)},
        {id:2, _uid:'two', title:'Я'.repeat(350000)},
        {...rawLast, _recordHash:hash('sha256', JSON.stringify(rawLast), 'hex'), id:3},
    ];
    const writer = await RustTableBuilder.open(binary, path.join(directory, 'book'), 'build-book');
    try {
        await writer.append([
            ...rows.slice(0, 2).map(row => JSON.stringify([row.id, row._uid, row]) + '\n'),
            JSON.stringify([3,'three',rawLast,true]) + '\n',
        ]);
        await writer.finish(rows.length);
    } finally {await writer.close();}

    await db.open({table:'book'});
    assert.deepEqual(await db.select({table:'book'}), rows);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'three')"}), [rows[2]]);
    await db.delete({table:'book', where:'@@id(1)'});
    const changed = {...rows[2], title:'Обновлено'};
    const added = {id:4, _uid:'four', title:'Добавлено', sourceId:'fixture', libid:'444', sourcelib:'lib', ext:'Ğ'};
    await db.insert({table:'book', rows:[changed, added], replace:true});
    await db.close({table:'book'});
    await db.open({table:'book'});
    assert.deepEqual(await db.select({table:'book', sort:'(a,b)=>a.id-b.id'}), [rows[1], changed, added]);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'one')"}), []);
    assert.deepEqual(await db.select({table:'book', where:"@@hash('_uid', 'four')"}), [added]);
    const creator = new DbCreator({});
    const expected = (await db.select({table:'book'})).map(row => [row.id,row._uid,row._recordHash ?? null,creator.physicalIdentity(row)]);
    const identities = [];
    await readBookIdentities(binary, path.join(directory,'book'), expected.length, row => creator.physicalIdentity(row), batch => {
        for (const row of batch) identities.push([row.id,row.uid,row.hash,row.identity]);
    });
    assert.deepEqual(identities, expected);
}

async function checkIndex(binary, directory, db) {
    const keys = ['ё', 'е', 'и\u0306', 'й', 'co-operate', 'cooperate', 'Ё', 'Й', 'a', 'a\u200d'];
    for (let i=0; i < 60; i++) keys.push(`книга ${String(i).padStart(2, '0')}`);
    keys.sort((a,b) => a.localeCompare(b));
    const rows = keys.map((value,i) => ({id:i * 3, value, bookIds:[i]}));
    await RustTableBuilder.buildIndex(binary, path.join(directory,'native'), rows, () => {});
    await db.create({table:'reference', index:{field:'value', type:'string', unique:true, depth:1000000}});
    await db.insert({table:'reference',rows});
    await db.close({table:'reference'});
    await db.open({table:'reference'});
    await db.open({table:'native'});
    assert.deepEqual(await db.select({table:'native'}), await db.select({table:'reference'}));
    const index = name => db.table.get(name).reducer._index.get('value');
    assert.deepEqual(index('native').sorted, index('reference').sorted);
    assert.deepEqual([...index('native').hash], [...index('reference').hash]);
    const where = "return Array.from(@dirtyIndexLR('value','книга 0','книга 4'))";
    assert.deepEqual(await db.select({table:'native',rawResult:true,where}), await db.select({table:'reference',rawResult:true,where}));
}

async function checkIncomplete(binary, directory) {
    const target = path.join(directory,'partial');
    const writer = await RustTableBuilder.open(binary,target,'build-book');
    try {
        await writer.append(['[1,"a",{"id":1,"_uid":"a"}]\n']);
        await assert.rejects(writer.finish(2), /count differs/);
        await assert.rejects(fs.stat(target), {code:'ENOENT'});
    } finally {await writer.close();}
}

async function checkCatalogueUpdate(binary, directory) {
    const index = path.join(directory,'library.inpx');
    const filter = path.join(directory,'filter.json');
    const config = {...require('../server/config/base'),dataDir:directory,inpxFilterFile:filter,
        librarySources:[{id:'fixture',name:'Fixture',type:'inpx',inpxFile:index,libDir:directory}]};
    const template = (file,title,series = '',del = 0) =>
        ['Иванов, Иван:Егоров:', 'prose:sf:',title,series,1,file,1234,file,del,'fb2','2026-10-01','ru',2,''].join('\x04');
    const fixed = template('keep','Песни и ёлки','Первый'), remove = template('remove','Читать','',1);
    const original = template('edit','Чужая книга'), changed = template('edit','Ёлка №１２ in cон'), added = template('new','Йота');
    const write = async rows => {
        const zip = new (require('yazl').ZipFile)();
        zip.addBuffer(Buffer.from(rows.join('\n')+'\n'),'one.inp');
        const output = pipeline(zip.outputStream,createWriteStream(index));
        zip.end();
        await output;
    };
    const snapshot = async dbPath => {
        const db = new JembaDb();
        try {
            await db.lock({dbPath,softLock:true});
            await db.openAll();
            const tables = {};
            for (const table of ['book','author','series','title','word','genre','lang','del','date','librate','ext','source'])
                tables[table] = await db.select({table});
            const [stats] = await db.select({table:'config',where:"@@id('stats')"});
            const [update] = await db.select({table:'config',where:"@@id('indexUpdate')"});
            const {updatedAt,...changes} = update.value;
            return {tables,stats:stats.value,changes};
        } finally {await db.unlock();}
    };
    const originalDirectory = path.join(directory,'catalogue-before');
    const previousBinary = process.env.INPX_RUST_CATALOG_BINARY;
    process.env.INPX_RUST_CATALOG_BINARY = binary;
    try {
        await write([original,fixed,remove]);
        await buildIndexInWorker({...config,rustBookStoreEnabled:false},originalDirectory,null,()=>{});
        await fs.writeFile(filter,JSON.stringify({excludeAuthors:['запрет']}));
        let previous = originalDirectory;
        for (const [step, rows] of [[1,[changed,added,fixed]],[2,[fixed,added,template('edit','Ещё одно изменение')]]]) {
            await write(rows);
            const reference = path.join(directory,`catalogue-reference-${step}`);
            const candidate = path.join(directory,`catalogue-native-${step}`);
            await buildIndexInWorker({...config,rustCatalogUpdateEnabled:false},reference,previous,()=>{});
            let native = false, warning, mode;
            await buildIndexInWorker(config,candidate,previous,state => {
                native ||= !!state.nativeUpdate;
                warning ||= state.rustUpdateWarning;
                mode ||= state.bookStoreMode;
            });
            assert(native,warning || 'Native catalogue update did not run');
            assert.equal(mode,step === 1 ? 'base' : 'patch');
            const actual = await snapshot(candidate);
            assert.deepEqual(actual,await snapshot(reference));
            const reader = new (require('../server/core/DatabaseThread'))(config);
            try {
                const {generation} = JSON.parse(await fs.readFile(path.join(candidate,'books-store.json'),'utf8'));
                await reader.lock({dbPath:candidate,softLock:true});
                await reader.configureBookStore(candidate,generation);
                assert(reader.bookStore);
                assert.deepEqual(await reader.booksByIds(actual.tables.book.map(row => row.id)),actual.tables.book);
                assert.equal(reader.legacyBookOpen,undefined);
            } finally {await reader.unlock();}
            previous = candidate;
        }
        const controller = new AbortController();
        const abandoned = path.join(directory,'catalogue-aborted');
        await assert.rejects(buildIndexInWorker(config,abandoned,previous,state => {
            if (state.job === 'previous identities') controller.abort(new Error('Stop the native update'));
        },controller.signal),/Stop the native update/);
        assert(!(await fs.readdir(abandoned)).some(name => name.startsWith('.rust-catalog-')));
        console.log('ok Rust catalogue updates preserve Jemba order, identities and all posting tables across generations');
    } finally {
        if (previousBinary === undefined) delete process.env.INPX_RUST_CATALOG_BINARY;
        else process.env.INPX_RUST_CATALOG_BINARY = previousBinary;
    }
}

async function main() {
    if (!process.argv[2]) throw new Error('Usage: node scripts/rust-jemba-compat-tests.js <catalog-binary>');
    const binary = path.resolve(process.argv[2] || '');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'inpx-rust-jemba-'));
    const db = new JembaDb();
    try {
        await db.lock({dbPath:directory,create:true,softLock:true});
        await checkBooks(binary, directory, db);
        await checkIndex(binary, directory, db);
        await checkIncomplete(binary, directory);
        await checkCatalogueUpdate(binary,directory);
        console.log('ok Rust table snapshots can be queried and updated by JembaDB 5.1.7');
    } finally {
        await db.unlock();
        await fs.rm(directory, {recursive:true,force:true});
    }
}

main().catch(error => {console.error(error);process.exitCode = 1;});
