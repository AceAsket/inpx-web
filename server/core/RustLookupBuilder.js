const {spawn} = require('node:child_process');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');

async function* encode({generation, count, rows, bookMaps, ordered, lowMemory}) {
    yield JSON.stringify({generation,rows:count,bookMaps,lowMemory}) + '\n';
    let chunk = '';
    for await (const [table, row] of rows) {
        chunk += JSON.stringify({table, id:row.id, name:table === 'word' ? row.value : row.name,
            count:row.bookCount, deleted:row.bookDelCount, bookIds:row.bookIds, value:ordered ? row.value : undefined,
            omitFromBookMap:bookMaps && table === 'series' && row.value.localeCompare('?', 'en') === 0 || undefined}) + '\n';
        if (chunk.length >= 128 * 1024) {
            yield chunk;
            chunk = '';
        }
    }
    if (chunk) yield chunk;
}

async function writeLookup(binary, command, path, data) {
    const child = spawn(binary, [command, path], {windowsHide:true, stdio:['pipe','ignore','pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
    const done = new Promise(resolve => {
        child.once('error', resolve);
        child.once('close', (code, signal) => resolve(code === 0 ? null :
            new Error(stderr.trim() || `Rust lookup build exited (${signal || code})`)));
    });
    const [input, exit] = await Promise.allSettled([pipeline(Readable.from(data), child.stdin), done]);
    if (exit.value) throw exit.value;
    if (input.status === 'rejected') throw input.reason;
}

function buildLookup(binary,path,options) {return writeLookup(binary,'build-lookup',path,encode(options));}

function sealLookup(binary,path,generation,bookStoreGeneration) {
    return writeLookup(binary,'seal-lookup',path,[JSON.stringify({generation,bookStoreGeneration})]);
}

module.exports = {buildLookup,sealLookup};
