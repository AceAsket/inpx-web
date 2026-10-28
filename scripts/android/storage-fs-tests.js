'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {promisify} = require('util');
const {install, PREFIX} = require('../../android/runtime/storage-fs');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-android-storage-'));
    const filename = 'Книга 📚.fb2';
    const content = Buffer.from('Проверка произвольного чтения из библиотеки. '.repeat(2000));
    fs.writeFileSync(path.join(directory, filename), content);
    const original = {open: fs.openSync, stat: fs.statSync, readdir: fs.readdirSync};
    const bridge = {call(op, virtual) {
        const relative = virtual.slice((PREFIX + 'test/').length);
        const file = path.join(directory, relative);
        try {
            if (op === 'open') return JSON.stringify({value: original.open(file, 'r')});
            const info = file => { const s = original.stat(file); return {name: path.basename(file), size: s.size, modified: s.mtimeMs, directory: s.isDirectory()}; };
            return JSON.stringify({value: op === 'list' ? original.readdir(file).map(name => info(path.join(file, name))) : info(file)});
        } catch (error) { return JSON.stringify({error: error.code, message: 'test storage unavailable'}); }
    }};
    install(bridge);
    const virtual = PREFIX + 'test/' + filename;
    try {
        assert.deepEqual(await fs.promises.readFile(virtual), content);
        assert.equal(fs.readFileSync(virtual, 'utf8'), content.toString());
        const fd = await promisify(fs.open)(virtual, 'r');
        try {
            const bytes = Buffer.alloc(73);
            const {bytesRead} = await promisify(fs.read)(fd, bytes, 0, bytes.length, 211);
            assert.equal(bytesRead, bytes.length); assert.deepEqual(bytes, content.subarray(211, 284));
        } finally { fs.closeSync(fd); }
        assert.equal((await fs.promises.stat(virtual)).size, content.length);
        const entries = await fs.promises.readdir(PREFIX + 'test/', {withFileTypes: true});
        assert.equal(entries[0].name, filename); assert.equal(entries[0].isFile(), true);
        const chunks = []; for await (const chunk of fs.createReadStream(virtual, {start: 19, end: 1023})) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), content.subarray(19, 1024));
        assert.throws(() => fs.openSync(virtual, 'w'), {code: 'EROFS'});
        await assert.rejects(fs.promises.access(virtual, fs.constants.W_OK), {code: 'EACCES'});
        await assert.rejects(fs.promises.stat(PREFIX + 'test/../escape'), {code: 'EACCES'});
        await assert.rejects(fs.promises.readFile(PREFIX + 'test/missing'), {code: 'ENOENT'});
        assert.equal(fs.existsSync(PREFIX + 'test/missing'), false);
        assert.deepEqual(await fs.promises.readFile(path.join(directory, filename)), content, 'Local data files must remain unaffected');
        const handle = await fs.promises.open(virtual, 'r');
        try {
            assert.equal((await handle.stat()).size, content.length);
            const b = Buffer.alloc(17); await handle.read(b, 0, b.length, 31);
            assert.deepEqual(b, content.subarray(31, 48));
        } finally { await handle.close(); }
        console.log('PASS: mounted file reads, random offsets, Unicode, streams, metadata, read-only access, traversal rejection, offline errors, local files');
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
