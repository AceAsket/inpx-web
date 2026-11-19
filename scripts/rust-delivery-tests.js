const assert = require('node:assert/strict');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const {createServer} = require('node:http');
const net = require('node:net');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomBytes} = require('node:crypto');
const {setTimeout:sleep} = require('node:timers/promises');

const password = 'rust-delivery-fixture';
const token = '123456:fixture-token';
const first = 'Первая книга доставки';
const second = 'Вторая книга доставки';
const missing = 'Отсутствующий файл доставки';
const large = 'Большой файл для очереди ZIP';
const series = 'Серия тестовой доставки';
const text = '<FictionBook><description><title-info><book-title>Тест</book-title><lang>ru</lang></title-info></description><body><section><p>Проверка вложения.</p></section></body></FictionBook>';

async function zip(path, entries) {
    const archive = new (require('yazl').ZipFile)();
    const stream = createWriteStream(path);
    archive.outputStream.pipe(stream);
    for (const [name, contents] of entries) archive.addBuffer(Buffer.from(contents), name);
    archive.end();
    await once(stream, 'finish');
}

async function fixture(library) {
    await fs.mkdir(library, {recursive:true});
    const data = randomBytes(48 * 1024 * 1024);
    const book = (title, number, ext, size, collection = '', position = '') =>
        ['Тестов,Автор:', 'sf:', title, collection, position, number, size, number, 0, ext,
            '2026-11-17', 'ru', 0, ''].join('\x04');
    const rows = [
        book(first, 1, 'fb2', Buffer.byteLength(text), series, 1),
        book(second, 2, 'fb2', Buffer.byteLength(text), series, 2),
        book(missing, 3, 'fb2', 42),
        book(large, 4, 'txt', data.length),
    ];
    await zip(join(library, 'delivery.inpx'), [['collection.info', 'Доставка\n'], ['delivery.inp', rows.join('\n')+'\n']]);
    await zip(join(library, 'delivery.zip'), [['1.fb2', text], ['2.fb2', text], ['4.txt', data]]);
}

function multipart(body, contentType) {
    const boundary = contentType.split('boundary=')[1];
    const fields = {};
    for (const part of body.toString('latin1').split('--'+boundary)) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const name = /\bname="([^"]+)"/.exec(headers)?.[1];
        if (!name) continue;
        fields[name] = Buffer.from(part.slice(headerEnd+4, -2), 'latin1');
        if (name==='document') fields.filename = /\bfilename="([^"]+)"/.exec(headers)?.[1];
    }
    return fields;
}

function service() {
    const state = {documentRequests:0, documents:[], messages:[], mail:[], polls:[], hold:false,
        telegramFailure:0, smtpFailure:false, updates:[]};
    let sequence=100;
    const waiters = [];
    createServer(async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const type = request.headers['content-type'] || '';
            function json(value, status = 200) {
                response.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify(value));
            }
            if (request.url==='/state') return json(state);
            const payload = type.startsWith('application/json') ? JSON.parse(body) : {};
            if (request.url==='/control') {
                Object.assign(state, payload);
                if (!state.hold) waiters.splice(0).forEach(resolve => resolve());
                return json({ok:true});
            }
            if (request.url==='/update') {
                state.updates.push({...payload, update_id:++sequence});
                return json({ok:true});
            }
            const method = request.url.split('/').at(-1);
            if (!request.url.startsWith('/bot'+token+'/')) return json({ok:false,error_code:401}, 401);
            let result = true;
            switch (method) {
                case 'getMe': result = {id:42, username:'fixture_delivery_bot'}; break;
                case 'getWebhookInfo': result = {url:''}; break;
                case 'setMyCommands': break;
                case 'getUpdates':
                    state.polls.push(payload.offset);
                    if (state.polls.length>200) state.polls.shift();
                    await sleep(150);
                    result = state.updates.filter(update => update.update_id>=payload.offset);
                    break;
                case 'sendMessage':
                case 'editMessageText': state.messages.push(payload); break;
                case 'answerCallbackQuery': break;
                case 'sendDocument': {
                    const fields = multipart(body, type);
                    state.documentRequests++;
                    if (state.hold) await new Promise(resolve => waiters.push(resolve));
                    if (state.telegramFailure) {
                        const code=state.telegramFailure;
                        state.telegramFailure=0;
                        return json({ok:false,error_code:code,description:'mock failure containing '+token},code);
                    }
                    state.documents.push({chat:fields.chat_id?.toString(), caption:fields.caption?.toString(),
                        filename:fields.filename, bytes:fields.document?.toString('base64')});
                    result = {message_id:state.documents.length};
                    break;
                }
                default: return json({ok:false,error_code:404}, 404);
            }
            json({ok:true, result});
        } catch (error) {
            console.error(error);
            response.writeHead(500).end();
        }
    }).listen(8080, '0.0.0.0');
    net.createServer(socket => {
        let buffer = '', data, from, recipients = [];
        const reply = line => socket.write(line + '\r\n');
        socket.setEncoding('utf8');
        socket.on('error', () => {});
        reply('220 fixture.example.test ESMTP');
        socket.on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0,end);
                buffer = buffer.slice(end+2);
                if (data) {
                    if (line === '.') {
                        state.mail.push({from, recipients, raw:data.join('\r\n')});
                        data = undefined;
                        reply('250 Queued');
                    } else data.push(line);
                } else if (line.startsWith('EHLO')) {
                    reply('250-fixture.example.test');
                    reply('250 SIZE 104857600');
                } else if (line.startsWith('MAIL FROM:')) {
                    from = line.slice(10); recipients = []; reply('250 OK');
                } else if (line.startsWith('RCPT TO:')) {
                    if (state.smtpFailure) { state.smtpFailure=false; reply('550 Recipient rejected'); }
                    else { recipients.push(line.slice(8)); reply('250 OK'); }
                } else if (line==='DATA') { data=[]; reply('354 End with .'); }
                else if (line==='QUIT') { reply('221 Bye'); socket.end(); }
                else reply('500 Unsupported');
            }
        });
    }).listen(2525, '0.0.0.0');
}

async function unpack(buffer) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'inpx-delivery-'));
    const file = join(directory, 'received.zip');
    let archive;
    try {
        await fs.writeFile(file, buffer);
        archive = new (require('node-stream-zip').async)({file});
        const entries = [];
        for (const entry of Object.values(await archive.entries()))
            entries.push({name:entry.name, bytes:await archive.entryData(entry.name)});
        return entries;
    } finally {
        await archive?.close();
        await fs.unlink(file);
        await fs.rmdir(directory);
    }
}

async function verify(base, backend) {
    const {connect, signIn, waitFor} = require('./rust-events-tests');
    const client = await connect(base);
    let outsider;
    const calls = [];
    try {
        const identity = await signIn(client, 'admin', password);
        const request = (action, fields={}) => client.send(action, {...identity,...fields});
        const send = async (action, fields) => {
            const result = await request(action, fields);
            assert.equal(result.error || '', '', `${action}: ${result.error}`);
            return result;
        };
        const track = promise => { calls.push(promise); promise.catch(()=>{}); return promise; };
        const mock = async (path, fields) => {
            const reply = await fetch(backend + path, fields===undefined ? {} : {
                method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields),
            });
            assert.equal(reply.status,200);
            return reply.json();
        };
        const find = async title => (await send('bookSearch',{query:{title:'='+title}})).found[0]._uid;
        const [one,two,bad,big] = await Promise.all([first,second,missing,large].map(find));
        async function download(result, count) {
            assert.equal(result.count,count,result.error);
            const response = await fetch(base+result.url, {headers:{cookie:client.cookie}});
            assert.equal(response.status,200);
            assert.equal(response.headers.get('content-type'),'application/zip');
            return unpack(Buffer.from(await response.arrayBuffer()));
        }
        const batch = await send('prepare-batch-download',{selection:{bookUids:[one,two,one]}});
        const entries = await download(batch,2);
        assert(entries[0].name.startsWith(series+'/001_'));
        assert(entries.every(entry=>entry.bytes.toString()===text));
        const head = await fetch(base+batch.url,{method:'HEAD',headers:{cookie:client.cookie}});
        assert.equal(head.status,200);
        const range = await fetch(base+batch.url,{headers:{range:'bytes=0-7',cookie:client.cookie}});
        assert.equal(range.status,206);
        assert.equal((await range.arrayBuffer()).byteLength,8);
        const fromSeries = await send('prepare-batch-download',{selection:{series}});
        assert.equal((await download(fromSeries,2)).length,2);
        const shelf = await send('create-reading-list',{name:'Полка доставки'});
        await send('update-reading-list-book',{listId:shelf.list.id,bookUid:one,enabled:true});
        const fromShelf = await send('prepare-batch-download',{selection:{listId:shelf.list.id}});
        assert.equal((await download(fromShelf,1))[0].bytes.toString(),text);
        const failure = await request('prepare-batch-download',{selection:{bookUids:[one,bad,two]}});
        assert.match(failure.error,/Книга 2 из 3.*Файл книги не найден/);
        assert.equal(failure.bookUid,bad);
        assert.equal(failure.url,undefined);
        assert.match((await request('send-book-telegram',{bookUid:'no-such-book'})).error,/chat id/i);
        const zipped = track(send('prepare-batch-download',{selection:{bookUids:[big]}}));
        await waitFor(()=>send('get-background-tasks'), result=>result.tasks.some(task=>task.kind==='batch-download' && task.state==='running'),
            'Large batch did not start',45);
        const queued = track(send('prepare-batch-download',{selection:{bookUids:[one]}}));
        await waitFor(()=>send('get-background-tasks'), result=>result.tasks.some(task=>task.kind==='batch-download' && task.state==='queued'),
            'Second batch did not enter the queue',45);
        assert.equal(await find(second),two);
        assert.equal((await zipped).count,1);
        assert.equal((await queued).count,1);
        console.log('ok ZIP selection and series, archive bytes, HEAD/ranges, per-book error, rollback and queued retry');

        const health = await waitFor(()=>send('admin-telegram-bot-status'), result=>result.telegramBotStatus.state==='running',
            'Telegram did not start polling');
        assert.equal(health.telegramBotStatus.username,'fixture_delivery_bot');
        assert(health.telegramBotStatus.lastPollAt);
        assert.equal((await send('telegram-bot-account',{operation:'status'})).linked,false);
        const pair = await send('telegram-bot-account',{operation:'link'});
        assert(Date.parse(pair.expiresAt)>Date.now());
        const start = '/start '+new URL(pair.url).searchParams.get('start');
        const message = (id, content, type='private') => ({message:{text:content,chat:{type,id},from:{id,is_bot:false}}});
        await mock('/update',message(123,start,'group'));
        await mock('/update',message(123,start));
        const linked = await waitFor(()=>send('telegram-bot-account',{operation:'status'}), result=>result.linked,
            'Pair was not accepted by the polling bot');
        assert.equal(linked.bindingSource,'link');
        assert.equal(linked.chatId,'123');
        assert.equal((await send('telegram-bot-account',{operation:'digest',options:{enabled:true}})).digest,true);
        await send('update-user-profile',{targetUserId:identity.userId,profile:{emailTo:'reader@example.test',telegramAsZip:true}});
        const config = await send('get-config');
        assert.equal(config.telegramShareEnabled,true);
        assert.equal(config.emailShareEnabled,true);
        await send('create-user-profile',{profile:{name:'Читатель',login:'book-reader-test',password}});
        outsider = await connect(base);
        const other = await signIn(outsider,'book-reader-test',password);
        assert.match((await outsider.send('admin-telegram-bot-status',other)).error,/администратора/);
        assert.match((await outsider.send('prepare-batch-download',{...other,selection:{listId:shelf.list.id}})).error,/Список не найден/);
        const denied = await fetch(base+batch.url,{headers:{cookie:outsider.cookie}});
        assert.equal(denied.status,403);
        await denied.body.cancel();
        console.log('ok Telegram polling status, profile link, digest setting, admin scope and ZIP ownership');

        assert.equal((await send('send-book-telegram',{bookUid:one,format:'original'})).success,true);
        const doc = (await mock('/state')).documents[0];
        assert.equal(doc.chat,'123');
        assert(doc.caption.includes(first));
        assert(doc.filename.endsWith('.fb2.zip'));
        assert.equal((await unpack(Buffer.from(doc.bytes,'base64')))[0].bytes.toString(),text);
        const before = await mock('/state');
        await mock('/control',{hold:true});
        const outgoing = Array.from({length:5},()=>track(send('send-book-telegram',{bookUid:two})));
        await waitFor(()=>mock('/state'), result=>result.documentRequests>=before.documentRequests+4,
            'Four deliveries did not start');
        const tasks = await send('get-background-tasks');
        assert.equal(tasks.tasks.filter(task=>task.kind==='book-delivery' && task.state==='running').length,4);
        assert.equal(tasks.tasks.filter(task=>task.kind==='book-delivery' && task.state==='queued').length,1);
        assert.equal((await mock('/state')).documentRequests,before.documentRequests+4);
        await mock('/control',{hold:false});
        assert((await Promise.all(outgoing)).every(result=>result.success));
        await mock('/control',{telegramFailure:403});
        const providerError = await request('send-book-telegram',{bookUid:one});
        assert.match(providerError.error,/403/);
        assert(!providerError.error.includes(token));
        const bookError = await request('send-book-telegram',{bookUid:bad});
        assert.match(bookError.error,/Файл книги не найден/);
        console.log('ok Telegram multipart ZIP, queue and per-book/provider errors');

        assert.equal((await send('send-book-email',{bookUid:two})).success,true);
        const mail = (await mock('/state')).mail[0];
        assert.deepEqual(mail.recipients,['<reader@example.test>']);
        assert.match(mail.raw,/Subject: =\?UTF-8\?B\?/);
        assert.match(mail.raw,/filename\*=UTF-8''/);
        assert(mail.raw.replace(/\r\n/g,'').includes(Buffer.from(text).toString('base64')));
        await mock('/control',{smtpFailure:true});
        assert.match((await request('send-book-email',{bookUid:two})).error,/SMTP 550/);
        assert.match((await request('send-book-email',{bookUid:bad})).error,/Файл книги не найден/);
        assert.equal((await mock('/state')).mail.length,1);
        await mock('/update',message(123,'/search '+first));
        const buttons = async title => {
            const result = await waitFor(()=>mock('/state'), varState =>
                varState.messages.some(item=>item.chat_id==='123' && item.text.startsWith(title)),
            'Telegram message was not returned: '+title);
            return result.messages.find(item=>item.chat_id==='123' && item.text.startsWith(title)).reply_markup.inline_keyboard.flat();
        };
        const click = async button => mock('/update',{callback_query:{id:randomBytes(8).toString('hex'),
            data:button.callback_data,from:{id:123,is_bot:false},message:{message_id:42,chat:{id:123,type:'private'}}}});
        await send('change-library-follow',{operation:'add',payload:{kind:'series',value:series}});
        await mock('/update',message(123,'/favorites'));
        assert((await buttons('Избранные авторы и серии')).some(button=>button.text===series));
        await click((await buttons('Результаты поиска')).find(button=>button.text===first));
        const initialBot = await mock('/state');
        const docs = initialBot.documents.length;
        const sendButton = (await buttons(first)).find(button=>button.text==='Получить оригинал');
        await mock('/control',{hold:true});
        await click(sendButton);
        await waitFor(()=>mock('/state'), result=>result.documentRequests===initialBot.documentRequests+1,'Bot file upload did not start');
        await click(sendButton);
        await buttons('Другая книга уже готовится');
        assert.equal((await mock('/state')).documentRequests,initialBot.documentRequests+1);
        await mock('/control',{hold:false});
        await waitFor(()=>mock('/state'), result=>result.documents.length===docs+1,'Telegram callback did not deliver the book');
        await send('telegram-bot-account',{operation:'unlink'});
        assert.equal((await send('telegram-bot-account',{operation:'status'})).linked,false);
        await mock('/update',message(234,start));
        await waitFor(()=>mock('/state'), result=>result.messages.some(message=>message.chat_id==='234' && /истекла/.test(message.text)),
            'Pair token could be reused');
        assert.equal((await send('get-config')).telegramShareEnabled,false);
        console.log('ok SMTP MIME attachment and rejection, Telegram bot search and delivery, unlink and one-use link');
    } finally {
        await fetch(backend+'/control',{method:'POST',headers:{'content-type':'application/json'},body:'{"hold":false}'}).catch(()=>{});
        await Promise.allSettled(calls);
        outsider?.close();
        client.close();
    }
}

const [mode,arg] = process.argv.slice(2);
if (mode==='service') service();
else (mode==='fixture' ? fixture(arg) : verify(mode, arg)).catch(error=>{console.error(error);process.exitCode=1;});
