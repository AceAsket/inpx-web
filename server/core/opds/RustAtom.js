const {response} = require('./RustFeed');

function prepare(document,req,page,legacy) {
    const scope = page.getScopeUserId(req) ? String(req.query.user) : '';
    const user = req.opdsUser;
    let progress;
    if (user && String(req.query.user || '') === String(user.id)) {
        const rows = user.readerProgress || {};
        const marks = Object.create(null);
        for (const entry of document[page.rootTag].entry || []) {
            const id = String(entry.id || '');
            const row = Object.hasOwn(rows,id) ? rows[id] : null;
            if (row) marks[id] = {percent:Number(row.percent),relinked:!!row.relinkedTo};
        }
        progress = {marks,showUnavailable:page.id==='reading-progress'};
    }
    return response('atom',{
        document,scope,root:page.opdsRoot || page.config.opdsRoot || '/opds',
        tolino:page.config.opds?.compatibility==='tolino',progress,
    },legacy);
}

function opensearch(root,scope,legacy) {
    return response('opensearch',{root,scope},legacy);
}

module.exports = {prepare,opensearch};
