const assert = require('assert/strict');

function fixture() {
    const BasePage = require('../server/core/opds/BasePage');
    const config = {opdsVersion:2, opdsRoot:'/library/opds/v2', rootPathStatic:'/library', bookPathStatic:'/library/book',
        conversionEnabled:true, conversionFormats:['epub','mobi'], mobiEnabled:true};
    const page = Object.assign(Object.create(BasePage.prototype), {config, opdsRoot:config.opdsRoot, id:'title', title:'Книги & авторы', rootTag:'feed'});
    const req = {query:{user:'alice'}, originalUrl:config.opdsRoot + '/title?user=alice',
        opdsUser:{id:'alice', defaultOpdsFormat:'mobi', readerProgress:{one:{percent:.3}}}};
    const book = {_uid:'one', title:'Книга & «Север»', author:'Первый Автор,Второй Автор', series:'Мир & север', serno:2, lang:'ru,en', genre:'sf', ext:'fb2'};
    const entry = record => page.makeBookEntry(record, {id:record._uid, title:record.title,
        link:page.acqLink({href:'/book?uid=' + encodeURIComponent(record._uid),req})});
    return {page,req,book,entry};
}

async function testOpds2NativePublicationsPreserveProfileFormatsProgressAndMetadata() {
    const {page,req,book,entry} = fixture();
    page.genreMap = new Map([['sf','Фантастика']]);
    const feed = page.makeBody({entry:[entry(book)]}, req);
    assert.equal(feed.metadata.title,'Книги & авторы');assert.equal(feed.publications.length,1);
    const publication = feed.publications[0];
    assert.equal(publication.links.filter(link=>link.type==='application/opds-publication+json').length,1,'Equivalent query parameter orders do not duplicate the publication link');
    assert.equal(publication.metadata.title,'◑ Книга & «Север»');
    assert.deepEqual(publication.metadata.author.map(author => author.name),['Первый Автор','Второй Автор']);
    assert.deepEqual(publication.metadata.language,['ru','en']);assert.equal(publication.metadata.subject[0].name,'Фантастика');
    assert.equal(publication.metadata.belongsTo.series[0].position,2);
    for (const link of [publication.links.find(link => link.rel === 'self'),publication.metadata.author[0].links[0],publication.metadata.belongsTo.series[0].links[0]]) {
        const url = new URL(link.href,'http://test');assert(url.pathname.startsWith('/library/opds/v2/'));assert.equal(url.searchParams.get('user'),'alice');
    }
    const downloads = publication.links.filter(link => link.rel === 'http://opds-spec.org/acquisition');
    assert.equal(downloads[0].type,'application/x-mobipocket-ebook');assert(downloads[0].href.includes('format=mobi'));
    assert(publication.images[0].href.startsWith('/library/cover/by-uid?uid=one'));
    assert(!JSON.stringify(feed).includes('*ATTRS'));assert(!JSON.stringify(feed).includes('password'));
    assert.equal(book.title,'Книга & «Север»','Presentation does not mutate shared catalog records');
    const other = page.makeBody({entry:[entry(book)]},{...req,query:{user:'bob'},opdsUser:{id:'bob',readerProgress:{}}});
    assert.equal(other.publications[0].metadata.title,book.title,'No progress leaks into another profile');
}

async function testOpds2SearchAndPaginationStayInJsonCatalogAndBoundPublicationWork() {
    const {page,req,book,entry} = fixture();const serialized=new Set();
    const rows = Array.from({length:205},(_,index) => entry({...book,_uid:String(index),get author(){serialized.add(index);return 'Автор';}}));
    const feed = page.makeBody({entry:rows},{...req,query:{user:'alice',v2page:'2'},originalUrl:page.opdsRoot + '/title?user=alice&v2page=2'});
    assert.equal(feed.publications.length,100);assert.equal(feed.publications[0].metadata.identifier,'urn:inpx:book:100');
    assert.equal(feed.metadata.numberOfItems,205);assert.equal(feed.metadata.currentPage,2);assert.deepEqual([...serialized],Array.from({length:100},(_,index)=>index+100),'Only the selected page is serialized');
    for (const rel of ['self','start','next','previous']) {
        const link=feed.links.find(link => link.rel===rel);assert(link,rel);assert.equal(link.type,'application/opds+json');
        assert.equal(new URL(link.href,'http://test').searchParams.get('user'),'alice');
    }
    const search=feed.links.find(link => link.rel==='search');assert.equal(search.templated,true);assert(search.href.endsWith('{&query}'));
    assert(!feed.links.some(link => /opensearch/.test(link.href)));
    const empty=page.makeBody({entry:[]},req);assert.equal(empty.metadata.numberOfItems,0);assert.equal(empty.publications,undefined);
    assert(empty.navigation[0].href.startsWith(page.opdsRoot));
}

async function testOpds2EntrySanitizesDescriptionsAndLeavesAtomUnchanged() {
    const {page,req,book,entry}=fixture();const row=entry(book);
    row.content={'*ATTRS':{type:'html'},'*TEXT':page.escape('<p>Описание</p><img src=x onerror=alert(1)><script>alert(2)</script>')};
    const source=JSON.stringify(row),feed=page.makeBody({entry:[row]},req),description=feed.publications[0].metadata.description;
    assert(description.includes('<p>Описание</p>'));assert(!/<(?:img|script)\b|onerror\s*=/i.test(description.replace(/&lt;[^;]*&gt;/g,'')));
    assert.equal(JSON.stringify(row),source);
    page.config={...page.config,opdsVersion:1};page.opdsRoot='/library/opds';
    const atom=page.makeBody({entry:[page.makeBookEntry(book,{id:book._uid,title:book.title,link:page.acqLink({href:'/book?uid=one'})})]},req);
    assert.equal(typeof atom,'string');assert(atom.includes('http://www.w3.org/2005/Atom'));assert(!atom.includes('OPDS publication record'));
    delete page.config;
    assert.equal(typeof page.makeBody({entry:[page.makeBookEntry(book,{id:book._uid,title:book.title})]},req),'string','Legacy pages without a presentation config still render Atom');
}

async function testOpds2FullPublicationKeepsEpubMetadataPathAndRejectsMissingBooks() {
    const BookPage = require('../server/core/opds/BookPage');
    const {page,req,book}=fixture();Object.setPrototypeOf(page,BookPage.prototype);page.id='book';page.title='Книга';
    const record={...book,ext:'epub',size:2000,date:'2026-11-08',genre:'sf'};
    page.webWorker={getGenreMap:async()=>new Map([['sf','Фантастика']]),getGenreTree:async()=>({genreTree:[]}),
        getBookRecordByUid:async uid=>uid==='one'?record:null,applyMetadataOverridesToSearchResult:async()=>{},
        getBookCardInfo:async()=>assert.fail('EPUB JSON card must not parse/convert the book')};
    const publication=await page.body({...req,query:{user:'alice',uid:'one'},originalUrl:page.opdsRoot + '/book?uid=one&user=alice'});
    assert.equal(publication.metadata.identifier,'urn:inpx:book:one');assert(!publication.publications);
    assert.equal(publication.links.find(link=>link.rel==='self').type,'application/opds-publication+json');
    await assert.rejects(page.body({...req,query:{uid:'missing'}}),error=>error.status===404);
}

module.exports=[testOpds2NativePublicationsPreserveProfileFormatsProgressAndMetadata,testOpds2SearchAndPaginationStayInJsonCatalogAndBoundPublicationWork,
    testOpds2EntrySanitizesDescriptionsAndLeavesAtomUnchanged,testOpds2FullPublicationKeepsEpubMetadataPathAndRejectsMissingBooks];
module.exports.fixture=fixture;
