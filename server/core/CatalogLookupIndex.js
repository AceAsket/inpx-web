const search = require('../../shared/CatalogSearch');
const {suggestions} = require('./CatalogueNameRanges');
const MAX_CHAR = String.fromCodePoint(0xfffff);
const FAST_LIMITS = {names:32, wordRows:16, wordBooks:64, books:128, perName:4};
const SUGGEST_BOOK_FIELDS = ['id','_uid','_recordHash','title','author','series','serno','folder','file','ext','size','inpxSize',
    'date','genre','lang','del','librate','libid','insno','sourcelib','sourceId','sourceName','sourceLibDir','sourceType','unavailable'];

// Jemba 5.1.7's range reducer first materializes EVERY matching ID; select.limit
// is applied even later, after loading rows. Seek its existing sorted runs and
// merge only a bounded prefix instead. This adapter is read-only and guarded:
// an unsupported index returns no candidates, never a full-table fallback.
function boundedRange(index, from, to, limit) {
    if (!index?.unique || !Array.isArray(index.sorted) || index.sorted.length>64 || !index.sorted.every(Array.isArray)
        || typeof index.hash?.get !== 'function'
        || typeof index.cmp !== 'function' || typeof index.prepareValue !== 'function')
        return {ids:[],limited:true};
    from=index.prepareValue(from); to=index.prepareValue(to);
    const runs=index.sorted.map(values=>{
        let left=0,right=values.length;
        while(left<right) {const middle=(left+right)>>>1;if(index.cmp(values[middle],from)<0)left=middle+1;else right=middle;}
        return {values,at:left};
    });
    const valid=run=>run.at<run.values.length && index.cmp(run.values[run.at],to)<=0;
    const ids=new Set();let inspected=0;
    while(ids.size<limit && inspected++<limit*4+128) {
        let next;
        for(const run of runs)if(valid(run) && (!next || index.cmp(run.values[run.at],next.values[next.at])<0))next=run;
        if(!next)break;
        const id=index.hash.get(next.values[next.at++]);
        if(id!==undefined)ids.add(id);
    }
    return {ids:[...ids],limited:runs.some(valid)};
}

function sampleIds(ids, limit) {
    if (!ids?.length || !limit) return [];
    const size=Math.min(limit,ids.length), result=[];
    // Diverse samples avoid spending the entire budget on one early edition or
    // one prolific author, without copying/scanning a large posting list.
    for(let i=0;i<size;i++)result.push(ids[Math.floor(i*(ids.length-1)/Math.max(1,size-1))]);
    return result;
}

function findCandidates(index, keys, limit, maxChar) {
    const ids = new Set();
    let limited = false;
    for (const key of keys) {
        const exact = boundedRange(index, key, key, limit);
        for (const id of exact.ids) ids.add(id);
        limited ||= exact.limited;
        if (!maxChar) continue;
        const prefix = boundedRange(index, key, key + maxChar, limit);
        for (const id of prefix.ids) {
            if (ids.size < limit) ids.add(id);
            else limited = true;
        }
        limited ||= prefix.limited;
    }
    return {ids:[...ids], limited};
}

function validSample(row) {
    return Number.isInteger(row?.id) && typeof row.name === 'string' && Number.isInteger(row.count)
        && Array.isArray(row.bookIds) && row.bookIds.length <= FAST_LIMITS.perName && typeof row.complete === 'boolean';
}

async function nativeSamples(native, table, keys, limit, includePrefixes) {
    const ranges = keys.flatMap(key => includePrefixes ? [[key,key],[key,key+MAX_CHAR]] : [[key,key]]);
    const windows = await native.nameWindows?.(table,ranges,'nameSuggestions');
    if (!windows) return null;
    const queries = keys.map((_,index) => includePrefixes
        ? {exact:windows[index*2],prefix:windows[index*2+1]} : {exact:windows[index]});
    const result = await native.nameQuery('suggestSamples',table,{limit,queries});
    if (result !== null && (typeof result?.limited !== 'boolean' || !Array.isArray(result.rows)
        || result.rows.length > limit || result.rows.some(row => !validSample(row))))
        throw new Error('Invalid Rust suggestion candidates');
    return result;
}

async function lookupRows(db, table, keys, limit, includePrefixes, projection, native) {
    const selection = `
        const boundedRange = ${boundedRange.toString()}, find = ${findCandidates.toString()};
        const {ids, limited} = find(__tr._index?.get('value'), ${db.esc(keys)}, ${limit},
            ${db.esc(includePrefixes ? MAX_CHAR : '')});
    `;
    if (native) {
        const samples = await nativeSamples(native,table,keys,limit,includePrefixes);
        if (samples !== null) return samples;
        const order = await native.labelOrder?.(table);
        const {ids, limited} = order ? suggestions(order,keys,limit,includePrefixes ? MAX_CHAR : '')
            : (await db.select({table,rawResult:true,where:`${selection} return {ids, limited};`}))[0].rawResult;
        if (!ids.length) return {rows:[], limited};
        if (ids.length <= limit || db.nativeCatalogue) {
            const selected = ids.slice(0,limit);
            const rows = await native.query({op:'sample', table, ids:selected});
            if (!Array.isArray(rows) || rows.length !== selected.length || rows.some((row, index) =>
                !validSample(row) || row.id !== selected[index]))
                throw new Error('Invalid Rust suggestion candidates');
            return {rows, limited:limited || ids.length>selected.length};
        }
    }
    const [result] = await db.select({table, rawResult:true, where:`
        ${selection}
        const sample = ${sampleIds.toString()}, rows = [];
        for (const id of ids) {
            const row = @unsafeRow(id);
            if (row && row.value !== '?') rows.push(${projection});
            if (rows.length === ${limit}) break;
        }
        return {rows, limited};
    `});
    return result.rawResult;
}

// A separate inverted index maps words to author/series/title IDs, not to every
// book by a prolific author. Built incrementally in bounded batches; a marker
// makes interrupted builds distinguishable from complete ones after a restart.
class CatalogLookupIndex {
    static get fastLimits() {return FAST_LIMITS;}

    static async names(db, kind, query, exactNames = null, native) {
        const keys = exactNames || [...new Set([query.toLowerCase(), search.normalize(query)])];
        const result = await lookupRows(db, kind, keys, FAST_LIMITS.names, !exactNames, `
            {id:row.id, name:row.name, count:row.bookCount, bookIds:sample(row.bookIds,${FAST_LIMITS.perName}),
                complete:row.bookIds.length<=${FAST_LIMITS.perName}}
        `, native);
        return {limited:result.limited, rows:result.rows.filter(row => row.name !== '?').slice(0, FAST_LIMITS.names)};
    }

    static async wordCandidates(db, kind, token, {typo = false, native} = {}) {
        if (!await db.tableExists({table:'word'})) return {rows:[],limited:false};
        const prefix=kind+':'+(typo ? token.slice(0,2):token);
        const limit = FAST_LIMITS.wordBooks / FAST_LIMITS.wordRows;
        const result = await lookupRows(db, 'word', [prefix], FAST_LIMITS.wordRows, true, `
            {name:row.value, bookIds:sample(row.bookIds,${limit}), complete:row.bookIds.length<=${limit}}
        `, native);
        const rows = result.rows.filter(row => row.name.startsWith(kind + ':')).map(({name, bookIds, complete}) =>
            ({word:name.slice(kind.length + 1), bookIds, complete}));
        return {rows, limited:result.limited || rows.some(row => !row.complete)};
    }

    static async books(db, ids) {
        if (!ids.length) return [];
        if (db.booksByIds) return db.booksByIds(ids.slice(0,FAST_LIMITS.books),SUGGEST_BOOK_FIELDS);
        const result=await db.select({table:'book',rawResult:true,where:`
            const rows=[];
            const fields=${db.esc(SUGGEST_BOOK_FIELDS)};
            for(const id of ${db.esc(ids.slice(0,FAST_LIMITS.books))}) {
                const row=@unsafeRow(id);
                if(row) {const book={};for(const field of fields)if(row[field]!==undefined)book[field]=row[field];rows.push(book);}
            }
            return rows;
        `});
        return result[0].rawResult;
    }

    static async candidates(db, kind, query, scoped, native) {
        const direct=await this.names(db,kind,query,null,native);
        direct.rows=direct.rows.filter(row=>search.match(row.name,query));
        // Full-name prefixes outrank matches later in a name. Six useful direct
        // answers need no word posting reads in the common unfiltered case.
        if (!scoped && direct.rows.filter(row=>row.count>0).length>=6) return direct;
        const tokens=[...new Set(search.words(query).map(search.root))].sort((a,b)=>b.length-a.length);
        const words=await this.wordCandidates(db,kind,tokens[0],{native});
        const books=await this.books(db,[...new Set(words.rows.flatMap(row=>row.bookIds))]);
        const names=new Set();
        for(const book of books) {
            const values=kind==='author' ? [...String(book.author || '').split(','),book.author]:[book[kind]];
            for(const value of values)if(value && search.match(value,query))names.add(value.toLowerCase());
        }
        const extra=names.size ? await this.names(db,kind,query,[...names].slice(0,FAST_LIMITS.names),native):{rows:[],limited:false};
        return {rows:[...new Map([...direct.rows,...extra.rows].map(row=>[row.id,row])).values()],
            books,limited:direct.limited || words.limited || extra.limited || names.size>FAST_LIMITS.names};
    }

}
module.exports = CatalogLookupIndex;
