const fs = require('fs-extra');
const path = require('node:path');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const DbCreator = require('./DbCreator');

async function buildIndex(config, dbPath, previousPath, report) {
    if (await fs.pathExists(dbPath))
        throw new Error(`createDb.pathExists: ${dbPath}`);

    const previousBook = previousPath && path.join(previousPath, 'book');
    if (previousBook && await fs.pathExists(previousBook)) {
        // The serving catalogue only reads its book table. Copy it to retain
        // record IDs; query caches in the live database may still be changing.
        await fs.copy(previousBook, path.join(dbPath, 'book'));
    }

    const db = new (require('jembadb/src/JembaDb'))();
    await db.lock({dbPath, create:true, softLock:true, tableDefaults:{cacheSize:config.dbCacheSize}});
    try {
        await new DbCreator({...config, indexDbPath:dbPath}).run(db, report);
    } finally {
        await db.unlock();
    }
}

function buildIndexInWorker(config, dbPath, previousPath, report, signal) {
    signal?.throwIfAborted();
    const worker = new Worker(`require(${JSON.stringify(__filename)})`, {
        eval:true, workerData:{indexBuild:{config, dbPath, previousPath}},
    });
    return new Promise((resolve, reject) => {
        let completed = false, failure;
        const abort = () => {void worker.terminate().catch(() => {});};
        signal?.addEventListener('abort', abort, {once:true});
        worker.on('message', ({progress, done, error}) => {
            if (progress) report(progress);
            if (done) completed = true;
            if (error) failure = new Error(error);
        });
        worker.once('error', error => {failure = error;});
        worker.once('exit', code => {
            signal?.removeEventListener('abort', abort);
            if (signal?.aborted) reject(signal.reason);
            else if (completed && code === 0) resolve();
            else reject(failure || new Error(`Index builder exited with code ${code}`));
        });
    });
}

if (!isMainThread && workerData?.indexBuild) {
    const {config, dbPath, previousPath} = workerData.indexBuild;
    (async() => {
        await new (require('./AppLogger'))().init({...config, loggingEnabled:false});
        await buildIndex(config, dbPath, previousPath, progress => parentPort.postMessage({progress}));
        parentPort.postMessage({done:true});
    })().catch(error => parentPort.postMessage({error:error.message}))
        .finally(() => parentPort.close());
}

module.exports = {buildIndexInWorker};
