const fs = require('fs-extra');
const path = require('path');
const {writeFileAtomic, syncParentDirectory, withFileTransactions} = require('./FilePersistence');
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
    return withFileTransactions(Object.values(allowed), async() => {
        await recover(config);
        const folder = path.join(config.dataDir, '.restore-transaction');
        const manifestFile = path.join(folder, 'manifest.json');
        const manifest = {state: 'prepared', files: Object.keys(content), existed: {}};
        for (const name of manifest.files) {
            if (!Object.hasOwn(allowed, name))
                throw new Error(`Unsupported backup entry: ${name}`);
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
                await recover(config);
            } catch (rollbackError) {
                require('./FilePersistence').blockFileTransactions(Object.values(allowed));
                throw new global.AggregateError([error, rollbackError], 'Backup rollback failed; recovery journal retained for restart');
            }
            throw error;
        }
        // A committed journal is also safely cleaned up at the next start.
        await recover(config).catch(error => {
            // Keep the committed recovery marker until the obsolete journal
            // is removed. A failed cleanup does not undo a completed restore.
            console.warn(`Backup restore cleanup: ${error.message}`);
        });
    });
}

module.exports = {targets, recover, commit};
