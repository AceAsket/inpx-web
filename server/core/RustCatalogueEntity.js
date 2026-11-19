async function entityNameIds(searcher,kind,name) {
    if (!searcher?.db?.nativeCatalogue || !searcher.db.bookStoreCatalogueEntities) return null;
    return searcher.exactNameIds(kind,[name.toLowerCase()]);
}

async function rows(searcher,kind,name,scope) {
    const nameIds = await entityNameIds(searcher,kind,name);
    if (nameIds === null) return null;
    if (!nameIds.length) return [];
    return searcher.db.bookStore.run(async process => {
        const groups = await searcher.discoveryFacetGroups(process,scope,false);
        if (!groups) return null;
        return process.query({op:'entityRows',table:kind,nameIds,groups,lookupGeneration:searcher.dbConfig.rustLookupGeneration});
    }, () => null);
}

function packOrder(members) {
    const bytes = Buffer.allocUnsafe(members.length * 4);
    for (let index = 0; index < members.length; index++) bytes.writeUInt32LE(members[index].id,index * 4);
    return bytes.toString('base64');
}

async function page(db,ordered,progress,page,limit,hasProfile) {
    if (!ordered.packed) return null;
    let completed;
    if (hasProfile) {
        const flags = Buffer.alloc(Math.ceil(ordered.members.length / 8));
        for (const [index,{uid}] of ordered.members.entries()) {
            const item = progress[uid];
            if (!item?.hidden && Number(item?.percent) >= .999) flags[index >>> 3] |= 1 << (index & 7);
        }
        completed = flags.toString('base64');
    }
    return db.bookStore.run(process=>process.query({op:'entityPage',order:ordered.packed,completed,
        page:Math.min(page,Number.MAX_SAFE_INTEGER),limit}),() => null);
}

async function seriesVolumes(worker,name,target) {
    const {dbSearcher:searcher,db,libraryAssetGeneration:generation} = worker;
    if (!db?.nativeCatalogue || !db.bookStoreCatalogueEntities) return null;
    worker.checkMyState();
    const nameIds = await entityNameIds(searcher,'series',name);
    if (nameIds === null) return null;
    if (!nameIds.length) return {status:'invalidVolume'};
    const overrides = await worker.readingListStore.getMetadataOverrides();
    const numbers = Object.fromEntries(Object.entries(overrides).filter(([,entry])=>entry && Object.hasOwn(entry,'serno'))
        .map(([uid,entry])=>[uid,Number(entry.serno)]));
    const result = await db.bookStore.run(process=>process.query({op:'seriesVolumes',nameIds,target,numbers,
        lookupGeneration:searcher.dbConfig.rustLookupGeneration}),() => null);
    if (db !== worker.db || generation !== worker.libraryAssetGeneration) throw new Error('Библиотека обновилась. Повторите запрос');
    return result;
}

module.exports = {rows,packOrder,page,seriesVolumes};
