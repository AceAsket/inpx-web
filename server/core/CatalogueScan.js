const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

async function* readBooks(db, ids, fields) {
    const keys = ids ?? await db.catalogueBookIds();
    const batchSize = fields ? 2048 : 512;
    for (let offset=0;offset<keys.length;offset+=batchSize) {
        const rows = await db.booksByIds(keys.slice(offset,offset+batchSize),fields);
        yield* rows;
    }
}

// Run the existing server-authored ranking logic against either reader. Only
// the loop and selected-row loader differ between the two storage engines.
async function scanBooks(db, render, {ids,fields} = {}) {
    if (db.nativeCatalogue) {
        const body = render('for await (const row of readBooks()) {','return loadBooks(selected.map(row=>row.id));');
        const run = new AsyncFunction('readBooks','loadBooks',`'use strict';\n${body}`);
        return [{rawResult:await run(()=>readBooks(db,ids,fields),keys=>db.booksByIds(keys))}];
    }
    const keys = ids == null ? '@all()' : db.esc(Array.from(ids));
    const where = render(`for (const scannedId of ${keys}) { const row = @unsafeRow(scannedId);`,
        'const books = []; for (const row of selected) books.push(@unsafeRow(row.id)); return books;');
    return db.select({table:'book',rawResult:true,where});
}

module.exports = {scanBooks,readBooks};
