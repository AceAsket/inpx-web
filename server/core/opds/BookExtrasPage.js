const BasePage = require('./BasePage');
const {safeHtml} = require('../../../shared/safeHtml');

class BookExtrasPage extends BasePage {
    constructor(config, kind) {
        super(config);
        this.kind = kind;
        this.id = `book-${kind}`;
        this.title = kind === 'reviews' ? 'Отзывы' : 'Об авторах';
    }

    async body(req) {
        const uid = String(req.query.uid || '');
        const book = uid && await this.webWorker.getBookRecordByUid(uid);
        if (!book) throw Object.assign(new Error('Книга не найдена'), {status:404});
        const entry = [];
        if (this.kind === 'reviews') {
            const reviews = await this.webWorker.getBookReviews(book);
            const number = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
            for (const [index, review] of reviews.slice((number - 1) * 20, number * 20).entries()) {
                entry.push(this.makeEntry({id:`review:${uid}:${(number - 1) * 20 + index}`,
                    title:[review.name, review.time].filter(Boolean).join(' · ') || 'Отзыв',
                    content:{'*ATTRS':{type:'text'}, '*TEXT':this.escape(String(review.text || ''))},
                    link:this.downLink(require('./AcquisitionLinks').forBook(book, this.config, req.opdsUser)[0])}));
            }
            for (const [enabled, page, label] of [[number > 1, number - 1, 'Предыдущая страница'], [number * 20 < reviews.length, number + 1, 'Следующая страница']]) {
                if (enabled) entry.push(this.makeEntry({id:`page:${page}`, title:`[${label}]`,
                    link:this.navLink({href:`/book/reviews?uid=${encodeURIComponent(uid)}&page=${page}`, req})}));
            }
        } else {
            for (const name of [...new Set(String(book.author || '').split(',').map(name => name.trim()).filter(Boolean))]) {
                const {authorInfo} = await this.webWorker.getAuthorInfo('', name);
                const url = this.scopedHref(`${this.opdsRoot}/author`, req, {author:`=${name}`});
                const html = `${safeHtml(authorInfo?.html || authorInfo?.text || 'Биография не найдена')}<p><a href="${this.escape(url)}">Все книги автора</a></p>`;
                entry.push(this.makeEntry({id:`author:${name}`, title:name,
                    content:{'*ATTRS':{type:'html'}, '*TEXT':this.escape(html)},
                    link:[this.navLink({href:url, hrefAsIs:true, req, rel:'related'}),
                        this.downLink(require('./AcquisitionLinks').forBook(book, this.config, req.opdsUser)[0])]}));
            }
        }
        if (!entry.length) entry.push(this.makeEntry({id:'empty', title:this.kind === 'reviews' ? 'Отзывов пока нет' : 'Сведения об авторах отсутствуют'}));
        entry.push(this.makeEntry({id:'book', title:'[К книге]', link:this.acqLink({href:`/book?uid=${encodeURIComponent(uid)}`, req})}));
        return this.makeBody({title:this.escape(`${this.title}: ${book.title || 'Без названия'}`), entry}, req);
    }
}

module.exports = BookExtrasPage;
