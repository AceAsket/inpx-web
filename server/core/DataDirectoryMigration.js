const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const {targets} = require('./BackupTransaction');

const databaseDirectories = ['db', 'db.previous', 'web-access'];
const databaseLocks = new Set(['__lock', '__softlock', '__softlockcheck']);
const stateEntries = [
    'session-secret', 'reader-backgrounds', 'public', 'backups',
    'kosync.json', 'kosync', 'telegram-bot-state.json', 'resource-benchmark.json',
    // Keep the previous index so a rebuild can retain legacy book identifiers.
    ...databaseDirectories,
];

async function copyWorkingDirectory(source, destination, config) {
    const configFile = path.resolve(config.configFile);
    const entries = Object.keys(targets({...config, dataDir: source})).filter(name => name !== 'config.json');
    const existing = [];
    for (const entry of [...entries, ...stateEntries]) {
        try {
            const stat = await fs.lstat(path.join(source, entry));
            existing.push({entry, size: stat.size, changed: stat.ctimeMs});
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    if (!existing.length) return destination;

    // An unchanged source can resume after a failed config save. A later rollback
    // and upgrade gets a new destination for the newer legacy state.
    const configStat = await fs.stat(configFile);
    const id = crypto.createHash('sha256')
        .update(JSON.stringify([source, configFile, configStat.ctimeMs, existing]))
        .digest('hex').slice(0, 12);
    const migrated = path.join(destination, `migrated-data-${id}`);
    const marker = '.data-dir-migration.json';
    const isComplete = async () => {
        try {
            const receipt = await fs.readJson(path.join(migrated, marker));
            return receipt.source === source && receipt.configFile === configFile;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return false;
        }
    };
    if (await isComplete()) return migrated;

    // Publish the complete data directory before changing config.json. An existing
    // installation in the destination and the original data can both be recovered.
    const stage = await fs.mkdtemp(path.join(destination, '.data-dir-migration-'));
    try {
        for (const {entry} of existing) {
            const entryPath = path.join(source, entry);
            const isDatabase = databaseDirectories.includes(entry);
            await fs.copy(entryPath, path.join(stage, entry), {
                filter: async file => {
                    if (isDatabase && path.dirname(file) === entryPath && databaseLocks.has(path.basename(file))) return false;
                    if ((await fs.lstat(file)).isSymbolicLink())
                        throw new Error(`Symbolic link in legacy data: ${file}`);
                    return true;
                },
            });
        }
        await fs.writeJson(path.join(stage, marker), {source, configFile});
        try {
            await fs.rename(stage, migrated);
        } catch (error) {
            if (!await isComplete()) throw error;
        }
        return migrated;
    } finally {
        await fs.remove(stage);
    }
}

async function migrateWorkingDirectory(config, saved) {
    const cwd = process.cwd();
    if (typeof saved.dataDir !== 'string' || !saved.dataDir || path.isAbsolute(saved.dataDir) || path.resolve(saved.dataDir) !== cwd)
        return false;

    const source = await fs.realpath(cwd);
    let destination = path.resolve(config.dataDir);
    await fs.ensureDir(destination);
    if (await fs.realpath(destination) === source) {
        destination = path.join(config.execDir, `.${config.name}`);
        await fs.ensureDir(destination);
        if (await fs.realpath(destination) === source)
            throw new Error('Set --data-dir to a different directory to migrate legacy data');
    }

    saved.dataDir = await copyWorkingDirectory(source, destination, config);
    for (const [setting, folder] of [['tempDir', 'tmp'], ['logDir', 'log']]) {
        if (typeof saved[setting] !== 'string' || !saved[setting]) continue;
        const previous = path.resolve(saved[setting]);
        if (previous === cwd || previous === path.join(cwd, folder)) saved[setting] = '';
    }
    return true;
}

module.exports = {migrateWorkingDirectory};
