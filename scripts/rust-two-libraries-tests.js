const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {connect, signIn, waitFor, zip} = require('./rust-events-tests');
const Fb2Parser = require('../server/core/fb2/Fb2Parser');

const ids = ['north', 'south'];
const password = 'two-libraries-fixture';
const picture = name => fs.readFile(join(__dirname, '..', 'client', 'assets', name));

async function fixture(directory, runtimeDirectory = directory) {
    const first = await picture('pwa-icon-192.png');
    const second = await picture('reader-icon-192.png');
    const replacement = await picture('pwa-icon-512.png');
    const books = [];
    const sources = [];
    for (const [i, id] of ids.entries()) {
        const library = join(directory, id);
        for (const folder of ['volumes', 'covers', 'images'])
            await fs.mkdir(join(library, folder), {recursive: true});
        // Same INPX row, archive name, libid, text member and picture IDs in both sources.
        const row = ['Same,Author:', 'sf:', 'Shared catalogue title', '', 0, 1, 512, 1, 0, 'fb2', '2026-11-18', 'en', 0, ''];
        const title = 'Manuscript from ' + id;
        const fb2 = '<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>' +
            title + '</book-title><coverpage><image l:href="#cover"/></coverpage></title-info></description>' +
            '<body><section><p>' + title + '</p><image l:href="#figure"/></section></body></FictionBook>';
        const cover = i === 0 ? first : second, illustration = i === 0 ? second : first;
        await zip(join(library, 'library.inpx'), [['collection.info', id], ['books.inp', row.join('\x04') + '\n']]);
        await zip(join(library, 'volumes', 'books.zip'), [['1.fb2', fb2]]);
        await zip(join(library, 'covers', 'books.zip'), [['1', cover]]);
        await zip(join(library, 'images', 'books.zip'), [['1/figure', illustration]]);
        const libDir = runtimeDirectory + '/' + id;
        sources.push({id, name:id, type:'inpx', libDir, inpx:libDir + '/library.inpx'});
        books.push({id, title, cover, illustration, percent:0});
    }
    const config = {server:{host:'0.0.0.0',port:12380,root:'/reader'}, librarySources:sources, inpxCheckInterval:0};
    await fs.writeFile(join(directory, 'config.json'), JSON.stringify(config));
    return {books, replacement, directory};
}

async function verify(url, state, reindex) {
    const client = await connect(url, '/reader');
    try {
        const auth = await signIn(client, 'admin', password);
        const send = async (action, fields) => {
            const reply = await client.send(action, {...auth, ...fields});
            assert.equal(reply.error, undefined, action + ': ' + reply.error);
            return reply;
        };
        async function check() {
            const search = query => send('bookSearch', {query});
            const pages = await Promise.all([0, 1].map(offset => search({del:'0', limit:1, offset})));
            assert.deepEqual(pages.map(page => page.totalFound), [2, 2]);
            assert.equal(new Set(pages.map(page => page.found[0]._uid)).size, 2);
            for (const book of state.books) {
                const result = await search({sourceId:book.id, del:'0'});
                assert.equal(result.totalFound, 1);
                const [row] = result.found;
                assert.equal(row.sourceId, book.id);
                if (book.uid) assert.equal(row._uid, book.uid);
                book.uid = row._uid;
                const fields = {bookUid:book.uid};
                const {bookInfo} = await send('get-book-info', {...fields, readerOnly:true});
                assert.equal(new Fb2Parser(bookInfo.fb2).bookInfo().titleInfo.bookTitle, book.title);
                const cover = await fetch(url + bookInfo.cover);
                assert.equal(cover.status, 200);
                assert.deepEqual(Buffer.from(await cover.arrayBuffer()), book.cover);
                const gallery = await send('get-book-gallery', fields);
                assert.deepEqual(gallery.images.map(image => image.id), ['figure']);
                assert.deepEqual(Buffer.from(gallery.images[0].data, 'base64'), book.illustration);
                const {link} = await send('get-book-link', fields);
                const download = await fetch(url + link + '/raw');
                assert.equal(download.status, 200);
                const xml = await download.text();
                for (const content of [book.title, book.cover.toString('base64'), book.illustration.toString('base64')])
                    assert.ok(xml.includes(content), 'Wrong download for ' + book.id);
                assert.equal((await send('get-reader-state', fields)).progress.percent, book.percent);
            }
        }
        await check();
        if (reindex) {
            for (const [i, book] of state.books.entries()) {
                book.percent = i === 0 ? 0.29 : 0.71;
                const result = await send('update-reader-progress', {bookUid:book.uid, progress:{percent:book.percent}});
                assert.equal(result.progress.percent, book.percent);
            }
            const [north] = state.books;
            north.cover = state.replacement;
            await zip(join(state.directory, north.id, 'covers', 'books.zip'), [['1', north.cover]]);
            const status = async () => (await fetch(url + '/api/index-status')).json();
            const before = (await status()).indexUpdate.updatedAt;
            assert.equal((await send('admin-reindex')).started, true);
            await waitFor(status, result => result.ready && !result.updating && result.indexUpdate.updatedAt !== before,
                'Two-source reindex did not finish');
            await check();
        }
    } finally { client.close(); }
}

module.exports = {fixture, verify, password};
