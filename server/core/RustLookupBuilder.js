const {spawn} = require('node:child_process');
const {readFile} = require('node:fs/promises');
const {dirname,join} = require('node:path');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const isEmptySeries = value => value.localeCompare('?', 'en') === 0;

async function* encode({generation, count, rows, bookMaps, ordered, lowMemory}) {
    yield JSON.stringify({generation,rows:count,bookMaps,lowMemory}) + '\n';
    let chunk = '';
    for await (const [table, row] of rows) {
        chunk += JSON.stringify({table, id:row.id, name:table === 'word' ? row.value : row.name,
            count:row.bookCount, deleted:row.bookDelCount, bookIds:row.bookIds, value:ordered ? row.value : undefined,
            omitFromBookMap:bookMaps && table === 'series' && isEmptySeries(row.value) || undefined}) + '\n';
        if (chunk.length >= 128 * 1024) {
            yield chunk;
            chunk = '';
        }
    }
    if (chunk) yield chunk;
}

async function writeLookup(binary, command, path, data, signal) {
    signal?.throwIfAborted();
    const child = spawn(binary, [command, path], {windowsHide:true, stdio:['pipe','ignore','pipe'], signal});
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
    const done = new Promise(resolve => {
        child.once('error', resolve);
        child.once('close', (code, signal) => resolve(code === 0 ? null :
            new Error(stderr.trim() || `Rust lookup build exited (${signal || code})`)));
    });
    const [input, exit] = await Promise.allSettled([pipeline(Readable.from(data), child.stdin), done]);
    signal?.throwIfAborted();
    if (exit.value) throw exit.value;
    if (input.status === 'rejected') throw input.reason;
}

function buildLookup(binary,path,options) {return writeLookup(binary,'build-lookup',path,encode(options));}

async function buildPackedLookup(binary,path,{generation,nameCounts,lowMemory,compareLabels,signal}) {
    const tables=['author','series','title','word'];
    const directory=join(dirname(path),'.postings');
    let seriesCount=nameCounts[1];
    async function* order() {
        yield JSON.stringify({generation,nameCounts,lowMemory})+'\n';
        for (const [tableIndex,table] of tables.entries()) {
            signal?.throwIfAborted();
            const labels=JSON.parse(await readFile(join(directory,`${table}.labels`),'utf8'));
            if (!Array.isArray(labels) || labels.length !== nameCounts[tableIndex])
                throw new Error('Rust catalogue label count differs');
            const positions=new Uint32Array(labels.length);
            for (let index=0; index<positions.length; index++) positions[index]=index;
            positions.sort((left,right)=>compareLabels(labels[left],labels[right]));
            const bytes=Buffer.allocUnsafe(positions.length*4);
            const omitted=table==='series' ? Buffer.alloc(Math.ceil(positions.length/8)) : null;
            for (let rank=0; rank<positions.length; rank++) {
                const position=positions[rank];
                bytes.writeUInt32LE(position,rank*4);
                if (omitted && isEmptySeries(labels[position])) {
                    omitted[rank>>>3] |= 1 << (rank%8);
                    seriesCount--;
                }
            }
            yield bytes;
            if (omitted) yield omitted;
        }
    }
    await writeLookup(binary,'publish-lookup',path,order(),signal);
    return seriesCount;
}

function sealLookup(binary,path,generation,bookStoreGeneration) {
    return writeLookup(binary,'seal-lookup',path,[JSON.stringify({generation,bookStoreGeneration})]);
}

module.exports = {buildLookup,buildPackedLookup,sealLookup};
