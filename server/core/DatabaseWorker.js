const {parentPort, workerData} = require('worker_threads');
// Import the database directly: jembadb's barrel also installs its own
// parentPort handler, which would execute every worker request twice.
const JembaDb = require('jembadb/src/JembaDb');
const {DatabaseCache} = require('./DatabaseCache');
const db = new JembaDb(), cache = new DatabaseCache(db, workerData);
parentPort.on('message', async message => {
    let result;
    try {
        cache.attach();
        result = {result:message.action === 'cacheStats' ? cache.snapshot() : await db[message.action](message.query)};
        cache.attach();
    } catch (error) {result = {error:error.message};}
    parentPort.postMessage({...result, requestId:message.requestId});
});
