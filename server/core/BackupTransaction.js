const fs = require('fs-extra');
const path = require('path');
const {writeFileAtomic, syncParentDirectory, withFileTransactions, blockFileTransactions} = require('./FilePersistence');
const progressJournal = require('./ReaderProgressJournal');
const durable = {syncDirectory: true};

function targets(config) {
    return {
        'config.json': config.configFile,
        'secret.key': path.join(config.dataDir, 'secret.key'),
        'reading-lists.json': path.join(config.dataDir, 'reading-lists.json'),
        'discovery-cache.json': path.join(config.dataDir, 'discovery-cache.json'),
        'backup-vault.json': path.join(config.dataDir, 'backup-vault.json'),
    };
}

async function clearRestoredProgressJournal(readingLists) {
    const file = path.join(path.dirname(readingLists), progressJournal.fileName);
    const stamp = await progressJournal.stamp(file);
    if (!stamp) return;
    // A previous attempt may have committed the restore and then failed to
    // remove its recovery directory. Preserve any new journal since created.
    const data = await fs.readJson(readingLists);
    const journal = await progressJournal.replay(file, data[progressJournal.checkpointField], data, stamp);
    if (!journal.offset) await progressJournal.clear(file);
}

async function recover(config) {
    const folder = path.join(config.dataDir, '.restore-transaction');
    if (!await fs.pathExists(folder)) return;
    if (await runNative(config, send => recoverNative(config, send))) return;
    await recoverLegacy(config);
}

async function runNative(config, work) {
    return progressJournal.runRustBackup(path.join(config.dataDir, progressJournal.fileName), config.configFile, work);
}

function requireState(reply, state) {
    if (reply?.state !== state)
        throw new Error(reply?.message || 'Unexpected backup transaction response');
}

async function finishNative(config, send, clearProgress) {
    if (clearProgress)
        await clearRestoredProgressJournal(targets(config)['reading-lists.json']);
    requireState(await send('finish'), 'clean');
}

async function recoverNative(config, send) {
    const result = await send('recover');
    if (result?.state === 'clearProgress') await finishNative(config, send, true);
    else requireState(result, 'clean');
}

async function commitNative(config, send, content, files, allowed) {
    const incoming = path.join(config.dataDir, '.restore-transaction', 'incoming');
    await recoverNative(config, send);
    await fs.mkdir(incoming, {recursive: true, mode: 0o700});
    for (const name of files)
        await fs.writeFile(path.join(incoming, name), content[name], {flag: 'wx', mode: 0o600});

    let result;
    try {
        result = await send('commit', {files});
        if (!['failed', 'committed'].includes(result?.state))
            throw new Error('Unexpected backup transaction response');
    } catch (error) {
        blockFileTransactions(Object.values(allowed));
        throw error;
    }
    if (result.blocked) blockFileTransactions(Object.values(allowed));
    requireState(result, 'committed');
    await finishNative(config, send, result.profiles).catch(warnCleanup);
}

function warnCleanup(error) {
    // Keep the committed marker until the obsolete progress journal is cleared.
    console.warn(`Backup restore cleanup: ${error.message}`);
}

async function recoverLegacy(config) {
    const folder = path.join(config.dataDir, '.restore-transaction');
    const manifestFile = path.join(folder, 'manifest.json');
    if (!await fs.pathExists(manifestFile)) {
        // No target is touched until the complete journal is published.
        await fs.remove(folder);
        return;
    }
    const manifest = await fs.readJson(manifestFile);
    const allowed = targets(config);
    if (!['prepared', 'committed'].includes(manifest.state) || !manifest.existed
        || !Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length
        || manifest.files.some(name => !Object.hasOwn(allowed, name) || typeof manifest.existed[name] !== 'boolean'))
        throw new Error('Invalid backup recovery journal');
    if (manifest.state !== 'committed') {
        for (const name of manifest.files) {
            if (manifest.existed[name])
                await writeFileAtomic(allowed[name], await fs.readFile(path.join(folder, name)), durable);
            else
                await fs.remove(allowed[name]);
        }
    } else if (manifest.files.includes('reading-lists.json')) await clearRestoredProgressJournal(allowed['reading-lists.json']);
    await fs.remove(folder);
}

async function commit(config, content) {
    const allowed = targets(config);
    const files = Object.keys(content);
    for (const name of files) {
        if (!Object.hasOwn(allowed, name))
            throw new Error(`Unsupported backup entry: ${name}`);
    }
    return withFileTransactions(Object.values(allowed), async() => {
        if (await runNative(config, send => commitNative(config, send, content, files, allowed))) return;
        await recoverLegacy(config);
        const folder = path.join(config.dataDir, '.restore-transaction');
        const manifestFile = path.join(folder, 'manifest.json');
        const manifest = {state: 'prepared', files, existed: {}};
        for (const name of manifest.files) {
            manifest.existed[name] = await fs.pathExists(allowed[name]);
            if (manifest.existed[name])
                await writeFileAtomic(path.join(folder, name), await fs.readFile(allowed[name]));
        }
        await writeFileAtomic(manifestFile, JSON.stringify(manifest), durable);
        await syncParentDirectory(folder);
        try {
            for (const name of manifest.files)
                await writeFileAtomic(allowed[name], content[name], durable);
            manifest.state = 'committed';
            await writeFileAtomic(manifestFile, JSON.stringify(manifest), durable);
        } catch (error) {
            try {
                await recoverLegacy(config);
            } catch (rollbackError) {
                blockFileTransactions(Object.values(allowed));
                throw new global.AggregateError([error, rollbackError], 'Backup rollback failed; recovery journal retained for restart');
            }
            throw error;
        }
        // A committed journal is also safely cleaned up at the next start.
        await recoverLegacy(config).catch(warnCleanup);
    });
}

module.exports = {targets, recover, commit};
