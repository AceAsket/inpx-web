const assert=require('assert/strict');
const fs=require('fs-extra');
const os=require('os');
const path=require('path');
const {performance}=require('perf_hooks');
const search=require('../shared/CatalogSearch');
const Lookup=require('../server/core/CatalogLookupIndex');
const Discovery=require('../server/core/CatalogDiscovery');

async function fixture(total,work) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-fast-suggest-'));
    const db=new (require('jembadb').JembaDb)();
    let service;
    try {
        await db.lock({dbPath:directory,create:true});
        const books=[
            {title:'Тест',author:'Ионова Злата Алексеевна',series:'Общий цикл',lang:'ru',sourceId:'one',
                annotation:'unrelated data'.repeat(100000),keywords:'keywords'.repeat(100000)},
            {title:'Тест',author:'Ионова Злата Алексеевна',series:'Общий цикл',lang:'en',sourceId:'two'},
            {title:'Приключения Тест героя',author:'Толстой Лев Николаевич',series:'Другой цикл',lang:'ru',sourceId:'one'},
            {title:'Ёлка у озера',author:'Ёлкин Семён',series:'Озёрные истории',lang:'ru',sourceId:'one'},
            {title:'Тест удалённый',author:'Удалённый автор',series:'Удалённая серия',lang:'ru',sourceId:'one',del:1},
            {title:'Туман над рекой',author:'Туман Автор',series:'Туман серия',lang:'ru',sourceId:'one'},
            ...Array.from({length:total},(_,i)=>({title:`Тест ${String(i).padStart(6,'0')}`,author:'Ионова Злата Алексеевна',series:`Серия ${i}`,lang:'ru',sourceId:'one'})),
        ].map((book,i)=>({id:i*2+7,_uid:'book-'+i,ext:'fb2',genre:'prose,sf',del:0,...book}));
        await db.create({table:'book'});
        for(let i=0;i<books.length;i+=2000)await db.insert({table:'book',rows:books.slice(i,i+2000)});
        const words=new Map();
        for(const kind of ['author','series','title']) {
            const names=new Map();
            for(const book of books) {
                const name=book[kind],value=name.toLowerCase();
                if(!names.has(value))names.set(value,{id:names.size*3+1,value,name,bookCount:0,bookIds:[]});
                const row=names.get(value);row.bookIds.push(book.id);if(!book.del)row.bookCount++;
                for(const word of new Set(search.words(name).map(search.root))) {
                    const key=kind+':'+word;
                    if(!words.has(key))words.set(key,{id:words.size*2+1,value:key,bookIds:[]});
                    words.get(key).bookIds.push(book.id);
                }
            }
            await db.create({table:kind,index:{field:'value',type:'string',unique:true,depth:1000000}});
            const rows=[...names.values()];
            for(let i=0;i<rows.length;i+=2000)await db.insert({table:kind,rows:rows.slice(i,i+2000)});
        }
        await db.create({table:'word',index:{field:'value',type:'string',unique:true,depth:1000000}});
        const rows=[...words.values()];
        for(let i=0;i<rows.length;i+=2000)await db.insert({table:'word',rows:rows.slice(i,i+2000)});
        await db.freeMemory();
        const worker={db,libraryAssetGeneration:1,dbSearcher:{selectBookIds:async()=>{throw new Error('Suggestions may not expand a full filter/posting result');}}};
        service=new Discovery(worker);
        service.warm=async()=>{throw new Error('A foreground suggestion must never start or await the full lookup build');};
        let reads=0;
        for(const table of db.table.values()) {
            const reducer=table.reducer,unsafeRow=reducer.unsafeRow.bind(reducer);
            reducer.unsafeRow=async id=>{reads++;return unsafeRow(id);};
            reducer.dirtyIndexLR=()=>{throw new Error('Unbounded range materialization is forbidden in suggestions');};
            reducer.all=()=>{throw new Error('Full table scans are forbidden in suggestions');};
        }
        // Mutating the extra index is forbidden even if an old build is absent.
        for(const method of ['create','insert','drop'])db[method]=async()=>{throw new Error('Suggestions may not write an index');};
        await work({db,service,worker,books,readCount:()=>reads,resetReads:()=>{reads=0;}});
    } finally {await service?.close();await db.unlock();await fs.remove(directory);}
}

async function testFastSuggestionsWorkBeforeAnyLookupBuildAndPreserveScope() {
    await fixture(30,async({service,db})=>{
        const result=await service.suggest({query:'Тест',kind:'title'});
        const items=result.groups[0].items;
        assert.equal(items[0].name,'Тест');assert.equal(items[0].count,2);assert(items[0].book);
        assert.equal(items[0].book.annotation,undefined);assert.equal(items[0].book.keywords,undefined);
        assert(Buffer.byteLength(JSON.stringify(result))<16000,'Unrelated large fields must stay inside the database worker');
        assert.equal(result.warming,undefined);assert.equal(result.progress,undefined);assert(items.length<=6);
        assert(!await db.tableExists({table:'catalog_lookup'}));
        const secondWord=await service.suggest({query:'Лев Ник',kind:'author'});
        assert(secondWord.groups[0].items.some(item=>item.name==='Толстой Лев Николаевич'));
        const titleSecondWord=await service.suggest({query:'героя',kind:'title'});
        assert.equal(titleSecondWord.groups[0].items[0].book.title,'Приключения Тест героя');
        const cyrillic=await service.suggest({query:'елк',kind:'title'});
        assert(cyrillic.groups[0].items.some(item=>item.name==='Ёлка у озера'));
        const scoped=await service.suggest({query:'Тест',kind:'title',filters:{lang:'en',sourceId:'two',ext:'fb2|epub',genre:'sf'}});
        assert.equal(scoped.groups[0].items.length,1);assert.equal(scoped.groups[0].items[0].count,1);
        assert.equal(scoped.groups[0].items[0].book.lang,'en');assert.equal(scoped.groups[0].items[0].book.sourceId,'two');
        assert.deepEqual((await service.suggest({query:'Тест',filters:{sourceId:'missing'}})).groups.flatMap(group=>group.items),[]);
        const typo=await service.suggest({query:'толстйо',kind:'author'});
        assert(typo.corrections.some(item=>item.query==='толстой'));
    });
}

async function testFastSuggestionsShortQueriesAndUnsupportedIndexNeverScan() {
    await fixture(5,async({service,db,readCount,resetReads})=>{
        let calls=0;
        const select=db.select.bind(db),exists=db.tableExists.bind(db);
        db.select=async(...args)=>{calls++;return select(...args);};
        db.tableExists=async(...args)=>{calls++;return exists(...args);};
        for(const query of ['', 'т', 'те', '  те  ', '\u{10400}\u{10401}', '=Тест', '!!!'])assert.deepEqual((await service.suggest({query})).groups,[]);
        assert.equal(readCount(),0);assert.equal(calls,0,'Short queries must not even inspect DB tables');
        assert.equal(service.pending.size,0);assert.equal(service.cache.size,0);
        resetReads();
        const index=db.table.get('title').reducer._index.get('value');
        const sorted=index.sorted;index.sorted=null;
        const result=await service.suggest({query:'Тест',kind:'title'});
        index.sorted=sorted;
        assert.deepEqual(result.groups[0].items,[]);assert.equal(result.limited,true);
        assert(readCount()<=Lookup.fastLimits.wordRows+Lookup.fastLimits.wordBooks);
    });
}

async function testFastSuggestionsBoundRowsBeforeReadingLargePrefixAndPostings() {
    await fixture(30000,async({service,db,books,readCount,resetReads})=>{
        const began=performance.now(),cpu=process.cpuUsage();
        const first=await service.suggest({query:'Тест',kind:'title'});
        const coldMs=performance.now()-began,usage=process.cpuUsage(cpu),coldReads=readCount();
        assert.equal(first.groups[0].items[0].name,'Тест');assert.equal(first.groups[0].items.length,6);
        assert.equal(first.limited,true);assert(coldReads<=Lookup.fastLimits.names+Lookup.fastLimits.books,
            `A 30k prefix must read bounded rows before projection: ${coldReads}`);
        resetReads();const warmStart=performance.now();assert.equal(await service.suggest({query:'Тест',kind:'title'}),first);
        assert.equal(readCount(),0,'A repeated request uses the bounded response cache');
        const warmMs=performance.now()-warmStart;
        // One real author posting has 30k book IDs. Scoped suggestions must not expand it.
        resetReads();
        const scoped=await service.suggest({query:'Ионова',kind:'author',filters:{lang:'ru'}});
        const item=scoped.groups[0].items[0];assert(item);assert.equal(item.count,null);assert.equal(item.limited,true);
        assert(readCount()<=Lookup.fastLimits.names*2+Lookup.fastLimits.wordRows+Lookup.fastLimits.wordBooks+Lookup.fastLimits.books);
        console.log(JSON.stringify({benchmark:'fast-suggestions',books:books.length,coldMs,warmMs,coldRowReads:coldReads,
            scopedRowReads:readCount(),cpuMs:(usage.user+usage.system)/1000,items:first.groups[0].items.length}));
    });
}

async function testFastSuggestionsFieldScopeSeparatesIndexesCorrectionsAndCache() {
    await fixture(0,async({service,db,readCount,resetReads})=>{
        const select=db.select.bind(db),tables=[];
        db.select=async options=>{tables.push(options.table);return select(options);};
        const byKind=new Map();
        for(const kind of ['title','author','series']) {
            tables.length=0;resetReads();
            const options={query:'Туман',kind,filters:{lang:'ru',sourceId:'one'}};
            const [first,concurrent]=await Promise.all([service.suggest(options),service.suggest(options)]);
            assert.equal(first,concurrent,'Identical scoped requests still coalesce');
            assert.deepEqual(first.groups.map(group=>group.kind),[kind]);
            assert(first.groups[0].items.length>0,'The fixture has a matching '+kind);
            assert(readCount()>0,'Changing only kind cannot reuse another field cache');
            assert(tables.every(table=>!['title','author','series'].includes(table)||table===kind),'A field never computes other name indexes');
            byKind.set(kind,first);
            resetReads();assert.equal(await service.suggest(options),first);assert.equal(readCount(),0);
            const filtered=await service.suggest({...options,filters:{sourceId:'missing'}});
            assert.equal(filtered.groups[0].items.length,0,'Filters remain part of cache identity');
            resetReads();assert.equal(await service.suggest(options),first);assert.equal(readCount(),0);
            const typo=await service.suggest({...options,query:'тумон'});
            assert(typo.corrections.length>0,'The fixture exercises corrections too');
            assert(typo.corrections.every(item=>item.kind===kind),'Corrections stay inside the selected field');
        }
        const mixed=await service.suggest({query:'Туман'});
        assert.deepEqual(mixed.groups.map(group=>group.kind),['author','series','title']);
        assert(mixed.groups.every(group=>group.items.length>0),'An explicit unified caller can still request mixed suggestions');
        assert([...byKind.values()].every(value=>value!==mixed));
        resetReads();await assert.rejects(service.suggest({query:'Туман',kind:'books'}),/title, author или series/);
        assert.equal(readCount(),0,'Unknown field scopes do not fall back to mixed database work');
    });
}

module.exports=[testFastSuggestionsWorkBeforeAnyLookupBuildAndPreserveScope,
    testFastSuggestionsShortQueriesAndUnsupportedIndexNeverScan,testFastSuggestionsBoundRowsBeforeReadingLargePrefixAndPostings,
    testFastSuggestionsFieldScopeSeparatesIndexesCorrectionsAndCache];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})()
    .catch(error=>{console.error(error);process.exitCode=1;});
