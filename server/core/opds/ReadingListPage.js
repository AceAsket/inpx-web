const BasePage = require('./BasePage');

class ReadingListPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-list';
        this.title = 'Список чтения';
    }

    async body(req) {
        const listId = req.query.id || '';
        if (!listId)
            throw new Error('listId is empty');

        const {list, books} = await this.webWorker.getReadingList(listId);
        const result = {};
        const entry = [];

        this.title = list.name;

        for (const book of books) {
            const title = `${book._readingListRead ? '✓ ' : ''}${book.serno ? `${book.serno}. ` : ''}${book.title || 'Без названия'} (${book.ext})`;
            const subtitle = [
                this.bookAuthor(book.author),
                book.series ? `Серия: ${book.series}` : '',
                book._readingListRead ? 'Прочитано' : 'Не прочитано',
            ].filter(Boolean).join(' · ');

            entry.push(
                this.makeEntry({
                    id: book._uid,
                    title,
                    link: this.acqLink({href: `/book?uid=${encodeURIComponent(book._uid)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': subtitle,
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: '[Список пуст]',
                    link: this.navLink({href: `/reading-lists`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Добавьте книги в этот список через веб-интерфейс',
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingListPage;
