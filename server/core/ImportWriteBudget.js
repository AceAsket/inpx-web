const {sleep} = require('./utils');

class ImportWriteBudget {
    constructor(db, table, lowMemoryMode) {
        // JembaDB 5.1.7 keeps serialized rows in tableRowsFile.deltas until
        // their save completes. Its own queue checks count transactions only.
        this.table = db.table?.get(table);
        this.limit = (lowMemoryMode ? 8 : 24) * 1024 ** 2;
        this.sizes = new WeakMap();
    }

    pendingBytes() {
        let total = 0;
        for (const delta of this.table?.tableRowsFile?.deltas?.values() || []) {
            let size = this.sizes.get(delta);
            if (!size) {
                size = {rows:0, bytes:0};
                this.sizes.set(delta, size);
            }
            // Defragmentation can append rows while committing a delta.
            for (; size.rows < delta.blockRows.length; size.rows++)
                size.bytes += Buffer.byteLength(delta.blockRows[size.rows][1]);
            total += size.bytes;
            // Deletion batches may have no serialized rows but still generate
            // index/block-list entries, with defragmentation deferred to save.
            total += (delta.blockIndex.length + delta.blockList.length) * 32;
        }
        return total;
    }

    async wait() {
        this.check();
        // The producer can exceed the limit by one completed insert batch.
        while (this.pendingBytes() > this.limit) {
            await sleep(20);
            this.check();
        }
    }

    check() {
        if (this.table?.fileError) throw new Error(this.table.fileError);
    }
}

module.exports = ImportWriteBudget;
