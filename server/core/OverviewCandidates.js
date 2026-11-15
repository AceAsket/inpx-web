const {words, root} = require('../../shared/CatalogSearch');
const DAY = 86400000;

function appendSample(result, ids, count, seed = 0) {
    if (!ids?.length || count <= 0) return;
    const take = Math.min(count, ids.length);
    for (let i = 0; i < take; i++) {
        const start = Math.floor(i * ids.length / take);
        const end = Math.floor((i + 1) * ids.length / take);
        result.push(ids[start + seed % (end - start)]);
    }
}

async function dates(db, now, windows, limit, seed = 0) {
    const rows = await db.select({table:'date', rawResult:true, where:`
        const append = ${appendSample.toString()};
        const days = ${db.esc(windows)}, now = ${db.esc(now)}, day = ${DAY};
        const dates = [];
        // The unique index has one entry per date. Open only the posting lists we use.
        const index = __tr._index.get('value');
        for (const [value,id] of index.hash) {
            const time = Date.parse(value);
            if (Number.isFinite(time) && time <= now) dates.push({id,time});
        }
        dates.sort((a,b) => b.time - a.time);
        const groups = (days.length ? days : [Infinity]).map(() => []);
        for (const {id,time} of dates) {
            const age = Math.floor((now-time)/day);
            const index = days.length ? days.findIndex(max=>age<=max) : 0;
            if (index < 0) continue;
            const group = groups[index];
            if (group.length < ${db.esc(limit)}) append(group, (@unsafeRow(id))?.bookIds, ${db.esc(limit)} - group.length, ${db.esc(seed)});
        }
        return groups.flat();
    `});
    return rows[0].rawResult;
}

async function postings(db, table, keys, total, seed = 0) {
    if (!keys.length || !total) return [];
    const rows = await db.select({table, rawResult:true, where:`
        const append = ${appendSample.toString()};
        const post = [];
        for (const key of ${db.esc([...new Set(keys)])})
            for (const id of @indexLR('value', key, key)) {
                const ids = (@unsafeRow(id))?.bookIds;
                if (ids?.length) post.push(ids);
            }
        const result = [], total = ${db.esc(total)};
        post.sort((a,b) => a.length - b.length);
        for (let i = 0; i < post.length && result.length < total; i++) {
            const share = Math.ceil((total - result.length) / (post.length - i));
            append(result, post[i], share, ${db.esc(seed)});
        }
        return result;
    `});
    return rows[0].rawResult;
}

function tasteKeys(weights, max) {
    return Object.entries(weights).sort((a,b) => b[1] - a[1]).slice(0,max).map(([key]) => key);
}

function bookReadOrder(ids, blocks) {
    return Array.from(ids).sort((a,b) => (blocks?.get(a) || 0) - (blocks?.get(b) || 0) || a-b);
}

async function recommendations(db, weights, limit, seed, now) {
    const {authors, series, genres, languages, keywords} = weights;
    const candidates = await Promise.all([
        postings(db,'author',tasteKeys(authors,24),limit*32,seed),
        postings(db,'series',tasteKeys(series,16),limit*16,seed+1),
        postings(db,'genre',tasteKeys(genres,16),limit*32,seed+2),
        postings(db,'lang',tasteKeys(languages,8),limit*16,seed+3),
        postings(db,'word',tasteKeys(keywords,24).flatMap(key => words(key)
            .map(word => 'title:'+root(word))),limit*12,seed+4),
        dates(db,now,[30,90,365],limit*4,seed+5),
        postings(db,'librate',[5,4,3],limit*8,seed+6),
        postings(db,'del',[0],limit*8,seed+7),
    ]);
    return [...new Set(candidates.flat())];
}

module.exports = {dates, postings, recommendations, bookReadOrder};
