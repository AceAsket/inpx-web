const fs = require('fs-extra');
const path = require('path');
const {open} = require('fs').promises;
const {writeFileAtomic} = require('./FilePersistence');

const fileName = 'reader-progress.log';
const checkpointField = 'readerProgressCheckpoint';
const maxBytes = 1024 * 1024;

function fileStamp(stat) {
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function stamp(file) {
    try { return fileStamp(await fs.stat(file)); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
    }
}

function applyProgress(user, bookUid, progress, updatedAt) {
    user.readerProgress ||= {};
    Object.defineProperty(user.readerProgress, bookUid, {
        value: progress, enumerable: true, configurable: true, writable: true,
    });
    user.updatedAt = updatedAt;
}

async function replay(file, checkpoint, data, currentStamp) {
    const journal = {stamp: currentStamp, offset: 0};
    if (!currentStamp || typeof checkpoint !== 'string' || !/^[a-f0-9]{32}$/.test(checkpoint)) return journal;

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
    const users = new Map((Array.isArray(data.users) ? data.users : []).filter(user => user?.id).map(user => [user.id, user]));
    const lines = contents.toString('utf8', firstLine + 1, journal.offset).split('\n');
    lines.pop();
    const invalidEntry = () => new Error('Некорректная запись в журнале прогресса чтения');
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

async function append(file, checkpoint, journal, line) {
    if (!journal.offset) {
        const data = Buffer.concat([Buffer.from(checkpoint + '\n'), line]);
        await writeFileAtomic(file, data);
        return {stamp: await stamp(file), offset: data.length};
    }

    const handle = await open(file, 'r+');
    try {
        const stat = await handle.stat();
        if (fileStamp(stat) !== journal.stamp)
            throw new Error('Reader progress journal changed during a write');
        if (stat.size !== journal.offset) await handle.truncate(journal.offset);
        let written = 0;
        while (written < line.length) {
            const {bytesWritten} = await handle.write(line, written, line.length - written, journal.offset + written);
            if (!bytesWritten) throw new Error('Could not write reader progress');
            written += bytesWritten;
        }
        await handle.sync();
        return {stamp: fileStamp(await handle.stat()), offset: journal.offset + line.length};
    } finally {
        await handle.close();
    }
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

module.exports = {fileName, checkpointField, maxBytes, stamp, replay, append, applyProgress, foldSnapshot};
