const MiB = 1024 ** 2;
function policy(config = {}) {
    const memory = require('./ResourcePolicy').hardware().memoryLimit;
    const fallback = config.lowMemoryMode ? 8 : Math.max(8, Math.min(64, Math.floor(memory / MiB / 64)));
    const mb = config.dbCacheBudgetMb == null ? fallback : Number(config.dbCacheBudgetMb);
    if (!Number.isInteger(mb) || mb < 1 || mb > 1024) throw new Error('dbCacheBudgetMb: expected 1–1024 MiB');
    return {budgetBytes:mb * MiB, idleMs:30000};
}

// Budget applies to decoded row blocks across ALL open tables. Tree/hash
// indexes stay open; dropping them on every idle period would make queries slow.
// A conservative 4x encoded-size estimate accounts for JS strings/objects.
class DatabaseCache {
    constructor(db, {budgetBytes, idleMs = 30000}) {
        this.db = db; this.budgetBytes = budgetBytes; this.idleMs = idleMs;
        this.blocks = new Map(); this.protected = new Map(); this.attached = new WeakSet(); this.bytes = 0;
        this.evictions = 0; this.idleEvictions = 0; this.hits = 0; this.misses = 0;
        this.timer = setInterval(() => this.trim(true), Math.max(20, Math.min(1000, idleMs)));
        this.timer.unref?.();
    }
    attach() {
        for (const [table, instance] of this.db.table || []) {
            const rows = instance.tableRowsFile;
            if (!rows || this.attached.has(rows)) continue;
            this.attached.add(rows);
            const getRow = rows.getRow.bind(rows), cache = this;
            rows.getRow = async function(id) {
                const block = rows.blockList.get(rows.blockIndex.get(id));
                if (!block) return getRow(id);
                block.rows ? cache.hits++ : cache.misses++;
                cache.protected.set(block, (cache.protected.get(block) || 0) + 1);
                let entered = false;
                try {
                    const result = await getRow(id);
                    const previous = cache.blocks.get(block);
                    if (block.rows && !previous) {
                        entered = true;
                        cache.blocks.delete(block);
                        cache.blocks.set(block, {table, rows, at:Date.now(), bytes:Math.max(1024, block.size * 4)});
                    } else if (previous) previous.at = Date.now();
                    return result;
                } finally {
                    const users = cache.protected.get(block) - 1;
                    users ? cache.protected.set(block, users) : cache.protected.delete(block);
                    // A scan can read millions of rows from the same block. Recount
                    // the global budget only when a block enters the cache.
                    if (entered) cache.trim();
                }
            };
        }
        this.trim();
    }
    trim(idle = false) {
        let bytes = 0;
        for (const [block, info] of this.blocks) {
            if (!block.rows || this.db.table?.get(info.table)?.tableRowsFile !== info.rows
                || info.rows.blockList.get(block.index) !== block) this.blocks.delete(block);
            else {info.bytes = Math.max(1024, block.size * 4); bytes += info.bytes;}
        }
        for (const [block, info] of [...this.blocks].sort((a, b) => a[1].at - b[1].at)) {
            const expired = idle && Date.now() - info.at >= this.idleMs;
            if (!expired && bytes <= this.budgetBytes) continue;
            if (this.protected.has(block) || block.index >= info.rows.lastSavedBlockIndex) continue;
            block.rows = null;
            info.rows.loadedBlocks = info.rows.loadedBlocks.filter(index => index !== block.index);
            this.blocks.delete(block); bytes -= info.bytes; this.evictions++;
            if (expired) this.idleEvictions++;
        }
        this.bytes = bytes;
    }
    snapshot() {
        this.trim();
        const pinnedBytes = [...this.blocks].reduce((sum, [block, info]) =>
            sum + (block.index >= info.rows.lastSavedBlockIndex || this.protected.has(block) ? info.bytes : 0), 0);
        return {budgetBytes:this.budgetBytes, estimatedBytes:this.bytes, blocks:this.blocks.size,
            pinnedBytes,
            evictions:this.evictions, idleEvictions:this.idleEvictions, hits:this.hits, misses:this.misses,
            workerHeapUsed:process.memoryUsage().heapUsed, workerHeapTotal:process.memoryUsage().heapTotal,
            workerHeapLimit:require('v8').getHeapStatistics().heap_size_limit};
    }
}
module.exports = {DatabaseCache, policy};
