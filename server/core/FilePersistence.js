const {AsyncLocalStorage} = require('async_hooks');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const context = new AsyncLocalStorage();
const queues = new Map();
const blocked = new Set();

// Serialize whole operations, including their reads, across instances in this process.
// Nested store calls join the current operation instead of waiting on themselves.
function withFileTransaction(file, task) {
    const key = path.resolve(file);
    const current = context.getStore();
    for (let parent = current; parent; parent = parent.parent) {
        if (parent.active && parent.key === key)
            return task();
    }

    const previous = queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => {
        if (blocked.has(key))
            throw new Error('Восстановление данных прервано; требуется перезапуск для восстановления из журнала');
        const scope = {key, active: true, parent: current};
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

function withFileTransactions(files, task) {
    const keys = [...new Set(files.map(file => path.resolve(file)))].sort();
    const next = (index) => index === keys.length ? task() : withFileTransaction(keys[index], () => next(index + 1));
    return next(0);
}

function blockFileTransactions(files) {
    for (const file of files)
        blocked.add(path.resolve(file));
}

module.exports = {withFileTransaction, withFileTransactions, writeFileAtomic, blockFileTransactions};
