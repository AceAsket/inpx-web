const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const {setTimeout: delay} = require('timers/promises');
const {withFileTransaction, writeFileAtomic} = require('./FilePersistence');
const bookFormats = require('../../shared/BookFormats');
const {escapeHtml} = require('../../shared/safeHtml');
const shelfData = require('./EbookShelves');
const PAGE_SIZE = 8;
const pageNumber = value => Math.min(100000, Math.max(1, Math.floor(Number(value) || 1)));
const short = (value, length = 100) => Array.from(String(value || '')).slice(0, length).join('');
const html = value => escapeHtml(short(value, 500));
const privateChat = update => {
    const message = update.message || update.callback_query?.message, from = update.message?.from || update.callback_query?.from;
    if (message?.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id) || message.chat.id <= 0
        || from?.id !== message.chat.id || from?.is_bot) return null;
    return {chatId: String(message.chat.id), messageId: update.callback_query ? message.message_id : null};
};

class TelegramBot {
    constructor(worker, options = {}) {
        this.worker = worker; this.config = worker.config; this.now = options.now || Date.now;
        this.apiFactory = options.apiFactory || ((config, token) => new (require('./TelegramBotApi'))(config, token));
        this.sleep = options.sleep || ((milliseconds, signal) => delay(milliseconds, undefined, {signal}));
        this.offsetFile = path.join(this.config.dataDir, 'telegram-bot-state.json');
        this.pairs = new Map(); this.callbacks = new Map(); this.rates = new Map(); this.outbound = new Map(); this.deliveries = new Map();
        this.deliveryReservations = new Set();
        this.health = {state: 'disabled', error: '', username: '', lastPollAt: ''};
    }
    enabled() {return this.config.telegramBotEnabled === true && this.config.telegramShareEnabled === true && !!this.config.telegramBotToken;}
    status() {return {...this.health, enabled: this.enabled()};}
    configure() {
        const signature = JSON.stringify([this.enabled(), this.config.telegramBotToken, require('./TelegramTransport').signature(this.config)]);
        if (signature === this.signature) return;
        this.signature = signature; this.stop(); this.pairs.clear(); this.callbacks.clear();
        if (!this.enabled()) {this.health = {state: 'disabled', error: '', username: '', lastPollAt: ''}; return;}
        const run = {controller: new AbortController(), api: this.apiFactory(this.config, this.config.telegramBotToken)};
        this.run = run; this.health = {state: 'connecting', error: '', username: '', lastPollAt: ''};
        this.task = (this.task || Promise.resolve()).catch(() => {}).then(() => this.loop(run));
        this.task.catch(() => {});
    }
    stop() {this.run?.controller.abort(new Error('Telegram остановлен')); this.run = null;}
    prune(map, maximum) {
        for (const [key, value] of map) if (value.expiresAt <= this.now()) map.delete(key);
        while (map.size >= maximum) map.delete(map.keys().next().value);
    }
    rate(chatId, kind, maximum) {
        this.prune(this.rates, 1000);
        const key = `${chatId}:${kind}`, value = this.rates.get(key) || {count: 0, expiresAt: this.now() + 60000};
        if (value.count >= maximum) return false;
        value.count++; this.rates.set(key, value); return true;
    }
    async account(user, operation, options = {}) {
        if (user.id === 'default' && !user.login) throw new Error('Войдите в личный профиль');
        if (operation === 'unlink') {
            await this.worker.readingListStore.changeTelegramBinding(user.id, 'unlink');
            this.cancelDeliveries(user.id);
            for (const [key, value] of this.pairs) if (value.userId === user.id) this.pairs.delete(key);
        } else if (operation === 'digest') {
            if(this.run?.botId&&user.telegramChatId)await this.worker.readingListStore.findTelegramUser(this.run.botId,user.telegramChatId);
            await this.worker.readingListStore.changeTelegramBinding(user.id, 'digest', {enabled: options.enabled});
        } else if (operation === 'link') {
            if (!this.enabled() || !this.run?.botId || !this.run?.username) throw new Error('Бот ещё не подключён. Проверьте настройки Telegram у администратора');
            if (!this.rate(user.id, 'pair', 5)) throw new Error('Слишком много запросов. Повторите через минуту');
            this.prune(this.pairs, 1000);
            for (const [key, value] of this.pairs) if (value.userId === user.id) this.pairs.delete(key);
            const token = crypto.randomBytes(24).toString('base64url'), expiresAt = this.now() + 10 * 60000;
            this.pairs.set(crypto.createHash('sha256').update(token).digest('hex'), {userId: user.id, botId: this.run.botId, expiresAt});
            return {url: `https://t.me/${this.run.username}?start=link_${token}`, expiresAt: new Date(expiresAt).toISOString()};
        } else if (operation !== 'status') throw new Error('Неизвестное действие Telegram');
        let fresh = (await this.worker.readingListStore.load()).users.find(row => row.id === user.id);
        if (!fresh) throw new Error('Профиль удалён');
        const binding = this.run?.botId ? await this.worker.readingListStore.findTelegramUser(this.run.botId,fresh.telegramBotChatId||fresh.telegramChatId) : null;
        const linked = this.run?.botId ? binding?.id===fresh.id : !!fresh.telegramBotLinkedAt&&!fresh.telegramBotBlocked;
        if(binding?.id===fresh.id)fresh=binding;
        return {enabled: this.enabled(), state: this.health.state, username: this.health.username,
            linked, bindingSource:linked ? (fresh.telegramBotAutoLinked?'configured':'link'):'',
            chatId: fresh.telegramBotChatId, linkedAt: fresh.telegramBotLinkedAt, digest: fresh.telegramDigest};
    }
    async loop(run) {
        const signal = run.controller.signal; let failures = 0, offset = 0;
        while (this.run === run && !signal.aborted) {
            try {
                if (!run.botId) {
                    const me = await run.api.call('getMe', {}, signal);
                    if (!Number.isSafeInteger(me.id) || !/^[A-Za-z0-9_]{5,32}$/.test(me.username || '')) throw new Error('Telegram вернул некорректное имя бота');
                    const webhook = await run.api.call('getWebhookInfo', {}, signal);
                    if (webhook.url) throw new Error('У бота настроен webhook. Для работы inpx-web нужен отдельный бот без webhook');
                    let state;
                    try {state = await fs.readJson(this.offsetFile);} catch (e) {if (e.code !== 'ENOENT') throw e; state = {};}
                    offset = state.botId === String(me.id) && Number.isSafeInteger(state.offset) && state.offset >= 0 ? state.offset : 0;
                    run.botId = String(me.id); run.username = me.username;
                    this.health.username = me.username;
                    await run.api.call('setMyCommands', {commands: [
                        ['help', 'Помощь'], ['search', 'Поиск книг'], ['reading', 'Сейчас читаю'], ['lists', 'Мои списки'],
                        ['favorites', 'Избранные авторы и серии'], ['following', 'Новое у любимых'], ['unlink', 'Отключить профиль'],
                    ].map(([command, description]) => ({command, description}))}, signal);
                }
                const updates = await run.api.call('getUpdates', {offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query']}, signal, 35000);
                if (!Array.isArray(updates)) throw new Error('Некорректный ответ Telegram');
                // Per-chat ordering, at most four chats in flight; one conversion cannot block the entire bot.
                const chats = new Map();
                for (const update of updates) {
                    if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
                    const key = privateChat(update)?.chatId || 'ignored';
                    if (!chats.has(key)) chats.set(key, []); chats.get(key).push(update);
                }
                const groups = [...chats.values()]; let next = 0;
                await Promise.all(Array.from({length: Math.min(4, groups.length)}, async() => {
                    while (next < groups.length && !signal.aborted) for (const update of groups[next++]) await this.handle(run, update);
                }));
                if (signal.aborted) break;
                const ids = updates.map(update => update.update_id).filter(Number.isSafeInteger);
                if (ids.length) {
                    offset = Math.max(offset, ...ids.map(id => id + 1));
                    await withFileTransaction(this.offsetFile, () => writeFileAtomic(this.offsetFile, JSON.stringify({version: 1, botId: run.botId, offset})));
                }
                failures = 0; this.health.state = 'running'; this.health.error = ''; this.health.lastPollAt = new Date(this.now()).toISOString();
                if (this.now() - (this.digestCheckedAt || 0) > 3600000 && !this.digestTask) {
                    this.digestCheckedAt = this.now();
                    this.digestTask = this.digest(run).catch(() => {}).finally(() => {this.digestTask = null;});
                }
            } catch (error) {
                if (signal.aborted || this.run !== run) break;
                const message = short(error.message, 240);
                if (this.health.error !== message || this.now() - (this.loggedAt || 0) > 300000) {
                    this.worker.addAdminEvent('warn', 'telegram', `Интерактивный бот: ${message}`); this.loggedAt = this.now();
                }
                this.health.state = 'error'; this.health.error = message;
                await delay(Math.max(error.retryAfter || 0, Math.min(60, 2 ** Math.min(++failures, 6))) * 1000, undefined, {signal}).catch(() => {});
            }
        }
    }
    async authorize(ctx) {
        if (this.run !== ctx.run || ctx.run.controller.signal.aborted) throw new Error('Telegram остановлен');
        const user = await this.worker.readingListStore.findTelegramUser(ctx.run.botId, ctx.chatId);
        if (this.run !== ctx.run || ctx.run.controller.signal.aborted) throw new Error('Telegram остановлен');
        if (!user || ctx.userId && user.id !== ctx.userId) throw new Error('Привязка Telegram отключена');
        return user;
    }
    button(ctx, text, action, payload = {}) {
        this.prune(this.callbacks, 2000);
        const key = crypto.randomBytes(12).toString('base64url');
        this.callbacks.set(key, {action, payload, userId: ctx.userId, chatId: ctx.chatId,
            generation: this.worker.libraryAssetGeneration, expiresAt: this.now() + 15 * 60000});
        return {text: short(text, 54), callback_data: `c:${key}`};
    }
    menu(ctx) {return [this.button(ctx, '🔎 Поиск', 'help'), this.button(ctx, '📚 Мои списки', 'lists')];}
    async throttle(ctx) {
        this.prune(this.outbound, 1000);
        const now = this.now(), chat = this.outbound.get(ctx.chatId);
        const at = Math.max(now, Math.min(now + 30000, chat?.at || 0), Math.min(now + 30000, this.nextMessageAt || 0));
        this.outbound.set(ctx.chatId, {at: at + 1050, expiresAt: at + 60000}); this.nextMessageAt = at + 40;
        if (at > now) await this.sleep(at - now, ctx.run.controller.signal);
    }
    async reply(ctx, text, rows = []) {
        await this.throttle(ctx);
        if (ctx.userId) await this.authorize(ctx);
        const payload = {chat_id: ctx.chatId, text: short(text, 3800), parse_mode: 'HTML', link_preview_options: {is_disabled: true}, reply_markup: {inline_keyboard: rows}};
        if (ctx.messageId) {
            try {return await ctx.run.api.call('editMessageText', {...payload, message_id: ctx.messageId}, ctx.run.controller.signal);}
            catch (e) {if (e.message.includes('message is not modified')) return; if (![400, 403].includes(e.status)) throw e;}
        }
        return ctx.run.api.call('sendMessage', payload, ctx.run.controller.signal);
    }
    async handle(run, update) {
        const identity = privateChat(update);
        if (!identity || this.run !== run) return;
        const ctx = {...identity, run};
        const callback = update.callback_query;
        try {
            if (callback) await run.api.call('answerCallbackQuery', {callback_query_id: callback.id}, run.controller.signal);
            if (!this.rate(ctx.chatId, 'message', 20)) return;
            const message = String(update.message?.text || '').trim();
            const link = /^\/start(?:@[A-Za-z0-9_]+)? link_([A-Za-z0-9_-]{32})$/.exec(message);
            if (link) {
                if (!this.rate(ctx.chatId, 'pair-input', 3)) return;
                const key = crypto.createHash('sha256').update(link[1]).digest('hex'), pair = this.pairs.get(key);
                this.pairs.delete(key);
                if (!pair || pair.expiresAt <= this.now() || pair.botId !== run.botId)
                    return await this.reply(ctx, 'Ссылка недействительна или истекла. Создайте новую ссылку в своём профиле inpx-web.');
                const previous=(await this.worker.readingListStore.load()).users.filter(user=>user.id!==pair.userId
                    &&user.telegramBotId===run.botId&&user.telegramBotChatId===ctx.chatId&&user.telegramBotLinkedAt).map(user=>user.id);
                await this.worker.readingListStore.changeTelegramBinding(pair.userId, 'link', {botId: run.botId, chatId: ctx.chatId});
                previous.forEach(userId=>this.cancelDeliveries(userId));
                ctx.userId = pair.userId;
                return await this.reply(ctx, 'Профиль подключён. Отправьте название книги, имя автора или серии. Команда /help покажет все возможности.', [this.menu(ctx)]);
            }
            const user = await this.worker.readingListStore.findTelegramUser(run.botId, ctx.chatId);
            if (!user) {
                if (!this.rate(ctx.chatId, 'unknown', 2)) return;
                return await this.reply(ctx, 'Укажите личный Chat ID в настройках своего профиля inpx-web или откройте Telegram-бот → «Подключить Telegram». Один чат должен соответствовать одному профилю. Пароль в чат отправлять не нужно.');
            }
            ctx.userId = user.id;
            if (callback) {
                const key = /^c:([A-Za-z0-9_-]{16})$/.exec(String(callback.data || ''))?.[1], action = key && this.callbacks.get(key);
                if (!action || action.expiresAt <= this.now() || action.userId !== user.id || action.chatId !== ctx.chatId
                    || action.generation !== this.worker.libraryAssetGeneration)
                    return await this.reply(ctx, 'Кнопки устарели. Отправьте запрос заново или используйте /help.');
                if (['download', 'read', 'save', 'unlink'].includes(action.action)) this.callbacks.delete(key);
                return await this.dispatch(ctx, user, action.action, action.payload);
            }
            const [command, ...rest] = message.split(/\s+/), argument = rest.join(' ');
            const name = command.replace(/@[A-Za-z0-9_]+$/, '').toLowerCase();
            if (name === '/unlink') return await this.reply(ctx, 'Отключить этот Telegram от профиля?', [[this.button(ctx, 'Отключить', 'unlink')], this.menu(ctx)]);
            if (['/help', '/start'].includes(name)) return await this.dispatch(ctx, user, 'help');
            if (name === '/reading') return await this.dispatch(ctx, user, 'reading');
            if (name === '/lists' || name === '/want') return await this.dispatch(ctx, user, 'lists');
            if (name === '/favorites') return await this.dispatch(ctx, user, 'favorites');
            if (name === '/following') return await this.dispatch(ctx, user, 'following');
            const query = name === '/search' ? argument : message;
            if (!query || Array.from(query).length > 120 || query.startsWith('/')) return await this.reply(ctx, 'Введите название, автора или серию (до 120 символов). Например: /search Косточка');
            return await this.dispatch(ctx, user, 'search', {query});
        } catch (error) {
            if (run.controller.signal.aborted) return;
            this.worker.addAdminEvent('warn', 'telegram', `Действие бота не выполнено: ${short(error.message, 240)}`);
            try {await run.api.call('sendMessage', {chat_id: ctx.chatId, text: 'Не удалось выполнить действие. Проверьте привязку профиля или повторите запрос позже.'}, run.controller.signal);} catch { /* Polling reports persistent connectivity failures. */ }
        }
    }
    async dispatch(ctx, user, action, payload = {}) {
        user = await this.authorize(ctx);
        const button = (label, action, data) => this.button(ctx, label, action, data);
        if (action === 'unlink') {
            await this.worker.readingListStore.changeTelegramBinding(user.id, 'unlink');
            this.cancelDeliveries(user.id);
            ctx.userId = ''; return this.reply(ctx, 'Telegram отключён от профиля. Подключить его снова можно на сайте.');
        }
        if (action === 'help') return this.reply(ctx, `<b>INPX Web</b> · ${html(user.name)}\n\nОтправьте название, автора или серию.\n/search запрос — поиск\n/reading — сейчас читаю\n/lists — личные списки\n/favorites — избранные авторы и серии\n/following — новые книги подписок\n/unlink — отключить профиль`, [this.menu(ctx)]);
        if (action === 'search') {
            const query = short(payload.query,120).trim(), kind = ['author','series'].includes(payload.kind) ? payload.kind : 'title';
            // Chat messages are submitted searches, not autocomplete. Keep short
            // titles searchable and use ordinary indexed words, never regex input.
            const words = require('../../shared/CatalogSearch').words(query).join(' ');
            if (!words) return this.reply(ctx,'Введите название, автора или серию.',[this.menu(ctx)]);
            let page = pageNumber(payload.page);
            const search = () => this.worker.bookSearch({[kind]:words,del:'0',limit:PAGE_SIZE,offset:(page-1)*PAGE_SIZE});
            let result = await search();
            const totalPages = Math.max(1,Math.ceil(result.totalFound/PAGE_SIZE));
            if (page > totalPages) {page = totalPages;result = await search();}
            const rows = result.found.map(book => [button(book.title,'book',{uid:book._uid})]);
            const pages = [];
            if (page > 1) pages.push(button('← Назад','search',{query,kind,page:page-1}));
            if (page < totalPages) pages.push(button('Далее →','search',{query,kind,page:page+1}));
            if (pages.length) rows.push(pages);
            const labels = {title:'По названию',author:'По автору',series:'По серии'};
            rows.push(Object.entries(labels).map(([field,label]) => button((field===kind?'✓ ':'')+label,'search',{query,kind:field,page:1})));
            return this.reply(ctx,`<b>Поиск: ${html(query)}</b>\n${labels[kind]} · Найдено: ${result.totalFound}\n${result.totalFound ? `Страница ${page} из ${totalPages}` : 'Ничего не найдено. Попробуйте другие слова.'}`,[...rows,this.menu(ctx)]);
        }
        if (action === 'entity') {
            const result = await this.worker.getCatalogDiscovery().entity({...payload, limit: PAGE_SIZE}, user);
            const rows = result.books.map(book => [button(`${book.serno ? book.serno + '. ' : ''}${book.title}`, 'book', {uid: book._uid})]);
            const pages = [];
            if (result.page > 1) pages.push(button('← Назад', 'entity', {...payload, page: result.page - 1}));
            if (result.page < result.pageCount) pages.push(button('Далее →', 'entity', {...payload, page: result.page + 1}));
            if (pages.length) rows.push(pages);
            return this.reply(ctx, `<b>${html(result.name)}</b>\nКниг: ${result.total} · Прочитано: ${result.read}\nСтраница ${result.page} из ${result.pageCount}`, [...rows, this.menu(ctx)]);
        }
        if (action === 'book') {
            const book = await this.worker.getBookRecordByUid(payload.uid);
            if (!book || book.del) return this.reply(ctx, 'Книга сейчас недоступна. Повторите поиск.', [this.menu(ctx)]);
            const preferred = bookFormats.resolve(book.ext, this.config, bookFormats.preference(user, 'telegram')) || 'raw';
            const extension = String(preferred === 'raw' ? book.ext || '' : preferred).toUpperCase();
            const label = extension ? `Получить ${extension}` : 'Получить файл';
            const rows = [[button(label, 'download', {uid: book._uid, format: preferred})]];
            if (preferred !== 'raw') rows.push([button('Оригинал ' + String(book.ext).toUpperCase(), 'download', {uid: book._uid, format: 'raw'})]);
            const formats = bookFormats.available(book.ext, this.config).filter(format => format !== preferred);
            for (let i = 0; i < formats.length; i += 3) rows.push(formats.slice(i, i + 3).map(format => button(format.toUpperCase(), 'download', {uid: book._uid, format})));
            rows.push([button('Хочу прочитать', 'save', {uid: book._uid}), button('Прочитано', 'read', {uid: book._uid})]);
            if (book.series) rows.push([button(`Серия: ${book.series}`, 'entity', {kind: 'series', name: book.series})]);
            return this.reply(ctx, `<b>${html(book.title)}</b>\n${html(book.author)}\n${book.series ? `${html(book.series)}${book.serno ? ' · ' + Number(book.serno) : ''}\n` : ''}${html(String(book.ext).toUpperCase())}${book.size > 0 ? ` · ${(book.size / 1048576).toFixed(1)} МБ` : ''}`, [...rows, this.menu(ctx)]);
        }
        if (action === 'download') {
            if (this.deliveries.has(ctx.chatId) || this.deliveryReservations.has(ctx.chatId)) return this.reply(ctx, 'Для вашего чата уже готовится книга. Дождитесь отправки.', [this.menu(ctx)]);
            if (this.deliveries.size + this.deliveryReservations.size >= 4) return this.reply(ctx, 'Сейчас готовятся другие книги. Повторите запрос немного позже.', [this.menu(ctx)]);
            if (!this.rate(ctx.chatId, 'download', 3)) return this.reply(ctx, 'Можно отправить до трёх книг за минуту. Повторите немного позже.', [this.menu(ctx)]);
            this.deliveryReservations.add(ctx.chatId);
            try {await this.reply(ctx, 'Готовим книгу к отправке…', [this.menu(ctx)]); this.startDelivery(ctx, user, payload);}
            finally {this.deliveryReservations.delete(ctx.chatId);}
            return;
        }
        if (action === 'read') {
            await this.worker.markReaderBooksRead(user.id, [payload.uid], true);
            require('./ReaderEvents').emit('change', {userId: user.id, bookUid: payload.uid});
            return this.reply(ctx, 'Книга отмечена прочитанной.', [this.menu(ctx)]);
        }
        if (action === 'save') {
            await withFileTransaction(this.worker.readingListStore.file, async() => {
                await this.authorize(ctx);
                const data = await this.worker.readingListStore.load();
                let list = data.lists.find(list => list.userId === user.id && list.name.toLowerCase() === 'хочу прочитать');
                if (!list) list = (await this.worker.createReadingList(user.id, 'Хочу прочитать')).list;
                await this.worker.updateReadingListBook(user.id, list.id, payload.uid, true);
            });
            return this.reply(ctx, 'Добавлено в список «Хочу прочитать».', [this.menu(ctx)]);
        }
        if (action === 'lists') {
            const lists = (await shelfData.lists(this.worker,user.id)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
            const page = Math.min(pageNumber(payload.page),Math.max(1,Math.ceil(lists.length/PAGE_SIZE))), slice = lists.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
            const rows = slice.map(list => [button(`${list.name} (${list.smart ? 'умная полка' : list.bookCount})`, 'list', {id: list.id})]);
            const pages = [];
            if (page > 1) pages.push(button('← Назад', 'lists', {page: page - 1}));
            if (page * PAGE_SIZE < lists.length) pages.push(button('Далее →', 'lists', {page: page + 1}));
            if (pages.length) rows.push(pages);
            return this.reply(ctx, lists.length ? '<b>Ваши списки</b>' : 'Личных списков пока нет. Их можно создать на сайте или кнопкой «Хочу прочитать» у книги.', [...rows, this.menu(ctx)]);
        }
        if (action === 'list') {
            const cursor = Math.min(10000000,Math.max(0,Math.floor(Number(payload.cursor)||0)));
            const trail = (Array.isArray(payload.trail)?payload.trail:[]).filter(value=>Number.isSafeInteger(value)&&value>=0&&value<cursor).slice(-20);
            let result;
            try {result = await shelfData.page(this.worker,user,payload.id,{offset:cursor,size:PAGE_SIZE});}
            catch (error) {if (error.status===404) return this.reply(ctx,'Список недоступен.',[this.menu(ctx)]);throw error;}
            const visible = result.books.filter(book=>!book.unavailable&&!book.del);
            const rows = visible.map(book=>[button(book.title,'book',{uid:book._uid})]);
            const pages = [];
            if (cursor) pages.push(button(trail.length?'← Назад':'К началу','list',{id:payload.id,cursor:trail.at(-1)||0,trail:trail.slice(0,-1)}));
            if (result.next!==null) pages.push(button('Далее →','list',{id:payload.id,cursor:result.next,trail:[...trail,cursor].slice(-20)}));
            if (pages.length) rows.push(pages);
            const message = visible.length ? `Показано книг: ${visible.length}`
                : result.next!==null ? 'В этой части полки подходящих книг нет. Продолжите просмотр.' : 'Доступных книг пока нет.';
            return this.reply(ctx,`<b>${html(result.name)}</b>\n${message}`,[...rows,this.menu(ctx)]);
        }
        if (action === 'reading') {
            const title = 'Сейчас читаю';
            const uids = Object.entries(user.readerProgress || {}).filter(([, progress]) => !progress.hidden && !progress.relinkedTo && Number(progress.percent) < .999)
                .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt))).map(([uid]) => uid);
            const totalPages = Math.max(1, Math.ceil(uids.length / PAGE_SIZE)), page = Math.min(totalPages, Math.max(1, Math.floor(Number(payload.page) || 1)));
            const slice = uids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), db = this.worker.db;
            const books = slice.length ? await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(slice)})`}) : [];
            const byUid = new Map(books.map(book => [book._uid, book]));
            const rows = slice.filter(uid => byUid.has(uid)).map(uid => [button(byUid.get(uid).title, 'book', {uid})]);
            const pages = [];
            if (page > 1) pages.push(button('← Назад', action, {...payload, page: page - 1}));
            if (page < totalPages) pages.push(button('Далее →', action, {...payload, page: page + 1}));
            if (pages.length) rows.push(pages);
            return this.reply(ctx, `<b>${html(title)}</b>\n${uids.length ? `Страница ${page} из ${totalPages}` : 'Книг пока нет.'}`, [...rows, this.menu(ctx)]);
        }
        if (action === 'favorites' || action === 'following') {
            const refresh = action === 'following' && payload.page === undefined;
            if (refresh && !this.rate(ctx.chatId, 'following', 2)) return this.reply(ctx, 'Подождите минуту перед повторной проверкой новинок.', [this.menu(ctx)]);
            const follows = this.worker.libraryFollows || (this.worker.libraryFollows = new (require('./LibraryFollows'))(this.worker));
            const result = await follows.list(user.id, refresh);
            const totalPages = Math.max(1,Math.ceil(result.books.length/PAGE_SIZE)),page = Math.min(pageNumber(payload.page),totalPages);
            const rows = action === 'favorites' ? result.follows.map(follow => [button(follow.value, 'entity', {kind: follow.kind, name: follow.value})])
                : result.books.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).map(book => [button(book.title, 'book', {uid: book._uid})]);
            if (action === 'following') {
                const pages = [];
                if (page>1) pages.push(button('← Назад','following',{page:page-1}));
                if (page<totalPages) pages.push(button('Далее →','following',{page:page+1}));
                if (pages.length) rows.push(pages);
            }
            return this.reply(ctx, action === 'favorites' ? '<b>Избранные авторы и серии</b>' : `<b>Новое у любимых</b>\n${result.books.length ? `Найдено: ${result.books.length} · Страница ${page} из ${totalPages}${result.truncated ? '\nПоказаны первые 200 совпадений.' : ''}` : 'Новых книг пока нет.'}`, [...rows, this.menu(ctx)]);
        }
        throw new Error('Неизвестная команда бота');
    }
    startDelivery(ctx, user, payload) {
        const controller = new AbortController(), signal = AbortSignal.any([ctx.run.controller.signal, controller.signal]);
        const job = {userId: user.id, controller};
        const runtime = require('./ResourceRuntime');
        job.promise = runtime.withSignal(signal, () => this.worker.sendBookToTelegram(payload.uid, payload.format, user.id,
            {chatId: ctx.chatId, signal, authorize: () => this.authorize(ctx), beforeSend: () => this.throttle(ctx)}))
            .catch(async error => {
                if (signal.aborted) return;
                this.worker.addAdminEvent('warn', 'telegram', `Книга не отправлена: ${short(error.message, 240)}`);
                try {await this.reply({...ctx, messageId: null}, 'Не удалось отправить книгу. Проверьте размер и формат файла или повторите позже.', [this.menu(ctx)]);} catch { /* The binding or connection may have been revoked. */ }
            }).finally(() => {if (this.deliveries.get(ctx.chatId) === job) this.deliveries.delete(ctx.chatId);});
        this.deliveries.set(ctx.chatId, job);
        job.promise.catch(() => {});
    }
    cancelDeliveries(userId) {for (const job of this.deliveries.values()) if (job.userId === userId) job.controller.abort(new Error('Привязка Telegram отключена'));}
    async idle() {await Promise.allSettled([...this.deliveries.values()].map(job => job.promise));}
    async digest(run, now = new Date(this.now())) {
        if (now.getDay() !== 1 || now.getHours() < 10 || this.run !== run) return;
        const data = await this.worker.readingListStore.load();
        const follows = this.worker.libraryFollows || (this.worker.libraryFollows = new (require('./LibraryFollows'))(this.worker));
        for (const user of data.users) {
            if (!user.telegramDigest || user.telegramBotId !== run.botId || !user.telegramBotChatId || !user.telegramBotLinkedAt) continue;
            if (user.telegramDigestAt && this.now() - Date.parse(user.telegramDigestAt) < 6 * 86400000) continue;
            const ctx = {run, chatId: user.telegramBotChatId, userId: user.id};
            try {
                const result = await follows.list(user.id, true), seen = new Set(user.telegramDigestSeen || []);
                const books = result.books.filter(book => !seen.has(book._uid)).slice(0, 10);
                if (!books.length) continue;
                if (!(await this.authorize(ctx)).telegramDigest) continue;
                await this.reply(ctx, '<b>Новые книги любимых авторов и серий</b>\nВаша еженедельная подборка.', books.map(book => [this.button(ctx, book.title, 'book', {uid: book._uid})]));
                await this.worker.readingListStore.changeTelegramBinding(user.id, 'digest-sent', {botId: run.botId, chatId: ctx.chatId, uids: books.map(book => book._uid)});
            } catch (e) {if (run.controller.signal.aborted) break; this.worker.addAdminEvent('warn', 'telegram', 'Не удалось отправить еженедельную подборку');}
        }
    }
}
module.exports = TelegramBot;
module.exports.privateChat = privateChat;
