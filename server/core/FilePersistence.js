const {AsyncLocalStorage} = require('async_hooks');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const context = new AsyncLocalStorage();
const queues = new Map();

// Serialize whole operations, including their reads, across instances in this process.
// Nested store calls join the current operation instead of waiting on themselves.
function withFileTransaction(file, task) {
    const key = path.resolve(file);
    const current = context.getStore();
    if (current && current.active && current.key === key)
        return task();

    const previous = queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => {
        const scope = {key, active: true};
        return context.run(scope, async() => {
            try {
                return await task();
            } finally {
                scope.active = false;
            }
        });
    });
    queues.set(key, operation);
    const cleanup = () => {
        if (queues.get(key) === operation)
            queues.delete(key);
    };
    operation.then(cleanup, cleanup);
    return operation;
}

async function writeFileAtomic(file, data) {
    await fs.ensureDir(path.dirname(file));
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
        const handle = await require('fs').promises.open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
    } finally {
        await fs.remove(temporary);
    }
}

module.exports = {withFileTransaction, writeFileAtomic};
