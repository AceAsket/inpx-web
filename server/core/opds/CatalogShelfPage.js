const ReadingListPage = require('./ReadingListPage');
const shelves = require('./CatalogShelves');

class CatalogShelfPage extends ReadingListPage {
    constructor(config) {
        super(config);
        this.id = 'catalog-shelf';
        this.title = 'Общая подборка';
    }

    async body(req) {
        const available = await shelves.load(this.config);
        const shelf = available.get(String(req.query.id || ''));
        if (!shelf) throw Object.assign(new Error('Подборка не найдена'), {status:404});
        const page = await shelves.page(this.webWorker, shelf, req.query);
        return this.render(req, shelf, page, '/catalog-shelves', '/root', false);
    }
}

module.exports = CatalogShelfPage;
