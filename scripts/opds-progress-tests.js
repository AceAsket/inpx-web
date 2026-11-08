const assert=require('assert/strict');
const {icon,decorate}=require('../server/core/opds/Progress');
const Xml=require('../server/core/xml/XmlParser');
const he=require('he');
async function logger(){require('../server/core/Logger');const value=new(require('../server/core/AppLogger'))();if(!value.inited)await value.init({loggingEnabled:false,name:'opds-progress-tests'});}

const book=(id,title='Книга & текст')=>({id,title,link:{'*ATTRS':{href:'/opds/book?uid='+id,rel:'subsection',type:'application/atom+xml;profile=opds-catalog;kind=acquisition'}}});
const request=(id,progress)=>({query:{user:id},opdsUser:{id,readerProgress:progress},originalUrl:'/opds/title?user='+id});

async function testOpdsProgressIconsFollowExistingReadThreshold(){
    for(const value of [undefined,null,'bad',NaN,Infinity,0,-1])assert.equal(icon(value),'');
    for(const [value,expected]of [[.001,'◔'],[.25,'◔'],[.2501,'◑'],[.5,'◑'],[.5001,'◕'],[.99,'◕'],[.9989,'◕'],[.999,'⬤'],[1,'⬤']])assert.equal(icon(value),expected);
    assert.equal(icon(0,true),'⬤');
}
async function testOpdsProgressIsProfileScopedAndDoesNotMutateSharedEntries(){
    const content={entry:[book('one'),book('two')]},before=JSON.stringify(content);
    const alice=decorate(content,request('alice',{one:{percent:.2},two:{percent:1}}));
    const bob=decorate(content,request('bob',{one:{percent:.7}}));
    assert.equal(alice.entry[0].title,'◔ Книга & текст');assert.equal(alice.entry[1].title,'⬤ Книга & текст');
    assert.equal(bob.entry[0].title,'◕ Книга & текст');assert.equal(bob.entry[1].title,'Книга & текст');
    assert.equal(JSON.stringify(content),before);assert.equal(decorate(content,{query:{}}),content);
    assert.equal(decorate(content,{query:{user:'bob'},opdsUser:request('alice',{}).opdsUser}),content,'Unresolved or mismatched profile context is never used');
    assert.equal(decorate(content,{query:{user:'alice'}}),content,'A URL parameter alone is not an authenticated/resolved profile');
}
async function testOpdsProgressSkipsNavigationAndRelinkedRowsAndUnifiesReadMark(){
    const nav={id:'one',title:'Navigation',link:{'*ATTRS':{href:'/opds/author',type:'application/atom+xml;kind=navigation'}}};
    const content={entry:[nav,book('two','✓ 3. Книга (fb2)'),book('old')]};
    const result=decorate(content,request('reader',{one:{percent:.5},old:{percent:.4,relinkedTo:'new'}}));
    assert.equal(result.entry[0],nav);assert.equal(result.entry[1].title,'⬤ 3. Книга (fb2)');assert.equal(result.entry[2].title,'Книга & текст');
    const missing={id:'missing',title:'Missing',content:{'*ATTRS':{type:'text'},'*TEXT':'40%'}};
    assert.equal(decorate({entry:[missing]},request('reader',{missing:{percent:.4}}),true).entry[0].title,'◑ Missing');
}
async function testOpdsRenderedXmlKeepsIdentifiersAcquisitionsAndSearchTemplate(){
    await logger();const BasePage=require('../server/core/opds/BasePage');
    const page=Object.create(BasePage.prototype);Object.assign(page,{config:{opdsRoot:'/opds',opds:{compatibility:'tolino'}},opdsRoot:'/opds',rootTag:'feed',id:'title',title:'Названия'});
    const item=page.makeEntry(book('one','2. Книга & <текст> (fb2)'));
    item.link=[item.link,{'*ATTRS':{href:'/book/by-uid?uid=one&format=raw',rel:'http://opds-spec.org/acquisition',type:'application/fb2+xml'}}];
    const req=request('reader',{one:{percent:.4}}),before=JSON.stringify(item);
    const source=page.makeBody({entry:[item]},req),xml=new Xml();xml.fromString(source);
    const entry=xml.$$('feed/entry/');assert.equal(entry.text('id'),'one');assert.equal(he.decode(entry.text('title')),'◑ 2. Книга & <текст> (fb2)');
    const links=entry.$$array('link').map(link=>link.attrs());
    assert(links.some(link=>he.decode(link.href)==='/opds/book?uid=one&user=reader'));
    assert(links.some(link=>he.decode(link.href)==='/book/by-uid?uid=one&format=raw'));
    const search=xml.$$array('feed/link').map(link=>link.attrs()).find(link=>link.rel==='search'&&link.href.includes('{searchTerms}'));
    assert(search,'The OPDS OpenSearch placeholder remains literal');assert.equal(JSON.stringify(item),before);
    const other=page.makeBody({entry:[item]},request('other',{}));assert(!other.includes('◑'));
}
async function testOpdsProgressScopeResponsesArePrivateWithoutChangingPublicFeeds(){
    await logger();
    const express=require('express'),scope=require('../server/core/opds').scopeGuard;
    const user={id:'reader',opdsEnabled:true,readerProgress:{one:{percent:.5}}};
    const app=express();app.use('/opds',scope(()=>({readingListStore:{getOpdsUser:async id=>id==='reader'?user:null}})));
    app.get('/opds',(req,res)=>res.json(decorate({entry:[book('one')]},req)));
    const server=await new Promise(resolve=>{const current=app.listen(0,'127.0.0.1',()=>resolve(current));});
    try{
        const base=`http://127.0.0.1:${server.address().port}/opds`;
        let response=await fetch(base+'?user=reader');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('vary'),/Cookie/);assert.match(response.headers.get('vary'),/Authorization/);assert.match((await response.json()).entry[0].title,/^◑ /);
        response=await fetch(base);assert.equal(response.headers.get('cache-control'),null);assert.equal((await response.json()).entry[0].title,'Книга & текст');
        assert.equal((await fetch(base+'?user=missing')).status,404);
    }finally{await new Promise(resolve=>server.close(resolve));}
}
async function testOpdsFb2CardResolvesPlainAndNamespacedRootAttributes(){
    const Fb2Parser=require('../server/core/fb2/Fb2Parser');
    for(const [attrs,expected]of [['','l'],[' xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"','l'],[' xmlns:xlink="http://www.w3.org/1999/xlink"','xlink']]){
        const parser=new Fb2Parser();parser.fromString('<FictionBook'+attrs+'><description><title-info><book-title>Book</book-title><annotation><p>Text</p></annotation></title-info></description></FictionBook>');
        assert.equal(parser.xlinkNS,expected);assert.equal(parser.bookInfo().titleInfo.bookTitle,'Book');
    }
}

module.exports=[testOpdsProgressIconsFollowExistingReadThreshold,testOpdsProgressIsProfileScopedAndDoesNotMutateSharedEntries,
    testOpdsProgressSkipsNavigationAndRelinkedRowsAndUnifiesReadMark,testOpdsRenderedXmlKeepsIdentifiersAcquisitionsAndSearchTemplate,
    testOpdsProgressScopeResponsesArePrivateWithoutChangingPublicFeeds,testOpdsFb2CardResolvesPlainAndNamespacedRootAttributes];
if(require.main===module)(async()=>{for(const test of module.exports){await test();console.log('ok '+test.name);}})().catch(error=>{console.error(error);process.exitCode=1;});
