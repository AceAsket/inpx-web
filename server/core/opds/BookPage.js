const path = require('path');
const _ = require('lodash');
const dayjs = require('dayjs');

const BasePage = require('./BasePage');
const Fb2Parser = require('../fb2/Fb2Parser');
const {safeHtml} = require('../../../shared/safeHtml');
const he = require('he');

const navigationType = 'application/atom+xml;profile=opds-catalog;kind=navigation';

class BookPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'book';
        this.title = 'Книга';

    }

    formatSize(size) {
        size = size/1024;
        let unit = 'KB';
        if (size > 1024) {
            size = size/1024;
            unit = 'MB';
        }
        return `${size.toFixed(1)} ${unit}`;
    }

    convertGenres(genreArr) {
        let result = [];
        if (genreArr) {
            for (const genre of genreArr) {
                const g = genre.trim();
                const name = this.genreMap.get(g);
                result.push(name ? name : g);
            }
        }

        return result.join(', ');
    }

    inpxInfo(bookRec) {
        const mapping = [
            {name: 'fileInfo', label: 'Информация о файле', value: [
                {name: 'folder', label: 'Папка'},
                {name: 'file', label: 'Файл'},
                {name: 'size', label: 'Размер'},
                {name: 'date', label: 'Добавлен'},
                {name: 'del', label: 'Удален'},
                {name: 'libid', label: 'LibId'},
                {name: 'insno', label: 'InsideNo'},
            ]},

            {name: 'titleInfo', label: 'Общая информация', value: [
                {name: 'author', label: 'Автор(ы)'},
                {name: 'title', label: 'Название'},
                {name: 'series', label: 'Серия'},
                {name: 'genre', label: 'Жанр'},
                {name: 'librate', label: 'Оценка'},
                {name: 'lang', label: 'Язык книги'},
                {name: 'keywords', label: 'Ключевые слова'},
            ]},
        ];

        const valueToString = (value, nodePath, b) => {//eslint-disable-line no-unused-vars
            if (value === undefined || value === null)
                return '';
            if (nodePath == 'fileInfo/file')
                return `${value}.${b.ext}`;

            if (nodePath == 'fileInfo/size')
                return `${this.formatSize(value)} (${value.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1 ')} Bytes)`;

            if (nodePath == 'fileInfo/date')
                return dayjs(value, 'YYYY-MM-DD').format('DD.MM.YYYY');

            if (nodePath == 'fileInfo/del')
                return (value ? 'Да' : null);

            if (nodePath == 'fileInfo/insno')
                return (value ? value : null);

            if (nodePath == 'titleInfo/author')
                return value.split(',').join(', ');

            if (nodePath == 'titleInfo/genre')
                return this.convertGenres(value.split(','));

            if (nodePath == 'titleInfo/librate' && !value)
                return null;

            if (typeof(value) === 'string') {
                return value;
            }

            return (value.toString ? value.toString() : '');
        };

        let result = [];
        const book = _.cloneDeep(bookRec);
        book.series = [book.series, book.serno].filter(v => v).join(' #');

        for (const item of mapping) {
            const itemOut = {name: item.name, label: item.label, value: []};

            for (const subItem of item.value) {
                const subItemOut = {
                    name: subItem.name,
                    label: subItem.label,
                    value: valueToString(book[subItem.name], `${item.name}/${subItem.name}`, book)
                };
                if (subItemOut.value)
                    itemOut.value.push(subItemOut);
            }

            if (itemOut.value.length)
                result.push(itemOut);
        }

        return result;
    }    

    catalogHref(kind, value, req) {
        return this.scopedHref(`${this.opdsRoot}/${kind}`, req, {[kind]: `=${value}`});
    }

    catalogAnchor(kind, value, label, req) {
        const href = this.catalogHref(kind, value, req);
        return `<a href="${this.escape(href)}" type="${navigationType}">${this.escape(String(label || value))}</a>`;
    }

    authorNames(value) {
        return (Array.isArray(value) ? value : String(value || '').split(','))
            .map(name => String(name || '').trim()).filter(Boolean);
    }

    authorsHtml(value, req) {
        return this.authorNames(value).map(name => this.catalogAnchor('author', name, name, req)).join(', ');
    }

    seriesHtml(value, number, req) {
        const name = String(value || '').trim();
        return name ? this.catalogAnchor('series', name, [name, number].filter(Boolean).join(' #'), req) : '';
    }

    htmlInfo(title, infoList, renderValue = null) {
        let info = '';
        for (const part of infoList) {
            if (part.value.length)
                info += `<h3>${this.escape(part.label)}</h3>`;
            for (const rec of part.value)
                info += `<p>${this.escape(rec.label)}: ${renderValue ? renderValue(rec, part) : this.escape(String(rec.value))}</p>`;
        }

        if (info)
            info = `<h2>${this.escape(title)}</h2>${info}`;

        return info;
    }

    async body(req) {
        const result = {};

        this.genreMap = await this.webWorker.getGenreMap();
        result.link = this.baseLinks(req, true);

        const bookUid = req.query.uid;
        const entry = [];
        if (bookUid) {
            const record = await this.webWorker.getBookRecordByUid(bookUid);
            const directDownload = record && String(record.ext).toLowerCase() !== 'fb2';
            let bookInfo;
            if (directDownload) {
                await this.webWorker.applyMetadataOverridesToSearchResult({books: [record]});
                // EPUB metadata is already in INPX. Preparing the book and
                // loading reviews here can time out before Kindle gets a link.
                bookInfo = {book: record, cover: '', fb2: false};
            } else if (record) {
                ({bookInfo} = await this.webWorker.getBookCardInfo(bookUid));
            }

            if (bookInfo) {
                const {genreMap} = await this.getGenres();

                //format
                const ext = bookInfo.book.ext;
                const directHref = `${this.config.bookPathStatic}/by-uid?uid=${encodeURIComponent(bookUid)}`;
                const rawHref = `${directHref}&format=raw`;
                const links = [];
                const addLink = (href, type) => {
                    links.push({href, type});
                };

                if (ext === 'fb2') {
                    addLink(rawHref, 'application/fb2+xml');
                    addLink(rawHref, 'application/x-fictionbook+xml');
                } else if (ext === 'epub') {
                    addLink(rawHref, 'application/epub+zip');
                } else if (ext === 'mobi') {
                    addLink(rawHref, 'application/x-mobipocket-ebook');
                } else {
                    addLink(rawHref, `application/${ext}`);
                    addLink(`${directHref}&zip=1`, 'application/zip');
                }

                if (this.config.conversionEnabled && this.config.mobiEnabled && ['fb2', 'epub'].includes(ext))
                    addLink(`${directHref}&format=mobi`, 'application/x-mobipocket-ebook');

                //entry
                const e = this.makeEntry({
                    id: bookUid,
                    title: bookInfo.book.title || 'Без названия',
                });

                //author bookInfo
                const atomAuthors = names => this.authorNames(names).map(name => ({
                    name: this.escape(name), uri: this.escape(this.catalogHref('author', name, req)),
                }));
                if (this.authorNames(bookInfo.book.author).length) {
                    e.author = atomAuthors(bookInfo.book.author);
                }

                e['dc:language'] = bookInfo.book.lang;
                if (ext === 'fb2')
                    e['dc:format'] = 'application/fb2+xml';
                else if (ext === 'epub')
                    e['dc:format'] = 'application/epub+zip';
                else if (ext === 'mobi')
                    e['dc:format'] = 'application/x-mobipocket-ebook';
                else
                    e['dc:format'] = `application/${ext}`;

                //genre
                const genre = String(bookInfo.book.genre || '').split(',');
                for (const g of genre) {
                    const genreName = genreMap.get(g);
                    if (genreName) {
                        if (!e.category)
                            e.category = [];
                        e.category.push({
                            '*ATTRS': {term: genreName, label: genreName},
                        });
                    }
                }

                let content = '';
                let ann = '';
                let info = '';
                //fb2 info
                if (bookInfo.fb2) {
                    const parser = new Fb2Parser(bookInfo.fb2);
                    const infoObj = parser.bookInfo();

                    if (infoObj.titleInfo) {
                        //author fb2Info
                        if (!e.author && infoObj.titleInfo.author.length) {
                            e.author = atomAuthors(infoObj.titleInfo.author.map(name => he.decode(name)));
                        }

                        ann = safeHtml(infoObj.titleInfo.annotationHtml || '');
                        const self = this;
                        const infoList = parser.bookInfoList(infoObj, {
                            valueToString(value, nodePath, origVTS) {//eslint-disable-line no-unused-vars
                                if ((nodePath == 'titleInfo/genre' || nodePath == 'srcTitleInfo/genre') && value) {
                                    return self.convertGenres(value);
                                }

                                return origVTS(value, nodePath);
                            },
                        });

                        info += this.htmlInfo('Fb2 инфо', infoList, (rec, part) => {
                            const value = infoObj[part.name][rec.name];
                            if (rec.name === 'author' && ['titleInfo', 'srcTitleInfo'].includes(part.name))
                                return this.authorsHtml(value.map(name => he.decode(name)), req);
                            if (rec.name === 'sequence')
                                return value.map(series => this.seriesHtml(he.decode(series.name || ''), series.num, req)).filter(Boolean).join(', ');
                            if (rec.name === 'historyHtml')
                                return safeHtml(rec.value);
                            return this.escape(he.decode(String(rec.value)));
                        });
                    }
                }

                //content
                info += this.htmlInfo('Inpx инфо', this.inpxInfo(bookInfo.book), (rec, part) => {
                    if (part.name === 'titleInfo' && rec.name === 'author')
                        return this.authorsHtml(bookInfo.book.author, req);
                    if (part.name === 'titleInfo' && rec.name === 'series')
                        return this.seriesHtml(bookInfo.book.series, bookInfo.book.serno, req);
                    return this.escape(String(rec.value));
                });

                content = `${ann}${info}`;
                if (content) {
                    e.content = {
                        '*ATTRS': {type: 'html'},
                        '*TEXT': this.escape(content),
                    };
                }

                //links
                e.link = [];
                for (const item of links)
                    e.link.push(this.downLink(item));

                // Atom author URIs and collection relations complement the
                // description links for clients that hide HTML navigation.
                const collections = new Map();
                for (const name of this.authorNames(bookInfo.book.author))
                    collections.set(this.catalogHref('author', name, req), `Книги автора: ${name}`);
                if (String(bookInfo.book.series || '').trim())
                    collections.set(this.catalogHref('series', bookInfo.book.series.trim(), req), `Серия: ${bookInfo.book.series}`);
                for (const [href, title] of collections)
                    e.link.push(this.makeLink({href, rel: 'collection', type: navigationType, title: this.escape(title)}));

                let coverHref = bookInfo.cover || '';
                let coverType = 'image/jpeg';
                if (coverHref && path.extname(coverHref) == '.png')
                    coverType = 'image/png';

                if (!coverHref && bookUid) {
                    coverHref = `${this.config.rootPathStatic || ''}/cover/by-uid?uid=${encodeURIComponent(bookUid)}`;
                    coverType = 'image/png';
                }

                if (coverHref) {
                    e.link.push(this.imgLink({href: coverHref, type: coverType}));
                    e.link.push(this.imgLink({href: coverHref, type: coverType, thumb: true}));
                }

                entry.push(e);
            }
        }

        result.entry = entry;

        return this.makeBody(result, req);
    }
}

module.exports = BookPage;
