const utils = require('../utils');
const BasePage = require('./BasePage');

class ReadingListsPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-lists';
        this.title = 'Списки чтения';
    }

    async body(req) {
        const result = {};
        const entry = [];

        const response = await this.webWorker.getReadingLists();
        for (const item of response.lists) {
            entry.push(
                this.makeEntry({
                    id: item.id,
                    title: item.name,
                    link: this.navLink({href: `/${this.id}/list?id=${encodeURIComponent(item.id)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': `${item.readCount || 0}/${item.bookCount} книг${utils.wordEnding(item.bookCount, 8)} прочитано`,
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: '[Списков пока нет]',
                    link: this.navLink({href: `/${this.id}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Создайте список чтения в веб-интерфейсе, и он появится здесь',
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingListsPage;
