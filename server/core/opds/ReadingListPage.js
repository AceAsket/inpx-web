const BasePage = require('./BasePage');
const shelfData = require('./ShelfPageData');

class ReadingListPage extends BasePage {
    constructor(config) {
        super(config);
        this.id = 'reading-list';
        this.title = 'Список чтения';
    }

    async body(req) {
        const userId = this.getScopeUserId(req), listId = String(req.query.id || '');
        if (!userId || !listId) throw new Error('Укажите профиль и список');
        const {list, books} = await shelfData.load(this.webWorker, userId, listId);
        const page = shelfData.page(books, list.opds, req.query);
        const entry = [];
        const href = query => this.scopedHref(this.opdsRoot + '/reading-lists/list', req, {id:listId, group:page.group, ...query});
        for (const book of page.entries) {
            if (book.group !== undefined) {
                entry.push(this.makeEntry({id:'group:' + book.group, title:book.group + ' (' + book.count + ')',
                    link:this.navLink({href:href({group:book.group}), hrefAsIs:true, req})}));
                continue;
            }
            const title = [book._readingListRead ? '✓' : '', book.serno ? book.serno + '.' : '', book.title || 'Без названия', '(' + book.ext + ')'].filter(Boolean).join(' ');
            entry.push(this.makeEntry({id:book._uid, title,
                link:this.acqLink({href:'/book?uid=' + encodeURIComponent(book._uid), req}),
                content:{'*ATTRS':{type:'text'}, '*TEXT':this.escape([book.author || '', book.series ? 'Серия: ' + book.series : '',
                    book._readingListRead ? 'Прочитано' : 'Не прочитано'].filter(Boolean).join(' · '))}}));
        }
        const links = this.baseLinks(req, true);
        const navigation = [[page.previous, page.number - 1, 'previous', 'Предыдущая страница'], [page.next, page.number + 1, 'next', 'Следующая страница']];
        for (const [enabled, number, rel, title] of navigation) {
            if (!enabled) continue;
            const link = this.navLink({href:href({page:number}), hrefAsIs:true, req, rel});
            links.push(link);
            entry.push(this.makeEntry({id:rel, title:'[' + title + ']', link}));
        }
        if (page.group) entry.unshift(this.makeEntry({id:'groups', title:'[Все группы]', link:this.navLink({href:href({group:''}), hrefAsIs:true, req})}));
        if (!entry.length) entry.push(this.makeEntry({id:'empty', title:'[Список пуст]', link:this.navLink({href:'/reading-lists', req})}));
        return this.makeBody({title:this.escape(list.name + (page.group ? ' — ' + page.group : '')), entry, link:links}, req);
    }
}

module.exports = ReadingListPage;
