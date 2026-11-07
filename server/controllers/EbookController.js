const express=require('express');
const {equal}=require('../core/opds/Auth');
const ProfileAccess=require('../core/ProfileAccess');
const Budget=require('../core/ClientRequestBudget');
const {getEnabledLibrarySources}=require('../core/LibrarySources');
const formats=require('../../shared/BookFormats');
const {EbookReader}=require('../core/EbookReader');
const shelves=require('../core/EbookShelves');

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function bad(message,status=400){return Object.assign(new Error(message),{status});}
function scalar(input,key,maximum=160,trim=true){const value=input?.[key];if(value===undefined)return '';if(typeof value!=='string'||value.length>maximum)throw bad('Некорректные параметры запроса.');return trim?value.trim():value;}
const short=(value,maximum=180)=>{const text=String(value||'');return text.length>maximum?text.slice(0,maximum).replace(/[\ud800-\udbff]$/,'')+'…':text;};
function number(input,key,fallback,maximum){const raw=scalar(input,key,8);if(!raw)return fallback;if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>maximum)throw bad('Некорректный номер страницы.');return Number(raw);}
function parameters(query,config) {
    const field=scalar(query,'field',12)||'title',mode=scalar(query,'mode',12)||'words';
    if(!['title','author','series'].includes(field)||!['words','contains','exact'].includes(mode))throw bad('Неизвестный вид поиска.');
    const lang=query.lang===undefined ? String(config.uiDefaults?.langDefault||''):scalar(query,'lang',40);
    if(lang&&!/^[a-z0-9, _-]+$/i.test(lang))throw bad('Некорректный язык.');
    const ext=scalar(query,'ext',12);if(ext&&!/^[a-z0-9]+$/i.test(ext))throw bad('Некорректный формат.');
    return {q:scalar(query,'q'),author:field==='author'?'':scalar(query,'author'),field,mode,lang,ext,sourceId:scalar(query,'sourceId',64),covers:scalar(query,'covers',1)==='1'?'1':'0',page:number(query,'page',1,100000),size:number(query,'size',10,20),back:scalar(query,'back',2048)};
}
const option=(value,label,selected)=>`<option value="${escape(value)}"${String(value)===String(selected)?' selected':''}>${escape(label)}</option>`;

class EbookController {
    constructor(config,worker,security,webAccess) {
        Object.assign(this,{config,worker,security,webAccess});this.root=String(config.rootPathStatic||'').replace(/\/$/,'');this.base=this.root+'/ebook';
        this.access=new ProfileAccess(config,worker,security);this.budget=new Budget({parallel:2,perUser:1,queued:16,waitMs:10000});
        this.authBudget=new Budget({parallel:2,perUser:1,queued:4,waitMs:5000});
    }
    url(path='',query={}) {const params=new URLSearchParams();for(const [name,value]of Object.entries(query))if(value!==undefined&&value!==null)params.set(name,String(value));return this.base+path+(params.size?'?'+params:'');}
    link(path,query,label,cls=''){return `<a${cls?` class="${cls}"`:''} href="${escape(this.url(path,query))}">${escape(label)}</a>`;}
    hidden(name,value){return `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;}
    headers(res){res.set({'Cache-Control':'private, no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
        'Content-Security-Policy':"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'Referrer-Policy':'same-origin'});}
    document(req,title,body,identity=null,reading=false) {
        title=short(title,600);
        const brand=this.config.name==='inpx-web'?'INPX Web':this.config.name||'INPX Web',current=req.path||'/';
        const csrf=this.security.getCsrfToken(req);
        const user=identity ? `<span>${escape(identity.user.name||identity.user.login)}</span> `+(identity.bound?'· Вход через proxy':`<form class="inline" method="post" action="${escape(this.url('/logout'))}">${this.hidden('csrf',csrf)}<button>Выйти</button></form>`):this.link('/login',{},'Войти');
        return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'+
            `<title>${escape(title)} — ${escape(brand)}</title><style>${require('../core/EbookStyle')}</style></head><body><div class="wrap"><header class="masthead"><div class="brand">${this.link('',{},brand)}</div><div class="account">${user}</div></header>`+
            (reading?`<p>${this.link('',{},'Библиотека')} · ${escape(title)}</p><main>${body}</main>`:
                `<nav class="nav" aria-label="Навигация">${this.link('',{},'Каталог',current==='/'?'active':'')} ${this.link('/shelves',{},'Мои полки',current.startsWith('/shel')?'active':'')} ${this.link('/recent',{},'Сейчас читаю',current==='/recent'?'active':'')} <a href="${escape(this.root+'/#/overview')}">Полная версия</a></nav><main><h1>${escape(title)}</h1>${body}</main>`)+
            '</div></body></html>';
    }
    destination(value) {
        if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\\]/.test(value))return this.base;
        try{const url=new URL(value,'http://ebook.local');return url.origin==='http://ebook.local'&&(url.pathname===this.base||url.pathname.startsWith(this.base+'/'))?url.pathname+url.search:this.base;}catch{return this.base;}
    }
    form(req,kind,message='') {
        const profile=kind==='profile',csrf=this.security.getCsrfToken(req);
        const next=this.destination(req.body?.next||((req.path==='/login'||req.path==='/access')?req.query.next:req.originalUrl));
        const body=(message?`<p class="error" role="alert">${escape(message)}</p>`:'')+
            `<form class="auth" method="post" action="${escape(this.url(profile?'/login':'/access'))}">${this.hidden('csrf',csrf)}${this.hidden('next',next)}`+
            (profile?`<label for="login">Логин</label><input id="login" name="login" value="${escape(typeof req.body?.login==='string'?short(req.body.login,100):'')}" autocomplete="username" maxlength="100" required>`:'')+
            `<label for="password">${profile?'Пароль':'Пароль библиотеки'}</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit">Войти</button></form>`;
        return this.document(req,profile?'Вход в профиль':'Доступ к библиотеке',body);
    }
    async libraryAllowed(req){return !this.webAccess||this.webAccess.freeAccess||await this.webAccess.hasAccess(req.securitySession?.ebookAccessToken);}
    async identity(req){return await this.access.resolve(req);}
    checkIdentity(req,identity){if(identity&&(!this.worker.getProfileSessionUser(identity.token)||req.securitySession?.profileAccessToken!==identity.token))throw bad('Сеанс завершён. Войдите снова.',401);}
    async authenticate(req,kind) {
        if(!this.security.hasValidCsrf(req,scalar(req.body,'csrf',128)))throw bad('Обновите страницу и повторите вход.',403);
        const profile=kind==='profile';this.security.checkLoginRate(req,profile?'profile':'access');
        const password=scalar(req.body,'password',1024,false);let valid=false;
        try {
            if(profile){
                if(this.access.bindingEnabled)throw bad('Профиль задаётся входом через proxy.',403);
                let result;
                try{result=await this.worker.loginUserProfile(scalar(req.body,'login',100),password);}
                catch(error){if(error.message==='Неверный логин или пароль')throw bad(error.message,401);throw error;}
                const session=req.securitySession,previous=session.profileAccessToken;
                if(previous)await this.worker.closeProfileSession(previous);
                session.profileAccessToken=result.profileAccessToken;
            }else{
                if(!equal(password,this.config.accessPassword))throw bad('Неверный пароль.',401);
                const salt=this.webAccess.newToken();req.securitySession.ebookAccessToken=require('../core/utils').getBufHash(password+salt,'sha256','hex');
            }
            valid=true;
        }finally{this.security.recordLoginAttempt(req,valid,profile?'profile':'access');}
    }
    searchForm(p,advanced=false) {
        const sources=getEnabledLibrarySources(this.config).filter(item=>item.enabled!==false);
        const label=p.field==='author'?'Автор':p.field==='series'?'Серия':'Название книги';
        const first='<p class="intro">Заполните одно или оба поля.</p>'+`<form class="search" action="${escape(this.base)}" method="get"><div class="fields"><div class="field"><label for="q">${label}</label><input id="q" name="q" value="${escape(p.q)}" maxlength="160"></div>`+
            (p.field!=='author'?`<div class="field"><label for="author">Автор</label><input id="author" name="author" value="${escape(p.author)}" maxlength="160"></div>`:'')+'</div>';
        if(!advanced)return first+['field','mode','lang','ext','sourceId','size','covers'].map(key=>this.hidden(key,p[key])).join('')+
            `<div class="actions"><button class="primary" type="submit">Найти книги</button>${this.link('',{lang:p.lang,sourceId:p.sourceId},'Сбросить','reset')}<button class="options" name="options" value="1">Параметры поиска</button></div>`+
            `<p class="scope">${escape(p.lang==='ru'?'Русский язык':p.lang?'Язык: '+p.lang:'Все языки')} · ${escape(p.ext?p.ext.toUpperCase():'Все форматы')}</p></form>`;
        return first+`<label for="field">Где искать</label><select id="field" name="field">${[['title','Название книги'],['author','Автор'],['series','Серия']].map(([key,name])=>option(key,name,p.field)).join('')}</select>`+
            `<label for="mode">Совпадение</label><select id="mode" name="mode">${[['words','Все слова'],['contains','Фраза внутри текста'],['exact','Точная запись']].map(([key,label])=>option(key,label,p.mode)).join('')}</select>`+
            '<fieldset><legend>Параметры поиска</legend>'+`<label for="lang">Язык (например, ru или en; пусто — все)</label><input id="lang" name="lang" value="${escape(p.lang)}" maxlength="40">`+
            `<label for="ext">Формат</label><select id="ext" name="ext">${[['','Все форматы'],['fb2','FB2'],['epub','EPUB'],['pdf','PDF'],['mobi','MOBI']].map(([key,label])=>option(key,label,p.ext)).join('')}</select>`+
            `<label for="sourceId">Библиотека</label><select id="sourceId" name="sourceId">${option('','Все библиотеки',p.sourceId)}${sources.map(source=>option(source.id,source.name,p.sourceId)).join('')}</select>`+
            `<label for="size">Книг на странице</label><select id="size" name="size">${[10,20].map(value=>option(value,value,p.size)).join('')}</select>`+
            `<label for="covers">Обложки</label><select id="covers" name="covers">${option('0','Без обложек',p.covers)}${option('1','Показывать',p.covers)}</select></fieldset><button type="submit">Применить параметры</button></form>`;
    }
    bookRow(book,p,downloadFormat=null) {
        const uid=book._uid||book.bookUid;
        if(book.unavailable)return '<article class="result"><h3>Книга недоступна</h3><p class="hint">Файл отсутствует в текущей библиотеке.</p></article>';
        return `<article class="result">${p.covers==='1'?`<img class="cover" alt="" src="${escape(this.root+'/cover/by-uid?'+new URLSearchParams({uid}))}">`:''}`+
            `<span class="book-format">Файл: ${escape(String(book.ext||'').toUpperCase())}</span><h3>${this.link('/book',{...p,uid},short(book.title||'Без названия',240))}</h3><p class="author">${escape(short(book.author||'Автор не указан'))}</p>`+
            (book.series?`<p class="series">${escape(short(book.series,160))}${book.serno?' · '+escape(book.serno):''}</p>`:'')+
            `<p class="book-meta">${Number(book.size)>0?Math.ceil(book.size/1024)+' КБ':''}${book.lang?' · '+escape(book.lang):''}${book.sourceName?' · '+escape(book.sourceName):''}${book._shelfRead?' · Прочитана':''}</p>`+
            (downloadFormat!==null?this.downloadButton(book,downloadFormat):'')+'</article>';
    }
    downloadSelection(book,format){
        const wanted=formats.normalize(format),native=String(book.ext).toLowerCase(),label=String(wanted==='original'?native:wanted).toUpperCase();
        const selected=wanted==='original'||wanted===native?'raw':formats.available(native,this.config).includes(wanted)?wanted:null;
        return {selected,label};
    }
    downloadButton(book,format){
        const {selected,label}=this.downloadSelection(book,format);
        if(!selected)return `<p class="hint">Скачивание ${escape(label)} для этой книги недоступно. Выберите другой формат в профиле.</p>`;
        return `<p class="quick-download download-form"><a class="button" href="${escape(this.url('/download/book.'+label.toLowerCase(),{uid:book._uid||book.bookUid}))}" aria-label="${escape('Скачать «'+book.title+'» в формате '+label)}">Скачать ${escape(label)}</a></p>`;
    }
    async download(req,identity){
        const uid=scalar(req.query,'uid',1024);if(!uid)throw bad('Не указана книга.');
        const book=await this.worker.getBookRecordByUid(uid);if(!book)throw bad('Книга не найдена.',404);
        const {selected,label}=this.downloadSelection(book,formats.preference(identity.user));
        if(!selected)throw bad(`Скачивание ${label} для этой книги недоступно. Выберите другой формат в профиле.`,415);
        return {redirect:this.root+'/book/by-uid/book.'+label.toLowerCase()+'?'+new URLSearchParams({uid,format:selected})};
    }
    formatForm(req,identity,next,ext=''){
        const selected=formats.preference(identity.user),values=[...new Set(['original',...formats.configured(this.config),...(formats.formats.includes(ext)?[ext]:[]),selected])];
        const originalLabel=ext?String(ext).toUpperCase()+' · Оригинал':'Исходный формат';
        return `<form class="shelf-options" method="post" action="${escape(this.url('/format'))}">${this.hidden('csrf',this.security.getCsrfToken(req))}${this.hidden('next',next)}<label for="format">Формат скачивания</label><select id="format" name="format">${values.map(value=>option(value,value==='original'?originalLabel:value.toUpperCase(),selected)).join('')}</select><p class="hint">Применяется ко всем скачиваниям в вашем профиле.</p><button>Сохранить формат</button></form>`;
    }
    navigation(p,page,total,path='') {
        return `<nav class="pagination" aria-label="Страницы">${page>1?this.link(path,{...p,page:page-1},'Предыдущая'):''} Страница ${page} из ${total} ${page<total?this.link(path,{...p,page:page+1},'Следующая'):''}</nav>`;
    }
    async search(req,identity) {
        const p=parameters(req.query,this.config),advanced=scalar(req.query,'options',1)==='1';let body=this.searchForm(p,advanced);
        if(advanced)return {title:'Параметры поиска',body};
        if(!p.q&&!p.author)return {title:'Поиск книг',body};
        const term=(value,mode)=>mode==='exact'?'='+value:mode==='contains'||/^[~?#*=]/.test(value)?'*'+value:value;
        const result=await this.worker.bookSearch({...(p.q?{[p.field]:term(p.q,p.mode)}:{}),...(p.author?{author:term(p.author,'words')}:{}),lang:p.lang,ext:p.ext,sourceId:p.sourceId,del:'0',limit:p.size,offset:(p.page-1)*p.size});
        const total=Math.max(1,Math.ceil(result.totalFound/p.size));
        body+=`<div class="result-header"><h2>Найдено: ${Number(result.totalFound)||0}</h2></div>`;
        if(p.page>total)body+='<p>На этой странице результатов нет.</p>'+this.link('',{...p,page:1},'К первой странице');
        else body+=result.found.map(book=>this.bookRow(book,p,identity?formats.preference(identity.user):null)).join('')+this.navigation(p,p.page,total);
        return {title:'Поиск книг',body};
    }
    async book(req,identity) {
        const uid=scalar(req.query,'uid',1024),p=parameters(req.query,this.config);
        if(!uid)throw bad('Не указана книга.');
        const book=await this.worker.getBookRecordByUid(uid);if(!book)throw bad('Книга не найдена.',404);
        const names=String(book.author||'').split(','),authors=names.slice(0,20).map(name=>this.link('',{...p,author:'',back:'',field:'author',mode:'words',q:short(name.trim(),160),page:1},short(name,200))).join(', ');
        let body=(p.back?`<p><a href="${escape(this.destination(p.back))}">К полке</a></p>`:p.q||p.author?this.link('',p,'К результатам поиска'):'')+`<p>${authors}</p>`+(names.length>20?'<p class="hint">Показаны первые 20 авторов. Полный список — в полной карточке.</p>':'')+
            (book.series?`<p>Серия: ${this.link('',{...p,field:'series',mode:'exact',q:short(book.series,160),page:1},short(book.series,400))}${book.serno?' · '+escape(book.serno):''}</p>`:'');
        body+=`<p class="meta">${escape(String(book.ext).toUpperCase())} · ${Number(book.size)>0?Math.ceil(book.size/1024)+' КБ':''}${book.lang?' · '+escape(book.lang):''}</p>`;
        const available=[{key:'raw',label:'Оригинал ('+String(book.ext).toUpperCase()+')'},...formats.available(book.ext,this.config).map(format=>({key:format,label:format.toUpperCase()}))];
        if(identity)body+=this.formatForm(req,identity,this.url('/book',{...p,uid}),String(book.ext).toLowerCase())+this.downloadButton({...book,_uid:uid},formats.preference(identity.user));
        else body+=`<form class="download-form" action="${escape(this.root+'/book/by-uid')}" method="get">${this.hidden('uid',uid)}<label for="format">Формат скачивания</label><select id="format" name="format">${available.map(format=>option(format.key,format.label,'raw')).join('')}</select><button type="submit">Скачать книгу</button></form>`;
        if(formats.canRead(book.ext,this.config)&&!this.worker.remoteLib)body+=this.link('/read',{...p,uid,page:1,font:22,bookPage:p.page},'Читать текст','button');
        body+=`<p><a href="${escape(this.root+'/#/book?'+new URLSearchParams({bookUid:uid,lang:p.lang,sourceId:p.sourceId}))}">Открыть в полной веб-версии</a></p>`;
        if(scalar(req.query,'annotation',1)!=='1')body+=this.link('/book',{...p,uid,annotation:1},'Показать аннотацию','button');
        else {
            let preview;
            try{preview=(await this.worker.getBookPreview(uid)).bookPreview;}catch{preview={annotationStatus:'unavailable'};}
            body+='<h2>Аннотация</h2>';
            if(preview.annotation)body+=`<div class="annotation">${escape(preview.annotation)}</div>`;
            if(preview.annotationLimited)body+='<p class="hint">Показан фрагмент аннотации.</p>';
            else if(!preview.annotation)body+='<p>Аннотация '+(preview.annotationStatus==='empty'?'отсутствует.':'пока недоступна. Обновите страницу, чтобы повторить запрос.')+'</p>';
        }
        return {title:book.title||'Книга',body};
    }
    async reading(req) {
        const uid=scalar(req.query,'uid',1024),page=number(req.query,'page',1,2048),font=number(req.query,'font',22,28);
        if(!uid||![18,22,26].includes(font))throw bad('Некорректные параметры чтения.');
        if(!this.worker.ebookReader)this.worker.ebookReader=new EbookReader(this.worker);
        const value=await this.worker.ebookReader.read(uid),total=value.pages.length;
        if(page>total)throw bad('Страница не найдена.',404);
        const scope=parameters(req.query,this.config),bookPage=number(req.query,'bookPage',1,100000),p={...scope,uid,font,bookPage};
        let body=this.link('/book',{...scope,uid,page:bookPage},'О книге');
        body+='<nav aria-label="Размер текста">'+[18,22,26].map(size=>this.link('/read',{...p,page,font:size},size===18?'Меньше':size===22?'Обычный':'Крупнее')).join(' ')+'</nav>';
        body+=this.navigation(p,page,total,'/read')+`<div class="reading" style="font-size:${font}px">${escape(value.pages[page-1])}</div>`+this.navigation(p,page,total,'/read');
        body+='<p class="hint">Текстовое чтение. Иллюстрации доступны в скачанном файле. Ссылка на эту страницу сохраняет место; прогресс полной читалки не изменяется.</p>';
        return {title:value.book.title||'Чтение',body,reading:true};
    }
    async recent(req,identity) {
        if(!identity)return {title:'Сейчас читаю',body:'<p>Войдите в свой профиль, чтобы увидеть книги из истории.</p>'+this.link('/login',{},'Войти')};
        const summary=await this.worker.buildUserReadingSummary(identity.user,10),p=parameters({},this.config);
        return {title:'Сейчас читаю',body:summary.items.length?summary.items.map(book=>this.bookRow(book,p,formats.preference(identity.user))+`<p class="meta">Прочитано ${Math.round(book.percent*100)}%</p>`).join(''):'<p>В истории пока нет книг в процессе чтения.</p>'};
    }
    async shelfIndex(req,identity){
        const items=await shelves.lists(this.worker,identity.user.id),page=number(req.query,'page',1,100000),size=20,total=Math.max(1,Math.ceil(items.length/size));
        let body='<p class="intro">Ваши списки чтения. Откройте полку, чтобы скачать книги.</p>';
        if(!items.length)body+='<p>Полок пока нет. Создайте список в полной версии библиотеки.</p>';
        else if(page>total)body+='<p>Страница не найдена.</p>'+this.link('/shelves',{},'К первой странице');
        else body+=items.slice((page-1)*size,page*size).map(item=>`<article class="result"><h3>${this.link('/shelf',{id:item.id},short(item.name,240))}</h3><p class="meta">${item.smart?'Умная полка':item.bookCount+' книг'}</p></article>`).join('')+this.navigation({},page,total,'/shelves');
        return {title:'Мои полки',body};
    }
    async shelf(req,identity){
        const id=scalar(req.query,'id',128),raw=scalar(req.query,'cursor',9)||'0';
        if(!id||!/^\d+$/.test(raw)||Number(raw)>10000000)throw bad('Некорректные параметры полки.');
        const cursor=Number(raw),trailText=scalar(req.query,'trail',200),trail=trailText?trailText.split(','):[];
        if(trail.length>20||trail.some((value,index)=>!/^\d+$/.test(value)||Number(value)>=cursor||index>0&&Number(value)<=Number(trail[index-1])))throw bad('Некорректная страница полки.');
        const size=number(req.query,'size',10,20),value=await shelves.page(this.worker,identity.user,id,{offset:cursor,size});
        const selected=formats.preference(identity.user),p={id,cursor,trail:trailText,size};
        let body=this.link('/shelves',{},'Все полки')+(value.unreadOnly?'<p class="hint">Только непрочитанные книги.</p>':'');
        body+=this.formatForm(req,identity,this.url('/shelf',p));
        if(!value.books.length)body+=`<p>${value.next!==null?'В этой части полки нет непрочитанных книг. Продолжите просмотр.':'На полке пока нет доступных книг.'}</p>`;
        const scope={...parameters({},this.config),back:this.url('/shelf',p)};
        body+=value.books.map(book=>this.bookRow(book,scope,selected)).join('');
        const previous=trail.length?{...p,cursor:Number(trail.at(-1)),trail:trail.slice(0,-1).join(',')}:cursor?{...p,cursor:0,trail:''}:null;
        body+='<nav class="pagination" aria-label="Страницы">'+(previous?this.link('/shelf',previous,'Предыдущая'):'')+(value.next!==null?this.link('/shelf',{...p,cursor:value.next,trail:[...trail,cursor].slice(-20).join(',')},'Следующая'):'')+'</nav>';
        return {title:value.name,body};
    }
    register(app) {
        const router=express.Router();router.use((req,res,next)=>{this.headers(res);this.security.ensureSession(req,res);next();});
        router.use(express.urlencoded({extended:false,limit:'8kb',parameterLimit:12}));
        router.all('*',async(req,res)=>{
            let identity=null;
            try {
                if(!['GET','HEAD','POST'].includes(req.method)){res.set('Allow','GET, HEAD, POST');throw bad('Метод не поддерживается.',405);}
                const path=req.path.replace(/\/$/,'')||'/';
                if(req.method==='POST') {
                    if(!['/login','/access','/logout','/format'].includes(path))throw bad('Страница не найдена.',404);
                    if(path==='/format'){
                        if(!await this.libraryAllowed(req))return res.status(401).type('html').send(this.form(req,'access'));
                        identity=await this.identity(req);
                        if(!identity)throw bad('Войдите в профиль.',401);
                        if(!this.security.hasValidCsrf(req,scalar(req.body,'csrf',128)))throw bad('Обновите страницу и повторите действие.',403);
                        const format=scalar(req.body,'format',12);
                        if(format!=='original'&&!formats.formats.includes(format))throw bad('Неизвестный формат скачивания.');
                        await this.budget.run('profile:'+identity.user.id,'format:'+require('crypto').randomUUID(),async()=>{
                            this.checkIdentity(req,identity);await this.worker.updateUserProfile(identity.user.id,{defaultDownloadFormat:format});
                        },()=>!res.destroyed);this.checkIdentity(req,identity);
                    }else if(path==='/logout') {
                        if(!this.security.hasValidCsrf(req,scalar(req.body,'csrf',128)))throw bad('Обновите страницу и повторите действие.',403);
                        const token=req.securitySession.profileAccessToken;
                        try{if(token)await this.worker.closeProfileSession(token);}finally{delete req.securitySession.profileAccessToken;delete req.securitySession.ebookAccessToken;}
                    }
                    else if(path==='/access')await this.authBudget.run(this.security.clientIp(req),'access:'+req.securitySession.id+':'+require('crypto').randomUUID(),()=>this.authenticate(req,'access'));
                    else if(!await this.libraryAllowed(req))return res.status(401).type('html').send(this.form(req,'access'));
                    else await this.authBudget.run(this.security.clientIp(req),'profile:'+req.securitySession.id+':'+require('crypto').randomUUID(),()=>this.authenticate(req,'profile'));
                    return res.redirect(303,path==='/logout'?this.base:this.destination(req.body.next));
                }
                if(!await this.libraryAllowed(req))return res.status(401).type('html').send(this.form(req,'access'));
                identity=await this.identity(req);
                if(path==='/login')return res.type('html').send(this.access.bindingEnabled?this.document(req,'Вход',`<p>Профиль задаётся входом через proxy.</p>${this.link('',{},'К поиску')}`,identity):this.form(req,'profile'));
                if(this.access.loginRequired&&!identity)return res.status(401).type('html').send(this.form(req,'profile'));
                const isDownload=path==='/download'||/^\/download\/book\.[a-z0-9]{1,12}$/.test(path);
                if((['/shelves','/shelf'].includes(path)||isDownload)&&!identity)return res.status(401).type('html').send(this.form(req,'profile'));
                const handler=path==='/'?()=>this.search(req,identity):path==='/book'?()=>this.book(req,identity):path==='/read'?()=>this.reading(req):path==='/recent'?()=>this.recent(req,identity):path==='/shelves'?()=>this.shelfIndex(req,identity):path==='/shelf'?()=>this.shelf(req,identity):isDownload?()=>this.download(req,identity):null;
                if(!handler)throw bad('Страница не найдена.',404);
                const db=this.worker.db,generation=this.worker.libraryAssetGeneration;
                const key=JSON.stringify([req.securitySession.id,path,req.query]);
                const result=await this.budget.run(identity?'profile:'+identity.user.id:'session:'+req.securitySession.id,key,handler,()=>!res.destroyed);
                this.worker.checkLibraryAssetState(generation,db);
                this.checkIdentity(req,identity);
                if(result.redirect)return res.redirect(302,result.redirect);
                res.type('html').send(this.document(req,result.title,result.body,identity,result.reading));
            }catch(error){
                const status=error.code==='INPX_LOGIN_RATE_LIMIT'?429:error.code==='server_busy'||error.code==='INPX_DATABASE_UNAVAILABLE'?503:error.status||500;
                if(status===401)identity=null;
                if(status===429)res.set('Retry-After',String(error.retryAfter||60));
                const message=error.status?error.message:status===429?'Слишком много попыток. Повторите позже.':status===503?'Сервер занят или библиотека пока недоступна. Повторите запрос позже.':'Не удалось выполнить запрос. Попробуйте ещё раз.';
                if(req.method==='POST'&&status===401&&['/login','/access'].includes(req.path))return res.status(status).type('html').send(this.form(req,req.path==='/login'?'profile':'access',message));
                const bookLink=typeof req.query.uid==='string'&&req.query.uid.length<=1024?this.link('/book',{uid:req.query.uid},'О книге'):'';
                res.status(status).type('html').send(this.document(req,'Не удалось открыть страницу',`<p class="error" role="alert">${escape(message)}</p>${bookLink} ${this.link('',{},'К поиску')} ${this.link('/login',{},'Войти')}`,identity));
            }
        });
        app.use(this.base,router);
        // An explicitly requested electronic-reader route never falls through to the SPA.
        router.use((error,req,res,next)=>{this.headers(res);res.status(error.status===413?413:400).type('html').send(this.document(req,'Ошибка запроса','<p>Не удалось обработать форму.</p>'));});
        return this;
    }
}
module.exports={EbookController,register:(app,config,worker,security,webAccess)=>new EbookController(config,worker,security,webAccess).register(app),escape,parameters};
