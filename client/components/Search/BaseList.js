import axios from 'axios';
import dayjs from 'dayjs';
import _ from 'lodash';

import authorBooksStorage from './authorBooksStorage';

import BookView from './BookView/BookView.vue';
import LoadingMessage from './LoadingMessage/LoadingMessage.vue';
import * as utils from '../../share/utils';

const showMoreCount = 100;//значение для "Показать еще"
const maxItemCount = 500;//выше этого значения показываем "Загрузка"

const componentOptions = {
    components: {
        BookView,
        LoadingMessage,
    },
    watch: {
        settings() {
            this.loadSettings();
        },
        search: {
            handler() {
                if (!this.isExtendedSearch)
                    this.refresh();
            },
            deep: true,
        },
        extSearch: {
            handler() {
                if (this.isExtendedSearch)
                    this.refresh();
            },
            deep: true,
        },
        showDeleted() {
            this.refresh();
        },
    },
};
export default class BaseList {
    _options = componentOptions;
    _props = {
        list: Object,
        search: Object,
        extSearch: Object,
        genreMap: Object,
    };
    
    error = '';
    loadingMessage = '';
    loadingMessage2 = '';

    //settings
    expandedAuthor = [];
    expandedSeries = [];

    downloadAsZip = false;
    showCounts = true;
    showRates = true;
    showGenres = true;    
    showDeleted = false;
    abCacheEnabled = true;

    //stuff
    refreshing = false;

    showMoreCount = showMoreCount;
    maxItemCount = maxItemCount;

    searchResult = {};
    tableData = [];

    created() {
        this.isExtendedSearch = false;
        this.commit = this.$store.commit;
        this.api = this.$root.api;

        this.loadSettings();
    }

    mounted() {
        this.refresh();//no await
    }

    loadSettings() {
        const settings = this.settings;

        this.expandedAuthor = _.cloneDeep(settings.expandedAuthor);
        this.expandedSeries = _.cloneDeep(settings.expandedSeries);
        this.downloadAsZip = settings.downloadAsZip;
        this.showCounts = settings.showCounts;
        this.showRates = settings.showRates;
        this.showGenres = settings.showGenres;
        this.showDeleted = settings.showDeleted;
        this.abCacheEnabled = settings.abCacheEnabled;
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get currentSearch() {
        return (this.isExtendedSearch ? this.extSearch : this.search);
    }

    get showReadLink() {
        return !!(this.config.onlineReaderEnabled || this.config.bookReadLink != '' || this.list.liberamaReady);
    }

    get ratingFilterOptions() {
        return [
            {label: 'Топ 5', value: '5'},
            {label: '4+', value: '4,5'},
            {label: '3+', value: '3,4,5'},
        ];
    }

    get activeRatingFilter() {
        return this.currentSearch.librate || '';
    }

    scrollToTop() {
        this.$emit('listEvent', {action: 'scrollToTop'});
    }

    selectAuthor(author) {
        const search = (this.isExtendedSearch ? this.extSearch : this.search);
        search.author = `=${author}`;
        this.scrollToTop();
    }

    selectSeries(series) {
        const search = (this.isExtendedSearch ? this.extSearch : this.search);
        search.series = `=${series}`;
    }

    selectTitle(title) {
        this.currentSearch.title = `=${title}`;
    }

    applyRatingFilter(value = '') {
        this.currentSearch.librate = value;
        this.scrollToTop();
    }

    clearRatingFilter() {
        this.applyRatingFilter('');
    }

    getActionLoadingMessage(action, format = '') {
        if (action == 'bookInfo')
            return 'Загрузка информации о книге...';

        if (action == 'authorInfo')
            return 'Загрузка информации об авторе...';

        if (action == 'sendTelegram')
            return (format ? `Отправка ${format.toUpperCase()} в Telegram...` : 'Отправка книги в Telegram...');

        if (action == 'sendEmail')
            return (format ? `Отправка ${format.toUpperCase()} на email...` : 'Отправка книги на email...');

        if (format)
            return `Подготовка ${format.toUpperCase()}...`;

        return 'Подготовка файла...';
    }

    getDownloadFileName(response, book, format = '') {
        const disposition = (response.headers ? response.headers['content-disposition'] : '');
        if (disposition) {
            const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
            if (utfMatch && utfMatch[1])
                return decodeURIComponent(utfMatch[1]);

            const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
            if (plainMatch && plainMatch[1])
                return plainMatch[1];
        }

        const baseName = (book.file || book.title || 'book').toString().replace(/[\\/:*?"<>|]+/g, '_');
        if (format)
            return `${baseName}.${format}`;

        const ext = (book.ext || '').toLowerCase();
        return (ext ? `${baseName}.${ext}` : baseName);
    }

    downloadBlob(blob, fileName) {
        const href = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
            window.URL.revokeObjectURL(href);
        }, 1000);
    }

    async getErrorMessage(error) {
        if (error.response && error.response.data) {
            const responseData = error.response.data;
            if (typeof(responseData) === 'string')
                return responseData;

            if (responseData && typeof(responseData.text) === 'function') {
                try {
                    return await responseData.text();
                } catch(e) {
                    // ignore
                }
            }
        }

        return error.message;
    }

    async download(book, action, format = '') {
        if (this.downloadFlag)
            return;

        if (format && this.config.conversionEnabled === false) {
            this.$root.stdDialog.alert('Конвертация книг отключена в текущем образе.', 'Информация');
            return;
        }

        this.downloadFlag = true;
        (async() => {
            await utils.sleep(200);
            if (this.downloadFlag)
                this.loadingMessage2 = this.getActionLoadingMessage(action, format);
        })();

        try {
            if (action == 'bookInfo' || action == 'authorInfo') {
                const response = await this.api.getBookInfo(book._uid);
                this.$emit('listEvent', {
                    action: 'bookInfo',
                    data: response.bookInfo,
                    tab: (action == 'authorInfo' ? 'author' : 'fb2'),
                });
                return;
            }

            if (action == 'sendTelegram') {
                await this.api.sendBookTelegram(book._uid, format);
                this.$root.notify.success(`Книга отправлена в Telegram${format ? ` (${format.toUpperCase()})` : ''}`);
                return;
            }

            if (action == 'sendEmail') {
                await this.api.sendBookEmail(book._uid, format);
                this.$root.notify.success(`Книга отправлена на email${format ? ` (${format.toUpperCase()})` : ''}`);
                return;
            }

            //подготовка
            const response = await this.api.getBookLink(book._uid);
            
            const link = response.link;
            let href = `${window.location.origin}${link}`;

            //downloadAsZip
            if (this.downloadAsZip && !format && (action == 'download' || action == 'copyLink')) {
                href += '/zip';
                //подожлем формирования zip-файла
                await axios.head(href);
            }

            if (format) {
                href += `/${format}`;
            }

            //action
            if (action == 'download') {
                if (format) {
                    const downloadResponse = await axios.get(href, {responseType: 'blob'});
                    const fileName = this.getDownloadFileName(downloadResponse, book, format);
                    this.downloadBlob(downloadResponse.data, fileName);
                } else {
                    //скачивание
                    const d = this.$refs.download;
                    d.href = href;
                    d.click();
                }
            } else if (action == 'copyLink') {
                //копирование ссылки
                if (await utils.copyTextToClipboard(href))
                    this.$root.notify.success('Ссылка успешно скопирована');
                else
                    this.$root.stdDialog.alert(
`Копирование ссылки не удалось. Пожалуйста, попробуйте еще раз.
<br><br>
<b>Пояснение</b>: вероятно, браузер запретил копирование, т.к. прошло<br>
слишком много времени с момента нажатия на кнопку (инициация<br>
пользовательского события). Сейчас ссылка уже закеширована,<br>
поэтому повторная попытка должна быть успешной.`, 'Ошибка');
            } else if (action == 'readBook') {
                //читать
                if (this.config.onlineReaderEnabled && String(book.ext || '').toLowerCase() === 'fb2') {
                    this.$router.push({path: '/reader', query: {bookUid: book._uid}});
                } else if (this.list.liberamaReady) {
                    this.$emit('listEvent', {action: 'submitUrl', data: href});
                } else {
                    const bookReadLink = this.config.bookReadLink;
                    if (!bookReadLink) {
                        this.$root.stdDialog.alert('Встроенная читалка пока поддерживает только FB2.', 'Информация');
                        return;
                    }
                    let url = bookReadLink;

                    if (bookReadLink.indexOf('${DOWNLOAD_LINK}') >= 0) {
                        url = bookReadLink.replace('${DOWNLOAD_LINK}', href);

                    } else if (bookReadLink.indexOf('${DOWNLOAD_URI}') >= 0) {
                        const hrefUrl = new URL(href);
                        const urlWithoutHost = hrefUrl.pathname + hrefUrl.search + hrefUrl.hash;
                        url = bookReadLink.replace('${DOWNLOAD_URI}', urlWithoutHost);
                    }

                    window.open(url, '_blank');
                }
            }
        } catch(e) {
            const message = await this.getErrorMessage(e);
            this.$root.stdDialog.alert(message, 'Ошибка');
        } finally {
            this.downloadFlag = false;
            this.loadingMessage2 = '';
        }
    }

    getBookUid(book = {}) {
        return String(book._uid || book.bookUid || '').trim();
    }

    async markBooksRead(bookUids = [], read = true) {
        const normalized = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
            .map((bookUid) => String(bookUid || '').trim())
            .filter(Boolean)));
        if (!normalized.length)
            return;

        try {
            const result = await this.api.markReaderBooksRead(normalized, read);
            const count = (result && result.changedBooks) || normalized.length;
            this.$root.notify.success(read ? `Помечено прочитанными: ${count}` : `Отметка снята: ${count}`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    bookEvent(event) {
        switch (event.action) {
            case 'authorClick':
                this.selectAuthor(event.book.author);
                break;
            case 'seriesClick':
                this.selectSeries(event.book.series);
                break;
            case 'titleClick':
                this.selectTitle(event.book.title);
                break;
            case 'genreClick':
                (this.isExtendedSearch ? this.extSearch : this.search).genre = event.format;
                this.scrollToTop();
                break;
            case 'readingList':
                this.$emit('listEvent', {action: 'manageReadingLists', book: event.book});
                break;
            case 'markRead':
                this.markBooksRead([this.getBookUid(event.book)], true);//no await
                break;
            case 'markUnread':
                this.markBooksRead([this.getBookUid(event.book)], false);//no await
                break;
            case 'download':
            case 'copyLink':
            case 'readBook':
            case 'bookInfo':
            case 'authorInfo':
            case 'sendTelegram':
            case 'sendEmail':
                this.download(event.book, event.action, event.format);//no await
                break;
        }
    }

    isExpandedAuthor(item) {
        return this.expandedAuthor.indexOf(item.author) >= 0;
    }

    isExpandedSeries(seriesItem) {
        return this.expandedSeries.indexOf(seriesItem.key) >= 0;
    }

    setSetting(name, newValue) {
        this.commit('setSettings', {[name]: _.cloneDeep(newValue)});
    }

    highlightPageScroller(query) {
        this.$emit('listEvent', {action: 'highlightPageScroller', query});
    }

    async expandSeries(seriesItem) {
        this.$emit('listEvent', {action: 'ignoreScroll'});

        const expandedSeries = _.cloneDeep(this.expandedSeries);
        const key = seriesItem.key;

        if (!this.isExpandedSeries(seriesItem)) {
            expandedSeries.push(key);

            if (expandedSeries.length > 100) {
                expandedSeries.shift();
            }

            this.getSeriesBooks(seriesItem); //no await

            this.setSetting('expandedSeries', expandedSeries);
        } else {
            const i = expandedSeries.indexOf(key);
            if (i >= 0) {
                expandedSeries.splice(i, 1);
                this.setSetting('expandedSeries', expandedSeries);
            }
        }
    }

    async loadAuthorBooks(authorId) {
        try {
            let result;

            if (this.abCacheEnabled) {
                const key = `author-${authorId}-${this.list.inpxHash}`;
                const data = await authorBooksStorage.getData(key);
                if (data) {
                    result = JSON.parse(data);
                } else {
                    result = await this.api.getAuthorBookList(authorId);
                    await authorBooksStorage.setData(key, JSON.stringify(result));
                }
            } else {
                result = await this.api.getAuthorBookList(authorId);
            }

            return result.books;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async loadAuthorSeries(authorId) {
        try {
            let result;

            if (this.abCacheEnabled) {
                const key = `author-${authorId}-series-${this.list.inpxHash}`;
                const data = await authorBooksStorage.getData(key);
                if (data) {
                    result = JSON.parse(data);
                } else {
                    result = await this.api.getAuthorSeriesList(authorId);
                    await authorBooksStorage.setData(key, JSON.stringify(result));
                }
            } else {
                result = await this.api.getAuthorSeriesList(authorId);
            }

            return result.series;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async loadSeriesBooks(series) {
        try {
            let result;

            if (this.abCacheEnabled) {
                const key = `series-${series}-${this.list.inpxHash}`;
                const data = await authorBooksStorage.getData(key);
                if (data) {
                    result = JSON.parse(data);
                } else {
                    result = await this.api.getSeriesBookList(series);
                    await authorBooksStorage.setData(key, JSON.stringify(result));
                }
            } else {
                result = await this.api.getSeriesBookList(series);
            }

            return result.books;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async getSeriesBooks(seriesItem) {
        //блокируем повторный вызов
        if (seriesItem.seriesBookLoading)
            return;
        seriesItem.seriesBookLoading = true;

        try {
            seriesItem.allBooksLoaded = await this.loadSeriesBooks(seriesItem.series);

            if (seriesItem.allBooksLoaded) {
                seriesItem.allBooksLoaded = seriesItem.allBooksLoaded.filter(book => (this.showDeleted || !book.del));
                this.sortSeriesBooks(seriesItem.allBooksLoaded);
                this.showMoreAll(seriesItem);
            }
        } finally {
            seriesItem.seriesBookLoading = false;
        }
    }

    filterBooks(books) {
        const s = this.search;

        const emptyFieldValue = '?';
        const maxUtf8Char = String.fromCodePoint(0xFFFFF);
        const ruAlphabet = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
        const enAlphabet = 'abcdefghijklmnopqrstuvwxyz';
        const enru = new Set((ruAlphabet + enAlphabet).split(''));

        const splitAuthor = (author) => {
            if (!author) {
                author = emptyFieldValue;
            }

            const result = author.split(',');
            if (result.length > 1)
                result.push(author);

            return result;
        };

        const filterBySearch = (bookValue, searchValue) => {
            if (!searchValue)
                return true;

            if (!bookValue)
                bookValue = emptyFieldValue;

            bookValue = bookValue.toLowerCase();
            if (searchValue[0] !== '~')
                searchValue = searchValue.toLowerCase();

            //особая обработка префиксов
            if (searchValue[0] == '=') {

                searchValue = searchValue.substring(1);
                return bookValue.localeCompare(searchValue) == 0;
            } else if (searchValue[0] == '*') {

                searchValue = searchValue.substring(1);
                return bookValue !== emptyFieldValue && bookValue.indexOf(searchValue) >= 0;
            } else if (searchValue[0] == '#') {

                searchValue = searchValue.substring(1);
                if (!bookValue)
                    return false;
                return bookValue !== emptyFieldValue && !enru.has(bookValue[0]) && bookValue.indexOf(searchValue) >= 0;
            } else if (searchValue[0] == '~') {//RegExp

                searchValue = searchValue.substring(1);
                const re = new RegExp(searchValue, 'i');
                return re.test(bookValue);
            } else {
                return bookValue.indexOf(searchValue) === 0;
            }
        };

        return books.filter((book) => {
            //author
            let authorFound = false;
            const authors = splitAuthor(book.author);
            for (const a of authors) {
                if (filterBySearch(a, s.author)) {
                    authorFound = true;
                    break;
                }
            }

            //genre
            let genreFound = !s.genre;
            if (!genreFound) {
                const searchGenres = new Set(s.genre.split(','));
                const bookGenres = book.genre.split(',');

                for (let g of bookGenres) {
                    if (!g)
                        g = emptyFieldValue;

                    if (searchGenres.has(g)) {
                        genreFound = true;
                        break;
                    }
                }
            }

            //lang
            let langFound = !s.lang;
            if (!langFound) {
                const searchLang = new Set(s.lang.split(','));
                langFound = searchLang.has(book.lang || emptyFieldValue);
            }

            //date
            let dateFound = !s.date;
            if (!dateFound) {
                const date = this.queryDate(s.date).split(',');
                let [from = '0000-00-00', to = '9999-99-99'] = date;

                dateFound = (book.date >= from && book.date <= to);
            }

            //librate
            let librateFound = !s.librate;
            if (!librateFound) {
                const searchLibrate = new Set(s.librate.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)));
                librateFound = searchLibrate.has(book.librate);
            }

            //ext
            let extFound = !s.ext;
            if (!extFound) {
                const searchExt = new Set(s.ext.split('|'));
                extFound = searchExt.has(book.ext.toLowerCase() || emptyFieldValue);
            }

            return (this.showDeleted || !book.del)
                && authorFound
                && filterBySearch(book.series, s.series)
                && filterBySearch(book.title, s.title)
                && genreFound
                && langFound
                && dateFound
                && librateFound
                && extFound
            ;
        });
    }

    showMore(item, all = false) {
        if (item.booksLoaded) {
            const currentLen = (item.books ? item.books.length : 0);
            let books;
            if (all || currentLen + this.showMoreCount*1.5 > item.booksLoaded.length) {
                books = item.booksLoaded;
            } else {
                books = item.booksLoaded.slice(0, currentLen + this.showMoreCount);
            }

            item.showMore = (books.length < item.booksLoaded.length);
            item.books = books;
        }
    }

    showMoreAll(seriesItem, all = false) {
        if (seriesItem.allBooksLoaded) {
            const currentLen = (seriesItem.allBooks ? seriesItem.allBooks.length : 0);
            let books;
            if (all || currentLen + this.showMoreCount*1.5 > seriesItem.allBooksLoaded.length) {
                books = seriesItem.allBooksLoaded;
            } else {
                books = seriesItem.allBooksLoaded.slice(0, currentLen + this.showMoreCount);
            }

            seriesItem.showMoreAll = (books.length < seriesItem.allBooksLoaded.length);
            seriesItem.allBooks = books;
        }
    }

    sortSeriesBooks(seriesBooks) {
        seriesBooks.sort((a, b) => {
            const dserno = (a.serno || Number.MAX_VALUE) - (b.serno || Number.MAX_VALUE);
            const dtitle = a.title.localeCompare(b.title);
            const dext = a.ext.localeCompare(b.ext);
            return (dserno ? dserno : (dtitle ? dtitle : dext));
        });
    }

    queryDate(date) {
        if (!utils.isManualDate(date)) {//!manual
            /*
            {label: 'сегодня', value: 'today'},
            {label: 'за 3 дня', value: '3days'},
            {label: 'за неделю', value: 'week'},
            {label: 'за 2 недели', value: '2weeks'},
            {label: 'за месяц', value: 'month'},
            {label: 'за 2 месяца', value: '2months'},
            {label: 'за 3 месяца', value: '3months'},
            {label: 'указать даты', value: 'manual'},
            */
            const sqlFormat = 'YYYY-MM-DD';
            switch (date) {
                case 'today': date = utils.dateFormat(dayjs(), sqlFormat); break;
                case '3days': date = utils.dateFormat(dayjs().subtract(3, 'days'), sqlFormat); break;
                case 'week': date = utils.dateFormat(dayjs().subtract(1, 'weeks'), sqlFormat); break;
                case '2weeks': date = utils.dateFormat(dayjs().subtract(2, 'weeks'), sqlFormat); break;
                case 'month': date = utils.dateFormat(dayjs().subtract(1, 'months'), sqlFormat); break;
                case '2months': date = utils.dateFormat(dayjs().subtract(2, 'months'), sqlFormat); break;
                case '3months': date = utils.dateFormat(dayjs().subtract(3, 'months'), sqlFormat); break;
                default:
                    date = '';
            }
        }

        return date;
    }

    getQuery() {
        const search = (this.isExtendedSearch ? this.extSearch : this.search);
        const newQuery = {};
        search.setDefaults(newQuery, search);

        //дата
        if (newQuery.date) {
            newQuery.date = this.queryDate(newQuery.date);
        }

        //offset
        newQuery.offset = (newQuery.page - 1)*newQuery.limit;

        //del
        if (!newQuery.del && !this.showDeleted)
            newQuery.del = '0';

        return newQuery;
    }
}
