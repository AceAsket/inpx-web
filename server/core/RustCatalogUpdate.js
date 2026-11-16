const fs = require('fs-extra');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {getEnabledLibrarySources} = require('./LibrarySources');
const InpxHashCreator = require('./InpxHashCreator');
const {executable,lookupGeneration} = require('./RustLookupIndex');
const {preparePatch,writeStoreMarker} = require('./RustBookStoreBuild');

const postingTables = ['author','series','title','word','genre','lang','del','date','librate','ext','source'];

async function prepare(binary, directory, request, report, signal) {
    signal?.throwIfAborted();
    const child = spawn(binary,['prepare-update',directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const lines = createInterface({input:child.stdout,crlfDelay:Infinity});
    let stderr = '', inputError;
    child.stderr.setEncoding('utf8').on('data',part => {stderr = (stderr + part).slice(-2048);});
    child.stdin.on('error',error => {inputError = error;});
    const done = new Promise(resolve => {
        child.once('error',resolve);
        child.once('close',(code,signal) => resolve(code === 0 ? null : new Error(stderr.trim() || `Rust catalogue update exited (${signal || code})`)));
    });
    const abort = () => child.kill();
    signal?.addEventListener('abort',abort,{once:true});
    let summary;
    try {
        child.stdin.end(JSON.stringify(request));
        for await (const line of lines) {
            const message = JSON.parse(line);
            if (message.summary) summary = message.summary;
            else report(message);
        }
        const error = await done;
        signal?.throwIfAborted();
        if (error || inputError) throw error || inputError;
        if (!summary || summary.parserInfos?.length !== request.sources.length || !summary.counts
            || !['recsLoaded','recordsChanged','recordsRemoved'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0))
            throw new Error('Invalid Rust catalogue update summary');
        return summary;
    } finally {
        signal?.removeEventListener('abort',abort);
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done;
    }
}

async function prepareRustCatalogueUpdate(creator, previousPath, destination, report, signal) {
    const config = creator.config;
    const binary = executable();
    const nativeCatalogue = config.rustCompatibilityTables !== true;
    if (!binary || config.rustBookStoreEnabled === false
        || config.rustCatalogUpdateEnabled === false) return null;
    if (!nativeCatalogue && (config.lowMemoryMode || config.fullOptimization || !previousPath || config.identityDbPath
        || require('jembadb/package.json').version !== '5.1.7')) return null;
    const sources = getEnabledLibrarySources(config);
    if (!sources.length || sources.some(source => source.type === 'folder')) return null;
    const identityPath = previousPath || config.identityDbPath;
    const previousNative = nativeCatalogue && identityPath && await fs.pathExists(path.join(identityPath,'catalogue.json'));
    const previousBook = !previousNative && identityPath && path.join(identityPath,'book');
    const legacyBook = previousBook && await fs.pathExists(previousBook) ? previousBook : undefined;
    if (identityPath && !legacyBook && !previousNative) return null;
    const filter = await creator.loadInpxFilter();
    if (filter?.filter) return null;

    await fs.ensureDir(destination);
    const stage = await fs.mkdtemp(path.join(destination,'.rust-catalog-'));
    let publishing = false;
    try {
        const previousGeneration = await preparePatch(stage,previousPath);
        const sourceHash = await new InpxHashCreator(config).getHash();
        const generation = lookupGeneration({inpxHash:sourceHash,dbVersion:config.dbVersion,rustLookupBuiltAt:new Date().toISOString()});
        const previousCatalogueGeneration = previousNative
            ? (await fs.readJson(path.join(identityPath,'catalogue.json'))).rustBookStoreGeneration : undefined;
        const request = {previousBook:legacyBook,previousCatalogue:previousNative ? identityPath : undefined,
            previousCatalogueGeneration,previousGeneration,generation,nativeCatalogue,lowMemory:!!config.lowMemoryMode,
            sources:sources.map(({id,name,inpx,inpxFile,libDir}) => ({id,name,inpx:inpxFile || inpx,libDir})),
            includeAuthors:filter?.includeAuthors,excludeAuthors:filter?.excludeAuthors};
        report({jobStepCount:9});
        const summary = await prepare(binary,stage,request,report,signal);
        await writeStoreMarker(stage,generation);
        signal?.throwIfAborted();
        publishing = true;
        for (const name of await fs.readdir(stage)) await fs.rename(path.join(stage,name),path.join(destination,name));
        const incremental = !!previousPath;
        report({nativeUpdate:incremental,nativeIdentities:!!identityPath,rustReader:true,
            bookStoreMode:previousGeneration ? 'patch' : 'base',incremental});
        return {...summary,sourceHash,generation,filter,nativeCatalogue,incremental};
    } catch (error) {
        signal?.throwIfAborted();
        if (publishing) throw error;
        report({rustUpdateWarning:error.message});
        return null;
    } finally {
        await fs.remove(stage);
    }
}

async function readPostings(directory, namesOnly = false) {
    const temporary = path.join(directory,'.postings');
    const result = {};
    for (const table of namesOnly ? postingTables.slice(0,4) : postingTables)
        result[`${table}Arr`] = await fs.readJson(path.join(temporary,table));
    await fs.remove(temporary);
    return result;
}

module.exports = {prepareRustCatalogueUpdate,readPostings};
