const {safeHtml} = require('../../shared/safeHtml');
const protocol = {version:1, features:['metadata', 'ratings']};

async function respond(worker, request) {
    worker.checkMyState();
    const offset = Number(request.cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Некорректная позиция обмена');
    if (request.kind === 'ratings') {
        const index = await worker.dbSearcher.ratingIndex.load();
        if (request.revision && request.revision !== index.signature) throw new Error('Индекс оценок обновился. Повторите синхронизацию');
        const slice = index.entries.slice(offset, offset + 1000);
        const rows = slice.length ? await worker.db.select({table:'book', where:`@@id(${worker.db.esc(slice.map(entry => entry[1]))})`, map:'row => ({id:row.id, uid:row._uid})'}) : [];
        const ids = new Map(rows.map(row => [row.id, row.uid]));
        return {revision:index.signature, items:slice.map(([count, id]) => [ids.get(id), count]).filter(([uid]) => uid),
            next:offset + slice.length < index.entries.length ? offset + slice.length : null};
    }
    if (request.kind === 'author') {
        const name = String(request.author || '').trim();
        if (!name || name.length > 300) throw new Error('Некорректное имя автора');
        const {authorInfo} = await worker.getAuthorInfo('', name);
        return {authorInfo:authorInfo ? {html:safeHtml(String(authorInfo.html || '').slice(0, 128000)), text:String(authorInfo.text || '').slice(0, 128000)} : null};
    }
    const uid = String(request.bookUid || '');
    const book = uid && await worker.getBookRecordByUid(uid);
    if (!book) throw new Error('Книга не найдена');
    if (request.kind === 'rating') return {rating:await worker.getBookLibraryRating(book)};
    if (request.kind === 'reviews') {
        const reviews = await worker.getBookReviews(book);
        return {items:reviews.slice(offset, offset + 10).map(item => ({name:String(item.name || '').slice(0, 300),
            time:String(item.time || '').slice(0, 100), text:String(item.text || '').slice(0, 16000)})), next:offset + 10 < reviews.length ? offset + 10 : null};
    }
    throw new Error('Неизвестный вид метаданных');
}

module.exports = {protocol, respond};
