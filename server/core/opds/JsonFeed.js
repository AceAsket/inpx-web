const he = require('he');
const {escapeHtml, safeHtml} = require('../../../shared/safeHtml');
const acquisitionLinks = require('./AcquisitionLinks');

const bookRecord = Symbol('OPDS publication record');
const feedType = 'application/opds+json';
const publicationType = 'application/opds-publication+json';
const array = value => Array.isArray(value) ? value : value ? [value] : [];
const text = value => he.decode(String(value ?? ''));

function link(value, page) {
    const attrs = value?.['*ATTRS'];
    if (!attrs?.href) return null;
    const result = {href:text(attrs.href)};
    for (const key of ['rel', 'type', 'title']) if (attrs[key]) result[key] = text(attrs[key]);
    if (String(result.type).startsWith('application/atom+xml')) {
        result.type = result.href.split('?')[0] === page.opdsRoot + '/book' ? publicationType : feedType;
    }
    return result;
}

function description(entry) {
    const value = entry.content || entry.summary;
    if (!value?.['*TEXT']) return '';
    const decoded = text(value['*TEXT']);
    return value['*ATTRS']?.type === 'html' ? safeHtml(decoded) : escapeHtml(decoded);
}

function publication(entry, req, page) {
    const book = entry[bookRecord];
    const uid = String(book?._uid || book?.bookUid || entry.id || '');
    const metadata = {title:text(entry.title || book?.title || 'Без названия'), identifier:'urn:inpx:book:' + encodeURIComponent(uid),
        '@type':'http://schema.org/Book'};
    const authors = book?.author ? String(book.author).split(',').map(name => ({name:name.trim()}))
        : array(entry.author).map(author => ({name:text(author.name)}));
    if (authors.some(author => author.name)) metadata.author = authors.filter(author => author.name).map(author => ({...author,
        links:[{href:page.scopedHref(page.opdsRoot + '/author', req, {author:'=' + author.name}), type:feedType}]}));
    const languages = String(book?.lang || entry['dc:language'] || '').split(',').map(value => value.trim()).filter(Boolean);
    if (languages.length) metadata.language = languages;
    if (entry.updated) metadata.modified = text(entry.updated);
    const details = description(entry);
    if (details) metadata.description = details;
    const subjects = array(entry.category).map(item => text(item['*ATTRS']?.label || item['*ATTRS']?.term)).filter(Boolean);
    if (!subjects.length && book?.genre) subjects.push(...String(book.genre).split(',').map(code => page.genreMap?.get(code) || code).filter(Boolean));
    if (subjects.length) metadata.subject = [...new Set(subjects)].map(name => ({name}));
    if (book?.series) {
        const series = {name:book.series, links:[{href:page.scopedHref(page.opdsRoot + '/series', req, {series:'=' + book.series}), type:feedType}]};
        if (Number.isFinite(Number(book.serno)) && Number(book.serno) > 0) series.position = Number(book.serno);
        metadata.belongsTo = {series:[series]};
    }
    const sourceLinks = array(entry.link).map(value => link(value,page)).filter(Boolean);
    const images = sourceLinks.filter(value => String(value.rel).startsWith('http://opds-spec.org/image')).map(value => ({href:value.href, type:value.type}));
    const links = sourceLinks.filter(value => !String(value.rel).startsWith('http://opds-spec.org/image'));
    // Listings already hold catalog records. Build acquisition links from them,
    // without opening books, converting files, or issuing one DB query per item.
    if (book) {
        for (const value of acquisitionLinks.forBook({...book, _uid:uid}, page.config, req.opdsUser))
            if (!links.some(item => item.href === value.href && item.type === value.type))
                links.push({...value, rel:'http://opds-spec.org/acquisition'});
        if (!images.length) images.push({href:(page.config.rootPathStatic || '') + '/cover/by-uid?uid=' + encodeURIComponent(uid), type:'image/jpeg'});
    }
    const self = page.scopedHref(page.opdsRoot + '/book',req,{uid});
    const canonical = href => {const url=new URL(href,'http://opds.invalid');url.searchParams.sort();return url.href;};
    const card = links.find(value => value.type === publicationType && canonical(value.href) === canonical(self));
    if (card) {card.rel = 'self';card.href = self;}
    else if (uid) links.unshift({href:self, rel:'self', type:publicationType});
    const unique = values => values.filter((item,index) => values.findIndex(other => other.href === item.href && other.type === item.type && other.rel === item.rel) === index);
    return {metadata, links:unique(links), ...(images.length ? {images:unique(images)} : {})};
}

function makeFeed(content, req, page) {
    const links = array(content.link || page.baseLinks(req)).map(value => link(value,page)).filter(value => value && value.type !== 'application/opensearchdescription+xml');
    const search = links.find(value => value.rel === 'search');
    if (search) {search.href = page.scopedHref(page.opdsRoot + '/search', req) + (page.getScopeUserId(req) ? '{&query}' : '{?query}'); search.type = feedType; search.templated = true;}
    const publications = [], navigation = [];
    for (const entry of content.entry || []) {
        if (entry[bookRecord] || page.id === 'book') {publications.push(entry); continue;}
        const target = array(entry.link).map(value => link(value,page)).find(Boolean);
        if (!target) continue;
        const item = {...target, title:text(entry.title || 'Открыть')};
        if (entry.id === 'next_page') item.rel = 'next';
        if (['next', 'previous', 'first', 'last'].includes(item.rel)) {
            if (!links.some(value => value.rel === item.rel && value.href === item.href)) links.push(item);
        } else navigation.push(item);
    }
    if (page.id === 'book') {
        if (!publications.length) throw Object.assign(new Error('Книга не найдена'), {status:404});
        return publication(publications[0],req,page);
    }
    const metadata = {title:text(content.title || page.title || 'Каталог')};
    if (content.updated) metadata.modified = text(content.updated);
    const result = {metadata, links};
    // Alphabetic author/series pages can hold many publications. Keep each JSON
    // response bounded; v2page is separate from existing shelf/search pagination.
    const limit = 100, requested = Math.max(1, Number.parseInt(req.query.v2page,10) || 1);
    const number = Math.min(requested,Math.max(1,Math.ceil(publications.length / limit)));
    if (publications.length > limit || number > 1) {
        const start = (number - 1) * limit;
        metadata.numberOfItems = publications.length; metadata.itemsPerPage = limit; metadata.currentPage = number;
        for (const [enabled,value,rel] of [[number > 1,number - 1,'previous'],[start + limit < publications.length,number + 1,'next']])
            if (enabled) links.push({href:page.scopedHref(req.originalUrl,req,{v2page:value}), rel, type:feedType});
        result.publications = publications.slice(start,start + limit).map(entry => publication(entry,req,page));
    } else if (publications.length) result.publications = publications.map(entry => publication(entry,req,page));
    if (navigation.length) result.navigation = navigation;
    if (!result.publications && !result.navigation) {
        metadata.numberOfItems = 0;
        result.navigation = [{href:page.scopedHref(page.opdsRoot,req),rel:'start',type:feedType,title:'В каталог'}];
    }
    return result;
}

module.exports = {bookRecord, feedType, publicationType, makeFeed};
