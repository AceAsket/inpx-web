const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const TelegramBot = require('../server/core/TelegramBot');
const ReadingListStore = require('../server/core/ReadingListStore');

async function fixture(task) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-bot-'));
    try {
        let now = Date.now();
        const config = {dataDir: directory, telegramShareEnabled: true, telegramBotEnabled: true, telegramBotToken: 'test-only-token',
            conversionEnabled: true, conversionFormats: ['fb2', 'epub'], adminPassword: 'integration-test-admin-password'};
        const store = new ReadingListStore(config); store.nowIso = () => new Date(now).toISOString();
        const a = await store.createUser({name: 'Alice', login: 'alice'}), b = await store.createUser({name: 'Bob', login: 'bob'});
        const books = [{_uid: 'book-one', id: 1, title: 'Book <one>', author: 'Author', ext: 'fb2', size: 100}];
        const messages = [], deliveries = [], events = [];
        const worker = {config, readingListStore: store, libraryAssetGeneration: 1, addAdminEvent: (...args) => events.push(args),
            getBookRecordByUid: async uid => books.find(book => book._uid === uid),
            bookSearch:async query=>({totalFound:books.length,found:books.slice(query.offset||0,(query.offset||0)+query.limit)}),
            getCatalogDiscovery: () => ({suggest: async() => ({groups: [{kind: 'title', items: [{name: books[0].title, book: books[0]}]}], corrections: []})}),
            getReadingLists: async userId => ({lists: (await store.getLists(userId)).map(list => store.listStats(list))}),
            db: {esc: JSON.stringify, select: async() => books},
            sendBookToTelegram: async(uid, format, userId, options) => {await options.authorize(); deliveries.push({uid, format, userId, chatId: options.chatId});},
            markReaderBooksRead: async(userId, uids, read) => store.setBooksRead(userId, uids, read),
            createReadingList: async(userId, name) => ({list: await store.createList(userId, name)}),
            updateReadingListBook: async(userId, listId, uid, enabled) => store.setBookMembership(userId, listId, uid, enabled),
            libraryFollows: {list: async() => ({follows: [], books})},
        };
        const bot = new TelegramBot(worker, {now: () => now, sleep: async() => {}});
        const run = {botId: '42', username: 'inpx_test_bot', controller: new AbortController(),
            api: {call: async(method, data) => {messages.push({method, data}); return {message_id: messages.length};}}};
        bot.run = run; bot.health.username = run.username;
        const send = (chat, text) => bot.handle(run, {message: {message_id: 1, text, chat: {type: 'private', id: chat}, from: {id: chat}}});
        const callback = (chat, data) => bot.handle(run, {callback_query: {id: 'callback', data, from: {id: chat}, message: {message_id: 1, chat: {id: chat, type: 'private'}}}});
        const link = async(user, chat) => {
            const issued = await bot.account(user, 'link');
            const start = new URL(issued.url).searchParams.get('start');
            await send(chat, `/start ${start}`); return {issued, start};
        };
        await task({a, b, store, bot, worker, run, messages, deliveries, events, send, callback, link,
            advance: ms => {now += ms;}, setNow: value => {now = value;}});
        bot.stop();
    } finally {await fs.remove(directory);}
}

async function testTelegramBotPairingIsolationExpiryAndRestart() {
    await fixture(async({a, b, store, bot, worker, run, messages, send, callback, link, advance}) => {
        await send(101, '/lists');
        assert(messages.at(-1).data.text.includes('одноразовой') || messages.at(-1).data.text.includes('Подключить Telegram'));
        assert(!messages.at(-1).data.text.includes('Alice'));
        const before = messages.length;
        await bot.handle(run, {message: {text: '/help', chat: {type: 'group', id: -100}, from: {id: 101}}});
        await bot.handle(run, {message: {text: '/help', chat: {type: 'private', id: 101}, from: {id: 102}}});
        assert.strictEqual(messages.length, before, 'Groups and mismatched identities are ignored');
        const first = await link(a, 101);
        assert.strictEqual((await store.findTelegramUser('42', '101')).id, a.id);
        await send(102, `/start ${first.start}`);
        assert.strictEqual(await store.findTelegramUser('42', '102'), null, 'Pairing links are single-use');
        const expired = await bot.account(b, 'link'); advance(11 * 60000);
        await send(102, `/start ${new URL(expired.url).searchParams.get('start')}`);
        assert.strictEqual(await store.findTelegramUser('42', '102'), null);
        await link(b, 102);
        const ctx = {run, chatId: '101', userId: a.id};
        const button = bot.button(ctx, 'Private action', 'read', {uid: 'book-one'});
        assert(Buffer.byteLength(button.callback_data) <= 64);
        await callback(102, button.callback_data);
        assert.strictEqual(Object.keys((await store.getUser(b.id)).readerProgress).length, 0, 'Callbacks cannot cross profiles');
        worker.libraryAssetGeneration++;
        await callback(101, button.callback_data);
        assert(!((await store.getUser(a.id)).readerProgress || {})['book-one'], 'A changed catalog invalidates callbacks');
        const restarted = new TelegramBot(worker); restarted.run = run;
        assert.strictEqual((await restarted.account(a, 'status')).linked, true, 'Verified bindings survive a restart');
        assert.strictEqual(restarted.pairs.size, 0, 'Pairing secrets never survive a restart');
        await bot.account(a, 'unlink');
        assert.strictEqual(await store.findTelegramUser('42', '101'), null);
        await callback(101, button.callback_data);
        assert(!((await store.getUser(a.id)).readerProgress || {})['book-one']);
    });
}

async function testTelegramBotSearchFormatsPrivateListsAndRevocation() {
    await fixture(async({a, b, store, bot, worker, run, messages, deliveries, send, callback, link, advance}) => {
        await link(a, 101); await link(b, 102);
        await store.createList(a.id, 'Alice private'); await store.createList(b.id, 'Bob private');
        await send(101, '/lists');
        const listOutput = messages.at(-1).data;
        assert(JSON.stringify(listOutput).includes('Alice private')); assert(!JSON.stringify(listOutput).includes('Bob private'));
        await send(101, 'Book');
        const bookButton = messages.at(-1).data.reply_markup.inline_keyboard[0][0];
        await callback(101, bookButton.callback_data);
        assert(messages.at(-1).data.text.includes('Book &lt;one&gt;'));
        const download = messages.at(-1).data.reply_markup.inline_keyboard[0][0];
        assert.strictEqual(download.text, 'Получить FB2', 'The original download names its real file format');
        await callback(101, download.callback_data);
        await bot.idle();
        assert.deepStrictEqual(deliveries[0], {uid: 'book-one', format: 'raw', userId: a.id, chatId: '101'});
        await callback(101, download.callback_data);
        assert.strictEqual(deliveries.length, 1, 'Repeated callback delivery does not send the same file twice');
        advance(60001);
        const ctx = {run, chatId: '101', userId: a.id}, read = bot.button(ctx, 'Read', 'read', {uid: 'book-one'});
        await callback(101, read.callback_data);
        assert.strictEqual((await store.getUser(a.id)).readerProgress['book-one'].percent, 1);
        assert(!((await store.getUser(b.id)).readerProgress || {})['book-one']);
        const save = bot.button(ctx, 'Save', 'save', {uid: 'book-one'});
        await callback(101, save.callback_data);
        const wanted = (await store.getLists(a.id)).find(list => list.name === 'Хочу прочитать');
        assert(wanted?.books.some(book => book.bookUid === 'book-one'));
        let release, entered;
        const started = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
        worker.sendBookToTelegram = async(uid, format, userId, options) => {entered(); await gate; await options.authorize(); deliveries.push({uid});};
        const delayed = bot.button(ctx, 'File', 'download', {uid: 'book-one'});
        const running = callback(101, delayed.callback_data); await started;
        await bot.account(a, 'unlink'); release(); await running; await bot.idle();
        assert.strictEqual(deliveries.length, 1, 'Unlinking while preparing a file prevents its delivery');
        await assert.rejects(store.changeTelegramBinding(a.id, 'link', {botId: '42', chatId: '102'}), /другому профилю/);
        await store.deleteUser(a.id);
        const before = (await store.load()).users.map(user => [user.id, user.readerProgress]);
        await assert.rejects(store.setBooksRead(a.id, ['book-one'], true), /Пользователь не найден/);
        await assert.rejects(store.createList(a.id, 'Orphan list'), /Пользователь не найден/);
        await assert.rejects(store.changeLibraryFollow(a.id, 'add', {kind: 'author', value: 'Author'}), /Пользователь не найден/);
        assert.deepStrictEqual((await store.load()).users.map(user => [user.id, user.readerProgress]), before, 'Deleted profiles never fall back to the administrator');
    });
}

async function testTelegramBotDigestIsOptInAndBounded() {
    await fixture(async({a, bot, run, store, messages, link, setNow}) => {
        setNow(new Date(2026, 10, 9, 10).getTime());
        await link(a, 101); messages.length = 0;
        await bot.digest(run); assert.strictEqual(messages.length, 0);
        await bot.account(a, 'digest', {enabled: true});
        await bot.digest(run); assert.strictEqual(messages.filter(row => row.method === 'sendMessage').length, 1);
        await bot.digest(run); assert.strictEqual(messages.filter(row => row.method === 'sendMessage').length, 1);
        assert.strictEqual((await store.getUser(a.id)).telegramDigestSeen[0], 'book-one');
        for (let i = 0; i < 3000; i++) bot.rate(String(i), 'spam', 20);
        assert(bot.rates.size <= 1000);
        const text = require('../server/core/SensitiveLog').redact({url: 'https://t.me/inpx_test_bot?start=link_secret-code'});
        assert(!JSON.stringify(text).includes('secret-code'));
    });
}
async function testTelegramBotPollingResumesOffsetAndPreservesWebhook() {
    await fixture(async({worker, bot: original}) => {
        original.stop();
        let bot, polls = 0, processed = 0;
        const api = {call: async(method, data) => {
            if (method === 'getMe') return {id: 42, username: 'inpx_test_bot'};
            if (method === 'getWebhookInfo') return {url: ''};
            if (method === 'getUpdates') {
                polls++;
                if (polls === 1) {assert.strictEqual(data.offset, 0); return [{update_id: 501}];}
                assert.strictEqual(data.offset, 502); bot.stop(); return [];
            }
            return true;
        }};
        bot = new TelegramBot(worker, {apiFactory: () => api});
        bot.handle = async() => {processed++;};
        bot.configure(); const firstTask = bot.task; bot.configure();
        assert.strictEqual(bot.task, firstTask, 'Unchanged settings never start a second poller');
        await bot.task;
        assert.strictEqual(processed, 1);
        assert.deepStrictEqual(await fs.readJson(bot.offsetFile), {version: 1, botId: '42', offset: 502});
        const restarted = new TelegramBot(worker, {apiFactory: () => ({call: async(method, data) => {
            if (method === 'getUpdates') {assert.strictEqual(data.offset, 502); restarted.stop(); return [];}
            return api.call(method, data);
        }})});
        restarted.configure(); await restarted.task;
        const methods = [];
        const webhook = new TelegramBot(worker, {apiFactory: () => ({call: async method => {
            methods.push(method);
            if (method === 'getMe') return {id: 42, username: 'inpx_test_bot'};
            if (method === 'getWebhookInfo') return {url: 'https://example.invalid/another-application'};
            throw new Error('Webhook owner must not be changed');
        }})});
        webhook.configure();
        for (let i = 0; i < 100 && webhook.status().state !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.strictEqual(webhook.status().state, 'error'); assert(webhook.status().error.includes('webhook'));
        webhook.stop(); await webhook.task;
        assert.deepStrictEqual(methods, ['getMe', 'getWebhookInfo']);
    });
}
async function testTelegramBotApiSanitizesFailuresAndHonorsCancellation() {
    const axios = require('axios'), TelegramBotApi = require('../server/core/TelegramBotApi');
    const saved = axios.post, token = 'sensitive-test-token';
    try {
        axios.post = async() => {throw {response: {status: 429, data: {description: `Retry ${token}`, parameters: {retry_after: 9}}}};};
        await assert.rejects(new TelegramBotApi({}, token).call('getMe'), error => error.status === 429 && error.retryAfter === 9
            && !error.message.includes(token) && !error.stack.includes(token));
        const controller = new AbortController(); controller.abort(new Error('Canceled by test'));
        await assert.rejects(new TelegramBotApi({}, token).call('getUpdates', {}, controller.signal), /Canceled by test/);
    } finally {axios.post = saved;}
}
async function testTelegramBotUsesProfileFormatAndThrottlesPerChat() {
    await fixture(async({a, bot, run, store, worker, messages, deliveries, link, callback}) => {
        await link(a, 101);
        await store.updateUser(a.id, {defaultTelegramFormat: 'epub'});
        const ctx = {run, chatId: '101', userId: a.id};
        await bot.dispatch(ctx, a, 'book', {uid: 'book-one'});
        const download = messages.at(-1).data.reply_markup.inline_keyboard[0][0];
        assert(download.text.includes('EPUB'));
        await callback(101, download.callback_data); await bot.idle();
        assert.strictEqual(deliveries[0].format, 'epub');
        await store.updateUser(a.id, {defaultTelegramFormat: 'original'});
        const originalBook = await worker.getBookRecordByUid('book-one');
        for (const ext of ['epub', 'pdf']) {
            worker.getBookRecordByUid = async() => ({...originalBook, ext});
            await bot.dispatch(ctx, a, 'book', {uid: 'book-one'});
            assert.strictEqual(messages.at(-1).data.reply_markup.inline_keyboard[0][0].text, `Получить ${ext.toUpperCase()}`);
        }
        bot.outbound.clear(); bot.nextMessageAt = 0;
        const sleeps = []; bot.sleep = async milliseconds => {sleeps.push(milliseconds);};
        await bot.throttle(ctx); await bot.throttle(ctx);
        assert(sleeps.some(milliseconds => milliseconds >= 1000), 'Replies in the same chat are paced');
    });
}
async function testTelegramBotConfiguredChatNeedsNoLinkAndRevokesOldIdentity() {
    await fixture(async({a,b,store,bot,run,messages,send,callback,advance})=>{
        await store.updateUser(a.id,{telegramChatId:'101'});
        await send(101,'/help');assert(messages.at(-1).data.text.includes('Alice'));
        const status=await bot.account(a,'status');assert(status.linked);assert.equal(status.bindingSource,'configured');
        const old=bot.button({run,chatId:'101',userId:a.id},'Read','read',{uid:'book-one'});
        const restarted=new TelegramBot(bot.worker);restarted.run=run;
        assert((await restarted.account(a,'status')).linked,'Automatic bindings survive restart');
        await assert.rejects(store.updateUser(b.id,{telegramChatId:'101'}),/Chat ID уже/);
        const legacy=await store.load();legacy.users.find(user=>user.id===b.id).telegramChatId='101';await store.save(legacy);
        assert.equal(await store.findTelegramUser('42','101'),null,'Duplicate configured IDs never select a profile');
        await store.updateUser(b.id,{telegramChatId:''});
        assert.equal((await store.findTelegramUser('43','101')).id,a.id,'Configured IDs follow the current bot after rotation');
        assert.equal((await store.findTelegramUser('42','101')).id,a.id);
        await store.updateUser(a.id,{telegramChatId:'102'});
        assert.equal(await store.findTelegramUser('42','101'),null);
        await callback(101,old.callback_data);assert(!((await store.getUser(a.id)).readerProgress||{})['book-one']);
        await send(102,'/help');assert(messages.at(-1).data.text.includes('Alice'));
        await bot.account(a,'unlink');
        assert.equal(await store.findTelegramUser('42','102'),null);
        const afterRestart=new ReadingListStore(bot.config);assert.equal(await afterRestart.findTelegramUser('42','102'),null);
        // Leaving a delivery address after disabling the bot cannot re-enable access.
        const data=await store.load();const user=data.users.find(row=>row.id===a.id);user.telegramChatId='102';await store.save(data);
        assert.equal(await store.findTelegramUser('42','102'),null);
        await store.updateUser(a.id,{telegramChatId:'-100123'});assert.equal(await store.findTelegramUser('42','-100123'),null);
        advance(60001);
    });
}
async function testTelegramBotConfiguredChatCannotOverrideVerifiedProfile() {
    await fixture(async({a,b,store,link})=>{
        await link(b,102);await assert.rejects(store.updateUser(a.id,{telegramChatId:'102'}),/Chat ID уже/);
        await assert.rejects(store.createUser({name:'Duplicate',login:'duplicate',telegramChatId:'102'}),/Chat ID уже/);
        const legacy=await store.load();legacy.users.find(user=>user.id===a.id).telegramChatId='102';await store.save(legacy);
        assert.equal((await store.findTelegramUser('42','102')).id,b.id,'A configured ID cannot hijack an explicitly verified binding');
        await assert.rejects(store.changeTelegramBinding(a.id,'link',{botId:'42',chatId:'102'}),/другому профилю/);
    });
    await fixture(async({a,b,store,bot,link})=>{
        await store.updateUser(a.id,{telegramChatId:'102'});await store.findTelegramUser('42','102');
        const legacy=await store.load();legacy.users.find(user=>user.id===b.id).telegramChatId='102';await store.save(legacy);
        const controller=new AbortController();bot.deliveries.set('102',{userId:a.id,controller,promise:Promise.resolve()});
        await link(b,102);
        assert.equal((await store.findTelegramUser('42','102')).id,b.id,'A verified owner can replace a configured automatic binding');
        assert(controller.signal.aborted,'Pending delivery for the replaced profile is canceled');
        await bot.account(b,'unlink');
        assert.equal(await store.findTelegramUser('42','102'),null,'The superseded configured address cannot return after unlink');
    });
}
async function testTelegramBotSearchIsPagedAndDoesNotUseAutocomplete() {
    await fixture(async({a,bot,worker,messages,send,link,callback})=>{
        await link(a,101);const calls=[];
        worker.getCatalogDiscovery=()=>{throw new Error('Submitted search must not use autocomplete');};
        worker.bookSearch=async query=>{calls.push(query);return {totalFound:20,found:Array.from({length:Math.min(query.limit,20-query.offset)},(_,i)=>({_uid:'s-'+(query.offset+i),title:'Книга '+(query.offset+i)}))};};
        await send(101,'Яд');assert.equal(calls[0].title,'яд');assert.equal(calls[0].limit,8);assert.equal(calls[0].offset,0);
        const next=messages.at(-1).data.reply_markup.inline_keyboard.flat().find(button=>button.text==='Далее →');
        await callback(101,next.callback_data);assert.equal(calls.at(-1).offset,8);
        const author=messages.at(-1).data.reply_markup.inline_keyboard.flat().find(button=>button.text==='По автору');
        await callback(101,author.callback_data);assert.equal(calls.at(-1).author,'яд');assert.equal(calls.at(-1).offset,0);
        await bot.dispatch({run:bot.run,chatId:'101',userId:a.id},a,'search',{query:'~\\D'});
        assert.equal(calls.at(-1).title,'d','Chat input cannot activate a regular expression');
    });
}
async function testTelegramBotSmartShelvesAreBoundedAndPrivate() {
    await fixture(async({a,b,bot,worker,store,messages,link,callback})=>{
        await link(a,101);const own=await store.createList(a.id,'Own','private',{title:'Книга'}),foreign=await store.createList(b.id,'Foreign');
        worker.getReadingLists=worker.smartShelfEntries=()=>{throw new Error('Do not materialize smart shelves');};
        const calls=[];worker.bookSearch=async query=>{calls.push(query);return {totalFound:10000,found:Array.from({length:query.limit},(_,i)=>({_uid:'b'+(query.offset+i),title:'Книга '+(query.offset+i)}))};};
        const ctx={run:bot.run,chatId:'101',userId:a.id};await bot.dispatch(ctx,a,'lists');assert.equal(calls.length,0,'Listing shelf names performs no book query');
        await bot.dispatch(ctx,a,'list',{id:own.id});assert.equal(calls.length,1);assert.equal(calls[0].limit,8);
        const next=messages.at(-1).data.reply_markup.inline_keyboard.flat().find(button=>button.text==='Далее →');
        await callback(101,next.callback_data);assert.equal(calls.at(-1).offset,8);
        const previous=messages.at(-1).data.reply_markup.inline_keyboard.flat().find(button=>button.text==='← Назад');
        await callback(101,previous.callback_data);assert.equal(calls.at(-1).offset,0);
        const before=calls.length;await bot.dispatch(ctx,a,'list',{id:foreign.id});assert.equal(calls.length,before);assert(messages.at(-1).data.text.includes('Список недоступен'));
        const unread=await store.createList(a.id,'Unread','private',{title:'Книга',unreadOnly:true});
        worker.getPersonalReadBookSet=()=>({has:()=>true});calls.length=0;
        await bot.dispatch(ctx,a,'list',{id:unread.id});assert.equal(calls.reduce((sum,query)=>sum+query.limit,0),200);
        assert(messages.at(-1).data.reply_markup.inline_keyboard.flat().some(button=>button.text==='Далее →'),'A bounded unread scan offers continuation');
    });
}
async function testTelegramBotFollowingPagesDoNotRepeatExpensiveRefresh() {
    await fixture(async({a,bot,worker,messages,link,callback})=>{
        await link(a,101);const refreshes=[];
        worker.libraryFollows={list:async(id,refresh)=>{refreshes.push(refresh);return {follows:[],books:Array.from({length:20},(_,i)=>({_uid:'n'+i,title:'Новинка '+i}))};}};
        const ctx={run:bot.run,chatId:'101',userId:a.id};await bot.dispatch(ctx,a,'following');
        for(let i=0;i<2;i++){
            const next=messages.at(-1).data.reply_markup.inline_keyboard.flat().find(button=>button.text==='Далее →');assert(next);await callback(101,next.callback_data);
        }
        assert.deepEqual(refreshes,[true,false,false]);assert(messages.at(-1).data.text.includes('Страница 3 из 3'));
        assert(messages.at(-1).data.reply_markup.inline_keyboard.flat().some(button=>button.text==='Новинка 19'));
    });
}
module.exports = {testTelegramBotPairingIsolationExpiryAndRestart, testTelegramBotSearchFormatsPrivateListsAndRevocation,
    testTelegramBotDigestIsOptInAndBounded, testTelegramBotPollingResumesOffsetAndPreservesWebhook,
    testTelegramBotApiSanitizesFailuresAndHonorsCancellation, testTelegramBotUsesProfileFormatAndThrottlesPerChat,
    testTelegramBotConfiguredChatNeedsNoLinkAndRevokesOldIdentity,testTelegramBotConfiguredChatCannotOverrideVerifiedProfile,
    testTelegramBotSearchIsPagedAndDoesNotUseAutocomplete,testTelegramBotSmartShelvesAreBoundedAndPrivate,
    testTelegramBotFollowingPagesDoNotRepeatExpensiveRefresh};
if (require.main === module) (async() => {for (const test of Object.values(module.exports)) {await test(); console.log(test.name + ': OK');}})().catch(error => {console.error(error); process.exitCode = 1;});
