const assert = require('node:assert/strict');
const http = require('node:http');
const {resolve} = require('node:path');
const express = require('express');
const sax = require('sax');
const {start,opdsModelRequested} = require('../server/core/RustHttpServer');
const nativeFeed = require('../server/core/opds/RustFeed');
const {mount} = require('../server/core/opds/Compatibility');

const root = '/library/opds';
const v2 = root+'/v2';
const credential = 'Basic '+Buffer.from('alice:fixture').toString('base64');

async function fixture(binary, enableModel) {
    process.env.INPX_RUST_SERVER_BINARY = binary;
    const {page,book,entry,req:example} = require('./opds2-tests').fixture();
    const makeEntry = page.makeEntry.bind(page);
    page.makeEntry = value=>({...makeEntry(value),updated:'2026-11-16T12:34:56Z'});
    page.genreMap = new Map([['sf','Фантастика']]);
    const books = Array.from({length:205},(_,i)=>entry({...book,_uid:`${i} & ё!'()~`,ext:['fb2','mobi','epub','pdf','kfx','txt'][i%6]}));
    books[100].content = {'*ATTRS':{type:'html'},'*TEXT':page.escape('<P style="color:red">Описание &nbsp;<b>тест</b></P><svg><title>Другой текст</title></svg>&lt;p&gt;')};
    const app = express();
    const config = {...page.config,opdsVersion:1,opdsRoot:root,opds:{compatibility:'standard'}};
    const atom = Object.assign(Object.create(page),{config,opdsRoot:root});
    const open = Object.assign(Object.create(require('../server/core/opds/OpensearchPage').prototype),{opdsRoot:root});
    const items = [
        atom.makeEntry({id:'one',title:'Книга & «Север»',link:atom.acqLink({href:'/book?uid=one'}),
            author:{name:'Редактор',uri:atom.escape(root+'/author?author=Редактор')},
            content:{'*ATTRS':{type:'html'},'*TEXT':atom.escape('<p>Описание &amp; заметки.</p>')},
            category:{'*ATTRS':{term:'sf',label:'Фантастика'}},'dc:language':'ru'}),
        atom.makeEntry({id:12,title:'Серия',link:[atom.navLink({href:'/series?series=Мир'}),atom.downLink({href:'/book/series',type:'application/fb2+xml'})]}),
    ];
    app.get('/outside',(req,res)=>res.json({marker:req.headers['x-inpx-opds-model'] || null}));
    function authorize(req,res,next) {
        if (req.query.user) {
            if (req.headers.authorization!==credential) {
                res.set('WWW-Authenticate','Basic realm="inpx-web OPDS"').set('Cache-Control','no-store').status(401).end('Unauthorized');
                return;
            }
            req.opdsUser = example.opdsUser;
            res.set('Cache-Control','private, no-store').vary('Cookie').vary('Authorization');
        }
        if (opdsModelRequested(req)) req[nativeFeed.requested] = true;
        next();
    }
    function reply(result,res) {
        if (result[nativeFeed.prepared]) nativeFeed.send(result,res);
        else res.send(result);
    }
    app.use(root,authorize);
    mount(app,[root,root+'/title',root+'/opensearch',root+'/literals'],async(req,res)=>{
        if (req.path.endsWith('/opensearch')) {
            res.type('application/opensearchdescription+xml');
            reply(await open.body(req),res);
            return;
        }
        res.type('application/atom+xml');
        const entries = req.path.endsWith('/literals') ? [
            atom.makeEntry({id:'id & raw',title:'Редактор',content:{'*TEXT':'A & B > 4 &amp; уже экранировано'},
                category:{'*ATTRS':{label:'Серия "Мир" & Свет'}}}),
        ] : items;
        reply(atom.makeBody({entry:entries},req),res);
    },config);
    app.get(root+'/malformed-model',(req,res)=>res.set('x-inpx-opds-model','atom').type('text/plain').send('internal fixture'));
    app.get([v2,v2+'/title',v2+'/search',v2+'/book'],(req,res)=>{
        const bookRequest = req.path===v2+'/book';
        const renderer = Object.assign(Object.create(page),{id:bookRequest?'book':'title'});
        let entries = books;
        if (bookRequest) {
            entries = books.filter(row=>row.id===req.query.uid);
            if (!entries.length) {res.status(404).json({error:'Книга не найдена'});return;}
        }
        if (req.path===v2+'/search') entries = [];
        res.type(bookRequest?'application/opds-publication+json; charset=utf-8':'application/opds+json; charset=utf-8');
        reply(renderer.makeBody({entry:entries},req),res);
    });
    app.post(v2,(_req,res)=>res.sendStatus(405));
    const failures = [];
    const transport = await start(http.createServer(app),{
        server:{host:'127.0.0.1',port:0},opdsRoot:enableModel ? root : undefined,version:'test',
    },{onFailure:error=>failures.push(error)});
    return {url:`http://127.0.0.1:${transport.port}`,failures,config,stop:()=>transport.stop()};
}

function validateXml(text) {
    const nodes = [];
    const parser = sax.parser(true);
    parser.onerror = error=>{throw error;};
    parser.onopentag = node=>nodes.push(node);
    parser.write(text).close();
    return nodes;
}

async function checkAtom(before,after) {
    const auth = {authorization:credential};
    const path = root+'/title?user=alice';
    for (const location of [path,root+'/opensearch?user='+encodeURIComponent("à' & й")]) {
        const [old,current] = await Promise.all([before,after].map(site=>fetch(site.url+location,{headers:auth})));
        assert.equal(current.status,200);
        assert(!current.headers.has('x-inpx-opds-model'));
        assert(!current.headers.has('x-powered-by'));
        assert.equal(current.headers.get('content-type'),old.headers.get('content-type'));
        const [oldXml,xml] = await Promise.all([old.text(),current.text()]);
        assert.equal(xml,oldXml);
        const nodes = validateXml(xml);
        if (location === path) {
            assert(xml.includes('<title>◑ Книга &amp;'));
            assert(nodes.some(node=>node.name==='link' && node.attributes.href===root+'/book?uid=one&user=alice'));
        } else {
            const templates = nodes.filter(node=>node.name==='Url').map(node=>node.attributes.template);
            assert.deepEqual(templates,['title','author','series'].map(kind=>root+'/search?type='+kind+"&term={searchTerms}&user=%C3%A0'%20%26%20%D0%B9"));
        }
        const head = await fetch(after.url+location,{method:'HEAD',headers:auth});
        assert.equal(head.headers.get('etag'),current.headers.get('etag'));
        assert.equal(head.headers.get('content-length'),current.headers.get('content-length'));
        const conditional = await fetch(after.url+location,{headers:{...auth,'if-none-match':current.headers.get('etag'),'cache-control':'max-age=0'}});
        assert.equal(conditional.status,304);
    }
    assert.equal((await fetch(after.url+path,{method:'POST',headers:auth})).status,405);
    before.config.opds.compatibility = after.config.opds.compatibility = 'tolino';
    assert.equal((await fetch(after.url+path,{method:'POST'})).status,401);
    const [oldPost,post] = await Promise.all([before,after].map(site=>fetch(site.url+path,{
        method:'POST',headers:{...auth,'if-none-match':'*'},
    })));
    assert.equal(post.status,200);
    assert(!post.headers.has('x-powered-by'));
    const text = await post.text();
    assert.equal(text,await oldPost.text());
    assert(validateXml(text).some(node=>node.name==='link' && !node.attributes.rel && node.attributes.href?.includes('/series?')));
    const literals = validateXml(await (await fetch(after.url+root+'/literals')).text());
    assert.equal(literals.find(node=>node.name==='category').attributes.label,'Серия "Мир" & Свет');
    const invalid = await fetch(after.url+root+'/malformed-model');
    assert.equal(invalid.status,502);
    assert.equal(await invalid.text(),'Bad Gateway');
}

async function main() {
    await new (require('../server/core/AppLogger'))().init({loggingEnabled:false});
    const binary = resolve(process.argv[2]);
    const before = await fixture(binary,false);
    const after = await fixture(binary,true);
    try {
        const auth = {authorization:credential};
        const page = v2+'/title?'+new URLSearchParams({user:'alice',v2page:2,term:'ё & ?+!*'});
        const uid = "100 & ё!'()~";
        for (const path of [page,v2+'/search?user=alice&query=none',v2+'/book?'+new URLSearchParams({uid,user:'alice'})]) {
            const responses = await Promise.all([before,after].map(site=>fetch(site.url+path,{headers:auth})));
            for (const response of responses) {
                assert.equal(response.status,200);
                assert(!response.headers.has('x-inpx-opds-model'));
                assert.equal(response.headers.get('cache-control'),'private, no-store');
                assert.match(response.headers.get('vary'),/Cookie, Authorization/);
            }
            assert(responses[0].headers.has('x-powered-by'));
            assert(!responses[1].headers.has('x-powered-by'),'Hyper builds the OPDS document');
            assert.equal(responses[0].headers.get('content-type'),responses[1].headers.get('content-type'));
            const bodies = await Promise.all(responses.map(response=>response.json()));
            assert.deepEqual(bodies[1],bodies[0],path);
            const get = responses[1];
            const head = await fetch(after.url+path,{method:'HEAD',headers:auth});
            assert.equal(head.status,200);
            assert.equal(head.headers.get('etag'),get.headers.get('etag'));
            assert.equal(head.headers.get('content-length'),get.headers.get('content-length'));
            assert.equal(await head.text(),'');
            const conditional = await fetch(after.url+path,{headers:{...auth,'if-none-match':get.headers.get('etag'),'cache-control':'max-age=0'}});
            assert.equal(conditional.status,304);
            assert.equal(await conditional.text(),'');
        }
        for (const method of ['GET','HEAD']) {
            const denied = await fetch(after.url+page,{method,headers:{'if-none-match':'*','x-inpx-opds-model':'1'}});
            assert.equal(denied.status,401);
            assert(!denied.headers.has('x-inpx-opds-model'));
            assert.match(denied.headers.get('www-authenticate'),/^Basic /);
        }
        const outside = await fetch(after.url+'/outside',{headers:{'x-inpx-opds-model':'1'}});
        assert.deepEqual(await outside.json(),{marker:null});
        const unreachableModel = await fetch(before.url+page,{headers:{...auth,'x-inpx-opds-model':'1'}});
        assert((await unreachableModel.json()).metadata,'A public request cannot enter model mode');
        assert.equal((await fetch(after.url+v2,{method:'POST'})).status,405);
        assert.equal((await fetch(after.url+v2+'/book?uid=missing',{headers:auth})).status,404);
        await checkAtom(before,after);
        assert.deepEqual([...before.failures,...after.failures],[]);
        console.log('Rust Atom, OpenSearch and OPDS 2 HTTP parity, Tolino, conditional requests and profile scopes passed');
    } finally {await Promise.all([before.stop(),after.stop()]);}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
