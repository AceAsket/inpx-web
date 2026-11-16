const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {basename,dirname,join} = require('node:path');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {copyKey,rowQuality} = require('./DiscoverySelection');

const fields = ['id','_uid','date','author','title','series','ext','librate','size','libid','sourceId','folder','file','insno','serno','del'];
const dateCollator = new Intl.Collator();
const textCollator = new Intl.Collator('ru');

async function* scanBooks(db, signal) {
    if (db.bookStoreScan && db.bookStore) {
        let after = null;
        do {
            signal?.throwIfAborted();
            const page = await db.bookStore.run(process => process.query({op:'scan',after,limit:4096,fields}),() => null);
            if (!page || !Array.isArray(page.rows) || page.after !== null && !(Number.isSafeInteger(page.after) && page.after > (after ?? -1)))
                throw new Error('Некорректная страница каталога Rust');
            for (const row of page.rows) if (row?.title && !row.del) yield row;
            after = page.after;
        } while (after !== null);
        return;
    }
    const token = db.esc(`rust-shelves-${randomUUID()}`);
    try {
        while (true) {
            signal?.throwIfAborted();
            const [{rawResult}] = await db.select({table:'book',rawResult:true,where:`
                let cursor=@getItem(${token});
                if (!cursor) {cursor=@all(); @setItem(${token},cursor);}
                const fields=${db.esc(fields)}, rows=[];
                for (let visited=0;visited<4096;visited++) {
                    const next=cursor.next();
                    if (next.done) return {rows,done:true};
                    const row=@unsafeRow(next.value);
                    if (row?.title && !row.del) rows.push(Object.fromEntries(fields.map(key => [key,row[key]])));
                }
                return {rows,done:false};
            `});
            yield* rawResult.rows;
            if (rawResult.done) return;
        }
    } finally {
        await db.select({table:'book',rawResult:true,where:`@delItem(${token}); return null;`});
    }
}

function ranks(values,collator) {
    const ordered = [...values].sort(collator.compare);
    const result = new Map();
    let rank = 0;
    for (const [index,value] of ordered.entries()) {
        if (index > 0 && collator.compare(ordered[index-1],value) !== 0) rank++;
        result.set(value,rank);
    }
    return result;
}

async function sortOrders(db, signal) {
    const dates = new Set(), authors = new Set(), titles = new Set();
    for await (const row of scanBooks(db,signal)) {
        dates.add(String(row.date || ''));
        authors.add(row.author || '');
        titles.add(row.title);
    }
    return [ranks(dates,dateCollator),ranks(authors,textCollator),ranks(titles,textCollator)];
}

async function* snapshot(db,generation,[dates,authors,titles],signal) {
    yield JSON.stringify({generation}) + '\n';
    let lines = '';
    for await (const row of scanBooks(db,signal)) {
        const date = String(row.date || ''), author = row.author || '';
        lines += JSON.stringify({id:row.id,uid:row._uid,copyKey:copyKey(row),quality:rowQuality(row),
            dateMs:Date.parse(date),dateOrder:dates.get(date),rating:row.librate || 0,
            authorOrder:authors.get(author),titleOrder:titles.get(row.title),
            authorGroup:author.trim().toLowerCase(),seriesGroup:(row.series || '').trim().toLowerCase()}) + '\n';
        if (lines.length >= 256 * 1024) {yield lines; lines = '';}
    }
    if (lines) yield lines;
}

async function write(binary,path,input,signal) {
    const child = spawn(binary,['build',path],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data',chunk => {stdout += chunk;});
    child.stderr.setEncoding('utf8').on('data',chunk => {stderr = (stderr + chunk).slice(-2048);});
    const finished = new Promise(resolve => {
        let failure;
        child.once('error',error => {failure = error;});
        child.once('close',(code,signal) => resolve(failure || (code === 0 ? null : new Error(stderr.trim() || `Rust shelf build exited (${signal || code})`))));
    });
    const [transfer,exited] = await Promise.allSettled([pipeline(Readable.from(input),child.stdin,{signal}),finished]);
    if (exited.value) throw exited.value;
    if (transfer.status === 'rejected') throw transfer.reason;
    return JSON.parse(stdout);
}

async function buildShelfIndex(binary,indexPath,db,generation,signal) {
    const orders = await sortOrders(db,signal);
    signal?.throwIfAborted();
    const stage = await fs.mkdtemp(join(dirname(indexPath),'.rust-shelves-'));
    try {
        const target = join(stage,basename(indexPath));
        const result = await write(binary,target,snapshot(db,generation,orders,signal),signal);
        signal?.throwIfAborted();
        await fs.rename(target,indexPath);
        return result;
    } finally {await fs.rm(stage,{force:true,recursive:true});}
}

module.exports = {buildShelfIndex};
