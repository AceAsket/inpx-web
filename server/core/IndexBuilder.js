const fs = require('fs-extra');
const path = require('node:path');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const DbCreator = require('./DbCreator');
const {prepareRustCatalogueUpdate} = require('./RustCatalogUpdate');
const {executable} = require('./RustLookupIndex');

async function buildIndex(config, dbPath, previousPath, report, signal) {
    if (await fs.pathExists(dbPath))
        throw new Error(`createDb.pathExists: ${dbPath}`);

    const creator = new DbCreator({...config,indexDbPath:dbPath,previousIndexPath:previousPath});
    const prepared = await prepareRustCatalogueUpdate(creator,previousPath,dbPath,report,signal);
    if (prepared?.nativeCatalogue) {
        await creator.finishNativeCatalogue(prepared,report);
        return;
    }
    if (!prepared && executable() && config.rustCompatibilityTables!==true && config.rustBookStoreEnabled!==false
        && config.rustCatalogUpdateEnabled!==false && !config.lowMemoryMode) {
        await creator.buildStandaloneCatalogue(report);
        return;
    }
    const previousBook = !prepared && previousPath && path.join(previousPath, 'book');
    if (previousBook && await fs.pathExists(previousBook)) {
        // The serving catalogue only reads its book table. Copy it to retain
        // record IDs; query caches in the live database may still be changing.
        await fs.copy(previousBook, path.join(dbPath, 'book'));
    } else if (!prepared && previousPath && await fs.pathExists(path.join(previousPath,'catalogue.json'))) {
        creator.config.identityDbPath = previousPath;
    }

    const db = new (require('jembadb/src/JembaDb'))();
    await db.lock({dbPath, create:true, softLock:true, tableDefaults:{cacheSize:config.dbCacheSize}});
    try {
        await creator.run(db,report,prepared);
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
        let completed = false, failure, abortTimer;
        const abort = () => {
            worker.postMessage({abort:true});
            abortTimer = setTimeout(() => {void worker.terminate().catch(() => {});},5000);
        };
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) abort();
        worker.on('message', ({progress, done, error}) => {
            if (progress) report(progress);
            if (done) completed = true;
            if (error) failure = new Error(error);
        });
        worker.once('error', error => {failure = error;});
        worker.once('exit', code => {
            clearTimeout(abortTimer);
            signal?.removeEventListener('abort', abort);
            if (signal?.aborted) reject(signal.reason);
            else if (completed && code === 0) resolve();
            else reject(failure || new Error(`Index builder exited with code ${code}`));
        });
    });
}

if (!isMainThread && workerData?.indexBuild) {
    const {config, dbPath, previousPath} = workerData.indexBuild;
    const controller = new AbortController();
    parentPort.on('message', message => {if (message.abort) controller.abort();});
    (async() => {
        await new (require('./AppLogger'))().init({...config, loggingEnabled:false});
        await buildIndex(config, dbPath, previousPath, progress => {
            controller.signal.throwIfAborted();
            parentPort.postMessage({progress});
        },controller.signal);
        parentPort.postMessage({done:true});
    })().catch(error => parentPort.postMessage({error:error.message}))
        .finally(() => parentPort.close());
}

module.exports = {buildIndexInWorker};
