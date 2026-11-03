const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-download-preference-'));
    try {await fn(dir);} finally {await fs.remove(dir);}
}

async function testDownloadPreferencePersistsPerProfileAndInBackup() {
    await temporary(async dir => {
        const Store = require('../server/core/ReadingListStore');
        const config = {dataDir:dir, adminLogin:'admin', adminPassword:'fixture-password'};
        const store = new Store(config);
        const a = await store.createUser({name:'EPUB reader', defaultDownloadFormat:'EPUB'});
        const b = await store.createUser({name:'MOBI reader', defaultDownloadFormat:'mobi'});
        assert.strictEqual((await new Store(config).getUser(a.id)).defaultDownloadFormat, 'epub');
        assert.strictEqual((await new Store(config).getUser(b.id)).defaultDownloadFormat, 'mobi');
        const backup = await store.exportData(a.id);
        assert.strictEqual(backup.user.defaultDownloadFormat, 'epub');
        await store.updateUser(a.id, {defaultDownloadFormat:'original'});
        await store.importData(a.id, backup);
        assert.strictEqual((await store.getUser(a.id)).defaultDownloadFormat, 'epub');
        assert.strictEqual((await store.getUser(b.id)).defaultDownloadFormat, 'mobi');
        const legacy = {...backup, user:{...backup.user}}; delete legacy.user.defaultDownloadFormat;
        await store.updateUser(a.id, {defaultDownloadFormat:'pdf'});
        await store.importData(a.id, legacy);
        assert.strictEqual((await store.getUser(a.id)).defaultDownloadFormat, 'pdf', 'Old backups retain the current preference');
        await store.importData(a.id, {...backup, user:{defaultDownloadFormat:'../../converter'}});
        assert.strictEqual((await store.getUser(a.id)).defaultDownloadFormat, 'original');
    });
}

async function testDownloadPreferenceUsesExistingProfileAuthorization() {
    await temporary(async dir => {
        const store = new (require('../server/core/ReadingListStore'))({dataDir:dir, adminPassword:'fixture-password'});
        const a = await store.createUser({name:'Own profile'}), b = await store.createUser({name:'Other profile'});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.readingListStore = store; worker.checkMyState = () => {};
        worker.getEffectiveUser = async() => await store.getUser(a.id);
        worker.requireAuthorizedUser = async id => {assert.strictEqual(id, a.id); return await store.getUser(id);};
        worker.requireAdmin = async() => {throw new Error('Admin required');};
        const handler = Object.create(require('../server/controllers/WebSocketController').prototype);
        handler.webWorker = worker; handler.send = () => {};
        await handler.updateUserProfile({userId:a.id, targetUserId:a.id, profile:{defaultDownloadFormat:'epub'}}, {});
        assert.strictEqual((await store.getUser(a.id)).defaultDownloadFormat, 'epub');
        await assert.rejects(handler.updateUserProfile({userId:a.id, targetUserId:b.id, profile:{defaultDownloadFormat:'mobi'}}, {}), /Admin required/);
        assert.strictEqual((await store.getUser(b.id)).defaultDownloadFormat, 'original');
        worker.requireAuthorizedUser = async() => {throw new Error('Login required');};
        await assert.rejects(handler.updateUserProfile({userId:a.id, targetUserId:a.id, profile:{defaultDownloadFormat:'pdf'}}, {}), /Login required/);
        assert.strictEqual((await store.getUser(a.id)).defaultDownloadFormat, 'epub');
        assert(handler.isCsrfProtectedAction('update-user-profile'));
        worker.buildUserReadingSummary = async() => ({items:[], count:0});
        worker.getProfileSessionUser = () => '';
        assert.strictEqual((await worker.getCurrentUserProfile(a.id)).currentUserProfile.defaultDownloadFormat, 'epub');
        worker.getEffectiveUser = async() => ({...await store.getUser(a.id), passwordHash:'locked'});
        const locked = await worker.getCurrentUserProfile(a.id);
        assert.strictEqual(locked.profileAuthorized, false);
        assert.strictEqual(locked.currentUserProfile.defaultDownloadFormat, 'original');
    });
}

async function testDownloadPreferenceUpdatesButtonsAndKeepsExplicitOriginal() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const View = loadClient(path.resolve(__dirname, '../client/components/Search/BookView/BookView.vue')).default;
    const List = loadClient(path.resolve(__dirname, '../client/components/Search/BaseList.js')).default;
    const config = {profileAuthorized:true, currentUserProfile:{defaultDownloadFormat:'epub'}, conversionFormats:['epub','pdf','mobi']};
    const view = Object.create(View.prototype); view.$store = {state:{config}};
    view.book = {_uid:'fixture', ext:'fb2'}; view.downloadAsZip = true;
    const previousWindow = global.window;
    global.window = {location:{origin:'http://local.test'}};
    try {
        assert.match(view.downloadLabel, /EPUB$/);
        assert.strictEqual(new URL(view.getDirectBookDownloadHref()).searchParams.get('format'), 'epub');
        assert(view.extraFormats.includes('fb2')); assert(!view.extraFormats.includes('epub'));
        assert.strictEqual(new URL(view.getDirectBookDownloadHref('fb2')).searchParams.get('format'), 'raw');
        const events = []; view.$emit = (_, event) => events.push(event);
        view.emit('sendEmail'); view.emit('sendTelegram', 'fb2');
        assert.deepStrictEqual(events.map(e => e.format), ['epub','raw']);
        config.currentUserProfile.defaultDownloadFormat = 'original';
        assert.strictEqual(new URL(view.getDirectBookDownloadHref()).searchParams.get('zip'), '1');
        config.currentUserProfile.defaultDownloadFormat = 'mobi'; config.conversionFormats = ['epub','pdf'];
        assert.strictEqual(view.preferredDownloadFormat, '');
        config.conversionFormats.push('mobi'); assert.strictEqual(view.preferredDownloadFormat, 'mobi');
        config.profileAuthorized = false; assert.strictEqual(view.preferredDownloadFormat, '');
        config.profileAuthorized = true; config.conversionEnabled = false; assert.strictEqual(view.preferredDownloadFormat, '');
        config.conversionEnabled = true; config.currentUserProfile.defaultDownloadFormat = 'epub'; view.book.ext = 'epub';
        assert.strictEqual(view.preferredDownloadFormat, '');
        view.book.ext = 'pdf'; assert.strictEqual(view.preferredDownloadFormat, '');
        const list = new List(); list.$store = {state:{config, settings:{}}};
        const sent = []; list.api = {sendBookEmail:async(uid, format) => sent.push([uid, format])};
        list.$root = {notify:{success:message => assert(!message.includes('RAW'))}, stdDialog:{alert:message => {throw new Error(message);}}};
        await list.download({_uid:'fixture', ext:'fb2'}, 'sendEmail');
        config.conversionEnabled = false;
        await list.download({_uid:'fixture', ext:'fb2'}, 'sendEmail', 'fb2');
        assert.deepStrictEqual(sent, [['fixture','epub'], ['fixture','raw']]);
    } finally {if (previousWindow === undefined) delete global.window; else global.window = previousWindow;}
}

async function testUnavailablePreferredFormatRemainsVisibleInUserSettings() {
    const {loadClient} = require('./catalog-list-filter-tests');
    const Dialog = loadClient(path.resolve(__dirname, '../client/components/Search/UserProfilesDialog/UserProfilesDialog.vue')).default;
    const dialog = new Dialog();
    dialog.$store = {state:{settings:{}, config:{conversionEnabled:false, currentUserProfile:{defaultDownloadFormat:'mobi'}}}};
    dialog.syncEditableProfile();
    assert.strictEqual(dialog.editableProfile.defaultDownloadFormat, 'mobi');
    assert(dialog.downloadFormatOptions.some(option => option.value === 'mobi' && option.disable));
    dialog.$store.state.config.conversionEnabled = true;
    dialog.$store.state.config.conversionFormats = ['epub','mobi'];
    assert(!dialog.downloadFormatOptions.find(option => option.value === 'mobi').disable);
    dialog.currentProfileTab = 'settings'; let saved, options;
    dialog.api = {updateUserProfile:async(id, profile) => {saved = {...profile};}};
    dialog.loadProfiles = async value => {options = value;};
    dialog.$root = {notify:{success:() => {}}, stdDialog:{alert:message => {throw new Error(message);}}};
    await dialog.saveCurrentProfile();
    assert.strictEqual(saved.defaultDownloadFormat, 'mobi'); assert.deepStrictEqual(options, {preserveState:true});
}

async function testPreparedFileUsesPreferenceAndFallsBackWithoutConversion() {
    await temporary(async dir => {
        const worker = Object.create(require('../server/core/WebWorker').prototype), utils = require('../server/core/utils');
        const converter = require('../server/core/BookConverter'), original = converter.prepareConvertedFile;
        const source = path.join(dir, 'input.fb2'), gzip = path.join(dir, 'fixture');
        await fs.writeFile(source, 'Original FB2'); await utils.gzipFile(source, gzip);
        const book = {_uid:'book', ext:'fb2'}; const formats = [];
        worker.config = {bookDir:dir, conversionFormats:['epub','pdf']};
        worker.getBookLink = async() => ({link:'/book/fixture', downFileName:'Book.fb2', size:12});
        worker.db = {esc:JSON.stringify, select:async() => [book]}; worker.scheduleCacheClean = () => {};
        converter.prepareConvertedFile = async options => {
            formats.push(options.format); const filePath = options.cacheBasePath + '.' + options.format;
            await fs.writeFile(filePath, 'Converted'); return {filePath, downloadName:'Book.' + options.format, created:true};
        };
        try {
            assert.strictEqual((await worker.getPreparedBookFile('book', '', 'epub')).downFileName, 'Book.epub');
            assert.strictEqual((await worker.getPreparedBookFile('book', 'raw', 'epub')).downFileName, 'Book.fb2');
            assert.strictEqual((await worker.getPreparedBookFile('book', 'pdf', 'epub')).downFileName, 'Book.pdf');
            assert.strictEqual((await worker.getPreparedBookFile('book', '', 'mobi')).downFileName, 'Book.fb2');
            worker.config.conversionEnabled = false;
            assert.strictEqual((await worker.getPreparedBookFile('book', '', 'epub')).downFileName, 'Book.fb2');
            assert.deepStrictEqual(formats, ['epub','pdf']);
        } finally {converter.prepareConvertedFile = original;}
    });
}

async function testDeliveryUsesPreferenceOfTheAuthorizedProfile() {
    await temporary(async dir => {
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        const mail = require('nodemailer'), axios = require('axios'), originalMail = mail.createTransport, originalPost = axios.post;
        const file = path.join(dir, 'book.fb2'); await fs.writeFile(file, 'Book');
        const calls = [], users = {a:{defaultDownloadFormat:'epub', emailTo:'a@example.test'}, b:{defaultDownloadFormat:'mobi', telegramChatId:'1'}};
        worker.config = {emailShareEnabled:true, smtpHost:'fixture.invalid', telegramShareEnabled:true, telegramBotToken:'fixture'};
        worker.readingListStore = {getUsers:async id => ({currentUser:users[id]})}; worker.addAdminEvent = () => {};
        worker.getPreparedBookFile = async(uid, explicit, preference) => {
            calls.push([explicit, preference]); return {book:{title:'Book', ext:'fb2'}, rawFile:file, downFileName:'Book.fb2'};
        };
        mail.createTransport = () => ({sendMail:async() => {}});
        axios.post = async(url, form) => {
            await require('stream/promises').pipeline(form, new (require('stream').Writable)({write(chunk, encoding, done) {done();}}));
            return {data:{ok:true}};
        };
        try {
            await worker.sendBookToEmail('book', '', 'a');
            await worker.sendBookToTelegram('book', '', 'b');
            await worker.sendBookToEmail('book', 'raw', 'a');
            assert.deepStrictEqual(calls, [['','epub'], ['','mobi'], ['raw','epub']]);
        } finally {mail.createTransport = originalMail; axios.post = originalPost;}
    });
}

module.exports = [testDownloadPreferencePersistsPerProfileAndInBackup, testDownloadPreferenceUsesExistingProfileAuthorization,
    testDownloadPreferenceUpdatesButtonsAndKeepsExplicitOriginal, testUnavailablePreferredFormatRemainsVisibleInUserSettings,
    testPreparedFileUsesPreferenceAndFallsBackWithoutConversion, testDeliveryUsesPreferenceOfTheAuthorizedProfile];
