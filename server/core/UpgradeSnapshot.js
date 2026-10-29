const fs = require('fs-extra');
const path = require('path');
const {writeFileAtomic} = require('./FilePersistence');

// Run before configuration migration and before any worker starts writing user data.
async function prepare(config) {
    const marker = path.join(config.dataDir, '.upgrade-version.json');
    let previous;
    try {previous = await fs.readJson(marker);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (previous?.version === config.version) return previous.snapshot || null;
    const targets = {...require('./BackupTransaction').targets(config), public:path.join(config.dataDir, 'public')};
    const existing = [];
    for (const [name, target] of Object.entries(targets)) {
        if (target && await fs.pathExists(target)) existing.push([name, target]);
    }
    let snapshot = null;
    if (existing.length) {
        const root = path.join(config.dataDir, '.upgrade-backups');
        await fs.ensureDir(root, {mode:0o700});
        const stage = await fs.mkdtemp(path.join(root, '.pending-'));
        try {
            await fs.chmod(stage, 0o700);
            for (const [name, target] of existing) {
                await fs.copy(target, path.join(stage, name), {filter:async source => {
                    if ((await fs.lstat(source)).isSymbolicLink())
                        throw new Error('Символическая ссылка в данных резервной копии обновления');
                    return true;
                }});
            }
            await writeFileAtomic(path.join(stage, 'manifest.json'), JSON.stringify({
                createdAt:new Date().toISOString(), targetVersion:config.version,
                files:existing.map(([name]) => name), configFile:config.configFile,
            }, null, 2));
            snapshot = path.join(root, `${Date.now()}-${String(config.version).replace(/[^a-z0-9.-]/gi, '_')}`);
            await fs.rename(stage, snapshot);
        } finally {await fs.remove(stage);}
    }
    await writeFileAtomic(marker, JSON.stringify({version:config.version, snapshot}));
    return snapshot;
}

module.exports = {prepare};
