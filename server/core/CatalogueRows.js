async function byIds(db,ids,fields) {
    if (db.nativeCatalogue) return db.booksByIds(Array.isArray(ids) || ArrayBuffer.isView(ids) ? ids : [ids],fields);
    return db.select({table:'book',where:`@@id(${db.esc(ids)})`,
        ...(fields ? {map:`row => Object.fromEntries(${db.esc(fields)}.map(key=>[key,row[key]]))`} : {})});
}

async function byUids(db,uids,fields) {
    if (!db.nativeCatalogue) return db.select({table:'book',where:`@@hash('_uid', ${db.esc(uids)})`,
        ...(fields ? {map:`row => Object.fromEntries(${db.esc(fields)}.map(key=>[key,row[key]]))`} : {})});
    const rows = await db.booksByUids(Array.isArray(uids) ? uids : [uids]);
    return fields ? rows.map(row=>Object.fromEntries(fields.map(key=>[key,row[key]]))) : rows;
}

async function orderedIds(db) {
    if (db.nativeCatalogue) return db.catalogueBookIds();
    return (await db.select({table:'book',rawResult:true,where:'return Array.from(@all());'}))[0].rawResult;
}

module.exports = {byIds,byUids,orderedIds};
