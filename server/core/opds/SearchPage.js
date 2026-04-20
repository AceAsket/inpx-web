const BasePage = require('./BasePage');
const utils = require('../utils');
const iconv = require('iconv-lite');

class SearchPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'search';
        this.title = 'Поиск';
    }

    async searchBooks(term = '', genre = '') {
        const normalized = String(term || '').trim();
        if (!normalized)
            return [];

        const queries = [
            {title: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
            {series: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
            {author: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
        ];

        const result = [];
        const seen = new Set();

        for (const query of queries) {
            const res = await this.webWorker.bookSearch(query);
            for (const book of (res.found || [])) {
                if (!book || seen.has(book._uid))
                    continue;

                seen.add(book._uid);
                result.push(book);
            }
        }

        return result;
    }

    async body(req) {
        const result = {};

        const query = {
            type: req.query.type || '',
            term: req.query.term || '',
            genre: req.query.genre || '',
            page: parseInt(req.query.page, 10) || 1,
        };

        let entry = [];
        if (query.type) {
            if (query.type == 'title') {
                try {
                    let found = await this.searchBooks(query.term, query.genre);

                    if (!found.length) {
                        const fallbackTerm = iconv.encode(query.term, 'ISO-8859-1').toString();
                        found = await this.searchBooks(fallbackTerm, query.genre);
                    }

                    const page = query.page;
                    const limit = 100;
                    const offset = (page - 1)*limit;
                    const pageItems = found.slice(offset, offset + limit);

                    for (const book of pageItems) {
                        const title = `${book.serno ? `${book.serno}. ` : ''}${book.title || 'Без названия'} (${book.ext})`;
                        const subtitle = [this.bookAuthor(book.author), book.series ? `Серия: ${book.series}` : ''].filter(Boolean).join(' · ');

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

                    if (found.length > offset + pageItems.length) {
                        entry.push(
                            this.makeEntry({
                                id: 'next_page',
                                title: '[Следующая страница]',
                                link: this.navLink({href: `/${this.id}?type=title&term=${encodeURIComponent(query.term)}&genre=${encodeURIComponent(query.genre)}&page=${page + 1}`}),
                            })
                        );
                    }
                } catch(e) {
                    entry.push(
                        this.makeEntry({
                            id: 'error',
                            title: `Ошибка: ${e.message}`,
                            link: this.navLink({href: `/fake-error-link`}),
                        })
                    );
                }
            } else if (['author', 'series'].includes(query.type)) {
                try {
                    const from = query.type;
                    const page = query.page;

                    const limit = 100;
                    const offset = (page - 1)*limit;

                    const searchQuery = {[from]: query.term, genre: query.genre, del: '0', offset, limit};
                    let queryRes = await this.webWorker.search(from, searchQuery);
                    
                    if (queryRes.totalFound === 0) {
                        searchQuery[from] = iconv.encode(query.term, 'ISO-8859-1').toString();
                        queryRes = await this.webWorker.search(from, searchQuery);
                    }

                    const found = queryRes.found;

                    for (let i = 0; i < found.length; i++) {
                        const row = found[i];
                        if (!row.bookCount)
                            continue;

                        entry.push(
                            this.makeEntry({
                                id: row.id,
                                title: `${(from === 'series' ? 'Серия: ' : '')}${from === 'author' ? this.bookAuthor(row[from]) : row[from]}`,
                                link: this.navLink({href: `/${from}?${from}==${encodeURIComponent(row[from])}`}),
                                content: {
                                    '*ATTRS': {type: 'text'},
                                    '*TEXT': `${row.bookCount} книг${utils.wordEnding(row.bookCount, 8)}`,
                                },
                            }),
                        );
                    }

                    if (queryRes.totalFound > offset + found.length) {
                        entry.push(
                            this.makeEntry({
                                id: 'next_page',
                                title: '[Следующая страница]',
                                link: this.navLink({href: `/${this.id}?type=${from}&term=${encodeURIComponent(query.term)}&genre=${encodeURIComponent(query.genre)}&page=${page + 1}`}),
                            })
                        );
                    }
                } catch(e) {
                    entry.push(
                        this.makeEntry({
                            id: 'error',
                            title: `Ошибка: ${e.message}`,
                            link: this.navLink({href: `/fake-error-link`}),
                        })
                    );
                }
            }
        } else {
            entry = [
                this.makeEntry({
                    id: 'search_author',
                    title: 'Поиск авторов',
                    link: this.navLink({href: `/${this.id}?type=author&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Искать по именам авторов',
                    },
                }),
                this.makeEntry({
                    id: 'search_series',
                    title: 'Поиск серий',
                    link: this.navLink({href: `/${this.id}?type=series&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Искать по названиям серий',
                    },
                }),
                this.makeEntry({
                    id: 'search_title',
                    title: 'Поиск книг',
                    link: this.navLink({href: `/${this.id}?type=title&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Искать книги по слову в названии, серии и авторе',
                    },
                }),
                this.makeEntry({
                    id: 'search_genre',
                    title: 'Поиск книг в жанре',
                    link: this.navLink({href: `/genre?from=search&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Искать по названиям книг в выбранном жанре',
                    },
                }),
                this.makeEntry({
                    id: 'search_help',
                    title: '[Памятка по поиску]',
                    link: this.acqLink({href: `/search-help`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': 'Описание формата поискового значения',
                    },
                }),
            ];
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = SearchPage;
