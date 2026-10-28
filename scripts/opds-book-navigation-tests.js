const assert = require('assert');
const he = require('he');
const express = require('express');
const XmlParser = require('../server/core/xml/XmlParser');

function readXml(text) {
    const xml = new XmlParser(); xml.fromString(text);
    return xml;
}

function anchors(html) {
    return [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(match => ({href:he.decode(match[1]), label:he.decode(match[2])}));
}

function fixture(options = {}) {
    const BookPage = require('../server/core/opds/BookPage');
    const AuthorPage = require('../server/core/opds/AuthorPage');
    const SeriesPage = require('../server/core/opds/SeriesPage');
    const root = '/library/opds';
    const book = {_uid:'one', title:'Первая книга', author:'Стругацкий Аркадий,Стругацкий Борис', series:'Мир & «Полдень»', serno:2,
        genre:'sf', lang:'ru', ext:'epub', file:'one', folder:'books.zip', size:1234, date:'2026-10-26', del:0, insno:0, libid:1, ...options.book};
    const books = [book, {...book, _uid:'two', title:'Следующая книга', serno:3}];
    const calls = {info:0, authors:[], series:[]};
    const config = {opdsRoot:root, opds:{root}, bookPathStatic:'/library/book', rootPathStatic:'/library'};
    const worker = {
        getGenreMap:async() => new Map([['sf','Фантастика']]),
        getGenreTree:async() => ({genreTree:[]}),
        getBookRecordByUid:async uid => books.find(item => item._uid === uid),
        applyMetadataOverridesToSearchResult:async() => {},
        getBookCardInfo:async uid => {calls.info++; return {bookInfo:{book:books.find(item => item._uid === uid), fb2:options.fb2 || false}};},
        getAuthorBookList:async(id, name) => {calls.authors.push(name); return {books:books.filter(item => item.author.split(',').includes(name))};},
        getSeriesBookList:async name => {calls.series.push(name); return {books:books.filter(item => item.series === name)};},
    };
    const pages = new Map([['book', BookPage], ['author', AuthorPage], ['series', SeriesPage]].map(([name, Type]) => {
        const page = Object.create(Type.prototype);
        Object.assign(page, {config, webWorker:worker, opdsRoot:root, id:name, title:name, rootTag:'feed'});
        return [name, page];
    }));
    const request = (name, query) => ({query, originalUrl:`${root}/${name}?${new URLSearchParams(query)}`});
    const detail = async(query = {}) => {
        const source = await pages.get('book').body(request('book', {uid:book._uid, ...query}));
        const xml = readXml(source), entry = xml.$$('feed/entry/');
        const html = he.decode(entry.text('content') || '');
        return {source, xml, entry, html, links:anchors(html)};
    };
    return {root, book, books, calls, pages, request, detail};
}

async function testOpdsBookDescriptionLinksAndAuthorUris() {
    const value = fixture(), user = 'profile & один';
    const result = await value.detail({user});
    assert.strictEqual(value.calls.info, 0, 'EPUB description must stay independent of extraction and reviews');
    assert.strictEqual(result.entry.attrs('content').type, 'html');
    assert.deepStrictEqual(result.links.map(link => link.label), ['Стругацкий Аркадий', 'Стругацкий Борис', 'Мир & «Полдень» #2']);
    for (const link of result.links) {
        const url = new URL(link.href, 'http://example.test');
        assert.strictEqual(url.searchParams.get('user'), user);
        const key = url.pathname.endsWith('/author') ? 'author' : 'series';
        const expected = key === 'author' ? link.label : value.book.series;
        assert.strictEqual(url.pathname, `${value.root}/${key}`);
        assert.strictEqual(url.searchParams.get(key), '=' + expected);
        assert.strictEqual(url.searchParams.size, 2);
    }
    const authors = result.entry.$$array('author');
    assert.strictEqual(authors.length, 2);
    for (let i = 0; i < authors.length; i++) {
        assert.strictEqual(he.decode(authors[i].text('/name')), result.links[i].label);
        assert.strictEqual(he.decode(authors[i].text('/uri')), result.links[i].href);
    }
    const collections = result.entry.$$array('link').map(link => link.attrs()).filter(link => link.rel === 'collection');
    assert.strictEqual(collections.length, 3);
    assert.deepStrictEqual(collections.map(link => he.decode(link.href)), result.links.map(link => link.href));
    assert.ok(collections.every(link => link.type.includes('profile=opds-catalog')));
    assert.ok(result.source.includes('rel="http://opds-spec.org/acquisition"'));
    assert.ok(!result.links.some(link => link.href.includes('/#/')), 'Description links must open OPDS, not the web app');
}

async function testOpdsBookNavigationPreservesProfileAcrossFeeds() {
    const value = fixture();
    const app = express();
    for (const [name, page] of value.pages)
        app.get(`${value.root}/${name}`, async(req, res, next) => {
            try { res.type('application/atom+xml').send(await page.body(req)); } catch (error) { next(error); }
        });
    const server = await new Promise(resolve => {const instance = app.listen(0, '127.0.0.1', () => resolve(instance));});
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async href => {
        const url = new URL(href, base);
        assert.strictEqual(url.searchParams.get('user'), 'reader-one');
        const response = await fetch(url);
        assert.strictEqual(response.status, 200);
        assert.ok(response.headers.get('content-type').includes('application/atom+xml'));
        return readXml(await response.text());
    };
    try {
        const {links} = await value.detail({user:'reader-one'});
        const authorFeed = await read(links[0].href);
        assert.deepStrictEqual(value.calls.authors, ['Стругацкий Аркадий']);
        const seriesFromAuthor = authorFeed.$$array('feed/entry').map(entry => entry.attrs('/link')).find(link => link.rel === 'subsection');
        assert.ok(seriesFromAuthor);
        const authorSeriesFeed = await read(he.decode(seriesFromAuthor.href));
        const bookLinks = authorSeriesFeed.$$array('feed/entry').map(entry => entry.attrs('/link'));
        assert.strictEqual(bookLinks.length, 2);
        for (const link of bookLinks) await read(he.decode(link.href));
        const seriesFeed = await read(links.at(-1).href);
        assert.strictEqual(value.calls.series.at(-1), value.book.series);
        const entries = seriesFeed.$$array('feed/entry');
        assert.deepStrictEqual(entries.map(entry => he.decode(entry.text('/title'))), ['2. Первая книга (epub)', '3. Следующая книга (epub)']);
        for (const entry of entries) await read(he.decode(entry.attrs('/link').href));
        const anonymous = await value.detail();
        assert.ok(anonymous.links.every(link => !new URL(link.href, base).searchParams.has('user')));
        const profiles = await Promise.all(['first', 'second'].map(user => value.detail({user})));
        profiles.forEach((result, i) => assert.ok(result.links.every(link => new URL(link.href, base).searchParams.get('user') === ['first','second'][i])));
    } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}

async function testOpdsFb2AuthorsAndMultipleSeriesAreClickable() {
    const parser = readXml('<FictionBook><description><title-info><genre>sf</genre><author><last-name>Тестов</last-name><first-name>Автор</first-name></author>' +
        '<book-title>Книга</book-title><annotation><p>Аннотация <strong>жирная</strong><a href="javascript:bad()">ссылка</a></p></annotation>' +
        '<sequence name="Цикл &amp; первый" number="4"/><sequence name="Вторая серия" number="7"/><lang>ru</lang></title-info></description></FictionBook>');
    const value = fixture({book:{ext:'fb2', author:'', series:'', serno:0}, fb2:parser.rawNodes});
    const result = await value.detail({user:'reader'});
    assert.strictEqual(value.calls.info, 1);
    assert.deepStrictEqual(result.links.map(link => link.label), ['Тестов Автор', 'Цикл & первый #4', 'Вторая серия #7']);
    const firstSeries = new URL(result.links[1].href, 'http://example.test');
    assert.strictEqual(firstSeries.searchParams.get('series'), '=Цикл & первый', 'Decode FB2 XML entities before looking up catalogue names');
    assert.ok(result.html.includes('<b>жирная</b>'), 'Annotation formatting retained');
    assert.ok(!result.html.includes('javascript:'));
    assert.strictEqual(he.decode(result.entry.$$array('author')[0].text('/name')), 'Тестов Автор');
}

async function testOpdsBookNavigationEscapesMetadataAndHandlesMissingValues() {
    const author = 'Автор & "A" <img src=x onerror=bad()>', series = 'Цикл #2? user=other & "B"';
    const value = fixture({book:{author, series, title:'Название <script>bad()</script>', serno:12}});
    const result = await value.detail({user:'actual-user'});
    assert.deepStrictEqual(result.links.map(link => link.label), [author, series + ' #12']);
    for (const link of result.links) {
        const url = new URL(link.href, 'http://example.test');
        assert.strictEqual(url.searchParams.get('user'), 'actual-user');
        assert.strictEqual(url.searchParams.size, 2);
    }
    assert.strictEqual(new URL(result.links[0].href, 'http://example.test').searchParams.get('author'), '=' + author);
    assert.strictEqual(new URL(result.links[1].href, 'http://example.test').searchParams.get('series'), '=' + series);
    assert.ok(!/<(?:img|script)\b/i.test(result.html), 'Metadata must stay text inside trusted anchors');
    const sparse = fixture({book:{author:undefined, series:undefined, serno:0, size:undefined, genre:undefined}});
    const sparseResult = await sparse.detail();
    assert.strictEqual(sparseResult.links.length, 0);
    assert.strictEqual(sparseResult.entry.$$array('author').length, 0);
    assert.ok(!sparseResult.html.includes('undefined'));
}

module.exports = [testOpdsBookDescriptionLinksAndAuthorUris, testOpdsBookNavigationPreservesProfileAcrossFeeds,
    testOpdsFb2AuthorsAndMultipleSeriesAreClickable, testOpdsBookNavigationEscapesMetadataAndHandlesMissingValues];
