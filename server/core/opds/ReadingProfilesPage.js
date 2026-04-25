const BasePage = require('./BasePage');

class ReadingProfilesPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-profiles';
        this.title = 'Подборки пользователей';
    }

    async body(req) {
        const result = {};
        const entry = [];
        const users = await this.webWorker.getOpdsUsers();

        for (const item of users) {
            entry.push(
                this.makeEntry({
                    id: item.id,
                    title: item.name,
                    link: this.navLink({href: '/root', req, query: {user: item.publicId || item.id}}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': `Списков: ${item.opdsListCount}, в чтении: ${item.opdsProgressCount || 0}`,
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: '[Публичных подборок пока нет]',
                    link: this.navLink({href: `/${this.id}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Включите публикацию списков в профиле и переведите нужные списки в режим OPDS',
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingProfilesPage;
