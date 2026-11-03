const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const formats = require('../shared/BookFormats');

async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-channel-formats-'));
    try {await fn(dir);} finally {await fs.remove(dir);}
}

const choices = {defaultDownloadFormat:'epub', defaultEmailFormat:'pdf', defaultTelegramFormat:'mobi', defaultOpdsFormat:'kepub', emailAsZip:true, telegramAsZip:false};

async function testChannelFormatsMigrateLegacyProfilesAndSurviveBackup() {
    await temporary(async dir => {
        const Store = require('../server/core/ReadingListStore');
        const config = {dataDir:dir, adminPassword:'fixture-password'};
        // Use the actual RC8 on-disk representation, including the admin profile.
        await fs.writeJson(path.join(dir, 'reading-lists.json'), {users:[
            {id:'admin', name:'Admin', isAdmin:true, defaultDownloadFormat:'epub'},
            {id:'reader', name:'Reader', defaultDownloadFormat:'mobi'},
        ], lists:[]});
        const store = new Store(config);
        for (const [id, expected] of [['admin','epub'], ['reader','mobi']]) {
            const user = await store.getUser(id);
            assert.strictEqual(user.defaultEmailFormat, expected);
            assert.strictEqual(user.defaultTelegramFormat, expected);
            assert.strictEqual(user.defaultOpdsFormat, 'original');
            assert.strictEqual(user.emailAsZip, false);
            assert.strictEqual(user.telegramAsZip, false);
        }
        await store.updateUser('reader', choices);
        let user = await new Store(config).getUser('reader');
        for (const [field, expected] of Object.entries(choices)) assert.strictEqual(user[field], expected);
        const backup = await store.exportData('reader');
        await store.updateUser('reader', {defaultEmailFormat:'original', defaultTelegramFormat:'epub', defaultOpdsFormat:'pdf', emailAsZip:false, telegramAsZip:true});
        await store.importData('reader', backup);
        user = await store.getUser('reader');
        for (const [field, expected] of Object.entries(choices)) assert.strictEqual(user[field], expected);
        await store.importData('reader', {...backup, user:{defaultDownloadFormat:'original'}});
        user = await store.getUser('reader');
        assert.strictEqual(user.defaultDownloadFormat, 'original');
        for (const [field, expected] of Object.entries(choices).filter(([field]) => field !== 'defaultDownloadFormat'))
            assert.strictEqual(user[field], expected, 'Old backups must not erase independent channel settings');
        const created = await store.createUser({name:'New reader', ...choices});
        for (const [field, expected] of Object.entries(choices)) assert.strictEqual(created[field], expected);
        await store.updateUser(created.id, {defaultEmailFormat:'../bad', emailAsZip:'false'});
        const normalized = await store.getUser(created.id);
        assert.strictEqual(normalized.defaultEmailFormat, 'original');
        assert.strictEqual(normalized.emailAsZip, false);
        assert.strictEqual(normalized.defaultTelegramFormat, 'mobi');
    });
}

async function testChannelFormatsUseProfileAuthorizationAndIndependentClientActions() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const config = {profileAuthorized:true, currentUserProfile:{...choices}, conversionFormats:['epub', 'pdf', 'mobi', 'kepub']};
    const View = loadClient(path.resolve(__dirname, '../client/components/Search/BookView/BookView.vue')).default;
    const view = Object.create(View.prototype); view.$store = {state:{config}}; view.book = {ext:'fb2', _uid:'book'};
    assert.strictEqual(view.preferredDownloadFormat, 'epub');
    const events = []; view.$emit = (_, value) => events.push(value);
    view.emit('sendEmail'); view.emit('sendTelegram'); view.emit('sendEmail', 'fb2'); view.emit('sendTelegram', 'pdf');
    assert.deepStrictEqual(events.map(event => event.format), ['pdf','mobi','raw','pdf']);
    config.conversionFormats = ['epub']; view.emit('sendEmail'); view.emit('sendTelegram');
    assert.deepStrictEqual(events.slice(-2).map(event => event.format), ['','']);
    assert.strictEqual(view.preferredDownloadFormat, 'epub');
    config.profileAuthorized = false;
    for (const channel of ['download','email','telegram','opds']) assert.strictEqual(formats.profilePreference(config, channel), 'original');
    await temporary(async dir => {
        const store = new (require('../server/core/ReadingListStore'))({dataDir:dir, adminPassword:'fixture-password'});
        const own = await store.createUser({name:'Own', ...choices}), other = await store.createUser({name:'Other'});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.readingListStore = store; worker.checkMyState = () => {};
        worker.getEffectiveUser = async() => await store.getUser(own.id);
        worker.requireAuthorizedUser = async id => {assert.strictEqual(id, own.id); return await store.getUser(id);};
        worker.requireAdmin = async() => {throw new Error('Admin required');};
        const handler = Object.create(require('../server/controllers/WebSocketController').prototype);
        handler.webWorker = worker; handler.send = () => {};
        await assert.rejects(handler.updateUserProfile({userId:own.id, targetUserId:other.id, profile:choices}, {}), /Admin required/);
        const unchanged = await store.getUser(other.id);
        assert.strictEqual(unchanged.defaultEmailFormat, 'original'); assert.strictEqual(unchanged.emailAsZip, false);
        worker.buildUserReadingSummary = async() => ({items:[], count:0}); worker.getProfileSessionUser = () => '';
        worker.getEffectiveUser = async() => ({...own, passwordHash:'locked'});
        const hidden = await worker.getCurrentUserProfile(own.id);
        assert.strictEqual(hidden.profileAuthorized, false);
        for (const field of Object.values(formats.preferenceFields)) assert.strictEqual(hidden.currentUserProfile[field], 'original');
        assert.strictEqual(hidden.currentUserProfile.emailAsZip, false); assert.strictEqual(hidden.currentUserProfile.telegramAsZip, false);
    });
}

async function readArchive(file) {
    const zip = new (require('../server/core/ZipReader'))();
    await zip.open(file);
    try {
        const names = Object.keys(zip.entries);
        const contents = await Promise.all(names.map(name => zip.extractToBuf(name)));
        return names.map((name, i) => ({name, text:contents[i].toString()}));
    } finally {await zip.close();}
}

async function testDeliveryZipContainsTheSelectedFormatAndIsIndependentPerChannel() {
    await temporary(async dir => {
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        const converter = require('../server/core/BookConverter'), original = converter.prepareConvertedFile;
        const utils = require('../server/core/utils');
        const source = path.join(dir, 'input.fb2'); await fs.writeFile(source, 'Original FB2');
        await utils.gzipFile(source, path.join(dir, 'cached'));
        worker.config = {bookDir:dir, conversionFormats:['epub','pdf','mobi']};
        worker.getBookLink = async() => ({link:'/book/cached', downFileName:'Книга.fb2', size:12});
        worker.db = {esc:JSON.stringify, select:async() => [{_uid:'book', ext:'fb2'}]}; worker.scheduleCacheClean = () => {};
        const calls = [];
        converter.prepareConvertedFile = async options => {
            calls.push(options.format); const filePath = path.join(dir, `cached.${options.format}`);
            await fs.writeFile(filePath, `Converted ${options.format}`);
            return {filePath, downloadName:`Книга.${options.format}`, created:true};
        };
        try {
            const mail = await worker.getDeliveryBookFile('book', '', choices, 'email');
            assert.strictEqual(mail.downFileName, 'Книга.pdf.zip');
            assert.deepStrictEqual(await readArchive(mail.rawFile), [{name:'Книга.pdf', text:'Converted pdf'}]);
            const telegram = await worker.getDeliveryBookFile('book', '', choices, 'telegram');
            assert.strictEqual(telegram.downFileName, 'Книга.mobi');
            assert.strictEqual(await fs.readFile(telegram.rawFile, 'utf8'), 'Converted mobi');
            const explicit = await worker.getDeliveryBookFile('book', 'raw', choices, 'email');
            assert.deepStrictEqual(await readArchive(explicit.rawFile), [{name:'Книга.fb2', text:'Original FB2'}]);
            const alternate = {...choices, emailAsZip:false, telegramAsZip:true};
            assert.strictEqual((await worker.getDeliveryBookFile('book', '', alternate, 'email')).downFileName, 'Книга.pdf');
            assert.strictEqual((await worker.getDeliveryBookFile('book', '', alternate, 'telegram')).downFileName, 'Книга.mobi.zip');
            worker.config.conversionEnabled = false;
            const fallback = await worker.getDeliveryBookFile('book', '', choices, 'email');
            assert.deepStrictEqual(await readArchive(fallback.rawFile), [{name:'Книга.fb2', text:'Original FB2'}]);
            assert.deepStrictEqual(calls, ['pdf','mobi','pdf','mobi']);
        } finally {converter.prepareConvertedFile = original;}
    });
}

async function testDeliveryArchiveDeduplicatesCachesSafeNamesAndRecoversAfterFailure() {
    await temporary(async dir => {
        const archive = require('../server/core/BookDeliveryArchive');
        const file = path.join(dir, 'book'); await fs.writeFile(file, 'Bytes');
        const prepared = {rawFile:file, downFileName:'../../Книга.fb2'};
        const values = await Promise.all(Array.from({length:8}, () => archive.prepare(prepared)));
        assert.strictEqual(new Set(values.map(value => value.rawFile)).size, 1);
        assert.strictEqual((await fs.readdir(dir)).filter(name => name.endsWith('.zip')).length, 1);
        assert.deepStrictEqual(await readArchive(values[0].rawFile), [{name:'Книга.fb2', text:'Bytes'}]);
        const other = await archive.prepare({...prepared, downFileName:'Другое имя.fb2'});
        assert.notStrictEqual(other.rawFile, values[0].rawFile);
        assert.deepStrictEqual(await readArchive(other.rawFile), [{name:'Другое имя.fb2', text:'Bytes'}]);
        const missing = {rawFile:path.join(dir, 'missing'), downFileName:'Recovered.epub'};
        await assert.rejects(archive.prepare(missing), /ENOENT/);
        assert(!(await fs.readdir(dir)).some(name => name.includes('.cache-tmp-')));
        assert(!(await fs.readdir(dir)).some(name => name.startsWith('missing.')));
        await fs.writeFile(missing.rawFile, 'Retry');
        const recovered = await archive.prepare(missing);
        assert.deepStrictEqual(await readArchive(recovered.rawFile), [{name:'Recovered.epub', text:'Retry'}]);
    });
}

async function testDeliveryTransportsReceiveZipAndOriginalWithoutExternalRequests() {
    await temporary(async dir => {
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        const mail = require('nodemailer'), axios = require('axios'), originalMail = mail.createTransport, originalPost = axios.post;
        const file = path.join(dir, 'book.pdf'); await fs.writeFile(file, 'Converted PDF');
        const user = {...choices, telegramAsZip:true, emailTo:'reader@example.test', telegramChatId:'1'};
        worker.config = {emailShareEnabled:true, smtpHost:'fixture.invalid', telegramShareEnabled:true, telegramBotToken:'fixture'};
        worker.readingListStore = {getUsers:async() => ({currentUser:user})}; worker.addAdminEvent = () => {}; worker.scheduleCacheClean = () => {};
        const calls = [];
        worker.getPreparedBookFile = async(uid, explicit, preference) => {
            calls.push(preference); return {book:{title:'Book', ext:'fb2'}, rawFile:file, downFileName:`Book.${preference}`};
        };
        const attachments = [], documents = [];
        mail.createTransport = () => ({sendMail:async message => attachments.push(message.attachments[0])});
        axios.post = async(url, form) => {
            const chunks = [];
            await require('stream/promises').pipeline(form, new (require('stream').Writable)({write(chunk, encoding, done) {chunks.push(chunk); done();}}));
            documents.push(Buffer.concat(chunks).toString('latin1')); return {data:{ok:true}};
        };
        try {
            await worker.sendBookToEmail('book', '', 'reader');
            assert.strictEqual(attachments[0].filename, 'Book.pdf.zip');
            assert.deepStrictEqual(await readArchive(attachments[0].path), [{name:'Book.pdf', text:'Converted PDF'}]);
            await worker.sendBookToTelegram('book', '', 'reader');
            assert(documents[0].includes('filename="Book.mobi.zip"')); assert(documents[0].includes('PK\x03\x04'));
            user.emailAsZip = false; await worker.sendBookToEmail('book', '', 'reader');
            assert.strictEqual(attachments[1].filename, 'Book.pdf'); assert.strictEqual(attachments[1].path, file);
            assert.deepStrictEqual(calls, ['pdf','mobi','pdf']);
        } finally {mail.createTransport = originalMail; axios.post = originalPost;}
    });
}

async function testOpdsOffersIndependentPreferredFormatAndCorrectAcquisitionTypes() {
    const {forBook} = require('../server/core/opds/AcquisitionLinks');
    const config = {conversionEnabled:true, mobiEnabled:true, conversionFormats:['epub','epub3','kepub','pdf','mobi','kfx','azw8'], bookPathStatic:'/library/book'};
    const book = {_uid:'a+/?=', ext:'fb2'};
    const links = forBook(book, config, choices);
    assert.strictEqual(links[0].type, 'application/epub+zip');
    assert.strictEqual(new URL(links[0].href, 'http://test').searchParams.get('format'), 'kepub');
    assert(links[0].title.includes('предпочитаемый'));
    assert.deepStrictEqual(links.filter(link => link.href.endsWith('format=raw')).map(link => link.type), ['application/fb2+xml', 'application/x-fictionbook+xml']);
    assert(links.every(link => new URL(link.href, 'http://test').searchParams.get('uid') === book._uid));
    const expectedTypes = {epub:'application/epub+zip', epub3:'application/epub+zip', kepub:'application/epub+zip',
        pdf:'application/pdf', mobi:'application/x-mobipocket-ebook', kfx:'application/vnd.amazon.ebook', azw8:'application/vnd.amazon.ebook'};
    for (const [format, type] of Object.entries(expectedTypes)) assert(links.some(link => link.href.endsWith('format=' + format) && link.type === type));
    assert.strictEqual(forBook(book, config)[0].type, 'application/fb2+xml');
    assert.strictEqual(forBook(book, {...config, conversionEnabled:false}, choices).length, 2);
    assert.strictEqual(forBook(book, {...config, mobiEnabled:false}, {defaultOpdsFormat:'mobi'})[0].type, 'application/fb2+xml');
    const epub = forBook({...book, ext:'epub'}, config, choices);
    assert(epub[0].href.endsWith('format=raw')); assert(!epub.some(link => /format=(epub|kepub|kfx|azw8)$/.test(link.href)));
    assert.strictEqual(forBook({...book, ext:'pdf'}, config, choices)[0].type, 'application/pdf');
}

async function testOpdsScopesApplyPreferencesPerRequestWithoutCrossProfileState() {
    const express = require('express'), Store = require('../server/core/ReadingListStore');
    const BookPage = require('../server/core/opds/BookPage'), XmlParser = require('../server/core/xml/XmlParser');
    await temporary(async dir => {
        const store = new Store({dataDir:dir, adminPassword:'fixture-password'});
        const a = await store.createUser({name:'EPUB', login:'reader', defaultOpdsFormat:'epub'});
        const b = await store.createUser({name:'PDF', defaultOpdsFormat:'pdf'});
        const hidden = await store.createUser({name:'Hidden', opdsEnabled:false, defaultOpdsFormat:'mobi'});
        const worker = {readingListStore:store, getGenreMap:async() => new Map(), getGenreTree:async() => ({genreTree:[]}),
            getBookRecordByUid:async() => ({_uid:'book', ext:'epub', title:'Book', author:'Author', lang:'ru'}), applyMetadataOverridesToSearchResult:async() => {}};
        const page = Object.create(BookPage.prototype);
        Object.assign(page, {config:{opdsRoot:'/opds', bookPathStatic:'/book', conversionEnabled:true, conversionFormats:['pdf']},
            webWorker:worker, opdsRoot:'/opds', id:'book', title:'Book', rootTag:'feed'});
        const app = express(); app.use('/opds', require('../server/core/opds').scopeGuard(() => worker));
        app.get('/opds/book', async(req, res, next) => {try {res.send(await page.body(req));} catch (error) {next(error);}});
        const server = await new Promise(resolve => {const value = app.listen(0, '127.0.0.1', () => resolve(value));});
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const first = async user => {
                const response = await fetch(`${base}/opds/book?uid=book${user ? '&user=' + encodeURIComponent(user) : ''}`);
                assert.strictEqual(response.status, 200);
                const xml = new XmlParser(); xml.fromString(await response.text());
                return xml.$$array('feed/entry/link').map(link => link.attrs()).filter(link => link.rel === 'http://opds-spec.org/acquisition')[0];
            };
            const results = await Promise.all(['reader', b.id, '', a.id, b.id].map(first));
            assert.deepStrictEqual(results.map(link => link.type), ['application/epub+zip','application/pdf','application/epub+zip','application/epub+zip','application/pdf']);
            assert(results[0].href.includes('format=raw')); assert(results[1].href.includes('format=pdf'));
            for (const user of ['no-such-user', hidden.id])
                assert.strictEqual((await fetch(`${base}/opds/book?uid=book&user=${user}`)).status, 404);
        } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    });
}

async function testChannelFormatSettingsKeepIndependentValuesOnSave() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const Dialog = loadClient(path.resolve(__dirname, '../client/components/Search/UserProfilesDialog/UserProfilesDialog.vue')).default;
    const dialog = new Dialog();
    dialog.$store = {state:{settings:{}, config:{conversionFormats:['epub','pdf','kepub'], currentUserProfile:{...choices}}}};
    dialog.syncEditableProfile();
    assert.strictEqual(dialog.formatFields.length, 4);
    assert.strictEqual(dialog.formatFields.filter(field => field.archive).length, 2);
    assert(dialog.formatOptions('defaultTelegramFormat').find(option => option.value === 'mobi').disable);
    dialog.editableProfile.defaultEmailFormat = 'epub'; dialog.editableProfile.telegramAsZip = true;
    let saved; dialog.api = {updateUserProfile:async(id, profile) => {saved = {...profile};}};
    dialog.loadProfiles = async() => {}; dialog.$root = {notify:{success:() => {}}, stdDialog:{alert:message => {throw new Error(message);}}};
    await dialog.saveCurrentProfile();
    assert.strictEqual(saved.defaultEmailFormat, 'epub'); assert.strictEqual(saved.defaultDownloadFormat, 'epub');
    assert.strictEqual(saved.defaultTelegramFormat, 'mobi'); assert.strictEqual(saved.defaultOpdsFormat, 'kepub');
    assert.strictEqual(saved.emailAsZip, true); assert.strictEqual(saved.telegramAsZip, true);
}

module.exports = [testChannelFormatsMigrateLegacyProfilesAndSurviveBackup, testChannelFormatsUseProfileAuthorizationAndIndependentClientActions,
    testDeliveryZipContainsTheSelectedFormatAndIsIndependentPerChannel, testDeliveryArchiveDeduplicatesCachesSafeNamesAndRecoversAfterFailure,
    testDeliveryTransportsReceiveZipAndOriginalWithoutExternalRequests, testOpdsOffersIndependentPreferredFormatAndCorrectAcquisitionTypes,
    testOpdsScopesApplyPreferencesPerRequestWithoutCrossProfileState, testChannelFormatSettingsKeepIndependentValuesOnSave];
