const he = require('he');
const {bookRecord} = require('./JsonFeed');

const requested = Symbol('Rust OPDS response');
const prepared = Symbol('Rust OPDS model');
const array = value => Array.isArray(value) ? value : value ? [value] : [];
const text = value => he.decode(String(value ?? ''));
const limit = 100;
const maximum = 16 * 1024 * 1024;

function links(value) {
    return array(value).flatMap(link=>{
        const attrs = link?.['*ATTRS'];
        if (!attrs?.href) return [];
        return [{
            href:text(attrs.href),
            ...(attrs.rel ? {rel:text(attrs.rel)} : {}),
            ...(attrs.type ? {type:text(attrs.type)} : {}),
            ...(attrs.title ? {title:text(attrs.title)} : {}),
        }];
    });
}

function publication(entry, page, progress) {
    const record = entry[bookRecord];
    const description = entry.content || entry.summary;
    const subjects = array(entry.category).map(item=>text(item['*ATTRS']?.label || item['*ATTRS']?.term)).filter(Boolean);
    if (!subjects.length && record?.genre) {
        for (const code of String(record.genre).split(',')) {
            const label = page.genreMap?.get(code) || code;
            if (label) subjects.push(label);
        }
    }
    const title = text(entry.title || record?.title || 'Без названия');
    const uid = String(record?._uid || record?.bookUid || entry.id || '');
    const author = record?.author;
    const authors = author ? String(author).split(',').map(name=>name.trim()) : array(entry.author).map(value=>text(value.name));
    const publishedLinks = links(entry.link);
    return {
        uid,title,authors,language:String(record?.lang || entry['dc:language'] || ''),
        modified:entry.updated ? text(entry.updated) : undefined,
        description:description?.['*TEXT'] ? {body:text(description['*TEXT']),html:description['*ATTRS']?.type === 'html'} : undefined,
        subjects,links:publishedLinks,progress:progress(entry,publishedLinks),
        book:record ? {extension:String(record.ext || '').toLowerCase(),series:String(record.series || ''),position:Number(record.serno) || 0} : undefined,
    };
}

function prepare(content, req, page, legacy) {
    const isBook = page.id === 'book';
    const user = req.opdsUser;
    const scoped = user && String(req.query.user || '') === String(user.id);
    const rows = scoped ? user.readerProgress || {} : null;
    const progress = (entry,links) => {
        if (!rows) return;
        if (!links.some(link=>link.rel?.startsWith('http://opds-spec.org/acquisition') || link.type?.includes('kind=acquisition'))
            && !(page.id === 'reading-progress' && entry.content?.['*ATTRS']?.type === 'text')) return;
        const id = String(entry.id || '');
        const row = Object.hasOwn(rows,id) ? rows[id] : null;
        return {percent:Number(row?.percent),relinked:!!row?.relinkedTo};
    };
    const publications = [], navigation = [];
    for (const entry of content.entry || []) {
        if (isBook || entry[bookRecord]) publications.push(entry);
        else {
            const entryLinks = links(entry.link);
            const [target] = entryLinks;
            if (target) navigation.push({...target,title:text(entry.title || 'Открыть'),progress:progress(entry,entryLinks),
                ...(entry.id === 'next_page' ? {rel:'next'} : {})});
        }
    }
    if (isBook && !publications.length)
        throw Object.assign(new Error('Книга не найдена'),{status:404});
    const requestedPage = Math.max(1,Number.parseInt(req.query.v2page,10) || 1);
    const selectedPage = Math.min(requestedPage,Math.max(1,Math.ceil(publications.length/limit)));
    const start = isBook ? 0 : (selectedPage-1)*limit;
    return response('1',{
            isBook,root:page.opdsRoot,staticRoot:page.config.rootPathStatic || '',
            bookPath:String(page.config.bookPathStatic),href:req.originalUrl,
            scope:req.query.user ? String(req.query.user) : '',templateScoped:!!page.getScopeUserId(req),
            conversion:!!page.config.conversionEnabled,
            formats:Array.isArray(page.config.conversionFormats) ? page.config.conversionFormats.map(String) : undefined,
            mobi:require('../BookConverter').mobiEnabled(page.config),
            preference:String(req.opdsUser?.defaultOpdsFormat || ''),
            title:text(content.title || page.title || 'Каталог'),
            modified:content.updated ? text(content.updated) : undefined,
            links:links(content.link || page.baseLinks(req)),navigation,
            total:publications.length,page:selectedPage,
            publications:publications.slice(start,start+(isBook ? 1 : limit)).map(entry=>publication(entry,page,progress)),
    },legacy);
}

function response(format,model,legacy) {
    return {[prepared]:true,format,model,legacy};
}

function send(value,res) {
    const bytes = Buffer.from(JSON.stringify(value.model));
    if (bytes.length > maximum) return res.send(value.legacy());
    res.set('x-inpx-opds-model',value.format);
    res.set('Content-Length',String(bytes.length));
    return res.end(bytes);
}

module.exports = {requested,prepared,prepare,response,send};
