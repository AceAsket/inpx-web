const fs = require('fs-extra');
const path = require('path');
const {open, unlink} = require('fs').promises;
const {writeFileAtomic, syncParentDirectory} = require('./FilePersistence');
const {RustLookupIndex,executable} = require('./RustLookupIndex');
const runtime = require('./ResourceRuntime');

const fileName = 'reader-progress.log';
const checkpointField = 'readerProgressCheckpoint';
const maxBytes = 1024 * 1024;
const rustReaders = new Map();
const idleMs = 1000;
const snapshotInlineBytes = 64 * 1024;

function fileStamp(stat) {
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

async function stamp(file) {
    try { return fileStamp(await fs.stat(file,{bigint:true})); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
    }
}

async function clear(file) {
    try { await unlink(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await syncParentDirectory(file);
}

function applyProgress(user, bookUid, progress, updatedAt) {
    user.readerProgress ||= {};
    Object.defineProperty(user.readerProgress, bookUid, {
        value: progress, enumerable: true, configurable: true, writable: true,
    });
    user.updatedAt = updatedAt;
}

function rustJournal(file) {
    const binary = executable();
    if (!binary) return null;
    const key = path.resolve(file);
    if (!rustReaders.has(key)) rustReaders.set(key,{key,active:new Set(),reader:new RustLookupIndex(path.dirname(key),null,
        {binary,file:key,generation:'progress-log-v1',command:'progress-journal'})});
    return rustReaders.get(key);
}

function closeRustJournal(entry) {
    clearTimeout(entry.timer);
    rustReaders.delete(entry.key);
    entry.closing ||= Promise.allSettled([...entry.active]).then(()=>entry.reader.close());
    return entry.closing;
}

async function withRustJournal(entry,work) {
    clearTimeout(entry.timer);
    const operation=Promise.resolve().then(()=>work(entry.reader));
    entry.active.add(operation);
    try { return await operation; }
    finally {
        entry.active.delete(operation);
        if (!entry.active.size && !entry.held && !entry.closing)
            entry.timer = setTimeout(()=>{void closeRustJournal(entry);},idleMs);
    }
}

function journalCapabilities(entry) {
    entry.capability ||= entry.reader.run(process=>process.query({op:'probe'}),()=>null);
    return entry.capability;
}

function startRustJournal(file) {
    const entry=rustJournal(file);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.held=true;
    void withRustJournal(entry,()=>journalCapabilities(entry)).catch(()=>{});
    return ()=>closeRustJournal(entry);
}

async function runRustBackup(file, configFile, work) {
    if (!configFile) return false;
    const entry = rustJournal(file);
    if (!entry) return false;
    return runtime.withSignal(undefined, () => withRustJournal(entry, async reader => {
        if (!(await journalCapabilities(entry))?.backups) return false;
        const send = (action, fields = {}) => reader.run(process => process.query({
            op: 'backup', action, configFile: path.resolve(configFile), ...fields,
        }), () => {throw new Error(reader.lastError || 'Rust backup worker is unavailable');});
        await work(send);
        return true;
    }));
}

async function replayRust(file,checkpoint,users) {
    if ([...users.keys()].some(id=>typeof id!=='string')) return null;
    const entry=rustJournal(file);
    if (!entry) return null;
    const generations = Object.fromEntries([...users].map(([id,user])=>[id,Math.max(0,parseInt(user.readerProgressGeneration,10) || 0)]));
    return withRustJournal(entry,reader=>reader.run(process=>process.query({op:'replay',checkpoint,generations}),()=>null));
}

async function replay(file, checkpoint, data, currentStamp) {
    const journal = {stamp: currentStamp, offset: 0};
    if (!currentStamp || typeof checkpoint !== 'string' || !/^[a-f0-9]{32}$/.test(checkpoint)) return journal;

    const users = new Map((Array.isArray(data.users) ? data.users : []).filter(user => user?.id).map(user => [user.id, user]));
    const invalidEntry = () => new Error('Некорректная запись в журнале прогресса чтения');
    const result = await replayRust(file,checkpoint,users);
    if (result?.state==='tooLarge') throw new Error('Reader progress journal exceeds its size limit');
    if (result?.state==='invalidRecord') throw invalidEntry();
    if (result?.state==='replay') {
        for (const [userId,bookUid,progress,updatedAt] of result.updates)
            applyProgress(users.get(userId),bookUid,progress,updatedAt);
        for (const [userId,updatedAt] of Object.entries(result.latest))
            users.get(userId).updatedAt = updatedAt;
        journal.offset=result.offset;
        return journal;
    }

    // A corrupt file must not cause an unbounded allocation at startup.
    const capacity = maxBytes + 1;
    const buffer = Buffer.allocUnsafe(capacity);
    const handle = await open(file, 'r');
    let read = 0;
    try {
        while (read < capacity) {
            const {bytesRead} = await handle.read(buffer, read, capacity - read, read);
            if (!bytesRead) break;
            read += bytesRead;
        }
    } finally {
        await handle.close();
    }
    const contents = buffer.subarray(0, read);
    const firstLine = contents.indexOf(10);
    if (firstLine !== checkpoint.length || !contents.subarray(0, firstLine).equals(Buffer.from(checkpoint)))
        return journal;
    if (contents.length > maxBytes)
        throw new Error('Reader progress journal exceeds its size limit');

    // A crash can leave a partial final record. Earlier records are complete
    // and a later append replaces only the incomplete tail.
    journal.offset = contents.lastIndexOf(10) + 1;
    const lines = contents.toString('utf8', firstLine + 1, journal.offset).split('\n');
    lines.pop();
    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); }
        catch (_) { throw invalidEntry(); }
        if (!Array.isArray(entry) || entry.length !== 4) throw invalidEntry();
        const [userId, bookUid, progress, updatedAt] = entry;
        const user = users.get(userId);
        const generation = Math.max(0, parseInt(user?.readerProgressGeneration, 10) || 0);
        if (!user || typeof bookUid !== 'string' || !bookUid || !progress || typeof progress !== 'object'
            || Array.isArray(progress) || progress.generation !== generation
            || typeof updatedAt !== 'string')
            throw invalidEntry();
        applyProgress(user, bookUid, progress, updatedAt);
    }
    return journal;
}

async function writeRust(file,request,needsUpdate=false) {
    const entry=rustJournal(file);
    if (!entry) return null;
    return runtime.withSignal(undefined,()=>withRustJournal(entry,async reader=>{
        const capability=await journalCapabilities(entry);
        if (capability?.state!=='ready' || needsUpdate && !capability.updates) return null;
        const result=await reader.run(process=>process.query(request),()=>{throw new Error('Could not write reader progress');});
        if (typeof result?.state!=='string') throw new Error('Could not write reader progress');
        if (result?.state==='changed') throw new Error('Reader progress journal changed during a write');
        if (result?.state==='tooLarge') throw new Error('Reader progress journal exceeds its size limit');
        return result;
    }));
}

function recordForRust({checkpoint,journal,line}) {
    return {checkpoint,expected:journal.stamp,offset:journal.offset,line:line.toString('utf8')};
}

async function update(file,policy,record) {
    const {generation,requestedGeneration,currentGeneration,revision,checksRevision,requestedRevision,
        requestedTime,currentTime,force}=policy;
    if ([generation,requestedGeneration,revision,currentGeneration ?? 0].every(Number.isFinite)) {
        const result=await writeRust(file,{op:'update',policy,append:record ? recordForRust(record) : null},true);
        if (result?.state==='written') return {state:'advance',journal:{stamp:result.stamp,offset:result.offset}};
        if (result) return result;
    }
    if (requestedGeneration!==generation) return {state:currentGeneration===generation ? 'generationMismatch' : 'reset'};
    if (checksRevision && requestedRevision!==revision) return {state:'conflict'};
    if (!force && !checksRevision && Number.isFinite(requestedTime) && Number.isFinite(currentTime) && requestedTime<currentTime)
        return {state:'keep'};
    return {state:'advance',journal:record ? await append(file,record.checkpoint,record.journal,record.line) : null};
}

async function append(file, checkpoint, journal, line) {
    const result=await writeRust(file,{op:'append',...recordForRust({checkpoint,journal,line})});
    if (result?.state==='written') return {stamp:result.stamp,offset:result.offset};
    if (result) throw new Error('Could not write reader progress');

    if (!journal.offset) {
        const data = Buffer.concat([Buffer.from(checkpoint + '\n'), line]);
        await writeFileAtomic(file, data, {syncDirectory: true});
        return {stamp: await stamp(file), offset: data.length};
    }

    const handle = await open(file, 'r+');
    try {
        const stat = await handle.stat({bigint:true});
        if (fileStamp(stat) !== journal.stamp)
            throw new Error('Reader progress journal changed during a write');
        if (stat.size !== BigInt(journal.offset)) await handle.truncate(journal.offset);
        let written = 0;
        while (written < line.length) {
            const {bytesWritten} = await handle.write(line, written, line.length - written, journal.offset + written);
            if (!bytesWritten) throw new Error('Could not write reader progress');
            written += bytesWritten;
        }
        await handle.sync();
        return {stamp: fileStamp(await handle.stat({bigint:true})), offset: journal.offset + line.length};
    } finally {
        await handle.close();
    }
}

async function writeSnapshot(file, progressFile, text) {
    const entriesFile=path.join(path.dirname(progressFile),'reading-lists.json');
    const entry=path.resolve(entriesFile)===path.resolve(file) ? rustJournal(progressFile) : null;
    if (entry) {
        const result=await runtime.withSignal(undefined,()=>withRustJournal(entry,async reader=>{
            const capability=await journalCapabilities(entry);
            if (capability?.state!=='ready' || !capability.snapshots) return null;
            const buffer=Buffer.from(text);
            const expected=await stamp(file);
            return reader.run(async process=>{
                const send=(action,payload={})=>process.query({op:'snapshot',action,...payload});
                const publish=async (action,payload)=>{
                    const result=await send(action,payload);
                    if (!['stored','changed'].includes(result?.state)) throw new Error('Could not publish profile snapshot');
                    return result;
                };
                if (buffer.length<=snapshotInlineBytes) return publish('replace',{expected,data:buffer.toString('base64')});
                const started=await send('begin',{expected,size:buffer.length});
                try {
                    if (started?.state!=='staged' || !/^\.reading-lists\.[a-zA-Z0-9]+$/.test(started.name))
                        throw new Error('Could not stage profile snapshot');
                    // Keep large snapshots off the JSON pipe. Rust verifies and commits its staging file.
                    await fs.writeFile(path.join(path.dirname(file),started.name),buffer,{flag:'r+'});
                    return await publish('finish');
                } catch (error) {
                    await send('cancel').catch(()=>{});
                    throw error;
                }
            },()=>{throw new Error('Could not write profile snapshot');});
        }));
        if (result?.state==='stored') return;
        if (result?.state==='changed') throw new Error('Profile snapshot changed during a write');
        if (result) throw new Error('Could not write profile snapshot');
    }
    await writeFileAtomic(file,text,{syncDirectory:true});
}

// Pre-upgrade snapshots must also open in versions predating the journal.
async function foldSnapshot(source, snapshot) {
    const journalFile = path.join(path.dirname(source), fileName);
    const journalStamp = await stamp(journalFile);
    if (!journalStamp) return;
    let data;
    try { data = JSON.parse(await fs.readFile(snapshot, 'utf8')); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return; // Preserve the original corrupt file for recovery.
    }
    const {offset} = await replay(journalFile, data?.[checkpointField], data, journalStamp);
    if (offset) {
        delete data[checkpointField];
        await writeFileAtomic(snapshot, JSON.stringify(data, null, 2));
    }
}

module.exports = {fileName, checkpointField, maxBytes, stamp, replay, append, update, writeSnapshot, runRustBackup, applyProgress, clear, foldSnapshot,
    startRustJournal};
