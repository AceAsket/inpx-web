const assert = require('assert/strict');
const WebSocket = require('ws');

module.exports = async function checkOpds2(url, {adminPassword='browser-speech-test'} = {}) {
    const response = await fetch(url + '/');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const socket = new WebSocket(url.replace(/^http/,'ws') + '/ws',{headers:{cookie,origin:url}});
    await new Promise((resolve,reject) => {socket.once('open',resolve);socket.once('error',reject);});
    let sequence=0,common={},admin,userId,changedOpds=false;const samples=[];
    const request = data => new Promise((resolve,reject) => {
        const requestId='opds2-'+(++sequence),timer=setTimeout(()=>{socket.off('message',listener);reject(new Error('OPDS 2 fixture timeout'));},15000);
        const listener=raw=>{const result=JSON.parse(raw);if(result.requestId!==requestId||result._rok)return;
            clearTimeout(timer);socket.off('message',listener);result.error?reject(new Error(result.error)):resolve(result);};
        socket.on('message',listener);socket.send(JSON.stringify({...common,...data,requestId}));
    });
    const read = async(href,headers={}) => {const result=await fetch(new URL(href,url),{headers});assert.equal(result.status,200,href);
        assert.match(result.headers.get('content-type'),/^application\/opds(?:-publication)?\+json\b/);const body=await result.json();samples.push({href,type:result.headers.get('content-type'),body});return {response:result,body};};
    try {
        const root=await read('/opds/v2'),slash=await read('/opds/v2/');
        assert(root.body.navigation.length);assert.equal(slash.body.metadata.title,root.body.metadata.title);
        assert(root.body.links.some(link=>link.rel==='self'&&link.type==='application/opds+json'));
        for(const link of root.body.navigation)assert(link.href.startsWith('/opds/v2/'));
        const atom=await fetch(url+'/opds');assert.match(atom.headers.get('content-type'),/^application\/atom\+xml/);assert((await atom.text()).includes('http://www.w3.org/2005/Atom'));
        const search=root.body.links.find(link=>link.rel==='search');assert(search.templated);assert(search.href.includes('{?query}'));
        const found=await read(search.href.replace('{?query}','?query=Packaged'));
        const book=found.body.publications.find(book=>book.links.some(link=>link.type==='application/fb2+xml'
            && new URL(link.href,url).searchParams.get('format')==='raw'));assert(book,'Search includes the original FB2 fixture');
        const self=book.links.find(link=>link.rel==='self');assert.equal(self.type,'application/opds-publication+json');
        const uid=new URL(self.href,url).searchParams.get('uid');assert(uid);assert.equal(book.metadata.identifier,'urn:inpx:book:'+encodeURIComponent(uid));
        const detail=await read(self.href);assert.equal(detail.body.metadata.identifier,book.metadata.identifier);assert(!detail.body.publications);
        const download=book.links.find(link=>link.rel==='http://opds-spec.org/acquisition'&&link.type==='application/fb2+xml');assert(download);
        const file=await fetch(new URL(download.href,url));assert.equal(file.status,200);assert((await file.text()).includes('<FictionBook'));
        assert.equal((await fetch(url+'/opds/v2/no-such-feed')).status,404);
        assert.equal((await fetch(url+'/opds/v2/book?uid=missing')).status,404);
        assert.equal((await fetch(url+'/opds/v2',{method:'POST'})).status,405);
        const empty=await read('/opds/v2/search?query=NoSuchUniqueBook099910');assert.equal(empty.body.metadata.numberOfItems,0);assert(!empty.body.publications);

        common.csrfToken=(await request({action:'get-config'})).csrfToken;
        const login=await request({action:'login-user-profile',login:'admin',password:adminPassword});
        common={csrfToken:common.csrfToken,...login};delete common.requestId;admin={...common};
        const created=await request({action:'create-user-profile',profile:{name:'OPDS 2 private fixture',login:'opds-two',password:'opds-two-fixture',opdsEnabled:true,opdsAuthEnabled:true}});
        userId=created.user.id;const headers={authorization:'Basic '+Buffer.from('opds-two:opds-two-fixture').toString('base64')};
        assert.equal((await fetch(url+'/opds/v2?user='+userId)).status,401);
        const scoped=await read('/opds/v2?user='+userId,headers);assert.match(scoped.response.headers.get('cache-control'),/private.*no-store/);
        for(const link of [...scoped.body.links,...scoped.body.navigation].filter(link=>!link.templated))assert.equal(new URL(link.href,url).searchParams.get('user'),userId);
        const userLogin=await request({action:'login-user-profile',login:'opds-two',password:'opds-two-fixture'});
        common={csrfToken:common.csrfToken,...userLogin};delete common.requestId;
        await request({action:'update-reader-progress',bookUid:uid,progress:{percent:.4,textSnippet:'Smoke text'}});
        const progress=await read('/opds/v2/reading-progress?user='+userId,headers);assert(progress.body.publications[0].metadata.title.startsWith('◑ '));
        const list=await request({action:'create-reading-list',name:'Полка JSON',visibility:'opds'});
        await request({action:'update-reading-list-book',listId:list.list.id,bookUid:uid,enabled:true});
        const shelf=await read('/opds/v2/reading-lists/list?'+new URLSearchParams({user:userId,id:list.list.id}),headers);
        assert.equal(shelf.body.publications[0].metadata.identifier,book.metadata.identifier);
        assert.equal((await fetch(url+'/opds/v2/reading-lists/list?'+new URLSearchParams({user:userId,id:list.list.id}))).status,401);
        common=admin;
        const credentials=password=>({authorization:'Basic '+Buffer.from('catalog-fixture:'+password).toString('base64')});
        await request({action:'update-admin-opds',opds:{user:'catalog-fixture',password:'first-fixture'}});changedOpds=true;
        for(const endpoint of ['/opds','/opds/v2']) {
            assert.equal((await fetch(url+endpoint)).status,401,'Changing shared credentials must protect '+endpoint+' immediately');
            assert.equal((await fetch(url+endpoint,{headers:credentials('first-fixture')})).status,200);
        }
        await request({action:'update-admin-opds',opds:{password:'second-fixture'}});
        for(const endpoint of ['/opds','/opds/v2']) {
            assert.equal((await fetch(url+endpoint,{headers:credentials('first-fixture')})).status,401,'Old credentials are revoked on '+endpoint);
            assert.equal((await fetch(url+endpoint,{headers:credentials('second-fixture')})).status,200);
        }
        await request({action:'update-admin-opds',opds:{enabled:false}});
        for(const endpoint of ['/opds','/opds/v2'])assert.equal((await fetch(url+endpoint,{headers:credentials('second-fixture')})).status,404);
        await request({action:'update-admin-opds',opds:{enabled:true,user:'',password:''}});changedOpds=false;
        console.log('OPDS 2 integration: JSON/search/publication/download, private shelves/progress, live credential changes and disable/enable, Basic Auth, pagination links and unchanged Atom passed');
        return samples;
    } finally {
        if(changedOpds&&admin){common=admin;await request({action:'update-admin-opds',opds:{enabled:true,user:'',password:''}}).catch(()=>{});}
        if(userId&&admin){common=admin;await request({action:'delete-user-profile',targetUserId:userId}).catch(()=>{});}
        socket.terminate();
    }
};
