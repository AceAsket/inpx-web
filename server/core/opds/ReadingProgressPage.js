const BasePage = require('./BasePage');

class ReadingProgressPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-progress';
        this.title = 'Моё чтение';
    }

    stateTitle(state = 'reading') {
        switch (state) {
            case 'read':
                return 'Прочитано';
            case 'hidden':
                return 'Скрыто';
            case 'all':
                return 'Все книги профиля';
            case 'reading':
            default:
                return 'Продолжить чтение';
        }
    }

    stateDescription(state = 'reading') {
        switch (state) {
            case 'read':
                return 'Книги, отмеченные прочитанными';
            case 'hidden':
                return 'Книги, скрытые из текущего чтения';
            case 'all':
                return 'Все книги с личным прогрессом профиля';
            case 'reading':
            default:
                return 'Книги, которые сейчас читаются';
        }
    }

    myEntry(req = null, state = 'reading', count = 0) {
        const title = this.stateTitle(state);
        return this.makeEntry({
            id: `${this.id}-${state}`,
            title,
            link: this.navLink({href: `/${this.id}`, req, query: {state}}),
            content: {
                '*ATTRS': {type: 'text'},
                '*TEXT': count ? `${count} книг` : this.stateDescription(state),
            },
        });
    }

    async body(req) {
        const state = String(req.query.state || 'reading').trim();
        const userId = this.getScopeUserId(req);
        if (!userId)
            throw new Error('user is empty');

        const response = await this.webWorker.getOpdsUserReadingLibrary(userId, {
            state,
            sort: state === 'read' ? 'updatedDesc' : 'updatedDesc',
            limit: 300,
        });
        const result = {};
        const entry = [];

        this.title = this.stateTitle(response.state);

        for (const book of response.items || []) {
            const percent = Math.max(0, Math.min(100, Math.round((Number(book.percent || 0) || 0) * 100)));
            const title = `${book.state === 'read' ? '✓ ' : ''}${book.serno ? `${book.serno}. ` : ''}${book.title || 'Без названия'} (${book.ext})`;
            const subtitle = [
                this.bookAuthor(book.author),
                book.series ? `Серия: ${book.series}` : '',
                `${percent}%`,
                book.hidden ? 'Скрыто' : '',
            ].filter(Boolean).join(' · ');

            entry.push(
                this.makeEntry({
                    id: book.bookUid,
                    title,
                    link: this.acqLink({href: `/book?uid=${encodeURIComponent(book.bookUid)}`, req}),
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
                    title: '[Книг пока нет]',
                    link: this.navLink({href: `/${this.id}`, req, query: {state: response.state}}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': this.stateDescription(response.state),
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingProgressPage;
