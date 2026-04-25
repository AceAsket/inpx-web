const BasePage = require('./BasePage');
const AuthorPage = require('./AuthorPage');
const SeriesPage = require('./SeriesPage');
const TitlePage = require('./TitlePage');
const GenrePage = require('./GenrePage');
const ReadingListsPage = require('./ReadingListsPage');
const ReadingProfilesPage = require('./ReadingProfilesPage');
const ReadingProgressPage = require('./ReadingProgressPage');

class RootPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'root';
        this.title = '';

        this.authorPage = new AuthorPage(config);
        this.seriesPage = new SeriesPage(config);
        this.titlePage = new TitlePage(config);
        this.genrePage = new GenrePage(config);
        this.readingListsPage = new ReadingListsPage(config);
        this.readingProfilesPage = new ReadingProfilesPage(config);
        this.readingProgressPage = new ReadingProgressPage(config);
    }

    async body(req) {
        const result = {};

        if (!this.title) {
            const dbConfig = await this.webWorker.dbConfig();
            const collection = dbConfig.inpxInfo.collection.split('\n');
            this.title = collection[0].trim();
            if (!this.title)
                this.title = 'Неизвестная коллекция';
        }

        const resultEntry = [
            this.authorPage.myEntry(req),
            this.seriesPage.myEntry(req),
            this.titlePage.myEntry(req),
            this.genrePage.myEntry(req),
        ];

        const userId = this.getScopeUserId(req);
        if (userId) {
            const readingLibrary = await this.webWorker.getOpdsUserReadingLibrary(userId, {state: 'all', limit: 1});
            resultEntry.push(
                this.readingProgressPage.myEntry(req, 'reading', readingLibrary.counters.reading || 0),
                this.readingProgressPage.myEntry(req, 'read', readingLibrary.counters.read || 0),
                this.readingProgressPage.myEntry(req, 'hidden', readingLibrary.counters.hidden || 0),
            );
            resultEntry.push(this.readingListsPage.myEntry(req));
        } else {
            const publicUsers = await this.webWorker.getOpdsUsers();
            if (publicUsers.length)
                resultEntry.push(this.readingProfilesPage.myEntry(req));
        }

        result.entry = resultEntry;

        return this.makeBody(result, req);
    }
}

module.exports = RootPage;
